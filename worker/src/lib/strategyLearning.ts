import {
  DEFAULT_STRATEGY_SPECS,
  assessCandidateAgainstStrategySpecs,
  deriveStrategyRawSignals,
  explainFeatureRefDsl,
  normalizeStrategySpecGovernance,
  validateStrategySpec,
  type StrategyCandidateInput,
  type StrategyFamilyId,
  type StrategyOwnerType,
  type StrategyPromotionStatus,
  type StrategySpec,
  type StrategySpecCandidatePolicy,
  type StrategySpecStatus,
} from './strategySpec'
import { assertOwnerCanOwn } from './strategyOwnerFreeze'

export const STRATEGY_LEARNING_VERSION = 'strategy-learning-v1'

export interface StrategySpecRegistryRow {
  strategy_id: string
  version: string
  name: string
  status: StrategySpecStatus
  owner: 'strategy'
  alpha_bucket: string
  family_id: StrategyFamilyId
  variant_id: string
  owner_type: StrategyOwnerType
  promotion_status: StrategyPromotionStatus
  supported_regimes_json: string
  thesis: string
  thresholds_json: string
  candidate_policy_json?: string
  risk_notes_json: string
  source_refs_json: string
  created_by: string
  created_at?: string
  updated_at?: string
}

export interface StrategySpecRegistryRowOptions {
  sourceRefs?: string[]
  createdBy?: string
}

export interface StrategyDecisionLogRow {
  decision_id: string
  date: string
  symbol: string
  name: string | null
  strategy_id: string
  strategy_version: string
  strategy_status: StrategySpecStatus
  alpha_bucket: string
  matched: 0 | 1
  match_score: number | null
  reason_code: string
  context_json: string
  evidence_json: string
  created_at: string
}

export interface StrategyRewardSourceRow {
  date: string
  symbol: string
  strategy_id: string
  strategy_version: string
  strategy_status: StrategySpecStatus
  alpha_bucket: string
  market_segment?: string | null
  alpha_context?: string | null
  trade_pnl_pct?: number | string | null
  actual_return_pct?: number | string | null
}

export interface StrategyRewardLedgerRow {
  reward_id: string
  strategy_id: string
  strategy_version: string
  strategy_status: StrategySpecStatus
  alpha_bucket: string
  date_start: string | null
  date_end: string | null
  horizon_days: number
  samples: number
  hit_rate: number | null
  avg_return_pct: number | null
  reward_sum: number | null
  max_drawdown_pct: number | null
  coverage: number | null
  market_segment: string
  regime: string
  evidence_json: string
  updated_at: string
}

export type StrategyPromotionDecision = 'not_ready' | 'candidate_ready' | 'active_monitor' | 'active_cooldown'
export type StrategyLearningStage =
  | 'L0_hypothesis'
  | 'L1_shadow'
  | 'L2_paper_active'
  | 'L3_production_allocation'

export interface StrategyPromotionGateRow {
  strategy_id: string
  strategy_version: string
  strategy_status: StrategySpecStatus
  alpha_bucket: string
  current_stage: StrategyLearningStage
  recommended_stage: StrategyLearningStage
  decision: StrategyPromotionDecision
  recommended_next_status: 'shadow' | 'candidate' | 'active'
  requires_wei_approval: boolean
  l3_requires_wei_approval: boolean
  production_effect: false
  missing_evidence: string[]
  evidence: {
    decisions: number
    matched: number
    match_rate: number | null
    samples: number
    hit_rate: number | null
    avg_return_pct: number | null
    max_drawdown_pct: number | null
  }
}

export interface StrategyAdaptivePolicyState {
  policy_id: string
  version: string
  status: 'shadow' | 'candidate' | 'active' | 'retired'
  strategy_weights: Record<string, number>
  threshold_deltas: Record<string, {
    minCloseAboveMa20Pct?: number
    minVolumeExpansion20?: number
    minBrokerCount?: number
    minRevenueGrowthYoY?: number
  }>
  evidence: {
    version: string
    date: string
    source: 'strategy_reward_ledger'
    production_effect: false
    requires_approval_to_activate: true
    eligible_strategy_count: number
    missing_evidence: Record<string, string[]>
  }
  updated_at: string
}

export interface StrategyLearningSummary {
  version: string
  date: string
  spec_source: 'registry'
  specs: Array<StrategySpec & {
    learning: {
      decisions: number
      matched: number
      match_rate: number | null
      samples: number
      hit_rate: number | null
      avg_return_pct: number | null
      max_drawdown_pct: number | null
      status: 'learning' | 'no_decisions' | 'no_reward'
    }
  }>
  promotion_gate: StrategyPromotionGateRow[]
  policy_state_preview: StrategyAdaptivePolicyState
}

export const STRATEGY_POLICY_ID = 'strategy-adaptive-shadow-v1'
const LEGACY_RETIRED_STRATEGY_SPEC_IDS = [
  'finlab_ai_skill_shadow_v1',
  'finlab_ai_skill_discovery_v1',
]

const PROMOTION_MIN_DECISIONS = 30
const PROMOTION_MIN_MATCH_RATE = 0.02
const PROMOTION_MIN_SAMPLES = 30
const PROMOTION_MIN_HIT_RATE = 0.52
const PROMOTION_MIN_AVG_RETURN = 0
const PROMOTION_MIN_MAX_DRAWDOWN = -0.08
const ACTIVE_COOLDOWN_MIN_SAMPLES = 30
const ACTIVE_COOLDOWN_HIT_RATE = 0.48
const STRATEGY_LEARNING_DEFAULT_CANDIDATE_LIMIT = 2000
const STRATEGY_LEARNING_D1_BATCH_SIZE = 250

function stageForStrategyStatus(status: StrategySpecStatus): StrategyLearningStage {
  if (status === 'active') return 'L3_production_allocation'
  if (status === 'candidate') return 'L2_paper_active'
  if (status === 'shadow') return 'L1_shadow'
  return 'L0_hypothesis'
}

