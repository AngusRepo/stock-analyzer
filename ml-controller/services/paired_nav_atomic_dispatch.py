"""Daily Atomic L2 -> original ML engine -> original prediction merge.

This module transports candidate effects; it does not select by returns, fit a
model, allocate money, grant maturity or make a promotion decision.
"""
from copy import deepcopy
from datetime import datetime, timezone

from services.paired_nav_atomic_inputs import validate_daily_inputs
from services.paired_nav_collection import shadow_failure
from services.paired_nav_journal import digest, _timestamp
from services.state_space_series import read_frozen_sequence_inputs


def _checked(record, schema, checksum_key):
    if (not isinstance(record, dict) or record.get('schema_version') != schema
            or record.get(checksum_key) != digest({k: v for k, v in record.items() if k != checksum_key})):
        raise ValueError('paired_nav_atomic_dispatch_evidence_invalid')
    return record


def prepare_atomic_request(state, parent):
    source = validate_daily_inputs(state.get('paired_nav_atomic_inputs'), signal_date=state['run_date'],
        producer_run_id=state['screener_run_id'], formal_stocks=state['active_stocks'])
    definitions = source['population']['replacements']
    l2 = _checked(state.get('paired_nav_atomic_l2'), 'paired-nav-atomic-l2-v1', 'output_checksum')
    pre = state.get('paired_nav_atomic_pre_l2') or {}
    context = _checked(state.get('pipeline_timesfm_context'), 'pipeline-timesfm-context-v1', 'source_checksum')
    sequence = state['pipeline_sequence_observations']
    if (l2.get('status') not in {'l2_payloads_built', 'incomplete'} or l2.get('signal_date') != state['run_date']
            or pre.get('input_checksum') != source['input_checksum']
            or pre.get('source_checksum') != state['payload_source_observations']['source_checksum']
            or set(l2['slates']) != set(pre['slates']) or set(pre['slates']) != set(source['candidate_stocks'])
            or set(l2.get('holding_slates', {})) != set(source.get('holding_scopes', {}))
            or set(pre.get('holding_slates', {})) != set(source.get('holding_scopes', {}))
            or l2['formal_payload_checksum'] != digest(parent['payloads'])
            or l2['input_checksum'] != digest([pre, context, sequence,
                l2['formal_input_payload_checksum'], digest(parent['payloads'])])):
        raise ValueError('paired_nav_atomic_dispatch_l2_mismatch')
    observed_at = datetime.now(timezone.utc).isoformat()
    if _timestamp(context['observed_at']) > _timestamp(observed_at):
        raise ValueError('paired_nav_atomic_dispatch_policy_observed_late')
    series, _ = read_frozen_sequence_inputs(sequence, decision_date=state['run_date'],
        payloads=parent['payloads'], observed_before=observed_at)
    if series != parent['sequence_series']:
        raise ValueError('paired_nav_atomic_dispatch_formal_sequence_mismatch')
    slates, contrasts, unavailable, holding_evaluations = {}, [], {}, []

    def add(payloads):
        history, _ = read_frozen_sequence_inputs(sequence, decision_date=state['run_date'],
            payloads=payloads, observed_before=observed_at)
        inputs = {'symbols': [p['symbol'] for p in payloads], 'payloads': deepcopy(payloads), 'sequence_series': history}
        key = digest(inputs)
        slates[key] = inputs
        return key

    baseline_key = None
    for definition in definitions:
        key = definition['definition_checksum']
        output = l2['slates'].get(key)
        if not output or output.get('status') != 'ready':
            seed = (source.get('candidate_recommendation_seeds') or {}).get('definitions', {}).get(key)
            unavailable[key] = deepcopy(output or seed or definition['candidate'])
            continue
        try:
            native = (source.get('native_holdings') or {}).get('definitions', {}).get(key)
            if source.get('native_holdings') is not None and (not native or native['status'] != 'ready'):
                raise ValueError('paired_nav_atomic_native_holdings_unavailable')
            scopes = {scope_id: scope for scope_id, scope in source.get('holding_scopes', {}).items()
                      if scope['definition_checksum'] == key}
            for scope_id, scope in scopes.items():
                held = l2['holding_slates'][scope_id]
                if (held.get('status') != 'ready'
                        or held.get('input_payload_checksum') != digest(pre['holding_slates'][scope_id])
                        or [p['symbol'] for p in held['payloads']] != [p['symbol'] for p in scope['stocks']]):
                    raise ValueError('paired_nav_atomic_holding_l2_unavailable')
            if ([p['symbol'] for p in output['payloads']] != [p['symbol'] for p in source['candidate_stocks'][key]]
                    or output['input_payload_checksum'] != digest(pre['slates'][key])):
                raise ValueError('paired_nav_atomic_dispatch_slate_identity_mismatch')
            # The formal input was verified above. A candidate-only raw source
            # failure stays attached to that definition, not to valid peers.
            candidate_key = add(output['payloads'])
            baseline_key = baseline_key or add(parent['payloads'])
            supplementary = [{'scope_checksum': scope_id, 'definition_checksum': key, 'arm': scope['arm'],
                'reference_key': baseline_key if scope['arm'] == 'baseline' else candidate_key,
                'slate_key': add(l2['holding_slates'][scope_id]['payloads']), 'target_symbol': scope['target_symbol']}
                for scope_id, scope in scopes.items()]
            contrasts.append({'definition_checksum': key, 'baseline_key': baseline_key,
                              'candidate_key': candidate_key})
            holding_evaluations.extend(supplementary)
        except Exception as exc:
            unavailable[key] = shadow_failure('atomic_ml_slate_source', exc)
    source_checksum = digest([source['input_checksum'], l2['output_checksum'], sequence['source_checksum'],
                              context['source_checksum'], parent['serving_manifest_digest']])
    required = {r[arm+'_key'] for r in contrasts for arm in ('baseline', 'candidate')}
    required.update(r['slate_key'] for r in holding_evaluations)
    slates = {k:v for k,v in slates.items() if k in required}
    packet = {'schema_version': 'paired-nav-atomic-slates-v2', 'signal_date': state['run_date'],
              'source_checksum': source_checksum, 'slates': slates, 'contrasts': contrasts}
    if holding_evaluations:
        packet['holding_evaluations'] = holding_evaluations
    request = {**packet, 'packet_checksum': digest(packet)} if contrasts else None
    body = {'schema_version': 'paired-nav-atomic-dispatch-v1', 'signal_date': state['run_date'],
        'status': 'prepared' if request else 'no_materialized_inference', 'request': request,
        'source_checksum': source_checksum, 'serving_manifest_digest': parent['serving_manifest_digest'],
        'definition_checksums': [d['definition_checksum'] for d in definitions], 'unavailable': unavailable,
        'production_effect': False, 'promotion_allowed': False, 'nav_maturity_credit': 0}
    dispatch = {**body, 'dispatch_checksum': digest(body)}
    saved = state.get('paired_nav_atomic_dispatch')
    if saved and saved.get('request') is not None:
        _checked(saved, 'paired-nav-atomic-dispatch-v1', 'dispatch_checksum')
        if saved != dispatch:
            raise ValueError('paired_nav_atomic_dispatch_frozen_request_changed')
    return dispatch


