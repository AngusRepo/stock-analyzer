"""Copy the multi-D1 cutover control plane between the legacy DB and the Ops DB (D9 / legacy retire step 1).

The nine control tables already exist in stockvision-ops-db with the same schema as in stockvision-db
(ops migrations 0001/0003/0004); Ops only holds a stale mirror. The Worker reads the control plane from
the database named by DATA_DOMAIN_CONTROL_PLANE ("legacy" | "ops", worker/src/lib/legacyDatabase.ts).

  plan    (default, read-only) sqlite_master + PRAGMA table_info on both sides, bounded row counts
  export  (read-only on D1)    SELECT every row of the nine small tables from the source, write a
                               replace-all copy.sql plus manifest.json (direction, target, sql sha256,
                               per-table rows + digest) under --out
  backup  (read-only on D1)    the same snapshot of ONE database (--db) whose restore target is that
                               same database; take it of the target before apply
  apply   (WRITES the target)  the target comes from the manifest.json next to --sql, never from a
                               flag; refuses a --direction that disagrees with it, a copy.sql whose
                               sha256 changed, and (copies only) a source whose digests moved since
                               export. Needs --execute AND --confirm COPY-CONTROL-PLANE (Wei go)
  verify  (read-only)          per-table row count + ordered-row digest, source vs target

--direction legacy-to-ops is the cutover; ops-to-legacy is the rollback copy before setting the var
back to "legacy". Stop every control-plane writer (migration-era scheduler jobs) before export.
A failed or wrong apply on Ops is undone by applying the `backup --db ops` snapshot taken just before.

  python tools/d1/legacy_control_plane_copy.py plan
  python tools/d1/legacy_control_plane_copy.py export --out audits/control-plane-copy-YYYYMMDD
  python tools/d1/legacy_control_plane_copy.py backup --db ops --out audits/control-plane-ops-backup-YYYYMMDD
  python tools/d1/legacy_control_plane_copy.py apply --sql audits/.../copy.sql --execute --confirm COPY-CONTROL-PLANE
  python tools/d1/legacy_control_plane_copy.py verify
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from tools.d1 import migrations as d1  # noqa: E402  (shared wrangler runner)

CONTROL_PLANE_TABLES = (
    'domain_projection_outbox',
    'domain_projection_inbox',
    'data_domain_cutovers',
    'data_domain_writer_epochs',
    'data_domain_table_writer_epochs',
    'data_domain_cutover_probe_receipts',
    'data_domain_cutover_probe_canary',
    'data_domain_backfill_cursors',
    'data_domain_parity_checks',
)
# Every table is a small control table; a bigger one means this is the wrong database or a runaway writer.
MAX_ROWS = 10_000
DIRECTIONS = {'legacy-to-ops': ('legacy', 'ops'), 'ops-to-legacy': ('ops', 'legacy')}
CONFIRM_PHRASE = 'COPY-CONTROL-PLANE'


def columns(db: str, table: str) -> list[dict]:
    return d1.query(db, f'PRAGMA table_info({table})')


def bounded_count(db: str, table: str) -> int:
    # The LIMIT caps rows read even if a table unexpectedly grew.
    sql = f'SELECT COUNT(*) AS n FROM (SELECT 1 FROM {table} LIMIT {MAX_ROWS + 1})'
    return int(d1.query(db, sql)[0]['n'])


def column_names(info: list[dict]) -> list[str]:
    return [str(c['name']) for c in sorted(info, key=lambda c: int(c['cid']))]


def primary_key(info: list[dict]) -> list[str]:
    keyed = sorted((c for c in info if int(c.get('pk') or 0) > 0), key=lambda c: int(c['pk']))
    return [str(c['name']) for c in keyed]


def plan(source: str, target: str) -> dict:
    tables = []
    for table in CONTROL_PLANE_TABLES:
        src, dst = columns(source, table), columns(target, table)
        tables.append({
            'table': table,
            'schema_equal': column_names(src) == column_names(dst) and primary_key(src) == primary_key(dst),
            'missing_in_target': sorted(set(column_names(src)) - set(column_names(dst))),
            'source_rows': bounded_count(source, table),
            'target_rows': bounded_count(target, table),
        })
    blocked = [t['table'] for t in tables if not t['schema_equal'] or t['source_rows'] > MAX_ROWS]
    return {'source': source, 'target': target, 'tables': tables, 'blocked': blocked}


def sql_literal(value) -> str:
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        return '1' if value else '0'
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def ordered_rows(db: str, table: str, info: list[dict]) -> list[dict]:
    order = ', '.join(primary_key(info) or column_names(info))
    return d1.query(db, f'SELECT * FROM {table} ORDER BY {order} LIMIT {MAX_ROWS + 1}')


def digest(rows: list[dict], names: list[str]) -> str:
    h = hashlib.sha256()
    for row in rows:
        h.update(json.dumps([row.get(n) for n in names], ensure_ascii=False, sort_keys=False).encode('utf-8'))
        h.update(b'\n')
    return h.hexdigest()


def build_copy_sql(table: str, names: list[str], rows: list[dict]) -> list[str]:
    """Replace-all: the target's stale mirror rows must not survive next to the copied ones."""
    statements = [f'DELETE FROM {table};']
    cols = ', '.join(names)
    for row in rows:
        values = ', '.join(sql_literal(row.get(n)) for n in names)
        statements.append(f'INSERT INTO {table} ({cols}) VALUES ({values});')
    return statements


