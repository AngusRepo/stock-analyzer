"""Retired experiment audit tests, explicitly invoked outside nightly runtime."""
from datetime import datetime, timedelta, timezone
import json
import sqlite3

import pytest

from services.paired_nav_journal import digest, freeze_snapshot, mature_staged_pairs, stage_execution_receipt
from services.paired_nav_sequential_state import DailyAssessmentReservations, allocation_fraction, nominate_allocation
from test_paired_nav_journal import DB, packet, receipt

STAMP = datetime(2026, 9, 7, 14, tzinfo=timezone.utc)


def nominate(db, *, pair=None, training='cohort-A', now=STAMP):
    p = pair or packet()
    plan = {k: p[k] for k in ('pair_id', 'candidate_checksum', 'baseline_checksum', 'configuration_checksum')}
    plan.update(owner='l4_alpha_ev', candidate_training_run_id=training)
    frozen = freeze_snapshot(signal_date='2026-09-07', source_run_id=digest(plan),
        snapshot_kind='allocation_pair', content=plan, query=db.query, writer=db.writer, now=STAMP)
    return nominate_allocation(allocation_snapshot_id=frozen['snapshot_id'], query=db.query, writer=db.writer, now=now)


def sessions(db, n):
    days = []
    day = STAMP.date()
    while len(days) < n:
        day += timedelta(days=1)
        if day.weekday() < 5:
            days.append(day.isoformat())
    previous = None
    for day in days:
        p = packet(day, previous)
        signal = previous or '2026-09-07'
        seal = freeze_snapshot(signal_date=signal, source_run_id=p['pair_id'] + ':' + signal,
            snapshot_kind='execution_pair', content=p, query=db.query, writer=db.writer,
            now=datetime.fromisoformat(signal + 'T14:00:00+00:00'))
        stage_execution_receipt(execution=receipt(p, seal), query=db.query, writer=db.writer,
            now=datetime(2026, 10, 31, tzinfo=timezone.utc))
        previous = day
    return days


def nightly(db, day):
    # Explicit research replay only. The actual nightly owner has no budget dependency.
    from services.paired_nav_evidence import read_verified_nav_evidence
    assessments = DailyAssessmentReservations(db.query)
    result = mature_staged_pairs(business_date=day, query=db.query, writer=db.writer,
        now=datetime(2026, 10, 31, tzinfo=timezone.utc))
    read_verified_nav_evidence(now=datetime(2026, 10, 31, tzinfo=timezone.utc), business_date=day, query=db.query, observe_prefix=assessments.observe)
    return {**result, 'sequential_assessment_state': assessments.persist(db.writer)}


def records(db):
    return db.query('SELECT * FROM paired_nav_assessment_reservations_v1 ORDER BY look_ordinal', [])


def test_daily_tenth_day_then_catchup_and_retries_never_reset_budget():
    db = DB()
    nomination = nominate(db)
    days = sessions(db, 12)
    assert nightly(db, days[8])['sequential_assessment_state']['new_reservations'] == 0
    assert nightly(db, days[9])['sequential_assessment_state']['new_reservations'] == 1
    assert nightly(db, days[-1])['sequential_assessment_state']['new_reservations'] == 2
    before = records(db)
    assert nightly(db, days[-1])['sequential_assessment_state']['new_reservations'] == 0
    assert records(db) == before
    bodies = [json.loads(r['payload_json']) for r in before]
    assert [r['look_ordinal'] for r in bodies] == [1, 2, 3]
    assert [r['reserved_alpha'] for r in bodies] == [nomination['hypothesis_alpha'] * allocation_fraction(i) for i in (1, 2, 3)]
    assert bodies[0]['previous_assessment_checksum'] is None
    assert bodies[1]['previous_assessment_checksum'] == before[0]['payload_checksum']
    assert all(r['exact_nav_sessions'] == r['accounted_sessions'] and not r['promotion_allowed'] for r in bodies)


def test_family_config_change_reserves_new_hypothesis_but_alias_cannot_reset():
    db = DB()
    first = nominate(db)
    assert nominate(db, now=STAMP + timedelta(days=20)) == first
    second_pair = packet()
    second_pair.update(pair_id='second', configuration_checksum='d' * 64)
    second = nominate(db, pair=second_pair)
    assert first['family_id'] == second['family_id']
    assert [first['family_ordinal'], second['family_ordinal']] == [1, 2]
    assert second['hypothesis_alpha'] == pytest.approx(.05 / 6)
    alias = packet()
    alias['pair_id'] = 'alias'
    with pytest.raises(RuntimeError, match='identity_conflict'):
        nominate(db, pair=alias)
    with pytest.raises(RuntimeError, match='identity_conflict'):
        nominate(db, training='renamed-cohort')


