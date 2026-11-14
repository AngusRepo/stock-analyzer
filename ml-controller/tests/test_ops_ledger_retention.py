"""D7g: ops ledger retention keeps release receipts and only removes old no-op ledger rows."""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ml-controller'))

from scripts import ops_ledger_retention as olr  # noqa: E402

OPS_SQL = (ROOT / 'worker' / 'domain-schemas' / 'ops.sql').read_text(encoding='utf-8')
OLD, NEW = '2024-01-02 00:00:00', '2026-10-20 00:00:00'


def _ddl(name: str) -> str:
    match = re.search(rf'CREATE TABLE IF NOT EXISTS {name} \([\s\S]*?\n\);', OPS_SQL)
    assert match, name
    return match.group(0)


@pytest.fixture()
def db():
    con = sqlite3.connect(':memory:')
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys=ON')
    for table in ('data_retention_policies', 'data_retention_runs', 'data_retention_run_items', 'run_artifacts',
                  'artifact_hard_references', 'artifact_deletion_claims_v1'):
        con.execute(_ddl(table))
    con.execute('PRAGMA foreign_keys=OFF')  # policy rows are irrelevant to ledger retention
    runs = [  # run_id, created, status, deleted
        ('noop-old', OLD, 'success', 0), ('error-old', OLD, 'error', 0), ('release-old', OLD, 'success', 7),
        ('mixed-old', OLD, 'success', 0), ('running-old', OLD, 'running', 0), ('noop-new', NEW, 'skipped', 0),
        ('empty-old', OLD, 'skipped', 0)]
    for run_id, created, status, deleted in runs:
        con.execute('INSERT INTO data_retention_runs(run_id,policy_id,business_date,status,deleted_rows,created_at,completed_at) '
                    'VALUES(?,?,?,?,?,?,?)', (run_id, 'p', created[:10], status, deleted, created, created))
    receipt = json.dumps({'artifact_id': 'a1', 'checksum': 'c'})
    items = [  # run_id, dataset, deleted, archived, evidence, completed
        ('noop-old', 'predictions', 0, 0, '{}', OLD), ('error-old', 'predictions', 0, 0, 'not json', OLD),
        ('release-old', 'predictions', 7, 7, receipt, OLD), ('mixed-old', 'a', 0, 0, '{}', OLD),
        ('mixed-old', 'b', 0, 0, receipt, OLD),  # archive-only receipt names an artifact
        ('running-old', 'predictions', 0, 0, '{}', OLD), ('noop-new', 'predictions', 0, 0, '{}', NEW)]
    for run_id, dataset, deleted, archived, evidence, completed in items:
        con.execute("INSERT INTO data_retention_run_items(run_id,dataset_id,status,deleted_rows,archived_rows,evidence_json,completed_at) "
                    "VALUES(?,?,'success',?,?,?,?)", (run_id, dataset, deleted, archived, evidence, completed))
    con.execute('PRAGMA foreign_keys=ON')
    yield con
    con.close()


def _query(con):
    return lambda sql, params: [dict(r) for r in con.execute(sql, params).fetchall()]


def _execute(con):
    def run(sql, params):
        cur = con.execute(sql, params)
        return {'success': True, 'meta': {'changes': cur.rowcount}}
    return run


def _remaining(con):
    return (sorted(r[0] for r in con.execute('SELECT run_id FROM data_retention_runs')),
            sorted(f'{r[0]}/{r[1]}' for r in con.execute('SELECT run_id,dataset_id FROM data_retention_run_items')))


def test_cutoff_uses_retention_days_and_rejects_short_windows():
    now = datetime(2026, 10, 29, tzinfo=timezone.utc)
    assert olr.cutoff_for(now, 400) == '2025-09-24 00:00:00'
    with pytest.raises(ValueError):
        olr.cutoff_for(now, 30)


def test_plan_is_read_only_and_counts_noop_rows(db):
    before = _remaining(db)
    report = olr.plan(_query(db), '2025-09-24 00:00:00')
    assert report['eligible'] == {'data_retention_run_items': 4, 'data_retention_runs': 3}
    assert report['total'] == {'data_retention_run_items': 7, 'data_retention_runs': 7}
    assert set(report['report_only_older_than_cutoff']) == {'run_artifacts', 'artifact_hard_references',
                                                            'artifact_deletion_claims_v1'}
    assert _remaining(db) == before


def test_execute_keeps_release_receipts_running_and_recent_rows(db):
    result = olr.execute(_execute(db), '2025-09-24 00:00:00', batch_size=1)
    # running-old/predictions is a no-op item and goes; the running run itself stays.
    assert result['deleted'] == {'data_retention_run_items': 4, 'data_retention_runs': 3}
    runs, items = _remaining(db)
    assert runs == ['mixed-old', 'noop-new', 'release-old', 'running-old']
    assert items == ['mixed-old/b', 'noop-new/predictions', 'release-old/predictions']
    assert olr.plan(_query(db), '2025-09-24 00:00:00')['eligible'] == {
        'data_retention_run_items': 0, 'data_retention_runs': 0}


def test_execute_requires_confirm_phrase(capsys):
    with pytest.raises(SystemExit):
        olr.main(['--execute'])
    assert olr.CONFIRM_PHRASE in capsys.readouterr().err
