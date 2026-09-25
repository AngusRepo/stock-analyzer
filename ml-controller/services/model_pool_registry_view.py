"""UI-only registry transport: retain the complete index and needed evidence.

Historical rows still count and keep every non-evidence column. Full evidence
is fetched for every row which either existing UI builder can return or use
for a decision/comparison. Admission and inference keep their full readers.
"""
import json
import re
from services import model_artifact_registry as registry


def evidence_ids(rows, pointers):
    needed = set()
    grouped = {}
    pointer_ids = {str(p.get('champion_artifact_id') or '') for p in pointers}
    versions = {(str(p.get('model_name') or ''), str(p.get('champion_version') or '')) for p in pointers}
    supported = {'oof_full_fit_release', 'manual_hotfix', 'timesfm_l175_l2_feature_release'}
    for row in rows:
        artifact = row['artifact_id']
        model = str(row.get('model_name') or 'unknown')
        if (artifact in pointer_ids or (model, str(row.get('version') or '')) in versions
                or (row.get('candidate_type') in supported and row.get('state') not in {'production', 'archived', 'rejected'})):
            needed.add(artifact)
        if (registry.is_production_artifact_model(model) and row.get('candidate_type') == 'oof_full_fit_release'
                and not registry._legacy_shadow_selection_row(row)):
            grouped.setdefault(model, []).append(row)
    for items in grouped.values():
        needed.add(max(items, key=registry._artifact_time_key)['artifact_id'])
    return needed


def list_workbench_artifacts(*, pointers, model_name=None, limit=200):
    client = registry.d1_client
    fields = [row['name'] for row in client.query('PRAGMA table_info(model_artifact_registry)', [])]
    if not fields or any(re.fullmatch('[a-zA-Z_][a-zA-Z_0-9]*', name) is None for name in fields):
        raise RuntimeError('model_pool_registry_schema_invalid')
    evidence = {'offline_evidence_json', 'live_evidence_json'}
    index_fields = [name for name in fields if name not in evidence]
    where, args = ('WHERE model_name = ?', [model_name]) if model_name else ('', [])
    rows = client.query('SELECT ' + ','.join(index_fields) + ' FROM model_artifact_registry '
        + where + ' ORDER BY updated_at DESC, created_at DESC LIMIT ?',
        [*args, max(1, min(int(limit or 100), 500))])
    needed = sorted(evidence_ids(rows, pointers))
    hydrated = {}
    for start in range(0, len(needed), 50):
        ids = needed[start:start + 50]
        full = client.query('SELECT * FROM model_artifact_registry WHERE artifact_id IN ('
            + ','.join('?' for _ in ids) + ')', ids)
        if {r['artifact_id'] for r in full} != set(ids) or len(full) != len(ids):
            raise RuntimeError('model_pool_registry_evidence_incomplete')
        hydrated.update((r['artifact_id'], r) for r in full)
    result = []
    for row in rows:
        full = hydrated.get(row['artifact_id'])
        if full is not None and any(full.get(k) != row.get(k) for k in index_fields):
            raise RuntimeError('model_pool_registry_index_changed')
        item = dict(full if full is not None else row)
        for key in ('offline_gate_failed_gates', 'offline_evidence_json', 'live_evidence_json'):
            raw = item.get(key)
            if isinstance(raw, str):
                try:
                    item[key] = registry._json_safe(json.loads(raw))
                except json.JSONDecodeError:
                    pass
        result.append(item)
    return result
