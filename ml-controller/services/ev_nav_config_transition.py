"""Read-only original EV publication proof for L3 configuration compatibility.

This grants no EV/L3 promotion and writes no evidence. Only the four artifact
aliases written by the original Worker hydration may replace L3's old config.
All other configuration still belongs to its existing owner/serving verifier.
"""
from copy import deepcopy
import hashlib
import json
from datetime import timedelta, timezone

from services.paired_nav_journal import digest, read_snapshot, _timestamp
from services.opb_nav_control import _history_time, _same_json, _without_prior

ALIASES = {'l4_alpha_ev': ('l4AlphaEv', 'l4_alpha_ev'),
           'allocator_ev_fusion': ('allocatorEvFusion', 'allocator_ev_fusion')}


def _fail(reason):
    raise RuntimeError('active8_nav_ev_projection_' + reason)


def _without_ev(value):
    value = _without_prior(value)
    ensemble = value.get('ensemble_v2') or {}
    for names in ALIASES.values():
        for name in names:
            ensemble.pop(name, None)
    return value


def _source(query, owner):
    pointer = query('SELECT * FROM model_champion_pointers WHERE model_name=?', [owner])
    if len(pointer) != 1:
        _fail('pointer_missing_or_ambiguous')
    artifact_id = pointer[0]['champion_artifact_id']
    result = {'pointer': pointer, 'registry': query('SELECT * FROM model_artifact_registry WHERE artifact_id=?', [artifact_id]),
        'payload': query('SELECT * FROM expected_return_artifact_payloads WHERE artifact_id=?', [artifact_id]),
        'state': query('SELECT * FROM expected_return_owner_state_v2 WHERE owner=?', [owner]),
        'history': query('SELECT * FROM model_champion_history WHERE model_name=? AND retired_at IS NULL', [owner])}
    if any(len(rows) != 1 for rows in result.values()):
        _fail('source_missing_or_ambiguous')
    return {key: rows[0] for key, rows in result.items()}


