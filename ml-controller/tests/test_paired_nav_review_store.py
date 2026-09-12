"""SQLite durability/recovery fixtures; synthetic input, never investment ROI."""
from dataclasses import replace
from datetime import datetime
from pathlib import Path
import sqlite3

import pytest

from services import paired_nav_review_store as store
from services.paired_nav_family_review import NavReviewBudget
from test_paired_nav_family_review import EFFECT, BUDGET, stub_numerical_effect
from test_paired_nav_lifecycle import environment, registered_old, successor_context, collect, stamp

STORE_EFFECT = replace(EFFECT, policy_id='test-two-session-storage-only', min_sessions=2, block_length=1)


def migrate(db):
    path = Path(__file__).parents[2] / 'worker/domain-migrations/learning/0044_paired_nav_review_records.sql'
    db.conn.executescript(path.read_text(encoding='utf-8'))


def record(db, **kwargs):
    return store.record_nav_family_reviews(**{'business_date': '2026-09-09',
        'query': db.query, 'writer': db.writer, 'effect_policy': STORE_EFFECT,
        'budget': BUDGET, 'review_id': 'first', 'now': stamp('2026-09-09'), **kwargs})


def two_sessions(environment, monkeypatch):
    from services.paired_nav_journal import read_snapshot, freeze_snapshot, digest, stage_execution_receipt, mature_staged_pairs
    from test_paired_nav_journal import packet, receipt, buy, FEES
    db, *_ = environment
    registered_old(environment)
    next_day = collect(environment, successor_context(environment, monkeypatch, changed=False))
    for item in next_day['plans']:
        plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
        p = packet('2026-09-09', '2026-09-08')
        p.update({k: plan[k] for k in ('pair_id','owner','candidate_checksum','baseline_checksum')})
        p.update(allocation_snapshot_id=item['snapshot_id'], configuration={**plan['configuration'], 'fees': FEES},
            schedule=[{'observed_at': '2026-09-09T00:00:00Z'}])
        p['configuration_checksum'] = digest(p['configuration'])
        saved = freeze_snapshot(signal_date='2026-09-08', source_run_id=p['pair_id'], snapshot_kind='execution_pair',
            content=p, query=db.query, writer=db.writer, now=stamp('2026-09-08'))
        stage_execution_receipt(execution=receipt(p, saved, fills=[buy('2026-09-09')], marks={'2330':105}),
            query=db.query, writer=db.writer, now=stamp('2026-09-09'))
    mature_staged_pairs(business_date='2026-09-09', query=db.query, writer=db.writer, now=stamp('2026-09-09'))


@pytest.fixture
def ready(environment, monkeypatch):
    db, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    stub_numerical_effect(monkeypatch)
    return db


def test_missing_migration_fails_before_writes_without_breaking_accounting(environment):
    from services.paired_nav_journal import mature_staged_pairs
    db, *_ = environment
    registered_old(environment)
    with pytest.raises(RuntimeError, match='migration_0044'):
        record(db, writer=lambda _: pytest.fail('must preflight before writes'))
    result = mature_staged_pairs(business_date='2026-09-08', query=db.query, writer=db.writer, now=stamp('2026-09-08'))
    assert result['status'] == 'up_to_date'


def test_retry_and_later_day_do_not_spend_again_or_relabel_old_evidence(ready):
    first = record(ready)
    assert first['status'] == 'reviews_recorded' and len(first['reviews']) == 2
    assert set(first['reserved_alpha_by_family'].values()) == {.025}
    rows = ready.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', [])
    second = record(ready, business_date='2026-09-10', now=stamp('2026-09-10'))
    assert all(r['status'] == 'existing_review_verified' for r in second['reviews'])
    assert all(r['body']['as_of_date'] == '2026-09-09' for r in second['reviews'])
    assert second['requested_as_of_date'] == '2026-09-10'
    assert second['reserved_alpha_by_family'] == first['reserved_alpha_by_family']
    assert ready.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', []) == rows
    assert second['promotion_allowed'] is False


