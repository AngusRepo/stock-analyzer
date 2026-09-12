import {
  FORMAL_STRATEGY_EVIDENCE_CALIBRATED_WEIGHT_EFFECT,
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

// A late computation is not a policy that was available at the earlier open.
// Serving admits it from the next Taipei decision date, preserving created_at.
// Historical reconstruction retains its separately verified frozen-policy path.
export const STRATEGY_PRODUCTION_POLICY_SERVING_SQL = STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL.replace(
  'ORDER BY knowledge_cutoff_date',
  "AND datetime(created_at) < datetime(?, '-8 hours') ORDER BY knowledge_cutoff_date",
)

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
export interface LoadedHistoricalStrategyProductionPolicy extends LoadedStrategyProductionPolicy {
  reconstruction_receipt: {
    source_contract: 'strategy-evidence-owner-fusion-v3' | 'strategy-evidence-owner-fusion-v2' | 'previous-firewall-v2'
    scope: 'historical_reconstruction_only'
    checksum_verified: true
  }
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
  routingWeights: Record<string, number>
  performanceWeightOwner: 'ple_portfolio_metrics' | 'formal_evidence_owner'
  source: 'authoritative_production_policy' | 'production_policy_unavailable_abstain'
  abstained: boolean
}

export const STRATEGY_ROUTING_WEIGHT_MULTIPLIER_MIN = 0.15 as const
export const STRATEGY_ROUTING_WEIGHT_MULTIPLIER_MAX = 1.8 as const
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
      routingWeights: Object.fromEntries(ids.map((id) => [id, 0])),
      performanceWeightOwner: 'ple_portfolio_metrics',
      source: 'production_policy_unavailable_abstain',
      abstained: true,
    }
  }
  const allocationWeights = Object.fromEntries(ids.map((id) => {
    const value = Number(policy.state.strategy_weights[id])
    return [id, Number.isFinite(value) && value > 0 ? value : 0]
  }))
  const positiveWeights = Object.values(allocationWeights).filter((weight) => weight > 0)
  const meanPositiveWeight = positiveWeights.length > 0
    ? positiveWeights.reduce((sum, weight) => sum + weight, 0) / positiveWeights.length
    : 0
  const routingWeights = Object.fromEntries(ids.map((id) => {
    const weight = allocationWeights[id]
    if (!(weight > 0) || !(meanPositiveWeight > 0)) return [id, 0]
    const relative = weight / meanPositiveWeight
    return [id, Number(Math.min(
      STRATEGY_ROUTING_WEIGHT_MULTIPLIER_MAX,
      Math.max(STRATEGY_ROUTING_WEIGHT_MULTIPLIER_MIN, relative),
    ).toFixed(6))]
  }))
  const evidenceOwner = (policy.state.evidence as {
    evidence_owner?: { weight_effect?: unknown } | null
  }).evidence_owner
  return {
    allocationWeights,
    evaluationWeights,
    routingWeights,
    performanceWeightOwner: evidenceOwner?.weight_effect === FORMAL_STRATEGY_EVIDENCE_CALIBRATED_WEIGHT_EFFECT
      ? 'formal_evidence_owner'
      : 'ple_portfolio_metrics',
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

// Semantic comparison only; checksums always hash the original raw payload.
function normalizedPolicyJson(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, ordered(child)])) : item
  return JSON.stringify(ordered(value))
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
  const evidenceOwner = evidence.evidence_owner && typeof evidence.evidence_owner === 'object' && !Array.isArray(evidence.evidence_owner)
    ? evidence.evidence_owner as Record<string, unknown>
    : {}
  const evidenceWeightEffectValid = evidenceOwner.weight_effect === 'neutral_until_immutable_calibration'
    || evidenceOwner.weight_effect === 'immutable_oos_calibrated_bounded_bidirectional'
  const calibratedEvidenceValid = evidenceOwner.weight_effect !== 'immutable_oos_calibrated_bounded_bidirectional'
    || (Boolean(evidenceOwner.calibration_run_id)
      && /^[a-f0-9]{64}$/.test(String(evidenceOwner.calibration_artifact_checksum ?? '')))
  if (
    (row.base_weight_source === 'adaptive_strategy_policy_v2' || Object.keys(evidenceOwner).length > 0)
    && (
      evidenceOwner.version !== 'strategy-evidence-owner-fusion-v3'
      || !evidenceWeightEffectValid
      || !calibratedEvidenceValid
    )
  ) {
    throw new Error('invalid_strategy_production_policy_evidence_owner')
  }
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

