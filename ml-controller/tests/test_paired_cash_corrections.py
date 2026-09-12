"""Original journal/chain integration; synthetic accounting, not strategy ROI."""
from datetime import datetime, timezone
import json
import math

import pytest

from services.paired_nav_journal import freeze_snapshot, stage_execution_receipt, materialize_pair
from services.paired_nav_chain import verify_journal_chain, read_verified_cash_history, empty_cash_history
from services.paired_nav_evidence import read_verified_nav_evidence
from test_paired_nav_journal import DB, packet, receipt

NOW = datetime(2026, 9, 11, 8, tzinfo=timezone.utc)


def cash_pair(*, correction_price=98, sold=False, extra_day=False):
    db, records = DB(), []
    initial = {'cash': 99000., 'positions': {'2330': 100}, 'marks': {'2330': 100}, 'nav': 109000.}
    action = {'action_id': 'cash', 'symbol': '2330', 'kind': 'cash', 'ex_date': '2026-09-08',
        'payable_date': '2026-09-10', 'cash_per_share': 2., 'stock_per_share': 0.}
    previous = None
    dates = [('2026-09-07', '2026-09-08'), ('2026-09-08', '2026-09-09'), ('2026-09-09', '2026-09-10')]
    if extra_day:
        dates.append(('2026-09-10', '2026-09-11'))
    for signal, day in dates:
        p = {**packet(day, previous), 'initial_account': initial}
        sealed = freeze_snapshot(signal_date=signal, source_run_id='correction:' + signal,
            snapshot_kind='execution_pair', content=p, query=db.query, writer=db.writer,
            now=datetime.fromisoformat(signal + 'T14:00:00+00:00'))
        fills = [{'fill_id': 'sell-original', 'symbol': '2330', 'side': 'sell', 'shares': 100, 'price': 98,
            'commission': 20, 'tax': 29, 'is_day_trade': False, 'executed_at': day + 'T01:10:00Z'}] if sold and previous is None else []
        rec = {**receipt(p, sealed, marks={'2330': correction_price if day == '2026-09-09' else 98}, fills=fills), 'cash_accounting_version': 1,
            'corporate_actions': [] if previous is None else [action]}
        stage_execution_receipt(execution=rec, query=db.query, writer=db.writer, now=NOW)
        args = dict(snapshot_id=sealed['snapshot_id'], session_date=day, execution=rec,
            query=db.query, writer=db.writer, now=NOW)
        result = materialize_pair(**args)
        assert materialize_pair(**args) == result
        records.append(result)
        previous = day
    return db, records


def test_original_materializer_and_complete_chain_recover_cash_without_daily_alpha_or_duplicate_payment():
    db, days = cash_pair()
    a = [d['arms']['candidate'] for d in days]
    assert [r['nav'] for r in a] == [108800, 109000, 109000]
    assert [r['cash'] for r in a] == [99000, 99000, 99200]
    assert a[1]['daily_return'] == 0 and a[2]['daily_return'] == 0
    assert a[1]['reported_opening_nav'] == 108800 and a[1]['return_opening_nav'] == 109000
    assert a[1]['cash_corrections'][0]['eligible_shares'] == 100
    # Earlier evidence remains immutable; its performance still needs an
    # explicitly as-of restatement, never a silent overwrite or new maturity.
    assert a[0]['daily_return'] < 0 and 'cash_corrections' not in a[0]
    assert a[1]['drawdown'] == 0 and a[1]['performance_complete'] is True
    assert a[1]['peak_nav'] == 109000
    result = verify_journal_chain(business_date='2026-09-10', query=db.query, now=NOW, page_size=1)
    assert result['accounted_sessions'] == result['sessions'] == 3
    context = read_verified_cash_history(query=db.query, pair_id='candidate-pair', before_date='2026-09-11', now=NOW)
    assert context['candidate']['openings']['2026-09-08'] == {'2330': 100}
    assert context['candidate']['recognized_cash_ids'] == ['cash']


def test_history_reader_rejects_rehashed_correction_amount_instead_of_trusting_native_or_journal_total():
    from test_paired_nav_chain import corrupt_payload
    db, _ = cash_pair()
    corrupt_payload(db, '2026-09-09', lambda p: p['arms']['candidate']['cash_corrections'][0].update(cash_due=201))
    with pytest.raises(RuntimeError, match='arithmetic_mismatch|accounting_mismatch'):
        read_verified_cash_history(query=db.query, pair_id='candidate-pair', before_date='2026-09-11', now=NOW)


