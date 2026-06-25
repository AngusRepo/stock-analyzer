import type { Bindings, UpdateQueueMsg } from '../types'
import { checkAlerts } from './localMaintenance'
import { crawlAndStoreNews } from './news'
import { computeAndStoreIndicators } from './technicalIndicators'
import { fetchAndStoreStockData } from '../routes/stocks'
import { assertMarketDataReady } from './marketDataReadiness'
import { runRegimeCompute } from './controllerDailyWorkflows'
import { runFinLabV4Backfill } from './controllerResearchWorkflows'
import { classifySchedulerSummary, logSchedulerResult } from './schedulerRunLogger'
import { fetchPunishedStocks } from './twseApi'

const UPDATE_BATCH_SIZE = 40
const UPDATE_SHARD_COUNT = 4
const INDICATOR_BATCH_CONCURRENCY = 4
const NEWS_BATCH_CONCURRENCY = 2
const FINALIZE_RECHECK_DELAY_MS = 30_000
const FINALIZE_RECHECK_MAX_ATTEMPTS = 10
const FINALIZE_ORPHAN_REPAIR_DELAY_MS = 2 * 60_000
const SOURCE_READINESS_RETRY_DELAY_SECONDS = 10 * 60
const SOURCE_READINESS_RETRY_MAX_ATTEMPTS = 9
const STRATEGY_LEARNING_QUEUE_CHUNK_SIZE = 80
const FINLAB_CANONICAL_DAILY_CHECKS = [
  { table: 'canonical_market_daily', minRows: 1000 },
  { table: 'canonical_chip_daily', minRows: 1000 },
  { table: 'canonical_institutional_amount_daily', minRows: 1 },
] as const

const UPDATE_UNIVERSE_WHERE = `
  COALESCE(UPPER(market), '') NOT IN ('US', 'NYSE', 'NASDAQ')
  AND COALESCE(UPPER(market), '') NOT LIKE '%ETF%'
  AND COALESCE(UPPER(market), '') NOT LIKE '%WARRANT%'
`