const SCHEMA_DDL = [
  `CREATE TABLE IF NOT EXISTS strategy_spec_registry (
    strategy_id TEXT NOT NULL,
    version TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('research','shadow','candidate','active','retired')),
    owner TEXT NOT NULL DEFAULT 'strategy',
    alpha_bucket TEXT NOT NULL,
    family_id TEXT NOT NULL DEFAULT 'TREND_RECLAIM_CONTINUATION',
    variant_id TEXT NOT NULL DEFAULT '',
    owner_type TEXT NOT NULL DEFAULT 'strategy',
    promotion_status TEXT NOT NULL DEFAULT 'production',
    supported_regimes_json TEXT NOT NULL DEFAULT '[]',
    thesis TEXT NOT NULL,
    thresholds_json TEXT NOT NULL DEFAULT '{}',
    candidate_policy_json TEXT NOT NULL DEFAULT '{}',
    risk_notes_json TEXT NOT NULL DEFAULT '[]',
    source_refs_json TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL DEFAULT 'p5_strategy_governance',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(strategy_id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_status
    ON strategy_spec_registry(status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_bucket
    ON strategy_spec_registry(alpha_bucket, status)`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_family
    ON strategy_spec_registry(family_id, status)`,
  `CREATE TABLE IF NOT EXISTS strategy_decision_log (
    decision_id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    name TEXT,
    strategy_id TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    strategy_status TEXT NOT NULL,
    alpha_bucket TEXT NOT NULL,
    matched INTEGER NOT NULL DEFAULT 0,
    match_score REAL,
    reason_code TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    evidence_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(date, symbol, strategy_id, strategy_version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_date
    ON strategy_decision_log(date DESC, strategy_id, matched)`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_symbol
    ON strategy_decision_log(symbol, date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_decision_log_status
    ON strategy_decision_log(strategy_status, matched, date DESC)`,
  `CREATE TABLE IF NOT EXISTS strategy_reward_ledger (
    reward_id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    strategy_status TEXT NOT NULL,
    alpha_bucket TEXT NOT NULL,
    date_start TEXT,
    date_end TEXT,
    horizon_days INTEGER NOT NULL DEFAULT 5,
    samples INTEGER NOT NULL DEFAULT 0,
    hit_rate REAL,
    avg_return_pct REAL,
    reward_sum REAL,
    max_drawdown_pct REAL,
    coverage REAL,
    market_segment TEXT DEFAULT 'all',
    regime TEXT DEFAULT 'all',
    evidence_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(strategy_id, strategy_version, horizon_days, market_segment, regime)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_reward_ledger_strategy
    ON strategy_reward_ledger(strategy_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_reward_ledger_status
    ON strategy_reward_ledger(strategy_status, samples DESC)`,
  `CREATE TABLE IF NOT EXISTS strategy_policy_state (
    policy_id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('shadow','candidate','active','retired')),
    strategy_weights_json TEXT NOT NULL DEFAULT '{}',
    threshold_deltas_json TEXT NOT NULL DEFAULT '{}',
    evidence_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
] as const

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function cleanToken(value: unknown): string {
  return String(value ?? '').trim()
}

function firstCleanToken(...values: unknown[]): string | null {
  for (const value of values) {
    const text = cleanToken(value)
    if (text) return text
  }
  return null
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function round6(value: number | null): number | null {
  return value == null ? null : Math.round(value * 1_000_000) / 1_000_000
}

function stableIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 96)
}

export async function ensureStrategyLearningTables(db: D1Database): Promise<void> {
  for (const sql of SCHEMA_DDL) {
    await db.prepare(sql).run()
  }
  await ensureStrategyRegistryGovernanceColumns(db)
}

async function ensureStrategyRegistryGovernanceColumns(db: D1Database): Promise<void> {
  const ddl = [
    `ALTER TABLE strategy_spec_registry ADD COLUMN family_id TEXT NOT NULL DEFAULT 'TREND_RECLAIM_CONTINUATION'`,
    `ALTER TABLE strategy_spec_registry ADD COLUMN variant_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE strategy_spec_registry ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'strategy'`,
    `ALTER TABLE strategy_spec_registry ADD COLUMN promotion_status TEXT NOT NULL DEFAULT 'production'`,
    `ALTER TABLE strategy_spec_registry ADD COLUMN candidate_policy_json TEXT NOT NULL DEFAULT '{}'`,
    `CREATE INDEX IF NOT EXISTS idx_strategy_spec_registry_family
      ON strategy_spec_registry(family_id, status)`,
  ]
  for (const sql of ddl) {
    try {
      await db.prepare(sql).run()
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).toLowerCase()
      if (!message.includes('duplicate column') && !message.includes('already exists')) {
        throw error
      }
    }
  }
}

export function strategySpecToRegistryRow(
  spec: StrategySpec,
  nowIso = new Date().toISOString(),
  options: StrategySpecRegistryRowOptions = {},
): StrategySpecRegistryRow {
  const normalized = normalizeStrategySpecGovernance(spec)
  return {
    strategy_id: normalized.id,
    version: normalized.version,
    name: normalized.name,
    status: normalized.status,
    owner: 'strategy',
    alpha_bucket: normalized.alphaBucket,
    family_id: normalized.familyId!,
    variant_id: normalized.variantId!,
    owner_type: normalized.ownerType!,
    promotion_status: normalized.promotionStatus!,
    supported_regimes_json: safeJson(normalized.supportedRegimes),
    thesis: normalized.thesis,
    thresholds_json: safeJson(normalized.thresholds),
    candidate_policy_json: safeJson(normalized.candidatePolicy ?? {}),
    risk_notes_json: safeJson(normalized.riskNotes),
    source_refs_json: safeJson(options.sourceRefs ?? ['default_strategy_specs', normalized.createdBy]),
    created_by: options.createdBy ?? 'p5_strategy_governance',
    created_at: nowIso,
    updated_at: nowIso,
  }
}

function candidatePolicyForRegistryRow(row: StrategySpecRegistryRow): StrategySpecCandidatePolicy | undefined {
  const policy = parseJson<StrategySpecCandidatePolicy | null>(row.candidate_policy_json, null)
  if (policy && typeof policy === 'object' && Object.keys(policy).length > 0) return policy
  return undefined
}

function hasLegacyScoreThresholds(thresholds: StrategySpec['thresholds']): boolean {
  return thresholds.minSeedScore != null
    || thresholds.minChipScore != null
    || thresholds.minTechScore != null
    || thresholds.minMomentumScore != null
}

function registryRowSourceRefs(row: StrategySpecRegistryRow): string[] {
  return parseJson(row.source_refs_json, []) as string[]
}

function isGeneratedDiscoveryRegistryRow(row: StrategySpecRegistryRow): boolean {
  const sourceRefs = registryRowSourceRefs(row)
  return row.strategy_id.startsWith('finlab_ai_skill_')
    || row.created_by === 'finlab_ai_skill_discovery_v1'
    || sourceRefs.includes('finlab_ai_skill_discovery_v1')
    || sourceRefs.some((ref) => String(ref).includes('finlab_ai_skill'))
}

function hasRuntimeCandidatePolicy(row: StrategySpecRegistryRow): boolean {
  const policy = parseJson<Record<string, unknown>>(row.candidate_policy_json, {})
  return Boolean(policy && typeof policy === 'object' && Object.keys(policy).length > 0)
}

export function registryRowToStrategySpec(row: StrategySpecRegistryRow): StrategySpec {
  return normalizeStrategySpecGovernance({
    id: row.strategy_id,
    version: row.version,
    name: row.name,
    status: row.status,
    owner: 'strategy',
    alphaBucket: row.alpha_bucket as StrategySpec['alphaBucket'],
    familyId: row.family_id,
    variantId: row.variant_id || row.strategy_id,
    ownerType: row.owner_type,
    promotionStatus: row.promotion_status,
    supportedRegimes: parseJson(row.supported_regimes_json, []) as StrategySpec['supportedRegimes'],
    thesis: row.thesis,
    thresholds: parseJson(row.thresholds_json, {}),
    candidatePolicy: candidatePolicyForRegistryRow(row),
    riskNotes: parseJson(row.risk_notes_json, []),
    createdBy: 'p5_strategy_governance',
  })
}

export async function seedDefaultStrategySpecRegistry(
  db: D1Database,
  options: { nowIso?: string } = {},
): Promise<{ seeded: number; skipped_invalid: string[]; demoted_stale_active: number }> {
  assertOwnerCanOwn('strategy', 'strategy_spec')
  await ensureStrategyLearningTables(db)
  const nowIso = options.nowIso ?? new Date().toISOString()
  let seeded = 0
  const skippedInvalid: string[] = []
  for (const spec of DEFAULT_STRATEGY_SPECS) {
    const validation = validateStrategySpec(spec)
    if (!validation.ok) {
      skippedInvalid.push(`${spec.id}:${validation.errors.join('|')}`)
      continue
    }
    const row = strategySpecToRegistryRow(spec, nowIso)
    await db.prepare(`
      INSERT INTO strategy_spec_registry (
        strategy_id, version, name, status, owner, alpha_bucket,
        family_id, variant_id, owner_type, promotion_status,
        supported_regimes_json, thesis, thresholds_json, candidate_policy_json, risk_notes_json,
        source_refs_json, created_by, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(strategy_id, version) DO UPDATE SET
        name=excluded.name,
        status=excluded.status,
        alpha_bucket=excluded.alpha_bucket,
        family_id=excluded.family_id,
        variant_id=excluded.variant_id,
        owner_type=excluded.owner_type,
        promotion_status=excluded.promotion_status,
        supported_regimes_json=excluded.supported_regimes_json,
        thesis=excluded.thesis,
        thresholds_json=excluded.thresholds_json,
        candidate_policy_json=excluded.candidate_policy_json,
        risk_notes_json=excluded.risk_notes_json,
        source_refs_json=excluded.source_refs_json,
        updated_at=excluded.updated_at
    `).bind(
      row.strategy_id,
      row.version,
      row.name,
      row.status,
      row.owner,
      row.alpha_bucket,
      row.family_id,
      row.variant_id,
      row.owner_type,
      row.promotion_status,
      row.supported_regimes_json,
      row.thesis,
      row.thresholds_json,
      row.candidate_policy_json ?? '{}',
      row.risk_notes_json,
      row.source_refs_json,
      row.created_by,
      row.created_at,
      row.updated_at,
    ).run()
    seeded += 1
  }
  for (const legacyId of LEGACY_RETIRED_STRATEGY_SPEC_IDS) {
    await db.prepare(`
      UPDATE strategy_spec_registry
         SET status='retired',
             owner_type='retired',
             promotion_status='retired',
             updated_at=?
       WHERE strategy_id=?
         AND status != 'retired'
    `).bind(nowIso, legacyId).run()
  }
  const demotedStaleActive = await retireGeneratedDiscoveryStrategySpecs(db, nowIso)
  return { seeded, skipped_invalid: skippedInvalid, demoted_stale_active: demotedStaleActive }
}

export async function retireGeneratedDiscoveryStrategySpecs(
  db: D1Database,
  nowIso = new Date().toISOString(),
): Promise<number> {
  const approvedActiveIds = DEFAULT_STRATEGY_SPECS
    .filter((spec) => spec.status === 'active')
    .map((spec) => spec.id)
  const placeholders = approvedActiveIds.length ? approvedActiveIds.map(() => '?').join(', ') : "''"
  const result = await db.prepare(`
    UPDATE strategy_spec_registry
       SET status='retired',
           owner_type='retired',
           promotion_status='retired',
           updated_at=?
     WHERE status != 'retired'
       AND strategy_id NOT IN (${placeholders})
       AND (
         strategy_id LIKE 'finlab_ai_skill_%'
         OR created_by='finlab_ai_skill_discovery_v1'
         OR source_refs_json LIKE '%finlab_ai_skill_discovery_v1%'
         OR source_refs_json LIKE '%finlab_ai_skill%'
       )
  `).bind(nowIso, ...approvedActiveIds).run()
  return Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0)
}

export const demoteStaleActiveDiscoveryStrategySpecs = retireGeneratedDiscoveryStrategySpecs

export async function listStrategySpecsForLearning(
  db: D1Database,
): Promise<{ specs: StrategySpec[]; source: 'registry'; registryRowCount: number; activeCount: number }> {
  assertOwnerCanOwn('strategy', 'strategy_spec')
  await ensureStrategyLearningTables(db)
  const { results } = await db.prepare(`
    SELECT strategy_id, version, name, status, owner, alpha_bucket,
           family_id, variant_id, owner_type, promotion_status,
           supported_regimes_json, thesis, thresholds_json, candidate_policy_json, risk_notes_json,
           source_refs_json, created_by, created_at, updated_at
      FROM strategy_spec_registry
     WHERE status IN ('research','shadow','candidate','active','retired')
     ORDER BY CASE status
        WHEN 'active' THEN 0
        WHEN 'candidate' THEN 1
        WHEN 'shadow' THEN 2
        WHEN 'research' THEN 3
        ELSE 4
      END, strategy_id ASC
  `).all<StrategySpecRegistryRow>()
  const registryRows = results ?? []
  const approvedRuntimeIds = new Set(DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status !== 'retired').map((spec) => spec.id))
  const staleGeneratedRows = registryRows.filter((row) =>
    row.status !== 'retired'
    && !approvedRuntimeIds.has(row.strategy_id)
    && isGeneratedDiscoveryRegistryRow(row)
  )
  if (staleGeneratedRows.length > 0) {
    throw new Error(`strategy_spec_registry_contains_stale_generated_rows_seed_required:${staleGeneratedRows.slice(0, 5).map((row) => row.strategy_id).join(',')}`)
  }
  const staleRuntimeRows = registryRows.filter((row) =>
    row.status !== 'retired'
    && (
      hasLegacyScoreThresholds(parseJson(row.thresholds_json, {}) as StrategySpec['thresholds'])
      || !hasRuntimeCandidatePolicy(row)
    )
  )
  if (staleRuntimeRows.length > 0) {
    throw new Error(`strategy_spec_registry_contains_stale_runtime_rows_seed_required:${staleRuntimeRows.slice(0, 5).map((row) => row.strategy_id).join(',')}`)
  }
  const registrySpecs = registryRows.map(registryRowToStrategySpec)
  if (registrySpecs.length === 0) {
    throw new Error('strategy_spec_registry_empty_seed_required')
  }
  const specs = registrySpecs.filter((spec) => spec.status !== 'retired')
  if (specs.length === 0) {
    throw new Error('strategy_spec_registry_no_runtime_specs_seed_required')
  }
  return {
    specs,
    source: 'registry',
    registryRowCount: registrySpecs.length,
    activeCount: specs.filter((spec) => spec.status === 'active').length,
  }
}

function matchScore(candidate: StrategyCandidateInput, matched: boolean): number | null {
  if (!matched) return null
  const raw = deriveStrategyRawSignals(candidate)
  const trend = Math.max(-0.2, Math.min(0.2, finiteNumber(raw.closeAboveMa20Pct) ?? 0)) * 2
  const volume = Math.max(0, Math.min(2, finiteNumber(raw.volumeExpansion20) ?? 0)) / 2
  const flow = Math.max(-1, Math.min(1, Math.sign(finiteNumber(raw.foreignTrustNet5d) ?? 0)))
  const broker = Math.max(0, Math.min(1, (finiteNumber(raw.brokerCount) ?? 0) / 10))
  const quality = Math.max(-1, Math.min(1, ((finiteNumber(raw.revenueGrowthYoY) ?? 0) + (finiteNumber(raw.roe) ?? 0)) / 30))
  return round6(Math.max(0, Math.min(1, 0.35 + trend * 0.2 + volume * 0.2 + flow * 0.08 + broker * 0.08 + quality * 0.09)))
}

export function buildStrategyDecisionRows(
  date: string,
  candidates: StrategyCandidateInput[],
  specs: StrategySpec[],
  options: { nowIso?: string } = {},
): StrategyDecisionLogRow[] {
  assertOwnerCanOwn('screener', 'candidate_discovery')
  assertOwnerCanOwn('strategy', 'strategy_spec')
  const nowIso = options.nowIso ?? new Date().toISOString()
  const rows: StrategyDecisionLogRow[] = []
  for (const candidate of candidates) {
    const symbol = cleanToken(candidate.symbol)
    if (!symbol) continue
    for (const spec of specs) {
      const validation = validateStrategySpec(spec)
      const assessment = validation.ok ? assessCandidateAgainstStrategySpecs(candidate, [spec]) : { matches: [], tags: [], watchPoints: [] }
      const matched = assessment.matches.length > 0
      const reasonCode = !validation.ok
        ? `strategy_spec_invalid:${validation.errors.join('|')}`
        : matched
          ? 'strategy_spec_matched'
          : 'strategy_spec_no_match'
      const evidence = {
        validation,
        matches: assessment.matches,
        tags: assessment.tags,
        watch_points: assessment.watchPoints,
        feature_ref_diagnostics: explainFeatureRefDsl(
          deriveStrategyRawSignals(candidate),
          spec.thresholds.featureRefs,
        ),
      }
      const rawSignals = deriveStrategyRawSignals(candidate)
      const context = {
        candidate: {
          raw_signals: rawSignals,
          current_price: finiteNumber(candidate.current_price),
          industry: candidate.industry ?? candidate.sector ?? null,
        },
        learning_version: STRATEGY_LEARNING_VERSION,
      }
      rows.push({
        decision_id: `strategy-${stableIdPart(date)}-${stableIdPart(symbol)}-${stableIdPart(spec.id)}-${stableIdPart(spec.version)}`,
        date,
        symbol,
        name: cleanToken(candidate.name) || null,
        strategy_id: spec.id,
        strategy_version: spec.version,
        strategy_status: spec.status,
        alpha_bucket: spec.alphaBucket,
        matched: matched ? 1 : 0,
        match_score: matchScore(candidate, matched),
        reason_code: reasonCode,
        context_json: safeJson(context),
        evidence_json: safeJson(evidence),
        created_at: nowIso,
      })
    }
  }
  return rows
}

export async function listStrategyLearningCandidates(
  db: D1Database,
  date: string,
  limit = STRATEGY_LEARNING_DEFAULT_CANDIDATE_LIMIT,
  offset = 0,
): Promise<StrategyCandidateInput[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 2000))
  const safeOffset = Math.max(0, Math.floor(offset))
  const { results } = await db.prepare(`
    WITH latest_run AS (
      SELECT run_id
        FROM screener_funnel_runs
       WHERE date = ?
       ORDER BY created_at DESC
       LIMIT 1
    ),
    funnel_candidates AS (
      SELECT symbol, name, stage, evidence, score_after, rank,
             ROW_NUMBER() OVER (
               PARTITION BY symbol
               ORDER BY
                 CASE stage
                   WHEN 'scoring' THEN 1
                   WHEN 'layer1_strategy_breadth_gate' THEN 2
                   WHEN 'l1_candidate_seed_after_overlay' THEN 3
                   WHEN 'final_selection' THEN 4
                   ELSE 4
                 END,
                 COALESCE(rank, 999999) ASC
             ) AS row_rank
       FROM screener_funnel_items
       WHERE run_id = (SELECT run_id FROM latest_run)
         AND (
           (stage = 'scoring' AND decision = 'pass')
           OR (stage = 'layer1_strategy_breadth_gate' AND decision = 'pass')
           OR (stage = 'l1_candidate_seed_after_overlay' AND decision = 'selected')
           OR (stage = 'final_selection' AND decision = 'selected')
         )
    )
    SELECT fc.symbol,
           COALESCE(dr.name, fc.name) AS name,
           dr.sector,
           dr.industry,
           dr.score_components,
           dr.current_price,
           fc.evidence AS funnel_evidence,
           fc.score_after AS funnel_score,
           fc.rank AS funnel_rank
      FROM funnel_candidates fc
      LEFT JOIN daily_recommendations dr
        ON dr.date = ?
       AND dr.symbol = fc.symbol
     WHERE fc.row_rank = 1
     ORDER BY COALESCE(fc.rank, 999999) ASC,
       CASE WHEN json_valid(score_components) THEN
         COALESCE(
           CAST(json_extract(score_components, '$.finalScore') AS REAL),
           CAST(json_extract(score_components, '$.total') AS REAL),
           0
         ) ELSE 0 END DESC,
       fc.symbol ASC
     LIMIT ?
     OFFSET ?
  `).bind(date, date, safeLimit, safeOffset).all<StrategyCandidateInput & {
    score_components?: unknown
    funnel_evidence?: string | null
    funnel_score?: number | null
    funnel_rank?: number | null
  }>()
  return (results ?? []).map(({ score_components, funnel_evidence, funnel_score: _funnelScore, funnel_rank: _funnelRank, ...row }) => {
    const evidence = parseJson<Record<string, any>>(funnel_evidence, {})
    const rawSignals = evidence && typeof evidence.raw_signals === 'object'
      ? evidence.raw_signals
      : row.raw_signals
    const currentPrice = row.current_price ?? finiteNumber((rawSignals as any)?.close)
    const taxonomy = evidence && typeof evidence.taxonomy === 'object' && !Array.isArray(evidence.taxonomy)
      ? evidence.taxonomy as Record<string, unknown>
      : {}
    return {
      ...row,
      sector: firstCleanToken(row.sector, taxonomy.industryTheme, taxonomy.industry),
      industry: firstCleanToken(row.industry, taxonomy.industry, taxonomy.subindustry),
      current_price: currentPrice,
      raw_signals: rawSignals ?? null,
      score_v2: row.score_v2 ?? score_components ?? evidence.score_components,
    }
  })
}

export async function persistStrategyDecisionRows(db: D1Database, rows: StrategyDecisionLogRow[]): Promise<number> {
  await ensureStrategyLearningTables(db)
  if (rows.length === 0) return 0
  const statements = rows.map((row) => db.prepare(`
    INSERT OR REPLACE INTO strategy_decision_log (
      decision_id, date, symbol, name, strategy_id, strategy_version,
      strategy_status, alpha_bucket, matched, match_score, reason_code,
      context_json, evidence_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.decision_id,
    row.date,
    row.symbol,
    row.name,
    row.strategy_id,
    row.strategy_version,
    row.strategy_status,
    row.alpha_bucket,
    row.matched,
    row.match_score,
    row.reason_code,
    row.context_json,
    row.evidence_json,
    row.created_at,
  ))
  let persisted = 0
  for (let i = 0; i < statements.length; i += STRATEGY_LEARNING_D1_BATCH_SIZE) {
    const chunk = statements.slice(i, i + STRATEGY_LEARNING_D1_BATCH_SIZE)
    await db.batch(chunk)
    persisted += chunk.length
  }
  return persisted
}

export async function materializeStrategyDecisionLog(
  db: D1Database,
  options: { date: string; limit?: number; dryRun?: boolean },
): Promise<{
  success: boolean
  mode: 'dry_run' | 'persisted'
  date: string
  spec_source: 'registry'
  candidate_count: number
  decision_rows: number
  persisted_rows: number
  preview: StrategyDecisionLogRow[]
}> {
  const { specs, source } = await listStrategySpecsForLearning(db)
  const candidates = await listStrategyLearningCandidates(db, options.date, options.limit)
  const rows = buildStrategyDecisionRows(options.date, candidates, specs)
  const dryRun = options.dryRun !== false
  const persisted = dryRun ? 0 : await persistStrategyDecisionRows(db, rows)
  return {
    success: true,
    mode: dryRun ? 'dry_run' : 'persisted',
    date: options.date,
    spec_source: source,
    candidate_count: candidates.length,
    decision_rows: rows.length,
    persisted_rows: persisted,
    preview: rows.slice(0, 20),
  }
}

function rewardForRow(row: StrategyRewardSourceRow): number | null {
  const trade = finiteNumber(row.trade_pnl_pct)
  if (trade != null) return trade
  return finiteNumber(row.actual_return_pct)
}

function maxDrawdown(values: number[]): number | null {
  if (!values.length) return null
  let equity = 0
  let peak = 0
  let mdd = 0
  for (const value of values) {
    equity += value
    peak = Math.max(peak, equity)
    mdd = Math.min(mdd, equity - peak)
  }
  return round6(mdd)
}

function regimeFromAlphaContext(raw: string | null | undefined): string {
  const parsed = parseJson<Record<string, unknown>>(raw, {})
  const regime = cleanToken(parsed.regime ?? parsed.market_regime ?? parsed.regime_label)
  return regime || 'all'
}

export function buildStrategyRewardLedgerRows(
  rows: StrategyRewardSourceRow[],
  options: { nowIso?: string; horizonDays?: number; marketSegment?: string; regime?: string; matchedTotal?: number } = {},
): StrategyRewardLedgerRow[] {
  const nowIso = options.nowIso ?? new Date().toISOString()
  const horizonDays = options.horizonDays ?? 5
  const buckets = new Map<string, { row: StrategyRewardSourceRow; rewards: number[]; dates: string[]; symbols: Set<string>; matchedTotal: number }>()
  for (const row of rows) {
    const reward = rewardForRow(row)
    if (reward == null) continue
    const marketSegment = options.marketSegment ?? (cleanToken(row.market_segment) || 'all')
    const regime = options.regime ?? regimeFromAlphaContext(row.alpha_context)
    const key = `${row.strategy_id}|${row.strategy_version}|${marketSegment}|${regime}`
    const bucket = buckets.get(key) ?? { row, rewards: [], dates: [], symbols: new Set<string>(), matchedTotal: options.matchedTotal ?? rows.length }
    bucket.rewards.push(reward)
    bucket.dates.push(row.date)
    bucket.symbols.add(row.symbol)
    buckets.set(key, bucket)
  }
  return [...buckets.entries()].map(([key, bucket]) => {
    const [strategyId, strategyVersion, marketSegment, regime] = key.split('|')
    const rewards = bucket.rewards
    const rewardSum = rewards.reduce((sum, reward) => sum + reward, 0)
    const dates = [...new Set(bucket.dates)].sort()
    const hitRate = rewards.length ? rewards.filter((reward) => reward > 0).length / rewards.length : null
    const avgReturn = rewards.length ? rewardSum / rewards.length : null
    const evidence = {
      version: STRATEGY_LEARNING_VERSION,
      reward_source: 'prediction_trade_pnl_pct_or_actual_return_pct',
      sample_symbols_preview: [...bucket.symbols].sort().slice(0, 20),
      date_start: dates[0] ?? null,
      date_end: dates.at(-1) ?? null,
    }
    return {
      reward_id: `strategy-reward-${stableIdPart(strategyId)}-${stableIdPart(strategyVersion)}-${horizonDays}-${stableIdPart(marketSegment)}-${stableIdPart(regime)}`,
      strategy_id: strategyId,
      strategy_version: strategyVersion,
      strategy_status: bucket.row.strategy_status,
      alpha_bucket: bucket.row.alpha_bucket,
      date_start: dates[0] ?? null,
      date_end: dates.at(-1) ?? null,
      horizon_days: horizonDays,
      samples: rewards.length,
      hit_rate: round6(hitRate),
      avg_return_pct: round6(avgReturn),
      reward_sum: round6(rewardSum),
      max_drawdown_pct: maxDrawdown(rewards),
      coverage: bucket.matchedTotal > 0 ? round6(rewards.length / bucket.matchedTotal) : null,
      market_segment: marketSegment,
      regime,
      evidence_json: safeJson(evidence),
      updated_at: nowIso,
    }
  }).sort((a, b) => a.strategy_id.localeCompare(b.strategy_id))
}

export async function listStrategyRewardSourceRows(
  db: D1Database,
  options: { startDate?: string; endDate?: string; limit?: number } = {},
): Promise<StrategyRewardSourceRow[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 5000, 20000))
  const clauses = ['l.matched = 1', "(p.trade_pnl_pct IS NOT NULL OR p.actual_return_pct IS NOT NULL)", "p.model_name = 'ensemble'"]
  const binds: unknown[] = []
  if (options.startDate) {
    clauses.push('l.date >= ?')
    binds.push(options.startDate)
  }
  if (options.endDate) {
    clauses.push('l.date <= ?')
    binds.push(options.endDate)
  }
  binds.push(limit)
  const { results } = await db.prepare(`
    SELECT l.date,
           l.symbol,
           l.strategy_id,
           l.strategy_version,
           l.strategy_status,
           l.alpha_bucket,
           dr.market_segment,
           dr.alpha_context,
           p.trade_pnl_pct,
           p.actual_return_pct
      FROM strategy_decision_log l
      JOIN daily_recommendations dr
        ON dr.date = l.date
       AND dr.symbol = l.symbol
      JOIN stocks s
        ON s.symbol = l.symbol
      JOIN predictions p
        ON p.stock_id = s.id
       AND p.prediction_date = l.date
     WHERE ${clauses.join(' AND ')}
     ORDER BY l.date DESC, l.strategy_id ASC
     LIMIT ?
  `).bind(...binds).all<StrategyRewardSourceRow>()
  return results ?? []
}

