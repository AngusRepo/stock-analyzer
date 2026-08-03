import assert from 'node:assert/strict'

import { buildMultiStrategyPleRoutingPlan } from './multiStrategyPleRouter'
import { buildStrategyProductionContributionFirewall } from './strategyProductionContributionFirewall'
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

const firewall = buildStrategyProductionContributionFirewall({
  knowledgeCutoffDate: '2026-08-02',
  strategies: [first, cooldown],
  gates: [{ strategy_id: cooldown.id, decision: 'active_cooldown' }],
  base: { source: 'runtime_default_unit_weights' },
})

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

const plan = buildMultiStrategyPleRoutingPlan([candidate], [first, cooldown], {
  strategyWeights: firewall.strategy_weights,
  maxSlateSize: 1,
})
const annotated: any = plan.l0Annotated[0]

assert.equal(annotated.strategy_hit_vector[first.id], 1)
assert.equal(annotated.strategy_hit_vector[cooldown.id], 1)
assert.ok(annotated.strategy_pool_ids?.includes(first.id))
assert.ok(!annotated.strategy_pool_ids?.includes(cooldown.id))
assert.equal(annotated.strategy_position_weight_vector[cooldown.id], 0)

console.log('strategy production firewall raw-label preservation tests passed')
