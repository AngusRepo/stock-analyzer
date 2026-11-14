import json
from pathlib import Path
import subprocess

import pytest

from tools.d1 import migrations as tool
from tools.d1.migrations import OVERRIDES, DATABASES, WORKER, classify, parse


def write(tmp_path, name, sql):
    path = tmp_path / name
    path.write_text(sql, encoding='utf-8')
    return parse(path)


def test_parse_tracks_final_object_state_and_ignores_comments(tmp_path):
    m = write(tmp_path, '0001_a.sql', '''
        -- CREATE TABLE ghost (x)
        CREATE TABLE IF NOT EXISTS "Alpha" (id INTEGER);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_alpha ON alpha(id);
        ALTER TABLE alpha ADD COLUMN score REAL;
        CREATE TABLE tmp (x); DROP TABLE tmp;
        ALTER TABLE beta RENAME TO gamma;
        /* DROP INDEX idx_alpha */
    ''')
    assert sorted(m.effects) == sorted([
        ('table', 'alpha', True), ('index', 'idx_alpha', True), ('column', 'alpha.score', True),
        ('table', 'tmp', False), ('table', 'beta', False), ('table', 'gamma', True),
    ])


def test_classify_uses_live_schema_for_unrecorded_files(tmp_path):
    items = [
        write(tmp_path, '0001_rec.sql', 'CREATE TABLE a (id);'),
        write(tmp_path, '0002_done.sql', 'CREATE TABLE b (id); ALTER TABLE b ADD COLUMN v;'),
        write(tmp_path, '0003_half.sql', 'CREATE TABLE c (id); CREATE INDEX idx_c ON c(id);'),
        write(tmp_path, '0004_new.sql', 'CREATE TABLE d (id);'),
        write(tmp_path, '0005_data.sql', "UPDATE b SET v = 1;"),
        write(tmp_path, '0006_old.sql', 'CREATE TABLE e (id);'),
        write(tmp_path, '0007_drop.sql', 'DROP TABLE e;'),
    ]
    objects = {('table', 'a'): 'CREATE TABLE a (id)', ('table', 'b'): 'CREATE TABLE b (id, v)', ('table', 'c'): 'CREATE TABLE c (id)'}
    rows = {r['name']: r for r in classify(items, {'0001_rec.sql'}, objects, {'0005_data.sql': True})}
    assert rows['0001_rec.sql']['status'] == 'recorded'
    assert rows['0002_done.sql']['status'] == 'applied_unrecorded'
    assert rows['0003_half.sql'] == {'name': '0003_half.sql', 'status': 'partial', 'checked': 2, 'missing': ['index:idx_c']}
    assert rows['0004_new.sql']['status'] == 'pending'
    assert rows['0005_data.sql']['status'] == 'applied_unrecorded'
    # A later DROP owns table e, so 0006 has nothing left to check; 0007 sees e absent.
    assert rows['0006_old.sql']['status'] == 'unverifiable'
    assert rows['0007_drop.sql']['status'] == 'applied_unrecorded'
    failed = classify([items[4]], set(), objects, {'0005_data.sql': 'wrangler_failed:no such table'})[0]
    assert failed['status'] == 'unverifiable' and 'no such table' in failed['error']


def test_overrides_name_existing_files_of_known_databases():
    data = json.loads(OVERRIDES.read_text(encoding='utf-8'))
    for section in ('probes', 'not_applicable'):
        for db, files in data[section].items():
            assert db in DATABASES
            for name in files:
                assert (WORKER / DATABASES[db][1] / name).is_file(), (db, name)


# X-14-1: `d1 execute --file --remote --json` prints wrangler's upload/poll spinner lines on stdout
# ahead of the JSON summary (wrangler 4.100 spinnerWhile ignores the --json log level).
FILE_STDOUT = '''│ Checking if file needs uploading
│ \U0001F300 Uploading 3f2a.sql
│ \U0001F300 Uploading complete.

[
  {
    "results": [{"Total queries executed": 2, "Rows read": 0, "Rows written": 2, "Database size (MB)": "1.00"}],
    "success": true,
    "finalBookmark": "00000001-00000002",
    "meta": {"duration": 1.5}
  }
]
'''


class FakeD1:
    """Stands in for `npx wrangler d1 execute --remote --json`; --file applies the parsed effects."""

    def __init__(self, items, recorded, objects, file_returncode=0, file_creates=True, fail_insert=False):
        self.items = {m.path.name: m for m in items}
        self.recorded, self.objects = set(recorded), dict(objects)
        self.file_returncode, self.file_creates, self.fail_insert = file_returncode, file_creates, fail_insert
        self.calls = []

    def done(self, argv, rows):
        return subprocess.CompletedProcess(argv, 0, json.dumps([{'results': rows, 'success': True, 'meta': {}}]), '')

    def run(self, argv, **kwargs):
        assert argv[1:6] == ['wrangler@4', 'd1', 'execute', 'stockvision-learning-db', '--remote'] and '--json' in argv
        mode, value = argv[-2], argv[-1]
        self.calls.append((mode, value))
        if mode == '--file':
            if self.file_returncode:
                return subprocess.CompletedProcess(argv, self.file_returncode, '', 'D1 import failed')
            for kind, obj, present in self.items[Path(value).name].effects if self.file_creates else []:
                if kind == 'column':
                    table, column = obj.split('.')
                    self.objects[('table', table)] = self.objects[('table', table)][:-1] + f', {column})'
                elif present:
                    self.objects[(kind, obj)] = f'CREATE {kind.upper()} {obj} (id)'
                else:
                    self.objects.pop((kind, obj), None)
            return subprocess.CompletedProcess(argv, 0, FILE_STDOUT, '')
        assert mode == '--command'
        if value.startswith('INSERT OR IGNORE INTO d1_migrations'):
            if self.fail_insert:
                return subprocess.CompletedProcess(argv, 1, '', '7500: database is locked')
            self.recorded.add(value.split("'")[1])
            return self.done(argv, [])
        if value.startswith('SELECT COUNT(*) AS n FROM d1_migrations WHERE name'):
            return self.done(argv, [{'n': int(value.split("'")[1] in self.recorded)}])
        if value.startswith('SELECT COUNT(*) AS n FROM sqlite_master'):
            return self.done(argv, [{'n': 1}])
        if value == 'SELECT name FROM d1_migrations':
            return self.done(argv, [{'name': n} for n in sorted(self.recorded)])
        assert value.startswith('SELECT type, name, sql FROM sqlite_master'), value
        return self.done(argv, [{'type': k, 'name': n, 'sql': sql} for (k, n), sql in self.objects.items()])