export async function persistStrategyRewardLedgerRows(db: D1Database, rows: StrategyRewardLedgerRow[]): Promise<number> {
  await ensureStrategyLearningTables(db)
  if (rows.length === 0) return 0
  const statements = rows.map((row) => db.prepare(`
    INSERT INTO strategy_reward_ledger (
      reward_id, strategy_id, strategy_version, strategy_status, alpha_bucket,
      date_start, date_end, horizon_days, samples, hit_rate, avg_return_pct,
      reward_sum, max_drawdown_pct, coverage, market_segment, regime,
      evidence_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_id, strategy_version, horizon_days, market_segment, regime) DO UPDATE SET
      strategy_status=excluded.strategy_status,
      alpha_bucket=excluded.alpha_bucket,
      date_start=excluded.date_start,
      date_end=excluded.date_end,
      samples=excluded.samples,
      hit_rate=excluded.hit_rate,
      avg_return_pct=excluded.avg_return_pct,
      reward_sum=excluded.reward_sum,
      max_drawdown_pct=excluded.max_drawdown_pct,
      coverage=excluded.coverage,
      evidence_json=excluded.evidence_json,
      updated_at=excluded.updated_at
  `).bind(
    row.reward_id,
    row.strategy_id,
    row.strategy_version,
    row.strategy_status,
    row.alpha_bucket,
    row.date_start,
    row.date_end,
    row.horizon_days,
    row.samples,
    row.hit_rate,
    row.avg_return_pct,
    row.reward_sum,
    row.max_drawdown_pct,
    row.coverage,
    row.market_segment,
    row.regime,
    row.evidence_json,
    row.updated_at,
  ))
  let persisted = 0
  for (let i = 0; i < statements.length; i += STRATEGY_LEARNING_D1_BATCH_SIZE) {
    const chunk = statements.slice(i, i + STRATEGY_LEARNING_D1_BATCH_SIZE)
    await db.batch(chunk)
    persisted += chunk.length
  }
  return persisted
}

