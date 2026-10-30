"""Research replay on reconstructed corporate history (Wei 10/30, option a)."""
from types import SimpleNamespace

import polars as pl
import pytest

from services import backtest_engine as engine
from services.research_corporate_history import (
    CorporateHistoryGap, make_history_record,
)
from services.research_corporate_preflight import (
    CorporateCoverageError, exclude_history_blocked_symbols, require_corporate_coverage,
)

DAYS = ['2026-09-03', '2026-09-04', '2026-09-07']
CAPTURED = '2026-10-03T01:00:00+00:00'
REFS = [{'dataset': 'finlab.dividend_announcement', 'uri': 'local://sealed.parquet',
         'sha256': 'b' * 64, 'fetched_at': '2026-10-03T00:00:00+00:00'}]


def history(day, *, symbols=('1101', '2330'), actions=(), blockers=None):
    snap = {'session_date': day, 'covered_symbols': sorted(symbols), 'actions': list(actions),
            'blockers': blockers or {}, 'source_checksum': 'a' * 64, 'tax_basis': 'gross_before_personal_tax'}
    return make_history_record(snap, captured_at=CAPTURED, source_refs=REFS,
                               history_start=DAYS[0], history_end=DAYS[-1])['snapshot']


def dataset(tape, symbols=('1101', '2330'), days=DAYS, suspended=()):
    rows = [{'symbol': s, 'date': d, 'open': 100., 'high': 100., 'low': 100., 'close': 100., 'volume': 1e6}
            for s in symbols for d in days if (s, d) not in suspended]
    stocks = pl.DataFrame({'symbol': list(symbols), 'listed_date': [None] * len(symbols),
                           'delisted_date': [None] * len(symbols), 'market': ['TWSE'] * len(symbols)},
                          schema={'symbol': pl.String, 'listed_date': pl.String,
                                  'delisted_date': pl.String, 'market': pl.String})
    return engine.BacktestDataset(prices=pl.DataFrame(rows), indicators=pl.DataFrame(), chips=pl.DataFrame(),
        market_risk=pl.DataFrame(), stocks=stocks, trading_days=list(days), start_date=days[0], end_date=days[-1],
        corporate_sources=tape)


# ── exclusion: a blocked issuer leaves the whole window; nothing else does ──

def test_blocked_issuer_leaves_universe_for_whole_window_and_coverage_then_passes():
    tape = {d: history(d) for d in DAYS}
    tape[DAYS[2]] = history(DAYS[2], blockers={'2330': ['stock_delivery_issuer_history_unverified']},
        actions=[{'action_id': 'stock-ev', 'symbol': '2330', 'kind': 'stock', 'ex_date': DAYS[2],
                  'payable_date': None, 'cash_per_share': 0., 'stock_per_share': .1}])
    tape[DAYS[2]]['unverified_stock_action_ids'] = {'2330': ['stock-ev']}
    data = dataset(tape)
    with pytest.raises(CorporateCoverageError):
        require_corporate_coverage(data, DAYS[0], DAYS[-1])
    report = exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])
    assert report['excluded_first_blocked_session'] == {'2330': DAYS[2]}
    assert report['excluded_reason_counts'] == {'stock_delivery_issuer_history_unverified': 1}
    assert report['selection_reads_blockers_through_end_date'] is True
    # Excluded on the first session too: a position opened then would reach the blocked day.
    assert all(data.get_universe_at(d) == {'1101'} for d in DAYS)
    assert not data.get_price_history('2330', DAYS[0], 3).is_empty()
    assert require_corporate_coverage(data, DAYS[0], DAYS[-1])['status'] == 'ready'


def test_unheld_unrelated_old_stock_event_does_not_exclude_issuer():
    # The issuer's unverified stock event is outside every possible entitlement.
    old = {'action_id': 'old-stock', 'symbol': '2330', 'kind': 'stock', 'ex_date': '2026-08-01',
           'payable_date': None, 'cash_per_share': 0., 'stock_per_share': .1}
    tape = {d: history(d, actions=[old], blockers={'2330': ['stock_delivery_issuer_history_unverified']}) for d in DAYS}
    for snap in tape.values():
        snap['unverified_stock_action_ids'] = {'2330': ['old-stock']}
    data = dataset(tape)
    assert exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])['excluded_count'] == 0
    assert data.get_universe_at(DAYS[0]) == {'1101', '2330'}


