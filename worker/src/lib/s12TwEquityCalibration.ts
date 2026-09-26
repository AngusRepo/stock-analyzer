import { archivedS12ReplayChunks, projectS12ReplayChunk, replayIdentityKeys, type ReplayArchiveEnv, type ReplayRow } from './retentionS12ReplayReader'
import { paperExecutionNow, paperExecutionDate } from './paperExecutionScope'
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

const CALIBRATION_EVIDENCE_PAGE_SIZE = 128
const CALIBRATION_EVIDENCE_SCAN_LIMIT = 100_000

const CALIBRATION_LIFECYCLE_RECENT_MS = 6 * 60 * 60_000

export interface S12TwCalibrationLifecycleCensoring {
  completeRows: number
  completeDates: number
  pendingMaturityTerminalRows: number
  pendingMaturityTerminalDates: number
  recentEnqueuedRows: number
  recentEnqueuedDates: string[]
  staleEnqueuedRows: number
  staleEnqueuedDates: string[]
  missingOrOtherRows: number
  missingOrOtherDates: number
}

function commaDates(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item))
    .sort()
}


export interface S12CalibrationHistory {
  snapshotAt: string
  nowMs: number
  startDate: string
  endDate: string
  guard(): Promise<void>
  rows(): Promise<ReplayRow[]>
}

/** One request-local cold pass shared by censor inspection and evidence selection. */
export function createS12CalibrationHistory(env: ReplayArchiveEnv, db: D1Database,
  startDate: string, endDate: string, nowMs = paperExecutionNow()): S12CalibrationHistory {
  const snapshotAt = new Date(nowMs).toISOString()
  const recentCutoff = new Date(nowMs - CALIBRATION_LIFECYCLE_RECENT_MS).toISOString()
  let loaded: Promise<ReplayRow[]> | undefined
  let hotIdentity: string | undefined
  async function guard() {
    const row = await db.prepare(`SELECT COUNT(*) AS row_count,COALESCE(SUM(id),0) AS id_sum,
      COALESCE(MAX(id),0) AS max_id FROM s12_replay_trade_outcomes WHERE trade_date>=? AND trade_date<=?`)
      .bind(startDate,endDate).first<ReplayRow>()
    const identity = JSON.stringify(row)
    if (hotIdentity !== undefined && identity !== hotIdentity) throw new Error('retention_replay_hot_snapshot_changed')
    hotIdentity = identity
  }
  return { snapshotAt, nowMs, startDate, endDate, guard, rows() {
    return loaded ??= (async () => {
      await guard()
      const collected: ReplayRow[] = []
      const sql = `
      SELECT o.id, o.symbol, o.signal_date, o.setup_id, o.trade_date, o.assessment_state,
             COALESCE(NULLIF(TRIM(o.market), ''), 'UNKNOWN') AS market,
             o.entry_ms, o.entry_price, o.stop_price, o.pnl_pct,
             o.max_favorable_pct, o.max_adverse_pct,
             COALESCE(
               json_extract(o.detail_json, '$.assessment_detail'),
               json_extract(o.detail_json, '$.assessmentDetail'),
               ''
             ) AS assessment_detail,
             json_extract(o.detail_json, '$.assessment_state') AS detail_assessment_state,
             json_extract(o.detail_json, '$.market_segment') AS market_segment,
             json_extract(o.detail_json, '$.alpha_bucket') AS alpha_bucket,
             l.state AS lifecycle_state,
             CASE WHEN datetime(l.updated_at)>=datetime(?) THEN 1 ELSE 0 END AS lifecycle_recent,
             CASE WHEN datetime(l.updated_at)<datetime(?) THEN 1 ELSE 0 END AS lifecycle_stale,
             CASE WHEN l.state IN ('replay_complete','replay_pending_maturity')
               AND datetime(l.updated_at)<=datetime(?) THEN 1 ELSE 0 END AS terminal_at_snapshot
        FROM s12_replay_trade_outcomes o
        LEFT JOIN allocator_ev_daily_lifecycle l ON l.business_date=o.signal_date
        WHERE o.trade_date>=? AND o.trade_date<=? AND o.sample_eligible=1 AND o.pnl_pct IS NOT NULL
          AND json_extract(o.detail_json,'$.replay_diagnostics.replay_engine_signature')=?
          AND json_extract(o.detail_json,'$.replay_diagnostics.replay_cohort_signature') IS NOT NULL`
      for await (const chunk of archivedS12ReplayChunks(env, db, startDate, endDate, snapshotAt)) {
        for await (const rows of projectS12ReplayChunk(db, chunk, sql,
          [recentCutoff, recentCutoff, snapshotAt, startDate, endDate, S12_REPLAY_ENGINE_SIGNATURE])) collected.push(...rows)
      }
      await guard()
      return collected
    })()
  } }
}

