import type { Bindings } from '../types'
import { databaseForDataDomain, shadowDatabaseForDataDomain } from './dataDomainRegistry'
import { SELECTION_REFERENCE_CONTRACT_VERSION } from './selectionReferenceEvidence'

export const PRICE_HORIZON_PROJECTION_VERSION = 'price_horizon_v3_canonical_reference_identity'
export const STRATEGY_MULTI_HORIZON_PROJECTION_VERSION = 'strategy_multi_horizon_price_v1'
export const STRATEGY_EVIDENCE_HORIZON_DAYS = [3, 5, 10] as const
export const PRICE_HORIZON_SOURCE = 'stock_prices:finlab_primary_canonical_mirror'
const MIN_SESSION_SAMPLE_SIZE = 100
const DEFAULT_LOOKBACK_DAYS = 120
const DEFAULT_MAX_SIGNAL_DATES = 60
const DEFAULT_MAX_PROCESS_DATES = 8
const RECENT_PRIORITY_SIGNAL_DATES = 2
const INCOMPLETE_RETRY_DAYS = 7
const UPSERT_ROWS_PER_STATEMENT = 8
const D1_BATCH_STATEMENTS = 20

type PriceRow = {
  stock_id: number
  open: number | null
  close: number | null
  adj_close: number | null
}

export type PriceHorizonLabel = {
  stockId: number
  priceDate: string
  entryDate: string
  entryRawOpen: number
  entryAdjustmentFactor: number
  exitDate: string
  exitRawClose: number
  exitAdjustmentFactor: number
}

export type PriceHorizonRejection = {
  stockId: number
  priceDate: string
  entryDate: string
  exitDate: string
  reason: string
}

export type PriceHorizonProjectionResult = {
  runId: string
  eligibleSignalDates: number
  processedSignalDates: number
  skippedCompleteDates: number
  deferredSignalDates: number
  candidateCount: number
  materializedCount: number
  rejectedCount: number
  breadthMaterializedCount: number
  status: 'success' | 'complete_with_rejections'
  summary: string
}

export type StrategyMultiHorizonProjectionResult = {
  horizons: number[]
  eligibleSignalDates: number
  processedSignalDates: number
  skippedCompleteDates: number
  deferredSignalDates: number
  candidateCount: number
  materializedCount: number
  rejectedCount: number
  status: 'success' | 'complete_with_rejections'
  summary: string
}

type ObservedSession = { session_date: string; sample_size: number }

export type PriceHorizonRow = {
  signal_date: string
  entry_date: string
  exit_date: string
}

export type PriceHorizonProjectionStatusRow = PriceHorizonRow & {
  status: string
  projection_version: string
  updated_at: string
}

export function planPriceHorizonWork(
  horizons: PriceHorizonRow[],
  statuses: PriceHorizonProjectionStatusRow[],
  options: { force?: boolean; maxProcessDates?: number; nowMs?: number; projectionVersion?: string } = {},
): {
  work: PriceHorizonRow[]
  skippedCompleteDates: number
  deferredSignalDates: number
} {
  const force = options.force === true
  const maxProcessDates = Math.max(1, Math.floor(options.maxProcessDates ?? DEFAULT_MAX_PROCESS_DATES))
  const retryAfterMs = INCOMPLETE_RETRY_DAYS * 86400_000
  const nowMs = options.nowMs ?? Date.now()
  const projectionVersion = options.projectionVersion ?? PRICE_HORIZON_PROJECTION_VERSION
  const statusByDate = new Map(statuses.map((row) => [row.signal_date, row]))
  const pending: PriceHorizonRow[] = []
  let skippedCompleteDates = 0
  let retryDeferredDates = 0

  for (const horizon of horizons) {
    const status = statusByDate.get(horizon.signal_date)
    const sameContract = status
      && status.entry_date === horizon.entry_date
      && status.exit_date === horizon.exit_date
      && status.projection_version === projectionVersion
    if (!force && sameContract && status.status === 'success') {
      skippedCompleteDates += 1
      continue
    }
    if (!force && sameContract && status.status === 'incomplete') {
      const normalized = status.updated_at.includes('T')
        ? status.updated_at
        : `${status.updated_at.replace(' ', 'T')}Z`
      const updatedAt = Date.parse(normalized)
      if (Number.isFinite(updatedAt) && nowMs - updatedAt < retryAfterMs) {
        retryDeferredDates += 1
        continue
      }
    }
    pending.push(horizon)
  }

  const ascending = [...pending].sort((left, right) => left.signal_date.localeCompare(right.signal_date))
  const recentCount = Math.min(RECENT_PRIORITY_SIGNAL_DATES, maxProcessDates, ascending.length)
  const recent = recentCount > 0 ? ascending.slice(-recentCount).reverse() : []
  const recentDates = new Set(recent.map((row) => row.signal_date))
  const backlog = ascending
    .filter((row) => !recentDates.has(row.signal_date))
    .slice(0, Math.max(0, maxProcessDates - recent.length))
  const work = [...recent, ...backlog]
  return {
    work,
    skippedCompleteDates,
    deferredSignalDates: retryDeferredDates + pending.length - work.length,
  }
}

