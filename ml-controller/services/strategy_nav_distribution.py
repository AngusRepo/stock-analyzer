"""Same released L3/L4, separate strategy inputs; no publication authority."""
from copy import deepcopy
from services.pipeline_slate_artifacts import load

from services.paired_nav_journal import digest


def enabled(config, *, signal_date):
    from services.paper_strategy_mode import single_b_policy
    return single_b_policy(config, signal_date=signal_date) is not None


def capture_history(prepared, *, formal_payloads, signal_date, capture_source):
    from services.l4_risk_history import load_canonical_risk_payloads
    from services.recommendation_service import gnn_return_history_lookback
    from services.paired_nav_collection import capture_allocator_return_history
    # Formal payloads are already sealed in recommendation_context; store only
    # the extra candidate symbols and rebuild the full rows on read.
    payloads = {p['symbol']: p for p in formal_payloads}
    extra = {}
    for definition in prepared['definitions'].values():
        if definition.get('status') != 'ready':
            continue
        for p in [*load(definition['payloads']), *definition.get('holding_risk_payloads', [])]:
            previous = payloads.get(p['symbol'])
            if previous is not None and previous.get('prices') != p.get('prices'):
                raise ValueError('strategy_nav_shared_price_capture_changed')
            if previous is None:
                payloads[p['symbol']] = extra[p['symbol']] = deepcopy(p)
    rows = [payloads[s] for s in sorted(payloads)]
    canonical = load_canonical_risk_payloads(payloads=rows, held_payloads=[],
        signal_date=signal_date, lookback=gnn_return_history_lookback(), capture_source=capture_source)
    context = capture_allocator_return_history(payloads=rows, signal_date=signal_date,
        held_payloads=[], canonical_risk_payloads=canonical)
    return {'payload_layout': FORMAL_PLUS_EXTRA, 'extra_payloads': [extra[s] for s in sorted(extra)],
            'payloads_checksum': context['payload_checksum'], 'context': context,
            'prepared_input_checksum': prepared['input_hash']}


FORMAL_PLUS_EXTRA = 'formal-plus-extra-v1'


def history_payloads(frozen, formal_payloads):
    """Full risk rows: legacy inline copy, or sealed formal rows plus extras."""
    if 'payloads' in frozen:
        return frozen['payloads']
    if frozen.get('payload_layout') != FORMAL_PLUS_EXTRA:
        raise ValueError('strategy_nav_distribution_history_layout_unknown')
    payloads = {p['symbol']: p for p in formal_payloads}
    for p in frozen['extra_payloads']:
        if p['symbol'] in payloads:
            raise ValueError('strategy_nav_distribution_history_extra_overlaps_formal')
        payloads[p['symbol']] = p
    rows = [payloads[s] for s in sorted(payloads)]
    if digest(rows) != frozen['payloads_checksum']:
        raise ValueError('strategy_nav_distribution_history_payloads_changed')
    return rows


def allocation_inputs(context, prepared, definition_checksum, recommendations):
    """Bind own full L3 predictions and dated risk to the exact released model.

    Initial allocation is a sealed preview. Native frames replace the account
    with each arm's own persistent private state before executing this policy.
    """
    from services.paired_native_models import atomic_model_context
    from services.paired_nav_collection import replay_allocator_return_history
    frozen = context.get('atomic_distribution_history')
    if not isinstance(frozen, dict) or frozen.get('prepared_input_checksum') != prepared['input_hash']:
        raise ValueError('strategy_nav_distribution_history_missing')
    payloads = history_payloads(frozen, context['recommendation_context']['inputs']['payloads'])
    history = replay_allocator_return_history(frozen['context'], payloads=payloads,
        signal_date=prepared['signal_date'])
    inputs = deepcopy(context['inputs'])
    native = atomic_model_context(context=context, prepared=prepared, definition_checksum=definition_checksum)
    policy = inputs['alpha_policy']['l4Distribution']
    if not enabled(context['trading_config'], signal_date=prepared['signal_date']):
        raise ValueError('strategy_nav_same_released_policy_required')
    formal = context['inputs']['alpha_policy']['l4Distribution']
    if (policy['artifact'] != context['trading_config']['l4Distribution']['artifact']
            or policy['runtime']['l3_identity'] != context['formal_baseline_identity']):
        raise ValueError('strategy_nav_distribution_model_changed')
    policy['runtime']['predictions'] = deepcopy(native['model_prediction_arms']['candidate']['predictions'])
    # Do not mix rewards from the formal account into an independent comparison.
    # Initial preview has no private observations. Native execution reads its
    # own persistent reward table; formal observations cannot seed either arm.
    inputs['opb_reward_ledger'] = []
    inputs['recommendations'] = deepcopy(recommendations)
    inputs['return_history'] = history
    if digest(policy['artifact']) != digest(formal['artifact']):
        raise ValueError('strategy_nav_distribution_model_changed')
    return inputs, native


def verify_input_arms(plan, parent, *, query):
    """Original comparison verification also checks the native per-arm inputs."""
    content = parent['payload']['content']
    if content['inputs'].get('alpha_policy', {}).get('l4Distribution') is None:
        return None
    # The caller supplies the original frozen context, not current API data.
    from services.paired_nav_journal import read_snapshot
    original = read_snapshot(query, content['upstream_allocation_context_snapshot_id'])['payload']['content']
    prepared = original['atomic_recommendation_inputs']
    key = plan['candidate_checksum']
    rows = original['atomic_recommendation_result']['definitions'][key]['result']['recommendations']
    candidate, _ = allocation_inputs(original, prepared, key, rows)
    expected = {'baseline': original['inputs'], 'candidate': candidate}
    if content.get('atomic_distribution_input_arms') != expected:
        raise ValueError('strategy_nav_distribution_arms_changed')
    return deepcopy(expected)
