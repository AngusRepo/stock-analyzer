"""Frozen L1.5 routing -> existing paired native account lifecycle, shadow only.

Equal allocations still collect real sessions: never select only the dates on
which the candidate happens to trade differently. No synthetic NAV or new
portfolio multiplier is introduced.
"""
from pathlib import Path
import hashlib

from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot

OWNER = 'l15_route'


def route_identity(version, slate_version):
    if not isinstance(version, str) or not version or not isinstance(slate_version, str) or not slate_version:
        raise ValueError('paired_nav_route_policy_identity_missing')
    return digest(['paired-nav-route-policy-v1', version, slate_version])


def collect_route_allocations(*, snapshot_id, query, writer):
    from services.paired_nav_route_effect import audit_route_allocation_effect
    from services.paired_nav_candidate_collection import allocation_policy_identity
    from services.paired_nav_execution_environment import configuration_environment
    from services.paired_nav_lifecycle import registered_pairs, resolve_pair_id, prepare_comparison_transitions
    saved = read_snapshot(query, snapshot_id)
    manifest, context = saved['manifest'], saved['payload']['content']
    captures = []
    effect = audit_route_allocation_effect(snapshot_id=snapshot_id, query=query, allocation_sink=captures.append)
    old = [item['allocation']['payload']['content'] for item in registered_pairs(signal_date=manifest['signal_date'], query=query)
        if item['allocation']['payload']['content']['owner'] == OWNER] if manifest['prospective'] else []
    base = {'effect': effect, 'plans': [], 'lifecycle_transitions': [], 'lifecycle_transition_plan': [],
        'production_effect': False, 'nav_maturity_credit': 0}
    if effect['status'] in {'unavailable_legacy_route_inputs', 'historical_not_prospective'}:
        if old:
            raise ValueError('paired_nav_registered_route_inputs_missing')
        return {**base, 'status': effect['status']}
    if len(captures) != 1:
        raise ValueError('paired_nav_route_allocation_capture_missing')
    candidate = route_identity(effect['challenger_version'], effect['slate_builder_version'])
    baseline = route_identity(effect['incumbent_version'], effect['slate_builder_version'])
    # Do not silently abandon a still-open executable version, or claim that
    # today's two different versions are a replay of an unavailable old policy.
    if any(p['candidate_checksum'] != candidate for p in old):
        raise ValueError('paired_nav_registered_route_version_missing')
    configuration = {key: context[key] for key in ('trading_config', 'risk_config', 'allocator_source_identity')}
    configuration.update(formal_baseline_identity=context['formal_baseline_identity'],
        allocator_policies=allocation_policy_identity(context['inputs']),
        route_policies={'incumbent_version': effect['incumbent_version'], 'challenger_version': effect['challenger_version'],
            'slate_builder_version': effect['slate_builder_version']},
        route_replay_source_checksum=hashlib.sha256(Path(__file__).with_name('paired_nav_route_effect.py').read_bytes()).hexdigest(),
        **configuration_environment(saved))
    config_checksum = digest(configuration)
    root_pair_id = digest([OWNER, candidate, baseline, config_checksum])
    pair_id = resolve_pair_id(root_pair_id, signal_date=manifest['signal_date'], query=query)
    seal = freeze_snapshot(signal_date=manifest['signal_date'], source_run_id=pair_id,
        snapshot_kind='allocation_pair', query=query, writer=writer, content={
            'pair_id': pair_id, 'root_pair_id': root_pair_id, 'owner': OWNER,
            'candidate_checksum': candidate, 'baseline_checksum': baseline,
            'candidate_artifact_id': OWNER + ':' + effect['challenger_version'] + ':' + candidate,
            'candidate_training_run_id': 'not_applicable:deterministic_runtime_router',
            'allocation_context_snapshot_id': snapshot_id, 'configuration': configuration,
            'configuration_checksum': config_checksum, 'allocation_input_checksum': digest(context['inputs']),
            'model_predictions_checksum': digest(context['model_predictions']),
            'baseline': captures[0]['incumbent'], 'candidate': captures[0]['challenger'],
            'route_effect': effect, 'production_effect': False, 'can_write_order': False, 'nav_maturity_credit': 0})
    plans = [{'pair_id': pair_id, 'snapshot_id': seal['snapshot_id'], 'owner': OWNER}]
    return {**base, 'status': 'allocation_pairs_frozen', 'plans': plans,
        'lifecycle_transition_plan': prepare_comparison_transitions(plans=plans,
            signal_date=manifest['signal_date'], query=query)}


def verify_route_comparison(plan, parent):
    """Validate frozen role/outputs without rerunning today's code on old dates."""
    from services.paired_nav_route_effect import frozen_route_source
    context = parent['payload']['content']
    source = frozen_route_source(parent)
    effect = plan.get('route_effect') or {}
    if (effect.get('schema_version') != 'paired-nav-route-effect-v1'
            or effect.get('snapshot_id') != plan['allocation_context_snapshot_id']
            or effect.get('effect_scope') != 'dispatch_priority_only'
            or effect.get('allocation_weight_applied') is not False
            or effect.get('promotion_allowed') is not False
            or effect.get('nav_maturity_credit') != 0
            or source['status'] != 'pit_route_source_verified'):
        raise ValueError('paired_nav_route_comparison_evidence_missing')
    policies = {key: effect.get(key) for key in ('incumbent_version', 'challenger_version', 'slate_builder_version')}
    if (plan['configuration'].get('route_policies') != policies
            or plan['candidate_checksum'] != route_identity(policies['challenger_version'], policies['slate_builder_version'])
            or plan['baseline_checksum'] != route_identity(policies['incumbent_version'], policies['slate_builder_version'])):
        raise ValueError('paired_nav_route_comparison_policy_mismatch')
    if any(source[key] != effect.get(key) for key in ('source_checksum', 'screener_run_id',
            'incumbent_version', 'challenger_version', 'slate_builder_version', 'serving_arm', 'candidate_count')):
        raise ValueError('paired_nav_route_comparison_source_mismatch')
    equal = (plan['baseline']['output'] == plan['candidate']['output']
        and plan['baseline']['capture']['effective_weights'] == plan['candidate']['capture']['effective_weights'])
    if (effect.get('allocation_equal') is not equal or effect.get('status') !=
            ('verified_no_allocation_change' if equal else 'allocation_change_requires_paired_execution')):
        raise ValueError('paired_nav_route_comparison_effect_mismatch')
    for arm, name in (('baseline', 'incumbent'), ('candidate', 'challenger')):
        if (plan[arm]['output'] != effect.get(name + '_allocation')
                or plan[arm]['capture']['effective_weights'] != effect.get(name + '_effective_weights')):
            raise ValueError('paired_nav_route_comparison_allocation_mismatch')
    serving = 'baseline' if effect.get('serving_arm') == 'incumbent' else 'candidate'
    if plan[serving]['output'] != context['formal_output']:
        raise ValueError('paired_nav_route_comparison_serving_mismatch')