export async function materializeStrategyDecisionLogChunk(
  db: D1Database,
  options: { date: string; offset?: number; limit?: number; dryRun?: boolean },
): Promise<{
  success: boolean
  mode: 'dry_run' | 'persisted'
  date: string
  spec_source: 'registry'
  offset: number
  limit: number
  candidate_count: number
  decision_rows: number
  persisted_rows: number
  has_more: boolean
  next_offset: number
  preview: StrategyDecisionLogRow[]
}> {
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 80), 250))
  const { specs, source } = await listStrategySpecsForLearning(db)
  const candidates = await listStrategyLearningCandidates(db, options.date, limit, offset)
  const rows = buildStrategyDecisionRows(options.date, candidates, specs)
  const dryRun = options.dryRun !== false
  const persisted = dryRun ? 0 : await persistStrategyDecisionRows(db, rows)
  return {
    success: true,
    mode: dryRun ? 'dry_run' : 'persisted',
    date: options.date,
    spec_source: source,
    offset,
    limit,
    candidate_count: candidates.length,
    decision_rows: rows.length,
    persisted_rows: persisted,
    has_more: candidates.length === limit,
    next_offset: offset + candidates.length,
    preview: rows.slice(0, 20),
  }
}

export async function refreshStrategyRewardLedger(
  db: D1Database,
  options: { startDate?: string; endDate?: string; limit?: number; dryRun?: boolean } = {},
): Promise<{
  success: boolean
  mode: 'dry_run' | 'persisted'
  source_rows: number
  ledger_rows: StrategyRewardLedgerRow[]
  persisted_rows: number
}> {
  await ensureStrategyLearningTables(db)
  const sourceRows = await listStrategyRewardSourceRows(db, options)
  const ledgerRows = buildStrategyRewardLedgerRows(sourceRows)
  const dryRun = options.dryRun !== false
  const persisted = dryRun ? 0 : await persistStrategyRewardLedgerRows(db, ledgerRows)
  return {
    success: true,
    mode: dryRun ? 'dry_run' : 'persisted',
    source_rows: sourceRows.length,
    ledger_rows: ledgerRows,
    persisted_rows: persisted,
  }
}

