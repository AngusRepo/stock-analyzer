"""Own Atomic recommendation -> original sparse/OPB, no native-account authority."""
from copy import deepcopy

from services.paired_nav_journal import digest, read_snapshot
from services.paired_nav_collection import (
    allocator_source_identity, replay_allocator_return_history, shadow_failure,
)
from services.paired_nav_atomic_recommendation import run_atomic_recommendations
from services.paired_nav_intervention import run_isolated_allocation


def allocation_economic_evidence(capture):
    """Keep all solver/OPB/admission evidence; separate the zero-authority RFS observer.

    Isolated allocation intentionally never calls the live RFS observer. Its
    unchanged formal packet remains in the parent, not claimed as recomputed.
    """
    value=deepcopy(capture)
    observer=value.get('allocation_contract',{}).get('rfs_shadow_challenger')
    if observer is not None:
        if (observer.get('production_effect') is not False or observer.get('promotion_eligible') is not False
                or observer.get('decision_role') != 'comparison_only'):
            raise ValueError('paired_nav_atomic_observer_authority_changed')
        del value['allocation_contract']['rfs_shadow_challenger']
    return value


def run_atomic_allocations(*, snapshot_id, query, prepared=None, recommendations=None):
    from services.recommendation_service import build_return_history_from_payloads
    parent = read_snapshot(query, snapshot_id)
    manifest, context = parent['manifest'], parent['payload']['content']
    if 'atomic_recommendation_inputs' in context:
        if ((prepared is not None and prepared != context['atomic_recommendation_inputs'])
                or (recommendations is not None and recommendations != context['atomic_recommendation_result'])):
            raise ValueError('paired_nav_atomic_sealed_recommendation_changed')
        prepared, recommendations = context['atomic_recommendation_inputs'], context['atomic_recommendation_result']
    if not isinstance(prepared, dict) or not isinstance(recommendations, dict):
        raise ValueError('paired_nav_atomic_sealed_recommendation_missing')
    if (manifest['snapshot_kind'] != 'allocation_context' or manifest['signal_date'] != prepared['signal_date']
            or context.get('allocator_source_identity') != allocator_source_identity()):
        raise ValueError('paired_nav_atomic_allocation_parent_invalid')
    rec_context = context['recommendation_context']
    expected = run_atomic_recommendations(prepared=prepared, formal_context=rec_context,
        source_context=rec_context['inputs']['recommendation_source_context'])
    if expected != recommendations:
        raise ValueError('paired_nav_atomic_allocation_recommendation_mismatch')
    history_context = context.get('allocator_history_context')
    history = replay_allocator_return_history(history_context, payloads=rec_context['inputs']['payloads'],
                                             signal_date=manifest['signal_date'])
    if (history != context['inputs']['return_history']
            or rec_context['expected']['recommendations'] != context['inputs']['recommendations']):
        raise ValueError('paired_nav_atomic_allocation_input_boundary_mismatch')
    inherited = context['capture'].get('inherited_state') or {}
    baseline = run_isolated_allocation(inputs=context['inputs'], inherited_state=inherited)
    if (baseline['output'] != context['formal_output']
            or digest(allocation_economic_evidence(baseline['capture'])) != digest(allocation_economic_evidence(context['capture']))):
        raise ValueError('paired_nav_atomic_allocation_incumbent_mismatch')
    definitions = {}
    formal_symbols = {p['symbol'] for p in rec_context['inputs']['payloads']}
    for key, definition in recommendations['definitions'].items():
        if definition.get('status') != 'recommendations_materialized':
            definitions[key] = deepcopy(definition)
            continue
        try:
            inputs = deepcopy(context['inputs'])
            inputs['recommendations'] = deepcopy(definition['result']['recommendations'])
            payloads = definition['inputs']['payloads']
            own_history = build_return_history_from_payloads(payloads, lookback=history_context['lookback'])
            shared = formal_symbols & {p['symbol'] for p in payloads}
            if any(own_history.get(s) != history.get(s) for s in shared):
                raise ValueError('paired_nav_atomic_shared_risk_history_changed')
            inputs['return_history'] = own_history
            result = run_isolated_allocation(inputs=inputs, inherited_state=inherited)
            from services.paired_native_models import atomic_model_context
            native_context = atomic_model_context(context=context, prepared=prepared, definition_checksum=key)
            definitions[key] = {'status': 'allocation_materialized', 'inputs': inputs, 'allocation': result,
                'native_model_context': native_context,
                'risk_history_symbols': sorted(own_history),
                'risk_history_missing_symbols': sorted({p['symbol'] for p in payloads} - set(own_history))}
        except Exception as exc:
            definitions[key] = shadow_failure('atomic_allocation', exc)
    body = {'schema_version': 'paired-nav-atomic-allocation-v1', 'signal_date': manifest['signal_date'],
        'allocation_context_snapshot_id': snapshot_id, 'allocation_context_checksum': manifest['payload_checksum'],
        'recommendation_checksum': recommendations['output_checksum'],
        'history_context_checksum': history_context['content_checksum'],
        'baseline': baseline, 'definitions': definitions,
        'baseline_economic_replay': 'PASS', 'rfs_observer_recomputed': False,
        'status': 'allocations_materialized' if all(d['status'] == 'allocation_materialized' for d in definitions.values()) else 'incomplete',
        'execution_status': 'requires_native_execution_and_ledger',
        'production_effect': False, 'promotion_allowed': False, 'can_write_order': False, 'nav_maturity_credit': 0}
    return {**body, 'output_checksum': digest(body)}