export async function inspectS12TwCalibrationLifecycleCensoring(
  db: D1Database,
  runDate: string,
  cadence: S12TwCalibrationCadence,
  nowMs = paperExecutionNow(),
  history?: S12CalibrationHistory,
): Promise<S12TwCalibrationLifecycleCensoring> {
  const startDate = daysBefore(runDate, cadence === 'monthly' ? 180 : 90)
  if (history && (history.startDate !== startDate || history.endDate !== runDate)) throw new Error('retention_replay_history_window_mismatch')
  await history?.guard()
  const recentCutoff = new Date((history?.nowMs ?? nowMs) - CALIBRATION_LIFECYCLE_RECENT_MS).toISOString()
  const hotRows = (await db.prepare(`
    SELECT o.signal_date,
      SUM(CASE WHEN l.state='replay_complete' THEN 1 ELSE 0 END) AS complete_rows,
      COUNT(DISTINCT CASE WHEN l.state='replay_complete' THEN o.signal_date END) AS complete_dates,
      SUM(CASE WHEN l.state='replay_pending_maturity' THEN 1 ELSE 0 END) AS pending_rows,
      COUNT(DISTINCT CASE WHEN l.state='replay_pending_maturity' THEN o.signal_date END) AS pending_dates,
      SUM(CASE WHEN l.state='replay_enqueued'
                AND datetime(l.updated_at) >= datetime(?) THEN 1 ELSE 0 END) AS recent_enqueued_rows,
      GROUP_CONCAT(DISTINCT CASE WHEN l.state='replay_enqueued'
                AND datetime(l.updated_at) >= datetime(?) THEN o.signal_date END) AS recent_enqueued_dates,
      SUM(CASE WHEN l.state='replay_enqueued'
                AND datetime(l.updated_at) < datetime(?) THEN 1 ELSE 0 END) AS stale_enqueued_rows,
      GROUP_CONCAT(DISTINCT CASE WHEN l.state='replay_enqueued'
                AND datetime(l.updated_at) < datetime(?) THEN o.signal_date END) AS stale_enqueued_dates,
      SUM(CASE WHEN l.state IS NULL OR l.state NOT IN (
                'replay_complete', 'replay_pending_maturity', 'replay_enqueued'
              ) THEN 1 ELSE 0 END) AS missing_or_other_rows,
      COUNT(DISTINCT CASE WHEN l.state IS NULL OR l.state NOT IN (
                'replay_complete', 'replay_pending_maturity', 'replay_enqueued'
              ) THEN o.signal_date END) AS missing_or_other_dates
      FROM s12_replay_trade_outcomes o
      LEFT JOIN allocator_ev_daily_lifecycle l
        ON l.business_date=o.signal_date
     WHERE o.trade_date >= ?
       AND o.trade_date <= ?
       AND o.sample_eligible = 1
       AND o.pnl_pct IS NOT NULL
       AND json_extract(o.detail_json, '$.replay_diagnostics.replay_engine_signature') = ?
       AND json_extract(o.detail_json, '$.replay_diagnostics.replay_cohort_signature') IS NOT NULL
     GROUP BY o.signal_date
  `).bind(
    recentCutoff,
    recentCutoff,
    recentCutoff,
    recentCutoff,
    startDate,
    runDate,
    S12_REPLAY_ENGINE_SIGNATURE,
  ).all<ReplayRow>()).results ?? []
  const coldRows = (history ? await history.rows() : []).map(row => ({
    signal_date: row.signal_date,
    complete_rows: row.lifecycle_state === 'replay_complete' ? 1 : 0,
    complete_dates: row.lifecycle_state === 'replay_complete' && row.signal_date != null ? 1 : 0,
    pending_rows: row.lifecycle_state === 'replay_pending_maturity' ? 1 : 0,
    pending_dates: row.lifecycle_state === 'replay_pending_maturity' && row.signal_date != null ? 1 : 0,
    recent_enqueued_rows: row.lifecycle_state === 'replay_enqueued' ? Number(row.lifecycle_recent) : 0,
    recent_enqueued_dates: row.lifecycle_state === 'replay_enqueued' && Number(row.lifecycle_recent) ? row.signal_date : null,
    stale_enqueued_rows: row.lifecycle_state === 'replay_enqueued' ? Number(row.lifecycle_stale) : 0,
    stale_enqueued_dates: row.lifecycle_state === 'replay_enqueued' && Number(row.lifecycle_stale) ? row.signal_date : null,
    missing_or_other_rows: !['replay_complete','replay_pending_maturity','replay_enqueued'].includes(row.lifecycle_state) ? 1 : 0,
    missing_or_other_dates: !['replay_complete','replay_pending_maturity','replay_enqueued'].includes(row.lifecycle_state) && row.signal_date != null ? 1 : 0,
  }))
  await history?.guard()
  const allRows: ReplayRow[] = [...hotRows, ...coldRows]
  const sum = (key: string) => allRows.reduce((total, row) => total + Math.max(0, Number(row[key] ?? 0)), 0)
  const dates = (key: string) => new Set(allRows.filter(row => Number(row[key]) > 0 && row.signal_date != null).map(row => String(row.signal_date))).size
  const enqueued = (key: string) => [...new Set(allRows.flatMap(row => commaDates(row[key])))].sort()
  return {
    completeRows: sum('complete_rows'),
    completeDates: dates('complete_dates'),
    pendingMaturityTerminalRows: sum('pending_rows'),
    pendingMaturityTerminalDates: dates('pending_dates'),
    recentEnqueuedRows: sum('recent_enqueued_rows'),
    recentEnqueuedDates: enqueued('recent_enqueued_dates'),
    staleEnqueuedRows: sum('stale_enqueued_rows'),
    staleEnqueuedDates: enqueued('stale_enqueued_dates'),
    missingOrOtherRows: sum('missing_or_other_rows'),
    missingOrOtherDates: dates('missing_or_other_dates'),
  }
}