function gateEvidenceFromSpec(spec: StrategyLearningSummary['specs'][number]): StrategyPromotionGateRow['evidence'] {
  return {
    decisions: spec.learning.decisions,
    matched: spec.learning.matched,
    match_rate: spec.learning.match_rate,
    samples: spec.learning.samples,
    hit_rate: spec.learning.hit_rate,
    avg_return_pct: spec.learning.avg_return_pct,
    max_drawdown_pct: spec.learning.max_drawdown_pct,
  }
}

export function evaluateStrategyPromotionGate(summary: StrategyLearningSummary): StrategyPromotionGateRow[] {
  return summary.specs.map((spec) => {
    const evidence = gateEvidenceFromSpec(spec)
    const missing: string[] = []
    if (spec.status === 'research') missing.push('status_must_enter_shadow_before_promotion')
    if (evidence.decisions < PROMOTION_MIN_DECISIONS) missing.push(`decisions_lt_${PROMOTION_MIN_DECISIONS}`)
    if (evidence.match_rate == null || evidence.match_rate < PROMOTION_MIN_MATCH_RATE) missing.push(`match_rate_lt_${PROMOTION_MIN_MATCH_RATE}`)
    if (evidence.samples < PROMOTION_MIN_SAMPLES) missing.push(`samples_lt_${PROMOTION_MIN_SAMPLES}`)
    if (evidence.hit_rate == null || evidence.hit_rate < PROMOTION_MIN_HIT_RATE) missing.push(`hit_rate_lt_${PROMOTION_MIN_HIT_RATE}`)
    if (evidence.avg_return_pct == null || evidence.avg_return_pct <= PROMOTION_MIN_AVG_RETURN) missing.push('avg_return_not_positive')
    if (evidence.max_drawdown_pct != null && evidence.max_drawdown_pct < PROMOTION_MIN_MAX_DRAWDOWN) {
      missing.push(`max_drawdown_lt_${PROMOTION_MIN_MAX_DRAWDOWN}`)
    }

    const activeMonitor = spec.status === 'active'
    const activeCooldownReasons = activeMonitor && evidence.samples >= ACTIVE_COOLDOWN_MIN_SAMPLES
      ? [
        evidence.hit_rate != null && evidence.hit_rate < ACTIVE_COOLDOWN_HIT_RATE ? `active_hit_rate_lt_${ACTIVE_COOLDOWN_HIT_RATE}` : null,
        evidence.avg_return_pct != null && evidence.avg_return_pct <= 0 ? 'active_avg_return_not_positive' : null,
        evidence.max_drawdown_pct != null && evidence.max_drawdown_pct < PROMOTION_MIN_MAX_DRAWDOWN ? `active_max_drawdown_lt_${PROMOTION_MIN_MAX_DRAWDOWN}` : null,
      ].filter((reason): reason is string => reason != null)
      : []
    const activeCooldown = activeMonitor && activeCooldownReasons.length > 0
    const ready = !activeMonitor && missing.length === 0
    const currentStage = stageForStrategyStatus(spec.status)
    const recommendedNextStatus = activeCooldown
      ? 'candidate'
      : activeMonitor
        ? 'active'
      : ready && spec.status === 'candidate'
        ? 'active'
        : ready
          ? 'candidate'
          : spec.status === 'research'
            ? 'shadow'
          : spec.status === 'candidate'
            ? 'candidate'
            : 'shadow'
    const recommendedStage = activeCooldown
      ? 'L2_paper_active'
      : activeMonitor
        ? 'L3_production_allocation'
      : ready && spec.status === 'candidate'
        ? 'L3_production_allocation'
        : ready
          ? 'L2_paper_active'
          : spec.status === 'research'
            ? 'L1_shadow'
            : currentStage

    return {
      strategy_id: spec.id,
      strategy_version: spec.version,
      strategy_status: spec.status,
      alpha_bucket: spec.alphaBucket,
      current_stage: currentStage,
      recommended_stage: recommendedStage,
      decision: activeCooldown ? 'active_cooldown' : activeMonitor ? 'active_monitor' : ready ? 'candidate_ready' : 'not_ready',
      recommended_next_status: recommendedNextStatus,
      requires_wei_approval: !activeMonitor || activeCooldown,
      l3_requires_wei_approval: recommendedStage === 'L3_production_allocation' && !activeMonitor,
      production_effect: false,
      missing_evidence: activeCooldown ? activeCooldownReasons : activeMonitor ? [] : missing,
      evidence,
    }
  })
}

