"""Synthetic accounting controls, never retrospective promotion observations."""
from copy import deepcopy
from datetime import datetime, timezone
import json

import pytest

from services.paired_nav_journal import account_valuation, replay_session, materialize_pair, mature_staged_pairs
from services.paired_native_session import validate_native_account
from test_paired_nav_journal import DB, FEES, packet, seal, receipt, stage_execution_receipt
from test_subscription_rights import action


def test_unknown_interval_keeps_all_days_and_new_trades_without_fabricating_returns():
    previous = {'cash': 99000., 'positions': {'2330': 100}, 'marks': {'2330': 100.}, 'nav': 109000.}
    books = []
    for day in ('2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'):
        fills = [] if day != '2026-09-08' else [{'fill_id': 'other-buy', 'symbol': '2317',
            'side': 'buy', 'shares': 10, 'price': 100., 'commission': 20, 'tax': 0,
            'executed_at': day + 'T01:10:00Z'}]
        previous = replay_session(previous=previous, fills=fills, marks={'2330': 99., '2317': 100.},
            corporate_actions=[action()], session_date=day, fees=FEES, allow_unpriced_rights=True)
        books.append(previous)
    assert len(books) == 4 and books[1]['positions']['2317'] == 10
    assert [b['nav'] for b in books] == [None, None, None, 108880.]
    assert [b['daily_return'] for b in books] == [None] * 4
    assert all(b['performance_complete'] is False for b in books)
    assert books[-1]['valuation_complete'] is True  # Expiry is not retroactive valuation.
    assert books[-1]['cash'] == 97980. and not books[-1]['corporate_receivables']
    resumed = replay_session(previous=books[-1], fills=[], marks={'2330': 100., '2317': 101.},
        corporate_actions=[action()], session_date='2026-09-11', fees=FEES, allow_unpriced_rights=True)
    assert resumed['nav'] == 108990.
    assert resumed['daily_return'] == pytest.approx(108990. / 108880. - 1)
    assert resumed['turnover'] == 0
    assert resumed['performance_complete'] is False and resumed['drawdown'] is None
    assert resumed['peak_nav'] is None  # Never reset the unknown historical peak.


def test_nightly_records_provisional_ledger_idempotently_but_counts_zero_nav_days():
    db, previous_day = DB(), None
    now = datetime(2026, 9, 11, 8, tzinfo=timezone.utc)
    for signal, day in [('2026-09-04', '2026-09-07'), ('2026-09-07', '2026-09-08'),
                        ('2026-09-08', '2026-09-09'), ('2026-09-09', '2026-09-10')]:
        p = packet(day, previous_day)
        p['initial_account'] = {'cash': 99000., 'positions': {'2330': 100},
            'marks': {'2330': 100.}, 'nav': 109000.}
        frozen = seal(db, p, signal)
        rec = receipt(p, frozen, marks={'2330': 99.})
        rec['corporate_actions'] = [action()]
        stage_execution_receipt(execution=rec, query=db.query, writer=db.writer, now=now)
        previous_day = day
    args = dict(business_date='2026-09-10', query=db.query, writer=db.writer, now=now)
    result = mature_staged_pairs(**args)
    assert result['processed_pair_sessions'] == result['accounted_pair_sessions'] == 4
    assert result['recorded_pair_sessions'] == 0 and result['unverified_pair_sessions'] == 4
    assert result['bounded_pair_sessions'] == 4 and result['journal_chain_verified'] is True
    assert result['latest_nav_session'] is None and result['latest_accounting_session'] == '2026-09-10'
    assert result['status'] == 'valuation_incomplete' and not result['promotion_allowed']
    assert mature_staged_pairs(**args)['processed_pair_sessions'] == 0
    rows = db.query('SELECT payload_json FROM paired_nav_daily_journal_v1 ORDER BY session_date', [])
    assert len(rows) == 4
    assert all(json.loads(row['payload_json'])['net_return_delta'] is None for row in rows)
    p = packet('2026-09-11', '2026-09-10')
    p['initial_account'] = {'cash': 99000., 'positions': {'2330': 100},
        'marks': {'2330': 100.}, 'nav': 109000.}
    frozen = seal(db, p, '2026-09-10')
    rec = receipt(p, frozen, marks={'2330': 100.})
    rec['corporate_actions'] = [action()]
    stage_execution_receipt(execution=rec, query=db.query, writer=db.writer, now=now)
    resumed_args = {**args, 'business_date': '2026-09-11'}
    resumed = mature_staged_pairs(**resumed_args)
    assert resumed['accounted_pair_sessions'] == 5 and resumed['recorded_pair_sessions'] == 1
    assert resumed['bounded_pair_sessions'] == 5
    assert resumed['unverified_pair_sessions'] == 4 and resumed['latest_nav_session'] == '2026-09-11'
    assert resumed['status'] == 'valuation_incomplete' and not resumed['promotion_allowed']
    assert mature_staged_pairs(**resumed_args)['processed_pair_sessions'] == 0
    latest = json.loads(db.query('SELECT payload_json FROM paired_nav_daily_journal_v1 ORDER BY session_date DESC LIMIT 1', [])[0]['payload_json'])
    assert latest['net_return_delta'] == 0  # A genuine paired zero is a valid observation.
    assert latest['arms']['candidate']['performance_complete'] is False


def test_native_reconciliation_checks_every_right_term_and_quantity():
    initial = {'cash': 99000., 'positions': {'2330': 100}, 'nav': 109000.}
    book = replay_session(previous=initial, fills=[], marks={'2330': 99.}, corporate_actions=[action()],
        session_date='2026-09-07', fees=FEES, allow_unpriced_rights=True)
    validate_native_account(book, book)
    for field, value in [('quantity', 7), ('subscription_price', 84), ('payment_deadline', '2026-09-10')]:
        bad = deepcopy(book)
        rights = json.loads(bad['corporate_receivables'][0]['rights_json'])
        rights[field] = value
        bad['corporate_receivables'][0]['rights_json'] = json.dumps(rights)
        with pytest.raises(ValueError, match='receivables_do_not_reconcile'):
            validate_native_account(bad, book)
    with pytest.raises(ValueError, match='nav_does_not_reconcile'):
        validate_native_account({**book, 'nav': book['nav_lower_bound']}, book)
    with pytest.raises(ValueError, match='invalid_number'):
        account_valuation(book, {})


@pytest.mark.parametrize('shares', [100, 1000, 2000])
def test_dividend_accounting_vs_price_only_is_not_investment_alpha(shares):
    initial = {'cash': 99000., 'positions': {'2330': shares}, 'nav': 99000. + 100 * shares}
    dividend = {'action_id': 'cash', 'symbol': '2330', 'kind': 'cash', 'ex_date': '2026-09-07',
        'payable_date': '2026-09-09', 'cash_per_share': 2., 'stock_per_share': 0.}
    ex = replay_session(previous=initial, fills=[], marks={'2330': 98.}, corporate_actions=[dividend],
        session_date='2026-09-07', fees=FEES)
    paid = replay_session(previous=ex, fills=[], marks={'2330': 98.}, corporate_actions=[dividend],
        session_date='2026-09-09', fees=FEES)
    assert ex['cash'] == 99000. and ex['nav'] == initial['nav']
    assert ex['corporate_receivables'][0]['cash_due'] == 2 * shares
    assert paid['cash'] == 99000. + 2 * shares and paid['nav'] == initial['nav']
    assert ex['nav'] - (99000. + 98 * shares) == 2 * shares
