import assert from 'node:assert/strict'

import { buildStrategyProductionContributionFirewall } from './strategyProductionContributionFirewall'

const strategies = [
  { id: 'active-a', status: 'active' as const },
  { id: 'active-b', status: 'active' as const },
  { id: 'candidate-c', status: 'candidate' as const },
  { id: 'shadow-d', status: 'shadow' as const },
  { id: 'retired-e', status: 'retired' as const },
]

const promotedState = buildStrategyProductionContributionFirewall({
  knowledgeCutoffDate: '2026-08-02',
  strategies,
  gates: [
    { strategy_id: 'active-a', decision: 'active_monitor', allocation_eligible: true },
    { strategy_id: 'active-b', decision: 'active_cooldown', allocation_eligible: false },
    { strategy_id: 'candidate-c', decision: 'candidate_ready', allocation_eligible: false },
    { strategy_id: 'shadow-d', decision: 'not_ready', allocation_eligible: false },
    { strategy_id: 'candidate-c', decision: 'active_cooldown', allocation_eligible: false },
  ],
  base: {
    source: 'adaptive_strategy_policy_v2',
    run_id: 'adaptive-v2-2026-08-02',
    weights: {
      'active-a': 0.6,
      'active-b': 0.3,
      'candidate-c': 0.1,
      'retired-e': 999,
    },
  },
})

assert.deepEqual(promotedState.strategy_weights, {
  'active-a': 1,
  'active-b': 0,
  'candidate-c': 0,
  'shadow-d': 0,
})
assert.deepEqual(promotedState.quarantined_strategy_ids, ['active-b'])
assert.deepEqual(promotedState.candidate_ready_strategy_ids, ['candidate-c'])
assert.equal(promotedState.evidence.raw_labels_preserved, true)
assert.equal(promotedState.evidence.experimental_threshold_deltas_applied, false)
assert.equal(promotedState.evidence.complete_non_retired_weight_map, true)
assert.equal(promotedState.evidence.positive_weight_count, 1)
assert.equal(promotedState.base_weight_run_id, 'adaptive-v2-2026-08-02')

const diversityState = buildStrategyProductionContributionFirewall({
  knowledgeCutoffDate: '2026-08-02',
  strategies,
  gates: [
    { strategy_id: 'active-a', decision: 'active_monitor', allocation_eligible: true, contribution_mode: 'full' },
    { strategy_id: 'active-b', decision: 'active_cooldown', allocation_eligible: false, contribution_mode: 'diversity_retention' },
  ],
  base: {
    source: 'adaptive_strategy_policy_v2',
    run_id: 'adaptive-v2|strategy-evidence-owner-fusion-v2:checksum',
    weights: { 'active-a': 1, 'active-b': 0.15 },
    evidence_owner: {
      version: 'strategy-evidence-owner-fusion-v2',
      checksum: 'checksum',
      weight_effect: 'mature_ready_only_bounded_bidirectional',
      ready_profile_count: 2,
    },
  },
})
assert.equal(diversityState.strategy_weights['active-a'], 0.869565217391)
assert.equal(diversityState.strategy_weights['active-b'], 0.130434782609)
assert.deepEqual(diversityState.quarantined_strategy_ids, [])
assert.equal(diversityState.evidence.diversity_retained_strategy_count, 1)
assert.equal(diversityState.evidence.bounded_bidirectional_adjustment, true)
assert.equal(diversityState.evidence.safety_reducing_only, false)
assert.equal(diversityState.evidence.evidence_owner?.checksum, 'checksum')

const unitWeightState = buildStrategyProductionContributionFirewall({
  knowledgeCutoffDate: '2026-08-02',
  strategies,
  gates: [
    { strategy_id: 'active-a', decision: 'active_monitor', allocation_eligible: true },
    { strategy_id: 'active-b', decision: 'active_cooldown', allocation_eligible: false },
  ],
  base: { source: 'runtime_default_unit_weights' },
})

assert.deepEqual(unitWeightState.strategy_weights, {
  'active-a': 1,
  'active-b': 0,
  'candidate-c': 0,
  'shadow-d': 0,
})
assert.equal(unitWeightState.evidence.normalized_promoted_weights, false)

const reorderedState = buildStrategyProductionContributionFirewall({
  knowledgeCutoffDate: '2026-08-02',
  strategies: [...strategies].reverse(),
  gates: [
    { strategy_id: 'candidate-c', decision: 'candidate_ready', allocation_eligible: false },
    { strategy_id: 'active-b', decision: 'active_cooldown', allocation_eligible: false },
    { strategy_id: 'active-a', decision: 'active_monitor', allocation_eligible: true },
  ],
  base: {
    source: 'adaptive_strategy_policy_v2',
    run_id: 'adaptive-v2-2026-08-02',
    weights: {
      'candidate-c': 0.1,
      'active-b': 0.3,
      'active-a': 0.6,
    },
  },
})

assert.equal(reorderedState.canonical_payload, promotedState.canonical_payload)

const invalidWeightState = buildStrategyProductionContributionFirewall({
  knowledgeCutoffDate: '2026-08-02',
  strategies,
  gates: [],
  base: {
    source: 'promoted_marginal_edge_v6',
    weights: {
      'active-a': Number.NaN,
      'active-b': -2,
      'candidate-c': Number.POSITIVE_INFINITY,
      'shadow-d': 0,
    },
  },
})

assert.deepEqual(invalidWeightState.strategy_weights, {
  'active-a': 0,
  'active-b': 0,
  'candidate-c': 0,
  'shadow-d': 0,
})
assert.equal(invalidWeightState.evidence.positive_weight_count, 0)

console.log('strategy production contribution firewall tests passed')
