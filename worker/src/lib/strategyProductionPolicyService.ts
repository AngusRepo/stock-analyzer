import type { StrategyAdaptivePolicyState, StrategyPromotionGateRow } from './strategyLearning'
import type { StrategySpec } from './strategySpec'
import {
  buildStrategyProductionContributionFirewall,
  type StrategyProductionFirewallState,
} from './strategyProductionContributionFirewall'
import { persistStrategyProductionPolicy } from './strategyProductionPolicyStore'
import { loadStrategyEvidenceOwnerSnapshotBefore, type StrategyEvidenceOwnerSnapshot } from './strategyEvidenceOwnerFusion'

export interface RefreshStrategyProductionPolicyResult {
  state: StrategyProductionFirewallState
  evidenceFusion: StrategyEvidenceOwnerSnapshot
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
  const evidenceFusion = await loadStrategyEvidenceOwnerSnapshotBefore(
    db,
    input.strategies,
    input.knowledgeCutoffDate,
  )
  if (!evidenceFusion.integration_ready) {
    throw new Error(`strategy_evidence_owner_integration_not_ready:${evidenceFusion.active_materialized_profile_count}/${evidenceFusion.active_profile_count}`)
  }
  const state = buildStrategyProductionContributionFirewall({
    knowledgeCutoffDate: input.knowledgeCutoffDate,
    strategies: runtimeStrategies,
    gates: input.gates,
    base: {
      source: 'adaptive_strategy_policy_v2',
      run_id: `${input.adaptiveState.updated_at}|${evidenceFusion.version}:${evidenceFusion.checksum}`,
      weights: input.adaptiveState.strategy_weights,
    },
  })
  const persisted = await persistStrategyProductionPolicy(db, state)
  return { state, evidenceFusion, ...persisted }
}