def test_uncovered_issuer_is_excluded_and_named():
    tape = {d: history(d, symbols=('1101',)) for d in DAYS}
    data = dataset(tape)
    report = exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])
    assert report['excluded_reason_counts'] == {'event_index_coverage_missing': 1}
    assert data.get_universe_at(DAYS[1]) == {'1101'}


def test_missing_session_is_never_excluded_away():
    tape = {d: history(d) for d in DAYS if d != DAYS[1]}
    data = dataset(tape)
    assert exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])['excluded_count'] == 0
    with pytest.raises(CorporateCoverageError) as err:
        require_corporate_coverage(data, DAYS[0], DAYS[-1])
    assert err.value.report['issues'] == [{'date': DAYS[1], 'reason': 'session_missing'}]


def test_every_symbol_blocked_fails_instead_of_an_empty_search():
    tape = {d: history(d, symbols=('9999',)) for d in DAYS}
    with pytest.raises(ValueError, match='universe_empty_after_exclusion'):
        exclude_history_blocked_symbols(dataset(tape), DAYS[0], DAYS[-1])


def test_paper_receipt_tape_is_refused_in_history_mode():
    tape = {d: {'session_date': d, 'covered_symbols': ['1101', '2330'], 'actions': [], 'blockers': {}} for d in DAYS}
    with pytest.raises(ValueError, match='mode_requires_history_tape'):
        exclude_history_blocked_symbols(dataset(tape), DAYS[0], DAYS[-1])


def test_holding_a_blocked_symbol_fails_closed_in_accounting():
    tape = {d: history(d, blockers={'2330': ['economic_terms_incomplete:cash:KeyError']}) for d in DAYS}
    data = dataset(tape)
    account = SimpleNamespace(positions={'2330': object()}, corporate_receivables={})
    with pytest.raises(CorporateHistoryGap) as err:
        engine._apply_daily_corporate(account, data, DAYS[0])
    assert err.value.requirements['symbols'] == ['2330']
    assert err.value.requirements['skip_candidate_allowed'] is False


def test_entitlement_after_its_session_is_rejected():
    future = {'action_id': 'cash-ev', 'symbol': '2330', 'kind': 'cash', 'ex_date': DAYS[1],
              'payable_date': '2026-10-01', 'cash_per_share': 1., 'stock_per_share': 0.}
    with pytest.raises(ValueError, match='future_entitlement'):
        history(DAYS[0], actions=[future])


# ── loader opt-in ──

def test_history_opt_in_reads_only_ga_research_snapshot(monkeypatch):
    seen = {}
    snapshot = {'snapshot_id': 'ga'}
    def resolve(**kwargs):
        seen['resolve'] = kwargs
        return SimpleNamespace(snapshot=snapshot, source='snapshot', to_dict=lambda: {'source': 'snapshot'})
    def load(cls, **kwargs):
        seen['load'] = kwargs
        return dataset({d: history(d) for d in DAYS})
    monkeypatch.setattr(engine, 'resolve_research_data_access', resolve)
    monkeypatch.setattr(engine.BacktestDataset, 'load_from_snapshot_manifest', classmethod(load))
    data, access = engine.BacktestDataset.load_for_research(
        lane='optuna.sltp', start_date=DAYS[0], end_date=DAYS[-1], corporate_history=True)
    assert seen['resolve']['kind'] == 'ga_research_dataset'
    assert seen['resolve']['mode'] == 'snapshot'
    assert seen['resolve']['required_components'] == ('signals', 'corporate_history_records')
    assert seen['load']['allow_corporate_history'] is True
    assert access['corporate_source'] == 'corporate_history_records'
    assert access['corporate_history_exclusion']['excluded_count'] == 0


def test_history_opt_in_refuses_d1_and_a_receipt_tape(monkeypatch):
    with pytest.raises(ValueError, match='requires_snapshot:d1_chunked'):
        engine.BacktestDataset.load_for_research(lane='x', start_date=DAYS[0], end_date=DAYS[-1],
                                                 mode='d1_chunked', corporate_history=True)
    monkeypatch.setattr(engine, 'resolve_research_data_access', lambda **_: SimpleNamespace(
        snapshot={}, source='snapshot', to_dict=lambda: {}))
    receipts = {d: {'session_date': d, 'covered_symbols': ['2330'], 'actions': [], 'blockers': {}} for d in DAYS}
    monkeypatch.setattr(engine.BacktestDataset, 'load_from_snapshot_manifest',
                        classmethod(lambda cls, **_: dataset(receipts)))
    with pytest.raises(ValueError, match='tape_not_loaded'):
        engine.BacktestDataset.load_for_research(lane='x', start_date=DAYS[0], end_date=DAYS[-1],
                                                 corporate_history=True)