def test_pair_scoped_history_does_not_import_other_account_quantities():
    db, _ = cash_pair()
    absent = read_verified_cash_history(query=db.query, pair_id='another-pair', before_date='2026-09-11', now=NOW)
    assert absent == empty_cash_history()


@pytest.mark.parametrize('price', [97, 99])
def test_correction_does_not_erase_true_loss_or_gain(price):
    db, days = cash_pair(correction_price=price)
    result = days[1]['arms']['candidate']
    expected = (price - 98) * 100 / 109000
    assert result['daily_return'] == pytest.approx(expected)
    assert (result['daily_return'] > 0) == (price > 98)
    assert verify_journal_chain(business_date='2026-09-10', query=db.query, now=NOW)['sessions'] == 3


def test_candidate_sale_does_not_lose_its_original_right_or_borrow_baselines_current_position():
    db, days = cash_pair(sold=True, extra_day=True)
    candidate = [d['arms']['candidate'] for d in days]
    baseline = [d['arms']['baseline'] for d in days]
    assert all(a['positions'] == {} for a in candidate)
    assert all(a['positions'] == {'2330': 100} for a in baseline)
    assert [a['cash'] for a in candidate] == [108751, 108751, 108951, 108951]
    assert candidate[1]['cash_corrections'][0]['eligible_shares'] == 100
    assert candidate[1]['daily_return'] == candidate[2]['daily_return'] == candidate[3]['daily_return'] == 0
    assert candidate[0]['costs'] == 49 and days[0]['net_return_delta'] < 0
    assert verify_journal_chain(business_date='2026-09-11', query=db.query, now=NOW)['sessions'] == 4


@pytest.mark.parametrize('sold', [False, True])
def test_asof_evidence_restates_existing_endpoints_without_new_dates_or_rewriting_journals(sold):
    db, days = cash_pair(sold=sold, correction_price=99)
    original = db.query('SELECT payload_json,payload_checksum FROM paired_nav_daily_journal_v1 ORDER BY session_date', [])
    before = read_verified_nav_evidence(business_date='2026-09-08', query=db.query, now=NOW)
    assert before.pairs[0].observations[0].candidate_daily_return < 0
    assert before.pairs[0].observations[0].accounting_adjustment_checksum is None
    delivered = []
    after = read_verified_nav_evidence(business_date='2026-09-10', query=db.query, now=NOW,
        page_size=1, observe_prefix=delivered.append)
    assert after == read_verified_nav_evidence(business_date='2026-09-10', query=db.query, now=NOW, page_size=3)
    rows = after.pairs[0].observations
    assert len(rows) == 3 and [o.session_date for o in rows] == ['2026-09-08', '2026-09-09', '2026-09-10']
    assert rows[0].candidate_daily_return == pytest.approx(-49 / 109000 if sold else 0)
    assert rows[0].baseline_daily_return == 0
    assert math.prod(1 + o.candidate_daily_return for o in rows) == pytest.approx(days[-1]['arms']['candidate']['nav'] / 109000)
    assert math.prod(1 + o.baseline_daily_return for o in rows) == pytest.approx(1)
    assert rows[0].accounting_adjustment_checksum and rows[1].accounting_adjustment_checksum
    assert rows[2].accounting_adjustment_checksum is None
    assert after.pairs[0].summary()['restated_nav_sessions'] == 2
    assert [p['candidate_daily_return'] for p in delivered] == [o.candidate_daily_return for o in rows]
    assert original == db.query('SELECT payload_json,payload_checksum FROM paired_nav_daily_journal_v1 ORDER BY session_date', [])
    assert after.coverage['accounted_sessions'] == after.coverage['sessions'] == 3


def test_corrupt_late_record_cannot_publish_an_earlier_unrestated_prefix_to_effect_consumer():
    from test_paired_nav_chain import corrupt_payload
    db, _ = cash_pair()
    corrupt_payload(db, '2026-09-10', lambda p: p.update(net_return_delta=123))
    seen = []
    with pytest.raises(RuntimeError, match='arithmetic_mismatch'):
        read_verified_nav_evidence(business_date='2026-09-10', query=db.query, now=NOW, page_size=1,
            observe_prefix=seen.append)
    assert seen == []
