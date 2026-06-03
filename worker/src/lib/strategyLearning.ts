import {
  DEFAULT_STRATEGY_SPECS,
  assessCandidateAgainstStrategySpecs,
  deriveStrategyRawSignals,
  normalizeStrategySpecGovernance,
  validateStrategySpec,
  type StrategyCandidateInput,
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
  supported_regimes_json: string
  thesis: string
  thresholds_json: string
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
  spec_source: 'registry' | 'default_fallback'
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
const LEGACY_RETIRED_STRATEGY_SPEC_IDS = ['finlab_ai_skill_shadow_v1']

const PROMOTION_MIN_DECISIONS = 30
const PROMOTION_MIN_MATCH_RATE = 0.02
const PROMOTION_MIN_SAMPLES = 30
const PROMOTION_MIN_HIT_RATE = 0.52
const PROMOTION_MIN_AVG_RETURN = 0
const PROMOTION_MIN_MAX_DRAWDOWN = -0.08
const ACTIVE_COOLDOWN_MIN_SAMPLES = 30
const ACTIVE_COOLDOWN_HIT_RATE = 0.48
const STRATEGY_LEARNING_D1_BATCH_SIZE = 50

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
    supported_regimes_json TEXT NOT NULL DEFAULT '[]',
    thesis TEXT NOT NULL,
    thresholds_json TEXT NOT NULL DEFAULT '{}',
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
}

export function strategySpecToRegistryRow(
  spec: StrategySpec,
  nowIso = new Date().toISOString(),
  options: StrategySpecRegistryRowOptions = {},
): StrategySpecRegistryRow {
  return {
    strategy_id: spec.id,
    version: spec.version,
    name: spec.name,
    status: spec.status,
    owner: 'strategy',
    alpha_bucket: spec.alphaBucket,
    supported_regimes_json: safeJson(spec.supportedRegimes),
    thesis: spec.thesis,
    thresholds_json: safeJson(spec.thresholds),
    risk_notes_json: safeJson(spec.riskNotes),
    source_refs_json: safeJson(options.sourceRefs ?? ['default_strategy_specs', spec.createdBy]),
    created_by: options.createdBy ?? 'p5_strategy_governance',
    created_at: nowIso,
    updated_at: nowIso,
  }
}

function candidatePolicyForRegistryRow(row: StrategySpecRegistryRow, defaultSpec?: StrategySpec): StrategySpecCandidatePolicy | undefined {
  if (defaultSpec?.candidatePolicy) return defaultSpec.candidatePolicy
  const sourceRefs = parseJson(row.source_refs_json, []) as string[]
  const isFinLabAiSkillSpec = row.strategy_id.startsWith('finlab_ai_skill_')
    || row.created_by === 'finlab_ai_skill_discovery_v1'
    || sourceRefs.includes('finlab_ai_skill_discovery_v1')
  if (row.status === 'research') {
    return {
      poolQuota: 8,
      costBudget: 10,
      evidenceRequirements: ['strategy_hypothesis', 'research_reward'],
      maxMlShare: 0,
    }
  }
  if (isFinLabAiSkillSpec) {
    return {
      poolQuota: 8,
      costBudget: 10,
      evidenceRequirements: [
        'finlab_ai_skill',
        'finlab_taxonomy',
        'raw_factor_mining',
        'raw_technical_indicator_mining',
        'strategy_hypothesis',
        'research_reward',
      ],
    }
  }
  return undefined
}

function hasLegacyScoreThresholds(thresholds: StrategySpec['thresholds']): boolean {
  return thresholds.minSeedScore != null
    || thresholds.minChipScore != null
    || thresholds.minTechScore != null
    || thresholds.minMomentumScore != null
}

function shouldPreferDefaultSpecOverRegistry(row: StrategySpecRegistryRow, defaultSpec: StrategySpec | undefined): boolean {
  if (!defaultSpec) return false
  const registryThresholds = parseJson(row.thresholds_json, {}) as StrategySpec['thresholds']
  if (!hasLegacyScoreThresholds(registryThresholds)) return false
  if (hasLegacyScoreThresholds(defaultSpec.thresholds)) return false
  return defaultSpec.status === 'active'
}

