import sqlite3
import pytest

from services.paired_nav_schema import validate_paired_nav_schema
from services.paired_nav_journal import freeze_snapshot
from test_paired_nav_journal import DB, NOW, packet, seal, receipt, mature


def test_current_migration_is_ready_and_read_only():
    db = DB()
    before = db.conn.total_changes
    assert validate_paired_nav_schema(db.query)['status'] == 'ready'
    assert db.conn.total_changes == before


def test_missing_table_is_explicit():
    db = DB()
    db.conn.execute('DROP TABLE paired_nav_daily_journal_v1')
    with pytest.raises(RuntimeError, match='migration_0040_missing'):
        validate_paired_nav_schema(db.query)


def test_old_0040_enum_detected_before_parts_are_written():
    db = DB()
    def old_query(sql, args):
        rows = db.query(sql, args)
        if sql.startswith('SELECT name,sql FROM sqlite_master'):
            return [{**row, 'sql': row['sql'].replace("'allocation_pair',", '')} for row in rows]
        return rows
    with pytest.raises(RuntimeError, match='kind_constraint_incompatible'):
        freeze_snapshot(signal_date='2026-09-09', source_run_id='schema-probe', snapshot_kind='allocation_pair',
                        content={}, query=old_query, writer=db.writer, now=NOW)
    assert db.query('SELECT * FROM paired_nav_frozen_parts_v1', []) == []


@pytest.mark.parametrize('operation', ['update', 'delete', 'replace'])
def test_missing_immutability_trigger_is_not_ready(operation):
    db = DB()
    db.conn.execute(f'DROP TRIGGER paired_nav_manifest_no_{operation}_v1')
    with pytest.raises(RuntimeError, match='immutability_missing'):
        validate_paired_nav_schema(db.query)


@pytest.mark.parametrize('recursive', [0, 1])
def test_sql_delete_and_replace_cannot_reset_or_rewrite_evidence(recursive):
    db = DB()
    db.conn.execute(f'PRAGMA recursive_triggers={recursive}')
    p = packet()
    frozen = seal(db, p)
    mature(db, frozen, receipt(p, frozen))
    cases = [
        ('paired_nav_frozen_parts_v1', 'payload_text', 'different'),
        ('paired_nav_frozen_manifests_v1', 'prospective', 0),
        ('paired_nav_daily_journal_v1', 'payload_checksum', 'different'),
    ]
    for table, field, value in cases:
        row = db.query(f'SELECT * FROM {table} LIMIT 1', [])[0]
        with pytest.raises(sqlite3.IntegrityError, match='paired_nav_immutable'):
            db.conn.execute(f'DELETE FROM {table}')
        changed = {**row, field: value}
        columns, binds = ','.join(changed), ','.join('?' for _ in changed)
        with pytest.raises(sqlite3.IntegrityError, match='paired_nav_immutable'):
            db.conn.execute(f'INSERT OR REPLACE INTO {table} ({columns}) VALUES ({binds})', list(changed.values()))
        # Exact replay cannot update a first-write time or spend a second look.
        retry = {**row}
        for stamp in ('frozen_at', 'recorded_at'):
            if stamp in retry:
                retry[stamp] = '2099-01-01T00:00:00Z'
        db.conn.execute(f'INSERT OR REPLACE INTO {table} ({columns}) VALUES ({binds})', list(retry.values()))
        assert db.query(f'SELECT * FROM {table} LIMIT 1', [])[0] == row
    assert validate_paired_nav_schema(db.query)['status'] == 'ready'
