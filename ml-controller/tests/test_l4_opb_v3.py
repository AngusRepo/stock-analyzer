"""OPB v3: selection arms (no exposure scaling), exposure-normalized market-neutral reward,
calibrated family-wise threshold, and KV-gated counterfactual / warm-start rows."""
from copy import deepcopy
from datetime import date, timedelta

import numpy as np
import pytest

from services.l4_opb_selection import (LEDGER_SCHEMA_V2, OPB_SCHEMA, OPB_SCHEMA_V3, POLICY_SCHEMA,
    REWARD_EXPOSURE_NORMALIZED, ROW_COUNTERFACTUAL_INERT, ROW_CUTOVER_WARM_START, ROW_LIVE, arm_policies,
    context_identity, critical_value, market_neutral_edge, select_arm, validate_arms)

ENVELOPE = {'exposure_cap': .45, 'name_cap': .25, 'max_positions': 5, 'min_weight': .03,
            'buy_cost': .001425, 'sell_cost': .004425}
CONSTRAINTS = {'risk_aversion': 2., 'alpha_strength': 1., 'return_history_lookback_sessions': 252,
               'cost_objective': 'entry_round_trip_v1'}


def opb(**overrides):
    body = {'schema_version': OPB_SCHEMA_V3, 'enabled': True, 'reward_window_observations': 60,
            'reward_half_life_observations': 20., 'approved_policy_identity': 'x' * 64,
            'reward': REWARD_EXPOSURE_NORMALIZED, 'family_error_rate': .1, 'critical_value_simulations': 4000,
            'hac_lag_sessions': 2, 'min_exposure_ratio': .5,
            'inert_counterfactual': {'enabled': False, 'reference_exposure_cap': None, 'reference_name_cap': None},
            'cutover_warm_start': {'enabled': False, 'max_observations': 0},
            'arms': [{'id': 'base'}, {'id': 'alpha_tilt', 'risk_aversion': .5}, {'id': 'ridge', 'l2_penalty': .02}]}
    body.update(overrides)
    return body


def policy(**overrides):
    return {'policy_schema': POLICY_SCHEMA, 'artifact': {'model_checksum': 'a' * 64},
            'constraints': deepcopy(CONSTRAINTS), 'opb': opb(**overrides)}


def sessions(n, start=date(2026, 1, 5)):
    out, day = [], start
    while len(out) < n:
        if day.weekday() < 5:
            out.append(day.isoformat())
        day += timedelta(days=1)
    return out


def ledger(value, deltas_by_arm, *, market=None, kind=ROW_LIVE, start=date(2026, 1, 5), status='complete'):
    """Rows of one signal day per session: signal day = previous session, offset 1."""
    arms = {a['id']: a for a in arm_policies(value, ENVELOPE)}
    n = max(len(v) for v in deltas_by_arm.values())
    days = sessions(n + 1, start)
    market = market if market is not None else [0.] * n
    rows = []
    for arm_id, deltas in deltas_by_arm.items():
        for i, delta in enumerate(deltas):
            rows.append({'context_identity': 'ctx', 'signal_date': days[i], 'known_date': days[i + 1],
                         'arm_digest': arms[arm_id]['definition_digest'], 'session_offset': 1,
                         'schema_version': LEDGER_SCHEMA_V2, 'reward_semantic': REWARD_EXPOSURE_NORMALIZED,
                         'row_kind': kind, 'status': status, 'delta': delta, 'market_piece': market[i],
                         'arm_exposure': .4, 'base_exposure': .4})
    return rows


def select(rows, value=None, envelope=ENVELOPE, **kwargs):
    value = value or policy()
    return select_arm(value, arm_policies(value, envelope), rows, identity='x' * 64, context='ctx',
                      signal_date='2027-12-31', envelope=envelope, **kwargs)