async function materializeMissingMarketBreadth(
  db: D1Database,
  sessions: ObservedSession[],
  limit: number,
): Promise<number> {
  if (sessions.length < 2) return 0
  const firstDate = sessions[0].session_date
  const lastDate = sessions[sessions.length - 1].session_date
  const { results: completeRows } = await db.prepare(`
    SELECT date
      FROM market_breadth
     WHERE date >= ? AND date <= ?
       AND sample_size IS NOT NULL
       AND limit_down_count IS NOT NULL
  `).bind(firstDate, lastDate).all<{ date: string }>()
  const complete = new Set((completeRows ?? []).map((row) => row.date))
  const missing = new Set(
    sessions
      .slice(1)
      .filter((row) => !complete.has(row.session_date))
      .slice(0, Math.max(1, limit))
      .map((row) => row.session_date),
  )
  let materialized = 0
  for (let index = 1; index < sessions.length; index += 1) {
    const row = sessions[index]
    if (!missing.has(row.session_date)) continue
    const previousDate = sessions[index - 1]?.session_date
    if (!previousDate) continue
    const breadth = await db.prepare(`
      SELECT
        COUNT(*) AS sample_size,
        SUM(CASE WHEN cur.close > prev.close THEN 1 ELSE 0 END) AS advance_count,
        SUM(CASE WHEN cur.close < prev.close THEN 1 ELSE 0 END) AS decline_count,
        SUM(CASE WHEN cur.close = prev.close THEN 1 ELSE 0 END) AS unchanged_count,
        SUM(CASE WHEN cur.open > 0 AND cur.close >= cur.open * 0.9
                  AND cur.close <= cur.open * 0.905 THEN 1 ELSE 0 END) AS limit_down_count
      FROM stock_prices cur INDEXED BY idx_prices_date_stock
      JOIN stock_prices prev
        ON prev.stock_id = cur.stock_id AND prev.date = ?
     WHERE cur.date = ? AND cur.close > 0 AND prev.close > 0
    `).bind(previousDate, row.session_date).first<{
      sample_size: number | null
      advance_count: number | null
      decline_count: number | null
      unchanged_count: number | null
      limit_down_count: number | null
    }>()
    const sampleSize = Number(breadth?.sample_size ?? 0)
    if (sampleSize < MIN_SESSION_SAMPLE_SIZE) continue
    const advanceCount = Number(breadth?.advance_count ?? 0)
    const declineCount = Number(breadth?.decline_count ?? 0)
    const unchangedCount = Number(breadth?.unchanged_count ?? 0)
    const limitDownCount = Number(breadth?.limit_down_count ?? 0)
    await db.prepare(`
      INSERT INTO market_breadth (
        date, advance_count, decline_count, unchanged_count, advance_ratio,
        sample_size, limit_down_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        advance_count=excluded.advance_count,
        decline_count=excluded.decline_count,
        unchanged_count=excluded.unchanged_count,
        advance_ratio=excluded.advance_ratio,
        sample_size=excluded.sample_size,
        limit_down_count=excluded.limit_down_count
    `).bind(
      row.session_date,
      advanceCount,
      declineCount,
      unchangedCount,
      sampleSize > 0 ? advanceCount / sampleSize : null,
      sampleSize,
      limitDownCount,
    ).run()
    materialized += 1
  }
  return materialized
}

