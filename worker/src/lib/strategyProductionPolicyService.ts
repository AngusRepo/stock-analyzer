import type { StrategyAdaptivePolicyState, StrategyPromotionGateRow } from './strategyLearning'
import type { StrategySpec } from './strategySpec'
import {
  buildStrategyProductionContributionFirewall,
  type StrategyProductionFirewallState,
} from './strategyProductionContributionFirewall'
import { persistStrategyProductionPolicy } from './strategyProductionPolicyStore'

export interface RefreshStrategyProductionPolicyResult {
  state: StrategyProductionFirewallState
  checksum: string
  inserted: boolean
}

/**
 * Materializes the production firewall from existing promotion-gate evidence.
 * It does not evaluate new promotion criteria and therefore cannot supersede
 * the Edge V5/V6 lifecycle owner.
 */
export async function refreshStrategyProductionContributionPolicy(
  db: D1Database,
  input: {
    knowledgeCutoffDate: string
    strategies: readonly StrategySpec[]
    gates: readonly StrategyPromotionGateRow[]
    adaptiveState: StrategyAdaptivePolicyState
  },
): Promise<RefreshStrategyProductionPolicyResult> {
  const runtimeStrategies = input.strategies
    .filter((strategy) => strategy.status !== 'retired')
    .map((strategy) => ({ id: strategy.id, status: strategy.status }))
  const state = buildStrategyProductionContributionFirewall({
    knowledgeCutoffDate: input.knowledgeCutoffDate,
    strategies: runtimeStrategies,
    gates: input.gates,
    base: {
      source: 'adaptive_strategy_policy_v2',
      run_id: input.adaptiveState.updated_at,
      weights: input.adaptiveState.strategy_weights,
    },
  })
  const persisted = await persistStrategyProductionPolicy(db, state)
  return { state, ...persisted }
}