def test_v3_arms_override_selection_parameters_and_never_the_exposure():
    arms = {a['id']: a for a in arm_policies(policy(), ENVELOPE)}
    assert arms['base']['constraints'] == {'risk_aversion': 2., 'alpha_strength': 1., **ENVELOPE}
    assert arms['alpha_tilt']['constraints'] == {'risk_aversion': .5, 'alpha_strength': 1., **ENVELOPE}
    assert arms['ridge']['constraints']['l2_penalty'] == .02
    assert {a['constraints']['exposure_cap'] for a in arms.values()} == {.45}
    assert {a['constraints']['name_cap'] for a in arms.values()} == {.25}
    for bad in ({'id': 'x', 'exposure_fraction': .8}, {'id': 'x', 'name_fraction': .8},
                {'id': 'x', 'alpha_strength': 2.}, {'id': 'x', 'max_cluster_weight': 0.},
                {'id': 'x', 'risk_aversion': -1.}):
        value = policy(arms=[{'id': 'base'}, bad])
        with pytest.raises(ValueError):
            validate_arms(value)
    with pytest.raises(ValueError, match='duplicate_arm_definition'):
        validate_arms(policy(arms=[{'id': 'base'}, {'id': 'a', 'l2_penalty': .1}, {'id': 'b', 'l2_penalty': .1}]))


@pytest.mark.parametrize('field,value', [
    ('reward', 'raw_v2'), ('family_error_rate', 0.), ('family_error_rate', .6), ('critical_value_simulations', 10),
    ('hac_lag_sessions', -1), ('inert_counterfactual', {'enabled': True, 'reference_exposure_cap': None, 'reference_name_cap': .0625}),
    ('inert_counterfactual', {'enabled': True, 'reference_exposure_cap': .2, 'reference_name_cap': .3}),
    ('inert_counterfactual', {'enabled': True, 'reference_exposure_cap': .2}),
    ('inert_counterfactual', {'enabled': False, 'reference_exposure_cap': .2, 'reference_name_cap': None}),
    ('cutover_warm_start', {'enabled': True, 'max_observations': 61}), ('exploration', .05),
    ('min_exposure_ratio', 0.), ('min_exposure_ratio', None)])
def test_v3_knobs_are_explicit_and_validated(field, value):
    with pytest.raises(ValueError):
        validate_arms(policy(**{field: value}))
    missing = policy()
    missing['opb'].pop('family_error_rate')
    with pytest.raises(ValueError):
        validate_arms(missing)


def test_context_carries_reward_semantic_and_counterfactual_reference(monkeypatch):
    from services import paired_nav_collection
    monkeypatch.setattr(paired_nav_collection, 'allocator_source_identity', lambda: {'x': 'y'})
    base = policy()
    other = policy(inert_counterfactual={'enabled': True, 'reference_exposure_cap': .2, 'reference_name_cap': .0625})
    v2 = deepcopy(base)
    v2['opb'] = {'schema_version': OPB_SCHEMA}
    contexts = {context_identity(p, {'l3': 1}) for p in (base, other, v2)}
    assert len(contexts) == 3
    # The decision knobs (alpha, arms) are not part of the context: rows survive a retune.
    assert context_identity(policy(family_error_rate=.2), {'l3': 1}) == context_identity(base, {'l3': 1})


def test_critical_value_controls_the_family_wise_false_leave_rate():
    rng = np.random.default_rng(7)
    lag, window, half_life, alpha, arms = 2, 60, 20., .1, 3
    for n in (12, 30):
        c = critical_value(n, arms, alpha, window, half_life, lag, 20000)
        shares = None
        leaves = 0
        trials = 1500
        for _ in range(trials):
            market = rng.standard_normal(n)
            best = max((st['mean'] / st['standard_error'])
                       for st in (market_neutral_edge(rng.standard_normal(n), market, window=window,
                                                      half_life=half_life, lag=lag) for _ in range(arms)))
            leaves += best > c
        assert abs(leaves / trials - alpha) < .03, (n, leaves / trials)
    assert critical_value(4, arms, alpha, window, half_life, lag, 4000) is None
    # More arms, stricter; more sessions, looser.
    assert critical_value(20, 5, alpha, window, half_life, lag, 4000) > critical_value(20, 1, alpha, window, half_life, lag, 4000)
    assert critical_value(40, 3, alpha, window, half_life, lag, 4000) < critical_value(10, 3, alpha, window, half_life, lag, 4000)


