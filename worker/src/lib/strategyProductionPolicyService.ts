import type { StrategyPromotionGateRow } from './strategyLearning'
import type { StrategySpec } from './strategySpec'
import {
  buildStrategyProductionContributionFirewall,
  type StrategyProductionFirewallBaseWeights,
  type StrategyProductionFirewallState,
} from './strategyProductionContributionFirewall'
import { persistStrategyProductionPolicy } from './strategyProductionPolicyStore'

async function loadCurrentPromotedBaseWeights(
  db: D1Database,
  strategyIds: readonly string[],
): Promise<StrategyProductionFirewallBaseWeights> {
  const head = await db.prepare(`
    SELECT h.run_id
      FROM strategy_marginal_edge_head_v4 h
      JOIN strategy_marginal_edge_runs_v4 r ON r.run_id=h.run_id AND r.status='promoted'
     WHERE h.owner_key='production'
     LIMIT 1
  `).first<{ run_id?: string }>()
  if (!head?.run_id) return { source: 'runtime_default_unit_weights' }

  const rows = await db.prepare(`
    SELECT strategy_id, production_weight_raw
      FROM strategy_marginal_edge_v4
     WHERE run_id=?
  `).bind(head.run_id).all<{ strategy_id: string; production_weight_raw: number | string }>()
  const rawWeights = new Map<string, number>()
  for (const row of rows.results ?? []) {
    const weight = Math.max(0, Number(row.production_weight_raw) || 0)
    rawWeights.set(row.strategy_id, (rawWeights.get(row.strategy_id) ?? 0) + weight)
  }
  const total = [...rawWeights.values()].reduce((sum, value) => sum + value, 0)
  const weights = Object.fromEntries(
    [...new Set(strategyIds)].map((strategyId) => [
      strategyId,
      total > 0 ? (rawWeights.get(strategyId) ?? 0) / total : 0,
    ]),
  )

  return {
    source: 'promoted_marginal_edge_v6',
    run_id: head.run_id,
    weights,
  }
}

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
  },
): Promise<RefreshStrategyProductionPolicyResult> {
  const runtimeStrategies = input.strategies
    .filter((strategy) => strategy.status !== 'retired')
    .map((strategy) => ({ id: strategy.id, status: strategy.status }))
  const base = await loadCurrentPromotedBaseWeights(
    db,
    runtimeStrategies.map((strategy) => strategy.id),
  )
  const state = buildStrategyProductionContributionFirewall({
    knowledgeCutoffDate: input.knowledgeCutoffDate,
    strategies: runtimeStrategies,
    gates: input.gates,
    base,
  })
  const persisted = await persistStrategyProductionPolicy(db, state)
  return { state, ...persisted }
}
