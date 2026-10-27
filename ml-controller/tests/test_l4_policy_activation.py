"""The v1 -> v2 activation transform keeps every absolute cap and only fills absent risk fields."""
from pathlib import Path
import re

import pytest

from services.l4_policy_activation import (CHANGE_SCHEMA, LEGACY_LOSS_STREAK_SCALE, LEGACY_MOMENTUM_ZONE_SCALE,
    LEGACY_SEVERE_HIGH_VOL_SCALE, SCHEMA, apply_risk_fields, chain_states, circuit_position_scales,
    missing_risk_fields, next_trading_config, step_writes, with_policy_activations)

WORKER = Path(__file__).resolve().parents[2] / 'worker/src/lib'


def test_legacy_scales_match_worker_constants():
    for name in ('riskChecks/p3MarketRisk.ts', 'riskChecks/p4Breadth.ts'):
        assert f'cc.highVolReducedPosPct * {LEGACY_SEVERE_HIGH_VOL_SCALE}' in (WORKER / name).read_text(encoding='utf-8')
    zone = (WORKER / 'momentumZone.ts').read_text(encoding='utf-8')
    block = re.search(r'ZONE_MULTIPLIER: Record<MomentumZone, number> = \{([^}]*)\}', zone).group(1)
    assert {k: float(v) for k, v in re.findall(r'(RED|YELLOW): ([0-9.]+)', block)} == LEGACY_MOMENTUM_ZONE_SCALE
    losses = (WORKER / 'riskChecks/p5Losses.ts').read_text(encoding='utf-8')
    assert f'export const P5_LOSS_POSITION_SCALE = {LEGACY_LOSS_STREAK_SCALE}\n' in losses


def test_scales_reproduce_absolute_caps_and_reject_invalid_caps():
    scales = circuit_position_scales({'maxPositionPct': .08, 'highVolReducedPosPct': .04})
    assert .08 * scales['highVol'] == .04 and .08 * scales['highVol'] * scales['severeHighVol'] == .02
    with pytest.raises(ValueError, match='circuit_caps'):
        circuit_position_scales({'maxPositionPct': .08, 'highVolReducedPosPct': .09})


def test_risk_fill_adds_absent_fields_only():
    risk = {'system': {'killSwitch': True}, 'portfolio': {}, 'position': {}, 'order': {}}
    filled = missing_risk_fields(risk, {'system': {'killSwitch': False, 'clockSkewTolerance': 30},
        'portfolio': {'orangeTargetExposure': .45}, 'position': {}, 'order': {}})
    assert filled == {'system.clockSkewTolerance': 30, 'portfolio.orangeTargetExposure': .45}
    assert apply_risk_fields(risk, filled)['system'] == {'killSwitch': True, 'clockSkewTolerance': 30}
    with pytest.raises(ValueError, match='risk_field_present'):
        apply_risk_fields(risk, {'system.killSwitch': False})


def test_raw_config_must_carry_the_name_cap_it_moves():
    with pytest.raises(ValueError, match='position_name_cap_missing'):
        next_trading_config({'position': {}}, l4={}, scales={})


T, R = 'trading:config', 'trading:risk_config'
# S -> P1 moves both keys (risk first), P1 -> P2 changes trading:config only.
CHAIN = [{'rollback_config': 't0', 'rollback_risk_config': 'r0', 'next_config': 't1', 'next_risk_config': 'r1',
          'write_order': [R, T], 'rollback_order': [T, R]},
         {'rollback_config': 't1', 'rollback_risk_config': 'r1', 'next_config': 't2', 'next_risk_config': 'r1',
          'write_order': [T], 'rollback_order': [T]}]


@pytest.mark.parametrize('trading,risk,target,start,writes', [
    ('t0', 'r0', 1, 0, [(R, 'r0', 'r1'), (T, 't0', 't1')]),
    ('t0', 'r1', 1, 0, [(T, 't0', 't1')]),  # resume after the risk write landed
    ('t1', 'r1', 2, 1, [(T, 't1', 't2')]),  # the unchanged risk key is not rewritten
    ('t2', 'r1', 1, 2, [(T, 't2', 't1')]),
    ('t1', 'r1', 0, 1, [(T, 't1', 't0'), (R, 'r1', 'r0')]),
    ('t0', 'r1', 0, 1, [(R, 'r1', 'r0')]),  # resume a rollback after its trading write
    ('t2', 'r1', 2, 2, [])])
def test_step_writes_moves_one_adjacent_step(trading, risk, target, start, writes):
    assert step_writes(CHAIN, {T: trading, R: risk}, target) == (start, writes)


@pytest.mark.parametrize('trading,risk,target,reason', [
    ('t0', 'r0', 2, 'step_not_adjacent'), ('t2', 'r1', 0, 'step_not_adjacent'),
    ('tx', 'r0', 1, 'drift'), ('t1', 'r0', 1, 'drift'), ('t2', 'r0', 2, 'drift'),
    ('t0', 'r0', 3, 'step_target'), ('t0', 'r0', -1, 'step_target'), ('t0', 'r0', '1', 'step_target')])
def test_step_writes_refuses_drift_and_jumps(trading, risk, target, reason):
    with pytest.raises(ValueError, match=reason):
        step_writes(CHAIN, {T: trading, R: risk}, target)


def test_chain_states_require_linked_packets():
    assert [s[T] for s in chain_states(CHAIN)] == ['t0', 't1', 't2']
    for field, value in (('rollback_config', 't9'), ('rollback_risk_config', 'r0'), ('write_order', ['other'])):
        broken = [CHAIN[0], {**CHAIN[1], field: value}]
        with pytest.raises(ValueError, match='chain_not_linked'):
            chain_states(broken)


def test_release_policy_keys_bind_one_key_per_reviewed_activation():
    chain = [{'schema_version': SCHEMA}, {'schema_version': CHANGE_SCHEMA}]
    manifest, behavior = with_policy_activations({'policy_activation': {}, 'scope': 'paper'},
        {'runtime_admission': 'S', 'policy_runtime_admission': 'old'}, chain=chain, keys=['P1', 'P2'])
    assert manifest == {'scope': 'paper', 'policy_activations': chain}
    assert behavior == {'runtime_admission': 'S', 'policy_runtime_admissions': ['P1', 'P2']}
    for keys, activations in ((['P1'], chain), (['P1', 'P1'], chain), (['S', 'P2'], chain),
                              (['P1', 'P2'], [chain[0], {'schema_version': 'l4-execution-policy-activation-v1'}])):
        with pytest.raises(ValueError, match='release_policy_keys'):
            with_policy_activations({}, {'runtime_admission': 'S'}, chain=activations, keys=keys)