export function registryRowToStrategySpec(row: StrategySpecRegistryRow): StrategySpec {
  const defaultSpec = DEFAULT_STRATEGY_SPECS.find((spec) => spec.id === row.strategy_id)
  if (shouldPreferDefaultSpecOverRegistry(row, defaultSpec)) return { ...defaultSpec!, thresholds: { ...defaultSpec!.thresholds } }
  return normalizeStrategySpecGovernance({
    id: row.strategy_id,
    version: row.version,
    name: row.name,
    status: row.status,
    owner: 'strategy',
    alphaBucket: row.alpha_bucket as StrategySpec['alphaBucket'],
    supportedRegimes: parseJson(row.supported_regimes_json, []) as StrategySpec['supportedRegimes'],
    thesis: row.thesis,
    thresholds: parseJson(row.thresholds_json, {}),
    candidatePolicy: candidatePolicyForRegistryRow(row, defaultSpec),
    familyId: defaultSpec?.familyId,
    variantId: defaultSpec?.variantId,
    ownerType: defaultSpec?.ownerType,
    promotionStatus: defaultSpec?.promotionStatus,
    riskNotes: parseJson(row.risk_notes_json, []),
    createdBy: 'p5_strategy_governance',
  })
}

export async function upsertStrategySpecRegistry(
  db: D1Database,
  spec: StrategySpec,
  options: StrategySpecRegistryRowOptions & { nowIso?: string } = {},
): Promise<{ upserted: number; skipped_invalid: string[]; strategy_id: string; status: StrategySpecStatus }> {
  assertOwnerCanOwn('strategy', 'strategy_spec')
  await ensureStrategyLearningTables(db)
  const validation = validateStrategySpec(spec)
  if (!validation.ok) {
    return {
      upserted: 0,
      skipped_invalid: [`${spec.id}:${validation.errors.join('|')}`],
      strategy_id: spec.id,
      status: spec.status,
    }
  }
  const row = strategySpecToRegistryRow(spec, options.nowIso ?? new Date().toISOString(), {
    sourceRefs: options.sourceRefs,
    createdBy: options.createdBy,
  })
  await db.prepare(`
    INSERT INTO strategy_spec_registry (
      strategy_id, version, name, status, owner, alpha_bucket,
      supported_regimes_json, thesis, thresholds_json, risk_notes_json,
      source_refs_json, created_by, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_id, version) DO UPDATE SET
      name=excluded.name,
      status=excluded.status,
      alpha_bucket=excluded.alpha_bucket,
      supported_regimes_json=excluded.supported_regimes_json,
      thesis=excluded.thesis,
      thresholds_json=excluded.thresholds_json,
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
    row.supported_regimes_json,
    row.thesis,
    row.thresholds_json,
    row.risk_notes_json,
    row.source_refs_json,
    row.created_by,
    row.created_at,
    row.updated_at,
  ).run()
  return { upserted: 1, skipped_invalid: [], strategy_id: spec.id, status: spec.status }
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
        supported_regimes_json, thesis, thresholds_json, risk_notes_json,
        source_refs_json, created_by, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(strategy_id, version) DO UPDATE SET
        name=excluded.name,
        status=excluded.status,
        alpha_bucket=excluded.alpha_bucket,
        supported_regimes_json=excluded.supported_regimes_json,
        thesis=excluded.thesis,
        thresholds_json=excluded.thresholds_json,
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
      row.supported_regimes_json,
      row.thesis,
      row.thresholds_json,
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
             updated_at=?
       WHERE strategy_id=?
         AND status != 'retired'
    `).bind(nowIso, legacyId).run()
  }
  const demotedStaleActive = await demoteStaleActiveDiscoveryStrategySpecs(db, nowIso)
  return { seeded, skipped_invalid: skippedInvalid, demoted_stale_active: demotedStaleActive }
}

