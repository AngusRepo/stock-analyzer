import type { Bindings } from '../types'

export type AllocatorEvLifecycleState =
  | 'lineage_ready'
  | 'snapshot_ready'
  | 'verify_triggered'
  | 'replay_pending_maturity'
  | 'replay_enqueued'
  | 'replay_complete'
  | 'error'

export interface AllocatorEvLifecycleRow {
  business_date: string
  state: AllocatorEvLifecycleState
  native_lineage_rows: number
  snapshot_run_id: string | null
  snapshot_rows: number
  replay_rows: number
  replay_maturity_as_of_date: string | null
  upstream_run_id: string | null
  attempt_count: number
  last_error: string | null
  updated_at: string
}

export interface AllocatorSnapshotClosure {
  businessDate: string
  recommendationRows: number
  nativeLineageRows: number
  runNativeLineageRows: number
  reconstructedLineageRows: number
  rejectedLineageRows: number
  snapshotRunId: string | null
  expectedRows: number
  publishedRows: number
  actualRows: number
  ready: boolean
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export async function readAllocatorEvLifecycle(
  db: D1Database,
  businessDate: string,
): Promise<AllocatorEvLifecycleRow | null> {
  return await db.prepare(`
    SELECT business_date, state, native_lineage_rows, snapshot_run_id,
           snapshot_rows, replay_rows, replay_maturity_as_of_date,
           upstream_run_id, attempt_count, last_error, updated_at
      FROM allocator_ev_daily_lifecycle
     WHERE business_date = ?
     LIMIT 1
  `).bind(businessDate).first<AllocatorEvLifecycleRow>()
}

export async function recordAllocatorEvLifecycle(
  db: D1Database,
  input: {
    businessDate: string
    state: AllocatorEvLifecycleState
    nativeLineageRows?: number
    snapshotRunId?: string | null
    snapshotRows?: number
    replayRows?: number
    replayMaturityAsOfDate?: string | null
    upstreamRunId?: string | null
    lastError?: string | null
    incrementAttempt?: boolean
  },
): Promise<void> {
  if (!validDate(input.businessDate)) throw new Error(`invalid allocator EV lifecycle date: ${input.businessDate}`)
  const closed = input.state === 'replay_complete' ? new Date().toISOString() : null
  await db.prepare(`
    INSERT INTO allocator_ev_daily_lifecycle (
      business_date, state, native_lineage_rows, snapshot_run_id,
      snapshot_rows, replay_rows, replay_maturity_as_of_date,
      upstream_run_id, attempt_count, last_error, created_at, updated_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(business_date) DO UPDATE SET
      state = CASE
        WHEN allocator_ev_daily_lifecycle.state = 'replay_complete' THEN allocator_ev_daily_lifecycle.state
        WHEN excluded.state = 'error' THEN excluded.state
        WHEN allocator_ev_daily_lifecycle.state = 'replay_enqueued'
         AND excluded.state = 'replay_pending_maturity' THEN excluded.state
        WHEN (CASE excluded.state
          WHEN 'lineage_ready' THEN 1 WHEN 'snapshot_ready' THEN 2 WHEN 'verify_triggered' THEN 3
          WHEN 'replay_pending_maturity' THEN 4 WHEN 'replay_enqueued' THEN 5 WHEN 'replay_complete' THEN 6
          ELSE 0 END) >=
          (CASE allocator_ev_daily_lifecycle.state
          WHEN 'lineage_ready' THEN 1 WHEN 'snapshot_ready' THEN 2 WHEN 'verify_triggered' THEN 3
          WHEN 'replay_pending_maturity' THEN 4 WHEN 'replay_enqueued' THEN 5 WHEN 'replay_complete' THEN 6
          ELSE 0 END)
        THEN excluded.state
        ELSE allocator_ev_daily_lifecycle.state
      END,
      native_lineage_rows = MAX(allocator_ev_daily_lifecycle.native_lineage_rows, excluded.native_lineage_rows),
      snapshot_run_id = COALESCE(excluded.snapshot_run_id, allocator_ev_daily_lifecycle.snapshot_run_id),
      snapshot_rows = MAX(allocator_ev_daily_lifecycle.snapshot_rows, excluded.snapshot_rows),
      replay_rows = MAX(allocator_ev_daily_lifecycle.replay_rows, excluded.replay_rows),
      replay_maturity_as_of_date = COALESCE(excluded.replay_maturity_as_of_date, allocator_ev_daily_lifecycle.replay_maturity_as_of_date),
      upstream_run_id = COALESCE(excluded.upstream_run_id, allocator_ev_daily_lifecycle.upstream_run_id),
      attempt_count = allocator_ev_daily_lifecycle.attempt_count + excluded.attempt_count,
      last_error = excluded.last_error,
      updated_at = CURRENT_TIMESTAMP,
      closed_at = COALESCE(excluded.closed_at, allocator_ev_daily_lifecycle.closed_at)
  `).bind(
    input.businessDate,
    input.state,
    Math.max(0, Number(input.nativeLineageRows ?? 0)),
    input.snapshotRunId ?? null,
    Math.max(0, Number(input.snapshotRows ?? 0)),
    Math.max(0, Number(input.replayRows ?? 0)),
    input.replayMaturityAsOfDate ?? null,
    input.upstreamRunId ?? null,
    input.incrementAttempt ? 1 : 0,
    input.lastError ?? null,
    closed,
  ).run()
}

export async function inspectAllocatorSnapshotClosure(
  db: D1Database,
  businessDate: string,
  options: { allowPointInTimeReconstruction?: boolean } = {},
): Promise<AllocatorSnapshotClosure> {
  if (!validDate(businessDate)) throw new Error(`invalid allocator snapshot date: ${businessDate}`)
  const [lineage, run, actual] = await Promise.all([
    db.prepare(`
      WITH next_executable_session AS (
        SELECT MIN(date(c.date)) AS session_date
          FROM canonical_market_daily c
         WHERE c.stock_id = '0050'
           AND c.source = 'finlab.price'
           AND date(c.date) > date(?)
      )
      SELECT
        COUNT(*) AS recommendation_rows,
        COALESCE(SUM(CASE WHEN EXISTS (
          SELECT 1
            FROM predictions p
            CROSS JOIN next_executable_session next_session
           WHERE p.stock_id = dr.stock_id
             AND p.prediction_date >= dr.date
             AND p.prediction_date < date(dr.date, '+1 day')
             AND p.model_name = 'ensemble'
             AND p.forecast_data IS NOT NULL
             AND next_session.session_date IS NOT NULL
             AND (
               date(datetime(p.generated_at, '+8 hours')) <= substr(p.prediction_date, 1, 10)
               OR datetime(p.generated_at) < datetime(next_session.session_date || ' 01:00:00')
             )
        ) THEN 1 ELSE 0 END), 0) AS row_count
        FROM daily_recommendations dr
       WHERE dr.date = ?
         AND dr.score_components IS NOT NULL
         AND json_extract(dr.score_components, '$.version') = 'score_v2'
    `).bind(businessDate, businessDate).first<{ recommendation_rows?: number; row_count?: number }>(),
    db.prepare(`
      SELECT run_id, expected_rows, published_rows, status,
             native_lineage_rows, reconstructed_lineage_rows, rejected_lineage_rows
        FROM allocator_ev_snapshot_runs
       WHERE snapshot_date = ?
         AND snapshot_source = 'allocator_ev_asof_backfill_v2'
       ORDER BY datetime(created_at) DESC, run_id DESC
       LIMIT 1
    `).bind(businessDate).first<{
      run_id?: string
      expected_rows?: number
      published_rows?: number
      status?: string
      native_lineage_rows?: number
      reconstructed_lineage_rows?: number
      rejected_lineage_rows?: number
    }>(),
    db.prepare(`
      SELECT COUNT(*) AS row_count
        FROM allocator_ev_feature_snapshots
       WHERE snapshot_date = ?
         AND snapshot_source = 'allocator_ev_asof_backfill_v2'
    `).bind(businessDate).first<{ row_count?: number }>(),
  ])
  const expectedRows = Number(run?.expected_rows ?? 0)
  const publishedRows = Number(run?.published_rows ?? 0)
  const actualRows = Number(actual?.row_count ?? 0)
  const runNativeLineageRows = Number(run?.native_lineage_rows ?? 0)
  const reconstructedLineageRows = Number(run?.reconstructed_lineage_rows ?? 0)
  const rejectedLineageRows = Number(run?.rejected_lineage_rows ?? 0)
  const commonReady = run?.status === 'ready'
    && expectedRows > 0
    && publishedRows === expectedRows
    && actualRows === expectedRows
  const nativeReady = Number(lineage?.row_count ?? 0) === expectedRows
    && runNativeLineageRows === expectedRows
    && reconstructedLineageRows === 0
    && rejectedLineageRows === 0
  const reconstructedReady = options.allowPointInTimeReconstruction === true
    && Number(lineage?.row_count ?? 0) >= expectedRows
    && reconstructedLineageRows > 0
    && runNativeLineageRows + reconstructedLineageRows === expectedRows
  return {
    businessDate,
    recommendationRows: Number(lineage?.recommendation_rows ?? 0),
    nativeLineageRows: Number(lineage?.row_count ?? 0),
    runNativeLineageRows,
    reconstructedLineageRows,
    rejectedLineageRows,
    snapshotRunId: run?.run_id ?? null,
    expectedRows,
    publishedRows,
    actualRows,
    ready: commonReady && (nativeReady || reconstructedReady),
  }
}

function staleVerifyTrigger(row: AllocatorEvLifecycleRow | null): boolean {
  if (row?.state !== 'verify_triggered') return false
  const updatedAt = Date.parse(row.updated_at)
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= 15 * 60_000
}

async function resolveLifecycleBusinessDate(db: D1Database, requestedDate?: string): Promise<string> {
  if (requestedDate) {
    if (!validDate(requestedDate)) throw new Error(`invalid allocator EV lifecycle date: ${requestedDate}`)
    return requestedDate
  }
  const recoverableSourceError = await db.prepare(`
    SELECT business_date
      FROM allocator_ev_daily_lifecycle
     WHERE state = 'error'
       AND last_error LIKE 'terminal market-data source error:%'
       AND datetime(updated_at) <= datetime('now', '-12 hours')
     ORDER BY business_date ASC
     LIMIT 1
  `).first<{ business_date?: string | null }>()
  const recoverableDate = String(recoverableSourceError?.business_date ?? '').trim().slice(0, 10)
  if (validDate(recoverableDate)) return recoverableDate
  const pending = await db.prepare(`
    SELECT business_date
      FROM allocator_ev_daily_lifecycle
     WHERE state = 'replay_pending_maturity'
     ORDER BY business_date ASC
     LIMIT 1
  `).first<{ business_date?: string | null }>()
  const pendingDate = String(pending?.business_date ?? '').trim().slice(0, 10)
  if (validDate(pendingDate)) {
    const { loadFusionSnapshotReplayCoverage } = await import('./s12ReplayTradeOutcome')
    const coverage = await loadFusionSnapshotReplayCoverage(db, pendingDate, twTodayDate())
    if (coverage.matureMissingRows > 0) return pendingDate
  }
  const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const latest = await db.prepare(`
    SELECT MAX(prediction_date) AS business_date
      FROM predictions
     WHERE model_name = 'ensemble'
       AND prediction_date <= ?
  `).bind(twToday).first<{ business_date?: string | null }>()
  const businessDate = String(latest?.business_date ?? '').trim().slice(0, 10)
  if (!validDate(businessDate)) throw new Error(`allocator EV lifecycle has no ensemble prediction date through ${twToday}`)
  return businessDate
}

function twTodayDate(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

export async function runAllocatorEvLifecycleWatchdog(
  env: Bindings,
  requestedDate?: string,
): Promise<string> {
  const businessDate = await resolveLifecycleBusinessDate(env.DB, requestedDate)
  const snapshot = await inspectAllocatorSnapshotClosure(env.DB, businessDate)
  if (snapshot.nativeLineageRows <= 0) {
    if (snapshot.recommendationRows <= 0) {
      return `skipped: allocator EV lifecycle has no Score V2 recommendations for ${businessDate}`
    }
    const reason = `missing point-in-time ensemble lineage before next executable session open recommendations=${snapshot.recommendationRows}`
    await recordAllocatorEvLifecycle(env.DB, {
      businessDate,
      state: 'error',
      nativeLineageRows: 0,
      lastError: reason,
      incrementAttempt: true,
    })
    throw new Error(`allocator_ev_missing_point_in_time_lineage:${businessDate}:${reason}`)
  }
  const lifecycle = await readAllocatorEvLifecycle(env.DB, businessDate)
  const postVerifyReached = lifecycle && ['replay_pending_maturity', 'replay_enqueued', 'replay_complete'].includes(lifecycle.state)
  let matureReplayMissingRows = 0
  if (lifecycle?.state === 'replay_pending_maturity') {
    const { loadFusionSnapshotReplayCoverage } = await import('./s12ReplayTradeOutcome')
    const coverage = await loadFusionSnapshotReplayCoverage(env.DB, businessDate, twTodayDate())
    matureReplayMissingRows = coverage.matureMissingRows
  }
  if (snapshot.ready && lifecycle?.state === 'replay_pending_maturity' && matureReplayMissingRows > 0) {
    const maturityAsOfDate = twTodayDate()
    const runId = `allocator-ev-lifecycle-mature-replay-${businessDate}-${Date.now()}`
    await env.UPDATE_QUEUE.send({
      type: 's12_replay_backfill_chunk',
      cursor: 0,
      triggerTime: businessDate,
      runId,
      replayScope: 'fusion_snapshot_missing',
      maturityAsOfDate,
      statusRunDate: businessDate,
    } as any)
    await recordAllocatorEvLifecycle(env.DB, {
      businessDate,
      state: 'replay_enqueued',
      replayMaturityAsOfDate: maturityAsOfDate,
      upstreamRunId: runId,
      incrementAttempt: true,
    })
    return `allocator EV lifecycle replay enqueued date=${businessDate} mature_missing=${matureReplayMissingRows} as_of=${maturityAsOfDate}`
  }
  if (snapshot.ready && (
    (postVerifyReached && matureReplayMissingRows === 0)
    || (lifecycle?.state === 'verify_triggered' && !staleVerifyTrigger(lifecycle))
  )) {
    return `allocator EV lifecycle current date=${businessDate} state=${lifecycle?.state} snapshot_rows=${snapshot.actualRows}`
  }

  const { runPostPipelineCallbackChain } = await import('./postMarketChain')
  await runPostPipelineCallbackChain(env, {
    runDate: businessDate,
    upstreamRunId: lifecycle?.upstream_run_id || `allocator-ev-lifecycle-watchdog-${businessDate}`,
    recoveryAttempt: Math.max(1, Number(lifecycle?.attempt_count ?? 0) + 1),
  })
  const repaired = await inspectAllocatorSnapshotClosure(env.DB, businessDate)
  if (!repaired.ready) {
    throw new Error(
      `allocator EV lifecycle repair incomplete date=${businessDate} lineage=${repaired.nativeLineageRows} `
      + `run_native=${repaired.runNativeLineageRows} reconstructed=${repaired.reconstructedLineageRows} `
      + `rejected=${repaired.rejectedLineageRows} expected=${repaired.expectedRows} `
      + `published=${repaired.publishedRows} actual=${repaired.actualRows}`,
    )
  }
  return `allocator EV lifecycle repaired date=${businessDate} snapshot_rows=${repaired.actualRows}`
}
