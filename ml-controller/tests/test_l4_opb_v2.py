"""v2 L4: relative arms inside the risk envelope, paired-edge selection, round-trip entry cost."""
from copy import deepcopy
import math

import numpy as np
import pytest

from services.l4_allocation_contract import policy_v2_from_v1
from services.l4_distribution_runtime import distribution_policy_identity, run
from services.l4_opb_selection import (LEDGER_SCHEMA, OPB_SCHEMA, POLICY_SCHEMA, arm_policies,
    decayed_paired_edge, objective_costs, risk_envelope, select_arm)
from services.l4_portfolio import allocate
from test_l4_distribution_runtime import fixture

ENVELOPE = {'exposure_cap': .45, 'name_cap': .25, 'max_positions': 5, 'min_weight': .03,
            'buy_cost': .001425, 'sell_cost': .004425}
CONSTRAINTS = {'risk_aversion': 2., 'alpha_strength': 1., 'return_history_lookback_sessions': 252,
               'cost_objective': 'entry_round_trip_v1'}


def policy(enabled=True):
    return {'policy_schema': POLICY_SCHEMA, 'artifact': {'model_checksum': 'a' * 64}, 'constraints': deepcopy(CONSTRAINTS),
        'opb': {'schema_version': OPB_SCHEMA, 'enabled': enabled, 'reward_window_observations': 60,
            'reward_half_life_observations': 20., 'approved_policy_identity': 'x' * 64, 'arms': [{'id': 'base'},
            {'id': 'tight', 'exposure_fraction': .8, 'name_fraction': .8},
            {'id': 'alpha', 'exposure_fraction': .92, 'name_fraction': 1.}]}}


def select(ledger, envelope=ENVELOPE, value=None, **kwargs):
    value = value or policy()
    return select_arm(value, arm_policies(value, envelope), ledger, identity='x' * 64, context='ctx',
                      signal_date='2026-12-31', envelope=envelope, **kwargs)


def rows(arm_id, deltas, value=None):
    arm = {a['id']: a for a in arm_policies(value or policy(), ENVELOPE)}[arm_id]
    days = [f'2026-{1 + i // 28:02d}-{1 + i % 28:02d}' for i in range(len(deltas))]
    return [{'context_identity': 'ctx', 'signal_date': day, 'known_date': day[:8] + '28' if day[8:] < '28' else
             f'2026-{int(day[5:7]) + 1:02d}-01', 'arm_digest': arm['definition_digest'],
             'schema_version': LEDGER_SCHEMA, 'delta': delta, 'status': 'complete'} for day, delta in zip(days, deltas)]


def test_v1_identity_is_bit_identical_to_main():
    v1 = {'scope': 'paper', 'artifact': {'model_checksum': 'aaaa', 'l3_identity': {'source': 'fixed'}},
        'constraints': {'alpha_strength': 1., 'buy_cost': .001425, 'covariance_horizon_sessions': 5, 'exposure_cap': 1.,
            'max_positions': 5, 'min_weight': 0., 'name_cap': .25, 'risk_aversion': 2., 'sell_cost': .004425,
            'turnover_penalty': 0.},
        'opb': {'enabled': True, 'exploration': .05, 'arms': [{'id': 'base', 'constraints': {}},
            {'id': 'tight', 'constraints': {'exposure_cap': .8, 'min_weight': .04, 'name_cap': .2}}]},
        'sealedExecution': {'schema_version': 'l4-sealed-execution-v1', 'rotation_mode': 'selected_ready_or_filled',
            'expiry': 'retain_until_next_seal', 'require_matched_risk_horizon': True, 'minimum_covariance_windows': 20}}
    # Golden computed with origin/main e5917754a services.l4_distribution_runtime.
    assert distribution_policy_identity(v1, v1['artifact']['l3_identity']) == \
        'd8ef0b60c0afdd8f91e6c946b345c5eb86cc54ca13b33510c6a8c6ede997c941'


def test_arms_scale_the_risk_envelope_and_never_own_min_weight():
    arms = {a['id']: a for a in arm_policies(policy(), ENVELOPE)}
    assert arms['base']['constraints'] == {'risk_aversion': 2., 'alpha_strength': 1., **ENVELOPE}
    assert arms['tight']['constraints']['exposure_cap'] == pytest.approx(.36)
    assert arms['tight']['constraints']['name_cap'] == pytest.approx(.2)
    assert {a['constraints']['min_weight'] for a in arms.values()} == {.03}
    assert len({a['effective_digest'] for a in arms.values()}) == 3
    account = {'risk_limits': {'exposure_cap': .45, 'name_cap': .25, 'max_positions': 5, 'min_trade_value': 30000},
               'fees': {'buy_cost': .001425, 'sell_cost': .004425}}
    assert risk_envelope(account, 1_000_000) == ENVELOPE
    with pytest.raises(ValueError, match='risk_context_missing'):
        risk_envelope({'fees': account['fees']}, 1_000_000)


