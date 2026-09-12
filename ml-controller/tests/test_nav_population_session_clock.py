"""Original frozen sessions: a date is not proof that its close is observable."""
from datetime import datetime

import pytest

from services.paired_nav_daily_review import run_daily_nav_reviews
from services.paired_nav_evidence import read_verified_nav_evidence
from services.paired_nav_journal import mature_staged_pairs
from test_paired_nav_lifecycle import environment, registered_old
from test_paired_nav_review_store import migrate


def test_open_session_is_pending_in_accounting_population_and_daily_review(environment):
    db, *_ = environment
    registered_old(environment, materialize=False)
    migrate(db)
    now = datetime.fromisoformat('2026-09-08T05:29:59+00:00')
    result = mature_staged_pairs(business_date='2026-09-08', query=db.query, writer=db.writer, now=now)
    assert result['status'] == 'awaiting_session_close' and result['open_pair_sessions'] == 2
    population = result['paired_nav_evidence']['candidate_population']
    assert all(p['execution_status'] == 'awaiting_session_close' for p in population['pairs'])
    assert all(not p['unaccounted_session_dates'] for p in population['pairs'])
    assert all(p['upcoming_session_dates'] == ['2026-09-08'] for p in population['pairs'])
    review = run_daily_nav_reviews(business_date='2026-09-08', query=db.query, writer=db.writer, now=now)
    assert review['status'] == 'daily_nav_reviews_current' and not review['failures']
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])


@pytest.mark.parametrize('timestamp', ['2026-09-08T05:30:00+00:00', '2026-09-08T13:30:00+08:00'])
def test_exact_close_is_due_in_all_readers_without_a_timezone_shift(environment, timestamp):
    db, *_ = environment
    registered_old(environment, materialize=False)
    now = datetime.fromisoformat(timestamp)
    population = read_verified_nav_evidence(business_date='2026-09-08', query=db.query, now=now).summary()['candidate_population']
    assert all(p['execution_status'] == 'registered_evidence_missing' for p in population['pairs'])
    assert all(p['unaccounted_session_dates'] == ['2026-09-08'] for p in population['pairs'])
    with pytest.raises(RuntimeError, match='due_execution_receipt_missing'):
        mature_staged_pairs(business_date='2026-09-08', query=db.query, writer=db.writer, now=now)


def test_a_completed_journal_cannot_be_used_before_its_frozen_session_close(environment):
    db, *_ = environment
    registered_old(environment)
    with pytest.raises(ValueError, match='raw_execution_not_observable'):
        read_verified_nav_evidence(business_date='2026-09-08', query=db.query,
            now=datetime.fromisoformat('2026-09-08T05:29:59+00:00'))


def test_direct_durable_review_uses_its_supplied_clock(environment):
    from test_paired_nav_review_store import record
    db, *_ = environment
    registered_old(environment, materialize=False)
    migrate(db)
    result = record(db, business_date='2026-09-08',
        now=datetime.fromisoformat('2026-09-08T05:29:59+00:00'))
    assert result['waiting_families']
    assert all('registered_evidence_missing' not in f['reasons'] for f in result['waiting_families'])
