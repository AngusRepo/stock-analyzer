"""Policy v2: risk owns the envelope, OPB learns relative arms from replays.

OPB v2 (`l4-opb-relative-arms-v2`): every arm is a fraction of the risk
envelope, so no arm can be clipped into another. Selection reads the
full-information arm-replay ledger: an arm leaves base only when its decayed
paired edge over base minus its HAC standard error is positive.

OPB v3 (`l4-opb-selection-arms-v3`): risk owns the exposure; an arm may not
scale it. Arms differ only in how the allocator selects and weights names
(name concentration, risk aversion, ridge, cluster and sector caps, turnover).
The reward is exposure-normalized (each arm's return per unit of invested
weight, at base's exposure, minus base), so a market move no longer rewards a
smaller book. An arm leaves base only when its decayed edge minus a calibrated
critical value times its HAC standard error is positive; the critical value
controls the family-wise false-leave rate over all arms by simulation of the
same estimator on overlapping five-session null series.

Both: no exploration bonus, no prior samples, no string tie-break, and no
reward from another L3 or allocator identity (the context keys the ledger).
"""
from __future__ import annotations

from copy import deepcopy
from datetime import date
from functools import lru_cache
import math

import numpy as np

from services.l4_distribution import digest, finite

POLICY_SCHEMA = 'l4-distribution-policy-v2'
OPB_SCHEMA = 'l4-opb-relative-arms-v2'
# Objective-only entry/reduce cost semantics; both are part of the policy identity.
SINGLE_SIDE_COST = 'single_side_v1'  # each trade leg pays its own fee (the v1 objective)
ROUND_TRIP_COST = 'entry_round_trip_v1'  # entry pays buy+sell once, a later reduction pays 0
COST_OBJECTIVES = (SINGLE_SIDE_COST, ROUND_TRIP_COST)
LEDGER_SCHEMA = 'l4-opb-arm-replay-v1'
REWARD_SCOPE = 'full_information_arm_replay_paired_with_base'
OPB_SCHEMA_V3 = 'l4-opb-selection-arms-v3'
LEDGER_SCHEMA_V2 = 'l4-opb-arm-replay-v2'
# One row per (signal day, arm, session of the five-session hold). The piece is the
# session's contribution to the five-session label (entry open -> exit close sums
# exactly; entry/rebalance cost on session 1). delta = arm_piece * base_exposure /
# arm_exposure - base_piece. Selection regresses the session-averaged delta on the
# same session's market-proxy piece and tests the intercept: return per unit of invested
# weight, net of market beta, i.e. selection and weighting, not exposure timing.
REWARD_EXPOSURE_NORMALIZED = 'exposure_normalized_market_neutral_daily_v1'
# Market proxy of the v3 reward (its piece in the market-neutral regression, and the
# replay's session calendar): KV trading:config l4Distribution.opb.market_proxy, owner
# trading:config, never searched by Optuna (config/kv/manifest.json). This is the
# schema default when the field is absent; an explicit value equal to it is the same
# policy, so neither the ledger context nor the approved policy identity moves.
MARKET_PROXY_DEFAULT = '0050'
# TW ETF codes only (00 + 2-4 digits): the five-session label calendar
# (forward_net_return) stays on 0050, and a single stock's halt days would put the
# replay calendar out of step with it.
MARKET_PROXY_PATTERN = r'00[0-9]{2,4}'
# Row kinds of the v2 ledger. Only `live_context` rows are unconditional evidence;
# the other two count only when the policy's own KV switch admits them.
ROW_LIVE = 'live_context'
ROW_COUNTERFACTUAL_INERT = 'counterfactual_inert'
ROW_CUTOVER_WARM_START = 'cutover_warm_start'
ROW_KINDS = (ROW_LIVE, ROW_COUNTERFACTUAL_INERT, ROW_CUTOVER_WARM_START)
# v3 arms override allocator selection parameters only. Exposure and the
# single-name cap stay with risk (a smaller name cap would shrink a 5-slot book).
V3_ARM_KEYS = ('risk_aversion', 'l2_penalty', 'max_cluster_weight', 'sector_concentration_cap', 'turnover_penalty')
V3_CONFIG_KEYS = frozenset({'schema_version', 'enabled', 'reward_window_observations', 'reward_half_life_observations',
    'arms', 'migration', 'approved_policy_identity', 'reward', 'family_error_rate', 'critical_value_simulations',
    'inert_counterfactual', 'cutover_warm_start', 'hac_lag_sessions', 'min_exposure_ratio', 'market_proxy'})