export async function loadS12TwCalibrationEvidence(
  db: D1Database,
  startDate: string,
  endDate: string,
  history?: S12CalibrationHistory,
): Promise<CalibrationEvidence[]> {
  if (history && (history.startDate !== startDate || history.endDate !== endDate)) throw new Error('retention_replay_history_window_mismatch')
  await history?.guard()
  const lifecycleSnapshotAt = history?.snapshotAt ?? paperExecutionDate().toISOString()
  const snapshot = await db.prepare(`
    SELECT COALESCE(MAX(o.id), 0) AS max_id
      FROM s12_replay_trade_outcomes o
     WHERE o.trade_date >= ?
       AND o.trade_date <= ?
       AND o.sample_eligible = 1
       AND o.pnl_pct IS NOT NULL
       AND json_extract(o.detail_json, '$.replay_diagnostics.replay_engine_signature') = ?
       AND json_extract(o.detail_json, '$.replay_diagnostics.replay_cohort_signature') IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM allocator_ev_daily_lifecycle lifecycle
          WHERE lifecycle.business_date=o.signal_date
            AND lifecycle.state IN ('replay_complete', 'replay_pending_maturity')
            AND datetime(lifecycle.updated_at) <= datetime(?)
       )
  `).bind(startDate, endDate, S12_REPLAY_ENGINE_SIGNATURE, lifecycleSnapshotAt).first<{ max_id?: number | string | null }>()
  const snapshotMaxId = Math.max(0, Number(snapshot?.max_id ?? 0))
  if (snapshotMaxId <= 0 && !history) return []
  const candidates = new Map<number, CalibrationEvidence | null>()
  const coldKeys = new Map<string, number>()
  for (const row of history ? await history.rows() : []) {
    if (Number(row.terminal_at_snapshot) !== 1) continue
    candidates.set(Number(row.id), calibrationEvidenceFromRow(row))
    for (const key of replayIdentityKeys(row)) coldKeys.set(key, Number(row.id))
  }
  let lastId = 0
  let scanned = 0
  while (snapshotMaxId > 0 && scanned < CALIBRATION_EVIDENCE_SCAN_LIMIT) {
    const limit = Math.min(CALIBRATION_EVIDENCE_PAGE_SIZE, CALIBRATION_EVIDENCE_SCAN_LIMIT - scanned)
    const { results } = await db.prepare(`
      SELECT o.id, o.symbol, o.signal_date, o.setup_id, o.trade_date, o.assessment_state,
             COALESCE(NULLIF(TRIM(o.market), ''), 'UNKNOWN') AS market,
             o.entry_ms, o.entry_price, o.stop_price, o.pnl_pct,
             o.max_favorable_pct, o.max_adverse_pct,
             COALESCE(
               json_extract(o.detail_json, '$.assessment_detail'),
               json_extract(o.detail_json, '$.assessmentDetail'),
               ''
             ) AS assessment_detail,
             json_extract(o.detail_json, '$.assessment_state') AS detail_assessment_state,
             json_extract(o.detail_json, '$.market_segment') AS market_segment,
             json_extract(o.detail_json, '$.alpha_bucket') AS alpha_bucket
        FROM s12_replay_trade_outcomes o
       WHERE o.id > ?
         AND o.id <= ?
         AND o.trade_date >= ?
         AND o.trade_date <= ?
         AND o.sample_eligible = 1
         AND o.pnl_pct IS NOT NULL
         AND json_extract(o.detail_json, '$.replay_diagnostics.replay_engine_signature') = ?
         AND json_extract(o.detail_json, '$.replay_diagnostics.replay_cohort_signature') IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM allocator_ev_daily_lifecycle lifecycle
            WHERE lifecycle.business_date=o.signal_date
              AND lifecycle.state IN ('replay_complete', 'replay_pending_maturity')
              AND datetime(lifecycle.updated_at) <= datetime(?)
         )
       ORDER BY o.id ASC
       LIMIT ?
    `).bind(lastId, snapshotMaxId, startDate, endDate, S12_REPLAY_ENGINE_SIGNATURE, lifecycleSnapshotAt, limit).all<Record<string, unknown>>()
    const page = results ?? []
    if (page.length === 0) break
    scanned += page.length
    for (const row of page) {
      lastId = Math.max(lastId, Number(row.id ?? 0))
      for (const key of replayIdentityKeys(row)) {
        const coldId = coldKeys.get(key)
        if (coldId != null) candidates.delete(coldId)
      }
      candidates.set(Number(row.id), calibrationEvidenceFromRow(row))
    }
    if (page.length < limit) break
  }
  await history?.guard()
  const evidence = [...candidates.entries()].sort(([a], [b]) => a - b)
    .slice(0, CALIBRATION_EVIDENCE_SCAN_LIMIT).map(([, value]) => value)
    .filter((value): value is CalibrationEvidence => value !== null)
  evidence.sort((left, right) => (
    left.tradeDate.localeCompare(right.tradeDate)
    || left.symbol.localeCompare(right.symbol)
  ))
  return evidence
}


