"""Candidate-owned persona inputs after the original daily ML callback."""
from copy import deepcopy

from services.paired_nav_atomic_dispatch import _checked, prepare_atomic_request
from services.paired_nav_atomic_inputs import validate_daily_inputs
from services.paired_nav_journal import digest
from services.pipeline_slate_artifacts import load_readonly, load_fields, keep, load_inputs, is_ref, content_digest, verified_preparation
from services.pipeline_persona_context import persona_inputs, compute_payload_personas
from services.state_space_series import read_frozen_sequence_inputs


def atomic_persona_slates(state):
    keys = ('run_date', 'screener_run_id', 'active_stocks', 'paired_nav_atomic_inputs',
            'paired_nav_atomic_dispatch', 'paired_nav_atomic_ml', 'paired_nav_atomic_l2',
            'paired_nav_atomic_pre_l2', 'pipeline_timesfm_context', 'pipeline_sequence_observations',
            'payloads', 'pipeline_slate_scope', 'pipeline_shared_payload_ref')
    identity = ['atomic-persona-slates', {k: state.get(k) for k in keys},
                (state.get('payload_source_observations') or {}).get('source_checksum'),
                state['pipeline_modal_serving_context']['serving_manifest_digest']]
    return verified_preparation(identity, lambda: _atomic_persona_slates(state))


def _atomic_persona_slates(state):
    source = validate_daily_inputs(state.get('paired_nav_atomic_inputs'), signal_date=state['run_date'],
        producer_run_id=state['screener_run_id'], formal_stocks=state['active_stocks'], readonly=True)
    dispatch = _checked(state.get('paired_nav_atomic_dispatch'), 'paired-nav-atomic-dispatch-v1', 'dispatch_checksum')
    ml = _checked(state.get('paired_nav_atomic_ml'), 'paired-nav-atomic-ml-v1', 'output_checksum')
    series, _ = read_frozen_sequence_inputs(state['pipeline_sequence_observations'],
        decision_date=state['run_date'], payloads=state['payloads'], include_metadata=False)
    expected = prepare_atomic_request(state, {'payloads': state['payloads'], 'sequence_series': series,
        'serving_manifest_digest': state['pipeline_modal_serving_context']['serving_manifest_digest']})
    if (expected != dispatch or ml.get('dispatch_checksum') != dispatch['dispatch_checksum']
            or ml.get('signal_date') != state['run_date']
            or set(ml['definitions']) != {r['definition_checksum'] for r in source['population']['replacements']}):
        raise ValueError('paired_nav_atomic_persona_upstream_mismatch')
    packet = dispatch.get('request') or {}
    contrasts = {r['definition_checksum']: r for r in packet.get('contrasts', [])}
    slates, unavailable = {}, {}
    formal_raw = persona_inputs(state['payloads'])
    for key, definition in ml['definitions'].items():
        if definition.get('status') != 'ready':
            unavailable[key] = deepcopy(definition)
            continue
        contrast = contrasts.get(key)
        if not contrast or any(definition.get(k) != contrast[k] for k in contrast):
            raise ValueError('paired_nav_atomic_persona_definition_mismatch')
        candidate_key = contrast['candidate_key']
        inputs = load_inputs(packet['slates'][candidate_key], state.get('pipeline_slate_scope'), readonly=True)
        output = ml['slates'][candidate_key]
        if (digest(inputs) != candidate_key or output.get('input_checksum') != candidate_key
                or output.get('status') != 'ready' or set(output['predictions']) != set(inputs['symbols'])):
            raise ValueError('paired_nav_atomic_persona_prediction_mismatch')
        raw = persona_inputs(inputs['payloads'])
        if any(formal_raw[s] != raw[s] for s in set(raw) & set(formal_raw)):
            raise ValueError('paired_nav_atomic_persona_shared_raw_changed')
        # The request already owns this immutable payload object. Retain its
        # verified reference instead of re-encoding all histories for personas.
        original = load_readonly(packet['slates'][candidate_key], state.get('pipeline_slate_scope'))['payloads']
        slates[key] = original if is_ref(original) else keep(inputs['payloads'], state)
        inputs = raw = None
    return {'slates': slates, 'unavailable': unavailable, 'input_checksum': digest([
        source['input_checksum'], dispatch['dispatch_checksum'], ml['output_checksum']])}


def compute_atomic_personas(*, prepared, run_date, context):
    return verified_preparation(['atomic-personas', prepared, run_date, context],
        lambda: _compute_atomic_personas(prepared=prepared, run_date=run_date, context=context))


def _compute_atomic_personas(*, prepared, run_date, context):
    definitions = {k: {'status': 'unavailable', 'evidence': deepcopy(v)}
                   for k, v in prepared['unavailable'].items()}
    cache = {}
    for key, reference in prepared['slates'].items():
        payloads = load_fields(reference, ('symbol', 'chips'))
        identity = digest(persona_inputs(payloads))
        if identity not in cache:
            _, cache[identity] = compute_payload_personas(payloads=payloads, run_date=run_date, context=context)
        result = deepcopy(cache[identity])
        definitions[key] = {**result, 'status': 'ready' if not result['errors'] else 'incomplete',
            'payload_checksum': content_digest(reference)}
        payloads = None
    body = {'schema_version': 'paired-nav-atomic-personas-v1', 'signal_date': run_date,
        'input_checksum': prepared['input_checksum'], 'context_checksum': context['source_checksum'],
        'definitions': definitions,
        'status': 'personas_materialized' if all(r['status'] == 'ready' for r in definitions.values()) else 'incomplete',
        'production_effect': False, 'promotion_allowed': False, 'nav_maturity_credit': 0}
    return {**body, 'output_checksum': digest(body)}