# Fixed simulation stream: the critical value is a pure function of its inputs,
# so a replayed plan reproduces the same choice. Not a trading parameter.
CRITICAL_VALUE_SEED = 20261124
# Monte Carlo runs in chunks of at most this many cells (paths x arms x sessions:
# bounded memory in the plan path); simulations x arms x window above the cell
# budget is rejected at validation.
CRITICAL_VALUE_CHUNK_CELLS = 2_000_000
MAX_SIMULATION_CELLS = 60_000_000
# Five-session label contract (five_session_gross_decimal): open d+1 -> close d+5.
HORIZON_SESSIONS = 5
# Degrees of freedom the market-neutral regression spends: alpha (intercept) and beta
# (market slope). An estimate needs more effective sessions than HAC lag + these two
# (market_neutral_edge, critical_value). A mathematical bound, not a trading parameter:
# no KV entry.
REGRESSION_PARAMETERS = 2

ALLOCATOR_KEYS = frozenset({'alpha_strength', 'risk_aversion', 'turnover_penalty', 'l2_penalty',
    'max_cluster_weight', 'cluster_edge_threshold', 'cluster_threshold_quantile',
    'sector_concentration_cap', 'covariance_horizon_sessions',
    'return_history_lookback_sessions', 'cost_objective'})
ENVELOPE_KEYS = frozenset({'exposure_cap', 'name_cap', 'max_positions', 'min_weight', 'buy_cost', 'sell_cost'})
# Policy-only keys the optimizer never receives.
NON_OPTIMIZER_KEYS = frozenset({'return_history_lookback_sessions', 'cost_objective'})


def market_proxy(policy):
    """The v3 market proxy of an l4Distribution policy (or its opb block); fail closed."""
    import re
    config = (policy.get('opb') if 'opb' in policy else policy) or {}
    value = config.get('market_proxy', MARKET_PROXY_DEFAULT)
    if not isinstance(value, str) or not re.fullmatch(MARKET_PROXY_PATTERN, value):
        raise ValueError('l4_distribution_opb_market_proxy_invalid')
    return value


def canonical_opb(config):
    """The opb block as identities see it: a market proxy equal to the default is the
    same as an absent one (writing the default into KV later moves nothing)."""
    if isinstance(config, dict) and config.get('market_proxy') == MARKET_PROXY_DEFAULT:
        return {k: v for k, v in config.items() if k != 'market_proxy'}
    return config


def canonical_policy(policy):
    """canonical_opb applied to a whole l4Distribution policy (other fields untouched)."""
    if isinstance(policy, dict) and isinstance(policy.get('opb'), dict) and canonical_opb(policy['opb']) is not policy['opb']:
        return {**policy, 'opb': canonical_opb(policy['opb'])}
    return policy


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


def is_v3(policy):
    return ((policy or {}).get('opb') or {}).get('schema_version') == OPB_SCHEMA_V3


def _unit_interval(value, field):
    number = finite(value, field)
    if not 0 < number <= 1:
        raise ValueError('l4_distribution_opb_v3_arm_invalid:' + field)
    return number


def _non_negative(value, field):
    number = finite(value, field)
    if number < 0:
        raise ValueError('l4_distribution_opb_v3_arm_invalid:' + field)
    return number


