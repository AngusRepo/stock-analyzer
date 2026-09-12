from copy import deepcopy
from types import SimpleNamespace
import json

import polars as pl
import pytest

from services.backtest_engine import AccountState, _mark_to_market
from services.backtest_corporate_accounting import apply_corporate_session
from services.paired_nav_journal import replay_session
from test_backtest_settlement_nav import _position

FEES = {'commission': 0., 'minCommission': 0., 'tax': 0.}


def source(day, actions):
    return {'schema_version': 'paper-corporate-source-v1', 'session_date': day,
            'covered_symbols': ['2330'], 'actions': actions, 'blockers': {},
            'source_checksum': 'a' * 64, 'tax_basis': 'gross_before_personal_tax'}


def action(kind, amount, payable=None, **kwargs):
    return {'action_id': kind, 'symbol': '2330', 'kind': kind, 'ex_date': '2026-09-07',
            'payable_date': payable, 'cash_per_share': amount if kind == 'cash' else 0.,
            'stock_per_share': amount if kind != 'cash' else 0., **kwargs}


def account():
    position = _position()
    position.shares = 100
    return AccountState(cash=99000., initial_capital=109000., positions={'2330': position})


def nav(account, mark):
    return _mark_to_market(account, SimpleNamespace(get_bar=lambda *_: {'close': mark}), '2026-09-07')


def reconcile(previous, account, actions, day, mark):
    expected = replay_session(previous=previous, fills=[], marks={'2330': mark},
        corporate_actions=actions, session_date=day, fees=FEES)
    assert expected['cash'] == account.cash
    assert expected['positions'] == {s: p.shares for s, p in account.positions.items()}
    assert expected['nav'] == pytest.approx(nav(account, mark))
    return expected


@pytest.mark.parametrize('amount,rounding', [(2., None), (.7207, 'floor_twd'), (.29, None)])
def test_cash_accrual_payment_retry_and_original_cost(amount, rounding):
    book = account()
    actions = [action('cash', amount, '2026-09-08', cash_rounding=rounding)]
    previous = {'cash': 99000., 'positions': {'2330': 100}, 'nav': 109000.}
    for day in ('2026-09-07', '2026-09-08'):
        tape = source(day, actions)
        apply_corporate_session(book, tape, day, {'2330': 100.})
        before = deepcopy(book)
        apply_corporate_session(book, tape, day, {'2330': 100.})
        assert book == before
        previous = reconcile(previous, book, actions, day, 100. - amount)
    assert not book.corporate_receivables
    assert book.positions['2330'].cost_basis == 100.
    assert book.positions['2330'].entry_price == 100. - amount


def test_sold_parent_retains_stock_rights_and_delivery_restores_exit_owner():
    book = account()
    actions = [action('stock', .29, '2026-09-09')]
    apply_corporate_session(book, source('2026-09-07', actions), '2026-09-07', {'2330': 100.})
    mark = 100 / 1.29
    assert nav(book, mark) == pytest.approx(109000.)
    assert book.available_cash == 99000.
    parent = book.positions.pop('2330')
    book.cash += 100 * mark  # Test a parent sale; delivery must not lose its owner.
    apply_corporate_session(book, source('2026-09-08', actions), '2026-09-08', {})
    assert not book.positions and nav(book, mark) == pytest.approx(109000.)
    apply_corporate_session(book, source('2026-09-09', actions), '2026-09-09', {})
    delivered = book.positions['2330']
    assert delivered.shares == 29 and delivered.initial_stop == parent.initial_stop
    assert delivered.entry_date == parent.entry_date and delivered.cost_basis == pytest.approx(mark)
    assert nav(book, mark) == pytest.approx(109000.) and not book.corporate_receivables


@pytest.mark.parametrize('ratio,refund,official', [(22., 0., None), (.75, 2.5, None),
                                                 (.7296441479, 0., .72964415)])
def test_conversion_matches_independent_journal(ratio, refund, official):
    book = account()
    exchange = action('exchange', ratio, '2026-09-07', capital_return_per_share=refund)
    if official:
        exchange.update(official_share_ratio=official, fractional_treatment='book_entry_fee')
    actions = [exchange] + ([action('cash', refund)] if refund else [])
    apply_corporate_session(book, source('2026-09-07', actions), '2026-09-07', {'2330': 100.})
    reconcile({'cash': 99000., 'positions': {'2330': 100}, 'nav': 109000.},
              book, actions, '2026-09-07', (100 - refund) / ratio)