function resolveUpdateDate(runDate?: string | null): string {
  const value = (runDate || '').trim()
  if (!value) return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid update date: ${value}; expected YYYY-MM-DD`)
  }
  return value
}

function isBulkPriceSourceNotReady(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Bulk price source incomplete|TWSE source failed|TPEX source failed|price rows=\d+\//i.test(message)
}

function isFinLabCanonicalReadinessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /FinLab canonical daily not ready/i.test(message)
}

function currentTaipeiDate(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

function isHistoricalReplayDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date < currentTaipeiDate()
}

async function finLabCanonicalTableStats(
  db: D1Database,
  table: string,
  targetDate: string,
): Promise<{ table: string; latestDate: string | null; rowsOnLatest: number; rowsOnTarget: number }> {
  const latest = await db.prepare(`SELECT MAX(date) AS latest_date FROM ${table}`).first<{ latest_date: string | null }>()
  const latestDate = latest?.latest_date ?? null
  if (!latestDate) return { table, latestDate: null, rowsOnLatest: 0, rowsOnTarget: 0 }
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE date = ?`).bind(latestDate).first<{ count: number }>()
  const target = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE date = ?`).bind(targetDate).first<{ count: number }>()
  return {
    table,
    latestDate,
    rowsOnLatest: Number(row?.count ?? 0),
    rowsOnTarget: Number(target?.count ?? 0),
  }
}

async function assertFinLabCanonicalDailyReady(db: D1Database, targetDate: string): Promise<string> {
  const stats = await Promise.all(
    FINLAB_CANONICAL_DAILY_CHECKS.map((check) => finLabCanonicalTableStats(db, check.table, targetDate)),
  )
  const errors: string[] = []
  for (const stat of stats) {
    const check = FINLAB_CANONICAL_DAILY_CHECKS.find((item) => item.table === stat.table)!
    if (!stat.latestDate || stat.latestDate < targetDate) {
      errors.push(`${stat.table} latest=${stat.latestDate ?? 'none'} before expected=${targetDate}`)
    }
    if (stat.rowsOnTarget < check.minRows) {
      errors.push(`${stat.table} target_rows=${stat.rowsOnTarget}/${check.minRows} date=${targetDate}`)
    }
  }
  if (errors.length) {
    throw new Error(`FinLab canonical daily not ready: ${errors.join('; ')}`)
  }
  return `FinLab canonical ready for ${targetDate}: ${stats.map((row) => `${row.table}=${row.rowsOnTarget}`).join(' ')}`
}

async function scheduleSourceReadinessRetry(
  env: Bindings,
  runDate: string,
  attempt: number,
  reason: string,
): Promise<void> {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  const summary = [
    `source waiting for ${runDate}`,
    `attempt=${safeAttempt}/${SOURCE_READINESS_RETRY_MAX_ATTEMPTS}`,
    `retry_in=${SOURCE_READINESS_RETRY_DELAY_SECONDS}s`,
    reason,
  ].join('; ')

  await logSchedulerResult(env.KV, 'update', {
    status: 'running',
    summary,
    duration_ms: 0,
    run_date: runDate,
  })
  await logSchedulerResult(env.KV, 'evening-chain', {
    status: 'running',
    summary: `waiting for same-day TWSE/TPEX supplemental source before indicator queue; ${summary}`,
    duration_ms: 0,
    run_date: runDate,
  })

  if (safeAttempt >= SOURCE_READINESS_RETRY_MAX_ATTEMPTS) {
    await logSchedulerResult(env.KV, 'update', {
      status: 'error',
      summary: `source readiness timeout for ${runDate}; ${reason}`,
      duration_ms: 0,
      error: reason,
      run_date: runDate,
    })
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'error',
      summary: `source readiness timeout before indicator queue for ${runDate}`,
      duration_ms: 0,
      error: reason,
      run_date: runDate,
    })
    throw new Error(`source readiness timeout for ${runDate}: ${reason}`)
  }

  await env.UPDATE_QUEUE.send({
    type: 'source_readiness_retry',
    cursor: 0,
    triggerTime: runDate,
    attempt: safeAttempt + 1,
  }, { delaySeconds: SOURCE_READINESS_RETRY_DELAY_SECONDS } as any)
}

type ProcessUpdateBatchDeps = {
  runMarketScreener: (env: Bindings, runDate?: string) => Promise<any>
  runMLAndRiskV2: (
    env: Bindings,
    runDate?: string,
    options?: { prevalidatedEventChain?: boolean },
  ) => Promise<string>
}

type UpdateStockRow = {
  id: number
  symbol: string
  market?: string | null
  name?: string | null
  in_current_watchlist?: number | null
}

type PriceMetadata = {
  count: number
  latestDate: string | null
}

async function runBounded<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, Math.floor(concurrency))
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      await fn(items[index], index)
    }
  })
  await Promise.all(workers)
}

async function loadPriceMetadataForBatch(
  db: D1Database,
  stockIds: number[],
): Promise<Map<number, PriceMetadata>> {
  const meta = new Map<number, PriceMetadata>()
  const uniqueIds = [...new Set(stockIds.filter((id) => Number.isFinite(id)))]
  for (const id of uniqueIds) meta.set(id, { count: 0, latestDate: null })
  if (!uniqueIds.length) return meta

  for (let i = 0; i < uniqueIds.length; i += 80) {
    const chunk = uniqueIds.slice(i, i + 80)
    const placeholders = chunk.map(() => '?').join(',')
    const { results } = await db.prepare(
      `SELECT stock_id, COUNT(*) AS cnt, MAX(date) AS latest_date
         FROM stock_prices
        WHERE stock_id IN (${placeholders})
        GROUP BY stock_id`,
    ).bind(...chunk).all<{ stock_id: number; cnt: number; latest_date: string | null }>()
    for (const row of results ?? []) {
      meta.set(Number(row.stock_id), {
        count: Number(row.cnt ?? 0),
        latestDate: row.latest_date ?? null,
      })
    }
  }
  return meta
}

export async function runBulkFetch(env: Bindings, force = false, runDate?: string): Promise<string> {
  const twDate = resolveUpdateDate(runDate)
  const lockKey = `cron:bulk-fetch:${twDate}`
  if (isHistoricalReplayDate(twDate)) {
    try {
      const ready = await assertMarketDataReady(env.DB, twDate, { requireIndicators: false })
      await env.KV.put(lockKey, '1', { expirationTtl: 86400 })
      return `TWSE/TPEX supplemental fetch skipped for historical replay; historical replay supplemental already ready; ${ready.summary}; source_role=supplemental_after_finlab_canonical`
    } catch {
      // Historical replay only falls through to source fetch when target-date
      // supplemental rows are genuinely missing or below the production floor.
    }
  }
  if (!force && await env.KV.get(lockKey)) {
    console.log(`[Cron] TWSE/TPEX supplemental fetch already done today (${twDate}), skipping.`)
    const ready = await assertMarketDataReady(env.DB, twDate, { requireIndicators: false })
    return `TWSE/TPEX supplemental fetch skipped; ${ready.summary}; source_role=supplemental_after_finlab_canonical`
  }

  try {
    const { bulkFetchAndStoreChipData, bulkFetchAndStorePrices } = await import('./twseApi')
    const controllerUrl = env.ML_CONTROLLER_URL ?? env.SHIOAJI_PROXY_URL
    const [{ chipCount, marginCount }, priceCount] = await Promise.all([
      bulkFetchAndStoreChipData(env.DB, twDate, controllerUrl, env.ML_CONTROLLER_SECRET),
      bulkFetchAndStorePrices(env.DB, twDate, controllerUrl, env.ML_CONTROLLER_SECRET),
    ])
    console.log(`[Cron] TWSE/TPEX supplemental: ${priceCount} prices + ${chipCount} chips + ${marginCount} margins`)
    const ready = await assertMarketDataReady(env.DB, twDate, { requireIndicators: false })
    await env.KV.put(lockKey, '1', { expirationTtl: 86400 })
    await fetchWave2Data(env, twDate).catch((e) => console.warn('[Wave2] failed:', e))
    return `${ready.summary}; TWSE/TPEX supplemental fetched price=${priceCount} chip=${chipCount} margin=${marginCount}; source_role=supplemental_after_finlab_canonical`
  } catch (e) {
    console.warn('[Cron] TWSE/TPEX supplemental fetch failed:', e)
    const message = e instanceof Error ? e.message : String(e)
    const sourceWaiting = isBulkPriceSourceNotReady(e)
    const status = sourceWaiting ? 'running' : 'error'
    const summary = sourceWaiting
      ? `source waiting before TWSE/TPEX supplemental fetch can write same-day rows: ${message}`
      : message
    await logSchedulerResult(env.KV, 'update', {
      status,
      summary,
      duration_ms: 0,
      error: sourceWaiting ? undefined : String(e),
      run_date: twDate,
    }).catch((logError) => console.warn('[Cron] Bulk fetch update log failed:', logError))
    await logSchedulerResult(env.KV, 'evening-chain', {
      status,
      summary: sourceWaiting
        ? `waiting for same-day TWSE/TPEX supplemental source before indicator queue: ${message}`
        : `TWSE/TPEX supplemental fetch failed before indicator queue: ${message}`,
      duration_ms: 0,
      error: sourceWaiting ? undefined : String(e),
      run_date: twDate,
    }).catch((logError) => console.warn('[Cron] Bulk fetch evening-chain log failed:', logError))
    throw e
  }
}

export async function runQueueUpdate(env: Bindings, runDate?: string, force = false) {
  const triggerTime = resolveUpdateDate(runDate)
  const lockKey = `cron:queue-update:${triggerTime}`
  if (!force && await env.KV.get(lockKey)) {
    console.log('[Cron] Queue update already triggered today, skipping.')
    return
  }

  console.log('[Cron] Kicking off queue update for full TW market indicator universe...')
  try {
    const runId = `${triggerTime}-${Date.now().toString(36)}`
    await env.UPDATE_QUEUE.sendBatch(
      Array.from({ length: UPDATE_SHARD_COUNT }, (_, shardIndex) => ({
        body: {
          type: 'update_batch' as const,
          cursor: 0,
          triggerTime,
          runId,
          shardIndex,
          shardCount: UPDATE_SHARD_COUNT,
        },
      })),
    )
    await logSchedulerResult(env.KV, 'indicator-queue', {
      status: 'running',
      summary: `indicator queue started for ${triggerTime}; run_id=${runId}; shards=${UPDATE_SHARD_COUNT}`,
      duration_ms: 0,
      run_date: triggerTime,
    })
    await env.KV.put(lockKey, '1', { expirationTtl: 86400 })
  } catch (e) {
    console.warn('[Cron] Queue update send failed, NOT writing lock:', e)
    throw e
  }
}

async function finalizeUpdateChain(
  env: Bindings,
  deps: ProcessUpdateBatchDeps,
  triggerTime: string,
  runId: string,
  shardCount: number,
): Promise<void> {
  const finalKey = `cron:indicator-queue:${triggerTime}:${runId}:finalized`
  const acquired = await acquireFinalizeLock(env, triggerTime, runId)
  if (!acquired) {
    console.log(`[Queue] Finalize already acquired for ${triggerTime} ${runId}`)
    await repairFinalizeContinuationIfNeeded(env, deps, triggerTime, runId, shardCount)
    return
  }
  await env.KV.put(finalKey, '1', { expirationTtl: 7 * 86400 })
  await runFinalizeContinuation(env, deps, triggerTime, runId, shardCount, 'lock-acquired')
}

async function runFinalizeContinuation(
  env: Bindings,
  deps: ProcessUpdateBatchDeps,
  triggerTime: string,
  runId: string,
  shardCount: number,
  source: string,
): Promise<void> {
  console.log('[Queue] All shards done. Running alert check and event-driven pipeline...')
  await logSchedulerResult(env.KV, 'indicator-queue', {
    status: 'success',
    summary: `indicator queue complete for ${triggerTime}; run_id=${runId}; shards=${shardCount}; source=${source}`,
    duration_ms: 0,
    run_date: triggerTime,
  })
  try {
    const { recordD1HotWindowDatasetManifests } = await import('./datasetSnapshots')
    const manifests = await recordD1HotWindowDatasetManifests(env, triggerTime, runId)
    const summary = manifests
      .map((m) => `${m.kind}:${m.latest_date ?? 'none'}:${m.row_count}`)
      .join(' ')
    console.log(`[Queue] D1 hot-window dataset manifests: ${summary}`)
  } catch (e) {
    await logSchedulerResult(env.KV, 'data-quality', {
      status: 'error',
      summary: `dataset manifest write failed for ${triggerTime}`,
      duration_ms: 0,
      error: String(e),
      run_date: triggerTime,
    })
    console.warn('[Queue] Dataset manifest write failed:', e)
  }
  await checkAlerts(env)

  try {
    const screenerResult = await deps.runMarketScreener(env, triggerTime)
    const screenerSummary = typeof screenerResult === 'string'
      ? screenerResult
      : JSON.stringify(screenerResult)?.slice(0, 500) ?? ''
    await logSchedulerResult(env.KV, 'screener', {
      status: classifySchedulerSummary(screenerSummary),
      summary: screenerSummary,
      duration_ms: 0,
      run_date: triggerTime,
    })
    try {
      const { recordSchedulerRunReportArtifact } = await import('./datasetSnapshots')
      await recordSchedulerRunReportArtifact(env, {
        task: 'screener',
        status: classifySchedulerSummary(screenerSummary),
        businessDate: triggerTime,
        runId,
        summary: screenerSummary,
      })
    } catch (e) {
      console.warn('[Queue] Screener R2 report artifact failed:', e)
    }
    console.log(`[Queue] Event-driven: screener completed for ${triggerTime}`)
  } catch (e) {
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'error',
      summary: `event-driven chain stopped: screener failed for ${triggerTime}`,
      duration_ms: 0,
      error: String(e),
      run_date: triggerTime,
    })
    await logSchedulerResult(env.KV, 'screener', {
      status: 'error',
      summary: e instanceof Error ? e.message : String(e),
      duration_ms: 0,
      error: String(e),
      run_date: triggerTime,
    })
    console.warn('[Queue] Event-driven screener failed:', e)
    return
  }

  await logSchedulerResult(env.KV, 'evening-chain', {
    status: 'running',
    summary: `event-driven chain queued post-screener continuation for ${triggerTime}; run_id=${runId}; source=${source}`,
    duration_ms: 0,
    run_date: triggerTime,
  })
  await env.UPDATE_QUEUE.send({
    type: 'post_screener_pipeline',
    cursor: 0,
    triggerTime,
    runId,
    shardCount,
    attempt: 1,
  })
  await env.KV.put(
    `cron:indicator-queue:${triggerTime}:${runId}:post-screener-enqueued`,
    new Date().toISOString(),
    { expirationTtl: 7 * 86400 },
  ).catch((e) => console.warn('[Queue] Post-screener enqueue marker write failed:', e))
}

async function acquireFinalizeLock(env: Bindings, triggerTime: string, runId: string): Promise<boolean> {
  const lockKey = `indicator-finalize:${triggerTime}:${runId}`
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 7 * 86400 * 1000).toISOString()
  try {
    const result = await env.DB.prepare(`
      INSERT OR IGNORE INTO scheduler_locks (lock_key, owner, run_date, run_id, created_at, expires_at)
      VALUES (?, 'indicator_finalize', ?, ?, ?, ?)
    `).bind(lockKey, triggerTime, runId, now, expiresAt).run()
    const changes = Number(result.meta?.changes ?? 0)
    return changes > 0
  } catch (error) {
    // Fail closed: without an atomic lock, multiple finalizers can advance the same chain.
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'error',
      summary: `event-driven chain stopped: finalize lock unavailable for ${triggerTime}`,
      duration_ms: 0,
      error: error instanceof Error ? error.message : String(error),
      run_date: triggerTime,
    })
    throw error
  }
}

async function loadFinalizeLock(env: Bindings, triggerTime: string, runId: string): Promise<{ created_at?: string | null } | null> {
  const lockKey = `indicator-finalize:${triggerTime}:${runId}`
  return await env.DB.prepare(`
    SELECT created_at
      FROM scheduler_locks
     WHERE lock_key = ?
     LIMIT 1
  `).bind(lockKey).first<{ created_at?: string | null }>()
}

function finalizeLockIsRepairable(lock: { created_at?: string | null } | null): boolean {
  const createdAtMs = lock?.created_at ? Date.parse(lock.created_at) : NaN
  if (!Number.isFinite(createdAtMs)) return true
  return Date.now() - createdAtMs >= FINALIZE_ORPHAN_REPAIR_DELAY_MS
}

async function hasSuccessfulScreenerRun(db: D1Database, triggerTime: string): Promise<boolean> {
  const row = await db.prepare(`
    SELECT run_id
      FROM screener_funnel_runs
     WHERE date = ?
       AND status = 'success'
     ORDER BY created_at DESC
     LIMIT 1
  `).bind(triggerTime).first<{ run_id?: string }>()
  return Boolean(row?.run_id)
}

async function hasPipelineEvidence(env: Bindings, triggerTime: string): Promise<boolean> {
  const pipelineLog = await env.KV.get(`scheduler:run:pipeline:${triggerTime}`, 'json') as { status?: string } | null
  if (['running', 'triggered', 'success'].includes(String(pipelineLog?.status ?? ''))) return true

  try {
    const prediction = await env.DB.prepare(`
      SELECT id
        FROM predictions
       WHERE prediction_date = ?
       LIMIT 1
    `).bind(triggerTime).first<{ id?: number }>()
    if (prediction?.id) return true
  } catch {
    // Older/dev databases may not have prediction_date; recommendation evidence is enough.
  }

  const recommendation = await env.DB.prepare(`
    SELECT id
      FROM daily_recommendations
     WHERE date = ?
       AND (
         signal IS NOT NULL
         OR COALESCE(ml_score, 0) <> 0
         OR alpha_allocation IS NOT NULL
       )
     LIMIT 1
  `).bind(triggerTime).first<{ id?: number }>()
  return Boolean(recommendation?.id)
}

async function repairFinalizeContinuationIfNeeded(
  env: Bindings,
  deps: ProcessUpdateBatchDeps,
  triggerTime: string,
  runId: string,
  shardCount: number,
): Promise<void> {
  const lock = await loadFinalizeLock(env, triggerTime, runId)
  if (!finalizeLockIsRepairable(lock)) {
    console.log(`[Queue] Finalize lock is recent; waiting for original finalizer ${triggerTime} ${runId}`)
    return
  }

  if (await hasPipelineEvidence(env, triggerTime)) {
    console.log(`[Queue] Finalize continuation already reached pipeline for ${triggerTime} ${runId}`)
    return
  }

  if (await hasSuccessfulScreenerRun(env.DB, triggerTime)) {
    await logSchedulerResult(env.KV, 'indicator-queue', {
      status: 'success',
      summary: `indicator queue finalizer repaired from existing lock for ${triggerTime}; run_id=${runId}; shards=${shardCount}`,
      duration_ms: 0,
      run_date: triggerTime,
    })
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'running',
      summary: `event-driven chain repaired orphaned post-screener continuation for ${triggerTime}; run_id=${runId}`,
      duration_ms: 0,
      run_date: triggerTime,
    })
    await env.UPDATE_QUEUE.send({
      type: 'post_screener_pipeline',
      cursor: 0,
      triggerTime,
      runId,
      shardCount,
      attempt: 1,
    })
    return
  }

  await logSchedulerResult(env.KV, 'evening-chain', {
    status: 'running',
    summary: `event-driven chain repairing stale finalizer lock before screener for ${triggerTime}; run_id=${runId}`,
    duration_ms: 0,
    run_date: triggerTime,
  })
  await runFinalizeContinuation(env, deps, triggerTime, runId, shardCount, 'stale-lock-repair')
}

async function continuePostScreenerPipeline(
  env: Bindings,
  deps: ProcessUpdateBatchDeps,
  triggerTime: string,
  runId?: string,
): Promise<void> {
  await logSchedulerResult(env.KV, 'regime-compute', {
    status: 'running',
    summary: `pre-pipeline regime-compute started for ${triggerTime}; run_id=${runId ?? 'n/a'}`,
    duration_ms: 0,
    run_date: triggerTime,
  })

  try {
    const startedAt = Date.now()
    const regimeSummary = String(await runRegimeCompute(env, triggerTime))
    const regimeStatus = regimeSummary.includes('kv=ok') ? 'success' : 'error'
    await logSchedulerResult(env.KV, 'regime-compute', {
      status: regimeStatus,
      summary: `pre-pipeline ${regimeSummary}`,
      duration_ms: Date.now() - startedAt,
      run_date: triggerTime,
    })
    if (regimeStatus !== 'success') {
      await logSchedulerResult(env.KV, 'evening-chain', {
        status: 'error',
        summary: `event-driven chain stopped: regime-compute did not update KV before pipeline for ${triggerTime}; ${regimeSummary}`,
        duration_ms: 0,
        run_date: triggerTime,
      })
      return
    }
    console.log(`[Queue] Event-driven: regime-compute completed before pipeline for ${triggerTime}`)
  } catch (e) {
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'error',
      summary: `event-driven chain stopped: regime-compute failed before pipeline for ${triggerTime}`,
      duration_ms: 0,
      error: String(e),
      run_date: triggerTime,
    })
    await logSchedulerResult(env.KV, 'regime-compute', {
      status: 'error',
      summary: e instanceof Error ? e.message : String(e),
      duration_ms: 0,
      error: String(e),
      run_date: triggerTime,
    })
    console.warn('[Queue] Event-driven regime-compute failed:', e)
    return
  }

  try {
    const summary = await deps.runMLAndRiskV2(env, triggerTime, { prevalidatedEventChain: true })
    if (summary.trim().toUpperCase().startsWith('LOCKED')) {
      const lockedSummary = `pipeline already running for ${triggerTime}; existing run lock preserved`
      await logSchedulerResult(env.KV, 'pipeline', {
        status: 'triggered',
        summary: lockedSummary,
        duration_ms: 0,
        run_date: triggerTime,
      })
      await logSchedulerResult(env.KV, 'evening-chain', {
        status: 'triggered',
        summary: `event-driven chain reached pipeline trigger for ${triggerTime}; ${lockedSummary}`,
        duration_ms: 0,
        run_date: triggerTime,
      })
      console.log(`[Queue] Event-driven: ${lockedSummary}`)
      return
    }
    await logSchedulerResult(env.KV, 'pipeline', {
      status: classifySchedulerSummary(summary),
      summary,
      duration_ms: 0,
      run_date: triggerTime,
    })
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'triggered',
      summary: `event-driven chain reached pipeline trigger for ${triggerTime}; ${summary}`,
      duration_ms: 0,
      run_date: triggerTime,
    })
    console.log(`[Queue] Event-driven: triggered runMLAndRiskV2 after update complete for ${triggerTime}`)
  } catch (e) {
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'error',
      summary: `event-driven chain stopped: pipeline trigger failed for ${triggerTime}`,
      duration_ms: 0,
      error: String(e),
      run_date: triggerTime,
    })
    await logSchedulerResult(env.KV, 'pipeline', {
      status: 'error',
      summary: e instanceof Error ? e.message : String(e),
      duration_ms: 0,
      error: String(e),
      run_date: triggerTime,
    })
    console.warn('[Queue] Event-driven ML trigger failed:', e)
  }
}

async function markShardComplete(
  msg: UpdateQueueMsg,
  env: Bindings,
  deps: ProcessUpdateBatchDeps,
): Promise<void> {
  const triggerTime = msg.triggerTime
  const shardIndex = Number.isFinite(msg.shardIndex) ? Number(msg.shardIndex) : 0
  const shardCount = Number.isFinite(msg.shardCount) && Number(msg.shardCount) > 0 ? Number(msg.shardCount) : 1
  const runId = msg.runId || `${triggerTime}-single`
  const donePrefix = `cron:indicator-queue:${triggerTime}:${runId}:done:`
  const doneKey = `${donePrefix}${shardIndex}`

  await env.KV.put(doneKey, '1', { expirationTtl: 7 * 86400 })
  const done = await env.KV.list({ prefix: donePrefix })
  const doneCount = new Set(done.keys.map((k) => k.name)).size

  if (doneCount < shardCount) {
    await logSchedulerResult(env.KV, 'indicator-queue', {
      status: 'running',
      summary: `indicator queue shards ${doneCount}/${shardCount} complete for ${triggerTime}; run_id=${runId}`,
      duration_ms: 0,
      run_date: triggerTime,
    })
    await env.UPDATE_QUEUE.send({
      type: 'finalize_update',
      cursor: 0,
      triggerTime,
      runId,
      shardCount,
      attempt: 1,
    })
    return
  }

  await finalizeUpdateChain(env, deps, triggerTime, runId, shardCount)
}

async function continueAfterFinLabBackfill(
  env: Bindings,
  twDate: string,
  force = false,
  runId?: string,
): Promise<string> {
  const canonicalSummary = await assertFinLabCanonicalDailyReady(env.DB, twDate)
  let bulkSummary: string
  try {
    bulkSummary = await runBulkFetch(env, force, twDate)
  } catch (e) {
    if (!isBulkPriceSourceNotReady(e)) throw e
    const message = e instanceof Error ? e.message : String(e)
    await scheduleSourceReadinessRetry(env, twDate, 1, message)
    return `source waiting; queued same-day market data retry for ${twDate}; ${message}`
  }
  await logSchedulerResult(env.KV, 'update', {
    status: 'success',
    summary: `market data update ready for ${twDate}; FinLab primary canonical ready; TWSE/TPEX supplemental refresh complete; ${canonicalSummary}; ${bulkSummary}`,
    duration_ms: 0,
    run_id: runId,
    run_date: twDate,
  })
  await runQueueUpdate(env, twDate, force)
  return `${canonicalSummary}; TWSE/TPEX supplemental refresh complete; ${bulkSummary}; indicator queue accepted`
}

export async function runDailyUpdate(env: Bindings, force = false, runDate?: string): Promise<string> {
  const twDate = resolveUpdateDate(runDate)
  if (force && runDate && isHistoricalReplayDate(twDate)) {
    try {
      const canonicalSummary = await assertFinLabCanonicalDailyReady(env.DB, twDate)
      await logSchedulerResult(env.KV, 'finlab-v4-backfill', {
        status: 'skipped',
        summary: `historical replay canonical already ready; skipped duplicate FinLab backfill; ${canonicalSummary}`,
        duration_ms: 0,
        run_date: twDate,
      })
      const continuation = await continueAfterFinLabBackfill(env, twDate, force, `historical-replay-${twDate}`)
      return `triggered evening-chain: historical replay skipped FinLab backfill; ${continuation}`
    } catch (e) {
      if (!isFinLabCanonicalReadinessError(e)) throw e
    }
  }
  const finlabSummary = String(await runFinLabV4Backfill(env, twDate, force, { continueEveningChain: true }))
  const finlabStatus = classifySchedulerSummary(finlabSummary)
  await logSchedulerResult(env.KV, 'finlab-v4-backfill', {
    status: finlabStatus,
    summary: finlabSummary,
    duration_ms: 0,
    run_date: twDate,
  })
  if (finlabStatus !== 'triggered' && finlabStatus !== 'success') {
    throw new Error(`FinLab primary backfill did not start: ${finlabSummary}`)
  }
  if (finlabStatus === 'success') {
    const continuation = await continueAfterFinLabBackfill(env, twDate, force)
    return `triggered evening-chain: ${continuation}`
  }
  const summary = `FinLab canonical refresh triggered for ${twDate}; waiting for finlab-v4-backfill callback before TWSE/TPEX supplemental refresh + indicator queue`
  await logSchedulerResult(env.KV, 'update', {
    status: 'triggered',
    summary,
    duration_ms: 0,
    run_date: twDate,
  })
  await logSchedulerResult(env.KV, 'evening-chain', {
    status: 'triggered',
    summary,
    duration_ms: 0,
    run_date: twDate,
  })
  return `triggered evening-chain: ${finlabSummary}; awaiting FinLab canonical callback`
}

export async function fetchWave2Data(env: Bindings, today: string): Promise<void> {
  const {
    fetchTwseValuation,
    fetchTpexValuation,
    fetchTwseMonthlyRevenue,
    fetchTpexMonthlyRevenue,
    fetchMarketBreadth,
    fetchTwseFinancials,
    fetchTpexFinancials,
  } = await import('./twseApi')

  try {
    const breadth = await fetchMarketBreadth()
    if (breadth) {
      await env.DB.prepare(`
        INSERT INTO market_breadth (date, advance_count, decline_count, unchanged_count, advance_ratio)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          advance_count=excluded.advance_count,
          decline_count=excluded.decline_count,
          unchanged_count=excluded.unchanged_count,
          advance_ratio=excluded.advance_ratio
      `).bind(
        breadth.date,
        breadth.advance_count,
        breadth.decline_count,
        breadth.unchanged_count,
        breadth.advance_ratio,
      ).run()
      console.log(
        `[Wave2] Market breadth: ${breadth.advance_count}/${breadth.decline_count}/${breadth.unchanged_count} (${(breadth.advance_ratio * 100).toFixed(0)}%)`,
      )
    }
  } catch (e) {
    console.warn('[Wave2] Market breadth failed:', e)
  }

  try {
    const [twseVal, tpexVal] = await Promise.allSettled([fetchTwseValuation(today), fetchTpexValuation()])
    const valRows = [
      ...(twseVal.status === 'fulfilled' ? twseVal.value : []),
      ...(tpexVal.status === 'fulfilled' ? tpexVal.value : []),
    ]

    if (valRows.length) {
      const twNow = new Date(Date.now() + 8 * 3600_000)
      const currentQ = `${twNow.getFullYear()}Q${Math.ceil((twNow.getMonth() + 1) / 3)}`

      const stmts = valRows
        .filter((v) => v.pe !== null || v.pb !== null || v.dividend_yield !== null)
        .flatMap((v) => [
          env.DB.prepare(`
            UPDATE financials SET pe=?, pb=?, dividend_yield=?
            WHERE stock_id = (SELECT id FROM stocks WHERE symbol=?)
            AND period = (
              SELECT MAX(period)
              FROM financials
              WHERE stock_id = (SELECT id FROM stocks WHERE symbol=?)
                AND period LIKE '%Q%'
            )
          `).bind(v.pe, v.pb, v.dividend_yield, v.symbol, v.symbol),
          env.DB.prepare(`
            INSERT INTO financials (stock_id, period, period_type, pe, pb, dividend_yield)
            SELECT s.id, ?, 'quarterly', ?, ?, ?
            FROM stocks s WHERE s.symbol = ?
            AND NOT EXISTS (
              SELECT 1 FROM financials f
              WHERE f.stock_id = s.id AND f.period LIKE '%Q%'
            )
          `).bind(currentQ, v.pe, v.pb, v.dividend_yield, v.symbol),
        ])

      for (let i = 0; i < stmts.length; i += 50) {
        await env.DB.batch(stmts.slice(i, i + 50))
      }

      console.log(
        `[Wave2] PER/PBR: ${valRows.length} stocks (TWSE ${twseVal.status === 'fulfilled' ? twseVal.value.length : 0} + TPEX ${tpexVal.status === 'fulfilled' ? tpexVal.value.length : 0})`,
      )
    }
  } catch (e) {
    console.warn('[Wave2] PER/PBR failed:', e)
  }

  const day = parseInt(today.slice(8, 10), 10)
  if (day <= 12) {
    try {
      const [twseRev, tpexRev] = await Promise.allSettled([fetchTwseMonthlyRevenue(), fetchTpexMonthlyRevenue()])
      const revData = [
        ...(twseRev.status === 'fulfilled' ? twseRev.value : []),
        ...(tpexRev.status === 'fulfilled' ? tpexRev.value : []),
      ]

      if (revData.length) {
        const stmts = revData.map((r) =>
          env.DB.prepare(`
            INSERT INTO monthly_revenue (stock_id, date, revenue, revenue_yoy, revenue_mom)
            SELECT s.id, ?, ?, ?, ?
            FROM stocks s WHERE s.symbol = ?
            ON CONFLICT(stock_id, date) DO UPDATE SET
              revenue=excluded.revenue,
              revenue_yoy=excluded.revenue_yoy,
              revenue_mom=excluded.revenue_mom
          `).bind(r.year_month, r.revenue, r.revenue_yoy, r.revenue_mom, r.symbol),
        )

        for (let i = 0; i < stmts.length; i += 50) {
          await env.DB.batch(stmts.slice(i, i + 50))
        }

        console.log(
          `[Wave2] Monthly revenue: ${revData.length} entries (TWSE ${twseRev.status === 'fulfilled' ? twseRev.value.length : 0} + TPEX ${tpexRev.status === 'fulfilled' ? tpexRev.value.length : 0})`,
        )
      }
    } catch (e) {
      console.warn('[Wave2] Monthly revenue failed:', e)
    }
  }

  try {
    const [twseFin, tpexFin] = await Promise.allSettled([fetchTwseFinancials(), fetchTpexFinancials()])
    const finRows = [
      ...(twseFin.status === 'fulfilled' ? twseFin.value : []),
      ...(tpexFin.status === 'fulfilled' ? tpexFin.value : []),
    ]

    if (finRows.length) {
      const stmts = finRows
        .filter((f) => f.eps !== null)
        .map((f) => {
          const period = `${f.year}Q${f.quarter}`
          return env.DB.prepare(`
            INSERT INTO financials (stock_id, period, period_type, eps, revenue, roe, operating_income, net_income, total_assets, total_liabilities)
            SELECT s.id, ?, 'quarterly', ?, ?, ?, ?, ?, ?, ?
            FROM stocks s WHERE s.symbol = ?
            ON CONFLICT(stock_id, period) DO UPDATE SET
              eps=COALESCE(excluded.eps, financials.eps),
              revenue=COALESCE(excluded.revenue, financials.revenue),
              roe=COALESCE(excluded.roe, financials.roe),
              operating_income=COALESCE(excluded.operating_income, financials.operating_income),
              net_income=COALESCE(excluded.net_income, financials.net_income),
              total_assets=COALESCE(excluded.total_assets, financials.total_assets),
              total_liabilities=COALESCE(excluded.total_liabilities, financials.total_liabilities)
          `).bind(
            period,
            f.eps,
            f.revenue,
            f.roe,
            f.operating_income,
            f.net_income,
            f.total_assets,
            f.total_liabilities,
            f.symbol,
          )
        })

      for (let i = 0; i < stmts.length; i += 50) {
        await env.DB.batch(stmts.slice(i, i + 50))
      }

      console.log(`[Wave2] Financials: ${finRows.length} entries (TWSE+TPEX EPS+ROE)`)
    }
  } catch (e) {
    console.warn('[Wave2] Financials failed:', e)
  }

  if (env.ML_CONTROLLER_URL) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.ML_CONTROLLER_SECRET) headers['X-Controller-Token'] = env.ML_CONTROLLER_SECRET

    try {
      const res = await fetch(`${env.ML_CONTROLLER_URL}/twse/ex-dividend`, {
        headers,
        signal: AbortSignal.timeout(30000),
      })
      if (res.ok) {
        const exDivRows = await res.json() as any[]
        if (exDivRows.length) {
          await env.KV.put('market:ex_dividend_forecast', JSON.stringify(exDivRows), { expirationTtl: 86400 })
          console.log(`[Wave2] Ex-dividend (via controller): ${exDivRows.length} entries`)
        }
      }
    } catch (e) {
      console.warn('[Wave2] Ex-dividend proxy failed:', e)
    }

    try {
      const res = await fetch(`${env.ML_CONTROLLER_URL}/twse/attention-stocks`, {
        headers,
        signal: AbortSignal.timeout(30000),
      })
      if (res.ok) {
        const attentionSymbols = await res.json() as string[]
        if (attentionSymbols.length) {
          await env.KV.put('market:attention_stocks', JSON.stringify(attentionSymbols), { expirationTtl: 86400 })
          console.log(`[Wave2] Attention stocks (via controller): ${attentionSymbols.length} symbols`)
        }
      }
    } catch (e) {
      console.warn('[Wave2] Attention stocks proxy failed:', e)
    }

    try {
      const punishedSymbols = await fetchPunishedStocks()
      if (punishedSymbols.length) {
        await env.KV.put('market:punished_stocks', JSON.stringify(punishedSymbols), { expirationTtl: 86400 })
        await env.KV.put('market:punished_stocks:checked_at', new Date().toISOString(), { expirationTtl: 86400 })
        console.log(`[Wave2] Punished stocks (TWSE): ${punishedSymbols.length} symbols`)
      }
    } catch (e) {
      console.warn('[Wave2] Punished stocks fetch failed:', e)
    }
  }
}

export async function processUpdateBatch(
  msg: UpdateQueueMsg,
  env: Bindings,
  deps: ProcessUpdateBatchDeps,
): Promise<void> {
  if (msg.type === 'finlab_backfill_complete') {
    const triggerTime = msg.triggerTime
    const attempt = Number.isFinite(msg.attempt) ? Number(msg.attempt) : 1
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid FinLab backfill continuation date ${triggerTime}, skipping.`)
      return
    }

    try {
      const summary = await continueAfterFinLabBackfill(env, triggerTime, Boolean(msg.force), msg.runId)
      await logSchedulerResult(env.KV, 'evening-chain', {
        status: 'running',
        summary: `FinLab canonical callback accepted for ${triggerTime}; ${summary}`,
        duration_ms: 0,
        run_id: msg.runId,
        run_date: triggerTime,
      })
    } catch (e) {
      if (isBulkPriceSourceNotReady(e)) {
        const message = e instanceof Error ? e.message : String(e)
        await scheduleSourceReadinessRetry(env, triggerTime, attempt, message)
        return
      }
      if (isFinLabCanonicalReadinessError(e)) {
        const message = e instanceof Error ? e.message : String(e)
        await logSchedulerResult(env.KV, 'finlab-v4-backfill', {
          status: 'error',
          summary: message,
          duration_ms: 0,
          error: message,
          run_id: msg.runId,
          run_date: triggerTime,
        })
        await logSchedulerResult(env.KV, 'evening-chain', {
          status: 'error',
          summary: `event-driven chain stopped: ${message}`,
          duration_ms: 0,
          error: message,
          run_id: msg.runId,
          run_date: triggerTime,
        }, env as any)
        return
      }
      throw e
    }
    return
  }

  if (msg.type === 'strategy_learning_materialize') {
    const triggerTime = msg.triggerTime
    const runId = msg.runId || `strategy-learning-${triggerTime}`
    const offset = Math.max(0, Math.floor(Number(msg.cursor ?? 0)))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid strategy-learning date ${triggerTime}, skipping.`)
      return
    }

    const {
      materializeStrategyDecisionLogChunk,
      refreshStrategyAdaptivePolicyState,
      refreshStrategyRewardLedger,
      seedDefaultStrategySpecRegistry,
    } = await import('./strategyLearning')

    if (offset === 0) {
      await seedDefaultStrategySpecRegistry(env.DB)
    }

    const chunk = await materializeStrategyDecisionLogChunk(env.DB, {
      date: triggerTime,
      offset,
      limit: STRATEGY_LEARNING_QUEUE_CHUNK_SIZE,
      dryRun: false,
    })

    if (chunk.has_more) {
      await logSchedulerResult(env.KV, 'strategy-learning', {
        status: 'running',
        summary: `materialized chunk offset=${chunk.offset} candidates=${chunk.candidate_count} decision_rows=${chunk.persisted_rows}; next_offset=${chunk.next_offset}`,
        duration_ms: 0,
        run_id: runId,
        run_date: triggerTime,
      })
      await env.UPDATE_QUEUE.send({
        type: 'strategy_learning_materialize',
        cursor: chunk.next_offset,
        triggerTime,
        runId,
        force: Boolean(msg.force),
      })
      return
    }

    const rewards = await refreshStrategyRewardLedger(env.DB, { endDate: triggerTime, dryRun: false })
    const policy = msg.force
      ? await refreshStrategyAdaptivePolicyState(env.DB, { date: triggerTime, dryRun: false })
      : null
    const summary = [
      `materialized_complete offset=${chunk.offset}`,
      `last_candidates=${chunk.candidate_count}`,
      `last_decision_rows=${chunk.persisted_rows}`,
      `reward_source_rows=${rewards.source_rows}`,
      `reward_rows=${rewards.persisted_rows}`,
      `policy=${policy ? policy.policy_state.status : 'skipped_historical'}`,
    ].join(' ')

    await logSchedulerResult(env.KV, 'strategy-learning', {
      status: 'success',
      summary,
      duration_ms: 0,
      run_id: runId,
      run_date: triggerTime,
    })
    await logSchedulerResult(env.KV, 'post-verify-chain', {
      status: 'success',
      summary: `strategy-learning queue closed; ${summary}`,
      duration_ms: 0,
      run_id: runId,
      run_date: triggerTime,
    })
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'success',
      summary: `root chain closed after queued strategy-learning: ${summary}`,
      duration_ms: 0,
      run_id: runId,
      run_date: triggerTime,
    })
    return
  }

  if (msg.type === 'source_readiness_retry') {
    const triggerTime = msg.triggerTime
    const attempt = Number.isFinite(msg.attempt) ? Number(msg.attempt) : 1
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid source readiness retry date ${triggerTime}, skipping.`)
      return
    }

    try {
      const bulkSummary = await runBulkFetch(env, false, triggerTime)
      await runQueueUpdate(env, triggerTime, false)
      await logSchedulerResult(env.KV, 'evening-chain', {
        status: 'running',
        summary: `source became ready for ${triggerTime}; ${bulkSummary}; indicator queue accepted`,
        duration_ms: 0,
        run_date: triggerTime,
      })
    } catch (e) {
      if (!isBulkPriceSourceNotReady(e)) throw e
      const message = e instanceof Error ? e.message : String(e)
      await scheduleSourceReadinessRetry(env, triggerTime, attempt, message)
    }
    return
  }

  if (msg.type === 'news_batch') {
    const stocks = (msg.newsStocks ?? []).filter((stock) => stock?.id && stock?.symbol)
    if (!stocks.length) {
      console.log(`[Queue] News batch empty for ${msg.triggerTime}, skipping.`)
      return
    }

    let crawled = 0
    await runBounded(stocks, NEWS_BATCH_CONCURRENCY, async (stock) => {
      try {
        await crawlAndStoreNews(env.DB, stock)
        crawled++
      } catch (e) {
        console.warn(`[Queue] News crawl failed ${stock.symbol}:`, e)
      }
    })
    console.log(`[Queue] News batch complete: ${crawled}/${stocks.length} stocks for ${msg.triggerTime}`)
    return
  }

  if (msg.type === 'finalize_update') {
    const triggerTime = msg.triggerTime
    const runId = msg.runId || `${triggerTime}-single`
    const shardCount = Number.isFinite(msg.shardCount) && Number(msg.shardCount) > 0 ? Number(msg.shardCount) : 1
    const attempt = Number.isFinite(msg.attempt) ? Number(msg.attempt) : 1
    const donePrefix = `cron:indicator-queue:${triggerTime}:${runId}:done:`
    await new Promise((resolve) => setTimeout(resolve, FINALIZE_RECHECK_DELAY_MS))
    const done = await env.KV.list({ prefix: donePrefix })
    const doneCount = new Set(done.keys.map((k) => k.name)).size

    if (doneCount >= shardCount) {
      await finalizeUpdateChain(env, deps, triggerTime, runId, shardCount)
      return
    }

    await logSchedulerResult(env.KV, 'indicator-queue', {
      status: 'running',
      summary: `indicator queue finalize wait ${doneCount}/${shardCount} for ${triggerTime}; run_id=${runId}; attempt=${attempt}`,
      duration_ms: 0,
      run_date: triggerTime,
    })

    if (attempt < FINALIZE_RECHECK_MAX_ATTEMPTS) {
      await env.UPDATE_QUEUE.send({
        type: 'finalize_update',
        cursor: 0,
        triggerTime,
        runId,
        shardCount,
        attempt: attempt + 1,
      })
      return
    }

    throw new Error(`indicator queue finalize timed out for ${triggerTime}; run_id=${runId}; done=${doneCount}/${shardCount}`)
  }

  if (msg.type === 'post_screener_pipeline') {
    const triggerTime = msg.triggerTime
    const runId = msg.runId || `${triggerTime}-post-screener`
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid post-screener continuation date ${triggerTime}, skipping.`)
      return
    }
    await continuePostScreenerPipeline(env, deps, triggerTime, runId)
    return
  }

  const { cursor, triggerTime } = msg
  const shardIndex = Number.isFinite(msg.shardIndex) ? Number(msg.shardIndex) : 0
  const shardCount = Number.isFinite(msg.shardCount) && Number(msg.shardCount) > 0 ? Number(msg.shardCount) : 1

  if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
    console.log(`[Queue] Invalid update trigger date ${triggerTime}, skipping.`)
    return
  }

  const { results: batch } = await env.DB.prepare(
    `SELECT id, symbol, market, name, in_current_watchlist
       FROM stocks
      WHERE ${UPDATE_UNIVERSE_WHERE}
        AND id > ?
        AND (id % ?) = ?
      ORDER BY id ASC
      LIMIT ?`,
  ).bind(cursor, shardCount, shardIndex, UPDATE_BATCH_SIZE + 1).all<any>()
  const currentBatch = batch.slice(0, UPDATE_BATCH_SIZE)
  const hasMore = batch.length > UPDATE_BATCH_SIZE

  if (currentBatch.length === 0) {
    console.log(`[Queue] Shard ${shardIndex + 1}/${shardCount} complete with no remaining stocks.`)
    await markShardComplete(msg, env, deps)
    return
  }

  console.log(`[Queue] Update batch: ${currentBatch.length} stocks (cursor=${cursor}, shard=${shardIndex + 1}/${shardCount}, hasMore=${hasMore})`)

  const priceMetaByStockId = await loadPriceMetadataForBatch(
    env.DB,
    currentBatch.map((stock) => Number(stock.id)),
  )
  const watchlistNewsStocks: UpdateStockRow[] = []

  await runBounded(currentBatch, INDICATOR_BATCH_CONCURRENCY, async (stock) => {
    try {
      const priceMeta = priceMetaByStockId.get(Number(stock.id))

      if ((priceMeta?.count ?? 0) < 20 && Number(stock.in_current_watchlist ?? 0) === 1) {
        await fetchAndStoreStockData(env.DB, env.KV, stock, env.FINMIND_TOKEN)
      }

      await computeAndStoreIndicators(env.DB, stock.id)
      if (Number(stock.in_current_watchlist ?? 0) === 1) {
        watchlistNewsStocks.push({
          id: stock.id,
          symbol: stock.symbol,
          market: stock.market ?? null,
          name: stock.name ?? null,
          in_current_watchlist: stock.in_current_watchlist ?? null,
        })
      }
    } catch (e) {
      console.error(`[Queue] Failed ${stock.symbol}:`, e)
    }
  })

  const lastId = currentBatch[currentBatch.length - 1].id

  if (watchlistNewsStocks.length) {
    await env.NEWS_QUEUE.send({
      type: 'news_batch',
      cursor: lastId,
      triggerTime,
      runId: msg.runId,
      newsStocks: watchlistNewsStocks,
    })
    console.log(`[Queue] News batch queued: ${watchlistNewsStocks.length} watchlist stocks (shard=${shardIndex + 1}/${shardCount})`)
  }

  if (hasMore) {
    await env.UPDATE_QUEUE.send({
      type: 'update_batch',
      cursor: lastId,
      triggerTime,
      runId: msg.runId,
      shardIndex,
      shardCount,
    })
    console.log(`[Queue] Next shard batch queued (cursor=${lastId}, shard=${shardIndex + 1}/${shardCount})`)
    return
  }

  await markShardComplete(msg, env, deps)
}