function calibrationEvidenceFromRow(row: ReplayRow): CalibrationEvidence | null {
  const assessmentDetail = String(row.assessment_detail ?? '')
  const entry = finite(row.entry_price)
  const stop = finite(row.stop_price)
  const atr = finite(detailValue(assessmentDetail, 'atr15m'))
  const grossPnlPct = finite(row.pnl_pct)
  const stopRiskPct = entry != null && stop != null && entry > stop ? (entry - stop) / entry : null
  if (grossPnlPct == null || stopRiskPct == null || stopRiskPct <= 0) return null
  const netPnlPct = grossPnlPct - CANONICAL_SELECTION_ROUNDTRIP_COST_BPS / 10_000
  const pnlR = netPnlPct / stopRiskPct
  const entryCohort = String(row.assessment_state ?? row.detail_assessment_state ?? '').trim().toLowerCase()
  if (entryCohort !== 'reaction_ready' && entryCohort !== 'limited_takeover_ready') return null
  return {
    symbol: String(row.symbol ?? ''),
    tradeDate: String(row.trade_date ?? ''),
    marketSegment: normalizeScope({
      marketSegment: String(row.market_segment ?? row.market ?? 'UNKNOWN'),
      entryCohort,
    }).marketSegment,
    entryCohort,
    alphaBucket: String(row.alpha_bucket ?? '').trim() || null,
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
  }
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
  const nowIso = paperExecutionDate().toISOString()
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

const S12_TW_CALIBRATION_BATCH_MAX_STATEMENTS = 250

export interface S12TwCalibrationAtomicCommitInput {
  runId: string
  runDate: string
  cadence: S12TwCalibrationCadence
  artifacts: S12TwCalibrationArtifact[]
  evidenceCount: number
  scopesSeen: number
  failedGateDistribution: Record<string, number>
  lifecycleCensoring?: S12TwCalibrationLifecycleCensoring
  replaceExistingRunArtifacts?: boolean
}

export async function commitS12TwCalibrationAtomically(
  db: D1Database,
  input: S12TwCalibrationAtomicCommitInput,
): Promise<number> {
  const approved = input.artifacts.filter((artifact) => artifact.status === 'approved')
  const statements: D1PreparedStatement[] = []
  if (input.replaceExistingRunArtifacts === true) {
    statements.push(db.prepare(`
      DELETE FROM s12_tw_calibration_artifacts
       WHERE run_id=?
    `).bind(input.runId))
  }
  const supersede = db.prepare(`
    UPDATE s12_tw_calibration_artifacts
       SET superseded_at = ?
     WHERE status = 'approved'
       AND superseded_at IS NULL
       AND market_segment = ?
       AND entry_cohort = ?
       AND COALESCE(alpha_bucket, '') = COALESCE(?, '')
       AND COALESCE(entry_time_bucket, '') = COALESCE(?, '')
  `)
  const upsertArtifact = db.prepare(`
    INSERT OR REPLACE INTO s12_tw_calibration_artifacts (
      artifact_id, run_id, status, cadence, market_segment, entry_cohort, alpha_bucket, entry_time_bucket,
      policy_json, exit_json, validation_start, validation_end, sample_count, date_count,
      metrics_json, created_at, approved_at, superseded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `)
  for (const artifact of input.artifacts) {
    if (artifact.status === 'approved') {
      statements.push(supersede.bind(
        artifact.createdAt,
        artifact.scope.marketSegment,
        artifact.scope.entryCohort,
        artifact.scope.alphaBucket,
        artifact.scope.entryTimeBucket,
      ))
    }
    statements.push(upsertArtifact.bind(
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
    ))
  }
  statements.push(db.prepare(`
    INSERT OR REPLACE INTO s12_tw_calibration_runs (
      run_id, run_date, cadence, status, scopes_seen, artifacts_written, summary_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).bind(
    input.runId,
    input.runDate,
    input.cadence,
    approved.length ? 'promoted' : 'frozen',
    input.scopesSeen,
    input.artifacts.length,
    JSON.stringify({
      evidence: input.evidenceCount,
      candidates: input.artifacts.length,
      approved: approved.length,
      rejected: input.artifacts.length - approved.length,
      failed_gate_distribution: input.failedGateDistribution,
      lifecycle_censoring: input.lifecycleCensoring ?? null,
    }),
  ))
  if (statements.length > S12_TW_CALIBRATION_BATCH_MAX_STATEMENTS) {
    throw new Error(
      `s12 calibration atomic batch exceeds ${S12_TW_CALIBRATION_BATCH_MAX_STATEMENTS} statements: ${statements.length}`,
    )
  }
  await db.batch(statements)
  return input.artifacts.length
}

export async function runS12TwCalibration(
  db: D1Database,
  options: {
    runDate: string
    cadence?: S12TwCalibrationCadence
    dryRun?: boolean
    replaceExistingRunArtifacts?: boolean
    lifecycleCensoring?: S12TwCalibrationLifecycleCensoring
    history?: S12CalibrationHistory
    beforeCommit?: () => Promise<void>
  },
): Promise<{ status: string; summary: string; artifacts: S12TwCalibrationArtifact[]; written: number }> {
  await ensureS12TwCalibrationTables(db)
  const cadence = options.cadence ?? 'weekly'
  const startDate = daysBefore(options.runDate, cadence === 'monthly' ? 180 : 90)
  const lifecycleCensoring = options.lifecycleCensoring
    ?? await inspectS12TwCalibrationLifecycleCensoring(db, options.runDate, cadence, options.history?.nowMs, options.history)
  const evidence = await loadS12TwCalibrationEvidence(db, startDate, options.runDate, options.history)
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
  if (options.dryRun !== true && options.beforeCommit) await options.beforeCommit()
  const written = options.dryRun === true
    ? 0
    : await commitS12TwCalibrationAtomically(db, {
        runId,
        runDate: options.runDate,
        cadence,
        artifacts,
        evidenceCount: evidence.length,
        scopesSeen: grouped.size,
        failedGateDistribution,
        lifecycleCensoring,
        replaceExistingRunArtifacts: options.replaceExistingRunArtifacts,
      })
  const status = approved.length ? (options.dryRun ? 'validated' : 'promoted') : 'frozen'
  return {
    status,
    summary: `s12_tw_calibration cadence=${cadence} status=${status} evidence=${evidence.length} scopes=${grouped.size} candidates=${artifacts.length} approved=${approved.length} rejected=${artifacts.length - approved.length} written=${written} lifecycle_complete=${lifecycleCensoring.completeRows} lifecycle_pending_terminal=${lifecycleCensoring.pendingMaturityTerminalRows} lifecycle_recent_enqueued_excluded=${lifecycleCensoring.recentEnqueuedRows} lifecycle_stale_enqueued_excluded=${lifecycleCensoring.staleEnqueuedRows} lifecycle_missing_or_other_excluded=${lifecycleCensoring.missingOrOtherRows} failed_gates=${JSON.stringify(failedGateDistribution)}`,
    artifacts,
    written,
  }
}