def test_default_loader_path_is_unchanged(monkeypatch):
    seen = {}
    def resolve(**kwargs):
        seen.update(kwargs)
        raise RuntimeError('stop')
    monkeypatch.setattr(engine, 'resolve_research_data_access', resolve)
    with pytest.raises(RuntimeError, match='stop'):
        engine.BacktestDataset.load_for_research(lane='x', start_date=DAYS[0], end_date=DAYS[-1])
    assert seen['kind'] == 'backtest_dataset'
    assert seen['required_components'] == ('signals', 'corporate_source_records')


def test_issuer_blocked_while_suspended_is_still_excluded():
    # 2330 has no bar on the blocked session; a position bought earlier would still be held.
    tape = {d: history(d) for d in DAYS}
    tape[DAYS[2]] = history(DAYS[2], blockers={'2330': ['economic_terms_incomplete:cash:KeyError']})
    data = dataset(tape, suspended={('2330', DAYS[2])})
    report = exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])
    assert report['excluded_first_blocked_session'] == {'2330': DAYS[2]}
    assert data.get_universe_at(DAYS[0]) == {'1101'}


def test_revision_of_an_earlier_entitlement_excludes_its_issuer():
    # The entitlement (ex on the first session) is listed from the second session on,
    # and its terms vanish on the third: every past ex_date in the window counts.
    event = {'action_id': 'ev', 'symbol': '2330', 'kind': 'cash', 'ex_date': DAYS[0],
             'payable_date': '2026-10-01', 'cash_per_share': 1., 'stock_per_share': 0., 'cash_rounding': 'floor_twd'}
    tape = {DAYS[0]: history(DAYS[0]), DAYS[1]: history(DAYS[1], actions=[event])}
    tape[DAYS[2]] = history(DAYS[2], blockers={'2330': ['outstanding_event_revision_unresolved']})
    tape[DAYS[2]]['unresolved_outstanding_action_ids'] = {'2330': ['ev']}
    data = dataset(tape)
    report = exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])
    assert report['excluded_first_blocked_session'] == {'2330': DAYS[2]}


def test_ready_history_replays_with_the_research_accounting_assumption(monkeypatch, kv_position_risk):
    # Preflight cannot see an unrounded issuer cash term; the history dataset carries the
    # research accounting assumption so the replay books it instead of raising mid-search.
    days = [*DAYS, '2026-09-08']
    cash = {'action_id': 'cash-ev', 'symbol': '2330', 'kind': 'cash', 'ex_date': days[2],
            'payable_date': days[3], 'cash_per_share': 1.2345, 'stock_per_share': 0.}
    tape = {d: make_history_record({'session_date': d, 'covered_symbols': ['1101', '2330'],
        'actions': [cash] if d >= days[2] else [], 'blockers': {}, 'source_checksum': 'a' * 64,
        'tax_basis': 'gross_before_personal_tax'}, captured_at=CAPTURED, source_refs=REFS,
        history_start=days[0], history_end=days[-1])['snapshot'] for d in days}
    from test_backtest_corporate_accounting import account
    def buy(**kwargs):
        if kwargs['entry_date'] == days[1]:
            kwargs['account'].positions['2330'] = account().positions['2330']
        return []
    monkeypatch.setattr(engine, 'replay_screener_for_date', lambda **_: ['fixture'])
    monkeypatch.setattr(engine, 'simulate_entries_for_date', buy)
    params = {'positionRiskDistribution': kv_position_risk}
    data = dataset(tape, days=days)
    assert exclude_history_blocked_symbols(data, days[0], days[-1])['excluded_count'] == 0
    assert require_corporate_coverage(data, days[0], days[-1])['status'] == 'ready'
    with pytest.raises(ValueError, match='cash_rounding_missing'):
        engine.replay_period(data, days[0], days[-1], params, initial_capital=109000.)
    data.research_accounting = {'cashRoundingMode': 'exact_accrual', 'subscriptionPolicy': 'do_not_subscribe_zero_value'}
    result = engine.replay_period(data, days[0], days[-1], params, initial_capital=109000.)
    assert result.final_equity > 0
    assert 'researchAccounting' not in params  # nothing can reach a KV push