/**
 * Historical reconstruction compatibility is deliberately narrower than the
 * runtime reader above. It accepts only the immutable owner-v2 payload that
 * was persisted by firewall-v3 before owner-v3 existed. Runtime allocation
 * and serving must never call this adapter.
 */
export function deserializeHistoricalStrategyProductionPolicyRow(
  row: StrategyProductionPolicyHistoryRow,
  expectedStrategyIds: readonly string[],
): Omit<LoadedHistoricalStrategyProductionPolicy, 'reconstruction_receipt'> & {
  reconstruction_receipt: Omit<LoadedHistoricalStrategyProductionPolicy['reconstruction_receipt'], 'checksum_verified'>
} {
  try {
    const loaded = deserializeStrategyProductionPolicyRow(row, expectedStrategyIds)
    return {
      ...loaded,
      reconstruction_receipt: {
        source_contract: 'strategy-evidence-owner-fusion-v3',
        scope: 'historical_reconstruction_only',
      },
    }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'invalid_strategy_production_policy_evidence_owner') {
      throw error
    }
  }

  const evidence = parseJsonRecord(row.evidence_json)
  const evidenceOwner = evidence.evidence_owner && typeof evidence.evidence_owner === 'object'
    && !Array.isArray(evidence.evidence_owner)
    ? evidence.evidence_owner as Record<string, unknown>
    : {}
  if (
    row.policy_id !== STRATEGY_PRODUCTION_FIREWALL_POLICY_ID
    || Number(row.version) !== STRATEGY_PRODUCTION_FIREWALL_VERSION
    || row.status !== 'active'
    || row.base_weight_source !== 'adaptive_strategy_policy_v2'
    || evidenceOwner.version !== 'strategy-evidence-owner-fusion-v2'
    || evidenceOwner.weight_effect !== 'mature_ready_only_bounded_bidirectional'
    || !/^[a-f0-9]{64}$/.test(String(evidenceOwner.checksum ?? ''))
    || !Number.isInteger(Number(evidenceOwner.ready_profile_count))
    || Number(evidenceOwner.ready_profile_count) <= 0
  ) {
    throw new Error('invalid_historical_strategy_production_policy_evidence_owner')
  }
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
    throw new Error('invalid_historical_strategy_production_policy_evidence')
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
        evidence_owner: evidenceOwner as StrategyProductionFirewallState['evidence']['evidence_owner'],
      },
    },
    checksum: row.checksum,
    created_at: row.created_at,
    reconstruction_receipt: {
      source_contract: 'strategy-evidence-owner-fusion-v2',
      scope: 'historical_reconstruction_only',
    },
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

export interface PreparedStrategyProductionPolicyWrite {
  readonly checksum: string
  readonly statements: readonly D1PreparedStatement[]
  verifyCommitted(): Promise<LoadedStrategyProductionPolicy>
}

/** Build the ORIGINAL policy write for composition in an owner's D1 batch.
 * Read-only: schema initialization and transaction execution belong to the caller.
 * This is storage, NOT promotion authority; callers must still verify the NAV
 * proof, registry/config CAS and publication receipt in their own transaction.
 */
