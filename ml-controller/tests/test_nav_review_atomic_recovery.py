"""Immutable review recovery across new publications; synthetic, not ROI."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
from types import SimpleNamespace

import pytest

from services import paired_nav_daily_review as daily
from services import paired_nav_review_store as store
from test_paired_nav_lifecycle import environment, stamp
from test_paired_nav_review_store import migrate, two_sessions
from test_paired_nav_daily_review import local_policy, append_session


def test_lost_reservation_ack_recovers_after_new_same_signal_plans(environment, monkeypatch, local_policy):
    db, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    failed = []
    def lost_ack(statements):
        reservations = [params for sql, params in statements
            if store.RECORDS in sql and params[1] == 'reservation']
        if reservations and not failed:
            failed.append(reservations[0][0])
            db.writer(statements)
            raise RuntimeError('fixture_committed_reservation_ack_lost')
        return db.writer(statements)
    first = daily.run_daily_nav_reviews(business_date='2026-09-09', query=db.query,
        writer=lost_ack, now=stamp('2026-09-09'))
    assert first['status'] == 'partial_daily_nav_reviews'
    before = db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', [])
    assert len(failed) == 1
    # Original9/9 review must survive9/9 allocations for the9/10 session.
    append_session(environment, monkeypatch, '2026-09-09', '2026-09-10', 106)
    final = daily.run_daily_nav_reviews(business_date='2026-09-10', query=db.query,
        writer=db.writer, now=stamp('2026-09-10'))
    assert final['status'] == 'daily_nav_reviews_current', final['failures']
    rows = {r['record_id']: r for r in db.query(f'SELECT * FROM {store.RECORDS}', [])}
    assert all(rows[r['record_id']] == r for r in before)
    assert set(final['runs'][0]['result']['reserved_alpha_by_family'].values()) == {.025}
    saved = store.read_review_record(query=db.query, record_id=failed[0])
    assert saved['body']['as_of_date'] == '2026-09-09'
    assert saved['body']['population_snapshot_ids']


def test_nightly_routes_whole_reviews_through_atomic_domain_writer(environment, monkeypatch, local_policy):
    from routers.walk_forward import _materialize_nav_with_reviews
    db, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    calls = []
    def ordinary(statements):
        assert all(store.RECORDS not in sql and store.PARTS not in sql for sql, _ in statements)
        return db.writer(statements)
    def atomic(statements):
        assert len(statements) >= 2
        assert store.RECORDS in statements[0][0]
        assert len(statements) == statements[0][1][7] + 1
        assert all(store.PARTS in sql for sql, _ in statements[1:])
        calls.append(statements)
        return db.writer(statements)
    client = SimpleNamespace(query=db.query, batch_execute=ordinary, atomic_batch_execute=atomic)
    result = _materialize_nav_with_reviews(business_date='2026-09-09',
        learning_client=client, now=stamp('2026-09-09'))
    assert result['family_reviews']['status'] == 'daily_nav_reviews_current'
    assert len(calls) == 5  # protocol + two families*(reservation + review)
    del client.atomic_batch_execute
    with pytest.raises(RuntimeError, match='review_atomic_writer_missing'):
        _materialize_nav_with_reviews(business_date='2026-09-09',
            learning_client=client, now=stamp('2026-09-09'))


def test_original_multi_part_sql_rolls_back_in_native_d1(environment, tmp_path):
    db, *_ = environment
    migrate(db)
    batches = []
    def capture(statements):
        batches.append(statements)
        return db.writer(statements)
    body = {'record_kind': 'reservation', 'protocol_id': 'atomic-storage-only',
        'family_id': 'synthetic-family', 'review_id': 'first', 'as_of_date': '2026-09-09',
        'payload': '測試😀' * 100000, 'promotion_allowed': False}
    saved = store._freeze(body=body, query=db.query, writer=capture, now=stamp('2026-09-09'))
    assert len(batches) == 1 and len(batches[0]) > 10
    root = Path(__file__).parents[2]
    migration = (root / 'worker/domain-migrations/learning/0044_paired_nav_review_records.sql').read_text(encoding='utf-8')
    statements, pending = [], ''
    for line in migration.splitlines(keepends=True):
        pending += line
        if sqlite3.complete_statement(pending):
            statements.append(pending)
            pending = ''
    assert not pending.strip()
    fixture = tmp_path / 'original-review-batch.json'
    fixture.write_text(json.dumps({'schema': statements, 'batch': batches[0],
        'record_id': saved['header']['record_id'], 'checksum': saved['header']['payload_checksum'],
        'raw': store.encode(body)}, ensure_ascii=False), encoding='utf-8')
    result = subprocess.run(['node', '--import', 'tsx', '--test', '--test-reporter=tap', 'tests/navReviewAtomicD1.ts'],
        cwd=root / 'worker', env={**os.environ, 'NAV_REVIEW_ATOMIC_FIXTURE': str(fixture)},
        capture_output=True, text=True, encoding='utf-8', timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    assert '# pass 1' in result.stdout and '# fail 0' in result.stdout