V3_ARM_VALIDATORS = {'risk_aversion': _non_negative, 'l2_penalty': _non_negative,
                     'max_cluster_weight': _unit_interval, 'sector_concentration_cap': _unit_interval,
                     'turnover_penalty': _non_negative}


def arm_definition_v3(arm):
    """Only the overrides an arm declares; base declares none."""
    if set(arm) - {'id', *V3_ARM_KEYS}:
        raise ValueError('l4_distribution_opb_forbidden_override')
    return {key: V3_ARM_VALIDATORS[key](arm[key], key) for key in V3_ARM_KEYS if key in arm}


def policy_arm_definition(policy, arm):
    return arm_definition_v3(arm) if is_v3(policy) else arm_definition(arm)


def arm_definition(arm):
    body = {'exposure_fraction': finite(arm.get('exposure_fraction', 1.), 'opb_exposure_fraction'),
            'name_fraction': finite(arm.get('name_fraction', 1.), 'opb_name_fraction')}
    if 'risk_aversion' in arm:
        body['risk_aversion'] = finite(arm['risk_aversion'], 'opb_risk_aversion')
    if (not 0 < body['exposure_fraction'] <= 1 or not 0 < body['name_fraction'] <= 1
            or body.get('risk_aversion', 0.) < 0):
        raise ValueError('l4_distribution_opb_arm_outside_envelope')
    return body


def validate_v3_config(config):
    """The v3 knobs are explicit KV fields; none has a code default."""
    if set(config) - V3_CONFIG_KEYS:
        raise ValueError('l4_distribution_opb_unknown_field')
    if config.get('reward') != REWARD_EXPOSURE_NORMALIZED:
        raise ValueError('l4_distribution_opb_v3_reward_invalid')
    market_proxy(config)
    alpha = config.get('family_error_rate')
    if isinstance(alpha, bool) or not isinstance(alpha, (int, float)) or not 0 < alpha <= .5:
        raise ValueError('l4_distribution_opb_v3_family_error_rate_invalid')
    lag = config.get('hac_lag_sessions')
    if type(lag) is not int or not 0 <= lag <= 10:
        raise ValueError('l4_distribution_opb_v3_hac_lag_invalid')
    simulations = config.get('critical_value_simulations')
    if type(simulations) is not int or not 1000 <= simulations <= 200000:
        raise ValueError('l4_distribution_opb_v3_simulations_invalid')
    ratio = config.get('min_exposure_ratio')
    if isinstance(ratio, bool) or not isinstance(ratio, (int, float)) or not 0 < ratio <= 1:
        raise ValueError('l4_distribution_opb_v3_min_exposure_ratio_invalid')
    if config['critical_value_simulations'] * len(config.get('arms') or ()) * config['reward_window_observations'] > MAX_SIMULATION_CELLS:
        raise ValueError('l4_distribution_opb_v3_simulation_budget_exceeded')
    inert = config.get('inert_counterfactual')
    keys = ('reference_exposure_cap', 'reference_name_cap')
    if (not isinstance(inert, dict) or set(inert) != {'enabled', *keys}
            or not isinstance(inert['enabled'], bool)):
        raise ValueError('l4_distribution_opb_v3_inert_counterfactual_invalid')
    if inert['enabled']:
        if any(isinstance(inert[k], bool) or not isinstance(inert[k], (int, float)) or not 0 < inert[k] <= 1
               for k in keys) or inert['reference_name_cap'] > inert['reference_exposure_cap']:
            raise ValueError('l4_distribution_opb_v3_inert_counterfactual_invalid')
    elif any(inert[k] is not None for k in keys):
        raise ValueError('l4_distribution_opb_v3_inert_counterfactual_invalid')
    warm = config.get('cutover_warm_start')
    if (not isinstance(warm, dict) or set(warm) != {'enabled', 'max_observations'}
            or not isinstance(warm['enabled'], bool) or type(warm['max_observations']) is not int
            or not 0 <= warm['max_observations'] <= config['reward_window_observations']):
        raise ValueError('l4_distribution_opb_v3_cutover_warm_start_invalid')


