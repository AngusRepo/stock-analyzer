"""The same pre-allocation recommendation path for serving and isolated replay.

Capture precedes SELL filtering and L4 materialization. A downstream pick list
cannot recover symbols which a different L3 ensemble would have admitted.
This module does not train models, grant model authority, or publish NAV credit.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path

from services.paired_nav_journal import digest, encode, read_snapshot


def recommendation_source_identity() -> dict[str, str]:
    base = Path(__file__).parent
    return {name: hashlib.sha256((base / name).read_bytes()).hexdigest() for name in (
        'paired_nav_recommendation_path.py', 'paired_nav_l3_candidate.py', 'paired_nav_l3_dispatch.py', 'recommendation_service.py',
        'ensemble_v2.py', 'alpha_framework.py', 'l4_alpha_ev_producer.py',
        'allocator_ev_fusion.py', 'expected_return_numeric.py', 'persona_service.py',
        'pipeline_persona_context.py', 'paired_nav_atomic_personas.py',
        'screener_seed_domain_merge.py', 'screener_seed_domain_shadow.py',
        'recommendation_source_context.py', 'paired_nav_atomic_recommendation.py',
        'paired_nav_atomic_policy.py', 'paired_nav_atomic_allocation.py', 'paired_nav_atomic_candidate.py',
        'fundamental_quality.py', 'pit_sector_alpha.py', 'sector_flow_pit_history.py')}


def verify_screener_recommendation_source(inputs: dict) -> None:
    evidence = inputs.get('recommendation_source_context')
    if evidence is not None:
        from services.recommendation_source_context import replay_recommendation_sources
        replayed = replay_recommendation_sources(evidence)
        if (replayed['inputs']['run_date'] != inputs['filter_options']['run_date']
                or replayed['inputs']['formal_recs'] != inputs['screener_recs']
                or any(replayed['formal'][field] != inputs['filter_options'].get(field) for field in (
                    'fundamental_quality_by_symbol', 'pit_sector_alpha_by_symbol'))):
            raise ValueError('paired_nav_recommendation_evidence_boundary_mismatch')
    context = inputs.get('screener_seed_context')
    if context is None:
        return  # Legacy captures are not upgraded to new source/PIT evidence.
    from services.screener_seed_domain_merge import replay_screener_seed_context
    original = replay_screener_seed_context(context, run_date=inputs['filter_options']['run_date'])
    if digest(original) != digest(inputs['screener_recs']):
        raise ValueError('paired_nav_screener_recommendation_boundary_mismatch')


def run_recommendation_path(*, inputs: dict, filter_rows=None, enrich_l2=None,
                            enrich_core=None) -> dict:
    """Run original functions exactly once, preserving their mutation semantics."""
    from services import recommendation_service as service
    if inputs.get('persona_context') is not None:
        from services.pipeline_persona_context import compute_payload_personas
        _, computed = compute_payload_personas(payloads=inputs['payloads'],
            run_date=inputs['filter_options']['run_date'], context=inputs['persona_context'],
            allow_unavailable_sentiment=True)
        if computed['opinions'] != inputs['filter_options'].get('persona_opinions', {}):
            raise ValueError('paired_nav_persona_recommendation_boundary_mismatch')
    predictions = inputs['predictions']
    rows, sell_count, diagnostics = (filter_rows or service.filter_and_score_recommendations)(
        inputs['screener_recs'], predictions, inputs['payloads'],
        **inputs['filter_options'], include_filtered_diagnostics=True)
    rows = (enrich_l2 or service.apply_l2_timesfm_evidence)(
        rows, predictions, l2_summary=inputs['l2_summary'])
    layer2_symbols = [str(row['symbol']) for row in rows if row.get('symbol')]
    # The original resolver returns input_count. This is evidence coverage,
    # not a Top-K limit, and must be recomputed for EACH arm's actual slate.
    target_size = len(rows)
    rows = (enrich_core or service.apply_core_family_evidence)(
        rows, predictions, target_size=target_size,
        require_lifecycle_weights=True, require_complete_active_models=True)
    return {'recommendations': rows, 'sell_count': sell_count,
            'filter_stage_diagnostics': diagnostics, 'layer2_symbols': layer2_symbols,
            'layer2_count': target_size, 'core_family_target_size': target_size}


def run_and_capture_recommendation_path(*, inputs: dict, candidate_reader=None, **functions) -> tuple[dict, dict]:
    from services.paired_nav_collection import shadow_failure
    failure, selection = None, None
    try:
        verify_screener_recommendation_source(inputs)
        before = json.loads(encode(inputs))
    except Exception as exc:
        failure = shadow_failure('recommendation_context_inputs', exc)
    if candidate_reader is not None:
        try:
            selection = json.loads(encode(candidate_reader()))
        except Exception as exc:
            # An independent L3 challenger failure cannot discard the verified
            # incumbent context used by Atomic/L4/fusion. Retain its failure;
            # never reinterpret it as zero candidates or refresh latest state.
            selection = shadow_failure('l3_candidate_selection', exc)
    # A real recommendation failure must propagate, not be retried or hidden.
    result = run_recommendation_path(inputs=inputs, **functions)
    if failure is not None:
        return result, failure
    try:
        expected = json.loads(encode(result))
        post_predictions = json.loads(encode(inputs['predictions']))
        packet = {'status': 'recommendation_context_captured',
                  'schema_version': 'paired-nav-recommendation-context-v1',
                  'source_identity': recommendation_source_identity(),
                  'inputs': before, 'expected': expected,
                  'post_predictions': post_predictions}
        if selection is not None:
            packet['l3_candidate_selection'] = selection
        packet['content_checksum'] = digest(packet)
        return result, packet
    except Exception as exc:
        return result, shadow_failure('recommendation_context_outputs', exc)


def replay_recommendation_context(context: dict) -> dict:
    """Recompute the incumbent before permitting any different-model contrast."""
    if (context.get('status') != 'recommendation_context_captured'
            or context.get('schema_version') != 'paired-nav-recommendation-context-v1'
            or digest({k: v for k, v in context.items() if k != 'content_checksum'})
            != context.get('content_checksum')):
        raise ValueError('paired_nav_recommendation_context_invalid')
    if context['source_identity'] != recommendation_source_identity():
        raise ValueError('paired_nav_recommendation_source_changed')
    inputs = deepcopy(context['inputs'])
    verify_screener_recommendation_source(inputs)
    result = run_recommendation_path(inputs=inputs)
    if (digest(result) != digest(context['expected'])
            or digest(inputs['predictions']) != digest(context['post_predictions'])):
        raise ValueError('paired_nav_incumbent_recommendation_replay_mismatch')
    return result


def replay_frozen_recommendation_allocation(*, snapshot_id: str, query) -> dict:
    """Verify sealed pre-filter inputs through the actual isolated sparse/OPB."""
    from services.paired_nav_collection import allocator_source_identity
    from services.paired_nav_intervention import run_isolated_allocation
    saved = read_snapshot(query, snapshot_id)
    packet = saved['payload']['content']
    if saved['manifest']['snapshot_kind'] != 'allocation_context':
        raise ValueError('paired_nav_allocation_context_required')
    context = packet.get('recommendation_context')
    if not isinstance(context, dict):
        raise ValueError('paired_nav_pre_filter_context_missing')
    if context.get('inputs', {}).get('filter_options', {}).get('run_date') != saved['manifest']['signal_date']:
        raise ValueError('paired_nav_recommendation_signal_date_mismatch')
    if packet.get('allocator_source_identity') != allocator_source_identity():
        raise ValueError('paired_nav_allocator_source_changed')
    result = replay_recommendation_context(context)
    # No reconstruction from final picks, no changed seed/signal/config owner.
    allocation_inputs = deepcopy(packet['inputs'])
    if digest(result['recommendations']) != digest(allocation_inputs['recommendations']):
        raise ValueError('paired_nav_recommendation_allocation_boundary_mismatch')
    allocation_inputs['recommendations'] = result['recommendations']
    replay = run_isolated_allocation(inputs=allocation_inputs,
        inherited_state=packet['capture'].get('inherited_state') or {})
    if replay['output'] != packet['formal_output']:
        raise ValueError('paired_nav_incumbent_allocation_replay_mismatch')
    return {'snapshot_id': snapshot_id, 'recommendation_allocation_replay': 'PASS',
            'allocation': replay, 'production_effect': False, 'promotion_allowed': False,
            'nav_maturity_credit': 0, 'execution_parity_decision': 'NOT_EVALUATED'}
