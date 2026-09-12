"""Sealed original Atomic allocations -> existing native candidate lifecycle."""
from copy import deepcopy

from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot, _timestamp
from services.paired_nav_atomic_policy import validate_atomic_policy

OWNER = 'atomic_strategy'


def _configuration(saved, policy):
    from services.paired_nav_candidate_collection import allocation_policy_identity
    from services.paired_nav_execution_environment import configuration_environment
    context = saved['payload']['content']
    return {**{key: deepcopy(context[key]) for key in ('trading_config', 'risk_config', 'allocator_source_identity')},
        'formal_baseline_identity': deepcopy(context['formal_baseline_identity']),
        'allocator_policies': allocation_policy_identity(context['inputs']),
        'atomic_policy_identity': deepcopy(policy['context']['identity']),
        'recommendation_source_identity': deepcopy(context['recommendation_context']['source_identity']),
        **configuration_environment(saved)}


def collect_atomic_allocations(*, snapshot_id, query, writer):
    from services.paired_nav_atomic_allocation import run_atomic_allocations
    from services.paired_nav_lifecycle import resolve_pair_id, prepare_comparison_transitions
    saved = read_snapshot(query, snapshot_id)
    manifest, context = saved['manifest'], saved['payload']['content']
    empty = {'plans': [], 'lifecycle_transition_plan': [], 'production_effect': False,
             'promotion_allowed': False, 'nav_maturity_credit': 0}
    if manifest['snapshot_kind'] != 'allocation_context':
        raise ValueError('paired_nav_atomic_allocation_parent_invalid')
    prepared = context.get('atomic_recommendation_inputs')
    if prepared is None:
        return {**empty, 'status': 'legacy_context_without_atomic_inputs'}
    if manifest['prospective'] != 1:
        return {**empty, 'status': 'historical_not_prospective'}
    if not prepared['definitions']:
        return {**empty, 'status': 'no_structural_candidates'}
    if not prepared.get('policy_population', {}).get('policy_context'):
        return {**empty, 'status': 'unavailable_legacy_atomic_policy'}
    policy = validate_atomic_policy(prepared['policy_population'])
    if set(policy['definitions']) != set(prepared['definitions']):
        raise ValueError('paired_nav_atomic_policy_population_changed')
    output = run_atomic_allocations(snapshot_id=snapshot_id, query=query)
    configuration = _configuration(saved, policy)
    config_checksum, baseline_checksum = digest(configuration), policy['context']['policy_checksum']
    plans, unavailable = [], {}
    for key, definition in output['definitions'].items():
        if definition.get('status') != 'allocation_materialized':
            unavailable[key] = deepcopy(definition)
            continue
        root_pair_id = digest([OWNER, key, baseline_checksum, config_checksum])
        pair_id = resolve_pair_id(root_pair_id, signal_date=manifest['signal_date'], query=query)
        native = definition['native_model_context']
        fields = {name: deepcopy(native[name]) for name in ('model_predictions', 'model_prediction_arms')}
        seeds = {'baseline': context['recommendation_context']['inputs']['screener_seed_context']['inputs']['daily_rows'],
                 'candidate': prepared['definitions'][key]['candidate_seed_inputs']['daily_rows']}
        contrast = {'definition_checksum': key, 'policy_checksum': baseline_checksum,
            'prepared_input_checksum': prepared['input_hash'], 'allocation_output_checksum': output['output_checksum'],
            'baseline': deepcopy(output['baseline']), 'candidate': deepcopy(definition['allocation'])}
        parent = freeze_snapshot(signal_date=manifest['signal_date'], source_run_id='atomic:' + pair_id,
            snapshot_kind='allocation_context', query=query, writer=writer, content={**deepcopy(context), **fields,
                'upstream_allocation_context_snapshot_id': snapshot_id,
                'atomic_contrast': contrast, 'atomic_native_seed_rows': deepcopy(seeds)})
        seal = freeze_snapshot(signal_date=manifest['signal_date'], source_run_id=pair_id,
            snapshot_kind='allocation_pair', query=query, writer=writer, content={
                'pair_id': pair_id, 'root_pair_id': root_pair_id, 'owner': OWNER,
                'candidate_checksum': key, 'baseline_checksum': baseline_checksum,
                'candidate_artifact_id': OWNER + ':' + key,
                'candidate_training_run_id': 'not_applicable:canonical_strategy_definition',
                'allocation_context_snapshot_id': parent['snapshot_id'],
                'configuration': configuration, 'configuration_checksum': config_checksum,
                'allocation_input_checksum': digest(context['inputs']),
                'model_predictions_checksum': native['model_predictions_checksum'],
                'model_prediction_arms_checksum': native['model_prediction_arms_checksum'],
                'baseline': output['baseline'], 'candidate': definition['allocation'],
                'atomic_contrast_checksum': digest(contrast), 'atomic_native_seed_checksum': digest(seeds),
                'production_effect': False, 'promotion_allowed': False, 'can_write_order': False, 'nav_maturity_credit': 0})
        plan = {'pair_id': pair_id, 'snapshot_id': seal['snapshot_id'], 'owner': OWNER}
        verify_atomic_comparison(read_snapshot(query, seal['snapshot_id'])['payload']['content'],
                                 read_snapshot(query, parent['snapshot_id']), query=query)
        plans.append(plan)
    return {**empty, 'status': 'allocation_pairs_frozen' if plans else 'atomic_candidates_unavailable',
        'plans': plans, 'unavailable': unavailable, 'definition_count': len(policy['definitions']),
        'selection_materialization_complete': not unavailable,
        'lifecycle_transition_plan': prepare_comparison_transitions(plans=plans,
            signal_date=manifest['signal_date'], query=query)}