def _child_contract(parent_contract, inputs):
    """Recompute expected membership from frozen inputs, not returned counts."""
    core = deepcopy({k: v for k, v in parent_contract.items() if k != 'digest'})
    history = {r['symbol']: r for r in inputs['sequence_series']}
    core['sequence_point_counts'] = {s: len(history[s]['prices']) if s in history else None for s in inputs['symbols']}
    for group in ('by_model', 'shadow_by_model'):
        for entry in core[group].values():
            points = entry['sequence_contract'].get('seq_len')
            if type(points) is not int or points <= 0:
                raise ValueError('paired_nav_atomic_dispatch_sequence_contract_invalid')
            entry['symbols'] = [s for s in inputs['symbols'] if s in history and len(history[s]['prices']) >= points]
    return {**core, 'digest': digest(core)}


async def consume_atomic_results(state, formal_result, *, validate, merge):
    dispatch = _checked(state.get('paired_nav_atomic_dispatch'), 'paired-nav-atomic-dispatch-v1', 'dispatch_checksum')
    packet = dispatch['request']
    if packet is not None:
        packet = _checked(packet, 'paired-nav-atomic-slates-v2', 'packet_checksum')
    context = state['pipeline_modal_serving_context']
    if (dispatch['signal_date'] != state['run_date']
            or dispatch['serving_manifest_digest'] != context['serving_manifest_digest']):
        raise ValueError('paired_nav_atomic_callback_context_mismatch')
    parent = state['modal_prediction_bundle']
    frozen_formal_series, _ = read_frozen_sequence_inputs(state['pipeline_sequence_observations'],
        decision_date=state['run_date'], payloads=state['payloads'])
    expected_dispatch = prepare_atomic_request(state, {'payloads': state['payloads'],
        'sequence_series': frozen_formal_series, 'serving_manifest_digest': context['serving_manifest_digest']})
    if expected_dispatch != dispatch:
        raise ValueError('paired_nav_atomic_callback_dispatch_source_changed')
    if packet is None:
        body = {'schema_version': 'paired-nav-atomic-ml-v1', 'signal_date': state['run_date'],
            'dispatch_checksum': dispatch['dispatch_checksum'], 'slates': {},
            'definitions': {k: {'status': 'unavailable', 'evidence': deepcopy(v)} for k, v in dispatch['unavailable'].items()},
            'status': 'incomplete', 'reason': 'paired_nav_atomic_no_materialized_inference',
            'production_effect': False, 'promotion_allowed': False, 'nav_maturity_credit': 0}
        return {**body, 'output_checksum': digest(body)}
    response = parent.get('paired_nav_atomic_inference') or {}
    if (response.get('schema_version') != 'paired-nav-atomic-inference-v2'
            or response.get('request_checksum') != packet['packet_checksum']
            or response.get('source_checksum') != packet['source_checksum']
            or response.get('contrasts') != packet['contrasts']
            or response.get('holding_evaluations', []) != packet.get('holding_evaluations', [])
            or response.get('production_effect') is not False or response.get('promotion_allowed') is not False
            or type(response.get('nav_maturity_credit')) is not int or response['nav_maturity_credit'] != 0
            or response.get('status') not in {'complete', 'failed'}
            or not isinstance(response.get('slates'), dict)
            or not set(response['slates']) <= set(packet['slates'])):
        raise ValueError('paired_nav_atomic_callback_inference_missing_or_mismatched')
    outputs = {}
    formal_inputs = {'symbols': [p['symbol'] for p in state['payloads']], 'payloads': state['payloads'],
                     'sequence_series': frozen_formal_series}
    formal_key = digest(formal_inputs)
    for key, inputs in packet['slates'].items():
        try:
            if key != digest(inputs):
                raise ValueError('paired_nav_atomic_callback_inputs_changed')
            record = response['slates'].get(key) or {}
            if not inputs['symbols']:
                if record != {'status': 'empty_universe', 'symbols': []}:
                    raise ValueError('paired_nav_atomic_callback_empty_slate_invalid')
                outputs[key] = {'status': 'ready', 'predictions': {}, 'input_checksum': key}
                continue
            if record.get('status') != 'complete' or record.get('symbols') != inputs['symbols']:
                raise ValueError('paired_nav_atomic_callback_slate_incomplete')
            bundle = record.get('result') or {}
            if (any(bundle.get(k) != parent.get(k) for k in ('run_id', 'run_date', 'state_gcs_uri'))
                    or bundle.get('n_input') != len(inputs['symbols'])):
                raise ValueError('paired_nav_atomic_callback_run_identity_mismatch')
            child = {'run_date': state['run_date'], 'producer_run_id': state['producer_run_id'],
                'payloads': deepcopy(inputs['payloads']), 'l3_payloads': deepcopy(inputs['payloads']),
                'pipeline_modal_serving_context': deepcopy(context), 'modal_prediction_bundle': deepcopy(bundle),
                'pipeline_modal_sequence_input_contract': _child_contract(state['pipeline_modal_sequence_input_contract'], inputs)}
            validate(child, bundle)
            if key == formal_key:
                for field in ('predict_batch_v2_results', 'gnn_graphsage_raw', 'dlinear_raw', 'patchtst_raw',
                              'itransformer_raw', 'active8_sequence_shadow_raw'):
                    if bundle.get(field) != parent.get(field):
                        raise ValueError('paired_nav_atomic_callback_formal_result_changed')
                merged = formal_result
            else:
                merged = await merge(child)
            predictions = merged.get('predictions')
            if not isinstance(predictions, dict) or set(predictions) != set(inputs['symbols']):
                raise ValueError('paired_nav_atomic_callback_prediction_coverage_missing')
            outputs[key] = {'status': 'ready', 'predictions': deepcopy(predictions), 'input_checksum': key}
        except Exception as exc:
            outputs[key] = shadow_failure('atomic_ml_slate', exc)
    definitions = {k: {'status': 'unavailable', 'evidence': deepcopy(v)} for k, v in dispatch['unavailable'].items()}
    for item in packet['contrasts']:
        ready = all(outputs[item[arm + '_key']]['status'] == 'ready' for arm in ('baseline', 'candidate'))
        ready = ready and all(outputs[h['slate_key']]['status'] == 'ready'
            for h in packet.get('holding_evaluations', []) if h['definition_checksum'] == item['definition_checksum'])
        definitions[item['definition_checksum']] = {**item, 'status': 'ready' if ready else 'incomplete'}
    body = {'schema_version': 'paired-nav-atomic-ml-v1', 'signal_date': state['run_date'],
        'dispatch_checksum': dispatch['dispatch_checksum'], 'slates': outputs, 'definitions': definitions,
        'holding_evaluations': deepcopy(packet.get('holding_evaluations', [])),
        'status': 'ml_predictions_materialized' if all(r['status'] == 'ready' for r in definitions.values()) else 'incomplete',
        'production_effect': False, 'promotion_allowed': False, 'nav_maturity_credit': 0}
    return {**body, 'output_checksum': digest(body)}
