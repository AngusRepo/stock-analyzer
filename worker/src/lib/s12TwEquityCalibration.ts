import {
  DEFAULT_S12_TIMING_POLICY,
  normalizeS12TimingPolicy,
  type S12TimingPolicy,
} from './s12IntradayStructure'
import { S12_REPLAY_ENGINE_SIGNATURE } from './s12ReplayContract'
import { CANONICAL_SELECTION_ROUNDTRIP_COST_BPS } from './canonicalSelectionLabels'

export type S12TwCalibrationCadence = 'weekly' | 'monthly' | 'regime_shift'

export type S12TwEntryCohort = 'reaction_ready' | 'limited_takeover_ready' | 'legacy_mixed'

export interface S12TwCalibrationScope {
  marketSegment: string
  entryCohort: S12TwEntryCohort
  alphaBucket: string | null
  entryTimeBucket: 'opening' | 'mid_session' | 'close_window' | null
}

export interface S12TwExitCalibration {
  tp1MfeQuantile: number
  tp2MfeQuantile: number
  stopMaeQuantile: number
  minNetProfitR: number
}

export interface S12TwCalibrationArtifact {
  artifactId: string
  runId: string
  status: 'approved' | 'rejected' | 'frozen'
  cadence: S12TwCalibrationCadence
  scope: S12TwCalibrationScope
  policy: Partial<S12TimingPolicy>
  exit: S12TwExitCalibration
  validationStart: string
  validationEnd: string
  sampleCount: number
  dateCount: number
  metrics: Record<string, unknown>
  createdAt: string
  approvedAt: string | null
}

interface CalibrationEvidence {
  symbol: string
  tradeDate: string
  marketSegment: string
  entryCohort: Exclude<S12TwEntryCohort, 'legacy_mixed'>
  alphaBucket: string | null
  entryTimeBucket: S12TwCalibrationScope['entryTimeBucket']
  pnlR: number
  mfePct: number
  maePct: number
  mutationScore: number | null
  fastVwapSignals: number | null
  fastVwapBlockers: number | null
  stopRiskPct: number | null
  stopRiskAtr: number | null
  sessionMoveAtr: number | null
  sessionClosePosition: number | null
}

interface ArtifactRow {
  artifact_id: string
  run_id: string
  status: string
  cadence: string
  market_segment: string
  entry_cohort: string
  alpha_bucket: string | null
  entry_time_bucket: string | null
  policy_json: string
  exit_json: string
  validation_start: string
  validation_end: string
  sample_count: number
  date_count: number
  metrics_json: string
  created_at: string
  approved_at: string | null
}

const TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS s12_tw_calibration_runs (
    run_id TEXT PRIMARY KEY,
    run_date TEXT NOT NULL,
    cadence TEXT NOT NULL,
    status TEXT NOT NULL,
    scopes_seen INTEGER NOT NULL DEFAULT 0,
    artifacts_written INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS s12_tw_calibration_artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    cadence TEXT NOT NULL,
    market_segment TEXT NOT NULL,
    entry_cohort TEXT NOT NULL DEFAULT 'legacy_mixed',
    alpha_bucket TEXT,
    entry_time_bucket TEXT,
    policy_json TEXT NOT NULL,
    exit_json TEXT NOT NULL,
    validation_start TEXT NOT NULL,
    validation_end TEXT NOT NULL,
    sample_count INTEGER NOT NULL,
    date_count INTEGER NOT NULL,
    metrics_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_at TEXT,
    superseded_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_s12_tw_calibration_active
     ON s12_tw_calibration_artifacts(status, superseded_at, entry_cohort, market_segment, alpha_bucket, entry_time_bucket, approved_at DESC)`,
]
export const S12_TW_CALIBRATION_RETURN_BASIS = 'net_after_roundtrip_cost' as const
export const S12_TW_CALIBRATION_RETURN_UNIT = 'r_multiple' as const


function finite(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object') return value as T
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function detailValue(detail: string, key: string): string | null {
  const match = detail.match(new RegExp(`(?:^|;)${key}=([^;]*)`))
  return match?.[1]?.trim() || null
}

function countPipeValues(value: string | null): number | null {
  if (value == null) return null
  return value.split('|').map((item) => item.trim()).filter(Boolean).length
}

function timeBucket(entryMs: unknown): CalibrationEvidence['entryTimeBucket'] {
  const ms = finite(entryMs)
  if (ms == null) return null
  const tw = new Date(ms + 8 * 60 * 60_000)
  const minute = tw.getUTCHours() * 60 + tw.getUTCMinutes()
  if (minute < 10 * 60) return 'opening'
  if (minute >= 13 * 60) return 'close_window'
  return 'mid_session'
}

function quantile(values: number[], q: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const index = (sorted.length - 1) * Math.max(0, Math.min(1, q))
  const low = Math.floor(index)
  const high = Math.ceil(index)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low)
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function maxDrawdownR(rows: CalibrationEvidence[]): number {
  let equity = 0
  let peak = 0
  let maxDrawdown = 0
  for (const row of [...rows].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))) {
    equity += row.pnlR
    peak = Math.max(peak, equity)
    maxDrawdown = Math.min(maxDrawdown, equity - peak)
  }
  return maxDrawdown
}

function scopeKey(scope: S12TwCalibrationScope): string {
  return [scope.entryCohort, scope.marketSegment, scope.alphaBucket ?? '*', scope.entryTimeBucket ?? '*'].join('|')
}

function normalizeScope(value: Partial<S12TwCalibrationScope>): S12TwCalibrationScope {
  const rawMarket = String(value.marketSegment ?? '').trim().toUpperCase()
  const marketSegment = ['TWSE', 'LISTED'].includes(rawMarket)
    ? 'LISTED'
    : ['TPEX', 'OTC'].includes(rawMarket)
      ? 'OTC'
      : rawMarket || 'UNKNOWN'
  const rawCohort = String(value.entryCohort ?? '').trim().toLowerCase()
  const entryCohort: S12TwEntryCohort = rawCohort === 'reaction_ready' || rawCohort === 'limited_takeover_ready'
    ? rawCohort
    : 'legacy_mixed'
  return {
    marketSegment,
    entryCohort,
    alphaBucket: String(value.alphaBucket ?? '').trim() || null,
    entryTimeBucket: ['opening', 'mid_session', 'close_window'].includes(String(value.entryTimeBucket ?? ''))
      ? value.entryTimeBucket as S12TwCalibrationScope['entryTimeBucket']
      : null,
  }
}

function artifactFromRow(row: ArtifactRow): S12TwCalibrationArtifact {
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    status: row.status as S12TwCalibrationArtifact['status'],
    cadence: row.cadence as S12TwCalibrationCadence,
    scope: normalizeScope({
      marketSegment: row.market_segment,
      entryCohort: row.entry_cohort as S12TwEntryCohort,
      alphaBucket: row.alpha_bucket,
      entryTimeBucket: row.entry_time_bucket as S12TwCalibrationScope['entryTimeBucket'],
    }),
    policy: parseJson<Partial<S12TimingPolicy>>(row.policy_json, {}),
    exit: parseJson<S12TwExitCalibration>(row.exit_json, {
      tp1MfeQuantile: 0,
      tp2MfeQuantile: 0,
      stopMaeQuantile: 0,
      minNetProfitR: 0.25,
    }),
    validationStart: row.validation_start,
    validationEnd: row.validation_end,
    sampleCount: Number(row.sample_count ?? 0),
    dateCount: Number(row.date_count ?? 0),
    metrics: parseJson<Record<string, unknown>>(row.metrics_json, {}),
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  }
}

export async function ensureS12TwCalibrationTables(db: D1Database): Promise<void> {
  for (const sql of TABLE_DDL) await db.prepare(sql).run()
}

export async function listApprovedS12TwCalibrationArtifacts(
  db: D1Database,
  options: { includeSuperseded?: boolean } = {},
): Promise<S12TwCalibrationArtifact[]> {
  await ensureS12TwCalibrationTables(db)
  const { results } = await db.prepare(`
    SELECT artifact_id, run_id, status, cadence, market_segment, entry_cohort, alpha_bucket, entry_time_bucket,
           policy_json, exit_json, validation_start, validation_end, sample_count, date_count,
           metrics_json, created_at, approved_at
     FROM s12_tw_calibration_artifacts
     WHERE status = 'approved'
       ${options.includeSuperseded ? '' : 'AND superseded_at IS NULL'}
     ORDER BY approved_at DESC, created_at DESC
     LIMIT 500
  `).all<ArtifactRow>()
  const artifacts = (results ?? []).map(artifactFromRow)
  if (options.includeSuperseded) return artifacts
  const latest = new Map<string, S12TwCalibrationArtifact>()
  for (const artifact of artifacts) {
    const key = scopeKey(artifact.scope)
    if (!latest.has(key)) latest.set(key, artifact)
  }
  return [...latest.values()]
}

export function resolveS12TwCalibrationArtifact(
  artifacts: S12TwCalibrationArtifact[],
  requested: Partial<S12TwCalibrationScope> & { asOfDate?: string | null },
): S12TwCalibrationArtifact | null {
  const requestedCohort = String(requested.entryCohort ?? '').trim()
  if (requestedCohort !== 'reaction_ready' && requestedCohort !== 'limited_takeover_ready') return null
  const scope = normalizeScope(requested)
  const keys = [
    scopeKey(scope),
    scopeKey({ ...scope, entryTimeBucket: null }),
    scopeKey({ entryCohort: scope.entryCohort, marketSegment: scope.marketSegment, alphaBucket: null, entryTimeBucket: null }),
  ]
  const asOfDate = String(requested.asOfDate ?? '').trim()
  const eligible = artifacts.filter((row) => (
    row.metrics.return_basis === S12_TW_CALIBRATION_RETURN_BASIS &&
    row.metrics.return_unit === S12_TW_CALIBRATION_RETURN_UNIT &&
    Number(row.metrics.roundtrip_cost_bps) === CANONICAL_SELECTION_ROUNDTRIP_COST_BPS &&
    row.status === 'approved' &&
    (!asOfDate || row.validationEnd < asOfDate)
  ))
  const byKey = new Map<string, S12TwCalibrationArtifact>()
  for (const artifact of eligible) {
    const key = scopeKey(artifact.scope)
    if (!byKey.has(key)) byKey.set(key, artifact)
  }
  for (const key of keys) {
    const artifact = byKey.get(key)
    if (artifact) return artifact
  }
  return null
}

export function s12TwEntryCohortFromState(value: unknown): Exclude<S12TwEntryCohort, 'legacy_mixed'> | undefined {
  const state = String(value ?? '').trim().toLowerCase()
  if (state === 'limited_takeover_ready') return 'limited_takeover_ready'
  if (state === 'reaction_ready') return 'reaction_ready'
  return undefined
}

export function applyS12TwCalibrationArtifact(
  base: Partial<S12TimingPolicy> | null | undefined,
  artifact: S12TwCalibrationArtifact | null,
): S12TimingPolicy {
  return normalizeS12TimingPolicy({
    ...(base ?? {}),
    ...(artifact?.policy ?? {}),
  })
}

async function loadEvidence(db: D1Database, startDate: string, endDate: string): Promise<CalibrationEvidence[]> {
  const { results } = await db.prepare(`
    SELECT o.symbol, o.trade_date, o.assessment_state,
           COALESCE(NULLIF(TRIM(o.market), ''), 'UNKNOWN') AS market,
           o.entry_ms, o.entry_price, o.stop_price, o.pnl_pct,
           o.max_favorable_pct, o.max_adverse_pct, o.detail_json
      FROM s12_replay_trade_outcomes o
     WHERE o.trade_date >= ?
       AND o.trade_date <= ?
       AND o.sample_eligible = 1
       AND o.pnl_pct IS NOT NULL
       AND json_extract(o.detail_json, '$.replay_diagnostics.replay_engine_signature') = ?
       AND json_extract(o.detail_json, '$.replay_diagnostics.replay_cohort_signature') IS NOT NULL
     ORDER BY o.trade_date ASC, o.symbol ASC
     LIMIT 100000
  `).bind(startDate, endDate, S12_REPLAY_ENGINE_SIGNATURE).all<Record<string, unknown>>()
  const evidence: CalibrationEvidence[] = []
  for (const row of results ?? []) {
    const payload = parseJson<Record<string, unknown>>(row.detail_json, {})
    const assessmentDetail = String(payload.assessment_detail ?? payload.assessmentDetail ?? '')
    const entry = finite(row.entry_price)
    const stop = finite(row.stop_price)
    const atr = finite(detailValue(assessmentDetail, 'atr15m'))
    const grossPnlPct = finite(row.pnl_pct)
    const stopRiskPct = entry != null && stop != null && entry > stop ? (entry - stop) / entry : null
    if (grossPnlPct == null || stopRiskPct == null || stopRiskPct <= 0) continue
    const netPnlPct = grossPnlPct - CANONICAL_SELECTION_ROUNDTRIP_COST_BPS / 10_000
    const pnlR = netPnlPct / stopRiskPct
    const entryCohort = String(row.assessment_state ?? payload.assessment_state ?? '').trim().toLowerCase()
    if (entryCohort !== 'reaction_ready' && entryCohort !== 'limited_takeover_ready') continue
    evidence.push({
      symbol: String(row.symbol ?? ''),
      tradeDate: String(row.trade_date ?? ''),
      marketSegment: normalizeScope({ marketSegment: String(payload.market_segment ?? row.market ?? 'UNKNOWN'), entryCohort }).marketSegment,
      entryCohort,
      alphaBucket: String(payload.alpha_bucket ?? '').trim() || null,
      entryTimeBucket: timeBucket(row.entry_ms),
      pnlR,
      mfePct: finite(row.max_favorable_pct) ?? 0,
      maePct: Math.abs(finite(row.max_adverse_pct) ?? 0),
      mutationScore: finite(detailValue(assessmentDetail, 'equity_mutation_score')),
      fastVwapSignals: countPipeValues(detailValue(assessmentDetail, 'vwap_fast_reasons')),
      fastVwapBlockers: countPipeValues(detailValue(assessmentDetail, 'vwap_fast_blockers')),
      stopRiskPct,
      stopRiskAtr: entry != null && stop != null && atr != null && atr > 0 && entry > stop ? (entry - stop) / atr : null,
      sessionMoveAtr: finite(detailValue(assessmentDetail, 'session_60m_move_atr')),
      sessionClosePosition: finite(detailValue(assessmentDetail, 'session_60m_close_position')),
    })
  }
  return evidence
}

function buildArtifactCandidate(
  rows: CalibrationEvidence[],
  scope: S12TwCalibrationScope,
  cadence: S12TwCalibrationCadence,
  runId: string,
  validationStart: string,
  validationEnd: string,
): S12TwCalibrationArtifact | null {
  const dates = [...new Set(rows.map((row) => row.tradeDate))].sort()
  if (rows.length < 40 || dates.length < 10) return null
  const splitDate = dates[Math.max(1, Math.floor(dates.length * 0.7)) - 1]
  const train = rows.filter((row) => row.tradeDate <= splitDate)
  const validation = rows.filter((row) => row.tradeDate > splitDate)
  if (train.length < 28 || validation.length < 12 || new Set(validation.map((row) => row.tradeDate)).size < 3) return null

  const profitable = train.filter((row) => row.pnlR > 0)
  const scores = profitable.map((row) => row.mutationScore).filter((value): value is number => value != null)
  const stopRiskPct = profitable.map((row) => row.stopRiskPct).filter((value): value is number => value != null)
  const stopRiskAtr = profitable.map((row) => row.stopRiskAtr).filter((value): value is number => value != null)
  const fastSignals = profitable.map((row) => row.fastVwapSignals).filter((value): value is number => value != null)
  const baselineValidationMean = mean(validation.map((row) => row.pnlR)) ?? -Infinity
  const baselineValidationHitRate = validation.length
    ? validation.filter((row) => row.pnlR > 0).length / validation.length
    : 0
  const limitedMutationMinScore = Math.max(3, Math.min(6, Math.round(quantile(scores, 0.25) ?? DEFAULT_S12_TIMING_POLICY.limitedMutationMinScore)))
  const strictMutationMinScore = Math.max(limitedMutationMinScore + 1, Math.min(8, Math.round(quantile(scores, 0.55) ?? DEFAULT_S12_TIMING_POLICY.strictMutationMinScore)))
  const maxStopRiskPct = Math.max(0.02, Math.min(0.08, quantile(stopRiskPct, 0.85) ?? DEFAULT_S12_TIMING_POLICY.maxStopRiskPct))
  const maxStopRiskAtr = Math.max(1, Math.min(5, quantile(stopRiskAtr, 0.85) ?? DEFAULT_S12_TIMING_POLICY.maxStopRiskAtr))
  const minFastVwapSignals = Math.max(1, Math.min(4, Math.floor(quantile(fastSignals, 0.25) ?? DEFAULT_S12_TIMING_POLICY.minFastVwapSignals)))
  const trainSessionRows = train.filter((row) => row.sessionMoveAtr != null && row.sessionClosePosition != null)
  const profitableSessionRows = trainSessionRows.filter((row) => row.pnlR > 0)
  const validationSessionRows = validation.filter((row) => row.sessionMoveAtr != null && row.sessionClosePosition != null)
  const sessionFeatureCoverage = trainSessionRows.length / train.length
  const validationSessionFeatureCoverage = validationSessionRows.length / validation.length
  const proposedSessionMoveAtr = Math.max(0.1, Math.min(1.5,
    quantile(profitableSessionRows.map((row) => row.sessionMoveAtr as number), 0.25)
      ?? DEFAULT_S12_TIMING_POLICY.sessionAcceptanceMinMoveAtr,
  ))
  const proposedSessionClosePosition = Math.max(0.55, Math.min(0.95,
    quantile(profitableSessionRows.map((row) => row.sessionClosePosition as number), 0.25)
      ?? DEFAULT_S12_TIMING_POLICY.sessionAcceptanceMinClosePosition,
  ))
  const selectedSessionValidation = validationSessionRows.filter((row) => (
    (row.sessionMoveAtr as number) >= proposedSessionMoveAtr
    && (row.sessionClosePosition as number) >= proposedSessionClosePosition
  ))
  const sessionValidationMean = mean(selectedSessionValidation.map((row) => row.pnlR))
  const sessionValidationHitRate = selectedSessionValidation.length
    ? selectedSessionValidation.filter((row) => row.pnlR > 0).length / selectedSessionValidation.length
    : 0
  const sessionValidationCoverage = selectedSessionValidation.length / validation.length
  const sessionPolicyApproved = (
    sessionFeatureCoverage >= 0.7
    && validationSessionFeatureCoverage >= 0.7
    && profitableSessionRows.length >= 10
    && selectedSessionValidation.length >= 10
    && sessionValidationCoverage >= 0.35
    && sessionValidationMean != null
    && sessionValidationMean >= baselineValidationMean
    && sessionValidationHitRate >= baselineValidationHitRate
    && maxDrawdownR(selectedSessionValidation) >= maxDrawdownR(validation)
  )
  const selectedValidation = validation.filter((row) => (
    (row.mutationScore == null || row.mutationScore >= limitedMutationMinScore) &&
    (row.fastVwapSignals == null || row.fastVwapSignals >= minFastVwapSignals) &&
    (row.stopRiskPct == null || row.stopRiskPct <= maxStopRiskPct) &&
    (row.stopRiskAtr == null || row.stopRiskAtr <= maxStopRiskAtr)
  ))
  const validationMean = mean(selectedValidation.map((row) => row.pnlR)) ?? -Infinity
  const validationHitRate = selectedValidation.length
    ? selectedValidation.filter((row) => row.pnlR > 0).length / selectedValidation.length
    : 0
  const baselineDrawdown = maxDrawdownR(validation)
  const selectedDrawdown = maxDrawdownR(selectedValidation)
  const coverage = selectedValidation.length / validation.length
  const failedGates: string[] = []
  if (selectedValidation.length < 10) failedGates.push('selected_validation_samples')
  if (coverage < 0.35) failedGates.push('validation_coverage')
  if (validationMean < 0) failedGates.push('selected_validation_mean_r')
  if (validationHitRate < 0.45) failedGates.push('selected_validation_hit_rate')
  if (selectedDrawdown < baselineDrawdown) failedGates.push('validation_drawdown_non_degradation')
  if (validationMean < baselineValidationMean) failedGates.push('validation_mean_non_degradation')
  const approved = failedGates.length === 0
  const nowIso = new Date().toISOString()
  const tp1Mfe = Math.max(0, Math.min(0.5, quantile(profitable.map((row) => row.mfePct), 0.5) ?? 0))
  const tp2Mfe = Math.max(tp1Mfe, Math.min(0.8, quantile(profitable.map((row) => row.mfePct), 0.75) ?? tp1Mfe))
  const stopMae = Math.max(0, Math.min(0.25, quantile(train.filter((row) => row.pnlR > 0).map((row) => row.maePct), 0.8) ?? 0))
  return {
    artifactId: `s12-tw-v3-${cadence}-${scopeKey(scope).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${validationEnd}`,
    runId,
    status: approved ? 'approved' : 'rejected',
    cadence,
    scope,
    policy: {
      minFastVwapSignals,
      limitedMutationMinScore,
      strictMutationMinScore,
      maxStopRiskPct: round(maxStopRiskPct),
      maxStopRiskAtr: round(maxStopRiskAtr),
      ...(sessionPolicyApproved
        ? {
            sessionAcceptanceMinMoveAtr: round(proposedSessionMoveAtr),
            sessionAcceptanceMinClosePosition: round(proposedSessionClosePosition),
          }
        : {}),
    },
    exit: {
      tp1MfeQuantile: round(tp1Mfe),
      tp2MfeQuantile: round(Math.max(tp1Mfe, tp2Mfe)),
      stopMaeQuantile: round(stopMae),
      minNetProfitR: 0.25,
    },
    validationStart,
    validationEnd,
    sampleCount: rows.length,
    dateCount: dates.length,
    metrics: {
      return_basis: S12_TW_CALIBRATION_RETURN_BASIS,
      return_unit: S12_TW_CALIBRATION_RETURN_UNIT,
      roundtrip_cost_bps: CANONICAL_SELECTION_ROUNDTRIP_COST_BPS,
      train_samples: train.length,
      validation_samples: validation.length,
      selected_validation_samples: selectedValidation.length,
      validation_coverage: round(coverage),
      baseline_validation_mean_r: round(baselineValidationMean),
      selected_validation_mean_r: round(validationMean),
      selected_validation_hit_rate: round(validationHitRate),
      baseline_validation_max_drawdown_r: round(baselineDrawdown),
      selected_validation_max_drawdown_r: round(selectedDrawdown),
      failed_gates: failedGates,
      session_acceptance_threshold_selection: {
        status: sessionPolicyApproved ? 'selected' : 'insufficient_oos_evidence',
        train_feature_coverage: round(sessionFeatureCoverage),
        validation_feature_coverage: round(validationSessionFeatureCoverage),
        profitable_train_samples: profitableSessionRows.length,
        proposed_min_move_atr: round(proposedSessionMoveAtr),
        proposed_min_close_position: round(proposedSessionClosePosition),
        selected_validation_samples: selectedSessionValidation.length,
        selected_validation_coverage: round(sessionValidationCoverage),
        baseline_validation_mean_r: round(baselineValidationMean),
        selected_validation_mean_r: sessionValidationMean == null ? null : round(sessionValidationMean),
        baseline_validation_hit_rate: round(baselineValidationHitRate),
        selected_validation_hit_rate: round(sessionValidationHitRate),
        selection_contract: 'train_profitable_q25_then_chronological_oos_non_degradation',
      },
      split_date: splitDate,
      no_global_fallback: true,
    },
    createdAt: nowIso,
    approvedAt: approved ? nowIso : null,
  }
}

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

export async function runS12TwCalibration(
  db: D1Database,
  options: { runDate: string; cadence?: S12TwCalibrationCadence; dryRun?: boolean },
): Promise<{ status: string; summary: string; artifacts: S12TwCalibrationArtifact[]; written: number }> {
  await ensureS12TwCalibrationTables(db)
  const cadence = options.cadence ?? 'weekly'
  const startDate = daysBefore(options.runDate, cadence === 'monthly' ? 180 : 90)
  const evidence = await loadEvidence(db, startDate, options.runDate)
  const grouped = new Map<string, { scope: S12TwCalibrationScope; rows: CalibrationEvidence[] }>()
  const append = (scope: S12TwCalibrationScope, row: CalibrationEvidence) => {
    const key = scopeKey(scope)
    const group = grouped.get(key) ?? { scope, rows: [] }
    group.rows.push(row)
    grouped.set(key, group)
  }
  for (const row of evidence) {
    append({ entryCohort: row.entryCohort, marketSegment: row.marketSegment, alphaBucket: null, entryTimeBucket: null }, row)
    if (row.alphaBucket) append({ entryCohort: row.entryCohort, marketSegment: row.marketSegment, alphaBucket: row.alphaBucket, entryTimeBucket: null }, row)
    if (row.alphaBucket && row.entryTimeBucket) append({ entryCohort: row.entryCohort, marketSegment: row.marketSegment, alphaBucket: row.alphaBucket, entryTimeBucket: row.entryTimeBucket }, row)
  }
  const runId = `s12-tw-calibration-${cadence}-${options.runDate}`
  const artifacts = [...grouped.values()]
    .map((group) => buildArtifactCandidate(group.rows, group.scope, cadence, runId, startDate, options.runDate))
    .filter((artifact): artifact is S12TwCalibrationArtifact => artifact != null)
  const approved = artifacts.filter((artifact) => artifact.status === 'approved')
  const failedGateDistribution: Record<string, number> = {}
  for (const artifact of artifacts) {
    const gates = Array.isArray(artifact.metrics.failed_gates)
      ? artifact.metrics.failed_gates
      : []
    for (const gate of gates) {
      const key = String(gate)
      failedGateDistribution[key] = (failedGateDistribution[key] ?? 0) + 1
    }
  }
  let written = 0
  if (options.dryRun !== true) {
    for (const artifact of artifacts) {
      if (artifact.status === 'approved') await db.prepare(`
        UPDATE s12_tw_calibration_artifacts
           SET superseded_at = ?
         WHERE status = 'approved'
           AND superseded_at IS NULL
           AND market_segment = ?
           AND entry_cohort = ?
           AND COALESCE(alpha_bucket, '') = COALESCE(?, '')
           AND COALESCE(entry_time_bucket, '') = COALESCE(?, '')
      `).bind(artifact.createdAt, artifact.scope.marketSegment, artifact.scope.entryCohort, artifact.scope.alphaBucket, artifact.scope.entryTimeBucket).run()
      await db.prepare(`
        INSERT OR REPLACE INTO s12_tw_calibration_artifacts (
          artifact_id, run_id, status, cadence, market_segment, entry_cohort, alpha_bucket, entry_time_bucket,
          policy_json, exit_json, validation_start, validation_end, sample_count, date_count,
          metrics_json, created_at, approved_at, superseded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).bind(
        artifact.artifactId,
        artifact.runId,
        artifact.status,
        artifact.cadence,
        artifact.scope.marketSegment,
        artifact.scope.entryCohort,
        artifact.scope.alphaBucket,
        artifact.scope.entryTimeBucket,
        JSON.stringify(artifact.policy),
        JSON.stringify(artifact.exit),
        artifact.validationStart,
        artifact.validationEnd,
        artifact.sampleCount,
        artifact.dateCount,
        JSON.stringify(artifact.metrics),
        artifact.createdAt,
        artifact.approvedAt,
      ).run()
      written += 1
    }
    await db.prepare(`
      INSERT OR REPLACE INTO s12_tw_calibration_runs (
        run_id, run_date, cadence, status, scopes_seen, artifacts_written, summary_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).bind(
      runId,
      options.runDate,
      cadence,
      approved.length ? 'promoted' : 'frozen',
      grouped.size,
      written,
      JSON.stringify({
        evidence: evidence.length,
        candidates: artifacts.length,
        approved: approved.length,
        rejected: artifacts.length - approved.length,
        failed_gate_distribution: failedGateDistribution,
      }),
    ).run()
  }
  const status = approved.length ? (options.dryRun ? 'validated' : 'promoted') : 'frozen'
  return {
    status,
    summary: `s12_tw_calibration cadence=${cadence} status=${status} evidence=${evidence.length} scopes=${grouped.size} candidates=${artifacts.length} approved=${approved.length} rejected=${artifacts.length - approved.length} written=${written} failed_gates=${JSON.stringify(failedGateDistribution)}`,
    artifacts,
    written,
  }
}
