import {
  STRATEGY_ALLOCATION_ELIGIBILITY_CONTRACT_VERSION,
  STRATEGY_PRODUCTION_FIREWALL_POLICY_ID,
  STRATEGY_PRODUCTION_FIREWALL_VERSION,
  type StrategyProductionBaseWeightSource,
  type StrategyProductionFirewallState,
} from './strategyProductionContributionFirewall'

export const STRATEGY_PRODUCTION_POLICY_HISTORY_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS strategy_production_policy_history_v1 (
    policy_id TEXT NOT NULL,
    knowledge_cutoff_date TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active')),
    strategy_weights_json TEXT NOT NULL,
    quarantined_strategy_ids_json TEXT NOT NULL DEFAULT '[]',
    candidate_ready_strategy_ids_json TEXT NOT NULL DEFAULT '[]',
    base_weight_source TEXT NOT NULL,
    base_weight_run_id TEXT,
    evidence_json TEXT NOT NULL,
    canonical_payload TEXT NOT NULL,
    checksum TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY(policy_id, knowledge_cutoff_date, checksum)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_production_policy_history_v1_cutoff
    ON strategy_production_policy_history_v1(policy_id, status, knowledge_cutoff_date DESC, created_at DESC)`,
] as const

export const STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL = `
  SELECT policy_id, knowledge_cutoff_date, version, status,
         strategy_weights_json, quarantined_strategy_ids_json,
         candidate_ready_strategy_ids_json, base_weight_source,
         base_weight_run_id, evidence_json, canonical_payload,
         checksum, created_at
    FROM strategy_production_policy_history_v1
   WHERE policy_id=? AND status='active' AND knowledge_cutoff_date < ?
   ORDER BY knowledge_cutoff_date DESC, created_at DESC, checksum DESC
   LIMIT 1
`

export const LEGACY_STRATEGY_PRODUCTION_FIREWALL_POLICY_ID =
  'strategy-production-contribution-firewall-v1' as const
export const LEGACY_STRATEGY_PRODUCTION_FIREWALL_VERSION = 1 as const
export const LEGACY_STRATEGY_IMPLICIT_UNIT_WEIGHTS_LAST_SIGNAL_DATE = '2026-08-04' as const
export const LEGACY_STRATEGY_IMPLICIT_UNIT_WEIGHTS_CONTRACT_VERSION =
  'multi-strategy-ple-runtime-default-unit-weights-v1' as const
export const LEGACY_STRATEGY_IMPLICIT_UNIT_WEIGHTS_SOURCE_COMMIT = '9132ce95' as const
export const PREVIOUS_STRATEGY_PRODUCTION_FIREWALL_POLICY_ID =
  'strategy-production-contribution-firewall-v2' as const
export const PREVIOUS_STRATEGY_PRODUCTION_FIREWALL_VERSION = 2 as const
export const PREVIOUS_STRATEGY_ALLOCATION_ELIGIBILITY_CONTRACT_VERSION =
  'strategy-allocation-eligibility-v2' as const

export interface StrategyProductionPolicyHistoryRow {
  policy_id: string
  knowledge_cutoff_date: string
  version: number | string
  status: string
  strategy_weights_json: string
  quarantined_strategy_ids_json: string
  candidate_ready_strategy_ids_json: string
  base_weight_source: string
  base_weight_run_id: string | null
  evidence_json: string
  canonical_payload: string
  checksum: string
  created_at: string
}

export interface LoadedStrategyProductionPolicy {
  state: StrategyProductionFirewallState | PreviousStrategyProductionFirewallState
  checksum: string
  created_at: string
}
export type PreviousStrategyProductionFirewallState = Omit<
  StrategyProductionFirewallState,
  'policy_id' | 'version' | 'evidence'
> & {
  policy_id: typeof PREVIOUS_STRATEGY_PRODUCTION_FIREWALL_POLICY_ID
  version: typeof PREVIOUS_STRATEGY_PRODUCTION_FIREWALL_VERSION
  evidence: {
    production_effect: true
    safety_reducing_only: true
    raw_labels_preserved: true
    experimental_threshold_deltas_applied: false
    complete_non_retired_weight_map: true
    allocation_eligibility_contract_version: typeof PREVIOUS_STRATEGY_ALLOCATION_ELIGIBILITY_CONTRACT_VERSION
    normalized_promoted_weights: boolean
    positive_weight_count: number
  }
}
export type RuntimeStrategyWeightResolution = {
  allocationWeights: Record<string, number>
  evaluationWeights: Record<string, number>
  source: 'authoritative_production_policy' | 'production_policy_unavailable_abstain'
  abstained: boolean
}
export interface LoadedLegacyStrategyProductionWeights {
  policy_id: typeof LEGACY_STRATEGY_PRODUCTION_FIREWALL_POLICY_ID
  version: typeof LEGACY_STRATEGY_PRODUCTION_FIREWALL_VERSION
  knowledge_cutoff_date: string
  strategy_weights: Record<string, number>
  checksum: string
  created_at: string
}

export interface LegacyImplicitUnitWeightsResolution {
  strategy_weights: Record<string, number>
  evidence: {
    source: 'implicit_runtime_default_unit_weights'
    contract_version: typeof LEGACY_STRATEGY_IMPLICIT_UNIT_WEIGHTS_CONTRACT_VERSION
    source_commit: typeof LEGACY_STRATEGY_IMPLICIT_UNIT_WEIGHTS_SOURCE_COMMIT
    firewall_materialization_date: typeof LEGACY_STRATEGY_IMPLICIT_UNIT_WEIGHTS_LAST_SIGNAL_DATE
    no_lookahead: true
  }
}

export function resolveLegacyImplicitUnitWeightsBeforeFirewall(
  knowledgeCutoffDate: string,
  expectedStrategyIds: readonly string[],
): LegacyImplicitUnitWeightsResolution | null {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(knowledgeCutoffDate)
    || knowledgeCutoffDate > LEGACY_STRATEGY_IMPLICIT_UNIT_WEIGHTS_LAST_SIGNAL_DATE
  ) return null
  const strategyIds = [...new Set(expectedStrategyIds.map((id) => String(id).trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
  if (!strategyIds.length) return null
  return {
    strategy_weights: Object.fromEntries(strategyIds.map((id) => [id, 1])),
    evidence: {
      source: 'implicit_runtime_default_unit_weights',
      contract_version: LEGACY_STRATEGY_IMPLICIT_UNIT_WEIGHTS_CONTRACT_VERSION,
      source_commit: LEGACY_STRATEGY_IMPLICIT_UNIT_WEIGHTS_SOURCE_COMMIT,
      firewall_materialization_date: LEGACY_STRATEGY_IMPLICIT_UNIT_WEIGHTS_LAST_SIGNAL_DATE,
      no_lookahead: true,
    },
  }
}

export function hasPositiveStrategyAllocation(
  strategyIds: readonly string[] | null | undefined,
  allocationWeights: Readonly<Record<string, number>>,
): boolean {
  return (strategyIds ?? []).some((strategyId) => {
    const value = Number(allocationWeights[String(strategyId).trim()])
    return Number.isFinite(value) && value > 0
  })
}

export function resolveRuntimeStrategyWeights(
  strategyIds: readonly string[],
  policy: LoadedStrategyProductionPolicy | null | undefined,
): RuntimeStrategyWeightResolution {
  const ids = [...new Set(strategyIds.map((id) => String(id).trim()).filter(Boolean))].sort()
  const evaluationWeights = Object.fromEntries(ids.map((id) => [id, 1]))
  if (!policy) {
    return {
      allocationWeights: Object.fromEntries(ids.map((id) => [id, 0])),
      evaluationWeights,
      source: 'production_policy_unavailable_abstain',
      abstained: true,
    }
  }
  return {
    allocationWeights: Object.fromEntries(ids.map((id) => {
      const value = Number(policy.state.strategy_weights[id])
      return [id, Number.isFinite(value) && value > 0 ? value : 0]
    })),
    evaluationWeights,
    source: 'authoritative_production_policy',
    abstained: false,
  }
}


function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_strategy_production_policy_record')
  }
  return parsed as Record<string, unknown>
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('invalid_strategy_production_policy_string_array')
  }
  return [...new Set(parsed)].sort((left, right) => left.localeCompare(right))
}

function parseWeights(value: string, expectedStrategyIds: readonly string[]): Record<string, number> {
  const parsed = parseJsonRecord(value)
  const weights: Record<string, number> = {}
  for (const strategyId of [...new Set(expectedStrategyIds)].sort((left, right) => left.localeCompare(right))) {
    const weight = parsed[strategyId]
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new Error(`incomplete_strategy_production_policy_weight:${strategyId}`)
    }
    weights[strategyId] = weight
  }
  return weights
}

function parseBaseWeightSource(value: string): StrategyProductionBaseWeightSource {
  if (
    value === 'adaptive_strategy_policy_v2'
    || value === 'promoted_marginal_edge_v6'
    || value === 'runtime_default_unit_weights'
  ) return value
  throw new Error(`invalid_strategy_production_policy_base_source:${value}`)
}

export function deserializeStrategyProductionPolicyRow(
  row: StrategyProductionPolicyHistoryRow,
  expectedStrategyIds: readonly string[],
): LoadedStrategyProductionPolicy {
  if (
    row.policy_id !== STRATEGY_PRODUCTION_FIREWALL_POLICY_ID
    || Number(row.version) !== STRATEGY_PRODUCTION_FIREWALL_VERSION
    || row.status !== 'active'
  ) {
    throw new Error('invalid_strategy_production_policy_identity')
  }

  const evidence = parseJsonRecord(row.evidence_json)
  if (
    evidence.production_effect !== true
    || evidence.safety_reducing_only !== false
    || evidence.bounded_bidirectional_adjustment !== true
    || evidence.raw_labels_preserved !== true
    || evidence.experimental_threshold_deltas_applied !== false
    || evidence.allocation_eligibility_contract_version
      !== STRATEGY_ALLOCATION_ELIGIBILITY_CONTRACT_VERSION
    || evidence.complete_non_retired_weight_map !== true
  ) {
    throw new Error('invalid_strategy_production_policy_evidence')
  }

  return {
    state: {
      policy_id: STRATEGY_PRODUCTION_FIREWALL_POLICY_ID,
      version: STRATEGY_PRODUCTION_FIREWALL_VERSION,
      status: 'active',
      knowledge_cutoff_date: row.knowledge_cutoff_date,
      strategy_weights: parseWeights(row.strategy_weights_json, expectedStrategyIds),
      quarantined_strategy_ids: parseStringArray(row.quarantined_strategy_ids_json),
      candidate_ready_strategy_ids: parseStringArray(row.candidate_ready_strategy_ids_json),
      base_weight_source: parseBaseWeightSource(row.base_weight_source),
      base_weight_run_id: row.base_weight_run_id,
      canonical_payload: row.canonical_payload,
      evidence: {
        production_effect: true,
        safety_reducing_only: false,
        bounded_bidirectional_adjustment: true,
        diversity_retention_budget: 0.15,
        raw_labels_preserved: true,
        experimental_threshold_deltas_applied: false,
        complete_non_retired_weight_map: true,
        allocation_eligibility_contract_version: STRATEGY_ALLOCATION_ELIGIBILITY_CONTRACT_VERSION,
        normalized_promoted_weights: evidence.normalized_promoted_weights === true,
        positive_weight_count: Number(evidence.positive_weight_count) || 0,
        diversity_retained_strategy_count: Number(evidence.diversity_retained_strategy_count) || 0,
        evidence_owner: evidence.evidence_owner && typeof evidence.evidence_owner === 'object'
          ? evidence.evidence_owner as StrategyProductionFirewallState['evidence']['evidence_owner']
          : null,
      },
    },
    checksum: row.checksum,
    created_at: row.created_at,
  }
}

export function deserializePreviousStrategyProductionPolicyRow(
  row: StrategyProductionPolicyHistoryRow,
  expectedStrategyIds: readonly string[],
): LoadedStrategyProductionPolicy {
  if (
    row.policy_id !== PREVIOUS_STRATEGY_PRODUCTION_FIREWALL_POLICY_ID
    || Number(row.version) !== PREVIOUS_STRATEGY_PRODUCTION_FIREWALL_VERSION
    || row.status !== 'active'
  ) throw new Error('invalid_previous_strategy_production_policy_identity')
  const evidence = parseJsonRecord(row.evidence_json)
  if (
    evidence.production_effect !== true
    || evidence.safety_reducing_only !== true
    || evidence.raw_labels_preserved !== true
    || evidence.experimental_threshold_deltas_applied !== false
    || evidence.complete_non_retired_weight_map !== true
    || evidence.allocation_eligibility_contract_version
      !== PREVIOUS_STRATEGY_ALLOCATION_ELIGIBILITY_CONTRACT_VERSION
  ) throw new Error('invalid_previous_strategy_production_policy_evidence')
  return {
    state: {
      policy_id: PREVIOUS_STRATEGY_PRODUCTION_FIREWALL_POLICY_ID,
      version: PREVIOUS_STRATEGY_PRODUCTION_FIREWALL_VERSION,
      status: 'active',
      knowledge_cutoff_date: row.knowledge_cutoff_date,
      strategy_weights: parseWeights(row.strategy_weights_json, expectedStrategyIds),
      quarantined_strategy_ids: parseStringArray(row.quarantined_strategy_ids_json),
      candidate_ready_strategy_ids: parseStringArray(row.candidate_ready_strategy_ids_json),
      base_weight_source: parseBaseWeightSource(row.base_weight_source),
      base_weight_run_id: row.base_weight_run_id,
      canonical_payload: row.canonical_payload,
      evidence: {
        production_effect: true,
        safety_reducing_only: true,
        raw_labels_preserved: true,
        experimental_threshold_deltas_applied: false,
        complete_non_retired_weight_map: true,
        allocation_eligibility_contract_version: PREVIOUS_STRATEGY_ALLOCATION_ELIGIBILITY_CONTRACT_VERSION,
        normalized_promoted_weights: evidence.normalized_promoted_weights === true,
        positive_weight_count: Number(evidence.positive_weight_count) || 0,
      },
    },
    checksum: row.checksum,
    created_at: row.created_at,
  }
}

export function deserializeLegacyStrategyProductionWeightsRow(
  row: StrategyProductionPolicyHistoryRow,
  expectedStrategyIds: readonly string[],
): LoadedLegacyStrategyProductionWeights {
  if (
    row.policy_id !== LEGACY_STRATEGY_PRODUCTION_FIREWALL_POLICY_ID
    || Number(row.version) !== LEGACY_STRATEGY_PRODUCTION_FIREWALL_VERSION
    || row.status !== 'active'
  ) {
    throw new Error('invalid_legacy_strategy_production_policy_identity')
  }
  const evidence = parseJsonRecord(row.evidence_json)
  if (
    evidence.production_effect !== true
    || evidence.safety_reducing_only !== true
    || evidence.raw_labels_preserved !== true
    || evidence.experimental_threshold_deltas_applied !== false
    || evidence.complete_non_retired_weight_map !== true
  ) {
    throw new Error('invalid_legacy_strategy_production_policy_evidence')
  }
  return {
    policy_id: LEGACY_STRATEGY_PRODUCTION_FIREWALL_POLICY_ID,
    version: LEGACY_STRATEGY_PRODUCTION_FIREWALL_VERSION,
    knowledge_cutoff_date: row.knowledge_cutoff_date,
    strategy_weights: parseWeights(row.strategy_weights_json, expectedStrategyIds),
    checksum: row.checksum,
    created_at: row.created_at,
  }
}

export async function sha256StrategyProductionPolicyPayload(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function ensureStrategyProductionPolicyHistoryTable(db: D1Database): Promise<void> {
  for (const statement of STRATEGY_PRODUCTION_POLICY_HISTORY_SCHEMA) {
    await db.prepare(statement).run()
  }
}

export async function persistStrategyProductionPolicy(
  db: D1Database,
  state: StrategyProductionFirewallState,
): Promise<{ checksum: string; inserted: boolean }> {
  await ensureStrategyProductionPolicyHistoryTable(db)
  const checksum = await sha256StrategyProductionPolicyPayload(state.canonical_payload)
  const result = await db.prepare(`
    INSERT OR IGNORE INTO strategy_production_policy_history_v1 (
      policy_id, knowledge_cutoff_date, version, status,
      strategy_weights_json, quarantined_strategy_ids_json,
      candidate_ready_strategy_ids_json, base_weight_source,
      base_weight_run_id, evidence_json, canonical_payload, checksum
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    state.policy_id,
    state.knowledge_cutoff_date,
    state.version,
    state.status,
    JSON.stringify(state.strategy_weights),
    JSON.stringify(state.quarantined_strategy_ids),
    JSON.stringify(state.candidate_ready_strategy_ids),
    state.base_weight_source,
    state.base_weight_run_id,
    JSON.stringify(state.evidence),
    state.canonical_payload,
    checksum,
  ).run()

  const existing = await db.prepare(`
    SELECT checksum
      FROM strategy_production_policy_history_v1
     WHERE policy_id=? AND knowledge_cutoff_date=? AND checksum=?
     LIMIT 1
  `).bind(state.policy_id, state.knowledge_cutoff_date, checksum).first<{ checksum?: string }>()
  if (existing?.checksum !== checksum) {
    throw new Error(`strategy_production_policy_persistence_missing:${state.knowledge_cutoff_date}:${checksum}`)
  }

  return { checksum, inserted: Number(result.meta?.changes ?? 0) > 0 }
}

