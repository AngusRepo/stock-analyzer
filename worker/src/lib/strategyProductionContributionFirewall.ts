export const STRATEGY_PRODUCTION_FIREWALL_POLICY_ID =
  'strategy-production-contribution-firewall-v2' as const

export const STRATEGY_PRODUCTION_FIREWALL_VERSION = 2 as const
export const STRATEGY_ALLOCATION_ELIGIBILITY_CONTRACT_VERSION =
  'strategy-allocation-eligibility-v2' as const

export type StrategyLifecycleStatus =
  | 'research'
  | 'shadow'
  | 'candidate'
  | 'active'
  | 'retired'

export type StrategyPromotionDecision =
  | 'not_ready'
  | 'candidate_ready'
  | 'active_monitor'
  | 'active_cooldown'

export type StrategyProductionBaseWeightSource =
  | 'promoted_marginal_edge_v6'
  | 'adaptive_strategy_policy_v2'
  | 'runtime_default_unit_weights'

export interface StrategyProductionFirewallStrategy {
  id: string
  status: StrategyLifecycleStatus
}

export interface StrategyProductionFirewallGate {
  strategy_id: string
  decision: StrategyPromotionDecision
  allocation_eligible: boolean
}

export interface StrategyProductionFirewallBaseWeights {
  source: StrategyProductionBaseWeightSource
  run_id?: string | null
  weights?: Readonly<Record<string, number>> | null
}

export interface StrategyProductionFirewallState {
  policy_id: typeof STRATEGY_PRODUCTION_FIREWALL_POLICY_ID
  version: typeof STRATEGY_PRODUCTION_FIREWALL_VERSION
  status: 'active'
  knowledge_cutoff_date: string
  strategy_weights: Record<string, number>
  quarantined_strategy_ids: string[]
  candidate_ready_strategy_ids: string[]
  base_weight_source: StrategyProductionBaseWeightSource
  base_weight_run_id: string | null
  canonical_payload: string
  evidence: {
    production_effect: true
    safety_reducing_only: true
    raw_labels_preserved: true
    experimental_threshold_deltas_applied: false
    complete_non_retired_weight_map: true
    allocation_eligibility_contract_version: typeof STRATEGY_ALLOCATION_ELIGIBILITY_CONTRACT_VERSION
    normalized_promoted_weights: boolean
    positive_weight_count: number
  }
}

function sanitizeWeight(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function roundWeight(value: number): number {
  return Number(value.toFixed(12))
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function canonicalizePayload(input: {
  knowledge_cutoff_date: string
  strategy_weights: Readonly<Record<string, number>>
  quarantined_strategy_ids: readonly string[]
  candidate_ready_strategy_ids: readonly string[]
  base_weight_source: StrategyProductionBaseWeightSource
  base_weight_run_id: string | null
}): string {
  const strategyWeights = Object.fromEntries(
    Object.entries(input.strategy_weights).sort(([left], [right]) => left.localeCompare(right)),
  )

  return JSON.stringify({
    policy_id: STRATEGY_PRODUCTION_FIREWALL_POLICY_ID,
    version: STRATEGY_PRODUCTION_FIREWALL_VERSION,
    allocation_eligibility_contract_version: STRATEGY_ALLOCATION_ELIGIBILITY_CONTRACT_VERSION,
    knowledge_cutoff_date: input.knowledge_cutoff_date,
    strategy_weights: strategyWeights,
    quarantined_strategy_ids: [...input.quarantined_strategy_ids].sort(),
    candidate_ready_strategy_ids: [...input.candidate_ready_strategy_ids].sort(),
    base_weight_source: input.base_weight_source,
    base_weight_run_id: input.base_weight_run_id,
  })
}

/**
 * Builds a production-only, risk-reducing contribution overlay.
 * Raw strategy labels remain available even when an active strategy is
 * quarantined from contributing to production selection.
 */
export function buildStrategyProductionContributionFirewall(input: {
  knowledgeCutoffDate: string
  strategies: readonly StrategyProductionFirewallStrategy[]
  gates: readonly StrategyProductionFirewallGate[]
  base: StrategyProductionFirewallBaseWeights
}): StrategyProductionFirewallState {
  const nonRetiredStrategies = [...input.strategies]
    .filter((strategy) => strategy.status !== 'retired')
    .sort((left, right) => left.id.localeCompare(right.id))

  const statusById = new Map(nonRetiredStrategies.map((strategy) => [strategy.id, strategy.status]))
  const allocationEligible = new Set(
    input.gates
      .filter((gate) => gate.allocation_eligible === true && statusById.get(gate.strategy_id) === 'active')
      .map((gate) => gate.strategy_id),
  )
  const quarantinedStrategyIds = sortedUnique(
    nonRetiredStrategies
      .filter((strategy) => strategy.status === 'active' && !allocationEligible.has(strategy.id))
      .map((strategy) => strategy.id),
  )
  const candidateReadyStrategyIds = sortedUnique(
    input.gates
      .filter((gate) => gate.decision === 'candidate_ready' && statusById.has(gate.strategy_id))
      .map((gate) => gate.strategy_id),
  )

  const suppliedWeights = input.base.weights ?? undefined
  const strategyWeights = Object.fromEntries(
    nonRetiredStrategies.map((strategy) => {
      if (strategy.status !== 'active' || !allocationEligible.has(strategy.id)) {
        return [strategy.id, 0]
      }
      const baseWeight = suppliedWeights ? sanitizeWeight(suppliedWeights[strategy.id]) : 1
      return [strategy.id, baseWeight]
    }),
  )

  let normalizedPromotedWeights = false
  if (
    input.base.source === 'adaptive_strategy_policy_v2'
    || input.base.source === 'promoted_marginal_edge_v6'
  ) {
    const positiveWeightTotal = Object.values(strategyWeights).reduce((total, weight) => total + weight, 0)
    if (positiveWeightTotal > 0) {
      for (const strategyId of Object.keys(strategyWeights)) {
        strategyWeights[strategyId] = roundWeight(strategyWeights[strategyId] / positiveWeightTotal)
      }
      normalizedPromotedWeights = true
    }
  }

  const baseWeightRunId = input.base.run_id ?? null
  const canonicalPayload = canonicalizePayload({
    knowledge_cutoff_date: input.knowledgeCutoffDate,
    strategy_weights: strategyWeights,
    quarantined_strategy_ids: quarantinedStrategyIds,
    candidate_ready_strategy_ids: candidateReadyStrategyIds,
    base_weight_source: input.base.source,
    base_weight_run_id: baseWeightRunId,
  })

  return {
    policy_id: STRATEGY_PRODUCTION_FIREWALL_POLICY_ID,
    version: STRATEGY_PRODUCTION_FIREWALL_VERSION,
    status: 'active',
    knowledge_cutoff_date: input.knowledgeCutoffDate,
    strategy_weights: strategyWeights,
    quarantined_strategy_ids: quarantinedStrategyIds,
    candidate_ready_strategy_ids: candidateReadyStrategyIds,
    base_weight_source: input.base.source,
    base_weight_run_id: baseWeightRunId,
    canonical_payload: canonicalPayload,
    evidence: {
      production_effect: true,
      safety_reducing_only: true,
      raw_labels_preserved: true,
      experimental_threshold_deltas_applied: false,
      complete_non_retired_weight_map: true,
      normalized_promoted_weights: normalizedPromotedWeights,
      positive_weight_count: Object.values(strategyWeights).filter((weight) => weight > 0).length,
      allocation_eligibility_contract_version: STRATEGY_ALLOCATION_ELIGIBILITY_CONTRACT_VERSION,
    },
  }
}
