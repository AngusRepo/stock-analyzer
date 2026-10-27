"""L4 policy activations: pure transforms shared by the packets and the grant validator.

`l4-policy-activation-v2` moves owners v1 -> v2. Every economic value keeps its
v1 value except the S3 arm rule and the cost objective the activation names.
`l4-policy-constraints-change-v1` then changes named allocator constraints of a
v2 policy, e.g. the cost objective. One release stages a chain of them as P1..Pn
grants; grant k names the chain prefix 1..k and the validator recomputes every
step from the source grant's configuration. Nothing accepts an arbitrary config.
"""
from copy import deepcopy

from services.paired_nav_journal import digest

SCHEMA = 'l4-policy-activation-v2'
CHANGE_SCHEMA = 'l4-policy-constraints-change-v1'
SCHEMAS = (SCHEMA, CHANGE_SCHEMA)
# The allocator's history window stays with the v2 activation (it must match the capture).
FIXED_CONSTRAINTS = frozenset({'return_history_lookback_sessions'})
# Worker legacy constants the circuit layers use until circuit.positionScales
# exists (p3MarketRisk/p4Breadth `* 0.5`, momentumZone ZONE_MULTIPLIER,
# p5Losses P5_LOSS_POSITION_SCALE). tests/test_l4_policy_activation.py pins them.
LEGACY_SEVERE_HIGH_VOL_SCALE = 0.5
LEGACY_MOMENTUM_ZONE_SCALE = {'RED': 0.3, 'YELLOW': 0.7}
LEGACY_LOSS_STREAK_SCALE = 0.5
RISK_SECTIONS = ('system', 'portfolio', 'position', 'order')
LIVE_FLAGS = ('LIVE_EXECUTION_CLIENT_ENABLED', 'LIVE_EXECUTION_SUBMIT_GUARD_ENABLED')
_ABSENT = object()


def _fail(reason):
    return ValueError('l4_policy_activation_invalid:' + reason)


def circuit_position_scales(circuit):
    """Relative scales whose products reproduce today's absolute circuit caps exactly."""
    base, reduced = circuit.get('maxPositionPct'), circuit.get('highVolReducedPosPct')
    if not all(type(v) in (int, float) for v in (base, reduced)) or not 0 < reduced <= base:
        raise _fail('circuit_caps')
    scales = {'highVol': reduced / base, 'severeHighVol': LEGACY_SEVERE_HIGH_VOL_SCALE,
              'momentumZone': dict(LEGACY_MOMENTUM_ZONE_SCALE), 'lossStreak': LEGACY_LOSS_STREAK_SCALE}
    # p3/p4 orange and red/severe caps must stay bit-identical.
    if (base * scales['highVol'] != reduced
            or base * scales['highVol'] * scales['severeHighVol'] != reduced * LEGACY_SEVERE_HIGH_VOL_SCALE):
        raise _fail('circuit_scale_not_exact')
    return scales


def missing_risk_fields(risk, defaults):
    """Worker defaults for the fields raw `trading:risk_config` lacks, as {'section.key': value}."""
    filled = {}
    for section in RISK_SECTIONS:
        current = risk.get(section, {})
        if not isinstance(current, dict) or not isinstance(defaults.get(section), dict):
            raise _fail('risk_section:' + section)
        filled.update({section + '.' + key: deepcopy(value)
                       for key, value in defaults[section].items() if key not in current})
    return filled


def apply_risk_fields(risk, filled):
    """Add absent fields only; a present value never moves."""
    result = deepcopy(risk)
    for path, value in filled.items():
        section, _, key = path.partition('.')
        if section not in RISK_SECTIONS or not key or '.' in key:
            raise _fail('risk_path:' + path)
        target = result.setdefault(section, {})
        if not isinstance(target, dict) or key in target:
            raise _fail('risk_field_present:' + path)
        target[key] = deepcopy(value)
    return result


def next_trading_config(config, *, l4, scales):
    """Apply the owner moves to either the raw KV or the Worker-merged view."""
    result = deepcopy(config)
    # Raw KV must carry the name cap itself: the Worker no longer defaults it.
    position, circuit = result.get('position'), result.setdefault('circuit', {})
    if not isinstance(position, dict) or 'maxPctOfPortfolio' not in position:
        raise _fail('position_name_cap_missing')
    if not isinstance(circuit, dict) or 'positionScales' in circuit:
        raise _fail('circuit_scales_present')
    del position['maxPctOfPortfolio']
    circuit['positionScales'] = deepcopy(scales)
    result['l4Distribution'] = deepcopy(l4)
    return result


def expected_activation(trading_config, risk_config, *, lookback, filled, cost_objective):
    """Recompute the only accepted next (trading_config, risk_config, l4, scales)."""
    from services.l4_allocation_contract import policy_v2_from_v1
    old = trading_config.get('l4Distribution')
    if not isinstance(old, dict) or old.get('scope') != 'paper' or old.get('policy_schema') is not None:
        raise _fail('source_policy')
    l4 = policy_v2_from_v1(old, lookback=lookback, cost_objective=cost_objective)
    scales = circuit_position_scales(trading_config['circuit'])
    risk = apply_risk_fields(risk_config, filled)
    # risk_config.position.maxSingleNamePct becomes the only single-name owner.
    if risk.get('position', {}).get('maxSingleNamePct') != trading_config['position'].get('maxPctOfPortfolio'):
        raise _fail('single_name_owner_disagrees')
    return next_trading_config(trading_config, l4=l4, scales=scales), risk, l4, scales