@pytest.fixture
def d1_factory(monkeypatch, tmp_path):
    items = [
        write(tmp_path, '0001_base.sql', 'CREATE TABLE a (id);'),
        write(tmp_path, '0002_new.sql', 'CREATE TABLE b (id); CREATE INDEX idx_b ON b(id); ALTER TABLE a ADD COLUMN v;'),
    ]
    monkeypatch.setattr(tool, 'migrations', lambda db: items)
    monkeypatch.setattr(tool, 'overrides', lambda section, db: {})
    monkeypatch.setattr(tool.shutil, 'which', lambda name: '/usr/bin/npx')

    def make(**kwargs):
        d1 = FakeD1(items, {'0001_base.sql'}, {('table', 'a'): 'CREATE TABLE a (id)'}, **kwargs)
        monkeypatch.setattr(tool.subprocess, 'run', d1.run)
        return d1
    return make


def test_query_parses_command_json(d1_factory):
    d1 = d1_factory()
    assert tool.query('learning', 'SELECT name FROM d1_migrations') == [{'name': '0001_base.sql'}]
    assert d1.calls == [('--command', 'SELECT name FROM d1_migrations')]


def test_apply_accepts_non_json_file_output_then_verifies_and_records(d1_factory, capsys):
    d1 = d1_factory()
    tool.apply('learning', execute=True)
    assert d1.recorded == {'0001_base.sql', '0002_new.sql'}
    file_at = [mode for mode, _ in d1.calls].index('--file')
    assert d1.calls[file_at][1].endswith('0002_new.sql')
    # Re-verify follows the import, then the INSERT, then the read that confirms the row.
    after = [value for _, value in d1.calls[file_at + 1:]]
    assert any(v.startswith('SELECT type, name, sql FROM sqlite_master') for v in after[:-2])
    assert after[-2] == "INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_new.sql')"
    assert after[-1].startswith('SELECT COUNT(*) AS n FROM d1_migrations WHERE name')
    assert 'apply learning 0002_new.sql' in capsys.readouterr().out
    assert [r['status'] for r in tool.status('learning')] == ['recorded', 'recorded']


def test_apply_dry_run_executes_nothing(d1_factory):
    d1 = d1_factory()
    tool.apply('learning', execute=False)
    assert all(mode == '--command' and not v.startswith('INSERT') for mode, v in d1.calls)
    assert d1.recorded == {'0001_base.sql'}


def test_apply_import_failure_is_not_recorded(d1_factory):
    d1 = d1_factory(file_returncode=1)
    with pytest.raises(SystemExit, match=r'^apply_failed:learning:0002_new.sql:wrangler_failed:learning:D1 import failed'):
        tool.apply('learning', execute=True)
    assert d1.recorded == {'0001_base.sql'}


def test_apply_reports_executed_file_whose_schema_does_not_verify(d1_factory):
    d1 = d1_factory(file_creates=False)
    with pytest.raises(SystemExit) as raised:
        tool.apply('learning', execute=True)
    message = str(raised.value)
    assert message.startswith('apply_executed_not_recorded:learning:0002_new.sql:')
    assert 'apply_verification_failed' in message and 'record --db learning --execute' in message
    assert d1.recorded == {'0001_base.sql'}


def test_apply_reports_executed_file_when_record_fails(d1_factory):
    d1 = d1_factory(fail_insert=True)
    with pytest.raises(SystemExit) as raised:
        tool.apply('learning', execute=True)
    message = str(raised.value)
    assert message.startswith('apply_executed_not_recorded:learning:0002_new.sql:')
    assert 'record_error' in message and 'database is locked' in message
    # The schema is live, so the documented follow-up (status, then record) picks the file up.
    assert {r['name']: r['status'] for r in tool.status('learning')}['0002_new.sql'] == 'applied_unrecorded'
    d1.fail_insert = False
    tool.record('learning', ['0002_new.sql'], execute=True)
    assert d1.recorded == {'0001_base.sql', '0002_new.sql'}


def test_apply_timeout_reports_unknown_outcome(d1_factory, monkeypatch):
    d1 = d1_factory()

    def slow(argv, **kwargs):
        if '--file' in argv:
            raise subprocess.TimeoutExpired(argv, kwargs['timeout'])
        return d1.run(argv, **kwargs)

    monkeypatch.setattr(tool.subprocess, 'run', slow)
    with pytest.raises(SystemExit, match=r'^apply_outcome_unknown:learning:0002_new.sql:wrangler timed out after 600s'):
        tool.apply('learning', execute=True)
    assert d1.recorded == {'0001_base.sql'}
