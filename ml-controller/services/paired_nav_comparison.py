"""Resolve the economic comparison from immutable execution/allocation parents.

Fusion measures an increment over the exact L4 candidate, not a replacement of
the incumbent portfolio. Legacy execution-only receipts have no attested role.
This reader neither rewrites old journals nor grants statistical authority.
"""
from services.paired_nav_journal import digest, read_snapshot, _timestamp


def resolve_comparison(*, query, execution):
    manifest, packet = execution['manifest'], execution['payload']['content']
    if not packet.get('allocation_snapshot_id'):
        return None
    allocation = read_snapshot(query, packet['allocation_snapshot_id'])
    am, plan = allocation['manifest'], allocation['payload']['content']
    if (manifest['snapshot_kind'] != 'execution_pair' or am['snapshot_kind'] != 'allocation_pair'
            or am['prospective'] != 1 or am['signal_date'] != manifest['signal_date']
            or _timestamp(am['frozen_at']) > _timestamp(manifest['frozen_at'])
            or packet.get('configuration') != {**plan['configuration'], 'fees': plan['configuration']['trading_config']['fees']}
            or any(packet.get(key) != plan.get(key) for key in
                   ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum'))):
        raise ValueError('paired_nav_comparison_execution_parent_mismatch')
    parent = read_snapshot(query, plan['allocation_context_snapshot_id'])
    from services.paired_nav_execution_environment import validate_registered_environment
    validate_registered_environment(parent=parent, allocation=plan,
        runtime={'execution_owner_version': packet.get('execution_owner_version')},
        account_id=packet.get('account_id'), variables=packet.get('variables'),
        kv_read_policy=packet.get('kv_read_policy'), source_context=packet.get('source_context'))
    return resolve_allocation_comparison(query=query, allocation=allocation, parent=parent)


def resolve_allocation_comparison(*, query, allocation, parent=None):
    """The same contrast validation, including plans with no execution yet."""
    am, plan = allocation['manifest'], allocation['payload']['content']
    parent = parent if parent is not None else read_snapshot(query, plan['allocation_context_snapshot_id'])
    pm, context = parent['manifest'], parent['payload']['content']
    if (am['snapshot_kind'] != 'allocation_pair' or am['prospective'] != 1
            or pm['snapshot_kind'] != 'allocation_context' or pm['prospective'] != 1
            or pm['signal_date'] != am['signal_date']
            or _timestamp(pm['frozen_at']) > _timestamp(am['frozen_at'])
            or digest(plan['configuration']) != plan['configuration_checksum']
            or plan['configuration'].get('formal_baseline_identity') != context.get('formal_baseline_identity')
            or not context.get('formal_baseline_identity')):
        raise ValueError('paired_nav_comparison_allocation_parent_mismatch')
    owner = plan['owner']
    if owner in {'ensemble', 'l4_alpha_ev'}:
        formal = context['formal_baseline_identity']
        expected = formal.get('payload_checksum') if owner == 'ensemble' else digest(formal)
        if plan['baseline_checksum'] != expected or plan['baseline']['output'] != context['formal_output']:
            raise ValueError('paired_nav_comparison_incumbent_mismatch')
        kind, baseline_kind = 'incumbent_replacement', 'frozen_incumbent_policy'
    elif owner == 'opb_arm_prior':
        from services.paired_nav_opb_candidate import verify_opb_comparison
        verify_opb_comparison(plan, parent)
        kind, baseline_kind = 'allocator_policy_contrast', 'exact_frozen_incumbent_allocator'
    elif owner == 'atomic_strategy':
        from services.paired_nav_atomic_candidate import verify_atomic_comparison
        verify_atomic_comparison(plan, parent, query=query)
        kind, baseline_kind = 'atomic_strategy_replacement', 'frozen_incumbent_strategy_policy'
    elif owner == 'l15_route':
        from services.paired_nav_route_candidate import verify_route_comparison
        verify_route_comparison(plan, parent)
        kind, baseline_kind = 'route_policy_contrast', 'frozen_incumbent_route'
    elif owner == 'allocator_ev_fusion':
        if plan.get('exact_l4_checksum') != plan['baseline_checksum']:
            raise ValueError('paired_nav_comparison_l4_identity_mismatch')
        references = []
        for row in query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 "
                "WHERE snapshot_kind='allocation_pair' AND prospective=1 AND signal_date=?", [am['signal_date']]):
            other = read_snapshot(query, row['snapshot_id'])['payload']['content']
            if (other.get('owner') == 'l4_alpha_ev'
                    and other.get('allocation_context_snapshot_id') == plan['allocation_context_snapshot_id']
                    and other.get('candidate_checksum') == plan['exact_l4_checksum']):
                references.append(other)
        if (len(references) != 1 or references[0]['configuration_checksum'] != plan['configuration_checksum']
                or references[0]['candidate'] != plan['baseline']):
            raise ValueError('paired_nav_comparison_l4_plan_mismatch')
        kind, baseline_kind = 'incremental_layer', 'exact_frozen_l4_candidate'
    else:
        raise ValueError('paired_nav_comparison_owner_unsupported')
    return {'schema_version': 'paired-nav-comparison-v1', 'owner': owner, 'kind': kind,
            'baseline_kind': baseline_kind, 'candidate_checksum': plan['candidate_checksum'],
            'baseline_checksum': plan['baseline_checksum']}