def next_constraints_policy(l4, changes):
    """The v2 policy with only the named allocator constraints changed; identity recomputed."""
    from services.l4_distribution_runtime import distribution_policy_identity
    from services.l4_opb_selection import ALLOCATOR_KEYS, is_v2, validate_constraints
    if not is_v2(l4) or l4.get('scope') != 'paper':
        raise _fail('change_source_not_v2')
    if not isinstance(changes, dict) or not changes or set(changes) - (ALLOCATOR_KEYS - FIXED_CONSTRAINTS):
        raise _fail('change_keys')
    policy = deepcopy(l4)
    for key, value in changes.items():
        if policy['constraints'].get(key, _ABSENT) == value:
            raise _fail('change_noop:' + key)
        policy['constraints'][key] = deepcopy(value)
    validate_constraints(policy['constraints'])
    policy['opb']['approved_policy_identity'] = distribution_policy_identity(policy, policy['artifact']['l3_identity'])
    return policy


def _reviewed(activation):
    return (activation.get('scope') == 'paper' and activation.get('maturity_transfer') is False
            and activation.get('account_reset') is False
            and bool(activation.get('engineering_receipt_checksum')) and bool(activation.get('source_reference')))


def activation_document(trading_config, risk_config, *, lookback, cost_objective, risk_defaults,
                        engineering_receipt_checksum, source_reference):
    filled = missing_risk_fields(risk_config, risk_defaults)
    config, risk, l4, scales = expected_activation(trading_config, risk_config, lookback=lookback,
                                                   filled=filled, cost_objective=cost_objective)
    if not engineering_receipt_checksum or not source_reference:
        raise _fail('review_reference')
    activation = {'schema_version': SCHEMA, 'scope': 'paper', 'maturity_transfer': False, 'account_reset': False,
        'return_history_lookback_sessions': lookback, 'cost_objective': cost_objective,
        'circuit_position_scales': scales, 'risk_config_filled_fields': filled,
        'previous_policy_checksum': digest(trading_config['l4Distribution']), 'next_policy_checksum': digest(l4),
        'previous_risk_config_checksum': digest(risk_config), 'next_risk_config_checksum': digest(risk),
        'next_policy_identity': l4['opb']['approved_policy_identity'],
        'engineering_receipt_checksum': engineering_receipt_checksum, 'source_reference': source_reference}
    return activation, config, risk


def change_document(trading_config, *, changes, engineering_receipt_checksum, source_reference):
    old = trading_config.get('l4Distribution')
    l4 = next_constraints_policy(old, changes)
    if not engineering_receipt_checksum or not source_reference:
        raise _fail('review_reference')
    activation = {'schema_version': CHANGE_SCHEMA, 'scope': 'paper', 'maturity_transfer': False,
        'account_reset': False, 'changes': deepcopy(changes),
        'previous_policy_checksum': digest(old), 'next_policy_checksum': digest(l4),
        'next_policy_identity': l4['opb']['approved_policy_identity'],
        'engineering_receipt_checksum': engineering_receipt_checksum, 'source_reference': source_reference}
    return activation, {**deepcopy(trading_config), 'l4Distribution': l4}


def expected_configuration(state, activation):
    """The only (trading_config, risk_config) one reviewed activation accepts after `state`."""
    trading, risk = state['trading_config'], state['risk_config']
    if not _reviewed(activation) or activation.get('previous_policy_checksum') != digest(trading.get('l4Distribution')):
        raise _fail('document')
    if activation.get('schema_version') == SCHEMA:
        if not isinstance(activation.get('risk_config_filled_fields'), dict):
            raise _fail('risk_fields')
        config, next_risk, l4, scales = expected_activation(trading, risk,
            lookback=activation.get('return_history_lookback_sessions'),
            filled=activation['risk_config_filled_fields'], cost_objective=activation.get('cost_objective'))
        if (activation.get('circuit_position_scales') != scales
                or activation.get('previous_risk_config_checksum') != digest(risk)
                or activation.get('next_risk_config_checksum') != digest(next_risk)):
            raise _fail('owner_move')
    elif activation.get('schema_version') == CHANGE_SCHEMA:
        l4 = next_constraints_policy(trading.get('l4Distribution'), activation.get('changes'))
        config, next_risk = {**deepcopy(trading), 'l4Distribution': l4}, deepcopy(risk)
    else:
        raise _fail('schema')
    if (activation.get('next_policy_checksum') != digest(l4)
            or activation.get('next_policy_identity') != l4['opb']['approved_policy_identity']):
        raise _fail('next_policy')
    return config, next_risk


