"""Assemble each frozen entry from original completed observations and sources.

This module does not capture a live configuration, dispatch inference, or invent
historical inputs. Missing completion or different source bytes remain not ready.
"""
from copy import deepcopy
import hashlib
import json

from google.api_core.exceptions import NotFound

from services.l4_challenger_comparison import digest
from services.l4_shadow_producer import read_reference


def resolve_completed_observation(*, bucket, config_reference, identity, day):
    """Locate the existing native owner's exact immutable request/index pair."""
    from services.l4_native_observation import PREFIX
    from services.l4_forward_materialization import digest as native_digest

    config = read_reference(bucket, config_reference)
    if config.get('l3_identity') != identity:
        raise ValueError('shadow_assembly_observer_identity_mismatch')
    key = native_digest(dict(day=day, identity=identity, policy=config))
    receipts = [config_reference['sha256']]
    found = {}
    for kind, field in (('requests', 'envelope'), ('index', 'projection')):
        blob = bucket.blob(PREFIX + kind + '/' + key + '.json')
        try:
            blob.reload()
            raw = blob.download_as_bytes(if_generation_match=blob.generation)
        except NotFound as exc:
            raise ValueError('shadow_assembly_observation_not_completed') from exc
        reference = json.loads(raw)
        if (not isinstance(reference, dict) or not reference.get('path')
                or len(reference.get('sha256', '')) != 64):
            raise ValueError('shadow_assembly_observation_pointer_invalid')
        found[field] = reference
        receipts.append(hashlib.sha256(raw).hexdigest())
    # The existing completed collector validates the actual original objects,
    # full manifest, training receipts, raw bundle and projected readback.
    return dict(config=config, **found), receipts


def _payload_map(rows):
    if not isinstance(rows, list) or not rows:
        raise ValueError('shadow_assembly_payload_source_missing')
    mapped = {row['symbol']: row for row in rows}
    if len(mapped) != len(rows):
        raise ValueError('shadow_assembly_payload_source_duplicate')
    return mapped


def assemble_recommendation_inputs(*, entry, state, environment_context, day_inputs,
                                   completed_observation=False):
    """Reuse verified common source facts, with this entry's own L3/L4 inputs.

The source context is complete original evidence, not a final recommendation
list or a feature projection. Its code and nested source guards stay in force.
"""
    from services.l4_shadow_native_producer import validate_prediction_state
    from services.paired_nav_recommendation_path import replay_recommendation_context
    from services.l4_p6_bundle import is_p6

    original = environment_context.get('inputs') or {}
    options = original.get('filter_options') or {}
    day = day_inputs['signal_date']
    allocation = day_inputs['l4_allocation_inputs']
    policy = allocation['alpha_policy']['l4Distribution']
    identity = policy['artifact']['l3_identity']
    if (options.get('run_date') != day or state.get('run_date') != day
            or identity['payload_checksum'] != entry['components']['L3']
            or policy['artifact']['model_checksum'] != entry['components']['L4']
            or (options.get('alpha_policy') or {}).get('l4Distribution') is None):
        raise ValueError('shadow_assembly_day_or_chain_mismatch')
    validate_prediction_state(state, identity)
    if digest(_payload_map(original.get('payloads'))) != digest(_payload_map(state.get('payloads'))):
        raise ValueError('shadow_assembly_payload_source_changed')
    if {row['symbol'] for row in original.get('screener_recs', [])} - set(state['predictions']):
        raise ValueError('shadow_assembly_screener_prediction_missing')
    # This replays the original owner over its original inputs first. A source
    # mismatch cannot be repaired by simply stamping a fresh capture checksum.
    replay_recommendation_context(environment_context)
    config = day_inputs['trading_config']
    alpha = deepcopy(config.get('alphaFramework') or config.get('alpha_framework') or {})
    alpha['l4Distribution'] = deepcopy(config['l4Distribution'])
    actual = deepcopy(allocation['alpha_policy'])
    for value in (alpha, actual):
        value['l4Distribution'].pop('runtime', None)
    if alpha != actual:
        raise ValueError('shadow_assembly_frozen_policy_mismatch')
    inputs = deepcopy(original)
    inputs['predictions'] = deepcopy(state['predictions'])
    inputs['payloads'] = deepcopy(state['payloads'])
    runtime = policy.setdefault('runtime', {})
    runtime.update(signal_date=day, l3_identity=deepcopy(identity),
                   predictions=deepcopy(state['predictions']))
    if is_p6(policy['artifact']):
        if completed_observation:
            # Set only by the existing collector after exact raw/projection
            # comparison. Never inherit the environment's old full-pool rows.
            pool = state.get('p6_native_pool')
            if not pool:
                raise ValueError('shadow_assembly_original_native_pool_missing')
        else:
            from services.l4_p6_pipeline import project_predictions
            projected = project_predictions(
                {**state, 'trading_config': {'l4Distribution': policy}},
                state['predictions'], identity)
            pool = projected.get('p6_native_pool')
            if not pool:
                raise ValueError('shadow_assembly_original_native_pool_missing')
        runtime['p6_native_pool'] = deepcopy(pool)
    day_inputs['trading_config']['l4Distribution'] = deepcopy(policy)
    inputs['filter_options']['alpha_policy'] = deepcopy(allocation['alpha_policy'])
    # The original persona/source guards are evaluated again by fresh capture
    # with this entry's payloads. No live configuration/source resolver is used.
    return inputs
