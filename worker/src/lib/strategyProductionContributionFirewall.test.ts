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
    { strategy_id: 'active-b', decision: 'active_cooldown' },
    { strategy_id: 'candidate-c', decision: 'candidate_ready' },
    { strategy_id: 'shadow-d', decision: 'not_ready' },
    { strategy_id: 'candidate-c', decision: 'active_cooldown' },
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
  'active-a': 0.857142857143,
  'active-b': 0,
  'candidate-c': 0.142857142857,
  'shadow-d': 0,
})
assert.deepEqual(promotedState.quarantined_strategy_ids, ['active-b'])
assert.deepEqual(promotedState.candidate_ready_strategy_ids, ['candidate-c'])
assert.equal(promotedState.evidence.raw_labels_preserved, true)
assert.equal(promotedState.evidence.experimental_threshold_deltas_applied, false)
assert.equal(promotedState.evidence.complete_non_retired_weight_map, true)
assert.equal(promotedState.evidence.positive_weight_count, 2)
assert.equal(promotedState.base_weight_run_id, 'adaptive-v2-2026-08-02')

const unitWeightState = buildStrategyProductionContributionFirewall({
  knowledgeCutoffDate: '2026-08-02',
  strategies,
  gates: [{ strategy_id: 'active-b', decision: 'active_cooldown' }],
  base: { source: 'runtime_default_unit_weights' },
})

assert.deepEqual(unitWeightState.strategy_weights, {
  'active-a': 1,
  'active-b': 0,
  'candidate-c': 1,
  'shadow-d': 1,
})
assert.equal(unitWeightState.evidence.normalized_promoted_weights, false)

const reorderedState = buildStrategyProductionContributionFirewall({
  knowledgeCutoffDate: '2026-08-02',
  strategies: [...strategies].reverse(),
  gates: [
    { strategy_id: 'candidate-c', decision: 'candidate_ready' },
    { strategy_id: 'active-b', decision: 'active_cooldown' },
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