@pytest.mark.parametrize('defect', ['missing', 'blocked', 'coverage', 'rounding', 'fraction', 'previous'])
def test_invalid_source_or_delivery_never_partially_mutates_account(defect):
    book = account()
    actions = [action('cash', .7207, '2026-09-07')]
    tape, closes = source('2026-09-07', actions), {'2330': 100.}
    if defect == 'missing': tape = None
    elif defect == 'blocked': tape['blockers'] = {'2330': ['missing_terms']}
    elif defect == 'coverage': tape['covered_symbols'] = []
    elif defect == 'fraction': tape['actions'] = [action('stock', .295, '2026-09-07')]
    elif defect == 'previous': closes = {}
    previous = deepcopy(book)
    with pytest.raises(ValueError):
        apply_corporate_session(book, tape, '2026-09-07', closes)
    assert book == previous


def test_exdate_buy_has_no_old_entitlement_and_unpaid_right_is_not_cash():
    book = AccountState(cash=109000., initial_capital=109000.)
    actions = [action('cash', 2.)]
    apply_corporate_session(book, source('2026-09-07', actions), '2026-09-07', {})
    book.positions['2330'] = account().positions['2330']
    book.cash -= 9800.
    apply_corporate_session(book, source('2026-09-08', actions), '2026-09-08', {})
    assert not book.corporate_receivables and nav(book, 98.) == 109000.


def test_daily_replay_keeps_unpaid_cash_right_after_forced_final_sale(monkeypatch):
    import services.backtest_engine as engine
    days = ['2026-09-03', '2026-09-04', '2026-09-07']
    actions = [action('cash', 2., '2026-09-09')]
    dataset = engine.BacktestDataset(
        prices=pl.DataFrame([{'symbol': '2330', 'date': day, 'open': close, 'high': close,
                             'low': close, 'close': close, 'volume': 1000000}
                            for day, close in zip(days, [100., 100., 98.])]),
        indicators=pl.DataFrame(), chips=pl.DataFrame(), market_risk=pl.DataFrame(),
        stocks=pl.DataFrame({'symbol': ['2330']}), trading_days=days,
        start_date=days[0], end_date=days[-1],
        corporate_sources={day: source(day, actions if day == days[-1] else []) for day in days})
    monkeypatch.setattr(engine, 'replay_screener_for_date', lambda **_: ['fixture'])
    def buy(**kwargs):
        if kwargs['entry_date'] == '2026-09-04':
            state = kwargs['account']
            state.positions['2330'] = account().positions['2330']
            state.pending_settlements.append(engine.PendingSettlement('2026-09-04', '2026-09-08', 'buy', 10000., '2330'))
        return []
    monkeypatch.setattr(engine, 'simulate_entries_for_date', buy)
    result = engine.replay_period(dataset, days[0], days[-1], {}, initial_capital=109000.)
    assert result.equity_curve[:2] == [(days[0], 109000.), (days[1], 109000.)]
    trade = result.trades[-1]
    fees = engine.FeeParams.from_trading_config({})
    proceeds = trade.exit_price * 100
    proceeds -= max(proceeds * fees.commission, fees.min_commission) + proceeds * fees.tax
    assert result.final_equity == pytest.approx(99000 + proceeds + 200)
    assert trade.entry_price == 100.  # Cost, not the ex-dividend anchor98.
    assert result.final_equity < 109000  # Real exit fees/slippage remain losses.


@pytest.mark.parametrize('defect', [None, 'late_fetch', 'checksum', 'duplicate'])
def test_archived_source_loader_rejects_backdated_or_corrupt_receipt(defect):
    from services.backtest_corporate_accounting import load_corporate_tape
    from services.paired_nav_journal import digest
    snapshot = source('2026-09-07', [action('cash', 2.)])
    snapshot['observed_at'] = '2026-09-06T23:00:00Z'
    record = {'identity': {'owner': 'paper-corporate-source-v1', 'session_date': '2026-09-07'},
              'request': {'symbols': ['2330'], 'outstanding_action_ids': []}, 'snapshot': snapshot,
              'snapshot_checksum': digest(snapshot), 'captured_at': '2026-09-06T23:00:01Z'}
    if defect == 'late_fetch': record['captured_at'] = '2026-09-08T00:00:00Z'
    if defect == 'checksum': record['snapshot_checksum'] = 'b' * 64
    rows = [json.dumps(record)] * (2 if defect == 'duplicate' else 1)
    frame = pl.DataFrame({'record_json': rows})
    if defect:
        with pytest.raises(ValueError, match='backtest_corporate'):
            load_corporate_tape(frame)
    else:
        assert load_corporate_tape(frame) == {'2026-09-07': snapshot}
