import type { StrategyAdaptivePolicyState, StrategyPromotionGateRow } from './strategyLearning'
import type { StrategySpec } from './strategySpec'
import {
  buildStrategyProductionContributionFirewall,
  type StrategyProductionFirewallState,
} from './strategyProductionContributionFirewall'
import { persistStrategyProductionPolicy } from './strategyProductionPolicyStore'
import { loadStrategyEvidenceOwnerSnapshotBefore, type StrategyEvidenceOwnerSnapshot } from './strategyEvidenceOwnerFusion'

export const STRATEGY_DIVERSITY_RETENTION_BUDGET = 0.15 as const

export interface RefreshStrategyProductionPolicyResult {
  state: StrategyProductionFirewallState
  evidenceFusion: StrategyEvidenceOwnerSnapshot
  checksum: string
  inserted: boolean
}

export type StrategyFormalContributionMode = 'full' | 'diversity_retention' | 'blocked'

function finitePositive(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * Readiness failures remain fail-closed. Performance cooldown is owned only
 * by consecutive, OOS-promoted primary-horizon evidence and receives a
 * bounded diversification sleeve instead of an implicit zero. Missing or
 * unpromoted performance evidence stays neutral.
 */
export function buildFormalOwnerWeightInputs(input: {
  strategies: readonly StrategySpec[]
  gates: readonly StrategyPromotionGateRow[]
  adaptiveWeights: Readonly<Record<string, number>>
  evidenceFusion: StrategyEvidenceOwnerSnapshot
}): {
  weights: Record<string, number>
  contributionModes: Record<string, StrategyFormalContributionMode>
} {
  const activeIds = new Set(input.strategies.filter((strategy) => strategy.status === 'active').map((strategy) => strategy.id))
  const gateById = new Map(input.gates.map((gate) => [gate.strategy_id, gate]))
  const profileById = new Map(input.evidenceFusion.profiles.map((profile) => [profile.strategy_id, profile]))
  const hasPositiveAnchor = [...activeIds].some((strategyId) => (
    gateById.get(strategyId)?.allocation_eligible === true
    && profileById.get(strategyId)?.performance_state !== 'cooldown'
    && finitePositive(input.adaptiveWeights[strategyId]) > 0
  ))
  const retainedIds = hasPositiveAnchor
    ? [...activeIds].filter((strategyId) => {
      const gate = gateById.get(strategyId)
      return gate?.allocation_eligible === true
        && profileById.get(strategyId)?.performance_state === 'cooldown'
    })
    : []
  const retainedFloor = retainedIds.length > 0
    ? STRATEGY_DIVERSITY_RETENTION_BUDGET / retainedIds.length
    : 0
  const weights: Record<string, number> = {}
  const contributionModes: Record<string, StrategyFormalContributionMode> = {}

  for (const strategyId of [...activeIds].sort()) {
    const gate = gateById.get(strategyId)
    const profile = profileById.get(strategyId)
    const mode: StrategyFormalContributionMode = gate?.allocation_eligible !== true
      ? 'blocked'
      : profile?.performance_state === 'cooldown'
        ? retainedIds.includes(strategyId) ? 'diversity_retention' : 'blocked'
        : 'full'
    contributionModes[strategyId] = mode
    const baseWeight = mode === 'full'
      ? finitePositive(input.adaptiveWeights[strategyId])
      : mode === 'diversity_retention'
        ? retainedFloor
        : 0
    weights[strategyId] = baseWeight * (profile?.weight_multiplier ?? 1)
  }
  return { weights, contributionModes }
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
  const formalOwnerWeights = buildFormalOwnerWeightInputs({
    strategies: input.strategies,
    gates: input.gates,
    adaptiveWeights: input.adaptiveState.strategy_weights,
    evidenceFusion,
  })
  const state = buildStrategyProductionContributionFirewall({
    knowledgeCutoffDate: input.knowledgeCutoffDate,
    strategies: runtimeStrategies,
    gates: input.gates.map((gate) => ({
      ...gate,
      contribution_mode: formalOwnerWeights.contributionModes[gate.strategy_id] ?? 'blocked',
    })),
    base: {
      source: 'adaptive_strategy_policy_v2',
      run_id: `${input.adaptiveState.updated_at}|${evidenceFusion.version}:${evidenceFusion.checksum}`,
      weights: formalOwnerWeights.weights,
      evidence_owner: {
        version: evidenceFusion.version,
        checksum: evidenceFusion.checksum,
        weight_effect: evidenceFusion.weight_effect,
        ready_profile_count: evidenceFusion.active_ready_profile_count,
        calibration_run_id: evidenceFusion.calibration_run_id,
        calibration_artifact_checksum: evidenceFusion.calibration_artifact_checksum,
        strategy_decisions: Object.fromEntries(evidenceFusion.profiles.map((profile) => [
          profile.strategy_id,
          {
            primary_horizon_days: profile.primary_horizon_days,
            performance_state: profile.performance_state,
            performance_reason: profile.performance_reason,
            negative_calibration_streak: profile.negative_calibration_streak,
            positive_calibration_streak: profile.positive_calibration_streak,
            multi_horizon_score: profile.multi_horizon_score,
            weight_multiplier: profile.weight_multiplier,
            contribution_mode: formalOwnerWeights.contributionModes[profile.strategy_id] ?? 'blocked',
          },
        ])),
      },
    },
  })
  const persisted = await persistStrategyProductionPolicy(db, state)
  return { state, evidenceFusion, ...persisted }
}