def test_market_neutral_edge_removes_beta_and_scale():
    rng = np.random.default_rng(3)
    market = rng.normal(0., .01, 40)
    noise = rng.normal(0., .0005, 40)
    # A high-beta arm in a rising market has a raw edge but no alpha.
    beta_only = 0.3 * (market + .004)
    stats = market_neutral_edge(beta_only + noise, market + .004, window=60, half_life=20., lag=2)
    assert abs(stats['mean']) < 3 * stats['standard_error']
    assert stats['beta'] == pytest.approx(.3, abs=.05)
    skilled = market_neutral_edge(.001 + noise, market, window=60, half_life=20., lag=2)
    assert skilled['mean'] / skilled['standard_error'] > 5


def test_selection_learns_a_consistent_alpha_and_ignores_pure_beta():
    rng = np.random.default_rng(11)
    n = 30
    market = list(rng.normal(.003, .01, n))
    value = policy()
    good = ledger(value, {'base': [0.] * n, 'alpha_tilt': list(.001 + rng.normal(0., .0006, n)),
                          'ridge': [0.4 * m for m in market]}, market=market)
    constraints, evidence = select(good, value)
    assert evidence['status'] == 'learned_policy' and evidence['arm_id'] == 'alpha_tilt'
    assert evidence['arm_statistics']['alpha_tilt']['critical_value'] > 1.
    assert evidence['rows_counted'][ROW_LIVE] == 3 * n
    assert constraints['risk_aversion'] == .5 and constraints['exposure_cap'] == .45
    beta = ledger(value, {'base': [0.] * n, 'alpha_tilt': [0.] * n, 'ridge': [0.4 * m for m in market]}, market=market)
    assert select(beta, value)[1]['status'] == 'no_calibrated_edge'


def test_small_noisy_samples_stay_on_base_where_the_v2_rule_would_leave():
    value = policy()
    deltas = [.004, -.001, .003, .002, -.002, .003, .001]
    rows = ledger(value, {'base': [0.] * 7, 'alpha_tilt': deltas, 'ridge': [0.] * 7})
    evidence = select(rows, value)[1]
    stats = evidence['arm_statistics']['alpha_tilt']
    assert stats['mean'] > stats['standard_error'] > 0          # the v2 1 x SE rule would leave base
    assert evidence['status'] == 'no_calibrated_edge'


def test_counterfactual_and_warm_start_rows_count_only_when_admitted():
    rng = np.random.default_rng(5)
    n = 30
    value = policy()
    deltas = {'base': [0.] * n, 'alpha_tilt': list(.001 + rng.normal(0., .0005, n)), 'ridge': [0.] * n}
    for kind, switch in ((ROW_COUNTERFACTUAL_INERT, {'inert_counterfactual': {'enabled': True, 'reference_exposure_cap': .2, 'reference_name_cap': .0625}}),
                         (ROW_CUTOVER_WARM_START, {'cutover_warm_start': {'enabled': True, 'max_observations': 60}})):
        rows = ledger(value, deltas, kind=kind)
        assert select(rows, value)[1]['status'] == 'cold_start_base'
        admitted = policy(**switch)
        rows = ledger(admitted, deltas, kind=kind)
        evidence = select(rows, admitted)[1]
        assert evidence['status'] == 'learned_policy' and evidence['rows_counted'][kind] == 3 * n


def test_warm_start_admits_only_the_most_recent_dates():
    rng = np.random.default_rng(9)
    value = policy(cutover_warm_start={'enabled': True, 'max_observations': 5})
    n = 30
    rows = ledger(value, {'base': [0.] * n, 'alpha_tilt': list(.001 + rng.normal(0., .0005, n)), 'ridge': [0.] * n},
                  kind=ROW_CUTOVER_WARM_START)
    evidence = select(rows, value)[1]
    assert evidence['rows_counted'][ROW_CUTOVER_WARM_START] == 3 * 5
    assert evidence['arm_statistics']['alpha_tilt']['samples'] == 5
    assert evidence['arm_statistics']['alpha_tilt']['last_session'] == sessions(31)[-1]