def test_second_named_review_uses_remaining_allocation_and_policy_is_locked(ready):
    record(ready)
    second = record(ready, review_id='final')
    assert set(second['reserved_alpha_by_family'].values()) == {.05}
    assert len(ready.query(f"SELECT * FROM {store.RECORDS} WHERE record_kind='review'", [])) == 4
    with pytest.raises(RuntimeError, match='immutable_input_conflict'):
        record(ready, budget=NavReviewBudget(BUDGET.protocol_id, .1, (('first', .05), ('final', .05))))
    with pytest.raises(RuntimeError, match='immutable_input_conflict'):
        record(ready, effect_policy=replace(EFFECT, resamples=3999))
    with pytest.raises(ValueError, match='unallocated_review'):
        record(ready, review_id='another')


@pytest.mark.parametrize('after_commit', [False, True])
def test_atomic_review_failure_retains_reservation_and_recovers(ready, after_commit):
    original = ready.writer
    failed = False
    def writer(statements):
        nonlocal failed
        # Reservation has committed; fail the first whole review transaction.
        is_review = any(store.RECORDS in sql and params[1] == 'review' for sql, params in statements)
        if not failed and is_review:
            failed = True
            if after_commit:
                original(statements)
            raise RuntimeError('fixture_remote_ack_lost')
        return original(statements)
    first = record(ready, writer=writer)
    assert first['status'] == 'partial_review_recording'
    assert len(first['failures']) == 1 and len(first['reviews']) == 1
    assert set(first['reserved_alpha_by_family'].values()) == {.025}
    headers = ready.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', [])
    restored = record(ready)
    assert restored['status'] == 'reviews_recorded' and len(restored['reviews']) == 2
    final = ready.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', [])
    assert len(final) == len(headers) + (0 if after_commit else 1)
    assert all(row in final for row in headers)


def test_unchanged_slot_cannot_accept_changed_original_numerical_result(ready, monkeypatch):
    first = record(ready)
    before = ready.query(f'SELECT * FROM {store.PARTS} ORDER BY record_id,part_no', [])
    stub_numerical_effect(monkeypatch, p=.001)
    result = record(ready)
    assert result['status'] == 'partial_review_recording' and len(result['failures']) == 2
    assert all(f['reason'] == 'nav_review_immutable_input_conflict' for f in result['failures'])
    assert result['reserved_alpha_by_family'] == first['reserved_alpha_by_family']
    assert ready.query(f'SELECT * FROM {store.PARTS} ORDER BY record_id,part_no', []) == before


def test_unmature_data_records_protocol_but_does_not_consume_review(environment):
    db, *_ = environment
    migrate(db)
    registered_old(environment)
    result = record(db)
    assert result['status'] == 'awaiting_review_evidence'
    assert result['reserved_alpha_by_family'] == {} and result['reviews'] == []
    assert len(db.query(f'SELECT * FROM {store.RECORDS}', [])) == 1


@pytest.mark.parametrize('operation', ['UPDATE','DELETE','REPLACE'])
def test_sql_guards_reject_destructive_record_changes(ready, operation):
    record(ready)
    row = ready.query(f'SELECT * FROM {store.RECORDS} LIMIT 1', [])[0]
    with pytest.raises(sqlite3.IntegrityError, match='immutable'):
        if operation == 'UPDATE':
            ready.conn.execute(f"UPDATE {store.RECORDS} SET payload_checksum='bad' WHERE record_id=?", [row['record_id']])
        elif operation == 'DELETE':
            ready.conn.execute(f'DELETE FROM {store.RECORDS} WHERE record_id=?', [row['record_id']])
        else:
            keys = list(row)
            values = [row[k] if k != 'payload_checksum' else 'bad' for k in keys]
            ready.conn.execute(f"INSERT OR REPLACE INTO {store.RECORDS}({','.join(keys)}) VALUES({','.join('?' for _ in keys)})", values)


