import sqlite3

import pytest

from tools.d1 import legacy_control_plane_copy as tool


SCHEMA = {
    'data_domain_cutovers': 'CREATE TABLE data_domain_cutovers (domain TEXT PRIMARY KEY, state TEXT, note TEXT)',
    'data_domain_backfill_cursors': (
        'CREATE TABLE data_domain_backfill_cursors (domain TEXT, table_name TEXT, cursor TEXT, '
        'PRIMARY KEY(domain, table_name))'
    ),
}


@pytest.fixture
def dbs(monkeypatch):
    conns = {name: sqlite3.connect(':memory:') for name in ('legacy', 'ops')}
    for conn in conns.values():
        conn.row_factory = sqlite3.Row
        for sql in SCHEMA.values():
            conn.execute(sql)
    executed = []

    def query(db, sql):
        return [dict(row) for row in conns[db].execute(sql).fetchall()]

    def execute_file(db, path):
        executed.append((db, path))
        conns[db].executescript(path.read_text(encoding='utf-8'))

    monkeypatch.setattr(tool, 'CONTROL_PLANE_TABLES', tuple(SCHEMA))
    monkeypatch.setattr(tool.d1, 'query', query)
    monkeypatch.setattr(tool.d1, 'execute_file', execute_file)
    return conns, executed


def seed(conns):
    legacy, ops = conns['legacy'], conns['ops']
    legacy.executemany('INSERT INTO data_domain_cutovers VALUES (?,?,?)',
                       [('learning', 'active', "it's"), ('ops', 'active', None)])
    legacy.execute("INSERT INTO data_domain_backfill_cursors VALUES ('learning','predictions','42')")
    # Stale Ops mirror: an outdated row and a row that no longer exists in the source.
    ops.execute("INSERT INTO data_domain_cutovers VALUES ('learning','shadow',NULL)")
    ops.execute("INSERT INTO data_domain_backfill_cursors VALUES ('paper','paper_orders','9')")


def test_plan_is_read_only_and_reports_counts(dbs):
    conns, executed = dbs
    seed(conns)
    result = tool.plan('legacy', 'ops')
    assert result['blocked'] == []
    cutovers = next(t for t in result['tables'] if t['table'] == 'data_domain_cutovers')
    assert cutovers == {'table': 'data_domain_cutovers', 'schema_equal': True, 'missing_in_target': [],
                        'source_rows': 2, 'target_rows': 1}
    assert executed == []


def test_plan_blocks_schema_drift(dbs):
    conns, _ = dbs
    conns['ops'].execute('ALTER TABLE data_domain_cutovers ADD COLUMN extra TEXT')
    assert tool.plan('legacy', 'ops')['blocked'] == ['data_domain_cutovers']


def test_export_apply_verify_round_trip_replaces_stale_mirror(dbs, tmp_path):
    conns, executed = dbs
    seed(conns)
    assert tool.verify('legacy', 'ops')['parity'] is False
    manifest = tool.export('legacy', 'ops', tmp_path)
    assert manifest['tables']['data_domain_cutovers']['rows'] == 2
    assert (manifest['kind'], manifest['direction'], manifest['target']) == ('copy', 'legacy-to-ops', 'ops')
    assert tool.apply(tmp_path / 'copy.sql', execute=True, confirm=tool.CONFIRM_PHRASE) == 'ops'
    assert executed == [('ops', tmp_path / 'copy.sql')]
    result = tool.verify('legacy', 'ops')
    assert result['parity'] is True
    rows = conns['ops'].execute('SELECT domain, table_name FROM data_domain_backfill_cursors').fetchall()
    assert [tuple(r) for r in rows] == [('learning', 'predictions')]
    assert conns['ops'].execute("SELECT note FROM data_domain_cutovers WHERE domain='learning'").fetchone()[0] == "it's"


def test_apply_target_comes_from_the_manifest_and_a_mismatched_direction_is_refused(dbs, tmp_path):
    conns, executed = dbs
    seed(conns)
    tool.export('legacy', 'ops', tmp_path)
    with pytest.raises(SystemExit, match='apply_refused_direction_mismatch:flag=ops-to-legacy:manifest=legacy-to-ops'):
        tool.apply(tmp_path / 'copy.sql', execute=True, confirm=tool.CONFIRM_PHRASE, direction='ops-to-legacy')
    assert tool.apply(tmp_path / 'copy.sql', execute=False, confirm=None, direction='legacy-to-ops') == 'ops'
    assert executed == []


def test_apply_refuses_when_the_source_moved_or_the_sql_was_edited(dbs, tmp_path):
    conns, executed = dbs
    seed(conns)
    tool.export('legacy', 'ops', tmp_path)
    conns['legacy'].execute("UPDATE data_domain_cutovers SET state='complete' WHERE domain='ops'")
    with pytest.raises(SystemExit, match='apply_refused_source_changed_since_export:data_domain_cutovers'):
        tool.apply(tmp_path / 'copy.sql', execute=True, confirm=tool.CONFIRM_PHRASE)
    tool.export('legacy', 'ops', tmp_path)
    with open(tmp_path / 'copy.sql', 'a', encoding='utf-8') as handle:
        handle.write('DELETE FROM data_domain_cutovers;\n')
    with pytest.raises(SystemExit, match='apply_refused_sql_changed_since_export'):
        tool.apply(tmp_path / 'copy.sql', execute=True, confirm=tool.CONFIRM_PHRASE)
    (tmp_path / 'manifest.json').unlink()
    with pytest.raises(SystemExit, match='apply_snapshot_missing'):
        tool.apply(tmp_path / 'copy.sql', execute=True, confirm=tool.CONFIRM_PHRASE)
    assert executed == []


def test_ops_backup_restores_the_pre_copy_ops_state(dbs, tmp_path):
    conns, _ = dbs
    seed(conns)
    backup = tool.backup('ops', tmp_path / 'ops-backup')
    assert (backup['kind'], backup['source'], backup['target'], backup['direction']) == ('backup', 'ops', 'ops', None)
    tool.export('legacy', 'ops', tmp_path / 'copy')
    tool.apply(tmp_path / 'copy' / 'copy.sql', execute=True, confirm=tool.CONFIRM_PHRASE)
    # A backup has no direction: passing one is a mismatch, it cannot be aimed at legacy.
    with pytest.raises(SystemExit, match='apply_refused_direction_mismatch'):
        tool.apply(tmp_path / 'ops-backup' / 'copy.sql', execute=True, confirm=tool.CONFIRM_PHRASE, direction='ops-to-legacy')
    assert tool.apply(tmp_path / 'ops-backup' / 'copy.sql', execute=True, confirm=tool.CONFIRM_PHRASE) == 'ops'
    rows = conns['ops'].execute('SELECT domain, state FROM data_domain_cutovers').fetchall()
    assert [tuple(r) for r in rows] == [('learning', 'shadow')]


def test_apply_needs_execute_and_confirm(dbs, tmp_path):
    conns, executed = dbs
    seed(conns)
    tool.export('legacy', 'ops', tmp_path)
    tool.apply(tmp_path / 'copy.sql', execute=False, confirm=None)
    with pytest.raises(SystemExit, match='apply_refused'):
        tool.apply(tmp_path / 'copy.sql', execute=True, confirm='yes')
    assert executed == []


def test_rollback_direction_swaps_source_and_target():
    assert tool.DIRECTIONS['ops-to-legacy'] == ('ops', 'legacy')
    assert tool.DIRECTIONS['legacy-to-ops'] == ('legacy', 'ops')