export async function prepareStrategyProductionPolicyWrite(
  db: D1Database,
  input: StrategyProductionFirewallState,
): Promise<PreparedStrategyProductionPolicyWrite> {
  // Hash, SQL and readback must refer to one value even across asynchronous work.
  const state = structuredClone(input)
  const checksum = await sha256StrategyProductionPolicyPayload(state.canonical_payload)
  const row: StrategyProductionPolicyHistoryRow = {
    policy_id: state.policy_id, knowledge_cutoff_date: state.knowledge_cutoff_date,
    version: state.version, status: state.status,
    strategy_weights_json: JSON.stringify(state.strategy_weights),
    quarantined_strategy_ids_json: JSON.stringify(state.quarantined_strategy_ids),
    candidate_ready_strategy_ids_json: JSON.stringify(state.candidate_ready_strategy_ids),
    base_weight_source: state.base_weight_source, base_weight_run_id: state.base_weight_run_id,
    evidence_json: JSON.stringify(state.evidence), canonical_payload: state.canonical_payload,
    checksum, created_at: '', // D1, not a caller-supplied historical time, owns availability.
  }
  const strategyIds = Object.keys(state.strategy_weights)
  deserializeStrategyProductionPolicyRow(row, strategyIds)
  await verifyServingStrategyProductionPolicyIntegrity(row)
  const columns = ['policy_id', 'knowledge_cutoff_date', 'version', 'status', 'strategy_weights_json',
    'quarantined_strategy_ids_json', 'candidate_ready_strategy_ids_json', 'base_weight_source',
    'base_weight_run_id', 'evidence_json', 'canonical_payload', 'checksum'] as const
  const values = columns.map(column => row[column])
  const readStored = () => db.prepare(`SELECT * FROM strategy_production_policy_history_v1
    WHERE policy_id=? AND knowledge_cutoff_date=? AND checksum=? LIMIT 1`)
    .bind(state.policy_id, state.knowledge_cutoff_date, checksum).first<StrategyProductionPolicyHistoryRow>()
  const previous = await readStored()
  if (previous) {
    deserializeStrategyProductionPolicyRow(previous, strategyIds)
    await verifyServingStrategyProductionPolicyIntegrity(previous)
    if (normalizedPolicyJson(parseJsonRecord(previous.evidence_json)) !== normalizedPolicyJson(state.evidence)) {
      throw new Error('strategy_production_policy_retry_evidence_mismatch')
    }
  }
  // Preserve equivalent existing serialization on retry; CAS the bytes read.
  const guardedValues = columns.map(column => (previous ?? row)[column])
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO strategy_production_policy_history_v1
      (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...values),
    // A duplicate checksum is not proof of identical content. Guard the entire
    // persisted projection in the SAME transaction, including retries/triggers.
    // A conflicting old record is preserved for repair, never overwritten here.
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM strategy_production_policy_history_v1
      WHERE ${columns.map(column => `${column} IS ?`).join(' AND ')}
        AND (? IS NULL OR created_at IS ?))
      THEN 1 ELSE json('strategy_production_policy_commit_content_mismatch') END`)
      .bind(...guardedValues, previous?.created_at ?? null, previous?.created_at ?? null),
  ]
  return Object.freeze({ checksum, statements: Object.freeze(statements),
    async verifyCommitted(): Promise<LoadedStrategyProductionPolicy> {
      const existing = await readStored()
      if (existing?.checksum !== checksum) {
        throw new Error(`strategy_production_policy_persistence_missing:${state.knowledge_cutoff_date}:${checksum}`)
      }
      const loaded = deserializeStrategyProductionPolicyRow(existing, strategyIds)
      await verifyServingStrategyProductionPolicyIntegrity(existing)
      if (columns.some((column, index) => existing[column] !== guardedValues[index])
        || (previous && existing.created_at !== previous.created_at)) {
        throw new Error('strategy_production_policy_readback_changed')
      }
      return loaded
    },
  })
}

export async function persistStrategyProductionPolicy(
  db: D1Database,
  state: StrategyProductionFirewallState,
): Promise<{ checksum: string; inserted: boolean }> {
  // Preserve the existing standalone owner while sharing the exact same write
  // with compound publication; never nest batches or commit policy separately.
  const captured = structuredClone(state)
  await ensureStrategyProductionPolicyHistoryTable(db)
  const prepared = await prepareStrategyProductionPolicyWrite(db, captured)
  const statements = [...prepared.statements]
  const writes = await db.batch(statements).catch(cause => {
    // D1 reports a failed SQL guard as generic malformed JSON. Preserve the
    // original cause while exposing which publication transaction failed.
    throw new Error('strategy_production_policy_transaction_failed', { cause })
  })
  if (writes.length !== statements.length || writes.some(write => !write.success)) {
    throw new Error('strategy_production_policy_transaction_incomplete')
  }

  await prepared.verifyCommitted()
  return { checksum: prepared.checksum, inserted: Number(writes[0].meta?.changes ?? 0) > 0 }
}

export async function loadStrategyProductionPolicyBefore(
  db: D1Database,
  knowledgeCutoffDate: string,
  expectedStrategyIds: readonly string[],
): Promise<LoadedStrategyProductionPolicy | null> {
  await ensureStrategyProductionPolicyHistoryTable(db)
  const row = await db.prepare(STRATEGY_PRODUCTION_POLICY_SERVING_SQL)
    .bind(STRATEGY_PRODUCTION_FIREWALL_POLICY_ID, knowledgeCutoffDate, knowledgeCutoffDate)
    .first<StrategyProductionPolicyHistoryRow>()
  if (row) {
    const loaded = deserializeStrategyProductionPolicyRow(row, expectedStrategyIds)
    await verifyServingStrategyProductionPolicyIntegrity(row)
    return loaded
  }
  const previous = await db.prepare(STRATEGY_PRODUCTION_POLICY_SERVING_SQL)
    .bind(PREVIOUS_STRATEGY_PRODUCTION_FIREWALL_POLICY_ID, knowledgeCutoffDate, knowledgeCutoffDate)
    .first<StrategyProductionPolicyHistoryRow>()
  if (!previous) return null
  const loaded = deserializePreviousStrategyProductionPolicyRow(previous, expectedStrategyIds)
  await verifyServingStrategyProductionPolicyIntegrity(previous)
  return loaded
}

async function verifyServingStrategyProductionPolicyIntegrity(row: StrategyProductionPolicyHistoryRow): Promise<void> {
  assertStrategyProductionPolicyCanonicalParity(row, 'strategy_production_policy')
  if (await sha256StrategyProductionPolicyPayload(row.canonical_payload) !== row.checksum) {
    throw new Error(`strategy_production_policy_checksum_mismatch:${row.knowledge_cutoff_date}`)
  }
}

/** Exact original policy record verification shared with compound publication.
 * This proves storage integrity, not promotion authority or serving availability.
 */
export async function verifyStrategyProductionPolicyRecord(row: StrategyProductionPolicyHistoryRow,
  expectedStrategyIds: readonly string[]): Promise<LoadedStrategyProductionPolicy> {
  const loaded = deserializeStrategyProductionPolicyRow(row, expectedStrategyIds)
  await verifyServingStrategyProductionPolicyIntegrity(row)
  return loaded
}

function assertHistoricalStrategyProductionPolicyCanonicalParity(
  row: StrategyProductionPolicyHistoryRow,
): void {
  assertStrategyProductionPolicyCanonicalParity(row, 'historical_strategy_production_policy')
}

function assertStrategyProductionPolicyCanonicalParity(
  row: StrategyProductionPolicyHistoryRow,
  errorPrefix: string,
): void {
  const canonical = parseJsonRecord(row.canonical_payload)
  const canonicalWeights = canonical.strategy_weights && typeof canonical.strategy_weights === 'object'
    && !Array.isArray(canonical.strategy_weights)
    ? canonical.strategy_weights as Record<string, unknown>
    : {}
  const persistedWeights = parseJsonRecord(row.strategy_weights_json)
  const evidence = parseJsonRecord(row.evidence_json)
  const canonicalOwner = canonical.evidence_owner && typeof canonical.evidence_owner === 'object'
    && !Array.isArray(canonical.evidence_owner)
    ? canonical.evidence_owner as Record<string, unknown>
    : {}
  const persistedOwner = evidence.evidence_owner && typeof evidence.evidence_owner === 'object'
    && !Array.isArray(evidence.evidence_owner)
    ? evidence.evidence_owner as Record<string, unknown>
    : {}
  const canonicalQuarantined = Array.isArray(canonical.quarantined_strategy_ids)
    ? [...canonical.quarantined_strategy_ids].map(String).sort()
    : []
  const canonicalCandidates = Array.isArray(canonical.candidate_ready_strategy_ids)
    ? [...canonical.candidate_ready_strategy_ids].map(String).sort()
    : []
  const persistedQuarantined = parseStringArray(row.quarantined_strategy_ids_json).sort()
  const persistedCandidates = parseStringArray(row.candidate_ready_strategy_ids_json).sort()
  if (
    canonical.policy_id !== row.policy_id
    || Number(canonical.version) !== Number(row.version)
    || canonical.knowledge_cutoff_date !== row.knowledge_cutoff_date
    || canonical.base_weight_source !== row.base_weight_source
    || (canonical.base_weight_run_id ?? null) !== row.base_weight_run_id
    || normalizedPolicyJson(canonicalWeights) !== normalizedPolicyJson(persistedWeights)
    || JSON.stringify(canonicalQuarantined) !== JSON.stringify(persistedQuarantined)
    || JSON.stringify(canonicalCandidates) !== JSON.stringify(persistedCandidates)
    || normalizedPolicyJson(canonicalOwner) !== normalizedPolicyJson(persistedOwner)
    || (row.policy_id === STRATEGY_PRODUCTION_FIREWALL_POLICY_ID
      && canonical.allocation_eligibility_contract_version !== evidence.allocation_eligibility_contract_version)
  ) {
    throw new Error(`${errorPrefix}_canonical_parity_failed:${row.knowledge_cutoff_date}`)
  }
}

export async function loadStrategyProductionPolicyForHistoricalReconstructionBefore(
  db: D1Database,
  knowledgeCutoffDate: string,
  expectedStrategyIds: readonly string[],
): Promise<LoadedHistoricalStrategyProductionPolicy | null> {
  await ensureStrategyProductionPolicyHistoryTable(db)
  const row = await db.prepare(STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL)
    .bind(STRATEGY_PRODUCTION_FIREWALL_POLICY_ID, knowledgeCutoffDate)
    .first<StrategyProductionPolicyHistoryRow>()
  if (row) {
    const loaded = deserializeHistoricalStrategyProductionPolicyRow(row, expectedStrategyIds)
    assertHistoricalStrategyProductionPolicyCanonicalParity(row)
    const checksum = await sha256StrategyProductionPolicyPayload(row.canonical_payload)
    if (checksum !== row.checksum) {
      throw new Error(`historical_strategy_production_policy_checksum_mismatch:${row.knowledge_cutoff_date}`)
    }
    return {
      ...loaded,
      reconstruction_receipt: {
        ...loaded.reconstruction_receipt,
        checksum_verified: true,
      },
    }
  }
  const previous = await db.prepare(STRATEGY_PRODUCTION_POLICY_POINT_IN_TIME_SQL)
    .bind(PREVIOUS_STRATEGY_PRODUCTION_FIREWALL_POLICY_ID, knowledgeCutoffDate)
    .first<StrategyProductionPolicyHistoryRow>()
  if (!previous) return null
  const loaded = deserializePreviousStrategyProductionPolicyRow(previous, expectedStrategyIds)
  assertHistoricalStrategyProductionPolicyCanonicalParity(previous)
  const checksum = await sha256StrategyProductionPolicyPayload(previous.canonical_payload)
  if (checksum !== previous.checksum) {
    throw new Error(`historical_strategy_production_policy_checksum_mismatch:${previous.knowledge_cutoff_date}`)
  }
  return {
    ...loaded,
    reconstruction_receipt: {
      source_contract: 'previous-firewall-v2',
      scope: 'historical_reconstruction_only',
      checksum_verified: true,
    },
  }
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
  if (!row) return null
  const loaded = deserializeLegacyStrategyProductionWeightsRow(row, expectedStrategyIds)
  assertHistoricalStrategyProductionPolicyCanonicalParity(row)
  const checksum = await sha256StrategyProductionPolicyPayload(row.canonical_payload)
  if (checksum !== row.checksum) {
    throw new Error(`historical_strategy_production_policy_checksum_mismatch:${row.knowledge_cutoff_date}`)
  }
  return loaded
}
