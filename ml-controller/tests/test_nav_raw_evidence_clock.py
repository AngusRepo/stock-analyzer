"""Original SQLite receipts, not return-summary mocks or investment results."""
from datetime import datetime

import pytest

from services.paired_nav_evidence import read_verified_nav_evidence
from services.paired_nav_journal import materialize_pair, stage_execution_receipt
from test_paired_nav_journal import DB, packet, receipt, seal


def clock(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def delayed_receipt(*, materialize=True):
    db = DB()
    content = packet()
    frozen = seal(db, content)
    raw = receipt(content, frozen)
    received = clock('2026-09-09T08:00:00Z')
    stage_execution_receipt(execution=raw, query=db.query, writer=db.writer, now=received)
    if materialize:
        materialize_pair(snapshot_id=frozen['snapshot_id'], session_date=content['session_date'],
            execution=raw, query=db.query, writer=db.writer, now=received)
    return db, received


@pytest.mark.parametrize('as_of', [
    '2026-09-07T13:59:59Z',  # Even the pre-market execution snapshot did not exist.
    '2026-09-08T05:45:00Z',  # Close happened, but the original observation did not.
    '2026-09-08T08:00:00Z',  # Observed, but not durably received until tomorrow.
    '2026-09-09T07:59:59Z',
])
def test_later_raw_receipt_cannot_be_used_in_an_earlier_decision(as_of):
    db, _ = delayed_receipt()
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
    seen = []
    with pytest.raises(ValueError, match='paired_nav_.*(available|observable|future)'):
        read_verified_nav_evidence(business_date='2026-09-08', query=db.query,
            now=clock(as_of), observe_prefix=seen.append)
    assert seen == []
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == before


def test_delayed_receipt_becomes_usable_at_receipt_time_without_rewriting_history():
    db, received = delayed_receipt()
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
    first = read_verified_nav_evidence(business_date='2026-09-08', query=db.query, now=received)
    later = read_verified_nav_evidence(business_date='2026-09-08', query=db.query,
        now=clock('2026-09-10T08:00:00Z'))
    assert first == later
    assert first.coverage['accounted_sessions'] == 1
    assert first.pairs[0].observations[0].session_date == '2026-09-08'
    assert first.pairs[0].observations[0].net_return_delta == 0
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == before


def test_naive_clock_is_rejected_before_observing_any_journal():
    db, received = delayed_receipt()
    seen = []
    with pytest.raises(ValueError, match='timezone_required'):
        read_verified_nav_evidence(business_date='2026-09-08', query=db.query,
            now=received.replace(tzinfo=None), observe_prefix=seen.append)
    assert seen == []


def test_pending_receipt_is_checked_before_daily_accounting_writes_and_can_retry():
    from services.paired_nav_journal import mature_staged_pairs
    db, received = delayed_receipt(materialize=False)
    with pytest.raises(ValueError, match='raw_execution_not_observable'):
        mature_staged_pairs(business_date='2026-09-08', query=db.query,
            writer=lambda _: pytest.fail('future evidence must not write a journal'),
            now=clock('2026-09-08T08:00:00Z'))
    result = mature_staged_pairs(business_date='2026-09-08', query=db.query, writer=db.writer, now=received)
    assert result['processed_pair_sessions'] == 1
    assert mature_staged_pairs(business_date='2026-09-08', query=db.query,
        writer=db.writer, now=received)['processed_pair_sessions'] == 0


@pytest.mark.parametrize('kind', ['allocation_context', 'allocation_pair', 'execution_pair'])
def test_unobserved_frozen_population_is_not_dropped_or_counted_even_without_nav(kind):
    from services.paired_nav_journal import freeze_snapshot
    db = DB()
    freeze_snapshot(signal_date='2026-09-08', source_run_id='time-boundary:' + kind,
        snapshot_kind=kind, content={}, query=db.query, writer=db.writer,
        now=clock('2026-09-08T14:00:00Z'))
    with pytest.raises(ValueError, match='population_snapshot_not_available'):
        read_verified_nav_evidence(business_date='2026-09-08', query=db.query,
            now=clock('2026-09-08T13:59:59Z'))


@pytest.mark.parametrize('consumer', ['effects', 'families', 'daily', 'candidate'])
def test_real_consumers_do_not_compute_or_reserve_from_later_receipts(consumer):
    from services.paired_nav_effect_inference import evaluate_nav_effects
    from services.paired_nav_family_review import review_nav_families
    from services.paired_nav_daily_review import run_daily_nav_reviews
    from services.paired_nav_candidate_decision import read_nav_candidate_decision
    from test_paired_nav_family_review import EFFECT, BUDGET
    from test_paired_nav_review_store import migrate
    db, _ = delayed_receipt()
    migrate(db)
    args = dict(business_date='2026-09-08', query=db.query, now=clock('2026-09-08T08:00:00Z'))
    with pytest.raises(ValueError, match='raw_execution_not_observable'):
        if consumer == 'effects':
            evaluate_nav_effects(**args, policy=EFFECT)
        elif consumer == 'families':
            review_nav_families(**args, effect_policy=EFFECT, budget=BUDGET, review_id='first')
        elif consumer == 'daily':
            run_daily_nav_reviews(**args, writer=lambda _: pytest.fail('must not spend review budget'))
        else:
            read_nav_candidate_decision(**args, owner='l4_alpha_ev',
                candidate_checksum='c' * 64, candidate_artifact_id='fixture-candidate')