export async function demoteStaleActiveDiscoveryStrategySpecs(
  db: D1Database,
  nowIso = new Date().toISOString(),
): Promise<number> {
  const approvedActiveIds = DEFAULT_STRATEGY_SPECS
    .filter((spec) => spec.status === 'active')
    .map((spec) => spec.id)
  if (!approvedActiveIds.length) return 0

  const placeholders = approvedActiveIds.map(() => '?').join(', ')
  const result = await db.prepare(`
    UPDATE strategy_spec_registry
       SET status='research',
           updated_at=?
     WHERE status='active'
       AND strategy_id LIKE 'finlab_ai_skill_%'
       AND strategy_id NOT IN (${placeholders})
       AND (
         created_by='finlab_ai_skill_discovery_v1'
         OR source_refs_json LIKE '%finlab_ai_skill_discovery_v1%'
         OR source_refs_json LIKE '%finlab_ai_skill%'
       )
  `).bind(nowIso, ...approvedActiveIds).run()
  return Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0)
}

export async function listStrategySpecsForLearning(
  db: D1Database,
): Promise<{ specs: StrategySpec[]; source: 'registry' | 'default_fallback' }> {
  assertOwnerCanOwn('strategy', 'strategy_spec')
  try {
    const { results } = await db.prepare(`
      SELECT strategy_id, version, name, status, owner, alpha_bucket,
             supported_regimes_json, thesis, thresholds_json, risk_notes_json,
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
    const specs = (results ?? []).map(registryRowToStrategySpec)
    if (specs.length > 0) {
      const registryKeys = new Set(specs.map((spec) => `${spec.id}:${spec.version}`))
      const merged = [
        ...specs,
        ...DEFAULT_STRATEGY_SPECS.filter((spec) => !registryKeys.has(`${spec.id}:${spec.version}`)),
      ].filter((spec) => spec.status !== 'retired')
      return { specs: merged, source: 'registry' }
    }
  } catch {
    return { specs: DEFAULT_STRATEGY_SPECS, source: 'default_fallback' }
  }
  return { specs: DEFAULT_STRATEGY_SPECS, source: 'default_fallback' }
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
  limit = 500,
): Promise<StrategyCandidateInput[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 2000))
  const { results } = await db.prepare(`
    SELECT symbol, name, sector, industry, score_components,
           current_price
      FROM daily_recommendations
     WHERE date = ?
     ORDER BY rank ASC,
       CASE WHEN json_valid(score_components) THEN
         COALESCE(
           CAST(json_extract(score_components, '$.finalScore') AS REAL),
           CAST(json_extract(score_components, '$.total') AS REAL),
           0
         ) ELSE 0 END DESC,
       symbol ASC
      LIMIT ?
  `).bind(date, safeLimit).all<StrategyCandidateInput & { score_components?: unknown }>()
  return (results ?? []).map(({ score_components, ...row }) => ({
    ...row,
    score_v2: row.score_v2 ?? score_components,
  }))
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
  spec_source: 'registry' | 'default_fallback'
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
): Promise<string> {
  await ensureStrategyLearningTables(db)
  const seeded = await seedDefaultStrategySpecRegistry(db)
  const decisions = await materializeStrategyDecisionLog(db, { date, dryRun: false })
  const rewards = await refreshStrategyRewardLedger(db, { endDate: date, dryRun: false })
  const policy = await refreshStrategyAdaptivePolicyState(db, { date, dryRun: false })
  return [
    `seeded=${seeded.seeded}`,
    `spec_source=${decisions.spec_source}`,
    `candidates=${decisions.candidate_count}`,
    `decision_rows=${decisions.persisted_rows}`,
    `reward_source_rows=${rewards.source_rows}`,
    `reward_rows=${rewards.persisted_rows}`,
    `policy=${policy.policy_state.status}`,
    `policy_eligible=${policy.policy_state.evidence.eligible_strategy_count}`,
  ].join(' ')
}