function strategyPolicyScore(spec: StrategyLearningSummary['specs'][number], gate: StrategyPromotionGateRow): number {
  if (gate.decision === 'active_cooldown') return 0
  const samples = Math.max(0, spec.learning.samples)
  if (samples <= 0 || spec.learning.hit_rate == null || spec.learning.avg_return_pct == null) return 0
  const sampleConfidence = Math.min(samples / 100, 1) * 0.2
  const hitLift = Math.max(spec.learning.hit_rate - 0.5, 0) * 1.5
  const returnLift = Math.max(spec.learning.avg_return_pct, 0) * 4
  const drawdownPenalty = spec.learning.max_drawdown_pct != null && spec.learning.max_drawdown_pct < PROMOTION_MIN_MAX_DRAWDOWN
    ? Math.abs(spec.learning.max_drawdown_pct) * 2
    : 0
  const gateBonus = gate.decision === 'candidate_ready' || gate.decision === 'active_monitor' ? 0.08 : 0
  return Math.max(0, 0.01 + sampleConfidence + hitLift + returnLift + gateBonus - drawdownPenalty)
}

export function buildStrategyAdaptivePolicyState(
  summary: StrategyLearningSummary,
  options: { nowIso?: string } = {},
): StrategyAdaptivePolicyState {
  const nowIso = options.nowIso ?? new Date().toISOString()
  const gates = summary.promotion_gate.length ? summary.promotion_gate : evaluateStrategyPromotionGate(summary)
  const gateById = new Map(gates.map((gate) => [`${gate.strategy_id}|${gate.strategy_version}`, gate]))
  const scored = summary.specs
    .filter((spec) => spec.status !== 'retired' && spec.status !== 'research')
    .map((spec) => {
      const gate = gateById.get(`${spec.id}|${spec.version}`)
      return { spec, gate, score: gate ? strategyPolicyScore(spec, gate) : 0 }
    })
    .filter((row): row is { spec: StrategyLearningSummary['specs'][number]; gate: StrategyPromotionGateRow; score: number } => row.gate != null && row.score > 0)
  const total = scored.reduce((sum, row) => sum + row.score, 0)
  const strategyWeights: Record<string, number> = {}
  const thresholdDeltas: StrategyAdaptivePolicyState['threshold_deltas'] = {}
  for (const row of scored) {
    strategyWeights[row.spec.id] = total > 0 ? round6(row.score / total) ?? 0 : 0
    const rewardHealthy = row.spec.learning.avg_return_pct != null
      && row.spec.learning.avg_return_pct > 0
      && row.spec.learning.hit_rate != null
      && row.spec.learning.hit_rate >= 0.58
    const drawdownWeak = row.spec.learning.max_drawdown_pct != null && row.spec.learning.max_drawdown_pct < PROMOTION_MIN_MAX_DRAWDOWN
    thresholdDeltas[row.spec.id] = rewardHealthy
      ? {
        minVolumeExpansion20: -0.05,
        minCloseAboveMa20Pct: -0.005,
        minBrokerCount: row.spec.learning.hit_rate != null && row.spec.learning.hit_rate >= 0.6 ? -1 : 0,
      }
      : drawdownWeak || row.spec.learning.avg_return_pct == null || row.spec.learning.avg_return_pct <= 0
        ? { minVolumeExpansion20: 0.08, minCloseAboveMa20Pct: 0.01, minRevenueGrowthYoY: 1 }
        : { minVolumeExpansion20: 0 }
  }
  for (const gate of gates.filter((row) => row.decision === 'active_cooldown')) {
    strategyWeights[gate.strategy_id] = 0.2
    thresholdDeltas[gate.strategy_id] = {
      minVolumeExpansion20: 0.12,
      minCloseAboveMa20Pct: 0.015,
      minRevenueGrowthYoY: 1,
    }
  }

  return {
    policy_id: STRATEGY_POLICY_ID,
    version: STRATEGY_LEARNING_VERSION,
    status: 'shadow',
    strategy_weights: strategyWeights,
    threshold_deltas: thresholdDeltas,
    evidence: {
      version: STRATEGY_LEARNING_VERSION,
      date: summary.date,
      source: 'strategy_reward_ledger',
      production_effect: false,
      requires_approval_to_activate: true,
      eligible_strategy_count: scored.length,
      missing_evidence: Object.fromEntries(gates.map((gate) => [gate.strategy_id, gate.missing_evidence])),
    },
    updated_at: nowIso,
  }
}

