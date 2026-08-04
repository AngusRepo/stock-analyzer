import { strict as assert } from 'node:assert'
import { planAdaptiveMetaPolicyTransition } from './adaptiveMetaPolicyController'

function evidence(evidenceDate = '2026-08-02', overrides: Record<string, any> = {}) {
  return {
    status: 'pass',
    recommended_method: 'NeuralTS',
    sample_windows: 20,
    date_end: evidenceDate,
    gates: [
      { name: 'walk_forward_windows', passed: true },
      { name: 'beats_current_heuristic', passed: true },
      { name: 'no_single_arm_collapse', passed: true },
      { name: 'positive_average_reward', passed: true },
    ],
    allocator_policy_candidate: {
      policy_id: 'adaptive-meta-2026-08-02-neuralts',
      status: 'candidate_requires_approval',
      allowed_target: 'ml:adaptive_params.model_allocator',
      method: 'NeuralTS',
      model_multiplier_cap: 0.15,
      model_weight_multipliers: {
        LightGBM: 1.15, XGBoost: 1.10, ExtraTrees: 1.05, TabM: 0.95,
        GNN: 0.90, DLinear: 0.85, PatchTST: 0.90, iTransformer: 0.95,
      },
      evidence: { average_reward: 0.03, sample_windows: 20, date_end: evidenceDate },
    },
    ...overrides,
  }
}

const first = planAdaptiveMetaPolicyTransition(evidence(), null, '2026-08-03')
assert.equal(first.decision, 'observe')
assert.equal(first.mutation, 'none')
assert.equal(first.next_state.consecutive_passes, 1)

const second = planAdaptiveMetaPolicyTransition(evidence('2026-08-09'), first.next_state, '2026-08-10')
assert.equal(second.decision, 'promote_canary')
assert.equal(second.mutation, 'apply')
assert.equal(second.policy?.production_cap, 0.05)
assert.equal(second.policy?.approved, true)
assert.equal(second.policy?.real_trading_allowed, false)

const third = planAdaptiveMetaPolicyTransition(evidence('2026-08-16'), second.next_state, '2026-08-17')
assert.equal(third.decision, 'retain_canary')
assert.equal(third.next_state.consecutive_passes, 3)

const fourth = planAdaptiveMetaPolicyTransition(evidence('2026-08-23'), third.next_state, '2026-08-24')
assert.equal(fourth.decision, 'promote_active')
assert.equal(fourth.policy?.production_cap, 0.15)

const negative = evidence('2026-08-24', {
  status: 'fail',
  recommended_method: null,
  allocator_policy_candidate: {
    ...evidence().allocator_policy_candidate,
    status: 'research_only_failed_gate',
    evidence: { average_reward: -0.01, sample_windows: 20, date_end: '2026-08-24' },
  },
  gates: [{ name: 'positive_average_reward', passed: false }],
})
const rollback = planAdaptiveMetaPolicyTransition(negative, fourth.next_state, '2026-08-31')
assert.equal(rollback.decision, 'rollback')
assert.equal(rollback.mutation, 'remove')
assert.equal(rollback.next_state.serving_policy, null)

const coldReject = planAdaptiveMetaPolicyTransition(negative, null, '2026-08-31')
assert.equal(coldReject.decision, 'reject')
assert.equal(coldReject.mutation, 'none')