def validate_arms(policy):
    """Validate the OPB block (v2 or v3) and every arm, dormant ones too."""
    config = policy.get('opb') or {}
    v3 = config.get('schema_version') == OPB_SCHEMA_V3
    if config.get('schema_version') != OPB_SCHEMA and not v3:
        raise ValueError('l4_distribution_opb_schema_invalid')
    if not v3 and set(config) - {'schema_version', 'enabled', 'reward_window_observations',
                                 'reward_half_life_observations', 'arms', 'migration', 'approved_policy_identity'}:
        raise ValueError('l4_distribution_opb_unknown_field')
    window, half_life = config.get('reward_window_observations'), config.get('reward_half_life_observations')
    if (type(window) is not int or window < 1 or isinstance(half_life, bool)
            or not isinstance(half_life, (int, float)) or not half_life > 0):
        raise ValueError('l4_distribution_opb_reward_window_invalid')
    if v3:
        validate_v3_config(config)
    arms = config.get('arms') or []
    ids = [arm.get('id') for arm in arms]
    if not arms or ids[0] != 'base' or set(arms[0]) != {'id'}:
        raise ValueError('l4_distribution_opb_base_arm_required')
    if len(ids) != len(set(ids)) or any(not isinstance(key, str) or not key for key in ids):
        raise ValueError('l4_distribution_opb_duplicate_arm')
    allowed = {'id', *V3_ARM_KEYS} if v3 else {'id', 'exposure_fraction', 'name_fraction', 'risk_aversion'}
    if any(set(arm) - allowed for arm in arms):
        raise ValueError('l4_distribution_opb_forbidden_override')
    resolved, definitions = [], set()
    for arm in arms:
        definition = arm_definition_v3(arm) if v3 else arm_definition(arm)
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
    if is_v3(policy):
        for arm_id, definition, definition_digest in validate_arms(policy):
            effective = {**deepcopy(allocator), **envelope, **definition}
            resolved.append({'id': arm_id, 'definition': definition, 'definition_digest': definition_digest,
                             'constraints': effective, 'effective_digest': digest(effective)})
        return resolved
    for arm_id, definition, definition_digest in validate_arms(policy):
        effective = {**deepcopy(allocator), **envelope,
            'exposure_cap': envelope['exposure_cap'] * definition['exposure_fraction'],
            'name_cap': envelope['name_cap'] * definition['name_fraction']}
        if 'risk_aversion' in definition:
            effective['risk_aversion'] = definition['risk_aversion']
        resolved.append({'id': arm_id, 'definition': definition, 'definition_digest': definition_digest,
                         'constraints': effective, 'effective_digest': digest(effective)})
    return resolved


DECISION_INPUTS_SCHEMA = 'l4-opb-decision-inputs-v1'


def decision_inputs_digest(recommendations, policy, return_history, reward_ledger):
    """Digest of what a v3 plan's arm choice and arm targets are a function of, code aside.

    The plan stores it at decision time; the replay recomputes it from the frozen
    allocation snapshot (the same inputs, JSON round-tripped) and compares only
    this, so the check holds across any deploy between the plan and its replay.
    None when the inputs are not JSON-encodable (no snapshot could hold them).
    """
    import json
    body = {'schema_version': DECISION_INPUTS_SCHEMA, 'recommendations': recommendations,
            'policy': {k: v for k, v in policy.items() if k != '_account_rewards'},
            'return_history': return_history or {}, 'reward_ledger': list(reward_ledger or ())}
    try:
        return digest(json.loads(json.dumps(body, sort_keys=True, allow_nan=False)))
    except (TypeError, ValueError):
        return None


