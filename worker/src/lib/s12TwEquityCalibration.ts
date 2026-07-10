import {
  DEFAULT_S12_TIMING_POLICY,
  normalizeS12TimingPolicy,
  type S12TimingPolicy,
} from './s12IntradayStructure'

export type S12TwCalibrationCadence = 'weekly' | 'monthly' | 'regime_shift'

export interface S12TwCalibrationScope {
  marketSegment: string
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
}

interface ArtifactRow {
  artifact_id: string
  run_id: string
  status: string
  cadence: string
  market_segment: string
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
     ON s12_tw_calibration_artifacts(status, superseded_at, market_segment, alpha_bucket, entry_time_bucket, approved_at DESC)`,
]

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
  return [scope.marketSegment, scope.alphaBucket ?? '*', scope.entryTimeBucket ?? '*'].join('|')
}

function normalizeScope(value: Partial<S12TwCalibrationScope>): S12TwCalibrationScope {
  const rawMarket = String(value.marketSegment ?? '').trim().toUpperCase()
  const marketSegment = ['TWSE', 'LISTED'].includes(rawMarket)
    ? 'LISTED'
    : ['TPEX', 'OTC'].includes(rawMarket)
      ? 'OTC'
      : rawMarket || 'UNKNOWN'
  return {
    marketSegment,
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
    SELECT artifact_id, run_id, status, cadence, market_segment, alpha_bucket, entry_time_bucket,
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
  const scope = normalizeScope(requested)
  const keys = [
    scopeKey(scope),
    scopeKey({ ...scope, entryTimeBucket: null }),
    scopeKey({ marketSegment: scope.marketSegment, alphaBucket: null, entryTimeBucket: null }),
  ]
  const asOfDate = String(requested.asOfDate ?? '').trim()
  const eligible = artifacts.filter((row) => (
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
    SELECT o.symbol, o.trade_date,
           COALESCE(NULLIF(TRIM(o.market), ''), s.market, 'UNKNOWN') AS market,
           o.entry_ms, o.entry_price, o.stop_price, o.trade_pnl_r,
           o.max_favorable_pct, o.max_adverse_pct, o.detail_json
      FROM s12_replay_trade_outcomes o
      LEFT JOIN stocks s ON s.symbol = o.symbol
     WHERE o.trade_date >= ?
       AND o.trade_date <= ?
       AND o.sample_eligible = 1
       AND o.trade_pnl_r IS NOT NULL
     ORDER BY o.trade_date ASC, o.symbol ASC
     LIMIT 100000
  `).bind(startDate, endDate).all<Record<string, unknown>>()
  const evidence: CalibrationEvidence[] = []
  for (const row of results ?? []) {
    const payload = parseJson<Record<string, unknown>>(row.detail_json, {})
    const assessmentDetail = String(payload.assessment_detail ?? payload.assessmentDetail ?? '')
    const entry = finite(row.entry_price)
    const stop = finite(row.stop_price)
    const atr = finite(detailValue(assessmentDetail, 'atr15m'))
    const pnlR = finite(row.trade_pnl_r)
    if (pnlR == null) continue
    evidence.push({
      symbol: String(row.symbol ?? ''),
      tradeDate: String(row.trade_date ?? ''),
      marketSegment: normalizeScope({ marketSegment: String(payload.market_segment ?? row.market ?? 'UNKNOWN') }).marketSegment,
      alphaBucket: String(payload.alpha_bucket ?? '').trim() || null,
      entryTimeBucket: timeBucket(row.entry_ms),
      pnlR,
      mfePct: finite(row.max_favorable_pct) ?? 0,
      maePct: Math.abs(finite(row.max_adverse_pct) ?? 0),
      mutationScore: finite(detailValue(assessmentDetail, 'equity_mutation_score')),
      fastVwapSignals: countPipeValues(detailValue(assessmentDetail, 'vwap_fast_reasons')),
      fastVwapBlockers: countPipeValues(detailValue(assessmentDetail, 'vwap_fast_blockers')),
      stopRiskPct: entry != null && stop != null && entry > stop ? (entry - stop) / entry : null,
      stopRiskAtr: entry != null && stop != null && atr != null && atr > 0 && entry > stop ? (entry - stop) / atr : null,
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
  const limitedMutationMinScore = Math.max(3, Math.min(6, Math.round(quantile(scores, 0.25) ?? DEFAULT_S12_TIMING_POLICY.limitedMutationMinScore)))
  const strictMutationMinScore = Math.max(limitedMutationMinScore + 1, Math.min(8, Math.round(quantile(scores, 0.55) ?? DEFAULT_S12_TIMING_POLICY.strictMutationMinScore)))
  const maxStopRiskPct = Math.max(0.02, Math.min(0.08, quantile(stopRiskPct, 0.85) ?? DEFAULT_S12_TIMING_POLICY.maxStopRiskPct))
  const maxStopRiskAtr = Math.max(1, Math.min(5, quantile(stopRiskAtr, 0.85) ?? DEFAULT_S12_TIMING_POLICY.maxStopRiskAtr))
  const minFastVwapSignals = Math.max(1, Math.min(4, Math.floor(quantile(fastSignals, 0.25) ?? DEFAULT_S12_TIMING_POLICY.minFastVwapSignals)))
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
  const approved = selectedValidation.length >= 10 && coverage >= 0.35 && validationMean >= 0 && validationHitRate >= 0.45 && selectedDrawdown >= baselineDrawdown && validationMean >= baselineValidationMean
  const nowIso = new Date().toISOString()
  const tp1Mfe = Math.max(0, Math.min(0.5, quantile(profitable.map((row) => row.mfePct), 0.5) ?? 0))
  const tp2Mfe = Math.max(tp1Mfe, Math.min(0.8, quantile(profitable.map((row) => row.mfePct), 0.75) ?? tp1Mfe))
  const stopMae = Math.max(0, Math.min(0.25, quantile(train.filter((row) => row.pnlR > 0).map((row) => row.maePct), 0.8) ?? 0))
  return {
    artifactId: `s12-tw-v2-${cadence}-${scopeKey(scope).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${validationEnd}`,
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
      train_samples: train.length,
      validation_samples: validation.length,
      selected_validation_samples: selectedValidation.length,
      validation_coverage: round(coverage),
      baseline_validation_mean_r: round(baselineValidationMean),
      selected_validation_mean_r: round(validationMean),
      selected_validation_hit_rate: round(validationHitRate),
      baseline_validation_max_drawdown_r: round(baselineDrawdown),
      selected_validation_max_drawdown_r: round(selectedDrawdown),
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
    append({ marketSegment: row.marketSegment, alphaBucket: null, entryTimeBucket: null }, row)
    if (row.alphaBucket) append({ marketSegment: row.marketSegment, alphaBucket: row.alphaBucket, entryTimeBucket: null }, row)
    if (row.alphaBucket && row.entryTimeBucket) append({ marketSegment: row.marketSegment, alphaBucket: row.alphaBucket, entryTimeBucket: row.entryTimeBucket }, row)
  }
  const runId = `s12-tw-calibration-${cadence}-${options.runDate}`
  const artifacts = [...grouped.values()]
    .map((group) => buildArtifactCandidate(group.rows, group.scope, cadence, runId, startDate, options.runDate))
    .filter((artifact): artifact is S12TwCalibrationArtifact => artifact != null)
  const approved = artifacts.filter((artifact) => artifact.status === 'approved')
  let written = 0
  if (options.dryRun !== true) {
    for (const artifact of approved) {
      await db.prepare(`
        UPDATE s12_tw_calibration_artifacts
           SET superseded_at = ?
         WHERE status = 'approved'
           AND superseded_at IS NULL
           AND market_segment = ?
           AND COALESCE(alpha_bucket, '') = COALESCE(?, '')
           AND COALESCE(entry_time_bucket, '') = COALESCE(?, '')
      `).bind(artifact.createdAt, artifact.scope.marketSegment, artifact.scope.alphaBucket, artifact.scope.entryTimeBucket).run()
      await db.prepare(`
        INSERT OR REPLACE INTO s12_tw_calibration_artifacts (
          artifact_id, run_id, status, cadence, market_segment, alpha_bucket, entry_time_bucket,
          policy_json, exit_json, validation_start, validation_end, sample_count, date_count,
          metrics_json, created_at, approved_at, superseded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).bind(
        artifact.artifactId,
        artifact.runId,
        artifact.status,
        artifact.cadence,
        artifact.scope.marketSegment,
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
      JSON.stringify({ evidence: evidence.length, candidates: artifacts.length, approved: approved.length }),
    ).run()
  }
  const status = approved.length ? (options.dryRun ? 'validated' : 'promoted') : 'frozen'
  return {
    status,
    summary: `s12_tw_calibration cadence=${cadence} status=${status} evidence=${evidence.length} scopes=${grouped.size} candidates=${artifacts.length} approved=${approved.length} written=${written}`,
    artifacts,
    written,
  }
}
