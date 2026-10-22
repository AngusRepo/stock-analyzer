"""Policy v2: risk owns the envelope, OPB learns relative arms from replays.

Every arm is a fraction of the risk envelope, so no arm can be clipped into
another. Selection reads the full-information arm-replay ledger: an arm leaves
base only when its decayed paired edge over base minus its HAC standard error
is positive. No exploration bonus, no prior samples, no string tie-break.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import date
import math

from services.l4_distribution import digest, finite

POLICY_SCHEMA = 'l4-distribution-policy-v2'
OPB_SCHEMA = 'l4-opb-relative-arms-v2'
# Objective-only entry/reduce cost semantics; both are part of the policy identity.
SINGLE_SIDE_COST = 'single_side_v1'  # each trade leg pays its own fee (the v1 objective)
ROUND_TRIP_COST = 'entry_round_trip_v1'  # entry pays buy+sell once, a later reduction pays 0
COST_OBJECTIVES = (SINGLE_SIDE_COST, ROUND_TRIP_COST)
LEDGER_SCHEMA = 'l4-opb-arm-replay-v1'
REWARD_SCOPE = 'full_information_arm_replay_paired_with_base'
# Five-session label contract (five_session_gross_decimal): open d+1 -> close d+5.
HORIZON_SESSIONS = 5

ALLOCATOR_KEYS = frozenset({'alpha_strength', 'risk_aversion', 'turnover_penalty', 'l2_penalty',
    'max_cluster_weight', 'cluster_edge_threshold', 'cluster_threshold_quantile',
    'sector_concentration_cap', 'covariance_horizon_sessions',
    'return_history_lookback_sessions', 'cost_objective'})
ENVELOPE_KEYS = frozenset({'exposure_cap', 'name_cap', 'max_positions', 'min_weight', 'buy_cost', 'sell_cost'})
# Policy-only keys the optimizer never receives.
NON_OPTIMIZER_KEYS = frozenset({'return_history_lookback_sessions', 'cost_objective'})


def is_v2(policy):
    return (policy or {}).get('policy_schema') == POLICY_SCHEMA


def allocator_return_history_lookback(l4_policy):
    """The v2 L4 policy owns its risk window; v1 keeps the env-backed window."""
    if is_v2(l4_policy):
        return validate_constraints(l4_policy['constraints'])['return_history_lookback_sessions']
    from services.active_model_policy import gnn_return_history_lookback
    return gnn_return_history_lookback()


def validate_constraints(constraints):
    if not isinstance(constraints, dict) or set(constraints) - ALLOCATOR_KEYS:
        raise ValueError('l4_policy_v2_constraints_not_allocator_owned')
    if constraints.get('cost_objective') not in COST_OBJECTIVES:
        raise ValueError('l4_policy_v2_cost_objective_invalid')
    lookback = constraints.get('return_history_lookback_sessions')
    if type(lookback) is not int or not 60 <= lookback <= 504:
        raise ValueError('l4_policy_v2_lookback_invalid')
    if finite(constraints.get('risk_aversion'), 'risk_aversion') < 0:
        raise ValueError('l4_policy_v2_risk_aversion_invalid')
    return constraints


def risk_envelope(account, nav):
    """The account risk limits and fees are the only envelope owner."""
    hard, fees = account.get('risk_limits'), account.get('fees')
    if not hard or not fees:
        raise ValueError('l4_distribution_canonical_risk_context_missing')
    envelope = {'exposure_cap': finite(hard['exposure_cap'], 'risk_exposure'),
        'name_cap': finite(hard['name_cap'], 'risk_name'),
        'max_positions': hard['max_positions'],
        'min_weight': finite(hard['min_trade_value'], 'min_trade') / nav,
        'buy_cost': finite(fees['buy_cost'], 'buy_cost'), 'sell_cost': finite(fees['sell_cost'], 'sell_cost')}
    if (not 0 <= envelope['exposure_cap'] <= 1 or not 0 <= envelope['name_cap'] <= 1
            or type(envelope['max_positions']) is not int or envelope['max_positions'] < 1
            or not 0 <= envelope['min_weight'] or not 0 <= envelope['buy_cost'] < 1
            or not 0 <= envelope['sell_cost'] < 1):
        raise ValueError('l4_distribution_risk_envelope_invalid')
    return envelope


def objective_costs(buy_costs, sell_costs, cost_objective):
    """(entry, reduce) objective costs; None keeps the single-side v1 objective."""
    if cost_objective == SINGLE_SIDE_COST:
        return None
    if cost_objective != ROUND_TRIP_COST:
        raise ValueError('l4_policy_v2_cost_objective_invalid')
    # Entry pays the full round trip once; a later reduction pays nothing.
    entry = [b + s for b, s in zip(buy_costs, sell_costs, strict=True)]
    return entry, [0.] * len(entry)


def arm_definition(arm):
    body = {'exposure_fraction': finite(arm.get('exposure_fraction', 1.), 'opb_exposure_fraction'),
            'name_fraction': finite(arm.get('name_fraction', 1.), 'opb_name_fraction')}
    if 'risk_aversion' in arm:
        body['risk_aversion'] = finite(arm['risk_aversion'], 'opb_risk_aversion')
    if (not 0 < body['exposure_fraction'] <= 1 or not 0 < body['name_fraction'] <= 1
            or body.get('risk_aversion', 0.) < 0):
        raise ValueError('l4_distribution_opb_arm_outside_envelope')
    return body


def validate_arms(policy):
    """Validate the v2 OPB block and every arm, dormant ones too."""
    config = policy.get('opb') or {}
    if config.get('schema_version') != OPB_SCHEMA:
        raise ValueError('l4_distribution_opb_schema_invalid')
    if set(config) - {'schema_version', 'enabled', 'reward_window_observations', 'reward_half_life_observations',
                      'arms', 'migration', 'approved_policy_identity'}:
        raise ValueError('l4_distribution_opb_unknown_field')
    window, half_life = config.get('reward_window_observations'), config.get('reward_half_life_observations')
    if (type(window) is not int or window < 1 or isinstance(half_life, bool)
            or not isinstance(half_life, (int, float)) or not half_life > 0):
        raise ValueError('l4_distribution_opb_reward_window_invalid')
    arms = config.get('arms') or []
    ids = [arm.get('id') for arm in arms]
    if not arms or ids[0] != 'base' or set(arms[0]) != {'id'}:
        raise ValueError('l4_distribution_opb_base_arm_required')
    if len(ids) != len(set(ids)) or any(not isinstance(key, str) or not key for key in ids):
        raise ValueError('l4_distribution_opb_duplicate_arm')
    allowed = {'id', 'exposure_fraction', 'name_fraction', 'risk_aversion'}
    if any(set(arm) - allowed for arm in arms):
        raise ValueError('l4_distribution_opb_forbidden_override')
    resolved, definitions = [], set()
    for arm in arms:
        definition = arm_definition(arm)
        definition_digest = digest(definition)
        if definition_digest in definitions:
            raise ValueError('l4_distribution_opb_duplicate_arm_definition')
        definitions.add(definition_digest)
        resolved.append((arm['id'], definition, definition_digest))
    return resolved


def arm_policies(policy, envelope):
    """Resolve each validated arm's effective limits inside the risk envelope."""
    allocator = {k: v for k, v in policy['constraints'].items() if k not in NON_OPTIMIZER_KEYS}
    resolved = []
    for arm_id, definition, definition_digest in validate_arms(policy):
        effective = {**deepcopy(allocator), **envelope,
            'exposure_cap': envelope['exposure_cap'] * definition['exposure_fraction'],
            'name_cap': envelope['name_cap'] * definition['name_fraction']}
        if 'risk_aversion' in definition:
            effective['risk_aversion'] = definition['risk_aversion']
        resolved.append({'id': arm_id, 'definition': definition, 'definition_digest': definition_digest,
                         'constraints': effective, 'effective_digest': digest(effective)})
    return resolved


