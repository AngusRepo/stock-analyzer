"""Immutable daily EV admission plus exact registered-candidate continuation."""
from copy import deepcopy

from services.expected_return_candidate_forward_evaluator import _candidate_rows
from services.paired_nav_journal import read_snapshot, digest
from services.paired_nav_lifecycle import registered_pairs

FIELDS = ('artifact_id', 'model_name', 'version', 'artifact_path', 'checksum',
          'source_run_date', 'offline_gate_decision', 'offline_gate_failed_gates', 'training_run_id')


def _projection(row):
    return {key: row[key] for key in FIELDS}


def frozen_ev_selection(context):
    """Read the original admission, never infer it from surviving output plans."""
    selection = context.get('ev_candidate_selection')
    if selection is None:
        return None  # Immutable legacy root; do not rewrite it.
    if selection.get('status') == 'failed':
        raise ValueError('paired_nav_ev_selection_unavailable')
    if (selection.get('schema_version') != 'paired-nav-ev-selection-v1'
            or not isinstance(selection.get('registry_rows'), list)
            or not isinstance(selection.get('l4_checksums'), list)
            or not isinstance(selection.get('fusion_bases'), dict)):
        raise ValueError('paired_nav_ev_selection_invalid')
    rows = {row['checksum']: row for row in selection['registry_rows']}
    if (len(rows) != len(selection['registry_rows'])
            or len(set(selection['l4_checksums'])) != len(selection['l4_checksums'])
            or any(rows.get(key, {}).get('model_name') != 'l4_alpha_ev' for key in selection['l4_checksums'])
            or any(rows.get(key, {}).get('model_name') != 'allocator_ev_fusion'
                or base not in selection['l4_checksums'] for key, base in selection['fusion_bases'].items())):
        raise ValueError('paired_nav_ev_selection_identity_invalid')
    return deepcopy(selection)


def select_ev_candidates(*, snapshot_id, signal_date, query):
    """Do not let mutable registry status end a registered NAV experiment.

    New daily roots seal selection BEFORE artifact reads/inference. Legacy plans
    retain their own whole-selection seals. Old plans may recover exact registry
    identities; a missing old artifact is an error, never a latest-model fallback.
    """
    parent = query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [snapshot_id])
    if parent:
        saved = read_snapshot(query, snapshot_id)
        if saved['manifest']['snapshot_kind'] != 'allocation_context' or saved['manifest']['signal_date'] != signal_date:
            raise ValueError('paired_nav_ev_selection_parent_invalid')
        frozen = frozen_ev_selection(saved['payload']['content'])
        if frozen is not None:
            return frozen
    manifests = query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 "
        "WHERE snapshot_kind='allocation_pair' AND signal_date=?", [signal_date])
    cached, legacy = [], []
    for row in manifests:
        plan = read_snapshot(query, row['snapshot_id'])['payload']['content']
        if plan.get('owner') not in {'l4_alpha_ev', 'allocator_ev_fusion'} or plan.get('allocation_context_snapshot_id') != snapshot_id:
            continue
        if plan.get('ev_candidate_selection'):
            cached.append(plan['ev_candidate_selection'])
        else:
            legacy.append(plan)
    if cached:
        if len({digest(item) for item in cached}) != 1:
            raise ValueError('paired_nav_ev_selection_changed_within_parent')
        return deepcopy(cached[0])
    selected, _ = _candidate_rows(query, '') if not legacy else ({}, {})
    rows = {row['checksum']: _projection(row) for row in selected.values()}
    l4_checksums, fusion_bases = set(), {}
    if 'l4_alpha_ev' in selected:
        l4_checksums.add(selected['l4_alpha_ev']['checksum'])
        if 'allocator_ev_fusion' in selected:
            fusion_bases[selected['allocator_ev_fusion']['checksum']] = selected['l4_alpha_ev']['checksum']
    def exact_row(checksum, owner, source):
        frozen = (source.get('ev_candidate_selection') or {}).get('registry_rows', [])
        matches = [r for r in frozen if r['checksum'] == checksum and r['model_name'] == owner]
        if not matches:
            matches = query('SELECT * FROM model_artifact_registry WHERE checksum=? AND model_name=?', [checksum, owner])
        if len(matches) != 1:
            raise ValueError('paired_nav_registered_ev_artifact_missing_or_ambiguous')
        return _projection(matches[0])
    pinned_rows = {}
    def retain(row):
        key = row['checksum']
        if key in pinned_rows and pinned_rows[key] != row:
            raise ValueError('paired_nav_registered_ev_metadata_conflict')
        pinned_rows[key] = row
        rows[key] = row
    pinned = [entry['allocation']['payload']['content']
        for entry in registered_pairs(signal_date=signal_date, query=query)]
    for plan in [*legacy, *pinned]:
        owner = plan['owner']
        if owner not in {'l4_alpha_ev', 'allocator_ev_fusion'}:
            continue
        row = exact_row(plan['candidate_checksum'], owner, plan)
        if row['artifact_id'] != plan['candidate_artifact_id'] or row['training_run_id'] != plan['candidate_training_run_id']:
            raise ValueError('paired_nav_registered_ev_identity_changed')
        retain(row)
        l4 = plan['candidate_checksum'] if owner == 'l4_alpha_ev' else plan['exact_l4_checksum']
        l4_checksums.add(l4)
        if owner == 'allocator_ev_fusion':
            base = exact_row(l4, 'l4_alpha_ev', plan)
            if any(base[key] != row[key] for key in ('training_run_id', 'source_run_date')):
                raise ValueError('paired_nav_registered_fusion_l4_mismatch')
            retain(base)
            if row['checksum'] in fusion_bases and fusion_bases[row['checksum']] != l4:
                raise ValueError('paired_nav_registered_fusion_baseline_changed')
            fusion_bases[row['checksum']] = l4
    return {'schema_version': 'paired-nav-ev-selection-v1',
        'registry_rows': [rows[key] for key in sorted(rows)],
        'l4_checksums': sorted(l4_checksums), 'fusion_bases': dict(sorted(fusion_bases.items()))}
