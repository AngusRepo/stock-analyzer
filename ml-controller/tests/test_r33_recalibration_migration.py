"""learning 0072: a cohort may hold a second R33 object (same-cohort recalibration's r33-row step)."""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
for entry in (str(ROOT / 'tools'), str(ROOT / 'tools' / 'release')):
    if entry not in sys.path:
        sys.path.insert(0, entry)

import r33_cutover_switch as tool  # noqa: E402

MIGRATIONS = ROOT / 'worker/domain-migrations/learning'
COLUMNS = ('artifact_id', 'cohort_id', 'training_run_id', 'knowledge_cutoff_date', 'schema_version', 'payload_json',
           'payload_checksum', 'base_artifact_set_checksum', 'validation_decision', 'validation_json', 'archive_uri')


def _row(artifact_id, cohort_id, checksum):
    return {'artifact_id': artifact_id, 'cohort_id': cohort_id, 'training_run_id': 'run', 'knowledge_cutoff_date': '2026-10-29',
            'schema_version': 'active8-oof-ensemble-serving-artifact-v1', 'payload_json': '{"k": 1}',
            'payload_checksum': checksum, 'base_artifact_set_checksum': 'b' * 64, 'validation_decision': 'PASS',
            'validation_json': '{}', 'archive_uri': 'gs://x/bundle.json'}


def _insert(conn, row):
    """The r33-row step's statement (tools/r33_cutover_switch.py _execute)."""
    columns = list(row)
    conn.execute(f"INSERT INTO active8_ensemble_artifacts_v1 ({','.join(columns)},state,production_effect) "
                 f"VALUES ({','.join('?' for _ in columns)},'candidate',0) ON CONFLICT(artifact_id) DO NOTHING",
                 [row[c] for c in columns])


class _Learning:
    def __init__(self, conn):
        self.conn = conn

    def query(self, sql, params):
        cursor = self.conn.execute(sql, params)
        names = [d[0] for d in cursor.description]
        return [dict(zip(names, values)) for values in cursor.fetchall()]


@pytest.fixture
def live():
    """The live learning schema (0027) with the production R33 row, one other cohort and the pointer."""
    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('CREATE TABLE data_domain_control_revisions (table_name TEXT PRIMARY KEY, revision INTEGER NOT NULL '
                 'DEFAULT 0, updated_at TEXT)')
    conn.executescript((MIGRATIONS / '0027_active8_ensemble_serving_owner.sql').read_text())
    _insert(conn, _row('r33-roster:c1:6814', 'c1', '6' * 64))
    _insert(conn, _row('active8-ensemble:c0:642b', 'c0', '4' * 64))
    conn.execute("UPDATE active8_ensemble_artifacts_v1 SET state='production', production_effect=1 WHERE cohort_id='c1'")
    conn.execute("INSERT INTO active8_ensemble_pointer_v1 (singleton_id, artifact_id, cohort_id, payload_checksum, "
                 "base_artifact_set_checksum, promotion_reason) VALUES (1, 'r33-roster:c1:6814', 'c1', ?, ?, 'r33_cutover')",
                 ['6' * 64, 'b' * 64])
    conn.commit()
    return conn


def _snapshot(conn):
    return (conn.execute('SELECT * FROM active8_ensemble_artifacts_v1 ORDER BY artifact_id').fetchall(),
            conn.execute('SELECT * FROM active8_ensemble_pointer_v1').fetchall())


def test_before_0072_the_same_cohort_row_is_refused_and_prepare_stops_first(live, monkeypatch):
    with pytest.raises(sqlite3.IntegrityError, match='cohort_id'):
        _insert(live, _row('r33-roster:c1:254e', 'c1', '2' * 64))
    monkeypatch.setattr(tool, '_learning', lambda: _Learning(live))
    with pytest.raises(RuntimeError, match='recalibration_needs_learning_migration_0072'):
        tool._require_same_cohort_rows()


def test_0072_keeps_every_row_the_pointer_and_its_guards_and_admits_a_second_object(live, monkeypatch):
    before = _snapshot(live)
    live.executescript((MIGRATIONS / '0072_active8_ensemble_same_cohort_recalibration.sql').read_text())
    live.execute('PRAGMA foreign_keys=ON')
    assert _snapshot(live) == before
    assert live.execute('PRAGMA foreign_key_check').fetchall() == []
    names = {r[0] for r in live.execute("SELECT name FROM sqlite_master WHERE name LIKE '%active8_ensemble%'")}
    assert not any('legacy' in n for n in names)
    assert {'trg_active8_ensemble_artifacts_revision_insert', 'trg_active8_ensemble_artifacts_revision_update',
            'trg_active8_ensemble_pointer_revision', 'trg_active8_ensemble_pointer_revision_update',
            'trg_active8_ensemble_pointer_revision_delete', 'idx_active8_ensemble_artifacts_state',
            'idx_active8_ensemble_artifacts_run', 'idx_active8_ensemble_artifacts_cohort'} <= names
    pointer_sql = live.execute("SELECT sql FROM sqlite_master WHERE name='active8_ensemble_pointer_v1'").fetchone()[0]
    assert 'REFERENCES active8_ensemble_artifacts_v1(artifact_id) ON DELETE RESTRICT' in pointer_sql
    monkeypatch.setattr(tool, '_learning', lambda: _Learning(live))
    tool._require_same_cohort_rows()
    # The probe sees a half-done rebuild (a missing trigger) as not applied.
    live.execute('DROP TRIGGER trg_active8_ensemble_pointer_revision_delete')
    with pytest.raises(RuntimeError, match='recalibration_needs_learning_migration_0072'):
        tool._require_same_cohort_rows()
    _insert(live, _row('r33-roster:c1:254e', 'c1', '2' * 64))
    assert live.execute("SELECT COUNT(*) FROM active8_ensemble_artifacts_v1 WHERE cohort_id='c1'").fetchone()[0] == 2
    # Still guarded: one row per object checksum, and the pointed-at object cannot be deleted.
    with pytest.raises(sqlite3.IntegrityError, match='payload_checksum'):
        _insert(live, _row('r33-roster:c1:other', 'c1', '2' * 64))
    with pytest.raises(sqlite3.IntegrityError, match='FOREIGN KEY'):
        live.execute("DELETE FROM active8_ensemble_artifacts_v1 WHERE artifact_id='r33-roster:c1:6814'")
    with pytest.raises(sqlite3.IntegrityError, match='FOREIGN KEY'):
        live.execute("UPDATE active8_ensemble_pointer_v1 SET artifact_id='missing' WHERE singleton_id=1")


def test_the_learning_schema_snapshot_matches_0072():
    schema = (ROOT / 'worker/domain-schemas/learning.sql').read_text()
    table = schema[schema.index('CREATE TABLE IF NOT EXISTS active8_ensemble_artifacts_v1'):]
    table = table[:table.index(');')]
    assert 'cohort_id TEXT NOT NULL CHECK' in table and 'payload_checksum TEXT NOT NULL UNIQUE' in table
    assert 'idx_active8_ensemble_artifacts_cohort' in schema
