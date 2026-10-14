"""Retain unverifiable retired contrasts without claiming replay or NAV credit."""
from services.paired_nav_journal import digest, _timestamp


def retired_source_comparison(exc, *, allocation, parent, clock):
    m, plan = allocation['manifest'], allocation['payload']['content']
    pm, context = parent['manifest'], parent['payload']['content']
    risk = context.get('strategy_bundle_risk_context')
    if (str(exc) != 'paired_nav_allocator_history_context_invalid'
            or plan.get('owner') != 'ensemble' or not plan['configuration'].get('strategy_bundle')
            or not isinstance(risk, dict)):
        return None
    from services.paired_nav_collection import allocator_source_identity
    original = risk.get('source_identity')
    if not original or original == allocator_source_identity():
        return None
    from services.trading_config_loader import load_merged_trading_config_with_contract
    from services.paper_strategy_mode import single_b_policy
    loaded = load_merged_trading_config_with_contract()
    if loaded.contract.degraded or single_b_policy(loaded.config) is None:
        return None
    # Raw objects were checksum-verified by read_snapshot. Retain the original
    # source binding; neither run today's allocator nor certify the old result.
    if (m['snapshot_kind'] != 'allocation_pair' or pm['snapshot_kind'] != 'allocation_context'
            or m['prospective'] != 1 or pm['prospective'] != 1
            or m['signal_date'] != pm['signal_date'] or risk.get('signal_date') != m['signal_date']
            or not _timestamp(pm['frozen_at']) <= _timestamp(m['frozen_at']) <= clock
            or original != plan['configuration'].get('allocator_source_identity')
            or original != context.get('allocator_source_identity')
            or risk.get('content_checksum') != digest({k:v for k,v in risk.items() if k != 'content_checksum'})
            or risk.get('payload_checksum') != digest(context['recommendation_context']['inputs']['payloads'])
            or plan['configuration_checksum'] != digest(plan['configuration'])):
        return None
    return {'schema_version': 'paired-nav-comparison-v1', 'owner': 'ensemble',
        'kind': 'unavailable_retired_source', 'baseline_kind': 'unverified_original_source',
        'candidate_checksum': plan['candidate_checksum'], 'baseline_checksum': plan['baseline_checksum'],
        'reason': 'paired_nav_retired_allocator_source_unavailable'}


def execution_parent_identity(allocation):
    m, plan = allocation['manifest'], allocation['payload']['content']
    return {'signal_date': m['signal_date'], 'frozen_at': m['frozen_at'],
        **{k: plan[k] for k in ('pair_id','owner','candidate_checksum','baseline_checksum')},
        'configuration_checksum': digest({**plan['configuration'],
            'fees': plan['configuration']['trading_config']['fees']})}


def validate_unavailable_execution(saved, expected):
    m, packet = saved['manifest'], saved['payload']['content']
    if (m['snapshot_kind'] != 'execution_pair' or m['prospective'] != 1
            or m['signal_date'] != expected['signal_date']
            or _timestamp(expected['frozen_at']) > _timestamp(m['frozen_at'])
            or any(packet.get(k) != expected[k] for k in
                ('pair_id','owner','candidate_checksum','baseline_checksum'))
            or packet.get('configuration_checksum') != expected['configuration_checksum']
            or digest(packet['configuration']) != expected['configuration_checksum']):
        raise ValueError('paired_nav_comparison_execution_parent_mismatch')