export async function loadStrategyProductionPolicyBefore(
  db: D1Database,
  knowledgeCutoffDate: string,
  expectedStrategyIds: readonly string[],
): Promise<LoadedStrategyProductionPolicy | null> {
  await ensureStrategyProductionPolicyHistoryTable(db)
  const row = await db.prepare(STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL)
    .bind(STRATEGY_PRODUCTION_FIREWALL_POLICY_ID, knowledgeCutoffDate)
    .first<StrategyProductionPolicyHistoryRow>()
  if (row) return deserializeStrategyProductionPolicyRow(row, expectedStrategyIds)
  const previous = await db.prepare(STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL)
    .bind(PREVIOUS_STRATEGY_PRODUCTION_FIREWALL_POLICY_ID, knowledgeCutoffDate)
    .first<StrategyProductionPolicyHistoryRow>()
  return previous ? deserializePreviousStrategyProductionPolicyRow(previous, expectedStrategyIds) : null
}

/**
 * Historical reconstruction only: reads the immutable v1 policy that was
 * actually available before a legacy-labeler signal date. Runtime serving
 * must continue to use loadStrategyProductionPolicyBefore and the v2 policy.
 */
export async function loadLegacyStrategyProductionWeightsBefore(
  db: D1Database,
  knowledgeCutoffDate: string,
  expectedStrategyIds: readonly string[],
): Promise<LoadedLegacyStrategyProductionWeights | null> {
  await ensureStrategyProductionPolicyHistoryTable(db)
  const row = await db.prepare(STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL)
    .bind(LEGACY_STRATEGY_PRODUCTION_FIREWALL_POLICY_ID, knowledgeCutoffDate)
    .first<StrategyProductionPolicyHistoryRow>()
  return row ? deserializeLegacyStrategyProductionWeightsRow(row, expectedStrategyIds) : null
}