export async function getLatestStrategyPolicyState(db: D1Database): Promise<StrategyAdaptivePolicyState | null> {
  await ensureStrategyLearningTables(db)
  const row = await db.prepare(`
    SELECT policy_id, version, status, strategy_weights_json, threshold_deltas_json, evidence_json, updated_at
      FROM strategy_policy_state
     WHERE policy_id = ?
     LIMIT 1
  `).bind(STRATEGY_POLICY_ID).first<{
    policy_id: string
    version: string
    status: StrategyAdaptivePolicyState['status']
    strategy_weights_json: string
    threshold_deltas_json: string
    evidence_json: string
    updated_at: string
  }>()
  if (!row) return null
  return {
    policy_id: row.policy_id,
    version: row.version,
    status: row.status,
    strategy_weights: parseJson(row.strategy_weights_json, {}),
    threshold_deltas: parseJson(row.threshold_deltas_json, {}),
    evidence: parseJson(row.evidence_json, {
      version: row.version,
      date: '',
      source: 'strategy_reward_ledger',
      production_effect: false,
      requires_approval_to_activate: true,
      eligible_strategy_count: 0,
      missing_evidence: {},
    }),
    updated_at: row.updated_at,
  }
}

export async function persistStrategyPolicyState(db: D1Database, state: StrategyAdaptivePolicyState): Promise<number> {
  await ensureStrategyLearningTables(db)
  await db.prepare(`
    INSERT INTO strategy_policy_state (
      policy_id, version, status, strategy_weights_json, threshold_deltas_json, evidence_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(policy_id) DO UPDATE SET
      version=excluded.version,
      status=excluded.status,
      strategy_weights_json=excluded.strategy_weights_json,
      threshold_deltas_json=excluded.threshold_deltas_json,
      evidence_json=excluded.evidence_json,
      updated_at=excluded.updated_at
  `).bind(
    state.policy_id,
    state.version,
    state.status,
    safeJson(state.strategy_weights),
    safeJson(state.threshold_deltas),
    safeJson(state.evidence),
    state.updated_at,
  ).run()
  return 1
}

