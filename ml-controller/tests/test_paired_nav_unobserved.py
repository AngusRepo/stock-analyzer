"""An expired empty first session may restart only with visible zero-NAV proof."""
from datetime import datetime, timezone
from pathlib import Path
import sqlite3

import pytest

from services.paired_nav_journal import digest, mature_staged_pairs
from services.paired_nav_lifecycle import registered_pairs
from services.paired_nav_unobserved import certify_unobserved_first_session, unobserved_pair
from services.paired_nav_population import read_candidate_population
from services.paired_native_collector import frame_identity
from scripts import certify_unobserved_first_session as incident_cli
from test_paired_native_prestart import fixture as prestart_fixture
from test_native_paper_sandbox import native_runner


def source(runner):
    db, kwargs, packet = prestart_fixture(runner)
    migration = Path(__file__).parents[2] / (
        'worker/domain-migrations/learning/0059_paired_nav_unobserved_first_session.sql')
    db.conn.executescript(migration.read_text(encoding='utf-8'))
    return db, kwargs, packet


def test_expired_empty_pair_is_retained_but_no_longer_carried(native_runner):
    db, kwargs, packet = source(native_runner)
    snapshot_id = kwargs['snapshot_id']
    assert len(registered_pairs(signal_date='2026-09-08', query=db.query)) == 1
    args = dict(execution_snapshot_id=snapshot_id, query=db.query, writer=db.writer,
                objects=kwargs['objects'])
    with pytest.raises(ValueError, match='session_not_closed'):
        certify_unobserved_first_session(**args, now=datetime(2026, 9, 7, 0, tzinfo=timezone.utc))
    clock = datetime(2026, 9, 8, 0, tzinfo=timezone.utc)
    receipt = certify_unobserved_first_session(**args, now=clock)
    assert receipt['nav_maturity_credit'] == 0 and receipt['promotion_allowed'] is False
    assert receipt['session_date'] == packet['session_date']
    assert unobserved_pair(execution_snapshot_id=snapshot_id, query=db.query) == receipt
    assert certify_unobserved_first_session(**args, now=clock) == receipt
    assert registered_pairs(signal_date='2026-09-08', query=db.query) == []
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
    population = read_candidate_population(business_date='2026-09-07',
        query=db.query, series=(), now=clock)
    pair = next(item for item in population['pairs'] if item['pair_id'] == packet['pair_id'])
    assert pair['unobserved_session_dates'] == [packet['session_date']]
    assert pair['unaccounted_session_dates'] == []
    assert pair['lifecycle_status'] == 'unobserved_closed'
    accounting = mature_staged_pairs(business_date='2026-09-07',
        query=db.query, writer=db.writer, now=clock)
    assert accounting['recorded_pair_sessions'] == 0
    with pytest.raises(sqlite3.IntegrityError, match='paired_nav_immutable_unobserved'):
        db.conn.execute('DELETE FROM paired_nav_unobserved_pairs_v1')
    with pytest.raises(sqlite3.IntegrityError, match='paired_nav_immutable_unobserved'):
        db.conn.execute('UPDATE paired_nav_unobserved_pairs_v1 SET payload_checksum=?', ['0' * 64])
    with pytest.raises(sqlite3.IntegrityError, match='paired_nav_immutable_unobserved'):
        db.conn.execute('INSERT OR REPLACE INTO paired_nav_unobserved_pairs_v1 '
            '(execution_snapshot_id,pair_id,session_date,payload_json,payload_checksum,recorded_at) '
            'VALUES(?,?,?,?,?,?)', [snapshot_id, packet['pair_id'], packet['session_date'],
            '{}', '0' * 64, clock.isoformat()])


def test_first_frame_delivery_forbids_unobserved_certificate(native_runner):
    db, kwargs, packet = source(native_runner)
    identity = frame_identity(kwargs['snapshot_id'], packet['schedule'][0])
    key = kwargs['objects'].put({'identity': identity})
    kwargs['objects'].publish_delivery(digest(identity), key)
    with pytest.raises(ValueError, match='first_frame_exists'):
        certify_unobserved_first_session(execution_snapshot_id=kwargs['snapshot_id'],
            query=db.query, writer=db.writer, objects=kwargs['objects'],
            now=datetime(2026, 9, 8, 0, tzinfo=timezone.utc))
    assert db.query('SELECT * FROM paired_nav_unobserved_pairs_v1', []) == []


def test_incident_cli_is_read_only_by_default_and_targets_exact_checksum(native_runner, monkeypatch):
    db, kwargs, packet = source(native_runner)
    snapshot_id = kwargs['snapshot_id']
    manifest = db.query('SELECT payload_checksum FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?',
        [snapshot_id])[0]
    monkeypatch.setattr(incident_cli, 'TARGETS', {
        snapshot_id: (manifest['payload_checksum'], packet['session_date']),
    })
    report = incident_cli.run(query=db.query, writer=db.writer, objects=kwargs['objects'])
    assert report['mode'] == 'plan' and report['nav_maturity_credit'] == 0
    assert db.query('SELECT * FROM paired_nav_unobserved_pairs_v1', []) == []
    monkeypatch.setattr(incident_cli, 'TARGETS', {
        snapshot_id: ('0' * 64, packet['session_date']),
    })
    with pytest.raises(ValueError, match='expected_checksum_changed'):
        incident_cli.run(query=db.query, writer=db.writer, objects=kwargs['objects'], apply=True)
    assert db.query('SELECT * FROM paired_nav_unobserved_pairs_v1', []) == []