function isoDate(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid_${name}:${value}`)
  return value
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function positive(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function adjustmentFactor(row: PriceRow | undefined): number | null {
  const close = positive(row?.close)
  const adjustedClose = positive(row?.adj_close)
  if (!close || !adjustedClose) return null
  return adjustedClose / close
}

export function buildPriceHorizonObservations(
  candidateStockIds: number[],
  priceDate: string,
  entryDate: string,
  exitDate: string,
  entryRows: PriceRow[],
  exitRows: PriceRow[],
): { labels: PriceHorizonLabel[]; rejections: PriceHorizonRejection[] } {
  const entryByStock = new Map(entryRows.map((row) => [Number(row.stock_id), row]))
  const exitByStock = new Map(exitRows.map((row) => [Number(row.stock_id), row]))
  const labels: PriceHorizonLabel[] = []
  const rejections: PriceHorizonRejection[] = []

  for (const stockId of [...new Set(candidateStockIds.map(Number))].sort((a, b) => a - b)) {
    const entry = entryByStock.get(stockId)
    const exit = exitByStock.get(stockId)
    const entryOpen = positive(entry?.open)
    const exitClose = positive(exit?.close)
    const entryFactor = adjustmentFactor(entry)
    const exitFactor = adjustmentFactor(exit)
    let reason = ''
    if (!entry) reason = 'entry_price_row_missing'
    else if (!exit) reason = 'exit_price_row_missing'
    else if (!entryOpen) reason = 'entry_open_invalid'
    else if (!exitClose) reason = 'exit_close_invalid'
    else if (!entryFactor) reason = 'entry_adjustment_factor_invalid'
    else if (!exitFactor) reason = 'exit_adjustment_factor_invalid'

    if (reason) {
      rejections.push({ stockId, priceDate, entryDate, exitDate, reason })
      continue
    }
    labels.push({
      stockId,
      priceDate,
      entryDate,
      entryRawOpen: entryOpen!,
      entryAdjustmentFactor: entryFactor!,
      exitDate,
      exitRawClose: exitClose!,
      exitAdjustmentFactor: exitFactor!,
    })
  }
  return { labels, rejections }
}

function chunks<T>(rows: T[], size: number): T[][] {
  const output: T[][] = []
  for (let index = 0; index < rows.length; index += size) output.push(rows.slice(index, index + size))
  return output
}

async function executeStatementBatches(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  for (const group of chunks(statements, D1_BATCH_STATEMENTS)) {
    if (group.length) await db.batch(group)
  }
}

async function loadProjectionStatuses(
  db: D1Database,
  horizons: PriceHorizonRow[],
): Promise<PriceHorizonProjectionStatusRow[]> {
  if (!horizons.length) return []
  const dates = [...new Set(horizons.map((row) => row.signal_date))]
  const placeholders = dates.map(() => '?').join(',')
  const { results } = await db.prepare(`
    SELECT signal_date, entry_date, exit_date, status, projection_version, updated_at
      FROM price_horizon_projection_status
     WHERE signal_date IN (${placeholders})
  `).bind(...dates).all<PriceHorizonProjectionStatusRow>()
  return results ?? []
}

async function loadPriceRows(db: D1Database, date: string): Promise<PriceRow[]> {
  const { results } = await db.prepare(`
    SELECT stock_id, open, close, adj_close
      FROM stock_prices INDEXED BY idx_prices_date_stock
     WHERE date = ?
  `).bind(date).all<PriceRow>()
  return results ?? []
}

type CandidateIdentityCoverage = {
  stockIds: number[]
  referenceRows: number
  identifiedReferenceRows: number
}

async function loadCandidateSignalDates(
  db: D1Database,
  startDate: string,
  endDate: string,
): Promise<Set<string>> {
  const result = await db.prepare(`
    SELECT DISTINCT signal_date
      FROM (
        SELECT signal_date
          FROM selection_reference_snapshots_v1
         WHERE signal_date >= ? AND signal_date <= ? AND hard_gate_passed=1
        UNION ALL
        SELECT snapshot_date AS signal_date
          FROM allocator_ev_feature_snapshots
         WHERE snapshot_date >= ? AND snapshot_date <= ?
        UNION ALL
        SELECT snapshot_date AS signal_date
          FROM allocator_ev_oof_snapshots
         WHERE snapshot_date >= ? AND snapshot_date <= ?
        UNION ALL
        SELECT prediction_date AS signal_date
          FROM predictions
         WHERE prediction_date >= ? AND prediction_date <= ? AND model_name='ensemble'
      )
  `).bind(startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate).all<{ signal_date: string }>()
  return new Set((result.results ?? []).map((row) => String(row.signal_date ?? '').slice(0, 10)).filter(Boolean))
}

async function loadCandidateStockIds(db: D1Database, signalDate: string): Promise<CandidateIdentityCoverage> {
  const reference = await db.prepare(`
    SELECT COUNT(DISTINCT symbol) reference_rows,
           COUNT(DISTINCT CASE WHEN stock_id IS NOT NULL THEN symbol END) identified_reference_rows
      FROM selection_reference_snapshots_v1
     WHERE signal_date=? AND hard_gate_passed=1 AND feature_contract_version=?
  `).bind(signalDate, SELECTION_REFERENCE_CONTRACT_VERSION).first<{
    reference_rows: number
    identified_reference_rows: number
  }>()
  const { results } = await db.prepare(`
    SELECT DISTINCT stock_id
      FROM (
        SELECT stock_id
          FROM selection_reference_snapshots_v1
         WHERE signal_date = ? AND hard_gate_passed = 1
        UNION ALL
        SELECT stock_id
          FROM allocator_ev_feature_snapshots
         WHERE snapshot_date = ?
        UNION ALL
        SELECT stock_id
          FROM allocator_ev_oof_snapshots
         WHERE snapshot_date = ?
        UNION ALL
        SELECT stock_id
          FROM predictions
         WHERE prediction_date = ? AND model_name = 'ensemble'
      )
     WHERE stock_id IS NOT NULL
     ORDER BY stock_id
  `).bind(signalDate, signalDate, signalDate, signalDate).all<{ stock_id: number }>()
  return {
    stockIds: (results ?? []).map((row) => Number(row.stock_id)).filter((value) => Number.isInteger(value) && value > 0),
    referenceRows: Number(reference?.reference_rows ?? 0),
    identifiedReferenceRows: Number(reference?.identified_reference_rows ?? 0),
  }
}

async function upsertLabels(db: D1Database, rows: PriceHorizonLabel[]): Promise<void> {
  const statements = chunks(rows, UPSERT_ROWS_PER_STATEMENT).map((group) => {
    const values = group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const params = group.flatMap((row) => [
      row.stockId, row.priceDate, row.entryDate, row.entryRawOpen, row.entryAdjustmentFactor,
      row.exitDate, row.exitRawClose, row.exitAdjustmentFactor, row.exitDate,
      PRICE_HORIZON_SOURCE, PRICE_HORIZON_PROJECTION_VERSION,
    ])
    return db.prepare(`
      INSERT INTO price_horizon_labels_v1 (
        stock_id, price_date, entry_date, entry_raw_open, entry_adjustment_factor,
        exit_date, exit_raw_close, exit_adjustment_factor, outcome_known_date,
        source, projection_version
      ) VALUES ${values}
      ON CONFLICT(stock_id, price_date) DO UPDATE SET
        entry_date=excluded.entry_date,
        entry_raw_open=excluded.entry_raw_open,
        entry_adjustment_factor=excluded.entry_adjustment_factor,
        exit_date=excluded.exit_date,
        exit_raw_close=excluded.exit_raw_close,
        exit_adjustment_factor=excluded.exit_adjustment_factor,
        outcome_known_date=excluded.outcome_known_date,
        source=excluded.source,
        projection_version=excluded.projection_version,
        materialized_at=CURRENT_TIMESTAMP
    `).bind(...params)
  })
  await executeStatementBatches(db, statements)
}

async function upsertRejections(db: D1Database, rows: PriceHorizonRejection[]): Promise<void> {
  const statements = chunks(rows, UPSERT_ROWS_PER_STATEMENT).map((group) => {
    const values = group.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')
    const params = group.flatMap((row) => [
      row.stockId, row.priceDate, row.entryDate, row.exitDate, row.reason,
      PRICE_HORIZON_SOURCE, PRICE_HORIZON_PROJECTION_VERSION,
    ])
    return db.prepare(`
      INSERT INTO price_horizon_label_rejections_v1 (
        stock_id, price_date, entry_date, exit_date, rejection_reason, source, projection_version
      ) VALUES ${values}
      ON CONFLICT(stock_id, price_date) DO UPDATE SET
        entry_date=excluded.entry_date,
        exit_date=excluded.exit_date,
        rejection_reason=excluded.rejection_reason,
        source=excluded.source,
        projection_version=excluded.projection_version,
        updated_at=CURRENT_TIMESTAMP
    `).bind(...params)
  })
  await executeStatementBatches(db, statements)
}

async function deleteResolvedRejections(db: D1Database, priceDate: string, stockIds: number[]): Promise<void> {
  const statements = chunks(stockIds, 80).map((group) => {
    const placeholders = group.map(() => '?').join(',')
    return db.prepare(`
      DELETE FROM price_horizon_label_rejections_v1
       WHERE price_date = ? AND stock_id IN (${placeholders})
    `).bind(priceDate, ...group)
  })
  await executeStatementBatches(db, statements)
}

async function deleteRejectedLabels(db: D1Database, priceDate: string, stockIds: number[]): Promise<void> {
  const statements = chunks(stockIds, 80).map((group) => {
    const placeholders = group.map(() => '?').join(',')
    return db.prepare(`
      DELETE FROM price_horizon_labels_v1
       WHERE price_date = ? AND stock_id IN (${placeholders})
    `).bind(priceDate, ...group)
  })
  await executeStatementBatches(db, statements)
}

export async function materializePriceHorizonLabels(
  env: Bindings,
  options: {
    startDate?: string
    endDate?: string
    outcomeAsOfDate?: string
    maxSignalDates?: number
    maxProcessDates?: number
    force?: boolean
  } = {},
): Promise<PriceHorizonProjectionResult> {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const outcomeAsOfDate = isoDate(options.outcomeAsOfDate ?? today, 'outcome_as_of_date')
  const endDate = isoDate(options.endDate ?? outcomeAsOfDate, 'end_date')
  const startDate = isoDate(options.startDate ?? shiftDate(endDate, -DEFAULT_LOOKBACK_DAYS), 'start_date')
  if (startDate > endDate || endDate > outcomeAsOfDate) throw new Error('invalid_price_horizon_date_range')
  const maxSignalDates = Math.max(1, Math.min(Number(options.maxSignalDates ?? DEFAULT_MAX_SIGNAL_DATES), 260))
  const maxProcessDates = Math.max(1, Math.min(Number(options.maxProcessDates ?? DEFAULT_MAX_PROCESS_DATES), 40))
  const runId = `price-horizon-${startDate}-${endDate}-${Date.now().toString(36)}`
  const marketDb = databaseForDataDomain(env, 'market')
  const learningDb = databaseForDataDomain(env, 'learning')
  const opsDb = databaseForDataDomain(env, 'ops')

  await opsDb.prepare(`
    UPDATE price_horizon_projection_runs
       SET status='error', last_error='stale_projection_run_superseded', completed_at=CURRENT_TIMESTAMP
     WHERE status='running' AND started_at < datetime('now', '-15 minutes')
  `).run()
  await opsDb.prepare(`
    INSERT INTO price_horizon_projection_runs (
      run_id, start_date, end_date, outcome_as_of_date, status
    ) VALUES (?, ?, ?, ?, 'running')
  `).bind(runId, startDate, endDate, outcomeAsOfDate).run()

  try {
    const sessionStart = shiftDate(startDate, -14)
    const { results: observedSessions } = await marketDb.prepare(`
      SELECT date AS session_date, COUNT(*) AS sample_size
        FROM stock_prices INDEXED BY idx_prices_date_stock
       WHERE date >= ? AND date <= ? AND close > 0
       GROUP BY date
      HAVING COUNT(*) >= ?
       ORDER BY date
    `).bind(sessionStart, outcomeAsOfDate, MIN_SESSION_SAMPLE_SIZE).all<ObservedSession>()
    for (const group of chunks(observedSessions ?? [], 20)) {
      const statements = group.map((row) => marketDb.prepare(`
        INSERT INTO market_trading_sessions (session_date, source, sample_size)
        VALUES (?, ?, ?)
        ON CONFLICT(session_date) DO UPDATE SET
          source=excluded.source,
          sample_size=excluded.sample_size,
          materialized_at=CURRENT_TIMESTAMP
      `).bind(row.session_date, PRICE_HORIZON_SOURCE, Number(row.sample_size)))
      if (statements.length) await marketDb.batch(statements)
    }
    const breadthMaterializedCount = await materializeMissingMarketBreadth(
      marketDb,
      observedSessions ?? [],
      maxSignalDates,
    )

    const { results: horizonRows } = await marketDb.prepare(`
      WITH horizons AS (
        SELECT s.session_date AS signal_date,
               (SELECT e.session_date FROM market_trading_sessions e
                 WHERE e.session_date > s.session_date ORDER BY e.session_date LIMIT 1) AS entry_date,
               (SELECT x.session_date FROM market_trading_sessions x
                 WHERE x.session_date > s.session_date ORDER BY x.session_date LIMIT 1 OFFSET 4) AS exit_date
          FROM market_trading_sessions s
         WHERE s.session_date >= ? AND s.session_date <= ?
      )
      SELECT signal_date, entry_date, exit_date
        FROM horizons
       WHERE entry_date IS NOT NULL AND exit_date IS NOT NULL AND exit_date <= ?
       ORDER BY signal_date DESC
       LIMIT ?
    `).bind(startDate, endDate, outcomeAsOfDate, maxSignalDates).all<{
      signal_date: string
      entry_date: string
      exit_date: string
    }>()

    const candidateSignalDates = await loadCandidateSignalDates(learningDb, startDate, endDate)
    const horizons = (horizonRows ?? []).filter((row) => candidateSignalDates.has(row.signal_date))
    const existingStatuses = await loadProjectionStatuses(opsDb, horizons)
    const plan = planPriceHorizonWork(horizons, existingStatuses, {
      force: options.force,
      maxProcessDates,
    })
    let processedSignalDates = 0
    const skippedCompleteDates = plan.skippedCompleteDates
    const deferredSignalDates = plan.deferredSignalDates
    let candidateCount = 0
    let materializedCount = 0
    let rejectedCount = 0

    for (const horizon of plan.work) {
      const candidateCoverage = await loadCandidateStockIds(learningDb, horizon.signal_date)
      const candidates = candidateCoverage.stockIds
      if (
        candidateCoverage.referenceRows > 0
        && candidateCoverage.identifiedReferenceRows !== candidateCoverage.referenceRows
      ) {
        throw new Error(
          `price_horizon_reference_identity_incomplete:${horizon.signal_date}:${candidateCoverage.identifiedReferenceRows}/${candidateCoverage.referenceRows}`,
        )
      }
      if (candidates.length === 0) {
        throw new Error(`price_horizon_candidate_identity_empty:${horizon.signal_date}`)
      }

      const [entryRows, exitRows] = await Promise.all([
        loadPriceRows(marketDb, horizon.entry_date),
        loadPriceRows(marketDb, horizon.exit_date),
      ])
      const observations = buildPriceHorizonObservations(
        candidates,
        horizon.signal_date,
        horizon.entry_date,
        horizon.exit_date,
        entryRows,
        exitRows,
      )
      await upsertLabels(learningDb, observations.labels)
      await upsertRejections(learningDb, observations.rejections)
      await deleteResolvedRejections(
        learningDb,
        horizon.signal_date,
        observations.labels.map((row) => row.stockId),
      )
      await deleteRejectedLabels(
        learningDb,
        horizon.signal_date,
        observations.rejections.map((row) => row.stockId),
      )
      // Explicit rejections are terminal unavailable outcomes, not missing projection work.
      const status = 'success'
      await opsDb.prepare(`
        INSERT INTO price_horizon_projection_status (
          signal_date, entry_date, exit_date, candidate_count, materialized_count,
          rejected_count, status, source, projection_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(signal_date) DO UPDATE SET
          entry_date=excluded.entry_date,
          exit_date=excluded.exit_date,
          candidate_count=excluded.candidate_count,
          materialized_count=excluded.materialized_count,
          rejected_count=excluded.rejected_count,
          status=excluded.status,
          source=excluded.source,
          projection_version=excluded.projection_version,
          updated_at=CURRENT_TIMESTAMP
      `).bind(
        horizon.signal_date, horizon.entry_date, horizon.exit_date, candidates.length,
        observations.labels.length, observations.rejections.length, status,
        PRICE_HORIZON_SOURCE, PRICE_HORIZON_PROJECTION_VERSION,
      ).run()
      processedSignalDates += 1
      candidateCount += candidates.length
      materializedCount += observations.labels.length
      rejectedCount += observations.rejections.length
    }

    const status = rejectedCount > 0 ? 'complete_with_rejections' : 'success'
    await opsDb.prepare(`
      UPDATE price_horizon_projection_runs
         SET eligible_signal_dates=?, processed_signal_dates=?, skipped_complete_dates=?,
             candidate_count=?, materialized_count=?, rejected_count=?, status=?,
             completed_at=CURRENT_TIMESTAMP
       WHERE run_id=?
    `).bind(
      horizons.length, processedSignalDates, skippedCompleteDates,
      candidateCount, materializedCount, rejectedCount, status, runId,
    ).run()
    const summary = [
      `price_horizon_projection run_id=${runId}`,
      `eligible_dates=${horizons.length}`,
      `processed_dates=${processedSignalDates}`,
      `skipped_complete_dates=${skippedCompleteDates}`,
      `deferred_dates=${deferredSignalDates}`,
      `candidates=${candidateCount}`,
      `materialized=${materializedCount}`,
      `rejected=${rejectedCount}`,
      `breadth_materialized=${breadthMaterializedCount}`,
      `status=${status}`,
    ].join(' ')
    return {
      runId,
      eligibleSignalDates: horizons.length,
      processedSignalDates,
      skippedCompleteDates,
      deferredSignalDates,
      candidateCount,
      materializedCount,
      rejectedCount,
      breadthMaterializedCount,
      status,
      summary,
    }
  } catch (error) {
    await opsDb.prepare(`
      UPDATE price_horizon_projection_runs
         SET status='error', last_error=?, completed_at=CURRENT_TIMESTAMP
       WHERE run_id=?
    `).bind(String(error), runId).run().catch(() => undefined)
    throw error
  }
}

async function upsertMultiHorizonLabels(
  db: D1Database,
  horizonDays: number,
  rows: PriceHorizonLabel[],
): Promise<void> {
  const statements = chunks(rows, UPSERT_ROWS_PER_STATEMENT).map((group) => {
    const values = group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const params = group.flatMap((row) => [
      row.stockId, row.priceDate, horizonDays, row.entryDate, row.entryRawOpen,
      row.entryAdjustmentFactor, row.exitDate, row.exitRawClose, row.exitAdjustmentFactor,
      row.exitDate, PRICE_HORIZON_SOURCE, STRATEGY_MULTI_HORIZON_PROJECTION_VERSION,
    ])
    return db.prepare(`
      INSERT INTO price_horizon_labels_v2 (
        stock_id, price_date, horizon_days, entry_date, entry_raw_open,
        entry_adjustment_factor, exit_date, exit_raw_close, exit_adjustment_factor,
        outcome_known_date, source, projection_version
      ) VALUES ${values}
      ON CONFLICT(stock_id, price_date, horizon_days) DO UPDATE SET
        entry_date=excluded.entry_date,
        entry_raw_open=excluded.entry_raw_open,
        entry_adjustment_factor=excluded.entry_adjustment_factor,
        exit_date=excluded.exit_date,
        exit_raw_close=excluded.exit_raw_close,
        exit_adjustment_factor=excluded.exit_adjustment_factor,
        outcome_known_date=excluded.outcome_known_date,
        source=excluded.source,
        projection_version=excluded.projection_version,
        materialized_at=CURRENT_TIMESTAMP
    `).bind(...params)
  })
  await executeStatementBatches(db, statements)
}

async function upsertMultiHorizonRejections(
  db: D1Database,
  horizonDays: number,
  rows: PriceHorizonRejection[],
): Promise<void> {
  const statements = chunks(rows, UPSERT_ROWS_PER_STATEMENT).map((group) => {
    const values = group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const params = group.flatMap((row) => [
      row.stockId, row.priceDate, horizonDays, row.entryDate, row.exitDate,
      row.reason, PRICE_HORIZON_SOURCE, STRATEGY_MULTI_HORIZON_PROJECTION_VERSION,
    ])
    return db.prepare(`
      INSERT INTO price_horizon_label_rejections_v2 (
        stock_id, price_date, horizon_days, entry_date, exit_date,
        rejection_reason, source, projection_version
      ) VALUES ${values}
      ON CONFLICT(stock_id, price_date, horizon_days) DO UPDATE SET
        entry_date=excluded.entry_date,
        exit_date=excluded.exit_date,
        rejection_reason=excluded.rejection_reason,
        source=excluded.source,
        projection_version=excluded.projection_version,
        updated_at=CURRENT_TIMESTAMP
    `).bind(...params)
  })
  await executeStatementBatches(db, statements)
}

export async function materializeStrategyMultiHorizonPriceLabels(
  env: Bindings,
  options: {
    startDate?: string
    endDate?: string
    outcomeAsOfDate?: string
    maxSignalDates?: number
    maxProcessDates?: number
    force?: boolean
  } = {},
): Promise<StrategyMultiHorizonProjectionResult> {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const outcomeAsOfDate = isoDate(options.outcomeAsOfDate ?? today, 'outcome_as_of_date')
  const endDate = isoDate(options.endDate ?? outcomeAsOfDate, 'end_date')
  const startDate = isoDate(options.startDate ?? shiftDate(endDate, -DEFAULT_LOOKBACK_DAYS), 'start_date')
  if (startDate > endDate || endDate > outcomeAsOfDate) throw new Error('invalid_multi_horizon_date_range')
  const maxSignalDates = Math.max(1, Math.min(Number(options.maxSignalDates ?? DEFAULT_MAX_SIGNAL_DATES), 260))
  const maxProcessDates = Math.max(1, Math.min(Number(options.maxProcessDates ?? DEFAULT_MAX_PROCESS_DATES), 40))
  const marketDb = databaseForDataDomain(env, 'market')
  const sourceLearningDb = databaseForDataDomain(env, 'learning')
  const targetLearningDb = shadowDatabaseForDataDomain(env, 'learning') ?? sourceLearningDb
  const sourceOpsDb = databaseForDataDomain(env, 'ops')
  const targetOpsDb = shadowDatabaseForDataDomain(env, 'ops') ?? sourceOpsDb
  const candidateSignalDates = await loadCandidateSignalDates(sourceLearningDb, startDate, endDate)
  let eligibleSignalDates = 0
  let processedSignalDates = 0
  let skippedCompleteDates = 0
  let deferredSignalDates = 0
  let candidateCount = 0
  let materializedCount = 0
  let rejectedCount = 0

  for (const horizonDays of STRATEGY_EVIDENCE_HORIZON_DAYS) {
    const exitOffset = horizonDays - 1
    const horizonResult = await marketDb.prepare(`
      WITH horizons AS (
        SELECT s.session_date AS signal_date,
               (SELECT e.session_date FROM market_trading_sessions e
                 WHERE e.session_date > s.session_date ORDER BY e.session_date LIMIT 1) AS entry_date,
               (SELECT x.session_date FROM market_trading_sessions x
                 WHERE x.session_date > s.session_date ORDER BY x.session_date LIMIT 1 OFFSET ${exitOffset}) AS exit_date
          FROM market_trading_sessions s
         WHERE s.session_date >= ? AND s.session_date <= ?
      )
      SELECT signal_date, entry_date, exit_date
        FROM horizons
       WHERE entry_date IS NOT NULL AND exit_date IS NOT NULL AND exit_date <= ?
       ORDER BY signal_date DESC
       LIMIT ?
    `).bind(startDate, endDate, outcomeAsOfDate, maxSignalDates).all<PriceHorizonRow>()
    const horizons = (horizonResult.results ?? []).filter((row) => candidateSignalDates.has(row.signal_date))
    eligibleSignalDates += horizons.length
    const statusResult = horizons.length
      ? await targetOpsDb.prepare(`
          SELECT signal_date, entry_date, exit_date, status, projection_version, updated_at
            FROM price_horizon_projection_status_v2
           WHERE horizon_days=? AND signal_date >= ? AND signal_date <= ?
        `).bind(horizonDays, startDate, endDate).all<PriceHorizonProjectionStatusRow>()
      : { results: [] as PriceHorizonProjectionStatusRow[] }
    const plan = planPriceHorizonWork(horizons, statusResult.results ?? [], {
      force: options.force,
      maxProcessDates,
      projectionVersion: STRATEGY_MULTI_HORIZON_PROJECTION_VERSION,
    })
    skippedCompleteDates += plan.skippedCompleteDates
    deferredSignalDates += plan.deferredSignalDates
    for (const horizon of plan.work) {
      const coverage = await loadCandidateStockIds(sourceLearningDb, horizon.signal_date)
      if (coverage.referenceRows > 0 && coverage.identifiedReferenceRows !== coverage.referenceRows) {
        throw new Error(`multi_horizon_reference_identity_incomplete:${horizonDays}:${horizon.signal_date}`)
      }
      if (!coverage.stockIds.length) throw new Error(`multi_horizon_candidate_identity_empty:${horizonDays}:${horizon.signal_date}`)
      const [entryRows, exitRows] = await Promise.all([
        loadPriceRows(marketDb, horizon.entry_date),
        loadPriceRows(marketDb, horizon.exit_date),
      ])
      const observations = buildPriceHorizonObservations(
        coverage.stockIds, horizon.signal_date, horizon.entry_date, horizon.exit_date,
        entryRows, exitRows,
      )
      await upsertMultiHorizonLabels(targetLearningDb, horizonDays, observations.labels)
      await upsertMultiHorizonRejections(targetLearningDb, horizonDays, observations.rejections)
      const resolved = observations.labels.map((row) => targetLearningDb.prepare(`
        DELETE FROM price_horizon_label_rejections_v2
         WHERE stock_id=? AND price_date=? AND horizon_days=?
      `).bind(row.stockId, row.priceDate, horizonDays))
      await executeStatementBatches(targetLearningDb, resolved)
      await targetOpsDb.prepare(`
        INSERT INTO price_horizon_projection_status_v2 (
          signal_date, horizon_days, entry_date, exit_date, candidate_count,
          materialized_count, rejected_count, status, source, projection_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'success', ?, ?)
        ON CONFLICT(signal_date, horizon_days) DO UPDATE SET
          entry_date=excluded.entry_date, exit_date=excluded.exit_date,
          candidate_count=excluded.candidate_count, materialized_count=excluded.materialized_count,
          rejected_count=excluded.rejected_count, status=excluded.status,
          source=excluded.source, projection_version=excluded.projection_version,
          updated_at=CURRENT_TIMESTAMP
      `).bind(
        horizon.signal_date, horizonDays, horizon.entry_date, horizon.exit_date,
        coverage.stockIds.length, observations.labels.length, observations.rejections.length,
        PRICE_HORIZON_SOURCE, STRATEGY_MULTI_HORIZON_PROJECTION_VERSION,
      ).run()
      processedSignalDates += 1
      candidateCount += coverage.stockIds.length
      materializedCount += observations.labels.length
      rejectedCount += observations.rejections.length
    }
  }
  const status = rejectedCount > 0 ? 'complete_with_rejections' : 'success'
  const summary = `strategy_multi_horizon horizons=3,5,10 eligible=${eligibleSignalDates} processed=${processedSignalDates} skipped=${skippedCompleteDates} deferred=${deferredSignalDates} candidates=${candidateCount} materialized=${materializedCount} rejected=${rejectedCount} status=${status}`
  return { horizons: [...STRATEGY_EVIDENCE_HORIZON_DAYS], eligibleSignalDates, processedSignalDates,
    skippedCompleteDates, deferredSignalDates, candidateCount, materializedCount, rejectedCount, status, summary }
}