@pytest.mark.parametrize('case,status,arm', [
    ('empty', 'cold_start_base', 'base'),
    ('negative', 'no_positive_paired_edge', 'base'),
    ('short', 'no_positive_paired_edge', 'base'),
    ('tie', 'tied_paired_edge', 'base'),
    ('learned', 'learned_policy', 'tight'),
    ('halt', 'arm_inert', 'base'),
    ('disabled', 'fixed_policy', 'base'),
])
def test_selection_stays_on_base_without_a_positive_lower_bound(case, status, arm):
    steady = [.002 + .0001 * (i % 3) for i in range(40)]
    ledger = {'empty': [], 'negative': rows('tight', [-x for x in steady]), 'short': rows('tight', steady[:5]),
              'tie': rows('tight', steady) + rows('alpha', steady), 'learned': rows('tight', steady),
              'halt': rows('tight', steady), 'disabled': rows('tight', steady)}[case]
    envelope = {**ENVELOPE, 'exposure_cap': 0.} if case == 'halt' else ENVELOPE
    constraints, evidence = select(ledger, envelope, policy(case != 'disabled'))
    assert (evidence['status'], evidence['arm_id']) == (status, arm)
    assert evidence['effective_digest'] and evidence['arm_inert'] is (case == 'halt')
    assert constraints == evidence['effective_constraints']


def test_ledger_rows_must_be_known_before_the_decision_and_unique():
    ledger = rows('tight', [.01] * 10)
    with pytest.raises(ValueError, match='reward_contract'):
        select([dict(ledger[0], known_date='2027-01-05')])
    with pytest.raises(ValueError, match='duplicate_reward'):
        select(ledger + ledger[:1])
    # A replay of an arm removed from the policy carries no evidence.
    assert select([dict(row, arm_digest='f' * 64) for row in ledger])[1]['status'] == 'cold_start_base'


def test_forced_arm_is_a_counterfactual_and_needs_the_approved_identity():
    assert select([], forced_arm='alpha')[1]['status'] == 'forced_counterfactual'
    value = policy()
    value['opb']['approved_policy_identity'] = 'y' * 64
    with pytest.raises(ValueError, match='identity_missing'):
        select([], value=value, forced_arm='alpha')


def test_decayed_hac_matches_hand_computation():
    flat = decayed_paired_edge([1., 2., 3., 4.], window=60, half_life=1e12, lag=1)
    # Equal weights: mean 2.5, iid .3125, lag-1 autocov .078125 -> HAC .390625.
    assert flat['mean'] == pytest.approx(2.5)
    assert flat['standard_error'] == pytest.approx(.625)
    assert flat['effective_samples'] == pytest.approx(4.) and flat['lower_bound'] == pytest.approx(1.875)
    # Negative autocovariance cannot shrink the error below iid.
    alternating = decayed_paired_edge([1., 3.], window=60, half_life=1e12, lag=1)
    assert alternating['standard_error'] == pytest.approx(math.sqrt(.5)) and alternating['lower_bound'] is None
    decayed = decayed_paired_edge([0., 1.], window=60, half_life=1., lag=0)
    assert decayed['mean'] == pytest.approx(2 / 3)


def one_name(gross, current=0., cost_objective=None):
    objective = objective_costs([.001425], [.004425], cost_objective) if cost_objective else None
    return allocate(symbols=['A'], expected_gross=[gross], covariance=np.eye(1) * 1e-6, current_weights=[current],
        exposure_cap=.45, name_cap=.25, min_weight=.03, max_positions=5, buy_cost=.001425, sell_cost=.004425,
        objective_costs=objective)['weights']['A']


def test_round_trip_entry_cost_blocks_negative_net_entries_only():
    assert one_name(.005, cost_objective='entry_round_trip_v1') == pytest.approx(0, abs=1e-9)
    assert one_name(.006, cost_objective='entry_round_trip_v1') > .03
    assert one_name(.005) > .03  # legacy one-way objective buys the negative round trip
    # A held name with no edge exits once reducing it costs nothing.
    assert one_name(0., current=.2, cost_objective='entry_round_trip_v1') == pytest.approx(0, abs=1e-9)
    assert one_name(0., current=.2) == pytest.approx(.2, abs=1e-9)


@pytest.mark.parametrize('edge,swap', [(.0057, False), (.006, True)])
def test_swap_threshold_is_unchanged(edge, swap):
    for cost_objective in (None, 'entry_round_trip_v1'):
        objective = objective_costs([.001425] * 2, [.004425] * 2, cost_objective) if cost_objective else None
        weights = allocate(symbols=['A', 'B'], expected_gross=[.01, .01 + edge], covariance=np.eye(2) * 1e-6,
            current_weights=[.25, 0.], exposure_cap=.25, name_cap=.25, min_weight=.03, max_positions=1,
            buy_cost=.001425, sell_cost=.004425, objective_costs=objective)['weights']
        assert (weights['B'] > .2) is swap and (weights['A'] > .2) is not swap


