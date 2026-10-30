/** Daily L2 pool definition receipt (R33 D3: Paper does not freeze L2; it
 * records what defined the pool each day). Evidence only, never a gate. It
 * rides in the existing screener_funnel_runs.metadata, not a new D1 table.
 */
import { sha256Text } from './datasetSnapshots'

export const L2_POOL_DEFINITION_SCHEMA_VERSION = 'l2-pool-definition-v1'

export interface L2PoolDefinitionInput {
  admissionRuleVersion: string
  routeScoreFormulaVersion: string
  strategyRegistryChecksum: string
  admissionStrategyIds: string[]
  regimeActiveStrategyIds: string[]
  /** Policy that rarely changes: L0/L0.5 tradability and post-route safety. */
  staticPolicy: Record<string, unknown>
  /** Inputs that legitimately move day to day. */
  dailyParams: {
    regime: string | null
    evidenceMode: string | null
    productionStrategyWeights: Record<string, number>
    evaluationStrategyWeights: Record<string, number>
  }
  sourceUniverseCount: number
  l15SlateSymbols: string[]
  safetyExcludedSymbols: string[]
  poolSymbols: string[]
}

/** Key-sorted JSON so the digests do not depend on insertion order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const sortedSymbols = (symbols: string[]) =>
  [...new Set(symbols.map((symbol) => String(symbol ?? '').trim().toUpperCase()).filter(Boolean))].sort()

export async function buildL2PoolDefinitionReceipt(input: L2PoolDefinitionInput) {
  const admissionStrategyIds = [...new Set(input.admissionStrategyIds)].sort()
  const regimeActiveStrategyIds = [...new Set(input.regimeActiveStrategyIds)].sort()
  const staticPolicyDigest = await sha256Text(canonicalJson(input.staticPolicy))
  const ruleHash = await sha256Text(canonicalJson({
    admission_rule_version: input.admissionRuleVersion,
    strategy_registry_checksum: input.strategyRegistryChecksum,
    admission_strategy_ids: admissionStrategyIds,
    static_policy_digest: staticPolicyDigest,
  }))
  const dailyParamsDigest = await sha256Text(canonicalJson({
    regime: input.dailyParams.regime,
    evidence_mode: input.dailyParams.evidenceMode,
    regime_active_strategy_ids: regimeActiveStrategyIds,
    production_strategy_weights: input.dailyParams.productionStrategyWeights,
    evaluation_strategy_weights: input.dailyParams.evaluationStrategyWeights,
  }))
  const poolSymbols = sortedSymbols(input.poolSymbols)
  return {
    schema_version: L2_POOL_DEFINITION_SCHEMA_VERSION,
    enforcement: 'evidence_only_not_gate' as const,
    admission_rule_version: input.admissionRuleVersion,
    route_score_formula_version: input.routeScoreFormulaVersion,
    strategy_registry_checksum: input.strategyRegistryChecksum,
    admission_strategy_ids: admissionStrategyIds,
    regime_active_strategy_ids: regimeActiveStrategyIds,
    static_policy: input.staticPolicy,
    static_policy_digest: staticPolicyDigest,
    regime: input.dailyParams.regime,
    evidence_mode: input.dailyParams.evidenceMode,
    daily_params_digest: dailyParamsDigest,
    /** Changes only when the rule, strategy registry or static policy changes. */
    rule_hash: ruleHash,
    /** rule_hash plus today's regime/weights: the full pool definition. */
    pool_definition_hash: await sha256Text(canonicalJson({ rule_hash: ruleHash, daily_params_digest: dailyParamsDigest })),
    source_universe_count: input.sourceUniverseCount,
    l15_slate_size: sortedSymbols(input.l15SlateSymbols).length,
    safety_excluded_count: sortedSymbols(input.safetyExcludedSymbols).length,
    pool_size: poolSymbols.length,
    pool_members_checksum: await sha256Text(poolSymbols.join(',')),
  }
}
