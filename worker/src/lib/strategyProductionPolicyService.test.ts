import assert from 'node:assert/strict'
import { buildFormalOwnerWeightInputs, STRATEGY_DIVERSITY_RETENTION_BUDGET } from './strategyProductionPolicyService'

const result = buildFormalOwnerWeightInputs({
  strategies: [
    { id: 'anchor', status: 'active' },
    { id: 'cooldown', status: 'active' },
    { id: 'hard-risk', status: 'active' },
  ] as any,
  gates: [
    {
      strategy_id: 'anchor', strategy_status: 'active', decision: 'active_monitor',
      allocation_eligible: true, missing_evidence: [],
    },
    {
      strategy_id: 'cooldown', strategy_status: 'active', decision: 'active_cooldown',
      allocation_eligible: false, missing_evidence: ['active_avg_return_not_positive'],
    },
    {
      strategy_id: 'hard-risk', strategy_status: 'active', decision: 'active_cooldown',
      allocation_eligible: false, missing_evidence: ['active_max_drawdown_lt_-0.08'],
    },
  ] as any,
  adaptiveWeights: { anchor: 1, cooldown: 0, 'hard-risk': 0 },
  evidenceFusion: {
    profiles: [
      { strategy_id: 'anchor', weight_multiplier: 1.2 },
      { strategy_id: 'cooldown', weight_multiplier: 0.8 },
      { strategy_id: 'hard-risk', weight_multiplier: 1.25 },
    ],
  } as any,
})

assert.equal(result.contributionModes.anchor, 'full')
assert.equal(result.contributionModes.cooldown, 'diversity_retention')
assert.equal(result.contributionModes['hard-risk'], 'blocked')
assert.equal(result.weights.anchor, 1.2)
assert.equal(result.weights.cooldown, STRATEGY_DIVERSITY_RETENTION_BUDGET * 0.8)
assert.equal(result.weights['hard-risk'], 0)

const allWeak = buildFormalOwnerWeightInputs({
  strategies: [{ id: 'weak', status: 'active' }] as any,
  gates: [{
    strategy_id: 'weak', strategy_status: 'active', decision: 'active_cooldown',
    allocation_eligible: false, missing_evidence: ['active_avg_return_not_positive'],
  }] as any,
  adaptiveWeights: { weak: 0 },
  evidenceFusion: { profiles: [{ strategy_id: 'weak', weight_multiplier: 1.25 }] } as any,
})
assert.equal(allWeak.contributionModes.weak, 'blocked', 'diversity sleeve requires at least one positive formal anchor')
assert.equal(allWeak.weights.weak, 0)

console.log('strategy production policy service tests passed')