def test_warm_start_limit_larger_than_the_warm_days_keeps_them_all():
    value = policy(cutover_warm_start={'enabled': True, 'max_observations': 5})
    rows = ledger(value, {'base': [0.] * 3, 'alpha_tilt': [.001] * 3}, kind=ROW_CUTOVER_WARM_START)
    assert select(rows, value)[1]['rows_counted'][ROW_CUTOVER_WARM_START] == 6


def test_simulation_budget_is_bounded():
    value = policy(critical_value_simulations=200000, reward_window_observations=120)
    with pytest.raises(ValueError, match='simulation_budget'):
        select([], value)


@pytest.mark.parametrize('mutation,reason', [
    (lambda r: r.update(schema_version='l4-opb-arm-replay-v1'), 'reward_contract_invalid'),
    (lambda r: r.update(reward_semantic='raw'), 'reward_contract_invalid'),
    (lambda r: r.update(session_offset=6), 'reward_contract_invalid'),
    (lambda r: r.update(known_date='2028-01-01'), 'reward_contract_invalid'),
    (lambda r: r.update(row_kind='other'), 'reward_contract_invalid'),
])
def test_v3_reward_contract_fails_closed(mutation, reason):
    value = policy()
    rows = ledger(value, {'base': [0.] * 8, 'alpha_tilt': [.001] * 8})
    mutation(rows[3])
    with pytest.raises(ValueError, match=reason):
        select(rows, value)


def test_duplicate_and_conflicting_market_rows_fail_closed():
    value = policy()
    rows = ledger(value, {'base': [0.] * 8, 'alpha_tilt': [.001] * 8}, market=[.01] * 8)
    with pytest.raises(ValueError, match='duplicate_reward'):
        select(rows + [dict(rows[0])], value)
    bad = [dict(r) for r in rows]
    bad[9]['market_piece'] = .02
    # A conflicting day is dropped from the evidence (never a permanent plan failure).
    evidence = select(bad, value)[1]
    assert evidence['rows_counted']['conflicting_signal_days'] == 1
    assert evidence['arm_statistics']['alpha_tilt']['samples'] == 7


def test_thin_arm_rows_are_not_evidence():
    value = policy()
    rows = ledger(value, {'base': [0.] * 12, 'alpha_tilt': [.001] * 12})
    for row in rows[12:15]:
        row['arm_exposure'] = .1                 # 0.25 of base < min_exposure_ratio 0.5
    assert select(rows, value)[1]['arm_statistics']['alpha_tilt']['samples'] == 9


def test_overlapping_tranches_may_scale_the_same_session_differently():
    """Pieces are scaled by each signal day's entry open, so two tranches covering one
    session carry different 0050 pieces; only a mismatch within one signal day conflicts."""
    value = policy()
    rows = ledger(value, {'base': [0.] * 8, 'alpha_tilt': [.001] * 8}, market=[.01] * 8)
    second = []
    for row in rows:
        later = dict(row, session_offset=2, market_piece=row['market_piece'] * 1.03)
        later['signal_date'] = (date.fromisoformat(row['signal_date']) - timedelta(days=1)).isoformat()
        second.append(later)
    statistics = select(rows + second, value)[1]['arm_statistics']
    assert statistics['alpha_tilt']['samples'] == 8


def test_inert_envelope_and_disabled_policy_stay_on_base():
    value = policy()
    assert select([], value, envelope={**ENVELOPE, 'exposure_cap': 0.})[1]['status'] == 'arm_inert'
    assert select([], policy(enabled=False))[1]['status'] == 'fixed_policy'
    assert select([], value)[1]['status'] == 'cold_start_base'
    rows = ledger(value, {'base': [0.] * 20, 'alpha_tilt': [.001] * 20}, status='no_exposure')
    assert select(rows, value)[1]['status'] == 'cold_start_base'