def snapshot_tables(db: str) -> tuple[list[str], dict]:
    statements: list[str] = []
    tables = {}
    for table in CONTROL_PLANE_TABLES:
        info = columns(db, table)
        names = column_names(info)
        rows = ordered_rows(db, table, info)
        if len(rows) > MAX_ROWS:
            raise SystemExit(f'export_refused_table_too_large:{db}.{table}')
        statements += build_copy_sql(table, names, rows)
        tables[table] = {'rows': len(rows), 'digest': digest(rows, names)}
    return statements, tables


def write_snapshot(out: Path, manifest: dict, statements: list[str]) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    sql = '\n'.join(statements) + '\n'
    (out / 'copy.sql').write_text(sql, encoding='utf-8')
    manifest['sql_sha256'] = hashlib.sha256(sql.encode('utf-8')).hexdigest()
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return manifest


def export(source: str, target: str, out: Path) -> dict:
    checked = plan(source, target)
    if checked['blocked']:
        raise SystemExit('export_refused:' + json.dumps(checked['blocked']))
    statements, tables = snapshot_tables(source)
    direction = next(name for name, pair in DIRECTIONS.items() if pair == (source, target))
    return write_snapshot(out, {'kind': 'copy', 'direction': direction, 'source': source, 'target': target,
                                'tables': tables}, statements)


def backup(db: str, out: Path) -> dict:
    """Snapshot of one database whose restore target is itself (undo for a copy applied onto it)."""
    statements, tables = snapshot_tables(db)
    return write_snapshot(out, {'kind': 'backup', 'direction': None, 'source': db, 'target': db,
                                'tables': tables}, statements)


def verify(source: str, target: str) -> dict:
    tables = {}
    for table in CONTROL_PLANE_TABLES:
        info = columns(source, table)
        names = column_names(info)
        src, dst = ordered_rows(source, table, info), ordered_rows(target, table, info)
        tables[table] = {
            'source_rows': len(src), 'target_rows': len(dst),
            'equal': len(src) == len(dst) and digest(src, names) == digest(dst, names),
        }
    return {'source': source, 'target': target, 'tables': tables,
            'parity': all(t['equal'] for t in tables.values())}


def load_manifest(sql_path: Path) -> dict:
    manifest_path = sql_path.with_name('manifest.json')
    if not sql_path.is_file() or not manifest_path.is_file():
        raise SystemExit(f'apply_snapshot_missing:{sql_path}:{manifest_path}')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('kind') not in ('copy', 'backup') or manifest.get('target') not in ('legacy', 'ops'):
        raise SystemExit('apply_refused_manifest_invalid')
    actual = hashlib.sha256(sql_path.read_bytes()).hexdigest()
    if actual != manifest.get('sql_sha256'):
        raise SystemExit('apply_refused_sql_changed_since_export')
    return manifest


def apply(sql_path: Path, execute: bool, confirm: str | None, direction: str | None = None) -> str:
    """Runs copy.sql on the manifest's target. Returns that target."""
    manifest = load_manifest(sql_path)
    target = manifest['target']
    if direction is not None and direction != manifest['direction']:
        raise SystemExit(f'apply_refused_direction_mismatch:flag={direction}:manifest={manifest["direction"]}')
    if manifest['kind'] == 'copy':
        # The source must still be what was exported: a writer that ran since would be lost.
        _, tables = snapshot_tables(manifest['source'])
        moved = sorted(t for t, v in manifest['tables'].items() if tables.get(t) != v)
        if moved:
            raise SystemExit('apply_refused_source_changed_since_export:' + ','.join(moved))
    print(f'apply {manifest["kind"]} -> {target} {sql_path}' + ('' if execute else '  (dry-run)'))
    if not execute:
        return target
    if confirm != CONFIRM_PHRASE:
        raise SystemExit(f'apply_refused: pass --confirm {CONFIRM_PHRASE} together with --execute')
    d1.execute_file(target, sql_path)
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('action', nargs='?', default='plan', choices=['plan', 'export', 'backup', 'apply', 'verify'])
    parser.add_argument('--direction', choices=sorted(DIRECTIONS),
                        help='plan/export/verify (default legacy-to-ops); apply only cross-checks it against the manifest')
    parser.add_argument('--db', choices=['legacy', 'ops'], help='backup: the database to snapshot')
    parser.add_argument('--out', type=Path, help='export directory (copy.sql + manifest.json)')
    parser.add_argument('--sql', type=Path, help='apply: the exported copy.sql')
    parser.add_argument('--execute', action='store_true', help='apply: perform the write (default prints the plan)')
    parser.add_argument('--confirm', help=f'apply: must equal {CONFIRM_PHRASE}')
    args = parser.parse_args(argv)
    source, target = DIRECTIONS[args.direction or 'legacy-to-ops']
    if args.action == 'plan':
        print(json.dumps(plan(source, target), indent=2))
    elif args.action == 'export':
        if not args.out:
            parser.error('export needs --out')
        print(json.dumps(export(source, target, args.out), indent=2))
    elif args.action == 'backup':
        if not args.out or not args.db:
            parser.error('backup needs --db and --out')
        print(json.dumps(backup(args.db, args.out), indent=2))
    elif args.action == 'apply':
        if not args.sql:
            parser.error('apply needs --sql')
        apply(args.sql, args.execute, args.confirm, args.direction)
    else:
        result = verify(source, target)
        print(json.dumps(result, indent=2))
        return 0 if result['parity'] else 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
