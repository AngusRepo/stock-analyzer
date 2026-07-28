import {
  DEFAULT_STRATEGY_SPECS,
  assessCandidateAgainstStrategySpecs,
  assessStrategySpecEvaluability,
  deriveStrategyRawSignals,
  deriveStrategyThresholdScores,
  explainFeatureRefDsl,
  normalizeStrategySpecGovernance,
  validateStrategySpec,
  type StrategyCandidateInput,
  type StrategyFamilyId,
  type StrategyOwnerType,
  type StrategyPromotionStatus,
  type StrategyRawSignals,
  type StrategySpec,
  type StrategySpecCandidatePolicy,
  type StrategySpecStatus,
} from './strategySpec'
import { assertOwnerCanOwn } from './strategyOwnerFreeze'
import { materializeFormal137FeatureAliases } from './formal137FeatureMaterialization'
import { buildPriceActionStructure } from './priceActionStructure'
import type { OhlcvRow } from './ohlcvTradePlanLevels'
import type { Bindings } from '../types'
import { writeEvidenceArtifact } from './artifactLifecycle'
import { sha256Text } from './datasetSnapshots'
import { CANONICAL_SELECTION_ROUNDTRIP_COST_BPS } from './canonicalSelectionLabels'
import { S12_REPLAY_ENGINE_SIGNATURE } from './s12ReplayContract'
import {
  applyStrategyThresholdCalibrationArtifacts,
  buildStrategyThresholdAutoDecisions,
  classifyStrategyThresholdCalibrationCoverage,
  defaultStrategyThresholdCalibrationWindow,
  ensureStrategyThresholdCalibrationTables,
  listLatestApprovedStrategyThresholdCalibrations,
  listStrategyThresholdCalibrationEvidenceRows,
  persistStrategyThresholdAutoCalibrationResult,
  summarizeStrategyThresholdCalibrationResult,
  type StrategyThresholdAutoCalibrationOptions,
  type StrategyThresholdAutoCalibrationResult,
  type StrategyThresholdCalibrationCadence,
} from './strategyThresholdCalibration'

export const STRATEGY_LEARNING_VERSION = 'strategy-learning-v5'

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
  evaluable: 0 | 1
  unavailable_reason: string | null
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
  absolute_return_net?: number | string | null
  residual_return_net?: number | string | null
  cross_section_rank?: number | string | null
  benchmark_scope?: string | null
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

export interface StrategyLearningDailyStatsRow {
  date: string
  strategy_id: string
  strategy_version: string
  decisions: number
  evaluable_decisions: number
  unavailable_decisions: number
  matched: number
  reward_samples: number
  reward_hits: number
  reward_sum: number
  date_portfolio_return: number | null
  reward_refresh_run_id: string | null
  updated_at: string
}