def verified_ev_projection(*, query, publication, original, current, now):
    """Return original config plus ONLY exactly verified EV artifact aliases."""
    from services.active8_nav_adoption import read_original_committed_review
    before = original.get('ensemble_v2') or {}
    after = current['trading_config'].get('ensemble_v2') or {}
    changed = [owner for owner, names in ALIASES.items()
        if any((name in before) != (name in after) or not _same_json(before.get(name), after.get(name)) for name in names)]
    result = deepcopy(original)
    if not changed:
        return result
    if not _same_json(_without_ev(original), _without_ev(current['trading_config'])):
        _fail('unrelated_configuration_changed')
    l3 = json.loads(publication.payload_json)
    l3_receipt = json.loads(publication.receipt_json)
    formal = {'artifact_id': l3_receipt['ensemble_artifact_id'], **{key: l3[key] for key in
        ('cohort_id', 'payload_checksum', 'base_artifact_set_checksum')}}
    sources = {}
    for owner in changed:
        source = _source(query, owner)
        sources[owner] = source
        p, r, x, state, h = (source[key] for key in ('pointer', 'registry', 'payload', 'state', 'history'))
        artifact_id, checksum, version = r['artifact_id'], r['checksum'], r['version']
        evidence = json.loads(p['promotion_evidence_json'])
        artifact = json.loads(x['artifact_json'])
        if (artifact_id != f'{owner}:{version}:{checksum}' or r['model_name'] != owner or r['state'] != 'production'
                or p['champion_artifact_id'] != artifact_id or p['champion_version'] != version
                or x['model_name'] != owner or x['model_version'] != version or x['serving_mode'] != 'alpha'
                or x['source_artifact_checksum'] != checksum or x['source_artifact_path'] != r['artifact_path']
                or hashlib.sha256(x['artifact_json'].encode()).hexdigest() != x['payload_checksum']
                or artifact.get('model_version') != version or artifact.get('expected_return_owner') != owner
                or state['owner_state'] != 'learned_champion' or state['champion_artifact_id'] != artifact_id
                or h['artifact_id'] != artifact_id or h['version'] != version
                or h['source'] != 'model_champion_history' or h['evidence_grade'] != 'exact'
                or h['event_id'] != f'expected-return:{owner}:{version}:{checksum[:16]}'
                or h['evidence_json'] != p['promotion_evidence_json']
                or evidence.get('schema_version') != 'expected-return-pointer-promotion-v1'
                or evidence.get('owner') != owner or evidence.get('artifact_checksum') != checksum
                or evidence.get('artifact_path') != r['artifact_path'] or evidence.get('payload_checksum') != x['payload_checksum']
                or any(not _same_json(after.get(name), artifact) for name in ALIASES[owner])):
            _fail('publication_or_payload_invalid')
        promoted = _history_time(p['promoted_at'])
        if (_history_time(h['effective_at']) != promoted or not _timestamp(publication.published_at) <= promoted <= now):
            _fail('publication_time_invalid')
        gate = evidence['prospective_validation']
        nav = gate['nav_validation']
        body = {key: value for key, value in nav.items() if key not in ('decision_checksum', 'decision_payload_json')}
        if (gate.get('schema_version') != 'expected-return-candidate-nav-gate-v1' or gate.get('decision') != 'PASS'
                or gate.get('candidate_artifact_id') != artifact_id or gate.get('candidate_artifact_checksum') != checksum
                or nav.get('decision') != 'PASS' or nav.get('owner') != owner
                or nav.get('candidate_artifact_id') != artifact_id or nav.get('candidate_checksum') != checksum
                or nav.get('decision_checksum') != digest(body) or json.loads(nav.get('decision_payload_json') or '{}') != body
                or gate.get('evaluation_evidence_checksum') != nav['decision_checksum']
                or not _same_json(artifact.get('prospective_validation'), gate)):
            _fail('original_decision_invalid')
        records = read_original_committed_review(nav, query=query)
        saved = read_snapshot(query, nav['allocation_snapshot_id'])
        plan = saved['payload']['content']
        frozen = plan['configuration']
        if (nav['as_of_date'] > promoted.astimezone(timezone(timedelta(hours=8))).date().isoformat()
                or nav['checkpoint_as_of_date'] > nav['as_of_date']
                or any(_timestamp(item['header']['created_at']) > promoted for item in records)
                or saved['manifest']['payload_checksum'] != nav['allocation_payload_checksum']
                or _timestamp(saved['manifest']['frozen_at']) > promoted
                or plan['owner'] != owner or plan['candidate_artifact_id'] != artifact_id or plan['candidate_checksum'] != checksum
                or plan['baseline_checksum'] != nav['baseline_checksum'] or digest(frozen) != nav['configuration_checksum']
                or any(frozen['formal_baseline_identity'][key] != value for key, value in formal.items())
                or not _same_json(frozen['risk_config'], current['risk_config'])
                or not _same_json(_without_ev(frozen['trading_config']), _without_ev(original))
                or not _same_json(frozen['allocator_source_identity'], current['allocator_source_identity'])
                or frozen.get('native_execution_policy') != current.get('native_execution_policy')):
            _fail('frozen_source_or_configuration_invalid')
        if owner == 'allocator_ev_fusion':
            l4 = _source(query, 'l4_alpha_ev')
            if 'l4_alpha_ev' in sources and sources['l4_alpha_ev'] != l4:
                _fail('source_changed_during_read')
            if l4['registry']['checksum'] != nav['baseline_checksum'] or l4['registry']['state'] != 'production':
                _fail('exact_l4_dependency_changed')
            sources['l4_alpha_ev'] = l4
        for name in ALIASES[owner]:
            result.setdefault('ensemble_v2', {})[name] = deepcopy(artifact)
    for owner, source in sources.items():
        if _source(query, owner) != source:
            _fail('source_changed_during_read')
    return result
