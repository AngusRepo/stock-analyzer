"""Read-only preflight for additive journal rollout, including old local 0040.

CREATE TABLE IF NOT EXISTS does not upgrade CHECK constraints. Reject incompatible
schema before archiving any parts; never leave a success-looking partial seal.
"""
import re


def validate_paired_nav_schema(query) -> dict:
    names = ('paired_nav_frozen_parts_v1', 'paired_nav_frozen_manifests_v1', 'paired_nav_daily_journal_v1')
    rows = query("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN (?,?,?)", list(names))
    tables = {row['name']: row['sql'] or '' for row in rows}
    if set(tables) != set(names):
        raise RuntimeError('paired_nav_migration_0040_missing')
    sql = tables[names[1]]
    match = re.search(r'CHECK\s*\(\s*snapshot_kind\s+IN\s*\(([^)]+)\)\s*\)', sql, re.I)
    if match is None or set(re.findall(r"'([^']+)'", match.group(1))) != {
        'allocation_context', 'allocation_pair', 'execution_pair', 'execution_receipt',
    }:
        raise RuntimeError('paired_nav_schema_kind_constraint_incompatible')
    for table, required in {
        names[0]: {'snapshot_id', 'part_no', 'payload_text'},
        names[1]: {'snapshot_id', 'signal_date', 'source_run_id', 'frozen_at', 'payload_checksum',
                   'part_count', 'prospective', 'snapshot_kind', 'parent_snapshot_id'},
        names[2]: {'pair_id', 'session_date', 'snapshot_id', 'previous_checksum',
                   'payload_json', 'payload_checksum', 'recorded_at'},
    }.items():
        columns = {row['name'] for row in query(f'PRAGMA table_info({table})', [])}
        if not required <= columns:
            raise RuntimeError('paired_nav_schema_columns_incompatible:' + table)
    triggers = query("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (?,?,?)", list(names))
    available = {row['name']: row['sql'] or '' for row in triggers}
    for stem, table, reason in (
        ('paired_nav_parts', names[0], 'paired_nav_immutable_part'),
        ('paired_nav_manifest', names[1], 'paired_nav_immutable_manifest'),
        ('paired_nav_journal', names[2], 'paired_nav_immutable_journal'),
    ):
        for suffix, operation in (('update', 'UPDATE'), ('delete', 'DELETE'), ('replace', 'INSERT')):
            name = f'{stem}_no_{suffix}_v1'
            body = available.get(name, '')
            if (not re.search(r'BEFORE\s+' + operation + r'\s+ON\s+' + table + r'\b', body, re.I)
                    or not re.search(r"RAISE\s*\(\s*ABORT\s*,\s*'" + reason + "'\\s*\\)", body, re.I)
                    or suffix == 'replace' and not re.search(r'RAISE\s*\(\s*IGNORE\s*\)', body, re.I)):
                raise RuntimeError('paired_nav_schema_immutability_missing:' + name)
    # NAV integrity is independent of the retired assessment-budget experiment.
    # Existing 0042 records remain immutable, but are not an accounting prerequisite.
    return {'schema': 'paired-nav-journal-v1', 'status': 'ready', 'schema_writes': 0}