export async function refreshStrategyAdaptivePolicyState(
  db: D1Database,
  options: { date: string; dryRun?: boolean } = { date: new Date().toISOString().slice(0, 10) },
): Promise<{
  success: boolean
  mode: 'dry_run' | 'persisted'
  date: string
  policy_state: StrategyAdaptivePolicyState
  promotion_gate: StrategyPromotionGateRow[]
  persisted_rows: number
}> {
  await ensureStrategyLearningTables(db)
  const summary = await buildStrategyLearningSummary(db, options.date)
  const policyState = buildStrategyAdaptivePolicyState(summary)
  const dryRun = options.dryRun !== false
  const persisted = dryRun ? 0 : await persistStrategyPolicyState(db, policyState)
  return {
    success: true,
    mode: dryRun ? 'dry_run' : 'persisted',
    date: options.date,
    policy_state: policyState,
    promotion_gate: summary.promotion_gate,
    persisted_rows: persisted,
  }
}

export async function buildStrategyLearningSummary(
  db: D1Database,
  date: string,
): Promise<StrategyLearningSummary> {
  const { specs, source } = await listStrategySpecsForLearning(db)
  const learningBySpec = new Map<string, {
    decisions: number
    matched: number
    samples: number
    hit_rate: number | null
    avg_return_pct: number | null
    max_drawdown_pct: number | null
  }>()
  try {
    const { results } = await db.prepare(`
      SELECT strategy_id,
             strategy_version,
             COUNT(*) AS decisions,
             SUM(CASE WHEN matched = 1 THEN 1 ELSE 0 END) AS matched
        FROM strategy_decision_log
       WHERE date = ?
       GROUP BY strategy_id, strategy_version
    `).bind(date).all<{ strategy_id: string; strategy_version: string; decisions: number; matched: number }>()
    for (const row of results ?? []) {
      learningBySpec.set(`${row.strategy_id}|${row.strategy_version}`, {
        decisions: Number(row.decisions ?? 0),
        matched: Number(row.matched ?? 0),
        samples: 0,
        hit_rate: null,
        avg_return_pct: null,
        max_drawdown_pct: null,
      })
    }
    const { results: rewardRows } = await db.prepare(`
      SELECT strategy_id,
             strategy_version,
             SUM(samples) AS samples,
             AVG(hit_rate) AS hit_rate,
             AVG(avg_return_pct) AS avg_return_pct,
             MIN(max_drawdown_pct) AS max_drawdown_pct
        FROM strategy_reward_ledger
       GROUP BY strategy_id, strategy_version
    `).all<{ strategy_id: string; strategy_version: string; samples: number; hit_rate: number | null; avg_return_pct: number | null; max_drawdown_pct: number | null }>()
    for (const row of rewardRows ?? []) {
      const key = `${row.strategy_id}|${row.strategy_version}`
      const prev = learningBySpec.get(key) ?? {
        decisions: 0,
        matched: 0,
        samples: 0,
        hit_rate: null,
        avg_return_pct: null,
        max_drawdown_pct: null,
      }
      learningBySpec.set(key, {
        ...prev,
        samples: Number(row.samples ?? 0),
        hit_rate: row.hit_rate == null ? null : Number(row.hit_rate),
        avg_return_pct: row.avg_return_pct == null ? null : Number(row.avg_return_pct),
        max_drawdown_pct: row.max_drawdown_pct == null ? null : Number(row.max_drawdown_pct),
      })
    }
  } catch {
    // Missing strategy learning tables should be visible through zero learning state, not a page crash.
  }

  const summary = {
    version: STRATEGY_LEARNING_VERSION,
    date,
    spec_source: source,
    specs: specs.map((spec) => {
      const learning = learningBySpec.get(`${spec.id}|${spec.version}`) ?? {
        decisions: 0,
        matched: 0,
        samples: 0,
        hit_rate: null,
        avg_return_pct: null,
        max_drawdown_pct: null,
      }
      return {
        ...spec,
        learning: {
          ...learning,
          match_rate: learning.decisions > 0 ? round6(learning.matched / learning.decisions) : null,
          status: learning.samples > 0 ? 'learning' : learning.decisions > 0 ? 'no_reward' : 'no_decisions',
        },
      }
    }),
    promotion_gate: [],
    policy_state_preview: {} as StrategyAdaptivePolicyState,
  } as StrategyLearningSummary
  summary.promotion_gate = evaluateStrategyPromotionGate(summary)
  summary.policy_state_preview = buildStrategyAdaptivePolicyState(summary)
  return summary
}

export async function runStrategyLearningClosure(
  db: D1Database,
  date: string,
  options: { persistPolicy?: boolean } = {},
): Promise<string> {
  await ensureStrategyLearningTables(db)
  const seeded = await seedDefaultStrategySpecRegistry(db)
  const decisions = await materializeStrategyDecisionLog(db, {
    date,
    limit: STRATEGY_LEARNING_DEFAULT_CANDIDATE_LIMIT,
    dryRun: false,
  })
  const rewards = await refreshStrategyRewardLedger(db, { endDate: date, dryRun: false })
  const policy = options.persistPolicy === false
    ? null
    : await refreshStrategyAdaptivePolicyState(db, { date, dryRun: false })
  return [
    `seeded=${seeded.seeded}`,
    `spec_source=${decisions.spec_source}`,
    `candidates=${decisions.candidate_count}`,
    `decision_rows=${decisions.persisted_rows}`,
    `reward_source_rows=${rewards.source_rows}`,
    `reward_rows=${rewards.persisted_rows}`,
    `policy=${policy ? policy.policy_state.status : 'skipped_historical'}`,
    `policy_eligible=${policy ? policy.policy_state.evidence.eligible_strategy_count : 'n/a'}`,
  ].join(' ')
}
