import json

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
