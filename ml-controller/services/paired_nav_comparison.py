"""Resolve the economic comparison from immutable execution/allocation parents.

Fusion measures an increment over the exact L4 candidate, not a replacement of
the incumbent portfolio. Legacy execution-only receipts have no attested role.
This reader neither rewrites old journals nor grants statistical authority.
"""
from services.paired_nav_journal import digest, read_snapshot, read_context_projection, _timestamp


class _ComparisonInputArms(dict):
    """Validation-only view; the existing verifier's returned copy is unused.

    Keep the shared L3 verifier and all its checks intact. Only this read-only
    caller discards its output; execution/registration still receive deep copies.
    """
    def __deepcopy__(self, memo):
        return None


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
    if plan.get('execution_replacement'):
        from services.paired_native_prestart import validate_successor_execution
        _, _, comparison = validate_successor_execution(execution, allocation=allocation, query=query)
        return comparison
    from services.paired_nav_read_cache import reusable_comparison, remember_comparison, ComparisonReads
    reused = reusable_comparison(query, allocation)
    recorded = ComparisonReads(query)
    # Cached comparison still checks the exact execution environment afresh.
    parent = (read_context_projection(query, plan['allocation_context_snapshot_id'],
                                     ('native_execution_environment',)) if reused is not None
              else _comparison_parent(recorded, plan, include_environment=True))
    from services.paired_nav_execution_environment import validate_registered_environment
    validate_registered_environment(parent=parent, allocation=plan,
        runtime={'execution_owner_version': packet.get('execution_owner_version')},
        account_id=packet.get('account_id'), variables=packet.get('variables'),
        kv_read_policy=packet.get('kv_read_policy'), source_context=packet.get('source_context'))
    if reused is not None:
        return reused
    # This parent was obtained by the verified owner reader above. Capture its
    # source queries and the verifier's dependencies without encoding its full
    # history again just to prove the read_snapshot checksum a second time.
    result = _resolve_allocation_comparison(query=recorded, allocation=allocation, parent=parent)
    if recorded.stable:
        remember_comparison(query, allocation, parent, result, dependencies=list(recorded.reads.values()))
    from services.paired_nav_cold import remember_verified_projection
    remember_verified_projection(query, parent, ('native_execution_environment',))
    return result


def resolve_allocation_comparison(*, query, allocation, parent=None):
    """The same contrast validation, including plans with no execution yet."""
    from services.paired_nav_read_cache import reusable_comparison, remember_comparison, ComparisonReads
    supplied_parent = parent is not None
    if not supplied_parent:
        reused = reusable_comparison(query, allocation)
        if reused is not None:
            return reused
    am, plan = allocation['manifest'], allocation['payload']['content']
    recorded = ComparisonReads(query)
    if parent is not None:
        # A caller-supplied, already verified parent was read outside this
        # recorder. Bind its locator too, not just its immutable manifest.
        from services.paired_nav_cold import available, _row
        if recorded('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?',
                    [parent['manifest']['snapshot_id']]) != [parent['manifest']]:
            raise RuntimeError('paired_nav_comparison_parent_changed')
        if available(recorded):
            _row(recorded, parent['manifest']['snapshot_id'])
    else:
        parent = _comparison_parent(recorded, plan)
    result = _resolve_allocation_comparison(query=recorded, allocation=allocation, parent=parent)
    # A caller can mutate a supplied dictionary. Always run its original
    # verifier, and never seed a reusable verdict from that mutable input.
    # Only parents obtained here by the verified reader can seed the memo.
    if recorded.stable and not supplied_parent:
        remember_comparison(query, allocation, parent, result, dependencies=list(recorded.reads.values()))
    return result


def _comparison_parent(query, plan, *, include_environment=False):
    # Explicit field sets follow the validators below. Strategy/OPB/atomic
    # comparisons retain the complete parent and their original checks.
    fields = ('formal_baseline_identity', 'formal_output')
    if include_environment:
        fields += ('native_execution_environment',)
    if plan.get('execution_replacement') or plan['configuration'].get('strategy_bundle') is not None:
        return read_snapshot(query, plan['allocation_context_snapshot_id'])
    if plan['owner'] == 'l15_route':
        fields += ('recommendation_context.inputs.screener_recs',)
    elif plan['owner'] not in {'ensemble', 'l4_alpha_ev', 'allocator_ev_fusion'}:
        return read_snapshot(query, plan['allocation_context_snapshot_id'])
    return read_context_projection(query, plan['allocation_context_snapshot_id'], fields)


def _resolve_allocation_comparison(*, query, allocation, parent):
    am, plan = allocation['manifest'], allocation['payload']['content']
    pm, context = parent['manifest'], parent['payload']['content']
    if (am['snapshot_kind'] != 'allocation_pair' or am['prospective'] != 1
            or pm['snapshot_kind'] != 'allocation_context' or pm['prospective'] != 1
            or pm['signal_date'] != am['signal_date']
            or _timestamp(pm['frozen_at']) > _timestamp(am['frozen_at'])
            or digest(plan['configuration']) != plan['configuration_checksum']
            or plan['configuration'].get('formal_baseline_identity') != context.get('formal_baseline_identity')
            or not context.get('formal_baseline_identity')):
        raise ValueError('paired_nav_comparison_allocation_parent_mismatch')
    if plan.get('execution_replacement'):
        from services.paired_native_prestart import validate_successor_plan
        _, _, comparison = validate_successor_plan(plan, signal_date=am['signal_date'], frozen_at=am['frozen_at'], query=query)
        return comparison
    owner = plan['owner']
    if owner in {'ensemble', 'l4_alpha_ev'}:
        formal = context['formal_baseline_identity']
        expected = formal.get('payload_checksum') if owner == 'ensemble' else digest(formal)
        if plan['baseline_checksum'] != expected or plan['baseline']['output'] != context['formal_output']:
            raise ValueError('paired_nav_comparison_incumbent_mismatch')
        kind, baseline_kind = 'incumbent_replacement', 'frozen_incumbent_policy'
        if plan['configuration'].get('strategy_bundle') is not None:
            if owner!='ensemble':
                raise ValueError('paired_nav_strategy_comparison_owner_invalid')
            from services.paired_nav_strategy_bundle import verify_strategy_inputs
            validation_context = dict(context)
            if isinstance(context.get('strategy_allocation_input_arms'), dict):
                validation_context['strategy_allocation_input_arms'] = _ComparisonInputArms(context['strategy_allocation_input_arms'])
            verify_strategy_inputs(plan['configuration'],validation_context,signal_date=am['signal_date'])
            if plan['configuration']['strategy_bundle']['candidate_l3_identity']['payload_checksum']!=plan['candidate_checksum']:
                raise ValueError('paired_nav_strategy_comparison_candidate_mismatch')
            kind,baseline_kind='strategy_bundle_replacement','frozen_incumbent_complete_chain'
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
    elif owner == 'l4_r2':
        from services.l4_r2_paired import verify_input_arms
        verify_input_arms(plan,parent,query=query)
        kind,baseline_kind='same_l3_full_pool_l4_model_contrast','frozen_incumbent_on_shared_native_pool'
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
    extra = {}
    tag = (plan['configuration'].get('strategy_bundle') or {}).get('strategy_ab')
    if tag is not None:
        from services.strategy_ab import validate_tag
        extra['strategy_ab'] = validate_tag(tag)
    return {**extra, 'schema_version': 'paired-nav-comparison-v1', 'owner': owner, 'kind': kind,
            'baseline_kind': baseline_kind, 'candidate_checksum': plan['candidate_checksum'],
            'baseline_checksum': plan['baseline_checksum']}
