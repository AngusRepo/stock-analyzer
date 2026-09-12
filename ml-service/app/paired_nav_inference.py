"""Run frozen candidate bundles through the same compute-only L3 engine.

Only the shadow artifact slots may differ. Market inputs, serving artifacts,
source revision and run identity are inherited, never accepted from a child.
No callback, fit, publication or serving-pointer operation exists here.
"""
from copy import deepcopy
import hashlib
import json


def checksum(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
        ensure_ascii=False, allow_nan=False).encode('utf-8')).hexdigest()


def run_candidate_bundles(parent, *, compute):
    requests = parent.get('paired_nav_l3_requests')
    if requests is None:
        return None
    if not isinstance(requests, list):
        raise ValueError('paired_nav_l3_requests_invalid')
    from app.serving_resolver import (
        active8_shadow_candidate_identities, build_pool_from_frozen_manifest,
    )
    from app.serving_resolver import DIRECT_ALPHA_MODELS as ACTIVE_ALPHA_MODELS

    result = {'schema_version': 'paired-nav-l3-inference-v1',
        'request_checksum': checksum(requests), 'production_effect': False, 'bundles': {}}
    seen = set()
    for request in requests:
        if not isinstance(request, dict) or set(request) != {
                'bundle_key', 'candidates', 'sequence_series_by_model', 'sequence_contracts'}:
            raise ValueError('paired_nav_l3_request_fields_invalid')
        rows = request['candidates']
        if not isinstance(rows, list) or len(rows) != len(ACTIVE_ALPHA_MODELS):
            raise ValueError('paired_nav_l3_request_base_set_invalid')
        base = {r['model']: {k: r[k] for k in ('artifact_id', 'version', 'checksum', 'candidate_type')}
                for r in rows}
        key = checksum(base)
        if set(base) != set(ACTIVE_ALPHA_MODELS) or request['bundle_key'] != key or key in seen:
            raise ValueError('paired_nav_l3_request_identity_invalid')
        seen.add(key)
        child = deepcopy(parent)
        child.pop('paired_nav_l3_requests', None)
        child.pop('paired_nav_atomic_slates', None)
        # This is not an external flag to suppress a real callback: compute has
        # no publication capability and the parent remains the single publisher.
        for field in ('callback_url', 'callback_token'):
            child.pop(field, None)
        manifest = child['serving_manifest']
        manifest['active8_shadow_candidates'] = deepcopy(rows)
        manifest['active8_shadow_suppressions'] = []
        child['serving_manifest_digest'] = checksum(manifest)
        build_pool_from_frozen_manifest(manifest,
            expected_digest=child['serving_manifest_digest'],
            l2_sidecar_context={'version': child.get('active_versions', {}).get('TimesFM')})
        child['active8_shadow_artifact_identities'] = active8_shadow_candidate_identities(manifest)
        contracts = request['sequence_contracts']
        series = request['sequence_series_by_model']
        sequence_names = {'DLinear', 'PatchTST', 'iTransformer'}
        if set(contracts) != sequence_names or set(series) != sequence_names:
            raise ValueError('paired_nav_l3_sequence_set_invalid')
        row_map = {r['model']: r for r in rows}
        source_series = {str(r.get('symbol') or r.get('stock_id')): r
                         for r in parent['sequence_series']}
        if len(source_series) != len(parent['sequence_series']):
            raise ValueError('paired_nav_l3_sequence_source_duplicate')
        for name in sequence_names:
            expected = {**row_map[name]['schema']['sequence_contract'],
                        'artifact_path': row_map[name]['artifact_path']}
            if contracts[name] != expected:
                raise ValueError('paired_nav_l3_sequence_contract_identity_invalid')
            symbols = []
            for row in series[name]:
                symbol = str(row.get('symbol') or row.get('stock_id'))
                if row != source_series.get(symbol):
                    raise ValueError('paired_nav_l3_sequence_source_changed')
                symbols.append(symbol)
            if len(symbols) != len(set(symbols)):
                raise ValueError('paired_nav_l3_sequence_duplicate_symbol')
            eligible = [r for r in parent['sequence_series']
                        if isinstance(r.get('prices'), list) and len(r['prices']) >= int(expected['seq_len'])]
            if series[name] != eligible:
                raise ValueError('paired_nav_l3_sequence_coverage_changed')
        child['active8_shadow_sequence_series_by_model'] = deepcopy(series)
        child['active8_shadow_sequence_contracts'] = deepcopy(contracts)
        contract = deepcopy(child['sequence_input_contract'])
        contract.pop('digest', None)
        contract['serving_manifest_digest'] = child['serving_manifest_digest']
        contract['shadow_by_model'] = {name: {
            'symbols': [str(r.get('symbol') or r.get('stock_id')) for r in series[name]],
            'sequence_contract': contracts[name]} for name in sorted(sequence_names)}
        child['sequence_input_contract'] = {**contract, 'digest': checksum(contract)}
        # Run serially to bound GPU/model memory; no arbitrary candidate Top-K.
        try:
            bundle = compute(child)
            if (bundle.get('serving_manifest_digest') != child['serving_manifest_digest']
                    or bundle.get('active8_shadow_artifact_identities') != child['active8_shadow_artifact_identities']
                    or any(bundle.get(k) != parent.get(k) for k in ('run_date', 'run_id', 'state_gcs_uri'))):
                raise ValueError('paired_nav_l3_inference_identity_mismatch')
            result['bundles'][key] = {'status': 'complete', 'result': bundle}
        except Exception as exc:
            # Never copy incumbent forecasts into a failed candidate's record.
            result['bundles'][key] = {'status': 'failed', 'error_type': type(exc).__name__}
    result['status'] = 'failed' if any(r['status'] == 'failed' for r in result['bundles'].values()) else 'complete'
    return result
