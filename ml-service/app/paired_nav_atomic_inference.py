"""Compute each frozen Atomic slate with the original serving model engine.

Share only IDENTICAL complete frozen inputs, not per-symbol union payloads or
graph/rank predictions across different stock universes. This module has no I/O
or promotion/accounting authority. The upstream
producer must seal complete post-overlay/L2 inputs; a breadth-only source is not
accepted as a substitute for the formal baseline slate.
"""
from copy import deepcopy
import math
import re

from app.paired_nav_inference import checksum

ATOMIC_RESULT_SCHEMA = 'paired-nav-atomic-inference-v2'
# An Atomic intervention changes strategy admission/derived slate features,
# not the underlying market observations, stock identity or model policy.
_SHARED_SOURCE_FIELDS = ('stock_id', 'prices', 'indicators', 'chips', 'sentiment_scores',
    'real_accuracies', 'model_stats', 'market', 'market_env', 'adaptive_params',
    'trading_config', 'lifecycle_weights', 'barrier_params', 'horizon')


def atomic_inference_failure(exc):
    code = str(exc).split(':', 1)[0]
    return {'status': 'failed', 'error_type': type(exc).__name__,
            **({'error_code': code} if re.fullmatch(r'(atomic_inference|pipeline_modal)_[a-z_]+', code) else {})}


def _symbols(rows):
    if not isinstance(rows, list):
        raise ValueError('atomic_inference_rows_missing')
    symbols = [row.get('symbol') if isinstance(row, dict) else None for row in rows]
    if (any(not isinstance(s, str) or not s or s != s.strip() for s in symbols)
            or len(set(symbols)) != len(symbols)):
        raise ValueError('atomic_inference_symbols_invalid')
    return symbols


def _slate(value):
    if not isinstance(value, dict) or set(value) != {'symbols', 'payloads', 'sequence_series'}:
        raise ValueError('atomic_inference_slate_inputs_missing')
    symbols = _symbols(value['payloads'])
    if not isinstance(value['symbols'], list) or value['symbols'] != symbols:
        raise ValueError('atomic_inference_slate_payload_coverage_invalid')
    if not set(_symbols(value['sequence_series'])) <= set(symbols):
        raise ValueError('atomic_inference_sequence_universe_invalid')
    if any(not isinstance(row.get('prices'), list) or any(type(price) not in (int, float)
            or not math.isfinite(price) for price in row['prices']) for row in value['sequence_series']):
        raise ValueError('atomic_inference_sequence_values_invalid')
    return symbols


def _series_for(contracts, source, symbols):
    if not isinstance(contracts, dict):
        raise ValueError('atomic_inference_sequence_contract_invalid')
    result = {}
    for name, contract in contracts.items():
        points = contract.get('seq_len') if isinstance(contract, dict) else None
        if type(points) is not int or points <= 0:
            raise ValueError('atomic_inference_sequence_contract_invalid')
        result[name] = [deepcopy(source[s]) for s in symbols if s in source
                       and isinstance(source[s].get('prices'), list)
                       and len(source[s]['prices']) >= points]
    return result


def _child(parent, packet, inputs):
    replaced = {'paired_nav_atomic_slates', 'paired_nav_l3_requests', 'callback_url', 'callback_token',
                'payloads', 'sequence_series', 'sequence_model_series_by_model',
                'active8_shadow_sequence_series_by_model', 'sequence_dataset_meta'}
    child = deepcopy({k: v for k, v in parent.items() if k not in replaced})
    symbols = _symbols(inputs['payloads'])
    source = {row['symbol']: row for row in inputs['sequence_series']}
    child['payloads'] = deepcopy(inputs['payloads'])
    child['sequence_series'] = deepcopy(inputs['sequence_series'])
    for field, contracts in (('sequence_model_series_by_model', 'sequence_model_contracts'),
                             ('active8_shadow_sequence_series_by_model', 'active8_shadow_sequence_contracts')):
        child[field] = _series_for(parent.get(contracts) or {}, source, symbols)
    contract = deepcopy(parent['sequence_input_contract'])
    contract.pop('digest', None)
    if 'sequence_point_counts' in contract:
        contract['sequence_point_counts'] = {
            s: (len(source[s]['prices']) if isinstance(source[s].get('prices'), list) else 0)
            if s in source else None for s in symbols}
    for key, field, configs in (('by_model', 'sequence_model_series_by_model', 'sequence_model_contracts'),
                                ('shadow_by_model', 'active8_shadow_sequence_series_by_model', 'active8_shadow_sequence_contracts')):
        contract[key] = {name: {'symbols': _symbols(rows), 'sequence_contract': parent[configs][name]}
                         for name, rows in child[field].items()}
    child['sequence_input_contract'] = {**contract, 'digest': checksum(contract)}
    child['sequence_dataset_meta'] = {'source': 'atomic_frozen_slate_inputs',
        'source_checksum': packet['packet_checksum'], 'slate_input_checksum': checksum(inputs), 'symbols': symbols}
    return child