def context_identity(policy, l3_identity):
    """What a replayed arm outcome depends on, except the arm list itself."""
    from services.paired_nav_collection import allocator_source_identity
    body = {'policy_schema': POLICY_SCHEMA, 'model': policy['artifact']['model_checksum'],
            'l3': l3_identity, 'constraints': policy['constraints'],
            'sealed_execution': policy.get('sealedExecution'),
            'allocator_source_identity': digest(allocator_source_identity())}
    return digest(body)


def decayed_paired_edge(values, *, window, half_life, lag):
    """Decayed mean with a Bartlett HAC standard error, floored at iid.

    Observations overlap by `lag` sessions (five-session outcomes), so adjacent
    deltas are dependent. Weights follow the reward window/half-life policy.
    """
    recent = list(values)[-window:]
    n = len(recent)
    if not n:
        return {'samples': 0, 'effective_samples': 0., 'mean': None, 'standard_error': None, 'lower_bound': None}
    decay = math.log(2.) / half_life
    weights = [math.exp(-decay * age) for age in reversed(range(n))]
    total = sum(weights)
    shares = [w / total for w in weights]
    mean = sum(a * x for a, x in zip(shares, recent, strict=True))
    errors = [a * (x - mean) for a, x in zip(shares, recent, strict=True)]
    iid = sum(e * e for e in errors)
    hac = iid + sum(2. * (1. - k / (lag + 1.)) * sum(errors[i] * errors[i - k] for i in range(k, n))
                    for k in range(1, min(lag, n - 1) + 1))
    effective = 1. / sum(a * a for a in shares)
    stats = {'samples': n, 'effective_samples': effective, 'mean': mean,
             'standard_error': math.sqrt(max(hac, iid)), 'lower_bound': None}
    if effective > lag + 1:
        stats['lower_bound'] = mean - stats['standard_error']
    return stats


