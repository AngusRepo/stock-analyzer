"""D1 migration status and applier for the domain databases (Phase E-6).

`wrangler d1 migrations apply` trusts the d1_migrations table alone. Several learning-db files were
applied out of band without a row (0048-0055, 0060), so apply would rerun them, including ALTERs.
This tool checks every unrecorded file against the live schema instead:

  status  (read-only)  recorded | applied_unrecorded | partial | pending | unverifiable | not_applicable,
                       per file; overrides.json holds probes for data-only files and files whose
                       objects moved to another domain database
  record  backfill d1_migrations rows for applied_unrecorded files
  apply   run pending files in order with `d1 execute --file`, re-verify its objects, record each

record/apply print the plan and stop unless --execute is given. apply refuses while any earlier
unrecorded file is partial or unverifiable. Run from anywhere; wrangler runs in worker/.

  python tools/d1/migrations.py status [--db learning]
  python tools/d1/migrations.py apply --db learning [--execute]
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass, field
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
OVERRIDES = Path(__file__).with_name('overrides.json')
WORKER = ROOT / 'worker'
DATABASES = {
    'legacy': ('stockvision-db', 'migrations'),
    'market': ('stockvision-market-db', 'domain-migrations/market'),
    'learning': ('stockvision-learning-db', 'domain-migrations/learning'),
    'ops': ('stockvision-ops-db', 'domain-migrations/ops'),
    'core': ('stockvision-core-db', 'domain-migrations/core'),
    'execution': ('stockvision-execution-db', 'domain-migrations/execution'),
    'paper': ('stockvision-paper-db', 'domain-migrations/paper'),
    'research': ('stockvision-research-db', 'domain-migrations/research'),
}
NAME = r'["`\[]?(\w+)["`\]]?'
CREATE = re.compile(r'\bCREATE\s+(?:UNIQUE\s+|TEMP\s+|TEMPORARY\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?' + NAME, re.I)
DROP = re.compile(r'\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+EXISTS\s+)?' + NAME, re.I)
ADD_COLUMN = re.compile(r'\bALTER\s+TABLE\s+' + NAME + r'\s+ADD\s+(?:COLUMN\s+)?' + NAME, re.I)
RENAME_TABLE = re.compile(r'\bALTER\s+TABLE\s+' + NAME + r'\s+RENAME\s+TO\s+' + NAME, re.I)
RENAME_COLUMN = re.compile(r'\bALTER\s+TABLE\s+' + NAME + r'\s+RENAME\s+(?:COLUMN\s+)?' + NAME + r'\s+TO\s+' + NAME, re.I)


@dataclass
class Migration:
    name: str
    path: Path
    # (kind, object, present): kind is table/index/trigger/view, or 'column' with object 'table.column'.
    effects: list[tuple[str, str, bool]] = field(default_factory=list)


def strip_comments(sql: str) -> str:
    sql = re.sub(r'/\*.*?\*/', ' ', sql, flags=re.S)
    return re.sub(r'--[^\n]*', ' ', sql)


def parse(path: Path) -> Migration:
    sql = strip_comments(path.read_text(encoding='utf-8'))
    events = []
    for m in CREATE.finditer(sql):
        events.append((m.start(), m.group(1).lower(), m.group(2).lower(), True))
    for m in DROP.finditer(sql):
        events.append((m.start(), m.group(1).lower(), m.group(2).lower(), False))
    for m in ADD_COLUMN.finditer(sql):
        events.append((m.start(), 'column', f'{m.group(1).lower()}.{m.group(2).lower()}', True))
    for m in RENAME_COLUMN.finditer(sql):
        table = m.group(1).lower()
        events += [(m.start(), 'column', f'{table}.{m.group(2).lower()}', False),
                   (m.start() + 1, 'column', f'{table}.{m.group(3).lower()}', True)]
    for m in RENAME_TABLE.finditer(sql):
        events += [(m.start(), 'table', m.group(1).lower(), False), (m.start() + 1, 'table', m.group(2).lower(), True)]
    final: dict[tuple[str, str], bool] = {}
    for _, kind, obj, present in sorted(events):
        final[(kind, obj)] = present
    return Migration(path.name, path, [(k, o, p) for (k, o), p in final.items()])


def migrations(db: str) -> list[Migration]:
    return [parse(p) for p in sorted((WORKER / DATABASES[db][1]).glob('*.sql'))]


def wrangler(db: str, *args: str) -> str:
    npx = shutil.which('npx')
    if not npx:
        raise RuntimeError('npx_not_found')
    # --json also keeps wrangler from prompting before a --file import.
    out = subprocess.run([npx, 'wrangler@4', 'd1', 'execute', DATABASES[db][0], '--remote', '--json', *args],
                         cwd=WORKER, capture_output=True, text=True, encoding='utf-8', timeout=600)
    if out.returncode:
        raise RuntimeError(f'wrangler_failed:{db}:{out.stderr.strip()[-600:]}')
    return out.stdout


def query(db: str, sql: str) -> list[dict]:
    return json.loads(wrangler(db, '--command', sql))[0]['results']


def execute_file(db: str, path: Path) -> None:
    # A --file import writes its upload/poll spinner lines to stdout even under --json, so stdout is
    # not JSON. Exit 0 means the import completed (wrangler throws otherwise); apply re-verifies the
    # live schema itself instead of trusting the summary.
    wrangler(db, '--file', str(path))


def live_schema(db: str) -> tuple[set[str], dict[tuple[str, str], str]]:
    has_table = query(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='d1_migrations'")[0]['n']
    recorded = {r['name'] for r in query(db, 'SELECT name FROM d1_migrations')} if has_table else set()
    objects = {(r['type'], r['name'].lower()): r['sql'] or ''
               for r in query(db, "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")}
    return recorded, objects


def has_column(objects: dict, table: str, column: str) -> bool:
    sql = objects.get(('table', table))
    return sql is not None and re.search(r'[\s(,"`\[]' + re.escape(column) + r'[\s"`\],)]', sql, re.I) is not None


def classify(items: list[Migration], recorded: set[str], objects: dict, probed: dict[str, bool] | None = None) -> list[dict]:
    rows = []
    for i, m in enumerate(items):
        if m.name in recorded:
            rows.append({'name': m.name, 'status': 'recorded'})
            continue
        if probed and m.name in probed:
            value = probed[m.name]
            rows.append({'name': m.name, 'checked': 'probe',
                         **({'status': 'unverifiable', 'error': value} if isinstance(value, str)
                            else {'status': 'applied_unrecorded' if value else 'pending'})})
            continue
        # Expect only what no later file changes again: a later DROP or rename owns that object.
        later = {(k, o) for n in items[i + 1:] for k, o, _ in n.effects}
        checks = [(k, o, p) for k, o, p in m.effects if (k, o) not in later]
        seen = [(has_column(objects, *o.split('.', 1)) if k == 'column' else (k, o) in objects) == p for k, o, p in checks]
        status = ('unverifiable' if not checks else 'applied_unrecorded' if all(seen)
                  else 'pending' if not any(seen) else 'partial')
        missing = [f'{k}:{o}' for (k, o, _), ok in zip(checks, seen) if not ok]
        rows.append({'name': m.name, 'status': status, 'checked': len(checks), 'missing': missing})
    return rows


def overrides(section: str, db: str) -> dict[str, str]:
    return json.loads(OVERRIDES.read_text(encoding='utf-8'))[section].get(db, {})


def probe(db: str, names: list[str]) -> dict[str, bool | str]:
    found: dict[str, bool | str] = {}
    for name, sql in overrides('probes', db).items():
        if name in names:
            try:
                found[name] = query(db, sql)[0]['ok'] == 1
            except RuntimeError as error:  # e.g. the probed table is not in this database
                found[name] = str(error)[-300:]
    return found


def status(db: str) -> list[dict]:
    recorded, objects = live_schema(db)
    skip = overrides('not_applicable', db)
    files = {m.name for m in migrations(db)}
    unknown = sorted((skip.keys() | overrides('probes', db).keys()) - files)
    if unknown:  # a typo in overrides.json must not silently drop a check
        raise SystemExit(f'overrides_name_not_a_file:{db}:' + ','.join(unknown))
    items = [m for m in migrations(db) if m.name not in skip]
    rows = [{'name': n, 'status': 'not_applicable', 'reason': r} for n, r in skip.items()]
    rows += classify(items, recorded, objects, probe(db, [m.name for m in items if m.name not in recorded]))
    rows += [{'name': n, 'status': 'recorded_without_file'} for n in sorted(recorded - {m.name for m in migrations(db)})]
    return rows


def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def record(db: str, names: list[str], execute: bool) -> None:
    for name in names:
        print(f'record {db} {name}' + ('' if execute else '  (dry-run)'))
        if execute:
            query(db, f'INSERT OR IGNORE INTO d1_migrations (name) VALUES ({sql_text(name)})')
            if query(db, f'SELECT COUNT(*) AS n FROM d1_migrations WHERE name = {sql_text(name)}')[0]['n'] != 1:
                raise RuntimeError(f'record_not_visible:{db}:{name}')


def apply(db: str, execute: bool) -> None:
    rows = [r for r in status(db) if r['status'] not in ('not_applicable', 'recorded_without_file')]
    pending = [r for r in rows if r['status'] == 'pending']
    if not pending:
        print(f'{db}: nothing pending')
        return
    first = rows.index(pending[0])
    blocking = [r for r in rows[:first] if r['status'] in ('partial', 'unverifiable')]
    blocking += [r for r in rows[first:] if r['status'] in ('partial', 'unverifiable', 'applied_unrecorded')]
    if blocking:
        raise SystemExit('apply_refused_unresolved:' + json.dumps(blocking))
    by_name = {m.name: m for m in migrations(db)}
    for row in pending:
        name = row['name']
        print(f'apply {db} {name}' + ('' if execute else '  (dry-run)'))
        if not execute:
            continue
        try:
            execute_file(db, by_name[name].path)
        except RuntimeError as error:  # D1 rolls a failed import back; status shows what is live
            raise SystemExit(f'apply_failed:{db}:{name}:{error} (run status before retrying)') from error
        except subprocess.TimeoutExpired as error:  # the import may still complete server-side
            raise SystemExit(f'apply_outcome_unknown:{db}:{name}:wrangler timed out after {error.timeout}s '
                             '(run status: applied_unrecorded means record, pending means retry)') from error
        # The SQL ran: from here on every failure must say the file is executed but not confirmed recorded.
        unrecorded = (f'apply_executed_not_recorded:{db}:{name}: the file ran but its d1_migrations row is not confirmed; '
                      f'run `python tools/d1/migrations.py status --db {db}`, then `record --db {db} --execute` '
                      'once it reports applied_unrecorded')
        try:
            after = classify([by_name[name]], set(), live_schema(db)[1], probe(db, [name]))[0]
        except Exception as error:
            raise SystemExit(f'{unrecorded}:verify_error:{error!r}') from error
        if after['status'] != 'applied_unrecorded':
            raise SystemExit(f'{unrecorded}:apply_verification_failed:' + json.dumps(after))
        try:
            record(db, [name], True)
        except Exception as error:
            raise SystemExit(f'{unrecorded}:record_error:{error!r}') from error


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', choices=['status', 'record', 'apply'])
    parser.add_argument('--db', choices=sorted(DATABASES), action='append')
    parser.add_argument('--execute', action='store_true', help='perform the writes (record/apply); default prints the plan')
    args = parser.parse_args()
    dbs = args.db or sorted(DATABASES)
    if args.action != 'status' and len(dbs) != 1:
        parser.error('record/apply take exactly one --db')
    for db in dbs:
        if args.action == 'status':
            rows = status(db)
            print(json.dumps({'db': db, 'files': len(rows),
                              'not_recorded': [r for r in rows if r['status'] != 'recorded']}, ensure_ascii=False))
        elif args.action == 'record':
            record(db, [r['name'] for r in status(db) if r['status'] == 'applied_unrecorded'], args.execute)
        else:
            apply(db, args.execute)


if __name__ == '__main__':
    sys.exit(main())