def test_single_side_objective_keeps_the_v1_objective():
    assert objective_costs([.001425], [.004425], 'single_side_v1') is None
    with pytest.raises(ValueError, match='cost_objective_invalid'):
        objective_costs([.001425], [.004425], 'one_way')
    # Same as v1: Ê .5% clears the one-way buy cost, a held name with no edge is kept.
    assert one_name(.005, cost_objective='single_side_v1') > .03
    assert one_name(0., current=.2, cost_objective='single_side_v1') == pytest.approx(.2, abs=1e-9)


def v2_fixture(cost_objective='entry_round_trip_v1'):
    recs, value, history = fixture()
    runtime = value.pop('runtime')
    value['constraints']['risk_aversion'] = 2.
    value['opb'] = {'enabled': True, 'exploration': .01, 'approved_policy_identity': 'd' * 64,
        'arms': [{'id': 'base', 'constraints': {}}, {'id': 'tight', 'constraints': {'exposure_cap': .4, 'name_cap': .15}}]}
    v2 = policy_v2_from_v1(value, lookback=252, cost_objective=cost_objective)
    runtime['account'].update(risk_limits={'exposure_cap': .8, 'name_cap': .3, 'max_positions': 2,
        'min_trade_value': 30000, 'buys_halted': False}, fees={'buy_cost': .001, 'sell_cost': .004})
    return recs, {**v2, 'runtime': runtime}, history


def test_v2_run_cold_starts_on_the_envelope_and_records_the_effective_digest():
    recs, value, history = v2_fixture()
    plan = run(recs, value, return_history=history)[0]['_l4_portfolio_plan']
    assert plan['execution_scope'] == 'paper'
    assert plan['opb']['status'] == 'cold_start_base' and plan['opb']['effective_digest']
    assert plan['opb']['effective_constraints']['exposure_cap'] == .8
    assert plan['opb']['effective_constraints']['min_weight'] == pytest.approx(.03)
    assert plan['opb']['cost_objective'] == 'entry_round_trip_v1'


def test_v2_single_side_run_is_the_legacy_objective(monkeypatch):
    from services import l4_distribution_runtime
    recs, single, history = v2_fixture(cost_objective='single_side_v1')
    plan = run(recs, single, return_history=history)[0]['_l4_portfolio_plan']
    assert plan['opb']['cost_objective'] == 'single_side_v1'
    recs, round_trip, history = v2_fixture()
    monkeypatch.setattr(l4_distribution_runtime, 'objective_costs', lambda *args: None)
    legacy = run(recs, round_trip, return_history=history)[0]['_l4_portfolio_plan']
    assert plan['weights'] == legacy['weights']
    assert plan['opb']['effective_digest'] == legacy['opb']['effective_digest']


def test_v2_halt_is_inert_and_forced_arm_is_counterfactual_only():
    recs, value, history = v2_fixture()
    halted = deepcopy(value)
    halted['runtime']['account']['risk_limits'].update(exposure_cap=0., buys_halted=True)
    plan = run(recs, halted, return_history=history)[0]['_l4_portfolio_plan']
    assert plan['opb']['status'] == 'arm_inert' and sum(plan['weights'].values()) == pytest.approx(0, abs=1e-9)
    forced = run(recs, value, return_history=history, forced_arm='tight')[0]['_l4_portfolio_plan']
    assert forced['execution_scope'] == 'counterfactual' and forced['opb']['arm_id'] == 'tight'
    # v1 arm .4/.15 over base .8/.3 migrates to fractions .5/.5 of the risk envelope .8/.3.
    assert forced['opb']['effective_constraints']['exposure_cap'] == pytest.approx(.4)
    assert forced['opb']['effective_constraints']['name_cap'] == pytest.approx(.15)
    with pytest.raises(ValueError, match='forced_arm_not_admitted'):
        run(recs, value, return_history=history, forced_arm='tight', evidence_sink=[].append)
    with pytest.raises(ValueError, match='policy_schema_invalid'):
        run(recs, {**value, 'policy_schema': 'l4-distribution-policy-v9'}, return_history=history)


def test_non_complete_replay_rows_are_skipped_before_validation():
    ledger = rows('tight', [.01] * 10)
    expected = select(ledger)
    inert = [dict(row, status='arm_inert', known_date='2027-01-05') for row in ledger]
    assert select(ledger + inert) == expected
    assert select(inert)[1]['status'] == 'cold_start_base'