def select_arm(policy, arms, ledger, *, identity, context, signal_date, envelope, forced_arm=None):
    """Return (effective constraints, opb evidence) for the plan."""
    date.fromisoformat(signal_date)
    config = policy.get('opb') or {}
    if (config.get('enabled') or forced_arm is not None) and config.get('approved_policy_identity') != identity:
        raise ValueError('l4_distribution_opb_policy_identity_missing')
    by_id = {arm['id']: arm for arm in arms}
    window = config['reward_window_observations']
    half_life = config['reward_half_life_observations']
    lag = HORIZON_SESSIONS - 1
    evidence = {'enabled': bool(config.get('enabled')), 'schema_version': OPB_SCHEMA,
        'reward_scope': REWARD_SCOPE, 'context_identity': context,
        'cost_objective': policy['constraints']['cost_objective'],
        'window_observations': window, 'half_life_observations': half_life, 'hac_lag': lag,
        'arm_inert': envelope['exposure_cap'] == 0, 'fabricated_prior_samples': 0}

    def chosen(arm_id, status, statistics=None):
        arm = by_id[arm_id]
        return deepcopy(arm['constraints']), {**evidence, 'status': status, 'arm_id': arm_id,
            'definition_digest': arm['definition_digest'], 'effective_digest': arm['effective_digest'],
            'effective_constraints': deepcopy(arm['constraints']),
            'effective_groups': sorted({a['effective_digest'] for a in arms}),
            'arm_statistics': statistics or {}}

    if forced_arm is not None:
        if forced_arm not in by_id:
            raise ValueError('l4_distribution_opb_forced_arm_unknown')
        return chosen(forced_arm, 'forced_counterfactual')
    if not config.get('enabled'):
        return chosen('base', 'fixed_policy')
    if evidence['arm_inert']:
        return chosen('base', 'arm_inert')
    digests = {arm['definition_digest']: arm['id'] for arm in arms}
    deltas, seen = {arm['id']: [] for arm in arms}, set()
    for row in ledger:
        if row.get('context_identity') != context or row.get('status') != 'complete':
            continue
        known, day, arm_digest = row.get('known_date'), row.get('signal_date'), row.get('arm_digest')
        if (row.get('schema_version') != LEDGER_SCHEMA
                or not all(isinstance(value, str) for value in (known, day, arm_digest))
                or not day < known <= signal_date):
            raise ValueError('l4_distribution_opb_reward_contract_invalid')
        date.fromisoformat(known)
        date.fromisoformat(day)
        arm_id = digests.get(arm_digest)
        # A replay of an arm since removed from the policy carries no evidence.
        if arm_id is None:
            continue
        key = (row['arm_digest'], row['signal_date'])
        if key in seen:
            raise ValueError('l4_distribution_opb_duplicate_reward')
        seen.add(key)
        deltas[arm_id].append((row['signal_date'], finite(row['delta'], 'opb_delta')))
    statistics = {}
    for arm in arms:
        series = [value for _, value in sorted(deltas[arm['id']])]
        statistics[arm['id']] = {**decayed_paired_edge(series, window=window, half_life=half_life, lag=lag),
            'definition_digest': arm['definition_digest'], 'effective_digest': arm['effective_digest']}
    if not seen:
        return chosen('base', 'cold_start_base', statistics)
    bounds = [(stat['lower_bound'], arm_id) for arm_id, stat in statistics.items()
              if arm_id != 'base' and stat['lower_bound'] is not None and stat['lower_bound'] > 0]
    if not bounds:
        return chosen('base', 'no_positive_paired_edge', statistics)
    best = max(bound for bound, _ in bounds)
    leaders = [arm_id for bound, arm_id in bounds if bound == best]
    if len(leaders) != 1:
        return chosen('base', 'tied_paired_edge', statistics)
    return chosen(leaders[0], 'learned_policy', statistics)