interface StrategyLearningHeadRow {
  strategy_id: string
  strategy_version: string
  lifetime_decisions: number
  lifetime_evaluable_decisions: number
  lifetime_unavailable_decisions: number
  lifetime_matched: number
  decision_dates: number
  lifetime_reward_samples: number
  lifetime_reward_hits: number
  lifetime_reward_sum: number
  reward_dates: number
  latest_decision_date: string | null
  latest_reward_date: string | null
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
    total_decisions: number
    evaluable_decisions: number
    unavailable_decisions: number
    matched: number
    match_rate: number | null
    samples: number
    hit_rate: number | null
    avg_return_pct: number | null
    max_drawdown_pct: number | null
    mature_dates: number
    date_return_lcb90: number | null
    lifetime_decisions: number
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
      evidence_available: boolean
      reward_owner: 'selection_edge_v4' | 's12_execution_replay_v3_net'
      decisions: number
      evaluable_decisions: number
      unavailable_decisions: number
      matched: number
      match_rate: number | null
      today_decisions: number
      today_evaluable_decisions: number
      today_unavailable_decisions: number
      today_matched: number
      rolling_decisions: number
      rolling_evaluable_decisions: number
      rolling_unavailable_decisions: number
      rolling_matched: number
      rolling_match_rate: number | null
      rolling_sessions: number
      samples: number
      hit_rate: number | null
      avg_return_pct: number | null
      max_drawdown_pct: number | null
      rolling_samples: number
      rolling_hit_rate: number | null
      rolling_avg_return_pct: number | null
      rolling_max_drawdown_pct: number | null
      rolling_reward_dates: number
      rolling_date_return_mean: number | null
      rolling_date_return_lcb90: number | null
      latest_decision_date: string | null
      latest_reward_date: string | null
      status: 'learning' | 'no_decisions' | 'no_reward' | 'unavailable'
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
const PROMOTION_MIN_MATURE_DATES = 10
const PROMOTION_MIN_DATE_RETURN_LCB90 = 0
const STRATEGY_LEARNING_ROLLING_SESSIONS = 60
const STRATEGY_DAILY_RECONCILIATION_CALENDAR_DAYS = 21
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
    evaluable INTEGER NOT NULL DEFAULT 0 CHECK(evaluable IN (0,1)),
    unavailable_reason TEXT,
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
  `CREATE TABLE IF NOT EXISTS strategy_learning_daily_stats (
    date TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    decisions INTEGER NOT NULL DEFAULT 0,
    evaluable_decisions INTEGER NOT NULL DEFAULT 0,
    unavailable_decisions INTEGER NOT NULL DEFAULT 0,
    matched INTEGER NOT NULL DEFAULT 0,
    reward_samples INTEGER NOT NULL DEFAULT 0,
    reward_hits INTEGER NOT NULL DEFAULT 0,
    reward_sum REAL NOT NULL DEFAULT 0,
    date_portfolio_return REAL,
    reward_refresh_run_id TEXT,
    projection_version TEXT NOT NULL DEFAULT 'strategy-learning-daily-v1',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(date, strategy_id, strategy_version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_learning_daily_stats_strategy_date
    ON strategy_learning_daily_stats(strategy_id, strategy_version, date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_learning_daily_stats_date
    ON strategy_learning_daily_stats(date DESC, strategy_id)`,
  `CREATE TABLE IF NOT EXISTS strategy_learning_head (
    strategy_id TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    lifetime_decisions INTEGER NOT NULL DEFAULT 0,
    lifetime_evaluable_decisions INTEGER NOT NULL DEFAULT 0,
    lifetime_unavailable_decisions INTEGER NOT NULL DEFAULT 0,
    lifetime_matched INTEGER NOT NULL DEFAULT 0,
    decision_dates INTEGER NOT NULL DEFAULT 0,
    lifetime_reward_samples INTEGER NOT NULL DEFAULT 0,
    lifetime_reward_hits INTEGER NOT NULL DEFAULT 0,
    lifetime_reward_sum REAL NOT NULL DEFAULT 0,
    reward_dates INTEGER NOT NULL DEFAULT 0,
    latest_decision_date TEXT,
    latest_reward_date TEXT,
    projection_version TEXT NOT NULL DEFAULT 'strategy-learning-head-v1',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(strategy_id, strategy_version)
  )`,
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
    refresh_run_id TEXT,
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
  `CREATE TABLE IF NOT EXISTS strategy_evidence_rebuild_runs_v5 (
    signal_date TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK(status IN ('pending','success','blocked','failed')),
    candidate_count INTEGER NOT NULL DEFAULT 0,
    strategy_count INTEGER NOT NULL DEFAULT 0,
    decision_rows INTEGER NOT NULL DEFAULT 0,
    evaluable_rows INTEGER NOT NULL DEFAULT 0,
    unavailable_rows INTEGER NOT NULL DEFAULT 0,
    matrix_rows INTEGER NOT NULL DEFAULT 0,
    labeler_version TEXT NOT NULL DEFAULT 'strategy-decision-log-pit-reconstruction-v5',
    source_checksum TEXT,
    blocker_reason TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_evidence_rebuild_v5_status
    ON strategy_evidence_rebuild_runs_v5(status, signal_date)`,
  `CREATE TABLE IF NOT EXISTS strategy_replacement_cutover_guards_v5 (
    guard_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('pre','post','portfolio_post')),
    precondition_ok INTEGER NOT NULL CHECK(precondition_ok=1),
    evidence_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_replacement_cutover_guards_v5_run
    ON strategy_replacement_cutover_guards_v5(run_id, phase)`,
  `CREATE TABLE IF NOT EXISTS strategy_replacement_decisions_v5 (
    decision_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    as_of_date TEXT NOT NULL,
    family_id TEXT NOT NULL,
    candidate_strategy_id TEXT NOT NULL,
    candidate_strategy_version TEXT NOT NULL,
    replaced_strategy_id TEXT NOT NULL,
    replaced_strategy_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('proposed','accepted','rejected')),
    paired_dates INTEGER NOT NULL DEFAULT 0,
    paired_delta_mean REAL,
    paired_delta_lcb90 REAL,
    candidate_absolute_mean REAL,
    candidate_max_drawdown REAL,
    replaced_max_drawdown REAL,
    candidate_turnover REAL,
    replaced_turnover REAL,
    return_correlation REAL,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(run_id, candidate_strategy_id, candidate_strategy_version, replaced_strategy_id, replaced_strategy_version)
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

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function pctChange(current: number | null, base: number | null): number | null {
  if (current == null || base == null || Math.abs(base) < 1e-9) return null
  return current / base - 1
}

function firstFinite(...values: unknown[]): number | null {
  for (const value of values) {
    const number = finiteNumber(value)
    if (number != null) return number
  }
  return null
}

function percentileRank(value: number, sortedAsc: number[]): number | null {
  if (!Number.isFinite(value) || sortedAsc.length < 2) return null
  let lower = 0
  while (lower < sortedAsc.length && sortedAsc[lower] < value) lower++
  let upper = lower
  while (upper < sortedAsc.length && sortedAsc[upper] <= value) upper++
  const midpointIndex = (lower + Math.max(lower, upper - 1)) / 2
  return Math.min(1, Math.max(0, midpointIndex / (sortedAsc.length - 1)))
}

function ensureRawSignalObjects(candidate: StrategyCandidateInput): StrategyRawSignals {
  const raw = (
    candidate.raw_signals && typeof candidate.raw_signals === 'object' && !Array.isArray(candidate.raw_signals)
      ? candidate.raw_signals
      : {}
  ) as StrategyRawSignals
  raw.technicalIndicators = { ...(raw.technicalIndicators ?? {}) }
  raw.factorSignals = { ...(raw.factorSignals ?? {}) }
  candidate.raw_signals = raw
  return raw
}

function setIfFinite(target: Record<string, number | null | undefined>, key: string, value: number | null): boolean {
  if (value == null || !Number.isFinite(value)) return false
  if (finiteNumber(target[key]) != null) return false
  target[key] = round6(value)
  return true
}

function sortedDailyBars(rows: Array<{
  date: string
  open: number | string | null
  high: number | string | null
  low: number | string | null
  close: number | string | null
  volume: number | string | null
}>): OhlcvRow[] {
  return rows
    .map((row) => ({
      date: String(row.date ?? ''),
      open: finiteNumber(row.open),
      high: finiteNumber(row.high),
      low: finiteNumber(row.low),
      close: finiteNumber(row.close),
      volume: finiteNumber(row.volume) ?? 0,
    }))
    .filter((row): row is OhlcvRow => (
      Boolean(row.date)
      && row.open != null
      && row.high != null
      && row.low != null
      && row.close != null
      && row.high >= row.low
    ))
    .sort((left, right) => left.date.localeCompare(right.date))
}

interface StrategyCandidatePriceRow {
  symbol: string
  date: string
  open: number | string | null
  high: number | string | null
  low: number | string | null
  close: number | string | null
  volume: number | string | null
}

function materializeDailyVwapAndSmc(raw: StrategyRawSignals, bars: OhlcvRow[]): boolean {
  if (bars.length < 2) return false
  raw.technicalIndicators = { ...(raw.technicalIndicators ?? {}) }
  raw.factorSignals = { ...(raw.factorSignals ?? {}) }
  let touched = false
  const latest = bars[bars.length - 1]
  const close = finiteNumber(raw.close) ?? latest.close
  const latestTypical = (latest.high + latest.low + latest.close) / 3
  const vwapBias = pctChange(close, latestTypical)
  const vwapBars = bars.slice(-5)
  const volumeSum = vwapBars.reduce((sum, row) => sum + Math.max(0, row.volume ?? 0), 0)
  const vwap5d = vwapBars.length >= 5 && volumeSum > 0
    ? vwapBars.reduce((sum, row) => sum + (((row.high + row.low + row.close) / 3) * Math.max(0, row.volume ?? 0)), 0) / volumeSum
    : null
  const vwapBias5d = pctChange(close, vwap5d)
  raw.close = firstFinite(raw.close, close)
  raw.vwapBias = firstFinite(raw.vwapBias, raw.factorSignals.vwap_bias, raw.technicalIndicators.vwap_bias, vwapBias)
  raw.vwap5d = firstFinite(raw.vwap5d, raw.factorSignals.vwap_5d, raw.technicalIndicators.vwap_5d, vwap5d)
  raw.vwapBias5d = firstFinite(raw.vwapBias5d, raw.factorSignals.vwap_bias_5d, raw.technicalIndicators.vwap_bias_5d, vwapBias5d)
  for (const [key, value] of [
    ['vwapBias', raw.vwapBias],
    ['vwap5d', raw.vwap5d],
    ['vwapBias5d', raw.vwapBias5d],
  ] as const) {
    touched = setIfFinite(raw.technicalIndicators, key, value) || touched
    if (key === 'vwap5d') touched = setIfFinite(raw.technicalIndicators, 'vwap_5d', value) || touched
  }
  touched = setIfFinite(raw.technicalIndicators, 'vwap_bias', raw.vwapBias ?? null) || touched
  touched = setIfFinite(raw.technicalIndicators, 'vwap_bias_5d', raw.vwapBias5d ?? null) || touched
  touched = setIfFinite(raw.factorSignals, 'vwap_bias', raw.vwapBias ?? null) || touched
  touched = setIfFinite(raw.factorSignals, 'vwap_5d', raw.vwap5d ?? null) || touched
  touched = setIfFinite(raw.factorSignals, 'vwap_bias_5d', raw.vwapBias5d ?? null) || touched
  touched = setIfFinite(raw.factorSignals, 'vwapBias', raw.vwapBias ?? null) || touched
  touched = setIfFinite(raw.factorSignals, 'vwap5d', raw.vwap5d ?? null) || touched
  touched = setIfFinite(raw.factorSignals, 'vwapBias5d', raw.vwapBias5d ?? null) || touched

  if (bars.length >= 5) {
    const structure = buildPriceActionStructure(bars, { latestPrice: close })
    const smc = structure.smc
    raw.bestOrderBlockStrength = firstFinite(raw.bestOrderBlockStrength, raw.technicalIndicators.bestOrderBlockStrength, structure.bestOrderBlock?.strength)
    touched = setIfFinite(raw.technicalIndicators, 'bestOrderBlockStrength', raw.bestOrderBlockStrength ?? null) || touched
    touched = setIfFinite(raw.technicalIndicators, 'smcBullishScore', firstFinite(raw.technicalIndicators.smcBullishScore, smc.bullishScore)) || touched
    touched = setIfFinite(raw.technicalIndicators, 'smcBearishScore', firstFinite(raw.technicalIndicators.smcBearishScore, smc.bearishScore)) || touched
    touched = setIfFinite(raw.technicalIndicators, 'smcNetScore', firstFinite(raw.technicalIndicators.smcNetScore, smc.score)) || touched
    touched = setIfFinite(raw.technicalIndicators, 'smcBiasBullish', firstFinite(raw.technicalIndicators.smcBiasBullish, smc.bias === 'bullish' ? 1 : 0)) || touched
    touched = setIfFinite(raw.technicalIndicators, 'smcBiasBearish', firstFinite(raw.technicalIndicators.smcBiasBearish, smc.bias === 'bearish' ? 1 : 0)) || touched
  }
  return touched
}

function materializeSmrcVwapCrossSectionalRanks(candidates: StrategyCandidateInput[]): void {
  const rankFields = [
    { rawKey: 'vwapBias' as const, factorKey: 'finlabCsVwapBiasRank' },
    { rawKey: 'vwapBias5d' as const, factorKey: 'finlabCsVwapBias5dRank' },
    { rawKey: 'bestOrderBlockStrength' as const, factorKey: 'finlabCsBestOrderBlockStrengthRank' },
    { rawKey: 'volumeExpansion20' as const, factorKey: 'finlabCsVolumeExpansion20Rank' },
  ]
  const valuesByField = new Map<string, number[]>()
  for (const field of rankFields) {
    valuesByField.set(field.factorKey, candidates
      .map((candidate) => {
        const raw = ensureRawSignalObjects(candidate)
        return firstFinite(raw[field.rawKey], raw.factorSignals?.[field.rawKey], raw.technicalIndicators?.[field.rawKey])
      })
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b))
  }
  for (const candidate of candidates) {
    const raw = ensureRawSignalObjects(candidate)
    for (const field of rankFields) {
      if (finiteNumber(raw.factorSignals?.[field.factorKey]) != null) continue
      const value = firstFinite(raw[field.rawKey], raw.factorSignals?.[field.rawKey], raw.technicalIndicators?.[field.rawKey])
      if (value == null) continue
      const rank = percentileRank(value, valuesByField.get(field.factorKey) ?? [])
      if (rank == null) continue
      raw.factorSignals![field.factorKey] = round4(rank)
    }
  }
}

function stableIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 96)
}

function isoDateMinusCalendarDays(date: string, days: number): string {
  const parsed = new Date(date + 'T00:00:00.000Z')
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid_strategy_learning_date:' + date)
  parsed.setUTCDate(parsed.getUTCDate() - Math.max(0, Math.floor(days)))
  return parsed.toISOString().slice(0, 10)
}

export async function ensureStrategyLearningTables(db: D1Database): Promise<void> {
  for (const sql of SCHEMA_DDL) {
    await db.prepare(sql).run()
  }
  try {
    await db.prepare('ALTER TABLE strategy_reward_ledger ADD COLUMN refresh_run_id TEXT').run()
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).toLowerCase()
    if (!message.includes('duplicate column') && !message.includes('already exists')) throw error
  }
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_strategy_reward_ledger_refresh
    ON strategy_reward_ledger(refresh_run_id, date_end)`).run()
  await ensureStrategyRegistryGovernanceColumns(db)
  await ensureStrategyThresholdCalibrationTables(db)
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
        status=CASE
          WHEN strategy_spec_registry.status IN ('research','shadow','candidate','active','retired')
          THEN strategy_spec_registry.status
          ELSE excluded.status
        END,
        alpha_bucket=excluded.alpha_bucket,
        family_id=excluded.family_id,
        variant_id=excluded.variant_id,
        owner_type=CASE
          WHEN strategy_spec_registry.owner_type IN ('strategy','feature','observe','retired')
          THEN strategy_spec_registry.owner_type
          ELSE excluded.owner_type
        END,
        promotion_status=CASE
          WHEN strategy_spec_registry.promotion_status IN ('production','candidate','research','retired')
          THEN strategy_spec_registry.promotion_status
          ELSE excluded.promotion_status
        END,
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
  const approvedRuntimeIds = DEFAULT_STRATEGY_SPECS
    .filter((spec) => spec.status !== 'retired')
    .map((spec) => spec.id)
  const placeholders = approvedRuntimeIds.length ? approvedRuntimeIds.map(() => '?').join(', ') : "''"
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
  `).bind(nowIso, ...approvedRuntimeIds).run()
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
  const latestThresholdCalibrations = await listLatestApprovedStrategyThresholdCalibrations(db)
  const calibratedSpecs = applyStrategyThresholdCalibrationArtifacts(registrySpecs, latestThresholdCalibrations)
  const specs = calibratedSpecs.filter((spec) => spec.status !== 'retired')
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
      const evaluability = assessStrategySpecEvaluability(candidate, spec)
      const assessment = validation.ok && evaluability.evaluable
        ? assessCandidateAgainstStrategySpecs(candidate, [spec])
        : { matches: [], tags: [], watchPoints: [] }
      const matched = evaluability.evaluable && assessment.matches.length > 0
      const unavailableReason = evaluability.evaluable ? null : evaluability.unavailableReasons.join('|')
      const reasonCode = !validation.ok
        ? `strategy_spec_invalid:${validation.errors.join('|')}`
        : !evaluability.evaluable
          ? `strategy_spec_unavailable:${unavailableReason}`
          : matched
            ? 'strategy_spec_matched'
            : 'strategy_spec_no_match'
      const rawSignals = deriveStrategyRawSignals(candidate)
      const featureRefDiagnostics = explainFeatureRefDsl(rawSignals, spec.thresholds.featureRefs)
      const currentPrice = finiteNumber(candidate.current_price) ?? finiteNumber(rawSignals.close)
      const volumeExpansion20 = finiteNumber(rawSignals.volumeExpansion20)
      const evidence = {
        validation,
        matches: assessment.matches,
        tags: assessment.tags,
        watch_points: assessment.watchPoints,
        evaluability,
        signal_dsl_diagnostics: evaluability.signalDiagnostics,
        feature_ref_diagnostics: featureRefDiagnostics,
        base_gate_diagnostics: {
          price: {
            value: currentPrice,
            min: spec.thresholds.minPrice ?? null,
            max: spec.thresholds.maxPrice ?? null,
            passed: spec.thresholds.minPrice == null && spec.thresholds.maxPrice == null
              ? true
              : currentPrice != null
                && (spec.thresholds.minPrice == null || currentPrice >= spec.thresholds.minPrice)
                && (spec.thresholds.maxPrice == null || currentPrice <= spec.thresholds.maxPrice),
          },
          volume_expansion_20: {
            value: volumeExpansion20,
            min: spec.thresholds.minVolumeExpansion20 ?? null,
            passed: spec.thresholds.minVolumeExpansion20 == null
              || (volumeExpansion20 != null && volumeExpansion20 >= spec.thresholds.minVolumeExpansion20),
          },
          missing_required_feature_refs: Array.isArray(featureRefDiagnostics?.missing_required_feature_refs)
            ? featureRefDiagnostics.missing_required_feature_refs
            : [],
        },
      }
      const thresholdScores = deriveStrategyThresholdScores(candidate)
      const context = {
        candidate: {
          raw_signals: rawSignals,
          current_price: finiteNumber(candidate.current_price),
          industry: candidate.industry ?? candidate.sector ?? null,
        },
        score_v2: {
          finalScore: thresholdScores.seedScore,
          components: {
            chipFlow: thresholdScores.chipFlow,
            technicalStructure: thresholdScores.technicalStructure,
            momentumProxy: thresholdScores.momentumScore,
          },
          source: thresholdScores.source,
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
        evaluable: evaluability.evaluable ? 1 : 0,
        unavailable_reason: unavailableReason,
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
  afterSymbol = '',
): Promise<StrategyCandidateInput[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 2000))
  const safeAfterSymbol = cleanToken(afterSymbol)
  const { results } = await db.prepare(`
    WITH canonical_reference AS (
      SELECT r.signal_date, r.symbol, r.producer_run_id, r.name, r.sector,
             r.market_segment, r.score_components
        FROM selection_reference_snapshots_v1 r
       WHERE r.signal_date=?
         AND r.hard_gate_passed=1
         AND r.strategy_labeled=1
         AND r.strategy_matrix_status='ready'
         AND r.symbol>?
         AND EXISTS (
           SELECT 1
             FROM canonical_run_heads h
            WHERE h.logical_run_key='screener:' || r.signal_date || ':TW:production:market_screener'
              AND h.run_id=r.producer_run_id
         )
    ),
    funnel_candidates AS (
      SELECT i.symbol, i.name, i.stage, i.evidence, i.score_after, i.rank,
             ROW_NUMBER() OVER (
               PARTITION BY i.symbol
               ORDER BY
                 CASE i.stage
                   WHEN 'scoring' THEN 1
                   WHEN 'layer1_strategy_breadth_gate' THEN 2
                   WHEN 'l1_candidate_seed_after_overlay' THEN 3
                   WHEN 'final_selection' THEN 4
                   ELSE 4
                 END,
                 COALESCE(i.rank, 999999) ASC
             ) AS row_rank
        FROM screener_funnel_items i
        JOIN canonical_reference r
          ON r.producer_run_id=i.run_id AND r.symbol=i.symbol
    )
    SELECT r.symbol,
           COALESCE(dr.name, r.name, fc.name) AS name,
           COALESCE(dr.sector, r.sector) AS sector,
           dr.industry,
           COALESCE(dr.score_components, r.score_components) AS score_components,
           dr.current_price,
           fc.evidence AS funnel_evidence,
           fc.score_after AS funnel_score,
           fc.rank AS funnel_rank
      FROM canonical_reference r
      LEFT JOIN funnel_candidates fc
        ON fc.symbol=r.symbol AND fc.row_rank=1
      LEFT JOIN daily_recommendations dr
        ON dr.date = ?
       AND dr.symbol = r.symbol
     ORDER BY r.symbol ASC
     LIMIT ?
  `).bind(date, safeAfterSymbol, date, safeLimit).all<StrategyCandidateInput & {
    score_components?: unknown
    funnel_evidence?: string | null
    funnel_score?: number | null
    funnel_rank?: number | null
  }>()
  const candidates = (results ?? []).map(({ score_components, funnel_evidence, funnel_score: _funnelScore, funnel_rank: _funnelRank, ...row }) => {
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
  await hydrateStrategyCandidateDailyFeatures(db, date, candidates)
  await hydrateS12StrategyEvidence(db, date, candidates)
  return candidates
}

interface StrategyS12EvidenceRow {
  symbol: string
  source: string
  state: string
  ready: number | string
  invalidated: number | string
}

export async function hydrateS12StrategyEvidence(
  db: D1Database,
  date: string,
  candidates: StrategyCandidateInput[],
): Promise<{ available: number; unavailable: number; missing: number }> {
  if (!candidates.length) return { available: 0, unavailable: 0, missing: 0 }
  const bySymbol = new Map<string, StrategyS12EvidenceRow>()
  const symbols = [...new Set(candidates.map((candidate) => cleanToken(candidate.symbol)).filter(Boolean))]
  for (let offset = 0; offset < symbols.length; offset += 80) {
    const chunk = symbols.slice(offset, offset + 80)
    const placeholders = chunk.map(() => '?').join(',')
    const page = await db.prepare(`
      SELECT symbol, source, state, ready, invalidated
        FROM (
          SELECT symbol, source, state, ready, invalidated,
                 ROW_NUMBER() OVER (
                   PARTITION BY symbol
                   ORDER BY CASE source
                     WHEN 's12_candidate_snapshot' THEN 1
                     WHEN 's12_candidate_snapshot_reconstruction' THEN 2
                     ELSE 3
                   END, updated_at DESC, id DESC
                 ) AS row_rank
            FROM s12_structure_snapshots
           WHERE trade_date=?
             AND symbol IN (${placeholders})
             AND source IN ('s12_candidate_snapshot', 's12_candidate_snapshot_reconstruction')
        )
       WHERE row_rank=1
    `).bind(date, ...chunk).all<StrategyS12EvidenceRow>()
    for (const row of page.results ?? []) bySymbol.set(cleanToken(row.symbol), row)
  }
  let available = 0
  let unavailable = 0
  let missing = 0
  for (const candidate of candidates) {
    const row = bySymbol.get(cleanToken(candidate.symbol))
    const raw = ensureRawSignalObjects(candidate)
    if (!row) {
      missing += 1
      continue
    }
    if (cleanToken(row.state) === 'data_unavailable') {
      raw.source = [cleanToken(raw.source), `s12:${row.source}:data_unavailable`].filter(Boolean).join('|')
      unavailable += 1
      continue
    }
    const ready = Number(row.ready) === 1
    const invalidated = Number(row.invalidated) === 1
    raw.technicalIndicators!.stockTechS12StructureAvailable = 1
    raw.technicalIndicators!.stockTechS12Ready = ready ? 1 : 0
    raw.technicalIndicators!.stockTechS12Invalidated = invalidated ? 1 : 0
    raw.technicalIndicators!.stockTechS12Signal = ready && !invalidated ? 1 : 0
    raw.technicalIndicators!.stockTechS12Score = ready && !invalidated ? 1 : 0
    raw.source = [cleanToken(raw.source), `s12:${row.source}:${cleanToken(row.state)}`].filter(Boolean).join('|')
    available += 1
  }
  return { available, unavailable, missing }
}
export async function hydrateStrategyCandidateDailyFeatures(
  db: D1Database,
  date: string,
  candidates: StrategyCandidateInput[],
): Promise<{
  hydratedSymbols: number
  materializedAliases: number
}> {
  if (!candidates.length) return { hydratedSymbols: 0, materializedAliases: 0 }
  for (const candidate of candidates) ensureRawSignalObjects(candidate)
  const symbols = [...new Set(candidates.map((candidate) => cleanToken(candidate.symbol)).filter(Boolean))]
  const symbolsNeedingOhlcv = symbols.filter((symbol) => {
    const candidate = candidates.find((row) => cleanToken(row.symbol) === symbol)
    const raw = candidate ? ensureRawSignalObjects(candidate) : {}
    return (
      firstFinite(
        raw.vwapBias,
        raw.factorSignals?.vwap_bias,
        raw.technicalIndicators?.vwap_bias,
      ) == null
      || firstFinite(
        raw.vwapBias5d,
        raw.factorSignals?.vwap_bias_5d,
        raw.technicalIndicators?.vwap_bias_5d,
      ) == null
      || firstFinite(
        raw.technicalIndicators?.smcNetScore,
      ) == null
      || firstFinite(
        raw.bestOrderBlockStrength,
        raw.technicalIndicators?.bestOrderBlockStrength,
      ) == null
    )
  })
  let hydratedSymbols = 0
  if (symbolsNeedingOhlcv.length > 0) {
    const placeholders = symbolsNeedingOhlcv.map(() => '?').join(', ')
    try {
      const { results } = await db.prepare(`
        SELECT s.symbol, sp.date, sp.open, sp.high, sp.low, sp.close, sp.volume
          FROM stock_prices sp
          JOIN stocks s ON s.id = sp.stock_id
         WHERE s.symbol IN (${placeholders})
           AND sp.date <= ?
         ORDER BY s.symbol ASC, sp.date DESC
         LIMIT ?
      `).bind(...symbolsNeedingOhlcv, date, Math.min(5000, symbolsNeedingOhlcv.length * 70)).all<StrategyCandidatePriceRow>()
      const bySymbol = new Map<string, StrategyCandidatePriceRow[]>()
      for (const row of results ?? []) {
        const symbol = cleanToken(row.symbol)
        if (!symbol) continue
        const rows = bySymbol.get(symbol) ?? []
        rows.push(row)
        bySymbol.set(symbol, rows)
      }
      for (const candidate of candidates) {
        const symbol = cleanToken(candidate.symbol)
        if (!symbol) continue
        const bars = sortedDailyBars((bySymbol.get(symbol) ?? []).slice(0, 70))
        if (!bars.length) continue
        const touched = materializeDailyVwapAndSmc(ensureRawSignalObjects(candidate), bars)
        if (touched) hydratedSymbols += 1
      }
    } catch {
      // Strategy learning must still run when historical D1 shards lack stock_prices;
      // missing feature refs remain visible in decision evidence.
    }
  }
  const aliasTelemetry = materializeFormal137FeatureAliases(candidates.map((candidate) => ({
    raw_signals: ensureRawSignalObjects(candidate),
  })))
  materializeSmrcVwapCrossSectionalRanks(candidates)
  return {
    hydratedSymbols,
    materializedAliases: aliasTelemetry.materializedCount,
  }
}

export async function persistStrategyDecisionRows(
  db: D1Database,
  rows: StrategyDecisionLogRow[],
  artifactEnv?: Pick<Bindings, 'DB' | 'ARTIFACTS'>,
  producerRunId = `strategy-learning-${rows[0]?.date ?? 'unknown'}`,
): Promise<number> {
  await ensureStrategyLearningTables(db)
  if (rows.length === 0) return 0
  let persistedRows = rows
  let contextStatements: D1PreparedStatement[] = []
  if (artifactEnv?.ARTIFACTS) {
    const artifact = await writeEvidenceArtifact(artifactEnv, {
      domain: 'strategy_decision_evidence',
      businessDate: rows[0].date,
      producerRunId,
      retentionClass: 'canonical_model_evidence',
      schemaVersion: 'strategy-decision-evidence-v2',
      payload: {
        contexts: [...new Map(rows.map((row) => [`${row.date}:${row.symbol}`, {
          date: row.date,
          symbol: row.symbol,
          context: JSON.parse(row.context_json),
        }])).values()],
        decisions: rows.map((row) => ({
          decision_id: row.decision_id,
          strategy_id: row.strategy_id,
          strategy_version: row.strategy_version,
          evidence: JSON.parse(row.evidence_json),
        })),
      },
      rowCount: rows.length,
      metadata: { symbols: [...new Set(rows.map((row) => row.symbol))].length },
    })
    const contextBySymbol = new Map<string, { contextId: string; compactContext: string }>()
    for (const row of rows) {
      const key = `${row.date}:${row.symbol}`
      if (contextBySymbol.has(key)) continue
      const parsed = JSON.parse(row.context_json) as any
      const contextHash = await sha256Text(row.context_json)
      const contextId = `strategy-context:${row.date}:${row.symbol}:${contextHash.replace(/^sha256:/, '').slice(0, 16)}`
      const rawSignals = {
        ...(parsed?.candidate?.raw_signals ?? {}),
        score_v2: parsed?.score_v2 ?? null,
      }
      contextBySymbol.set(key, {
        contextId,
        compactContext: JSON.stringify({
          schema_version: 'strategy-context-pointer-v1',
          context_id: contextId,
          artifact_id: artifact.artifact_id,
          r2_key: artifact.r2_key,
          checksum: artifact.checksum,
        }),
      })
      contextStatements.push(db.prepare(`
        INSERT OR IGNORE INTO strategy_candidate_contexts (
          context_id, date, symbol, context_hash, raw_signals_json,
          current_price, industry, artifact_id, r2_key, checksum, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        contextId,
        row.date,
        row.symbol,
        contextHash,
        JSON.stringify(rawSignals),
        parsed?.candidate?.current_price ?? null,
        parsed?.candidate?.industry ?? null,
        artifact.artifact_id,
        artifact.r2_key,
        artifact.checksum,
        row.created_at,
      ))
    }
    persistedRows = rows.map((row) => {
      const context = contextBySymbol.get(`${row.date}:${row.symbol}`)!
      const evidence = JSON.parse(row.evidence_json) as any
      return {
        ...row,
        context_json: context.compactContext,
        evidence_json: JSON.stringify({
          schema_version: 'strategy-evidence-pointer-v1',
          artifact_id: artifact.artifact_id,
          r2_key: artifact.r2_key,
          checksum: artifact.checksum,
          feature_ref_diagnostics: {
            weighted_score: evidence?.feature_ref_diagnostics?.weighted_score ?? null,
            effective_min: evidence?.feature_ref_diagnostics?.effective_min ?? null,
            passes_weighted_score: evidence?.feature_ref_diagnostics?.passes_weighted_score ?? null,
            missing_required_feature_refs: evidence?.feature_ref_diagnostics?.missing_required_feature_refs ?? [],
          },
          evaluability: evidence?.evaluability ?? null,
          signal_dsl_diagnostics: evidence?.signal_dsl_diagnostics ?? [],
          base_gate_diagnostics: evidence?.base_gate_diagnostics ?? null,
          rejection_diagnostics: Array.isArray(evidence?.watch_points) ? evidence.watch_points : [],
        }),
        context_id: context.contextId,
        evidence_artifact_id: artifact.artifact_id,
      } as StrategyDecisionLogRow & { context_id: string; evidence_artifact_id: string }
    })
  }
  for (let i = 0; i < contextStatements.length; i += STRATEGY_LEARNING_D1_BATCH_SIZE) {
    await db.batch(contextStatements.slice(i, i + STRATEGY_LEARNING_D1_BATCH_SIZE))
  }
  const statements = persistedRows.map((row) => db.prepare(`
    INSERT INTO strategy_decision_log (
      decision_id, date, symbol, name, strategy_id, strategy_version,
      strategy_status, alpha_bucket, evaluable, unavailable_reason, matched, match_score, reason_code,
      context_json, evidence_json, created_at, context_id, evidence_artifact_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, symbol, strategy_id, strategy_version) DO UPDATE SET
      name=excluded.name,
      strategy_status=excluded.strategy_status,
      alpha_bucket=excluded.alpha_bucket,
      evaluable=excluded.evaluable,
      unavailable_reason=excluded.unavailable_reason,
      matched=excluded.matched,
      match_score=excluded.match_score,
      reason_code=excluded.reason_code,
      context_json=excluded.context_json,
      evidence_json=excluded.evidence_json,
      context_id=excluded.context_id,
      evidence_artifact_id=excluded.evidence_artifact_id
  `).bind(
    row.decision_id,
    row.date,
    row.symbol,
    row.name,
    row.strategy_id,
    row.strategy_version,
    row.strategy_status,
    row.alpha_bucket,
    row.evaluable,
    row.unavailable_reason,
    row.matched,
    row.match_score,
    row.reason_code,
    row.context_json,
    row.evidence_json,
    row.created_at,
    (row as any).context_id ?? null,
    (row as any).evidence_artifact_id ?? null,
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
  options: {
    date: string
    limit?: number
    dryRun?: boolean
    artifactEnv?: Pick<Bindings, 'DB' | 'ARTIFACTS'>
    producerRunId?: string
  },
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
  const persisted = dryRun ? 0 : await persistStrategyDecisionRows(db, rows, options.artifactEnv, options.producerRunId)
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
  return finiteNumber(row.residual_return_net)
}

function maxDrawdownFromDateReturns(values: number[]): number | null {
  if (!values.length) return null
  let equity = 1
  let peak = 1
  let mdd = 0
  for (const value of values) {
    equity *= Math.max(0, 1 + value)
    peak = Math.max(peak, equity)
    mdd = Math.min(mdd, peak > 0 ? equity / peak - 1 : -1)
  }
  return round6(mdd)
}

export function summarizeDateClusteredReturns(values: number[]): {
  mean: number | null
  lcb90: number | null
} {
  const finite = values.filter((value) => Number.isFinite(value))
  if (!finite.length) return { mean: null, lcb90: null }
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length
  if (finite.length < 2) return { mean: round6(mean), lcb90: null }
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (finite.length - 1)
  const standardError = Math.sqrt(Math.max(variance, 0) / finite.length)
  return {
    mean: round6(mean),
    lcb90: round6(mean - 1.281551565545 * standardError),
  }
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
  const buckets = new Map<string, {
    row: StrategyRewardSourceRow
    rewards: number[]
    rewardsByDate: Map<string, number[]>
    dates: string[]
    symbols: Set<string>
    matchedTotal: number
  }>()
  for (const row of rows) {
    const reward = rewardForRow(row)
    if (reward == null) continue
    const marketSegment = options.marketSegment ?? (cleanToken(row.market_segment) || 'all')
    const regime = options.regime ?? regimeFromAlphaContext(row.alpha_context)
    const key = `${row.strategy_id}|${row.strategy_version}|${marketSegment}|${regime}`
    const bucket = buckets.get(key) ?? {
      row,
      rewards: [],
      rewardsByDate: new Map<string, number[]>(),
      dates: [],
      symbols: new Set<string>(),
      matchedTotal: options.matchedTotal ?? rows.length,
    }
    bucket.rewards.push(reward)
    bucket.dates.push(row.date)
    bucket.rewardsByDate.set(row.date, [...(bucket.rewardsByDate.get(row.date) ?? []), reward])
    bucket.symbols.add(row.symbol)
    buckets.set(key, bucket)
  }
  return [...buckets.entries()].map(([key, bucket]) => {
    const [strategyId, strategyVersion, marketSegment, regime] = key.split('|')
    const rewards = bucket.rewards
    const rewardSum = rewards.reduce((sum, reward) => sum + reward, 0)
    const dates = [...new Set(bucket.dates)].sort()
    const datePortfolioReturns = dates.map((date) => {
      const dateRewards = bucket.rewardsByDate.get(date) ?? []
      return dateRewards.reduce((sum, reward) => sum + reward, 0) / dateRewards.length
    })
    const hitRate = rewards.length ? rewards.filter((reward) => reward > 0).length / rewards.length : null
    const avgReturn = rewards.length ? rewardSum / rewards.length : null
    const evidence = {
      version: STRATEGY_LEARNING_VERSION,
      reward_source: 'canonical_selection_labels_v4.residual_return_net',
      max_drawdown_semantic: 'date_clustered_equal_weight_compounded_residual_return_v1',
      max_drawdown_observation_dates: datePortfolioReturns.length,
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
      max_drawdown_pct: maxDrawdownFromDateReturns(datePortfolioReturns),
      coverage: bucket.matchedTotal > 0 ? round6(rewards.length / bucket.matchedTotal) : null,
      market_segment: marketSegment,
      regime,
      evidence_json: safeJson(evidence),
      updated_at: nowIso,
    }
  }).sort((a, b) => a.strategy_id.localeCompare(b.strategy_id))
}

export function buildStrategyRewardDailyStatsRows(
  rows: StrategyRewardSourceRow[],
  options: { nowIso?: string; refreshRunId?: string | null } = {},
): StrategyLearningDailyStatsRow[] {
  const nowIso = options.nowIso ?? new Date().toISOString()
  const refreshRunId = options.refreshRunId ?? null
  const buckets = new Map<string, {
    date: string
    strategyId: string
    strategyVersion: string
    rewards: number[]
  }>()
  for (const row of rows) {
    const reward = rewardForRow(row)
    if (reward == null) continue
    const key = `${row.date}|${row.strategy_id}|${row.strategy_version}`
    const bucket = buckets.get(key) ?? {
      date: row.date,
      strategyId: row.strategy_id,
      strategyVersion: row.strategy_version,
      rewards: [],
    }
    bucket.rewards.push(reward)
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
    .map((bucket) => {
      const rewardSum = bucket.rewards.reduce((sum, reward) => sum + reward, 0)
      return {
        date: bucket.date,
        strategy_id: bucket.strategyId,
        strategy_version: bucket.strategyVersion,
        decisions: 0,
        evaluable_decisions: 0,
        unavailable_decisions: 0,
        matched: 0,
        reward_samples: bucket.rewards.length,
        reward_hits: bucket.rewards.filter((reward) => reward > 0).length,
        reward_sum: round6(rewardSum) ?? 0,
        date_portfolio_return: round6(rewardSum / bucket.rewards.length),
        reward_refresh_run_id: refreshRunId,
        updated_at: nowIso,
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date)
      || a.strategy_id.localeCompare(b.strategy_id)
      || a.strategy_version.localeCompare(b.strategy_version))
}

export async function materializeStrategyDecisionDailyStats(
  db: D1Database,
  date: string,
): Promise<number> {
  await ensureStrategyLearningTables(db)
  const { results } = await db.prepare(`
    SELECT strategy_id,
           strategy_version,
           COUNT(*) AS decisions,
           SUM(CASE WHEN evaluable = 1 THEN 1 ELSE 0 END) AS evaluable_decisions,
           SUM(CASE WHEN evaluable = 0 THEN 1 ELSE 0 END) AS unavailable_decisions,
           SUM(CASE WHEN matched = 1 THEN 1 ELSE 0 END) AS matched
      FROM strategy_decision_log
     WHERE date = ?
     GROUP BY strategy_id, strategy_version
  `).bind(date).all<{
    strategy_id: string
    strategy_version: string
    decisions: number
    evaluable_decisions: number
    unavailable_decisions: number
    matched: number
  }>()
  const rows = results ?? []
  if (!rows.length) return 0
  const nowIso = new Date().toISOString()
  const statements = rows.map((row) => db.prepare(`
    INSERT INTO strategy_learning_daily_stats (
      date, strategy_id, strategy_version, decisions, evaluable_decisions, unavailable_decisions, matched, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, strategy_id, strategy_version) DO UPDATE SET
      decisions=excluded.decisions,
      evaluable_decisions=excluded.evaluable_decisions,
      unavailable_decisions=excluded.unavailable_decisions,
      matched=excluded.matched,
      updated_at=excluded.updated_at
  `).bind(
    date,
    row.strategy_id,
    row.strategy_version,
    Number(row.decisions ?? 0),
    Number(row.evaluable_decisions ?? 0),
    Number(row.unavailable_decisions ?? 0),
    Number(row.matched ?? 0),
    nowIso,
  ))
  for (let i = 0; i < statements.length; i += STRATEGY_LEARNING_D1_BATCH_SIZE) {
    await db.batch(statements.slice(i, i + STRATEGY_LEARNING_D1_BATCH_SIZE))
  }
  return rows.length
}

async function persistStrategyRewardDailyStatsRows(
  db: D1Database,
  rows: StrategyLearningDailyStatsRow[],
): Promise<number> {
  if (!rows.length) return 0
  const statements = rows.map((row) => db.prepare(`
    INSERT INTO strategy_learning_daily_stats (
      date, strategy_id, strategy_version,
      reward_samples, reward_hits, reward_sum, date_portfolio_return,
      reward_refresh_run_id, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, strategy_id, strategy_version) DO UPDATE SET
      reward_samples=excluded.reward_samples,
      reward_hits=excluded.reward_hits,
      reward_sum=excluded.reward_sum,
      date_portfolio_return=excluded.date_portfolio_return,
      reward_refresh_run_id=excluded.reward_refresh_run_id,
      updated_at=excluded.updated_at
  `).bind(
    row.date,
    row.strategy_id,
    row.strategy_version,
    row.reward_samples,
    row.reward_hits,
    row.reward_sum,
    row.date_portfolio_return,
    row.reward_refresh_run_id,
    row.updated_at,
  ))
  for (let i = 0; i < statements.length; i += STRATEGY_LEARNING_D1_BATCH_SIZE) {
    await db.batch(statements.slice(i, i + STRATEGY_LEARNING_D1_BATCH_SIZE))
  }
  return rows.length
}

export async function refreshStrategyLearningHeads(db: D1Database): Promise<number> {
  await ensureStrategyLearningTables(db)
  const { results } = await db.prepare(`
    SELECT strategy_id,
           strategy_version,
           SUM(decisions) AS lifetime_decisions,
           SUM(evaluable_decisions) AS lifetime_evaluable_decisions,
           SUM(unavailable_decisions) AS lifetime_unavailable_decisions,
           SUM(matched) AS lifetime_matched,
           COUNT(DISTINCT CASE WHEN decisions > 0 THEN date END) AS decision_dates,
           SUM(reward_samples) AS lifetime_reward_samples,
           SUM(reward_hits) AS lifetime_reward_hits,
           SUM(reward_sum) AS lifetime_reward_sum,
           COUNT(DISTINCT CASE WHEN reward_samples > 0 THEN date END) AS reward_dates,
           MAX(CASE WHEN decisions > 0 THEN date END) AS latest_decision_date,
           MAX(CASE WHEN reward_samples > 0 THEN date END) AS latest_reward_date
      FROM strategy_learning_daily_stats
     GROUP BY strategy_id, strategy_version
  `).all<StrategyLearningHeadRow>()
  const rows = results ?? []
  if (!rows.length) return 0
  const nowIso = new Date().toISOString()
  const statements = rows.map((row) => db.prepare(`
    INSERT INTO strategy_learning_head (
      strategy_id, strategy_version,
      lifetime_decisions, lifetime_evaluable_decisions, lifetime_unavailable_decisions, lifetime_matched, decision_dates,
      lifetime_reward_samples, lifetime_reward_hits, lifetime_reward_sum,
      reward_dates, latest_decision_date, latest_reward_date, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(strategy_id, strategy_version) DO UPDATE SET
      lifetime_decisions=excluded.lifetime_decisions,
      lifetime_evaluable_decisions=excluded.lifetime_evaluable_decisions,
      lifetime_unavailable_decisions=excluded.lifetime_unavailable_decisions,
      lifetime_matched=excluded.lifetime_matched,
      decision_dates=excluded.decision_dates,
      lifetime_reward_samples=excluded.lifetime_reward_samples,
      lifetime_reward_hits=excluded.lifetime_reward_hits,
      lifetime_reward_sum=excluded.lifetime_reward_sum,
      reward_dates=excluded.reward_dates,
      latest_decision_date=excluded.latest_decision_date,
      latest_reward_date=excluded.latest_reward_date,
      updated_at=excluded.updated_at
  `).bind(
    row.strategy_id,
    row.strategy_version,
    Number(row.lifetime_decisions ?? 0),
    Number(row.lifetime_evaluable_decisions ?? 0),
    Number(row.lifetime_unavailable_decisions ?? 0),
    Number(row.lifetime_matched ?? 0),
    Number(row.decision_dates ?? 0),
    Number(row.lifetime_reward_samples ?? 0),
    Number(row.lifetime_reward_hits ?? 0),
    Number(row.lifetime_reward_sum ?? 0),
    Number(row.reward_dates ?? 0),
    row.latest_decision_date ?? null,
    row.latest_reward_date ?? null,
    nowIso,
  ))
  for (let i = 0; i < statements.length; i += STRATEGY_LEARNING_D1_BATCH_SIZE) {
    await db.batch(statements.slice(i, i + STRATEGY_LEARNING_D1_BATCH_SIZE))
  }
  return rows.length
}

export async function listStrategyRewardSourceRows(
  db: D1Database,
  options: { startDate?: string; endDate?: string; limit?: number } = {},
): Promise<StrategyRewardSourceRow[]> {
  const pageSize = Math.max(1, Math.min(options.limit ?? 1000, 5000))
  const rows: StrategyRewardSourceRow[] = []
  let cursorDate = ''
  let cursorStrategyId = ''
  let cursorSymbol = ''
  let cursorStrategyVersion = ''
  for (;;) {
    const clauses = [
      'm.strategy_hit = 1',
      "l.label_schema_version = 'canonical-strategy-selection-label-v4'",
      "EXISTS (SELECT 1 FROM canonical_run_heads h WHERE h.logical_run_key = 'screener:' || m.signal_date || ':TW:production:market_screener' AND h.run_id = m.producer_run_id)",
      `(
        m.signal_date > ?
        OR (m.signal_date = ? AND m.strategy_id > ?)
        OR (m.signal_date = ? AND m.strategy_id = ? AND m.symbol > ?)
        OR (m.signal_date = ? AND m.strategy_id = ? AND m.symbol = ? AND m.strategy_version > ?)
      )`,
    ]
    const binds: unknown[] = [
      cursorDate,
      cursorDate, cursorStrategyId,
      cursorDate, cursorStrategyId, cursorSymbol,
      cursorDate, cursorStrategyId, cursorSymbol, cursorStrategyVersion,
    ]
    if (options.startDate) { clauses.push('m.signal_date >= ?'); binds.push(options.startDate) }
    if (options.endDate) { clauses.push('m.signal_date <= ?'); binds.push(options.endDate) }
    binds.push(pageSize)
    const page = await db.prepare(`
      SELECT m.signal_date date,
             m.symbol,
             m.strategy_id,
             m.strategy_version,
             m.strategy_status,
             m.alpha_bucket,
             r.market_segment,
             NULL alpha_context,
             l.absolute_return_net,
             l.residual_return_net,
             l.cross_section_rank,
             l.benchmark_scope
        FROM strategy_label_matrix_v4 m
        JOIN selection_reference_snapshots_v1 r
          ON r.signal_date = m.signal_date
         AND r.symbol = m.symbol
         AND r.producer_run_id = m.producer_run_id
        JOIN canonical_selection_labels_v4 l
          ON l.signal_date = m.signal_date
         AND l.symbol = m.symbol
         AND l.producer_run_id = m.producer_run_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY m.signal_date, m.strategy_id, m.symbol, m.strategy_version
       LIMIT ?
    `).bind(...binds).all<StrategyRewardSourceRow>()
    const pageRows = page.results ?? []
    rows.push(...pageRows)
    if (pageRows.length < pageSize) break
    const last = pageRows.at(-1)!
    cursorDate = last.date
    cursorStrategyId = last.strategy_id
    cursorSymbol = last.symbol
    cursorStrategyVersion = last.strategy_version
  }
  return rows
}

export async function persistStrategyRewardLedgerRows(
  db: D1Database,
  rows: StrategyRewardLedgerRow[],
  refreshRunId: string | null = null,
): Promise<number> {
  await ensureStrategyLearningTables(db)
  if (rows.length === 0) return 0
  const statements = rows.map((row) => db.prepare(`
    INSERT INTO strategy_reward_ledger (
      reward_id, strategy_id, strategy_version, strategy_status, alpha_bucket,
      date_start, date_end, horizon_days, samples, hit_rate, avg_return_pct,
      reward_sum, max_drawdown_pct, coverage, market_segment, regime,
      evidence_json, refresh_run_id, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      refresh_run_id=excluded.refresh_run_id,
      updated_at=excluded.updated_at
  `).bind(
    row.reward_id, row.strategy_id, row.strategy_version, row.strategy_status, row.alpha_bucket,
    row.date_start, row.date_end, row.horizon_days, row.samples, row.hit_rate,
    row.avg_return_pct, row.reward_sum, row.max_drawdown_pct, row.coverage,
    row.market_segment, row.regime, row.evidence_json, refreshRunId, row.updated_at,
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
  options: {
    date: string
    afterSymbol?: string
    limit?: number
    dryRun?: boolean
    artifactEnv?: Pick<Bindings, 'DB' | 'ARTIFACTS'>
    producerRunId?: string
  },
): Promise<{
  success: boolean
  mode: 'dry_run' | 'persisted'
  date: string
  spec_source: 'registry'
  cursor_symbol: string
  limit: number
  strategy_count: number
  candidate_count: number
  decision_rows: number
  persisted_rows: number
  has_more: boolean
  next_cursor_symbol: string
  preview: StrategyDecisionLogRow[]
}> {
  const afterSymbol = cleanToken(options.afterSymbol)
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 80), 250))
  const { specs, source } = await listStrategySpecsForLearning(db)
  const candidatePage = await listStrategyLearningCandidates(db, options.date, limit + 1, afterSymbol)
  const hasMore = candidatePage.length > limit
  const candidates = candidatePage.slice(0, limit)
  const nextCursorSymbol = cleanToken(candidates[candidates.length - 1]?.symbol) || afterSymbol
  const rows = buildStrategyDecisionRows(options.date, candidates, specs)
  const dryRun = options.dryRun !== false
  const persisted = dryRun ? 0 : await persistStrategyDecisionRows(db, rows, options.artifactEnv, options.producerRunId)
  return {
    success: true,
    mode: dryRun ? 'dry_run' : 'persisted',
    date: options.date,
    spec_source: source,
    cursor_symbol: afterSymbol,
    limit,
    strategy_count: specs.length,
    candidate_count: candidates.length,
    decision_rows: rows.length,
    persisted_rows: persisted,
    has_more: hasMore,
    next_cursor_symbol: nextCursorSymbol,
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
  daily_decision_rows: number
  daily_reward_rows: number
  head_rows: number
  stale_rows_retired: number
  stale_daily_rewards_cleared: number
  refresh_run_id: string | null
}> {
  await ensureStrategyLearningTables(db)
  const dryRun = options.dryRun !== false
  const sourceRows = await listStrategyRewardSourceRows(db, options)
  const ledgerRows = buildStrategyRewardLedgerRows(sourceRows)
  const refreshRunId = dryRun
    ? null
    : `strategy-reward-v4-${options.endDate ?? 'latest'}-${Date.now().toString(36)}`
  const dailyProjectionStart = options.startDate
    ?? (options.endDate ? isoDateMinusCalendarDays(options.endDate, STRATEGY_DAILY_RECONCILIATION_CALENDAR_DAYS) : null)
  const dailyStatsRows = buildStrategyRewardDailyStatsRows(sourceRows, { refreshRunId })
    .filter((row) => dailyProjectionStart == null || row.date >= dailyProjectionStart)
  const dailyDecisionRows = !dryRun && options.endDate
    ? await materializeStrategyDecisionDailyStats(db, options.endDate)
    : 0
  const persisted = dryRun ? 0 : await persistStrategyRewardLedgerRows(db, ledgerRows, refreshRunId)
  const dailyRewardRows = dryRun ? 0 : await persistStrategyRewardDailyStatsRows(db, dailyStatsRows)
  let staleRowsRetired = 0
  let staleDailyRewardsCleared = 0
  const fullLedgerRefreshComplete = shouldRetireStaleStrategyRewardRows({
    dryRun,
    hasStartDate: Boolean(options.startDate),
    refreshRunId,
    ledgerRows: ledgerRows.length,
    persistedRows: persisted,
  })
  if (fullLedgerRefreshComplete) {
    const retired = await db.prepare(`
      DELETE FROM strategy_reward_ledger
       WHERE (refresh_run_id IS NULL OR refresh_run_id <> ?)
         AND (? IS NULL OR date_end IS NULL OR date(date_end) <= date(?))
    `).bind(refreshRunId, options.endDate ?? null, options.endDate ?? null).run()
    staleRowsRetired = Number(retired.meta?.changes ?? 0)
  }
  const dailyRefreshComplete = !dryRun
    && dailyStatsRows.length > 0
    && dailyRewardRows === dailyStatsRows.length
  if (dailyRefreshComplete) {
    const cleared = await db.prepare(`
      UPDATE strategy_learning_daily_stats
         SET reward_samples=0,
             reward_hits=0,
             reward_sum=0,
             date_portfolio_return=NULL,
             reward_refresh_run_id=?,
             updated_at=CURRENT_TIMESTAMP
       WHERE (reward_refresh_run_id IS NULL OR reward_refresh_run_id <> ?)
         AND reward_samples > 0
         AND (? IS NULL OR date(date) >= date(?))
         AND (? IS NULL OR date(date) <= date(?))
    `).bind(
      refreshRunId,
      refreshRunId,
      dailyProjectionStart,
      dailyProjectionStart,
      options.endDate ?? null,
      options.endDate ?? null,
    ).run()
    staleDailyRewardsCleared = Number(cleared.meta?.changes ?? 0)
  }  const headRows = dryRun ? 0 : await refreshStrategyLearningHeads(db)
  return {
    success: true,
    mode: dryRun ? 'dry_run' : 'persisted',
    source_rows: sourceRows.length,
    ledger_rows: ledgerRows,
    persisted_rows: persisted,
    daily_decision_rows: dailyDecisionRows,
    daily_reward_rows: dailyRewardRows,
    head_rows: headRows,
    stale_rows_retired: staleRowsRetired,
    stale_daily_rewards_cleared: staleDailyRewardsCleared,
    refresh_run_id: refreshRunId,
  }
}
export function shouldRetireStaleStrategyRewardRows(input: {
  dryRun: boolean
  hasStartDate: boolean
  refreshRunId: string | null
  ledgerRows: number
  persistedRows: number
}): boolean {
  return !input.dryRun
    && !input.hasStartDate
    && Boolean(input.refreshRunId)
    && input.ledgerRows > 0
    && input.persistedRows === input.ledgerRows
}

function gateEvidenceFromSpec(spec: StrategyLearningSummary['specs'][number]): StrategyPromotionGateRow['evidence'] {
  return {
    decisions: spec.learning.rolling_evaluable_decisions,
    total_decisions: spec.learning.rolling_decisions,
    evaluable_decisions: spec.learning.rolling_evaluable_decisions,
    unavailable_decisions: spec.learning.rolling_unavailable_decisions,
    matched: spec.learning.rolling_matched,
    match_rate: spec.learning.rolling_match_rate,
    samples: spec.learning.rolling_samples,
    hit_rate: spec.learning.rolling_hit_rate,
    avg_return_pct: spec.learning.rolling_avg_return_pct,
    max_drawdown_pct: spec.learning.rolling_max_drawdown_pct,
    mature_dates: spec.learning.rolling_reward_dates,
    date_return_lcb90: spec.learning.rolling_date_return_lcb90,
    lifetime_decisions: spec.learning.decisions,
  }
}

export function evaluateStrategyPromotionGate(summary: StrategyLearningSummary): StrategyPromotionGateRow[] {
  return summary.specs.map((spec) => {
    const evidence = gateEvidenceFromSpec(spec)
    const missing: string[] = []
    if (spec.status === 'research') missing.push('status_must_enter_shadow_before_promotion')
    if (spec.learning.reward_owner === 's12_execution_replay_v3_net') {
      missing.push('production_owned_by_s12_calibration_not_selection_replacement')
    }
    if (evidence.decisions < PROMOTION_MIN_DECISIONS) missing.push(`decisions_lt_${PROMOTION_MIN_DECISIONS}`)
    if (evidence.match_rate == null || evidence.match_rate < PROMOTION_MIN_MATCH_RATE) missing.push(`match_rate_lt_${PROMOTION_MIN_MATCH_RATE}`)
    if (evidence.samples < PROMOTION_MIN_SAMPLES) missing.push(`samples_lt_${PROMOTION_MIN_SAMPLES}`)
    if (evidence.hit_rate == null || evidence.hit_rate < PROMOTION_MIN_HIT_RATE) missing.push(`hit_rate_lt_${PROMOTION_MIN_HIT_RATE}`)
    if (evidence.avg_return_pct == null || evidence.avg_return_pct <= PROMOTION_MIN_AVG_RETURN) missing.push('avg_return_not_positive')
    if (evidence.max_drawdown_pct != null && evidence.max_drawdown_pct < PROMOTION_MIN_MAX_DRAWDOWN) {
      missing.push(`max_drawdown_lt_${PROMOTION_MIN_MAX_DRAWDOWN}`)
    }
    if (evidence.mature_dates < PROMOTION_MIN_MATURE_DATES) {
      missing.push(`mature_dates_lt_${PROMOTION_MIN_MATURE_DATES}`)
    }
    if (evidence.date_return_lcb90 == null || evidence.date_return_lcb90 <= PROMOTION_MIN_DATE_RETURN_LCB90) {
      missing.push('date_return_lcb90_not_positive')
    }

    const activeMonitor = spec.status === 'active'
    const activeEvidenceReady = evidence.samples >= ACTIVE_COOLDOWN_MIN_SAMPLES
      && evidence.mature_dates >= PROMOTION_MIN_MATURE_DATES
    const activeCooldownReasons = activeMonitor && activeEvidenceReady
      ? [
        evidence.hit_rate != null && evidence.hit_rate < ACTIVE_COOLDOWN_HIT_RATE ? `active_hit_rate_lt_${ACTIVE_COOLDOWN_HIT_RATE}` : null,
        evidence.avg_return_pct != null && evidence.avg_return_pct <= 0 ? 'active_avg_return_not_positive' : null,
        evidence.max_drawdown_pct != null && evidence.max_drawdown_pct < PROMOTION_MIN_MAX_DRAWDOWN ? `active_max_drawdown_lt_${PROMOTION_MIN_MAX_DRAWDOWN}` : null,
        evidence.date_return_lcb90 != null && evidence.date_return_lcb90 <= PROMOTION_MIN_DATE_RETURN_LCB90 ? 'active_date_return_lcb90_not_positive' : null,
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
      requires_wei_approval: false,
      l3_requires_wei_approval: false,
      production_effect: false,
      missing_evidence: activeCooldown ? activeCooldownReasons : activeMonitor ? [] : missing,
      evidence,
    }
  })
}

function strategyPolicyScore(spec: StrategyLearningSummary['specs'][number], gate: StrategyPromotionGateRow): number {
  if (gate.decision === 'active_cooldown') return 0
  if (spec.learning.rolling_reward_dates < PROMOTION_MIN_MATURE_DATES) return 0
  if (spec.learning.rolling_date_return_lcb90 == null || spec.learning.rolling_date_return_lcb90 <= 0) return 0
  const samples = Math.max(0, spec.learning.rolling_samples)
  const hitRate = spec.learning.rolling_hit_rate
  const avgReturn = spec.learning.rolling_avg_return_pct
  const maxDrawdown = spec.learning.rolling_max_drawdown_pct
  if (samples <= 0 || hitRate == null || avgReturn == null) return 0
  const sampleConfidence = Math.min(samples / 100, 1) * 0.2
  const hitLift = Math.max(hitRate - 0.5, 0) * 1.5
  const returnLift = Math.max(avgReturn, 0) * 4
  const drawdownPenalty = maxDrawdown != null && maxDrawdown < PROMOTION_MIN_MAX_DRAWDOWN
    ? Math.abs(maxDrawdown) * 2
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
    const rewardHealthy = row.spec.learning.rolling_reward_dates >= PROMOTION_MIN_MATURE_DATES
      && row.spec.learning.rolling_date_return_lcb90 != null
      && row.spec.learning.rolling_date_return_lcb90 > 0
      && row.spec.learning.rolling_avg_return_pct != null
      && row.spec.learning.rolling_avg_return_pct > 0
      && row.spec.learning.rolling_hit_rate != null
      && row.spec.learning.rolling_hit_rate >= 0.58
    const drawdownWeak = row.spec.learning.rolling_max_drawdown_pct != null
      && row.spec.learning.rolling_max_drawdown_pct < PROMOTION_MIN_MAX_DRAWDOWN
    thresholdDeltas[row.spec.id] = rewardHealthy
      ? {
        minVolumeExpansion20: -0.05,
        minCloseAboveMa20Pct: -0.005,
        minBrokerCount: row.spec.learning.rolling_hit_rate != null && row.spec.learning.rolling_hit_rate >= 0.6 ? -1 : 0,
      }
      : drawdownWeak || row.spec.learning.rolling_avg_return_pct == null || row.spec.learning.rolling_avg_return_pct <= 0
        ? { minVolumeExpansion20: 0.08, minCloseAboveMa20Pct: 0.01, minRevenueGrowthYoY: 1 }
        : { minVolumeExpansion20: 0 }
  }
  for (const gate of gates.filter((row) => row.decision === 'active_cooldown')) {
    strategyWeights[gate.strategy_id] = 0
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

export async function runStrategyThresholdAutoCalibration(
  db: D1Database,
  options: Partial<StrategyThresholdAutoCalibrationOptions> & {
    runDate: string
    cadence?: StrategyThresholdCalibrationCadence
    dryRun?: boolean
  },
): Promise<StrategyThresholdAutoCalibrationResult> {
  await ensureStrategyLearningTables(db)
  const cadence = options.cadence ?? 'weekly'
  const window = defaultStrategyThresholdCalibrationWindow({
    ...options,
    runDate: options.runDate,
    cadence,
  })
  const { specs } = await listStrategySpecsForLearning(db)
  const coverage = classifyStrategyThresholdCalibrationCoverage(specs)
  const evidenceRows = await listStrategyThresholdCalibrationEvidenceRows(db, {
    startDate: window.startDate,
    endDate: window.endDate,
  })
  const { guardrails, decisions } = buildStrategyThresholdAutoDecisions(specs, evidenceRows, {
    ...options,
    runDate: options.runDate,
    cadence,
    startDate: window.startDate,
    endDate: window.endDate,
  })
  const runId = `strategy-threshold-${cadence}-${options.runDate}-${Date.now().toString(36)}`
  const status: StrategyThresholdAutoCalibrationResult['status'] = decisions.length === 0
    ? 'skipped'
    : decisions.every((decision) => decision.status === 'approved')
      ? 'success'
      : 'partial'
  const baseResult = {
    runId,
    runDate: options.runDate,
    cadence,
    status,
    specsSeen: specs.filter((spec) => spec.status === 'active' || spec.status === 'candidate').length,
    eligibleSpecs: coverage.eligible.length,
    unsupportedSpecs: coverage.unsupported,
    decisions,
    guardrails,
    summary: '',
  }
  const artifactsWritten = await persistStrategyThresholdAutoCalibrationResult(db, baseResult, {
    dryRun: options.dryRun,
    validationStart: window.startDate,
    validationEnd: window.endDate,
  })
  const result: StrategyThresholdAutoCalibrationResult = {
    ...baseResult,
    mode: options.dryRun === false ? 'persisted' : 'dry_run',
    artifactsWritten,
    summary: '',
  }
  result.summary = summarizeStrategyThresholdCalibrationResult(result)
  return result
}

interface S12ExecutionDateMetric {
  date: string
  outcome_known_date: string | null
  samples: number
  hits: number
  reward_sum: number
  date_return: number
}

interface S12ExecutionLearningMetrics {
  lifetimeSamples: number
  lifetimeHits: number
  lifetimeRewardSum: number
  lifetimeMdd: number | null
  rollingSamples: number
  rollingHits: number
  rollingRewardSum: number
  rollingMdd: number | null
  rollingRewardDates: number
  rollingDateReturnMean: number | null
  rollingDateReturnLcb90: number | null
  latestRewardDate: string | null
}

async function loadS12ExecutionLearningMetrics(
  db: D1Database,
  asOfDate: string,
  windowStart: string | null,
): Promise<S12ExecutionLearningMetrics> {
  const rows = (await db.prepare(`
    SELECT o.signal_date AS date,
           MAX(date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date'))) AS outcome_known_date,
           COUNT(*) AS samples,
           SUM(CASE WHEN CAST(o.pnl_pct AS REAL) - (? / 10000.0) > 0 THEN 1 ELSE 0 END) AS hits,
           SUM(CAST(o.pnl_pct AS REAL) - (? / 10000.0)) AS reward_sum,
           AVG(CAST(o.pnl_pct AS REAL) - (? / 10000.0)) AS date_return
      FROM s12_replay_trade_outcomes o
     WHERE o.signal_date IS NOT NULL
       AND date(o.signal_date) <= date(?)
       AND o.sample_eligible=1
       AND o.source='s12_multisession_structure_replay_v3'
       AND o.pnl_pct IS NOT NULL
       AND json_extract(o.detail_json, '$.schema_version')='s12-replay-trade-outcome-v3'
       AND json_extract(o.detail_json, '$.observation_kind')='executed'
       AND json_extract(o.detail_json, '$.replay_diagnostics.replay_engine_signature')=?
       AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) IS NOT NULL
       AND date(json_extract(o.detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
     GROUP BY o.signal_date
     ORDER BY o.signal_date
  `).bind(
    CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,
    CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,
    CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,
    asOfDate,
    S12_REPLAY_ENGINE_SIGNATURE,
    asOfDate,
  ).all<S12ExecutionDateMetric>()).results ?? []
  const normalized = rows.map((row) => ({
    date: cleanToken(row.date),
    outcomeKnownDate: cleanToken(row.outcome_known_date) || null,
    samples: Number(row.samples ?? 0),
    hits: Number(row.hits ?? 0),
    rewardSum: Number(row.reward_sum ?? 0),
    dateReturn: Number(row.date_return ?? 0),
  })).filter((row) => row.date && row.samples > 0 && Number.isFinite(row.dateReturn))
  const rolling = windowStart ? normalized.filter((row) => row.date >= windowStart) : normalized
  const lifetimeReturns = normalized.map((row) => row.dateReturn)
  const rollingReturns = rolling.map((row) => row.dateReturn)
  const rollingStats = summarizeDateClusteredReturns(rollingReturns)
  return {
    lifetimeSamples: normalized.reduce((sum, row) => sum + row.samples, 0),
    lifetimeHits: normalized.reduce((sum, row) => sum + row.hits, 0),
    lifetimeRewardSum: normalized.reduce((sum, row) => sum + row.rewardSum, 0),
    lifetimeMdd: maxDrawdownFromDateReturns(lifetimeReturns),
    rollingSamples: rolling.reduce((sum, row) => sum + row.samples, 0),
    rollingHits: rolling.reduce((sum, row) => sum + row.hits, 0),
    rollingRewardSum: rolling.reduce((sum, row) => sum + row.rewardSum, 0),
    rollingMdd: maxDrawdownFromDateReturns(rollingReturns),
    rollingRewardDates: rolling.length,
    rollingDateReturnMean: rollingStats.mean,
    rollingDateReturnLcb90: rollingStats.lcb90,
    latestRewardDate: normalized.map((row) => row.outcomeKnownDate).filter((value): value is string => Boolean(value)).at(-1) ?? null,
  }
}

export async function buildStrategyLearningSummary(
  db: D1Database,
  date: string,
): Promise<StrategyLearningSummary> {
  const { specs, source } = await listStrategySpecsForLearning(db)
  const projectionHead = await db.prepare(`
    SELECT MAX(latest_date) AS latest_date
      FROM (
        SELECT latest_decision_date AS latest_date FROM strategy_learning_head
        UNION ALL
        SELECT latest_reward_date AS latest_date FROM strategy_learning_head
      )
  `).first<{ latest_date: string | null }>()
  const canUseLatestHead = projectionHead?.latest_date == null || projectionHead.latest_date <= date
  const headRows = canUseLatestHead
    ? (await db.prepare(`
        SELECT strategy_id,
               strategy_version,
               lifetime_decisions,
               lifetime_evaluable_decisions,
               lifetime_unavailable_decisions,
               lifetime_matched,
               decision_dates,
               lifetime_reward_samples,
               lifetime_reward_hits,
               lifetime_reward_sum,
               reward_dates,
               latest_decision_date,
               latest_reward_date
          FROM strategy_learning_head
      `).all<StrategyLearningHeadRow>()).results ?? []
    : (await db.prepare(`
        SELECT strategy_id,
               strategy_version,
               SUM(decisions) AS lifetime_decisions,
               SUM(evaluable_decisions) AS lifetime_evaluable_decisions,
               SUM(unavailable_decisions) AS lifetime_unavailable_decisions,
               SUM(matched) AS lifetime_matched,
               COUNT(DISTINCT CASE WHEN decisions > 0 THEN date END) AS decision_dates,
               SUM(reward_samples) AS lifetime_reward_samples,
               SUM(reward_hits) AS lifetime_reward_hits,
               SUM(reward_sum) AS lifetime_reward_sum,
               COUNT(DISTINCT CASE WHEN reward_samples > 0 THEN date END) AS reward_dates,
               MAX(CASE WHEN decisions > 0 THEN date END) AS latest_decision_date,
               MAX(CASE WHEN reward_samples > 0 THEN date END) AS latest_reward_date
          FROM strategy_learning_daily_stats
         WHERE date <= ?
         GROUP BY strategy_id, strategy_version
      `).bind(date).all<StrategyLearningHeadRow>()).results ?? []
  const headBySpec = new Map(
    headRows.map((row) => [row.strategy_id + '|' + row.strategy_version, row]),
  )

  const lifetimeMddRows = canUseLatestHead
    ? (await db.prepare(`
        SELECT strategy_id,
               strategy_version,
               MIN(max_drawdown_pct) AS max_drawdown_pct
          FROM strategy_reward_ledger
         GROUP BY strategy_id, strategy_version
      `).all<{
        strategy_id: string
        strategy_version: string
        max_drawdown_pct: number | null
      }>()).results ?? []
    : []
  const lifetimeMddBySpec = new Map(
    (lifetimeMddRows ?? []).map((row) => [
      row.strategy_id + '|' + row.strategy_version,
      row.max_drawdown_pct == null ? null : Number(row.max_drawdown_pct),
    ]),
  )

  const { results: windowDateRows } = await db.prepare(`
    SELECT DISTINCT date
      FROM strategy_learning_daily_stats
     WHERE date <= ?
     ORDER BY date DESC
     LIMIT ?
  `).bind(date, STRATEGY_LEARNING_ROLLING_SESSIONS).all<{ date: string }>()
  const windowDates = (windowDateRows ?? []).map((row) => row.date)
  const windowStart = windowDates.at(-1) ?? null
  const dailyRows = windowStart
    ? (await db.prepare(`
        SELECT date,
               strategy_id,
               strategy_version,
               decisions,
               evaluable_decisions,
               unavailable_decisions,
               matched,
               reward_samples,
               reward_hits,
               reward_sum,
               date_portfolio_return,
               reward_refresh_run_id,
               updated_at
          FROM strategy_learning_daily_stats
         WHERE date >= ?
           AND date <= ?
         ORDER BY date, strategy_id, strategy_version
      `).bind(windowStart, date).all<StrategyLearningDailyStatsRow>()).results ?? []
    : []
  const s12ExecutionMetrics = await loadS12ExecutionLearningMetrics(db, date, windowStart)
  const dailyBySpec = new Map<string, StrategyLearningDailyStatsRow[]>()
  for (const row of dailyRows) {
    const key = row.strategy_id + '|' + row.strategy_version
    dailyBySpec.set(key, [...(dailyBySpec.get(key) ?? []), row])
  }

  const summary = {
    version: STRATEGY_LEARNING_VERSION,
    date,
    spec_source: source,
    specs: specs.map((spec) => {
      const key = spec.id + '|' + spec.version
      const head = headBySpec.get(key)
      const rollingRows = dailyBySpec.get(key) ?? []
      const todayRow = rollingRows.find((row) => row.date === date)
      const lifetimeDecisions = Number(head?.lifetime_decisions ?? 0)
      const lifetimeEvaluable = Number(head?.lifetime_evaluable_decisions ?? 0)
      const lifetimeUnavailable = Number(head?.lifetime_unavailable_decisions ?? 0)
      const lifetimeMatched = Number(head?.lifetime_matched ?? 0)
      const usesS12ExecutionReward = spec.id === 'stock_tech_s12_multitimeframe_smc_reclaim_v2'
      const lifetimeSamples = usesS12ExecutionReward ? s12ExecutionMetrics.lifetimeSamples : Number(head?.lifetime_reward_samples ?? 0)
      const lifetimeHits = usesS12ExecutionReward ? s12ExecutionMetrics.lifetimeHits : Number(head?.lifetime_reward_hits ?? 0)
      const lifetimeRewardSum = usesS12ExecutionReward ? s12ExecutionMetrics.lifetimeRewardSum : Number(head?.lifetime_reward_sum ?? 0)
      const rollingDecisions = rollingRows.reduce((sum, row) => sum + Number(row.decisions ?? 0), 0)
      const rollingEvaluable = rollingRows.reduce((sum, row) => sum + Number(row.evaluable_decisions ?? 0), 0)
      const rollingUnavailable = rollingRows.reduce((sum, row) => sum + Number(row.unavailable_decisions ?? 0), 0)
      const rollingMatched = rollingRows.reduce((sum, row) => sum + Number(row.matched ?? 0), 0)
      const rewardRows = rollingRows.filter((row) => Number(row.reward_samples ?? 0) > 0)
      const selectionRollingSamples = rewardRows.reduce((sum, row) => sum + Number(row.reward_samples ?? 0), 0)
      const selectionRollingHits = rewardRows.reduce((sum, row) => sum + Number(row.reward_hits ?? 0), 0)
      const selectionRollingRewardSum = rewardRows.reduce((sum, row) => sum + Number(row.reward_sum ?? 0), 0)
      const selectionDateReturns = rewardRows
        .map((row) => finiteNumber(row.date_portfolio_return))
        .filter((value): value is number => value != null)
      const selectionDateReturnStats = summarizeDateClusteredReturns(selectionDateReturns)
      const rollingSamples = usesS12ExecutionReward ? s12ExecutionMetrics.rollingSamples : selectionRollingSamples
      const rollingHits = usesS12ExecutionReward ? s12ExecutionMetrics.rollingHits : selectionRollingHits
      const rollingRewardSum = usesS12ExecutionReward ? s12ExecutionMetrics.rollingRewardSum : selectionRollingRewardSum
      return {
        ...spec,
        learning: {
          evidence_available: true,
          reward_owner: usesS12ExecutionReward ? 's12_execution_replay_v3_net' : 'selection_edge_v4',
          decisions: lifetimeDecisions,
          evaluable_decisions: lifetimeEvaluable,
          unavailable_decisions: lifetimeUnavailable,
          matched: lifetimeMatched,
          match_rate: lifetimeEvaluable > 0 ? round6(lifetimeMatched / lifetimeEvaluable) : null,
          today_decisions: Number(todayRow?.decisions ?? 0),
          today_evaluable_decisions: Number(todayRow?.evaluable_decisions ?? 0),
          today_unavailable_decisions: Number(todayRow?.unavailable_decisions ?? 0),
          today_matched: Number(todayRow?.matched ?? 0),
          rolling_decisions: rollingDecisions,
          rolling_evaluable_decisions: rollingEvaluable,
          rolling_unavailable_decisions: rollingUnavailable,
          rolling_matched: rollingMatched,
          rolling_match_rate: rollingEvaluable > 0 ? round6(rollingMatched / rollingEvaluable) : null,
          rolling_sessions: rollingRows.filter((row) => Number(row.decisions ?? 0) > 0).length,
          samples: lifetimeSamples,
          hit_rate: lifetimeSamples > 0 ? round6(lifetimeHits / lifetimeSamples) : null,
          avg_return_pct: lifetimeSamples > 0 ? round6(lifetimeRewardSum / lifetimeSamples) : null,
          max_drawdown_pct: usesS12ExecutionReward ? s12ExecutionMetrics.lifetimeMdd : (lifetimeMddBySpec.get(key) ?? null),
          rolling_samples: rollingSamples,
          rolling_hit_rate: rollingSamples > 0 ? round6(rollingHits / rollingSamples) : null,
          rolling_avg_return_pct: rollingSamples > 0 ? round6(rollingRewardSum / rollingSamples) : null,
          rolling_max_drawdown_pct: usesS12ExecutionReward ? s12ExecutionMetrics.rollingMdd : maxDrawdownFromDateReturns(selectionDateReturns),
          rolling_reward_dates: usesS12ExecutionReward ? s12ExecutionMetrics.rollingRewardDates : rewardRows.length,
          rolling_date_return_mean: usesS12ExecutionReward ? s12ExecutionMetrics.rollingDateReturnMean : selectionDateReturnStats.mean,
          rolling_date_return_lcb90: usesS12ExecutionReward ? s12ExecutionMetrics.rollingDateReturnLcb90 : selectionDateReturnStats.lcb90,
          latest_decision_date: head?.latest_decision_date ?? null,
          latest_reward_date: usesS12ExecutionReward ? s12ExecutionMetrics.latestRewardDate : (head?.latest_reward_date ?? null),
          status: lifetimeSamples > 0
            ? 'learning'
            : lifetimeEvaluable > 0
              ? 'no_reward'
              : lifetimeUnavailable > 0
                ? 'unavailable'
                : 'no_decisions',
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
interface HistoricalStrategyDecisionRowV5 {
  date: string
  symbol: string
  name: string | null
  strategy_id: string
  strategy_version: string
  strategy_status: StrategySpecStatus
  alpha_bucket: string
}

interface HistoricalStrategyContextRowV5 {
  symbol: string
  context_json: string
  context_raw_signals_json: string | null
  context_current_price: number | string | null
  context_industry: string | null
}

export async function rebuildHistoricalStrategyEvidenceV5(
  db: D1Database,
  options: { asOfDate: string; maxDates?: number },
): Promise<{ attemptedDates: number; successfulDates: number; blockedDates: number; rebuiltDecisions: number; rebuiltMatrixRows: number }> {
  await ensureStrategyLearningTables(db)
  const maxDates = Math.max(1, Math.min(5, Math.floor(options.maxDates ?? 2)))
  const dateRows = await db.prepare(`
    SELECT d.date
      FROM strategy_decision_log d
      LEFT JOIN strategy_evidence_rebuild_runs_v5 r ON r.signal_date=d.date
     WHERE d.date<=?
       AND (r.signal_date IS NULL OR r.status NOT IN ('success','blocked'))
     GROUP BY d.date
     ORDER BY d.date DESC
     LIMIT ?
  `).bind(options.asOfDate, maxDates).all<{ date: string }>()
  const registryRows = await db.prepare(`
    SELECT strategy_id, version, name, status, owner, alpha_bucket,
           family_id, variant_id, owner_type, promotion_status,
           supported_regimes_json, thesis, thresholds_json, candidate_policy_json,
           risk_notes_json, source_refs_json, created_by, created_at, updated_at
      FROM strategy_spec_registry
  `).all<StrategySpecRegistryRow>()
  const specByKey = new Map((registryRows.results ?? []).map((row) => [
    row.strategy_id + '|' + row.version,
    registryRowToStrategySpec(row),
  ]))
  const governanceByKey = new Map((registryRows.results ?? []).map((row) => [
    row.strategy_id + '|' + row.version,
    row,
  ]))
  const { persistSelectionEvidenceV4 } = await import('./selectionReferenceEvidence')
  let successfulDates = 0
  let blockedDates = 0
  let rebuiltDecisions = 0
  let rebuiltMatrixRows = 0

  for (const { date } of dateRows.results ?? []) {
    await db.prepare(`
      INSERT INTO strategy_evidence_rebuild_runs_v5(signal_date, status, updated_at)
      VALUES (?, 'pending', CURRENT_TIMESTAMP)
      ON CONFLICT(signal_date) DO UPDATE SET status='pending', blocker_reason=NULL, updated_at=CURRENT_TIMESTAMP
    `).bind(date).run()
    try {
      const referencesResult = await db.prepare(`
        SELECT r.signal_date, r.symbol, r.producer_run_id, r.name, r.market_segment, r.sector,
               r.strategy_selected, r.selection_stage, r.rejection_reason, r.score_v2,
               r.score_components, r.feature_available, r.feature_rejection_reason,
               r.strategy_labeler_version, r.strategy_router_version,
               r.strategy_registry_checksum, r.evidence_artifact_id
          FROM selection_reference_snapshots_v1 r
         WHERE r.signal_date=?
           AND r.hard_gate_passed=1
           AND EXISTS (
             SELECT 1 FROM canonical_run_heads h
              WHERE h.logical_run_key='screener:' || r.signal_date || ':TW:production:market_screener'
                AND h.run_id=r.producer_run_id
           )
         ORDER BY r.symbol
      `).bind(date).all<any>()
      const referenceRows = referencesResult.results ?? []
      const producerRunIds = new Set(referenceRows.map((row) => cleanToken(row.producer_run_id)))
      const checksums = new Set(referenceRows.map((row) => cleanToken(row.strategy_registry_checksum)).filter(Boolean))
      const artifactIds = new Set(referenceRows.map((row) => cleanToken(row.evidence_artifact_id)).filter(Boolean))
      if (!referenceRows.length || producerRunIds.size !== 1 || checksums.size !== 1 || artifactIds.size !== 1) {
        throw new Error('reference_lineage_incomplete')
      }
      const references = [...new Map(referenceRows.map((row) => [cleanToken(row.symbol), row])).values()]
      const producerRunId = [...producerRunIds][0]
      const decisionResult = await db.prepare(`
        SELECT d.date, d.symbol, d.name, d.strategy_id, d.strategy_version,
               d.strategy_status, d.alpha_bucket
          FROM strategy_decision_log d
         WHERE d.date=?
           AND EXISTS (
             SELECT 1 FROM selection_reference_snapshots_v1 r
              WHERE r.signal_date=d.date AND r.symbol=d.symbol
                AND r.producer_run_id=?
           )
         ORDER BY d.symbol, d.strategy_id, d.strategy_version
      `).bind(date, producerRunId).all<HistoricalStrategyDecisionRowV5>()
      const decisions = decisionResult.results ?? []
      const referenceSymbols = new Set(references.map((row) => cleanToken(row.symbol)))
      const strategyKeys = new Set(decisions.map((row) => row.strategy_id + '|' + row.strategy_version))
      const expectedCells = referenceSymbols.size * strategyKeys.size
      if (!strategyKeys.size || decisions.length !== expectedCells) {
        throw new Error(`decision_grid_incomplete:${decisions.length}/${expectedCells}`)
      }
      const contextResult = await db.prepare(`
        SELECT d.symbol, d.context_json,
               c.raw_signals_json AS context_raw_signals_json,
               c.current_price AS context_current_price,
               c.industry AS context_industry
          FROM strategy_decision_log d
          LEFT JOIN strategy_candidate_contexts c ON c.context_id=d.context_id
         WHERE d.date=?
           AND EXISTS (
             SELECT 1 FROM selection_reference_snapshots_v1 r
              WHERE r.signal_date=d.date AND r.symbol=d.symbol
                AND r.producer_run_id=?
           )
         GROUP BY d.symbol
      `).bind(date, producerRunId).all<HistoricalStrategyContextRowV5>()
      const contextBySymbol = new Map((contextResult.results ?? []).map((row) => [row.symbol, row]))
      const decisionUpdates: D1PreparedStatement[] = []
      let evaluableRows = 0
      let unavailableRows = 0
      const rebuilt = decisions.map((row) => {
        const key = row.strategy_id + '|' + row.strategy_version
        const spec = specByKey.get(key)
        const context = contextBySymbol.get(row.symbol)
        const fullContext = parseJson<any>(context?.context_json, {})
        const contextRaw = parseJson<Record<string, any>>(context?.context_raw_signals_json, {})
        const rawSignals = Object.keys(contextRaw).length
          ? Object.fromEntries(Object.entries(contextRaw).filter(([name]) => name !== 'score_v2'))
          : fullContext?.candidate?.raw_signals ?? null
        const candidate: StrategyCandidateInput = {
          symbol: row.symbol,
          name: row.name ?? undefined,
          industry: firstCleanToken(context?.context_industry, fullContext?.candidate?.industry) ?? undefined,
          current_price: firstFinite(context?.context_current_price, fullContext?.candidate?.current_price),
          raw_signals: rawSignals,
          score_v2: contextRaw.score_v2 ?? fullContext?.score_v2 ?? null,
        }
        const evaluability = spec
          ? assessStrategySpecEvaluability(candidate, spec)
          : {
              evaluable: false,
              missingSignals: [],
              missingFeatureRefs: [],
              unavailableReasons: ['historical_strategy_spec_version_missing'],
              signalDiagnostics: [],
            }
        const assessment = spec && evaluability.evaluable
          ? assessCandidateAgainstStrategySpecs(candidate, [spec])
          : { matches: [], tags: [], watchPoints: [] }
        const matched = evaluability.evaluable && assessment.matches.length > 0
        const unavailableReason = evaluability.evaluable ? null : evaluability.unavailableReasons.join('|')
        if (evaluability.evaluable) evaluableRows += 1
        else unavailableRows += 1
        const evidence = {
          pit_reconstruction: {
            schema_version: 'strategy-decision-pit-reconstruction-v5',
            source: context?.context_raw_signals_json ? 'strategy_candidate_contexts' : 'strategy_decision_context',
            strategy_id: row.strategy_id,
            strategy_version: row.strategy_version,
            evaluability,
            matched,
            assessment,
            knowledge_cutoff: date,
            no_lookahead: true,
          },
        }
        decisionUpdates.push(db.prepare(`
          UPDATE strategy_decision_log
             SET evaluable=?, unavailable_reason=?, matched=?, match_score=?,
                 reason_code=?, evidence_json=json_patch(CASE WHEN json_valid(evidence_json) THEN evidence_json ELSE '{}' END, ?)
           WHERE date=? AND symbol=? AND strategy_id=? AND strategy_version=?
        `).bind(
          evaluability.evaluable ? 1 : 0,
          unavailableReason,
          matched ? 1 : 0,
          matchScore(candidate, matched),
          evaluability.evaluable ? (matched ? 'strategy_spec_matched' : 'strategy_spec_no_match') : 'strategy_spec_unavailable:' + unavailableReason,
          JSON.stringify(evidence),
          date, row.symbol, row.strategy_id, row.strategy_version,
        ))
        return { row, spec, evaluability, matched }
      })
      for (let offset = 0; offset < decisionUpdates.length; offset += STRATEGY_LEARNING_D1_BATCH_SIZE) {
        await db.batch(decisionUpdates.slice(offset, offset + STRATEGY_LEARNING_D1_BATCH_SIZE))
      }

      const existingMatrix = await db.prepare(`
        SELECT status FROM strategy_label_matrix_runs_v4 WHERE producer_run_id=?
      `).bind(producerRunId).first<{ status?: string }>()
      let matrixRows = 0
      if (existingMatrix?.status === 'ready') {
        matrixRows = Number((await db.prepare(
          'SELECT COUNT(*) AS count FROM strategy_label_matrix_v4 WHERE producer_run_id=?',
        ).bind(producerRunId).first<{ count: number }>())?.count ?? 0)
      } else {
        const labelerVersion = 'strategy-decision-log-pit-reconstruction-v5'
        const matrix = rebuilt.map(({ row, spec, evaluability, matched }) => {
          if (!spec) throw new Error('matrix_strategy_spec_version_missing:' + row.strategy_id + '|' + row.strategy_version)
          const governance = governanceByKey.get(row.strategy_id + '|' + row.strategy_version)
          return {
            signal_date: date,
            symbol: row.symbol,
            producer_run_id: producerRunId,
            strategy_id: row.strategy_id,
            strategy_version: row.strategy_version,
            strategy_status: row.strategy_status,
            alpha_bucket: row.alpha_bucket,
            family_id: cleanToken(spec.familyId) || 'UNKNOWN',
            production_owner: row.strategy_status === 'active' && governance?.owner_type === 'strategy' ? 1 : 0,
            strategy_hit: evaluability.evaluable && matched ? 1 : 0,
            weak_label: evaluability.evaluable ? (matched ? 1 : 0) : 0,
            affinity: evaluability.evaluable ? (matched ? 1 : 0) : 0,
            position_weight: 0,
            overlap: 0,
            labeler_version: labelerVersion,
            strategy_registry_checksum: [...checksums][0],
          }
        })
        const persisted = await persistSelectionEvidenceV4(db, {
          signalDate: date,
          producerRunId,
          references: references.map((row) => ({
            signal_date: date,
            symbol: cleanToken(row.symbol),
            producer_run_id: producerRunId,
            name: cleanToken(row.name) || null,
            market_segment: cleanToken(row.market_segment) || null,
            sector: cleanToken(row.sector) || null,
            strategy_selected: Number(row.strategy_selected) === 1 ? 1 : 0,
            selection_stage: cleanToken(row.selection_stage) || 'l1_labeled_observe',
            rejection_reason: cleanToken(row.rejection_reason) || null,
            score_v2: finiteNumber(row.score_v2),
            score_components: typeof row.score_components === 'string' ? row.score_components : null,
            feature_available: Number(row.feature_available) === 1 ? 1 : 0,
            feature_rejection_reason: cleanToken(row.feature_rejection_reason) || null,
            strategy_labeler_version: labelerVersion,
            strategy_router_version: cleanToken(row.strategy_router_version) || null,
            strategy_registry_checksum: [...checksums][0],
          })),
          matrix,
          strategyCount: strategyKeys.size,
          strategyRegistryChecksum: [...checksums][0],
          labelerVersion,
          evidenceArtifactId: [...artifactIds][0],
        })
        matrixRows = persisted.matrixRows
      }
      await materializeStrategyDecisionDailyStats(db, date)
      await db.prepare(`
        UPDATE strategy_evidence_rebuild_runs_v5
           SET status='success', candidate_count=?, strategy_count=?, decision_rows=?,
               evaluable_rows=?, unavailable_rows=?, matrix_rows=?,
               source_checksum=?, blocker_reason=NULL, updated_at=CURRENT_TIMESTAMP
         WHERE signal_date=?
      `).bind(
        referenceSymbols.size, strategyKeys.size, decisions.length,
        evaluableRows, unavailableRows, matrixRows, [...checksums][0], date,
      ).run()
      successfulDates += 1
      rebuiltDecisions += decisions.length
      rebuiltMatrixRows += matrixRows
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
      const status = reason.startsWith('reference_lineage_incomplete')
        || reason.startsWith('decision_grid_incomplete')
        || reason.startsWith('matrix_strategy_spec_version_missing')
        ? 'blocked'
        : 'failed'
      await db.prepare(`
        UPDATE strategy_evidence_rebuild_runs_v5
           SET status=?, blocker_reason=?, updated_at=CURRENT_TIMESTAMP
         WHERE signal_date=?
      `).bind(status, reason, date).run()
      blockedDates += 1
    }
  }
  if ((dateRows.results ?? []).length) await refreshStrategyLearningHeads(db)
  return {
    attemptedDates: (dateRows.results ?? []).length,
    successfulDates,
    blockedDates,
    rebuiltDecisions,
    rebuiltMatrixRows,
  }
}

export async function finalizeStrategyLearningEvidenceV5(
  db: D1Database,
  date: string,
  options: {
    allowPromotion?: boolean
    persistPolicy?: boolean
    calibrateThresholds?: boolean
    calibrationCadence?: StrategyThresholdCalibrationCadence
  } = {},
) {
  const { materializeCanonicalSelectionLabelsV4 } = await import('./canonicalSelectionLabels')
  const { reconcileSelectionDecisionEvidenceV4 } = await import('./selectionReferenceEvidence')
  const { refreshStrategyMarginalEdgeV4 } = await import('./strategyMarginalEdgeV4')
  const decisionEvidence = await reconcileSelectionDecisionEvidenceV4(db, date)
  const historicalEvidence = await rebuildHistoricalStrategyEvidenceV5(db, { asOfDate: date, maxDates: 2 })
  const labels = await materializeCanonicalSelectionLabelsV4(db, { asOfDate: date })
  const marginalEdge = await refreshStrategyMarginalEdgeV4(db, date, { allowPromotion: options.allowPromotion === true })
  const rewards = await refreshStrategyRewardLedger(db, { endDate: date, dryRun: false })
  const policy = options.persistPolicy === false
    ? null
    : await refreshStrategyAdaptivePolicyState(db, { date, dryRun: false })
  const thresholdCalibration = options.calibrateThresholds === false
    ? null
    : await runStrategyThresholdAutoCalibration(db, {
      runDate: date,
      cadence: options.calibrationCadence ?? 'daily_drift',
      dryRun: false,
    })
  return { decisionEvidence, historicalEvidence, labels, marginalEdge, rewards, policy, thresholdCalibration }
}

export async function runStrategyLearningClosure(
  db: D1Database,
  date: string,
  options: { allowPromotion?: boolean; persistPolicy?: boolean; calibrateThresholds?: boolean; calibrationCadence?: StrategyThresholdCalibrationCadence } = {},
): Promise<string> {
  await ensureStrategyLearningTables(db)
  const seeded = await seedDefaultStrategySpecRegistry(db)
  let decisionCursor = ''
  let decisionCandidates = 0
  let decisionRows = 0
  let decisionSpecSource: 'registry' = 'registry'
  for (;;) {
    const chunk = await materializeStrategyDecisionLogChunk(db, {
      date, afterSymbol: decisionCursor, limit: STRATEGY_LEARNING_D1_BATCH_SIZE, dryRun: false,
    })
    decisionSpecSource = chunk.spec_source
    decisionCandidates += chunk.candidate_count
    decisionRows += chunk.persisted_rows
    if (!chunk.has_more) break
    if (!chunk.next_cursor_symbol || chunk.next_cursor_symbol === decisionCursor) throw new Error('strategy_learning_pagination_stalled')
    decisionCursor = chunk.next_cursor_symbol
  }
  const { decisionEvidence, historicalEvidence, labels, marginalEdge, rewards, policy, thresholdCalibration }
    = await finalizeStrategyLearningEvidenceV5(db, date, options)
  return [
    `seeded=${seeded.seeded}`,
    `spec_source=${decisionSpecSource}`,
    `candidates=${decisionCandidates}`,
    `decision_rows=${decisionRows}`,
    `selection_decisions=${decisionEvidence.finalSignalRows}/${decisionEvidence.referenceRows}`,
    `selection_ev_owner=${decisionEvidence.evOwnerRows}`,
    `strategy_pit_rebuild=${historicalEvidence.successfulDates}/${historicalEvidence.attemptedDates}`,
    `strategy_pit_blocked=${historicalEvidence.blockedDates}`,
    `strategy_pit_matrix_rows=${historicalEvidence.rebuiltMatrixRows}`,
    `selection_labels=${labels.persisted_rows}`,
    `strategy_edge=${marginalEdge.status}:eligible=${marginalEdge.eligibleStrategies}`,
    `reward_source_rows=${rewards.source_rows}`,
    `reward_rows=${rewards.persisted_rows}`,
    `daily_decision_rows=${rewards.daily_decision_rows}`,
    `daily_reward_rows=${rewards.daily_reward_rows}`,
    `learning_head_rows=${rewards.head_rows}`,
    `reward_stale_retired=${rewards.stale_rows_retired}`,
    `daily_reward_stale_cleared=${rewards.stale_daily_rewards_cleared}`,
    `policy=${policy ? policy.policy_state.status : 'skipped_historical'}`,
    `policy_eligible=${policy ? policy.policy_state.evidence.eligible_strategy_count : 'n/a'}`,
    `threshold_calibration=${thresholdCalibration ? thresholdCalibration.status : 'skipped'}`,
    `threshold_artifacts=${thresholdCalibration ? thresholdCalibration.artifactsWritten : 0}`,
  ].join(' ')
}
