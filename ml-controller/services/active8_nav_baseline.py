"""Read-only bridge to the ORIGINAL committed L3 authority; no new verdict.

Return exact database read anchors so a downstream Worker can prevent a race
between this verification and its own transaction. No caller SQL or PASS input.
"""
from copy import deepcopy
from datetime import datetime, timezone
import json

from services.active8_nav_adoption import load_committed_nav_publication


IDENTITY = ('artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum')
# Only original authority SELECTs are captured; PRAGMA/schema checks remain in
# the original reader. No database writes, fitting or statistical review here.
TABLES = frozenset({'active8_ensemble_pointer_v1', 'active8_ensemble_artifacts_v1',
    'model_artifact_registry', 'model_champion_pointers', 'model_champion_history',
    'paired_nav_review_records_v1', 'paired_nav_review_parts_v1',
    'paired_nav_frozen_manifests_v1', 'paired_nav_frozen_parts_v1', 'paired_nav_cold_objects_v1'})


def _row_set(rows):
    # A SELECT without ORDER BY has no contractual row order. Preserve duplicate
    # counts and every column/value, while comparing the actual row multiset.
    return sorted(json.dumps(row, sort_keys=True, ensure_ascii=False, allow_nan=False) for row in rows)


def read_committed_nav_baseline(*, formal, query, now=None):
    import re
    clock = now or datetime.now(timezone.utc)
    reads = {}
    source_sets = []
    def capture(sql, params):
        rows = query(sql, params)
        match = re.fullmatch(r'SELECT (\*|part_no,payload_text) FROM ([a-z0-9_]+)(.*)', sql)
        predicate = (re.fullmatch(r'(?: WHERE (?:singleton_id=1|(?:artifact_id|record_id|snapshot_id)=\?|'
                                  r'(?:retired_at IS NULL AND )?(?:artifact_id|model_name) IN \(\?(?:,\?)*\)))?'
                                  r'(?: ORDER BY part_no)?', match[3]) if match else None)
        if match and match[2] in TABLES and predicate:
            # Export exact original query results, including empty populations.
            # The Worker validates a closed SELECT grammar before execution.
            key = (sql, tuple(params))
            if key in reads and _row_set(reads[key]['rows']) != _row_set(rows):
                raise RuntimeError('active8_nav_baseline_source_changed')
            reads[key] = {'sql': sql, 'params': list(params), 'rows': deepcopy(rows)}
        elif sql.startswith("SELECT 'model_artifact_registry' AS source_table,") and ' UNION ALL ' in sql:
            # Preserve the original five-table snapshot, but do not export its SQL to D1.
            source_sets.append(deepcopy(rows))
        elif any(f' FROM {table}' in sql for table in TABLES):
            raise RuntimeError('active8_nav_baseline_query_unsupported')
        return rows
    grant = load_committed_nav_publication(query=capture, now=clock)
    if grant is None:
        raise RuntimeError('active8_nav_baseline_committed_grant_missing')
    payload = json.loads(grant.payload_json)
    names = sorted(payload['observation_artifacts'])
    selected = sorted(payload['selected_models'])
    def slots(count):
        return ','.join('?' for _ in range(count))
    source_queries = [
        ('model_artifact_registry', f'SELECT * FROM model_artifact_registry WHERE artifact_id IN ({slots(len(names))})',
         [payload['observation_artifacts'][name]['artifact_id'] for name in names]),
        ('model_champion_pointers', f'SELECT * FROM model_champion_pointers WHERE model_name IN ({slots(len(names))})', names),
        ('active8_ensemble_artifacts_v1', 'SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?',
         [formal['artifact_id']]),
        ('active8_ensemble_pointer_v1', 'SELECT * FROM active8_ensemble_pointer_v1 WHERE singleton_id=1', []),
        ('model_champion_history',
         f'SELECT * FROM model_champion_history WHERE retired_at IS NULL AND model_name IN ({slots(len(selected))})',
         selected),
    ]
    if not source_sets or not names or not selected:
        raise RuntimeError('active8_nav_baseline_source_set_missing')
    for source_set in source_sets:
        grouped = {table: [] for table, _, _ in source_queries}
        for source in source_set:
            if (not isinstance(source, dict) or set(source) != {'source_table', 'source_row'}
                    or source['source_table'] not in grouped):
                raise RuntimeError('active8_nav_baseline_source_set_invalid')
            row = json.loads(source['source_row'])
            if not isinstance(row, dict):
                raise RuntimeError('active8_nav_baseline_source_set_invalid')
            grouped[source['source_table']].append(row)
        for table, sql, params in source_queries:
            key = (sql, tuple(params))
            rows = grouped[table]
            if key in reads:
                if _row_set(reads[key]['rows']) != _row_set(rows):
                    raise RuntimeError('active8_nav_baseline_source_changed')
            else:
                reads[key] = {'sql': sql, 'params': list(params), 'rows': rows}
    pointer = capture('SELECT * FROM active8_ensemble_pointer_v1 WHERE singleton_id=1', [])
    if len(pointer) != 1 or any(pointer[0].get(key) != formal.get(key) for key in IDENTITY):
        raise RuntimeError('active8_nav_baseline_identity_changed')
    for item in reads.values():
        if _row_set(query(item['sql'], item['params'])) != _row_set(item['rows']):
            raise RuntimeError('active8_nav_baseline_source_changed')
    return {'schema_version': 'active8-nav-committed-baseline-v1',
        'source': 'original_committed_nav_publication', 'read_only': True,
        'observed_at': clock.isoformat(), 'published_at': grant.published_at,
        'formal': {key: pointer[0][key] for key in IDENTITY},
        'receipt_json': grant.receipt_json, 'anchors': list(reads.values())}