def _validate_result(child, bundle):
    if (not isinstance(bundle, dict) or bundle.get('schema_version') != 'pipeline-modal-prediction-bundle-v1'
            or any(bundle.get(k) != child.get(k) for k in ('run_date', 'run_id', 'state_gcs_uri',
                'serving_manifest_digest', 'slot_artifact_identities', 'active_artifact_identities',
                'active8_shadow_artifact_identities', 'sequence_input_contract', 'serving_coverage'))
            or bundle.get('n_input') != len(child['payloads'])
            or bundle.get('modal_source_sha') != child.get('expected_source_sha')):
        raise ValueError('atomic_inference_result_identity_invalid')
    rows = bundle.get('predict_batch_v2_results')
    if (set(_symbols(rows)) != set(_symbols(child['payloads']))
            or any(row.get('error') for row in rows)):
        raise ValueError('atomic_inference_result_coverage_invalid')


def run_atomic_slates(parent, *, compute, formal_bundle):
    raw = parent.get('paired_nav_atomic_slates')
    if raw is None:
        return None
    packet = deepcopy(raw)
    # The previous local-only prototype cannot prove candidate-specific peer
    # features/eligibility. Do not reinterpret its union as verified slate data.
    if isinstance(packet, dict) and packet.get('schema_version') == 'paired-nav-atomic-slates-v1':
        raise ValueError('atomic_inference_legacy_union_requires_per_slate_inputs')
    fields = {'schema_version', 'signal_date', 'source_checksum', 'slates', 'contrasts', 'packet_checksum'}
    if isinstance(packet, dict) and 'holding_evaluations' in packet:
        fields.add('holding_evaluations')
    if (not isinstance(packet, dict) or set(packet) != fields
            or packet.get('schema_version') != 'paired-nav-atomic-slates-v2'
            or packet.get('signal_date') != parent.get('run_date')
            or not re.fullmatch('[a-f0-9]{64}', str(packet.get('source_checksum')))
            or checksum({k: v for k, v in packet.items() if k != 'packet_checksum'}) != packet['packet_checksum']):
        raise ValueError('atomic_inference_packet_invalid')
    parent_symbols = _symbols(parent['payloads'])
    parent_series = parent.get('sequence_series') or []
    _symbols(parent_series)
    formal_inputs = {'symbols': parent_symbols, 'payloads': parent['payloads'], 'sequence_series': parent_series}
    formal_key = checksum(formal_inputs)
    if not isinstance(packet['slates'], dict):
        raise ValueError('atomic_inference_slates_missing')
    raw_by_symbol, history_by_symbol = {}, {}
    for key, inputs in packet['slates'].items():
        _slate(inputs)
        if key != checksum(inputs):
            raise ValueError('atomic_inference_slate_input_checksum_mismatch')
        history = {row['symbol']: row for row in inputs['sequence_series']}
        for row in inputs['payloads']:
            symbol = row['symbol']
            raw_source = {field: row[field] for field in _SHARED_SOURCE_FIELDS if field in row}
            if symbol in raw_by_symbol and raw_by_symbol[symbol] != raw_source:
                raise ValueError('atomic_inference_shared_raw_source_changed')
            if symbol in history_by_symbol and history_by_symbol[symbol] != history.get(symbol):
                raise ValueError('atomic_inference_shared_history_changed')
            raw_by_symbol[symbol] = raw_source
            history_by_symbol[symbol] = history.get(symbol)
    if not isinstance(packet['contrasts'], list):
        raise ValueError('atomic_inference_contrasts_missing')
    required, definitions, contrasts = set(), set(), []
    for item in packet['contrasts']:
        if (not isinstance(item, dict) or set(item) != {'definition_checksum', 'baseline_key', 'candidate_key'}
                or not re.fullmatch('[a-f0-9]{64}', str(item.get('definition_checksum')))
                or item['definition_checksum'] in definitions):
            raise ValueError('atomic_inference_contrast_identity_invalid')
        definitions.add(item['definition_checksum'])
        # Exact post-L2 baseline, not just equal symbols or pre-Core breadth.
        if item['baseline_key'] != formal_key:
            raise ValueError('atomic_inference_formal_seed_mismatch')
        for arm in ('baseline', 'candidate'):
            key = item[arm + '_key']
            if not isinstance(key, str) or key not in packet['slates']:
                raise ValueError('atomic_inference_referenced_slate_missing')
            required.add(key)
        contrasts.append(deepcopy(item))
    holding_evaluations = packet.get('holding_evaluations', [])
    if not isinstance(holding_evaluations, list):
        raise ValueError('atomic_inference_holding_scopes_invalid')
    by_definition = {r['definition_checksum']: r for r in contrasts}
    scope_ids, scope_targets = set(), set()
    for item in holding_evaluations:
        if (not isinstance(item, dict) or set(item) != {'scope_checksum', 'definition_checksum', 'arm',
                'reference_key', 'slate_key', 'target_symbol'}
                or not re.fullmatch('[a-f0-9]{64}', str(item.get('scope_checksum')))
                or item['scope_checksum'] in scope_ids or item.get('arm') not in {'baseline','candidate'}
                or item.get('definition_checksum') not in by_definition
                or item.get('reference_key') != by_definition[item['definition_checksum']][item['arm'] + '_key']
                or item.get('slate_key') not in packet['slates']):
            raise ValueError('atomic_inference_holding_scope_identity_invalid')
        target = item.get('target_symbol')
        identity = (item['definition_checksum'], item['arm'], target)
        reference_symbols = packet['slates'][item['reference_key']]['symbols']
        if (not isinstance(target, str) or not target.strip() or target != target.strip()
                or identity in scope_targets or target in reference_symbols
                or set(packet['slates'][item['slate_key']]['symbols']) != set(reference_symbols) | {target}):
            raise ValueError('atomic_inference_holding_target_invalid')
        scope_ids.add(item['scope_checksum'])
        scope_targets.add(identity)
        required.add(item['slate_key'])
    if required != set(packet['slates']):
        raise ValueError('atomic_inference_full_payload_coverage_invalid')
    contract = parent.get('sequence_input_contract')
    if (not isinstance(contract, dict)
            or contract.get('digest') != checksum({k: v for k, v in contract.items() if k != 'digest'})
            or contract.get('serving_manifest_digest') != parent.get('serving_manifest_digest')):
        raise ValueError('atomic_inference_parent_sequence_contract_invalid')
    # Verify the baseline history contracts before any candidate compute. One
    # stored slate may serve multiple definitions only if ALL inputs are equal.
    formal_child = _child(parent, packet, formal_inputs)
    if any(formal_child[field] != parent.get(field, {}) for field in ('sequence_input_contract',
            'sequence_model_series_by_model', 'active8_shadow_sequence_series_by_model')):
        raise ValueError('atomic_inference_formal_sequence_contract_mismatch')
    del formal_child
    result = {'schema_version': ATOMIC_RESULT_SCHEMA, 'request_checksum': packet['packet_checksum'],
        'source_checksum': packet['source_checksum'], 'contrasts': contrasts, 'slates': {},
        'production_effect': False, 'nav_maturity_credit': 0, 'promotion_allowed': False}
    if 'holding_evaluations' in packet:
        result['holding_evaluations'] = deepcopy(holding_evaluations)
    for key, inputs in packet['slates'].items():
        try:
            child = _child(parent, packet, inputs)
            if not child['payloads']:
                # An explicitly empty slate is NOT a batch of zero forecasts.
                result['slates'][key] = {'status': 'empty_universe', 'symbols': []}
                continue
            reused = child['payloads'] == parent['payloads'] and child['sequence_series'] == parent_series
            bundle = deepcopy({k: v for k, v in formal_bundle.items() if not k.startswith('paired_nav_')}) if reused else compute(child)
            _validate_result(child, bundle)
            result['slates'][key] = {'status': 'complete', 'symbols': _symbols(child['payloads']),
                                     'reused_formal': reused, 'result': bundle}
        except Exception as exc:
            result['slates'][key] = atomic_inference_failure(exc)
    result['status'] = 'failed' if any(x['status'] == 'failed' for x in result['slates'].values()) else 'complete'
    return result