@pytest.mark.parametrize('now', [STAMP - timedelta(seconds=1), STAMP + timedelta(days=1), STAMP.replace(tzinfo=None)])
def test_new_nomination_cannot_be_backdated(now):
    with pytest.raises(ValueError, match='outcome_boundary|timezone_required'):
        nominate(DB(), now=now)


def test_observed_outcomes_cannot_be_nominated_retroactively():
    db = DB()
    days = sessions(db, 1)
    nightly(db, days[-1])
    with pytest.raises(ValueError, match='outcomes_already_observed'):
        nominate(db)


@pytest.mark.parametrize('recursive', [0, 1])
@pytest.mark.parametrize('table,stem', [('paired_nav_nominations_v1', 'nav_nomination'),
    ('paired_nav_assessment_reservations_v1', 'nav_assessment')])
def test_records_cannot_be_deleted_updated_or_replaced(recursive, table, stem):
    db = DB()
    nominate(db)
    nightly(db, sessions(db, 10)[-1])
    db.conn.execute(f'PRAGMA recursive_triggers={recursive}')
    original = db.query(f'SELECT * FROM {table}', [])
    for sql in (f'DELETE FROM {table}', f"UPDATE {table} SET payload_checksum='bad'",
                f"INSERT OR REPLACE INTO {table} SELECT " + ','.join("'bad'" if k == 'payload_checksum' else k for k in original[0]) + f' FROM {table}'):
        with pytest.raises(sqlite3.IntegrityError, match=stem + '_immutable'):
            db.conn.execute(sql)
    db.conn.execute(f'INSERT OR REPLACE INTO {table} SELECT * FROM {table}')
    assert db.query(f'SELECT * FROM {table}', []) == original


def test_alpha_total_is_bounded_for_future_candidates_and_daily_looks():
    total = sum(allocation_fraction(i) for i in range(1, 10001))
    assert total == pytest.approx(1 - 1 / 10001)
    assert .05 * total * total < .05


def test_missing_migration_blocks_only_explicit_legacy_assessment():
    db = DB()
    day = sessions(db, 1)[-1]
    db.conn.execute('DROP TABLE paired_nav_assessment_reservations_v1')
    with pytest.raises(RuntimeError, match='migration_0042_missing'):
        nightly(db, day)
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])


def test_missing_guard_is_not_silently_accepted():
    db = DB()
    db.conn.execute('DROP TRIGGER nav_assessment_no_delete_v1')
    with pytest.raises(RuntimeError, match='immutability_missing'):
        DailyAssessmentReservations(db.query)


def test_deleted_middle_reservation_cannot_hide_behind_valid_latest_record():
    db = DB()
    nominate(db)
    day = sessions(db, 12)[-1]
    nightly(db, day)
    db.conn.execute('DROP TRIGGER nav_assessment_no_delete_v1')
    trigger = DB().query("SELECT sql FROM sqlite_master WHERE name='nav_assessment_no_delete_v1'", [])[0]['sql']
    db.conn.execute('DELETE FROM paired_nav_assessment_reservations_v1 WHERE look_ordinal=2')
    db.conn.execute(trigger)
    with pytest.raises(RuntimeError, match='history_gap'):
        nightly(db, day)


def test_partial_assessment_write_recovers_from_persisted_prefix_not_zero():
    db = DB()
    nominate(db)
    days = sessions(db, 12)
    nightly(db, days[9])
    expected_first = records(db)[0]
    original_writer = db.writer

    def interrupted(statements):
        if any('INSERT OR IGNORE INTO paired_nav_assessment_reservations_v1' in sql for sql, _ in statements):
            original_writer(statements[:1])
            raise RuntimeError('simulated_process_loss')
        return original_writer(statements)

    db.writer = interrupted
    with pytest.raises(RuntimeError, match='simulated_process_loss'):
        nightly(db, days[-1])
    assert [r['look_ordinal'] for r in records(db)] == [1, 2]
    db.writer = original_writer
    assert nightly(db, days[-1])['sequential_assessment_state']['new_reservations'] == 1
    assert [r['look_ordinal'] for r in records(db)] == [1, 2, 3]
    assert records(db)[0] == expected_first
