import assert from 'node:assert/strict'

import { buildMultiStrategyPleRoutingPlan } from './multiStrategyPleRouter'
import { DEFAULT_STRATEGY_SPECS } from './strategySpec'

const first: any = {
  ...DEFAULT_STRATEGY_SPECS[0],
  id: 'healthy_active_strategy',
  variantId: 'healthy_active_strategy',
  status: 'active',
  ownerType: 'strategy',
  promotionStatus: 'production',
  thresholds: { minPrice: 10 },
}
const cooldown: any = {
  ...first,
  id: 'cooldown_active_strategy',
  variantId: 'cooldown_active_strategy',
}
const retained: any = {
  ...first,
  id: 'retained_active_strategy',
  variantId: 'retained_active_strategy',
}

const candidate: any = {
  symbol: '9912',
  current_price: 50,
  raw_signals: { close: 50 },
  score_v2: JSON.stringify({
    version: 'score_v2',
    components: {
      mlEdge: 12,
      chipFlow: 18,
      technicalStructure: 18,
      fundamentalQuality: 10,
      newsTheme: 2,
    },
    technicalBreakdown: {
      trendStructure: 6,
      volatilityStructure: 4,
      reversalExtreme: 4,
      volumeConfirmation: 6,
      executionRisk: 1,
    },
    seedComponents: { screenerMomentumSeed20: 12 },
    finalScore: 70,
  }),
}

const plan = buildMultiStrategyPleRoutingPlan([candidate], [first, retained, cooldown], {
  strategyWeights: { [first.id]: 1, [retained.id]: 1, [cooldown.id]: 1 },
  productionStrategyWeights: { [first.id]: 1.6, [retained.id]: 0.4, [cooldown.id]: 0 },
  performanceWeightOwner: 'formal_evidence_owner',
  strategyPortfolioMetrics: {
    [first.id]: {
      strategy_metric_status: 'ready',
      metric_sources: ['immutable_reward_evidence'],
      rolling_sharpe: 3,
      recent_alpha: 0.08,
      holding_overlap: 0.1,
      factor_crowding: 0.1,
      prior_weight: 1.8,
    },
  },
  maxSlateSize: 1,
})
const annotated: any = plan.l0Annotated[0]

assert.equal(annotated.strategy_hit_vector[first.id], 1)
assert.equal(annotated.strategy_hit_vector[retained.id], 1)
assert.equal(annotated.strategy_hit_vector[cooldown.id], 1)
assert.ok(annotated.strategy_pool_ids?.includes(first.id))
assert.ok(annotated.strategy_pool_ids?.includes(retained.id))
assert.ok(!annotated.strategy_pool_ids?.includes(cooldown.id))
assert.equal(annotated.strategy_position_weight_vector[cooldown.id], 0)
assert.equal(annotated.strategy_production_weight_vector[first.id], 1.6)
assert.equal(annotated.strategy_production_weight_vector[retained.id], 0.4)
assert.equal(annotated.strategy_production_weight_vector[cooldown.id], 0)
assert.ok(
  annotated.strategy_position_weight_vector[first.id]
    > annotated.strategy_position_weight_vector[retained.id],
)
assert.equal(annotated.strategy_portfolio_prior.strategy_prior_weight[first.id], 1)
assert.equal(
  annotated.strategy_portfolio_prior.strategy_metric_reason[first.id],
  'formal_evidence_owner_controls_performance_weight_structural_ple_metrics_only',
)

console.log('strategy production firewall raw-label preservation tests passed')