def validate_activation_chain(before, after, chain):
    """Accept exactly the recomputed chain, then restore `after` to `before` for the pin."""
    fail = lambda: RuntimeError('l4_execution_policy_activation_invalid')
    if not isinstance(chain, list) or not chain or not all(isinstance(a, dict) for a in chain):
        raise fail()
    state = {'trading_config': before['trading_config'], 'risk_config': before['risk_config']}
    try:
        for activation in chain:
            trading, risk = expected_configuration(state, activation)
            state = {'trading_config': trading, 'risk_config': risk}
    except (KeyError, TypeError, ValueError):
        raise fail()
    if (digest(after['trading_config']) != digest(state['trading_config'])
            or digest(after['risk_config']) != digest(state['risk_config'])):
        raise fail()
    for flag in LIVE_FLAGS:
        if str(after['native_execution_policy']['variables'].get(flag, '')).lower() not in ('0', 'false', 'off', 'disabled'):
            raise fail()
    after['trading_config'] = deepcopy(before['trading_config'])
    after['risk_config'] = deepcopy(before['risk_config'])


def manifest_chain(manifest):
    """Reviewed activations of one release; the v1 single-activation field still reads."""
    if 'policy_activations' in manifest:
        return manifest['policy_activations']
    return [manifest['policy_activation']] if 'policy_activation' in manifest else []


def named_chain(change):
    """Checksums a grant names: a prefix of the release chain."""
    if isinstance(change, dict) and set(change) == {'activation_checksums'}:
        return change['activation_checksums']
    if isinstance(change, dict) and set(change) == {'activation_checksum'}:
        return [change['activation_checksum']]
    return None


def policy_keys(behavior):
    if 'policy_runtime_admissions' in behavior:
        return list(behavior['policy_runtime_admissions'])
    return [behavior['policy_runtime_admission']] if behavior.get('policy_runtime_admission') else []


def with_policy_activations(manifest, behavior, *, chain, keys):
    """Release manifest edits that let one source release also stage P1..Pn policy grants.

    Call before the source grant is built: its manifest checksum covers the
    chain, and the source grant itself still pins the old configuration.
    """
    if (not chain or len(chain) != len(keys) or len(set(keys)) != len(keys)
            or behavior.get('runtime_admission') in keys
            or any(a.get('schema_version') not in SCHEMAS for a in chain)):
        raise _fail('release_policy_keys')
    manifest = {k: deepcopy(v) for k, v in manifest.items() if k != 'policy_activation'}
    behavior = {k: deepcopy(v) for k, v in behavior.items() if k != 'policy_runtime_admission'}
    return ({**manifest, 'policy_activations': deepcopy(chain)},
            {**behavior, 'policy_runtime_admissions': list(keys)})


def policy_grants(source_grant, packets):
    """P1..Pn: grant k = the S grant with packet k's configuration, naming the chain prefix 1..k."""
    grants = []
    for count, packet in enumerate(packets, 1):
        grant = deepcopy(source_grant)
        grant['configuration']['trading_config'] = deepcopy(packet['next_merged_config'])
        grant['configuration']['risk_config'] = deepcopy(packet['next_risk_config'])
        grant['approved_l4_execution_policy_change'] = {
            'activation_checksums': [digest(p['activation']) for p in packets[:count]]}
        grant['approval_checksum'] = digest({k: v for k, v in grant.items() if k != 'approval_checksum'})
        grants.append(grant)
    return grants


KV_KEYS = ('trading:config', 'trading:risk_config')


def chain_states(chain):
    """Raw KV values at S (0) and after each packet (1..n); packets must link end to start."""
    first = chain[0]
    states = [{'trading:config': first['rollback_config'], 'trading:risk_config': first['rollback_risk_config']}]
    for packet in chain:
        if (packet['rollback_config'] != states[-1]['trading:config']
                or packet['rollback_risk_config'] != states[-1]['trading:risk_config']
                or set(packet['write_order']) - set(KV_KEYS) or set(packet['rollback_order']) != set(packet['write_order'])):
            raise _fail('chain_not_linked')
        states.append({'trading:config': packet['next_config'], 'trading:risk_config': packet['next_risk_config']})
    return states


def step_writes(chain, current, target):
    """(start, writes) for one adjacent step to state `target`; resumes a step whose first writes landed.

    `current` is the raw KV now. Forward steps follow the packet's write order,
    backward steps its rollback order; any other KV value is drift.
    """
    states = chain_states(chain)
    if type(target) is not int or not 0 <= target < len(states):
        raise _fail('step_target')
    if all(current[key] == states[target][key] for key in KV_KEYS):
        return target, []
    for start, packet, order in ((target - 1, chain[target - 1] if target > 0 else None, 'write_order'),
                                 (target + 1, chain[target] if target + 1 < len(states) else None, 'rollback_order')):
        if packet is None:
            continue
        writes = [(key, states[start][key], states[target][key]) for key in packet[order]
                  if states[start][key] != states[target][key]]
        state = dict(states[start])
        for done in range(len(writes)):
            if all(current[key] == state[key] for key in KV_KEYS):
                return start, writes[done:]
            key, _, value = writes[done]
            state[key] = value
    raise _fail('production_config_drift_or_step_not_adjacent')