def context_identity(policy, l3_identity):
    """What a replayed arm outcome depends on, except the arm list itself."""
    from services.paired_nav_collection import allocator_source_identity
    body = {'policy_schema': POLICY_SCHEMA, 'model': policy['artifact']['model_checksum'],
            'l3': l3_identity, 'constraints': policy['constraints'],
            'sealed_execution': policy.get('sealedExecution'),
            'allocator_source_identity': digest(allocator_source_identity())}
    if is_v3(policy):
        # The reward semantic and the counterfactual envelope change what a row means.
        config = policy['opb']
        body.update(opb_schema=OPB_SCHEMA_V3, reward=config['reward'],
                    inert_counterfactual=config['inert_counterfactual'])
        # The proxy is what the market piece of every row is; another proxy is another
        # ledger. Only a non-default proxy enters the body, so the default keeps the
        # identity every existing context already has (absent == explicit default).
        proxy = market_proxy(config)
        if proxy != MARKET_PROXY_DEFAULT:
            body['market_proxy'] = proxy
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


def _decay_shares(m, half_life):
    decay = math.log(2.) / half_life
    weights = np.exp(-decay * np.arange(m - 1, -1, -1, dtype=float))
    return weights / weights.sum()


def _intercept_statistics(series, market, shares, lag):
    """Weighted LS of series on [1, market]; Bartlett HAC (floored at iid) for both coefficients.

    `series` is (..., m) and `market` (..., m) broadcastable; returns intercept,
    slope and the intercept's standard error, all shaped (...).
    """
    a = shares
    sw = a.sum()
    mx = (a * market).sum(axis=-1, keepdims=True) / sw
    my = (a * series).sum(axis=-1, keepdims=True) / sw
    dx = market - mx
    sxx = (a * dx * dx).sum(axis=-1, keepdims=True)
    slope = np.where(sxx > 0, (a * dx * (series - my)).sum(axis=-1, keepdims=True) / np.where(sxx > 0, sxx, 1.), 0.)
    intercept = my - slope * mx
    resid = series - intercept - slope * market
    # Scores of the two normal equations; (X'AX)^-1 maps them to the coefficients.
    g0, g1 = a * resid, a * market * resid
    s00, s01, s11 = sw, (a * market).sum(axis=-1, keepdims=True), (a * market * market).sum(axis=-1, keepdims=True)
    det = s00 * s11 - s01 * s01
    inv00 = np.where(det > 0, s11 / np.where(det > 0, det, 1.), 1. / s00)
    inv01 = np.where(det > 0, -s01 / np.where(det > 0, det, 1.), 0.)
    h = inv00 * g0 + inv01 * g1          # influence of each session on the intercept
    iid = (h * h).sum(axis=-1)
    hac = iid.copy()
    m = series.shape[-1]
    for k in range(1, min(lag, m - 1) + 1):
        hac = hac + 2. * (1. - k / (lag + 1.)) * (h[..., k:] * h[..., :-k]).sum(axis=-1)
    return intercept[..., 0], slope[..., 0], np.sqrt(np.maximum(hac, iid))


def market_neutral_edge(deltas, market, *, window, half_life, lag):
    """Decayed, market-neutral intercept of a session series (oldest first)."""
    recent, proxy = list(deltas)[-window:], list(market)[-window:]
    n = len(recent)
    if not n:
        return {'samples': 0, 'effective_samples': 0., 'mean': None, 'beta': None, 'standard_error': None}
    shares = _decay_shares(n, half_life)
    effective = 1. / float((shares * shares).sum())
    if effective <= lag + REGRESSION_PARAMETERS:
        return {'samples': n, 'effective_samples': effective, 'mean': None, 'beta': None, 'standard_error': None}
    alpha, beta, error = _intercept_statistics(np.asarray(recent, float), np.asarray(proxy, float), shares, lag)
    return {'samples': n, 'effective_samples': effective, 'mean': float(alpha), 'beta': float(beta),
            'standard_error': float(error)}


