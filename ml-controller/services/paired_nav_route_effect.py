"""Replay L1.5 dispatch changes through real recommendation/sparse/OPB consumers.

This does not invent a route allocation multiplier or call score-weighted
returns NAV. Different allocations still require actual paired execution.
"""
from copy import deepcopy
import math

from services.paired_nav_journal import digest, read_snapshot, _timestamp


def frozen_route_source(saved):
    """Validate PIT identity without executing an allocator or reading live data."""
    manifest, packet = saved['manifest'], saved['payload']['content']
    snapshot_id = manifest['snapshot_id']
    if manifest['snapshot_kind'] != 'allocation_context':
        raise ValueError('paired_nav_route_allocation_context_required')
    context = packet.get('recommendation_context') or {}
    rows = context.get('inputs', {}).get('screener_recs') or []
    base = {'schema_version': 'paired-nav-route-effect-v1', 'snapshot_id': snapshot_id,
        'promotion_allowed': False, 'nav_maturity_credit': 0,
        'effect_scope': 'dispatch_priority_only', 'allocation_weight_applied': False}
    if manifest['prospective'] != 1:
        return {**base, 'status': 'historical_not_prospective'}
    if not any(row.get('l15_route_source') is not None for row in rows):
        return {**base, 'status': 'unavailable_legacy_route_inputs'}
    scores, identities, sources, cutoffs, runs = {}, set(), [], set(), set()
    for row in rows:
        source = row.get('l15_route_source')
        if (not isinstance(source, dict) or source.get('schema_version') != 'l15-route-source-v1'
                or source.get('signal_date') != manifest['signal_date']
                or row.get('date') != manifest['signal_date']
                or not source.get('screener_run_id') or not source.get('decision_universe_frozen_at')
                or source.get('screener_run_id') != row.get('screener_run_id')
                or source.get('decision_universe_frozen_at') != row.get('decision_universe_frozen_at')
                or _timestamp(source['decision_universe_frozen_at']) > _timestamp(manifest['frozen_at'])):
            raise ValueError('paired_nav_route_source_lineage_missing_or_future')
        variants = [source[k] for k in ('l1_contrast', 'seed_contrast') if source.get(k) is not None]
        if not variants or len({digest(v) for v in variants}) != 1:
            raise ValueError('paired_nav_route_source_conflict_or_missing')
        contrast = variants[0]
        if (not isinstance(contrast, dict) or contrast.get('schema_version') != 'l15-route-contrast-v1'
                or contrast.get('effect_scope') != 'dispatch_priority_only'
                or contrast.get('allocation_weight_applied') is not False
                or contrast.get('serving_arm') not in {'incumbent', 'challenger'}
                or not contrast.get('slate_builder_version')):
            raise ValueError('paired_nav_route_contrast_invalid')
        symbol = str(row['symbol'])
        if symbol in scores:
            raise ValueError('paired_nav_route_duplicate_symbol')
        values = {}
        for arm in ('incumbent', 'challenger'):
            value = contrast.get(arm)
            if (not isinstance(value, dict) or not isinstance(value.get('version'), str) or not value['version']
                    or type(value.get('score')) not in (int, float) or not math.isfinite(value['score'])
                    or not 0 <= value['score'] <= 100):
                raise ValueError('paired_nav_route_version_or_score_missing')
            values[arm] = value['score']
        identities.add((contrast['incumbent']['version'], contrast['challenger']['version'],
            contrast['slate_builder_version'], contrast['serving_arm']))
        scores[symbol] = values
        sources.append((symbol, source))
        cutoffs.add(source['decision_universe_frozen_at'])
        runs.add(source['screener_run_id'])
    if len(identities) != 1 or len(cutoffs) != 1 or len(runs) != 1:
        raise ValueError('paired_nav_route_mixed_pit_universe')
    incumbent_version, challenger_version, slate_version, serving_arm = next(iter(identities))
    return {**base, 'status': 'pit_route_source_verified', 'scores': scores,
        'source_checksum': digest(sorted(sources)), 'screener_run_id': next(iter(runs)),
        'incumbent_version': incumbent_version, 'challenger_version': challenger_version,
        'slate_builder_version': slate_version, 'serving_arm': serving_arm, 'candidate_count': len(rows)}


def audit_route_allocation_effect(*, snapshot_id, query, allocation_sink=None):
    saved = read_snapshot(query, snapshot_id)
    source = frozen_route_source(saved)
    if source['status'] != 'pit_route_source_verified':
        return source
    scores = source.pop('scores')
    packet = saved['payload']['content']
    context = packet['recommendation_context']
    from services.paired_nav_recommendation_path import replay_frozen_recommendation_allocation, run_recommendation_path
    from services.paired_nav_intervention import run_isolated_allocation
    serving = replay_frozen_recommendation_allocation(snapshot_id=snapshot_id, query=query)['allocation']
    serving_arm = source['serving_arm']
    alternative_arm = 'challenger' if serving_arm == 'incumbent' else 'incumbent'
    inputs = deepcopy(context['inputs'])
    inputs['screener_recs'].sort(key=lambda row: (-scores[str(row['symbol'])][alternative_arm], str(row['symbol'])))
    for rank, row in enumerate(inputs['screener_recs'], 1):
        row['rank'] = rank  # Dispatch priority only; preserve Score V2 and all ML predictions.
    candidate_rows = run_recommendation_path(inputs=inputs)['recommendations']
    allocator_inputs = deepcopy(packet['inputs'])
    allocator_inputs['recommendations'] = candidate_rows
    alternative = run_isolated_allocation(inputs=allocator_inputs,
        inherited_state=packet['capture'].get('inherited_state') or {})
    arms = {serving_arm: serving, alternative_arm: alternative}
    equivalent = (arms['incumbent']['output'] == arms['challenger']['output']
        and arms['incumbent']['capture']['effective_weights'] == arms['challenger']['capture']['effective_weights'])
    result = {**source, 'status': 'verified_no_allocation_change' if equivalent else 'allocation_change_requires_paired_execution',
        'incumbent_dispatch': sorted(scores, key=lambda s: (-scores[s]['incumbent'], s)),
        'challenger_dispatch': sorted(scores, key=lambda s: (-scores[s]['challenger'], s)),
        'allocation_equal': equivalent,
        'incumbent_allocation': arms['incumbent']['output'], 'challenger_allocation': arms['challenger']['output'],
        'incumbent_effective_weights': arms['incumbent']['capture']['effective_weights'],
        'challenger_effective_weights': arms['challenger']['capture']['effective_weights'],
        'nav_inference_status': 'not_evaluated'}
    if allocation_sink is not None:
        allocation_sink(deepcopy(arms))
    return result