def test_guard_missing_and_future_clock_fail_without_new_review_writes(ready):
    with pytest.raises(ValueError, match='timezone_required'):
        record(ready, now=datetime(2026,9,8))
    with pytest.raises(ValueError, match='future_asof'):
        record(ready, business_date='2026-10-01')
    ready.conn.execute('DROP TRIGGER nav_review_part_no_delete_v1')
    with pytest.raises(RuntimeError, match='immutable_guard_missing'):
        record(ready, writer=lambda _: pytest.fail('preflight must reject before writing'))


@pytest.mark.parametrize('after_commit', [False, True])
def test_failed_reservation_never_runs_its_statistics_and_sibling_continues(ready, monkeypatch, after_commit):
    from services import paired_nav_family_review as family_review
    from services.paired_nav_journal import digest
    original_effect, original_writer = family_review._evaluate_pair, ready.writer
    called, failed_family = [], []
    def effect(pair, policy):
        family_id = digest(['paired-nav-owner-population-v1', dict(pair.comparison)['owner']])
        key = store._key(BUDGET.protocol_id, family_id, 'first', 'reservation')
        reservation = store.read_review_record(query=ready.query, record_id=key)
        assert reservation['body']['as_of_date'] == '2026-09-09'
        called.append(family_id)
        return original_effect(pair, policy)
    monkeypatch.setattr(family_review, '_evaluate_pair', effect)
    def writer(statements):
        sql, params = statements[0]
        if not failed_family and store.RECORDS in sql and params[1] == 'reservation':
            failed_family.append(params[3])
            if after_commit:
                original_writer(statements)
            raise RuntimeError('fixture_reservation_unacknowledged')
        return original_writer(statements)
    first = record(ready, writer=writer)
    assert first['status'] == 'partial_review_recording' and len(first['reviews']) == 1
    assert len(called) == 1 and failed_family[0] not in called
    called.clear()
    final = record(ready)
    assert final['status'] == 'reviews_recorded' and len(called) == 2
    assert set(final['reserved_alpha_by_family'].values()) == {.025}


def test_real_receipts_to_numerical_review_to_immutable_record_without_effect_stub(environment, monkeypatch):
    db, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])
    result = record(db)
    assert result['status'] == 'reviews_recorded' and len(result['reviews']) == 2
    for saved in result['reviews']:
        assert saved['body']['reservation_checksum']
        assert saved['body']['effects'][0]['inference_status'] == 'evaluated_fixed_sample'
        assert saved['body']['effects'][0]['mean_daily_nav_delta'] == pytest.approx(.0024)
        assert saved['body']['effects'][0]['accounted_sessions'] == 2
        assert saved['body']['promotion_allowed'] is False
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', []) == before


def test_large_payload_partial_parts_cannot_publish_and_identical_retry_finishes(ready):
    body = {'record_kind': 'reservation', 'protocol_id': 'large-storage-fixture',
        'family_id': 'family-fixture', 'review_id': 'first', 'as_of_date': '2026-09-09',
        'payload': '測試😀' * 30000, 'promotion_allowed': False}
    original_writer, failed = ready.writer, False
    def writer(statements):
        nonlocal failed
        if any(store.PARTS in sql for sql, _ in statements) and not failed:
            failed = True
            original_writer(statements[:1])
            return {'success_count': 1, 'error_count': len(statements)-1}
        return original_writer(statements)
    with pytest.raises(RuntimeError, match='write_incomplete'):
        store._freeze(body=body, query=ready.query, writer=writer, now=stamp('2026-09-09'))
    key = store._key('large-storage-fixture', 'family-fixture', 'first', 'reservation')
    with pytest.raises(RuntimeError, match='parts_incomplete'):
        store.read_review_record(query=ready.query, record_id=key)
    header = store._header(ready.query, key)
    saved = store._freeze(body=body, query=ready.query, writer=original_writer, now=stamp('2026-09-10'))
    assert saved['body'] == body and saved['header'] == header
    assert saved['header']['part_count'] > 1


def test_writer_success_claim_without_rows_cannot_publish_protocol(ready):
    with pytest.raises(RuntimeError, match='reservation_readback_failed'):
        record(ready, writer=lambda statements: {'success_count':len(statements), 'error_count':0})
    assert ready.query(f'SELECT * FROM {store.RECORDS}', []) == []