def verify_atomic_comparison(plan, parent, *, query):
    from services.paired_native_models import atomic_model_context
    content = parent['payload']['content']
    root_id = content.get('upstream_allocation_context_snapshot_id')
    if not root_id:
        raise ValueError('paired_nav_atomic_comparison_root_missing')
    root = read_snapshot(query, root_id)
    original = root['payload']['content']
    prepared = original['atomic_recommendation_inputs']
    policy = validate_atomic_policy(prepared['policy_population'])
    key, contrast = plan['candidate_checksum'], content.get('atomic_contrast') or {}
    if (root['manifest']['snapshot_kind'] != 'allocation_context' or root['manifest']['prospective'] != 1
            or root['manifest']['signal_date'] != parent['manifest']['signal_date']
            or _timestamp(root['manifest']['frozen_at']) > _timestamp(parent['manifest']['frozen_at'])
            or key not in policy['definitions'] or plan.get('owner') != OWNER
            or any(content.get(field) != original.get(field) for field in (
                'inputs', 'formal_output', 'formal_baseline_identity', 'atomic_recommendation_inputs',
                'atomic_recommendation_result', 'recommendation_context', 'native_execution_environment', 'ev_candidate_selection',
                'trading_config', 'risk_config', 'allocator_source_identity', 'capture', 'allocator_history_context'))
            or plan['baseline_checksum'] != policy['context']['policy_checksum']
            or plan['configuration'] != _configuration(root, policy)
            or plan.get('configuration_checksum') != digest(plan['configuration'])
            or plan.get('allocation_input_checksum') != digest(original['inputs'])
            or plan.get('root_pair_id') != digest([OWNER, key, plan['baseline_checksum'], plan['configuration_checksum']])
            or contrast.get('definition_checksum') != key
            or contrast.get('policy_checksum') != plan['baseline_checksum']
            or contrast.get('prepared_input_checksum') != prepared['input_hash']
            or plan.get('atomic_contrast_checksum') != digest(contrast)
            or any(plan[arm] != contrast.get(arm) for arm in ('baseline', 'candidate'))
            or plan['baseline']['output'] != original['formal_output']):
        raise ValueError('paired_nav_atomic_comparison_identity_mismatch')
    native = atomic_model_context(context=original, prepared=prepared, definition_checksum=key)
    if any(content.get(k) != native[k] or plan.get(k + '_checksum') != native[k + '_checksum']
            for k in ('model_predictions', 'model_prediction_arms')):
        raise ValueError('paired_nav_atomic_comparison_model_mismatch')
    seeds = {'baseline': original['recommendation_context']['inputs']['screener_seed_context']['inputs']['daily_rows'],
             'candidate': prepared['definitions'][key]['candidate_seed_inputs']['daily_rows']}
    if content.get('atomic_native_seed_rows') != seeds or plan.get('atomic_native_seed_checksum') != digest(seeds):
        raise ValueError('paired_nav_atomic_comparison_seed_mismatch')
    return deepcopy(seeds)