@lru_cache(maxsize=512)
def critical_value(observations, arms, family_error_rate, window, half_life, lag, simulations):
    """(1 - alpha) quantile of the largest arm intercept t-statistic under no edge, or None.

    Null: each arm's session delta and the market piece are iid normal, arms
    independent of each other (conservative when arms are positively
    correlated). The statistic is the exact estimator selection uses, so its
    small-sample behaviour (few effective sessions, HAC noise) is calibrated.

    The guarantee is per plan: on any one day, P(some zero-edge arm clears the
    bar) <= alpha. The test re-runs daily, so over months a zero-edge arm will
    be chosen on some days (about alpha of them, fewer when deltas are
    negatively autocorrelated); a zero-edge arm costs nothing in expectation.
    """
    m = min(int(observations), int(window))
    if m < 1 or arms < 1:
        return None
    shares = _decay_shares(m, half_life)
    if 1. / float((shares * shares).sum()) <= lag + REGRESSION_PARAMETERS:
        return None
    rng = np.random.Generator(np.random.PCG64(CRITICAL_VALUE_SEED))
    statistic, left = [], int(simulations)
    while left:
        size = min(left, max(1, CRITICAL_VALUE_CHUNK_CELLS // (int(arms) * m)))
        series = rng.standard_normal((size, int(arms), m))
        market = rng.standard_normal((size, 1, m))
        alpha, _, error = _intercept_statistics(series, market, shares, lag)
        statistic.append((alpha / error).max(axis=1))
        left -= size
    return float(np.quantile(np.concatenate(statistic), 1. - float(family_error_rate)))


def _v3_series(config, arms, ledger, *, context, signal_date):
    """Session series per arm from admitted, complete v2-ledger rows.

    For each session, the arm's delta is the mean over the signal days whose
    hold covers it. Warm-start rows (the new L3's fold-OOF replay of
    pre-cutover days, same context) count only when admitted, and only for
    the most recent `max_observations` signal days.
    """
    admitted = {ROW_LIVE}
    if config['inert_counterfactual']['enabled']:
        admitted.add(ROW_COUNTERFACTUAL_INERT)
    if config['cutover_warm_start']['enabled']:
        admitted.add(ROW_CUTOVER_WARM_START)
    digests = {arm['definition_digest']: arm['id'] for arm in arms}
    floor = config['min_exposure_ratio']
    kept, seen, market, conflicts = [], set(), {}, set()
    for row in ledger:
        if row.get('context_identity') != context or row.get('status') != 'complete':
            continue
        known, day, arm_digest = row.get('known_date'), row.get('signal_date'), row.get('arm_digest')
        offset = row.get('session_offset')
        if (row.get('schema_version') != LEDGER_SCHEMA_V2 or row.get('reward_semantic') != REWARD_EXPOSURE_NORMALIZED
                or row.get('row_kind') not in ROW_KINDS or type(offset) is not int
                or not 1 <= offset <= HORIZON_SESSIONS
                or not all(isinstance(value, str) for value in (known, day, arm_digest))
                or not day < known <= signal_date):
            raise ValueError('l4_distribution_opb_reward_contract_invalid')
        date.fromisoformat(known)
        date.fromisoformat(day)
        key = (arm_digest, day, offset)
        if key in seen:
            raise ValueError('l4_distribution_opb_duplicate_reward')
        seen.add(key)
        piece = finite(row['market_piece'], 'opb_market_piece')
        # Every arm of one signal day shares the same market-proxy piece and session date per
        # offset (pieces are scaled by that day's entry open, so tranches differ).
        # A mismatch (re-adjusted prices, a back-filled calendar row) drops that
        # signal day from the evidence instead of failing every later plan.
        if market.setdefault((day, offset), (known, piece)) != (known, piece):
            conflicts.add(day)
        arm_id = digests.get(arm_digest)
        arm_exposure = finite(row['arm_exposure'], 'opb_arm_exposure')
        base_exposure = finite(row['base_exposure'], 'opb_base_exposure')
        # A barely invested arm would have its piece multiplied by E_base/E_arm.
        thin = not base_exposure > 0 or arm_exposure < floor * base_exposure
        if row['row_kind'] in admitted and arm_id is not None and not thin:
            kept.append((row['row_kind'], arm_id, day, known, offset, finite(row['delta'], 'opb_delta'), piece))
    kept = [item for item in kept if item[2] not in conflicts]
    warm = sorted({day for kind, _, day, *_ in kept if kind == ROW_CUTOVER_WARM_START})
    limit = config['cutover_warm_start']['max_observations']
    allowed_warm = set(warm[max(0, len(warm) - limit):]) if limit else set()
    sessions = {arm['id']: {} for arm in arms}
    counted = {kind: 0 for kind in ROW_KINDS}
    counted['conflicting_signal_days'] = len(conflicts)
    for kind, arm_id, day, known, offset, value, piece in kept:
        if kind == ROW_CUTOVER_WARM_START and day not in allowed_warm:
            continue
        counted[kind] += 1
        # Session 1 is open->close and session 2..5 close->close; the market piece
        # follows the same convention, so average both within the session.
        bucket = sessions[arm_id].setdefault(known, [[], []])
        bucket[0].append(value)
        bucket[1].append(piece)
    series = {}
    for arm_id, by_session in sessions.items():
        ordered = sorted(by_session)
        series[arm_id] = ([sum(by_session[d][0]) / len(by_session[d][0]) for d in ordered],
                          [sum(by_session[d][1]) / len(by_session[d][1]) for d in ordered], ordered)
    return series, bool(kept), counted


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
    evidence = {'enabled': bool(config.get('enabled')), 'schema_version': config.get('schema_version', OPB_SCHEMA),
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
    if is_v3(policy):
        return _select_v3(config, arms, ledger, evidence, chosen, context=context, signal_date=signal_date,
                          window=window, half_life=half_life, lag=lag)
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


def _select_v3(config, arms, ledger, evidence, chosen, *, context, signal_date, window, half_life, lag):
    lag = config['hac_lag_sessions']
    series, any_rows, counted = _v3_series(config, arms, ledger, context=context, signal_date=signal_date)
    challengers = [arm for arm in arms if arm['id'] != 'base']
    alpha = float(config['family_error_rate'])
    evidence.update(reward=config['reward'], reward_scope=config['reward'], market_proxy=market_proxy(config),
                    family_error_rate=alpha, min_exposure_ratio=config['min_exposure_ratio'],
                    hac_lag=lag, hac_lag_sessions=lag, rows_counted=counted,
                    critical_value_simulations=config['critical_value_simulations'],
                    inert_counterfactual=deepcopy(config['inert_counterfactual']),
                    cutover_warm_start=deepcopy(config['cutover_warm_start']))
    statistics = {}
    for arm in arms:
        deltas, market, sessions = series[arm['id']]
        stats = market_neutral_edge(deltas, market, window=window, half_life=half_life, lag=lag)
        critical = (critical_value(stats['samples'], len(challengers), alpha, window, half_life, lag,
                                   config['critical_value_simulations'])
                    if arm['id'] != 'base' and challengers and stats['mean'] is not None else None)
        stats.update(critical_value=critical, last_session=sessions[-1] if sessions else None,
                     lower_bound=(stats['mean'] - critical * stats['standard_error'] if critical is not None else None))
        statistics[arm['id']] = {**stats, 'definition_digest': arm['definition_digest'],
                                 'effective_digest': arm['effective_digest']}
    if not any_rows:
        return chosen('base', 'cold_start_base', statistics)
    bounds = [(stat['lower_bound'], arm_id) for arm_id, stat in statistics.items()
              if arm_id != 'base' and stat['lower_bound'] is not None and stat['lower_bound'] > 0]
    if not bounds:
        return chosen('base', 'no_calibrated_edge', statistics)
    best = max(bound for bound, _ in bounds)
    leaders = [arm_id for bound, arm_id in bounds if bound == best]
    if len(leaders) != 1:
        return chosen('base', 'tied_paired_edge', statistics)
    return chosen(leaders[0], 'learned_policy', statistics)
