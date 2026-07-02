import type { Bindings, UpdateQueueMsg } from '../types'
import { checkAlerts } from './localMaintenance'
import { crawlAndStoreNews } from './news'
import { computeAndStoreIndicators } from './technicalIndicators'
import { fetchAndStoreStockData } from '../routes/stocks'
import { assertMarketDataReady, loadMarketDataReadinessStats } from './marketDataReadiness'
import { runRegimeCompute } from './controllerDailyWorkflows'
import { runFinLabV4Backfill } from './controllerResearchWorkflows'
import { runOfficialMarketSummaryRefresh } from './officialMarketSummaryRefresh'
import { enqueuePostScreenerPipelineContinuation } from './postScreenerContinuation'
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
const SOURCE_READINESS_FINLAB_REFRESH_COOLDOWN_SECONDS = 45 * 60
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
  return /Bulk price source incomplete|TWSE source failed|TPEX source failed|price rows=\d+\/|chip latest=|chip rows=\d+\/|margin rows=\d+\//i.test(message)
}

function isFinLabCanonicalReadinessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /FinLab canonical daily not ready|source readiness not ready after refresh/i.test(message)
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

type ReadinessCheck = {
  key: string
  ok: boolean
  summary: string
}

type SourceReadinessSnapshot = {
  ok: boolean
  checks: ReadinessCheck[]
  summary: string
  missingKeys: string[]
}

type SchedulerRunSnapshot = {
  status?: string
  summary?: string
  timestamp?: string
}

async function readSchedulerRunLog(
  env: Bindings,
  task: string,
  runDate: string,
): Promise<SchedulerRunSnapshot | null> {
  return (
    await env.KV.get(`scheduler:run:${task}:${runDate}`, 'json') as SchedulerRunSnapshot | null
  ) ?? (
    await env.KV.get(`cron:log:${task}:${runDate}`, 'json') as SchedulerRunSnapshot | null
  )
}

async function hasEveningChainSucceeded(env: Bindings, runDate: string): Promise<boolean> {
  const entry = await readSchedulerRunLog(env, 'evening-chain', runDate)
  return entry?.status === 'success'
}

async function hasEveningChainInFlight(env: Bindings, runDate: string): Promise<boolean> {
  const entry = await readSchedulerRunLog(env, 'evening-chain', runDate)
  return entry?.status === 'running' || entry?.status === 'triggered'
}

async function countReadinessRows(
  db: D1Database,
  key: string,
  sql: string,
  params: unknown[],
  minRows: number,
): Promise<ReadinessCheck> {
  try {
    const row = await db.prepare(sql).bind(...params).first<{ count: number }>()
    const count = Number(row?.count ?? 0)
    return {
      key,
      ok: count >= minRows,
      summary: count >= minRows ? `${key}=${count}` : `${key} rows=${count}/${minRows}`,
    }
  } catch (e) {
    return {
      key,
      ok: false,
      summary: `${key} query failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

async function checkEveningChainSourceReadiness(
  env: Bindings,
  targetDate: string,
): Promise<SourceReadinessSnapshot> {
  const checks: ReadinessCheck[] = []

  try {
    const summary = await assertFinLabCanonicalDailyReady(env.DB, targetDate)
    checks.push({ key: 'finlab_primary_canonical', ok: true, summary })
  } catch (e) {
    checks.push({
      key: 'finlab_primary_canonical',
      ok: false,
      summary: e instanceof Error ? e.message : String(e),
    })
  }

  try {
    const ready = await assertMarketDataReady(env.DB, targetDate, { requireIndicators: false })
    checks.push({ key: 'official_supplemental_market_data', ok: true, summary: ready.summary })
  } catch (e) {
    checks.push({
      key: 'official_supplemental_market_data',
      ok: false,
      summary: e instanceof Error ? e.message : String(e),
    })
  }

  const canonicalChecks = await Promise.all([
    countReadinessRows(
      env.DB,
      'canonical_market_index_daily:twii',
      "SELECT COUNT(*) AS count FROM canonical_market_index_daily WHERE date = ? AND symbol IN ('TWII', 'TAIEX')",
      [targetDate],
      1,
    ),
    countReadinessRows(
      env.DB,
      'canonical_market_index_daily:twoii',
      "SELECT COUNT(*) AS count FROM canonical_market_index_daily WHERE date = ? AND symbol IN ('TWOII', 'OTC', 'TPEX')",
      [targetDate],
      1,
    ),
    countReadinessRows(
      env.DB,
      'canonical_futures_daily:txf_day',
      "SELECT COUNT(*) AS count FROM canonical_futures_daily WHERE date = ? AND symbol IN ('TXF', 'TX') AND session = 'day'",
      [targetDate],
      1,
    ),
    countReadinessRows(
      env.DB,
      'canonical_market_summary_daily:listed_otc',
      "SELECT COUNT(DISTINCT market_segment) AS count FROM canonical_market_summary_daily WHERE date = ? AND market_segment IN ('LISTED', 'OTC')",
      [targetDate],
      2,
    ),
    countReadinessRows(
      env.DB,
      'canonical_regime_context_daily:pcr',
      "SELECT COUNT(*) AS count FROM canonical_regime_context_daily WHERE date = ? AND dataset = 'tw_option_put_call_ratio'",
      [targetDate],
      1,
    ),
    countReadinessRows(
      env.DB,
      'canonical_regime_context_daily:large_trader',
      "SELECT COUNT(*) AS count FROM canonical_regime_context_daily WHERE date = ? AND dataset = 'tw_taifex_futures_large_trader'",
      [targetDate],
      1,
    ),
    countReadinessRows(
      env.DB,
      'canonical_broker_flow_daily:listed_otc',
      "SELECT COUNT(*) AS count FROM canonical_broker_flow_daily WHERE date = ? AND source = 'finlab.broker_transactions' AND market_segment = 'LISTED_OTC'",
      [targetDate],
      1000,
    ),
    countReadinessRows(
      env.DB,
      'canonical_broker_rank_daily:listed_otc',
      "SELECT COUNT(*) AS count FROM canonical_broker_rank_daily WHERE date = ? AND source = 'finlab.broker_transactions' AND market_segment = 'LISTED_OTC'",
      [targetDate],
      1000,
    ),
  ])
  checks.push(...canonicalChecks)

  const missing = checks.filter((check) => !check.ok)
  return {
    ok: missing.length === 0,
    checks,
    missingKeys: missing.map((check) => check.key),
    summary: missing.length
      ? `source readiness waiting for ${targetDate}: ${missing.map((check) => check.summary).join('; ')}`
      : `source readiness ready for ${targetDate}: ${checks.map((check) => check.summary).join('; ')}`,
  }
}

function readinessDetails(readiness: SourceReadinessSnapshot): string[] {
  return readiness.checks.map((check) => `${check.ok ? 'ok' : 'waiting'} ${check.summary}`)
}

function isOfficialMarketSummaryMissingKey(key: string): boolean {
  return key.startsWith('canonical_market_summary_daily:')
}

function hasOfficialMarketSummaryMissing(readiness: SourceReadinessSnapshot): boolean {
  return readiness.missingKeys.some(isOfficialMarketSummaryMissingKey)
}

function isFinLabRefreshableMissingKey(key: string): boolean {
  return key !== 'official_supplemental_market_data' && !isOfficialMarketSummaryMissingKey(key)
}

function hasFinLabRefreshableMissing(readiness: SourceReadinessSnapshot): boolean {
  return readiness.missingKeys.some(isFinLabRefreshableMissingKey)
}

function finLabRefreshScopeForReadiness(readiness: SourceReadinessSnapshot): {
  lanes?: string
  canonicalDatasets?: string
} {
  const lanes = new Set<string>()
  const datasets = new Set<string>()

  for (const key of readiness.missingKeys) {
    if (!isFinLabRefreshableMissingKey(key)) continue
    if (key === 'finlab_primary_canonical') {
      lanes.add('daily_price')
      lanes.add('chip_diversity')
      lanes.add('institutional_amount_summary')
      datasets.add('canonical_market_daily')
      datasets.add('canonical_chip_daily')
      datasets.add('canonical_institutional_amount_daily')
      continue
    }
    if (key.startsWith('canonical_market_index_daily:')) {
      lanes.add('regime_context')
      datasets.add('canonical_market_index_daily')
      continue
    }
    if (key.startsWith('canonical_futures_daily:')) {
      lanes.add('regime_context')
      datasets.add('canonical_futures_daily')
      continue
    }
    if (key.startsWith('canonical_regime_context_daily:')) {
      lanes.add('regime_context')
      datasets.add('canonical_regime_context_daily')
      continue
    }
    if (key.startsWith('canonical_broker_flow_daily:') || key.startsWith('canonical_broker_rank_daily:')) {
      lanes.add('broker_flow_diversity')
      datasets.add('canonical_broker_flow_daily')
      datasets.add('canonical_broker_rank_daily')
    }
  }

  return {
    lanes: lanes.size ? Array.from(lanes).join(',') : undefined,
    canonicalDatasets: datasets.size ? Array.from(datasets).join(',') : undefined,
  }
}

async function readFinLabRefreshLock(env: Bindings, runDate: string): Promise<string | null> {
  return await env.KV.get(`source-readiness:finlab-refresh:${runDate}`)
}

async function writeFinLabRefreshLock(env: Bindings, runDate: string, summary: string): Promise<void> {
  await env.KV.put(
    `source-readiness:finlab-refresh:${runDate}`,
    summary.slice(0, 500),
    { expirationTtl: SOURCE_READINESS_FINLAB_REFRESH_COOLDOWN_SECONDS },
  )
}

async function assertFinLabCanonicalReadinessReady(env: Bindings, targetDate: string): Promise<string> {
  const readiness = await checkEveningChainSourceReadiness(env, targetDate)
  const missing = readiness.checks.filter((check) =>
    !check.ok &&
    check.key !== 'official_supplemental_market_data' &&
    !isOfficialMarketSummaryMissingKey(check.key)
  )
  if (missing.length) {
    throw new Error(`FinLab canonical daily not ready: ${missing.map((check) => check.summary).join('; ')}`)
  }
  return `FinLab canonical ready for ${targetDate}: ${readiness.checks
    .filter((check) => check.key !== 'official_supplemental_market_data' && !isOfficialMarketSummaryMissingKey(check.key))
    .map((check) => check.summary)
    .join('; ')}`
}

async function refreshOfficialMarketSummaryIfMissing(
  env: Bindings,
  targetDate: string,
  started: number,
): Promise<string | null> {
  const readiness = await checkEveningChainSourceReadiness(env, targetDate)
  if (!hasOfficialMarketSummaryMissing(readiness)) return null

  try {
    const summary = await runOfficialMarketSummaryRefresh(env, targetDate)
    await logSchedulerResult(env.KV, 'official-market-summary-refresh', {
      status: 'success',
      summary,
      duration_ms: Date.now() - started,
      run_date: targetDate,
    })
    return summary
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await logSchedulerResult(env.KV, 'official-market-summary-refresh', {
      status: 'running',
      summary: `official market summary waiting for ${targetDate}: ${message}`,
      duration_ms: Date.now() - started,
      error: message,
      run_date: targetDate,
    })
    return `official_market_summary_waiting=${message}`
  }
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

async function scheduleSourceReadinessRecheck(
  env: Bindings,
  runDate: string,
  attempt: number,
  reason: string,
  runId?: string,
): Promise<void> {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  const summary = [
    `source-readiness recheck for ${runDate}`,
    `attempt=${safeAttempt}/${SOURCE_READINESS_RETRY_MAX_ATTEMPTS}`,
    `retry_in=${SOURCE_READINESS_RETRY_DELAY_SECONDS}s`,
    reason,
  ].join('; ')

  await logSchedulerResult(env.KV, 'source-readiness-probe', {
    status: safeAttempt >= SOURCE_READINESS_RETRY_MAX_ATTEMPTS ? 'error' : 'running',
    summary: safeAttempt >= SOURCE_READINESS_RETRY_MAX_ATTEMPTS
      ? `source readiness recheck timeout for ${runDate}; ${reason}`
      : summary,
    duration_ms: 0,
    error: safeAttempt >= SOURCE_READINESS_RETRY_MAX_ATTEMPTS ? reason : undefined,
    run_id: runId,
    run_date: runDate,
  })
  await logSchedulerResult(env.KV, 'evening-chain', {
    status: safeAttempt >= SOURCE_READINESS_RETRY_MAX_ATTEMPTS ? 'error' : 'running',
    summary: safeAttempt >= SOURCE_READINESS_RETRY_MAX_ATTEMPTS
      ? `root chain waiting timed out at source-readiness gate for ${runDate}`
      : `root chain waiting at source-readiness gate; ${summary}`,
    duration_ms: 0,
    error: safeAttempt >= SOURCE_READINESS_RETRY_MAX_ATTEMPTS ? reason : undefined,
    run_id: runId,
    run_date: runDate,
  }, safeAttempt >= SOURCE_READINESS_RETRY_MAX_ATTEMPTS ? env as any : undefined)

  if (safeAttempt >= SOURCE_READINESS_RETRY_MAX_ATTEMPTS) {
    throw new Error(`source readiness recheck timeout for ${runDate}: ${reason}`)
  }

  await env.UPDATE_QUEUE.send({
    type: 'source_readiness_recheck',
    cursor: 0,
    triggerTime: runDate,
    runId,
    attempt: safeAttempt + 1,
  }, { delaySeconds: SOURCE_READINESS_RETRY_DELAY_SECONDS } as any)
}

type ProcessUpdateBatchDeps = {
  runMarketScreener: (env: Bindings, runDate?: string) => Promise<any>
  runMarketScreenerAsync?: (
    env: Bindings,
    runDate?: string,
    options?: { chainRunId?: string },
  ) => Promise<any>
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

type OfficialSupplementalFetchMode = 'fallback' | 'always' | 'disabled'

export type FinLabLegacyMarketDataSyncSummary = {
  priceRows: number
  chipRows: number
  marginRows: number
  sourceRole: 'finlab_primary_canonical_mirror'
  summary: string
}

export type FinLabLegacyWave2SyncSummary = {
  breadthRows: number
  breadthSampleSize: number
  revenueRows: number
  financialRows: number
  valuationRows: number
  sourceRole: 'finlab_primary_canonical_wave2_mirror'
}

function officialSupplementalFetchMode(env: Bindings): OfficialSupplementalFetchMode {
  const raw = String(env.OFFICIAL_SUPPLEMENTAL_FETCH_MODE ?? 'fallback').trim().toLowerCase()
  if (raw === 'always' || raw === 'disabled') return raw
  return 'fallback'
}

function d1ChangeCount(result: unknown): number {
  const meta = (result as { meta?: { changes?: unknown; rows_written?: unknown } } | null)?.meta
  const value = meta?.changes ?? meta?.rows_written ?? 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export async function syncLegacyMarketDataFromFinLabCanonical(
  db: D1Database,
  targetDate: string,
): Promise<FinLabLegacyMarketDataSyncSummary> {
  const priceResult = await db.prepare(`
    INSERT INTO stock_prices (stock_id, date, open, high, low, close, adj_close, volume, avg_price)
    SELECT
      s.id,
      c.date,
      c.open,
      c.high,
      c.low,
      c.close,
      COALESCE(c.adj_close, c.close),
      CAST(ROUND(COALESCE(c.volume, 0)) AS INTEGER),
      c.avg_price
    FROM canonical_market_daily c
    JOIN stocks s ON s.symbol = c.stock_id
    WHERE c.date = ?
      AND c.source IN ('finlab.price', 'finlab.rotc_price')
      AND c.close IS NOT NULL
      AND COALESCE(UPPER(s.market), '') IN ('TWSE', 'OTC')
    ON CONFLICT(stock_id, date) DO UPDATE SET
      open=excluded.open,
      high=excluded.high,
      low=excluded.low,
      close=excluded.close,
      adj_close=excluded.adj_close,
      volume=excluded.volume,
      avg_price=COALESCE(stock_prices.avg_price, excluded.avg_price)
  `).bind(targetDate).run()

  const chipResult = await db.prepare(`
    INSERT INTO chip_data (
      symbol, date,
      foreign_buy, foreign_sell, foreign_net,
      trust_buy, trust_sell, trust_net,
      dealer_buy, dealer_sell, dealer_net,
      margin_balance, short_balance
    )
    SELECT
      c.stock_id,
      c.date,
      CAST(ROUND(MAX(c.foreign_buy)) AS INTEGER),
      CAST(ROUND(MAX(c.foreign_sell)) AS INTEGER),
      CAST(ROUND(MAX(c.foreign_net)) AS INTEGER),
      CAST(ROUND(MAX(c.trust_buy)) AS INTEGER),
      CAST(ROUND(MAX(c.trust_sell)) AS INTEGER),
      CAST(ROUND(MAX(c.trust_net)) AS INTEGER),
      CAST(ROUND(MAX(c.dealer_buy)) AS INTEGER),
      CAST(ROUND(MAX(c.dealer_sell)) AS INTEGER),
      CAST(ROUND(MAX(c.dealer_net)) AS INTEGER),
      CAST(ROUND(MAX(c.margin_balance)) AS INTEGER),
      CAST(ROUND(MAX(c.short_balance)) AS INTEGER)
    FROM canonical_chip_daily c
    JOIN stocks s ON s.symbol = c.stock_id
    WHERE c.date = ?
      AND c.source LIKE 'finlab.%'
      AND COALESCE(UPPER(s.market), '') IN ('TWSE', 'OTC')
    GROUP BY c.stock_id, c.date
    ON CONFLICT(symbol, date) DO UPDATE SET
      foreign_buy=COALESCE(excluded.foreign_buy, chip_data.foreign_buy),
      foreign_sell=COALESCE(excluded.foreign_sell, chip_data.foreign_sell),
      foreign_net=COALESCE(excluded.foreign_net, chip_data.foreign_net),
      trust_buy=COALESCE(excluded.trust_buy, chip_data.trust_buy),
      trust_sell=COALESCE(excluded.trust_sell, chip_data.trust_sell),
      trust_net=COALESCE(excluded.trust_net, chip_data.trust_net),
      dealer_buy=COALESCE(excluded.dealer_buy, chip_data.dealer_buy),
      dealer_sell=COALESCE(excluded.dealer_sell, chip_data.dealer_sell),
      dealer_net=COALESCE(excluded.dealer_net, chip_data.dealer_net),
      margin_balance=COALESCE(excluded.margin_balance, chip_data.margin_balance),
      short_balance=COALESCE(excluded.short_balance, chip_data.short_balance)
  `).bind(targetDate).run()

  const marginResult = await db.prepare(`
    INSERT INTO margin_data (
      stock_id, date,
      margin_buy, margin_sell, margin_balance,
      short_buy, short_sell, short_balance,
      margin_usage_pct, short_ratio
    )
    SELECT
      s.id,
      c.date,
      NULL,
      NULL,
      CAST(ROUND(MAX(c.margin_balance)) AS INTEGER),
      NULL,
      NULL,
      CAST(ROUND(MAX(c.short_balance)) AS INTEGER),
      NULL,
      CASE
        WHEN MAX(c.margin_balance) IS NULL OR ABS(MAX(c.margin_balance)) < 1 THEN NULL
        ELSE MAX(c.short_balance) / MAX(c.margin_balance)
      END
    FROM canonical_chip_daily c
    JOIN stocks s ON s.symbol = c.stock_id
    WHERE c.date = ?
      AND c.source LIKE 'finlab.%'
      AND COALESCE(UPPER(s.market), '') IN ('TWSE', 'OTC')
      AND (c.margin_balance IS NOT NULL OR c.short_balance IS NOT NULL)
    GROUP BY s.id, c.date
    ON CONFLICT(stock_id, date) DO UPDATE SET
      margin_balance=COALESCE(excluded.margin_balance, margin_data.margin_balance),
      short_balance=COALESCE(excluded.short_balance, margin_data.short_balance),
      short_ratio=COALESCE(excluded.short_ratio, margin_data.short_ratio)
  `).bind(targetDate).run()

  const priceRows = d1ChangeCount(priceResult)
  const chipRows = d1ChangeCount(chipResult)
  const marginRows = d1ChangeCount(marginResult)
  return {
    priceRows,
    chipRows,
    marginRows,
    sourceRole: 'finlab_primary_canonical_mirror',
    summary: `FinLab canonical mirrored to legacy serving tables for ${targetDate}: stock_prices=${priceRows} chip_data=${chipRows} margin_data=${marginRows}`,
  }
}

export async function syncMarketBreadthFromFinLabCanonical(
  db: D1Database,
  targetDate: string,
): Promise<{ rows: number; sampleSize: number; advanceCount: number; declineCount: number; unchangedCount: number }> {
  const breadth = await db.prepare(`
    WITH current_prices AS (
      SELECT c.stock_id, c.date, c.close
      FROM canonical_market_daily c
      JOIN stocks s ON s.symbol = c.stock_id
      WHERE c.date = ?
        AND c.source IN ('finlab.price', 'finlab.rotc_price')
        AND c.close IS NOT NULL
        AND c.close > 0
        AND COALESCE(UPPER(s.market), '') IN ('TWSE', 'OTC')
    ),
    prev_dates AS (
      SELECT cur.stock_id, MAX(prev.date) AS prev_date
      FROM current_prices cur
      JOIN canonical_market_daily prev
        ON prev.stock_id = cur.stock_id
       AND prev.date < cur.date
       AND prev.source IN ('finlab.price', 'finlab.rotc_price')
       AND prev.close IS NOT NULL
       AND prev.close > 0
      GROUP BY cur.stock_id
    ),
    paired AS (
      SELECT cur.close AS close, prev.close AS prev_close
      FROM current_prices cur
      JOIN prev_dates pd ON pd.stock_id = cur.stock_id
      JOIN canonical_market_daily prev
        ON prev.stock_id = pd.stock_id
       AND prev.date = pd.prev_date
       AND prev.source IN ('finlab.price', 'finlab.rotc_price')
    )
    SELECT
      COUNT(*) AS sample_size,
      SUM(CASE WHEN close > prev_close THEN 1 ELSE 0 END) AS advance_count,
      SUM(CASE WHEN close < prev_close THEN 1 ELSE 0 END) AS decline_count,
      SUM(CASE WHEN close = prev_close THEN 1 ELSE 0 END) AS unchanged_count
    FROM paired
  `).bind(targetDate).first<{
    sample_size: number | null
    advance_count: number | null
    decline_count: number | null
    unchanged_count: number | null
  }>()

  const sampleSize = Number(breadth?.sample_size ?? 0)
  const advanceCount = Number(breadth?.advance_count ?? 0)
  const declineCount = Number(breadth?.decline_count ?? 0)
  const unchangedCount = Number(breadth?.unchanged_count ?? 0)
  if (sampleSize < 1000) {
    return { rows: 0, sampleSize, advanceCount, declineCount, unchangedCount }
  }
  const ratio = sampleSize > 0 ? advanceCount / sampleSize : null
  const result = await db.prepare(`
    INSERT INTO market_breadth (date, advance_count, decline_count, unchanged_count, advance_ratio)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      advance_count=excluded.advance_count,
      decline_count=excluded.decline_count,
      unchanged_count=excluded.unchanged_count,
      advance_ratio=excluded.advance_ratio
  `).bind(targetDate, advanceCount, declineCount, unchangedCount, ratio).run()
  return {
    rows: d1ChangeCount(result),
    sampleSize,
    advanceCount,
    declineCount,
    unchangedCount,
  }
}

export async function syncLegacyRevenueFromFinLabCanonical(
  db: D1Database,
  targetDate: string,
): Promise<number> {
  const result = await db.prepare(`
    INSERT INTO monthly_revenue (stock_id, date, revenue, revenue_yoy, revenue_mom)
    SELECT
      s.id,
      r.revenue_month,
      r.revenue,
      r.yoy,
      r.mom
    FROM canonical_revenue_monthly r
    JOIN stocks s ON s.symbol = r.stock_id
    WHERE r.source LIKE 'finlab.%'
      AND r.revenue_month >= strftime('%Y-%m', date(?, '-18 months'))
      AND r.revenue_month <= strftime('%Y-%m', ?)
      AND r.revenue IS NOT NULL
      AND COALESCE(UPPER(s.market), '') IN ('TWSE', 'OTC')
    ON CONFLICT(stock_id, date) DO UPDATE SET
      revenue=excluded.revenue,
      revenue_yoy=excluded.revenue_yoy,
      revenue_mom=excluded.revenue_mom
  `).bind(targetDate, targetDate).run()
  return d1ChangeCount(result)
}

function quarterFromIsoDate(date: string): string {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const quarter = Math.max(1, Math.min(4, Math.ceil(month / 3)))
  return `${year}Q${quarter}`
}

export async function syncLegacyFinancialsFromFinLabCanonical(
  db: D1Database,
  targetDate: string,
): Promise<{ financialRows: number; valuationRows: number }> {
  const factResult = await db.prepare(`
    WITH normalized AS (
      SELECT
        s.id AS legacy_stock_id,
        CASE
          WHEN instr(f.period, 'Q') > 0 THEN f.period
          WHEN length(f.period) >= 7 THEN substr(f.period, 1, 4) || 'Q' || CAST(((CAST(substr(f.period, 6, 2) AS INTEGER) + 2) / 3) AS INTEGER)
          ELSE f.period
        END AS legacy_period,
        COALESCE(f.available_date, f.report_date, f.period) AS source_date,
        f.revenue,
        f.eps,
        f.roe,
        f.operating_income,
        f.net_income,
        f.total_assets,
        f.total_liabilities
      FROM canonical_fundamental_features f
      JOIN stocks s ON s.symbol = f.stock_id
      WHERE f.source LIKE 'finlab.%'
        AND COALESCE(f.available_date, f.report_date, f.period) <= ?
        AND COALESCE(f.available_date, f.report_date, f.period) >= date(?, '-3 years')
        AND COALESCE(UPPER(s.market), '') IN ('TWSE', 'OTC')
        AND (
          f.revenue IS NOT NULL OR f.eps IS NOT NULL OR f.roe IS NOT NULL
          OR f.operating_income IS NOT NULL OR f.net_income IS NOT NULL
          OR f.total_assets IS NOT NULL OR f.total_liabilities IS NOT NULL
        )
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY legacy_stock_id, legacy_period
          ORDER BY source_date DESC
        ) AS rn
      FROM normalized
      WHERE legacy_period IS NOT NULL AND legacy_period != ''
    )
    INSERT INTO financials (
      stock_id, period, period_type,
      revenue, eps, roe, operating_income, net_income, total_assets, total_liabilities
    )
    SELECT
      legacy_stock_id,
      legacy_period,
      'quarterly',
      revenue,
      eps,
      roe,
      operating_income,
      net_income,
      total_assets,
      total_liabilities
    FROM ranked
    WHERE rn = 1
    ON CONFLICT(stock_id, period) DO UPDATE SET
      revenue=COALESCE(excluded.revenue, financials.revenue),
      eps=COALESCE(excluded.eps, financials.eps),
      roe=COALESCE(excluded.roe, financials.roe),
      operating_income=COALESCE(excluded.operating_income, financials.operating_income),
      net_income=COALESCE(excluded.net_income, financials.net_income),
      total_assets=COALESCE(excluded.total_assets, financials.total_assets),
      total_liabilities=COALESCE(excluded.total_liabilities, financials.total_liabilities)
  `).bind(targetDate, targetDate).run()

  const currentQuarter = quarterFromIsoDate(targetDate)
  const valuationResult = await db.prepare(`
    WITH latest_valuation AS (
      SELECT
        s.id AS legacy_stock_id,
        f.pe,
        f.pb,
        f.dividend_yield,
        COALESCE(f.available_date, f.report_date, f.period) AS source_date,
        ROW_NUMBER() OVER (
          PARTITION BY s.id
          ORDER BY COALESCE(f.available_date, f.report_date, f.period) DESC
        ) AS rn
      FROM canonical_fundamental_features f
      JOIN stocks s ON s.symbol = f.stock_id
      WHERE f.source LIKE 'finlab.%'
        AND COALESCE(f.available_date, f.report_date, f.period) <= ?
        AND (f.pe IS NOT NULL OR f.pb IS NOT NULL OR f.dividend_yield IS NOT NULL)
        AND COALESCE(UPPER(s.market), '') IN ('TWSE', 'OTC')
    )
    INSERT INTO financials (stock_id, period, period_type, pe, pb, dividend_yield)
    SELECT
      legacy_stock_id,
      COALESCE((
        SELECT MAX(existing.period)
        FROM financials existing
        WHERE existing.stock_id = latest_valuation.legacy_stock_id
          AND existing.period LIKE '%Q%'
      ), ?),
      'quarterly',
      pe,
      pb,
      dividend_yield
    FROM latest_valuation
    WHERE rn = 1
    ON CONFLICT(stock_id, period) DO UPDATE SET
      pe=COALESCE(excluded.pe, financials.pe),
      pb=COALESCE(excluded.pb, financials.pb),
      dividend_yield=COALESCE(excluded.dividend_yield, financials.dividend_yield)
  `).bind(targetDate, currentQuarter).run()

  return {
    financialRows: d1ChangeCount(factResult),
    valuationRows: d1ChangeCount(valuationResult),
  }
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
  const supplementalMode = officialSupplementalFetchMode(env)
  let finlabMirrorSummary: string | null = null

  try {
    const mirror = await syncLegacyMarketDataFromFinLabCanonical(env.DB, twDate)
    finlabMirrorSummary = mirror.summary
    if (supplementalMode !== 'always') {
      const ready = await assertMarketDataReady(env.DB, twDate, { requireIndicators: false })
      await env.KV.put(lockKey, '1', { expirationTtl: 86400 })
      return `${ready.summary}; ${mirror.summary}; TWSE/TPEX supplemental bulk fetch skipped; source_role=${mirror.sourceRole}; supplemental_mode=${supplementalMode}`
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (supplementalMode === 'disabled') throw e
    console.warn('[Cron] FinLab canonical mirror not ready; falling back to TWSE/TPEX supplemental fetch:', message)
    finlabMirrorSummary = finlabMirrorSummary ?? `FinLab canonical mirror not ready: ${message}`
  }

  if (isHistoricalReplayDate(twDate)) {
    try {
      const ready = await assertMarketDataReady(env.DB, twDate, { requireIndicators: false })
      await env.KV.put(lockKey, '1', { expirationTtl: 86400 })
      return `TWSE/TPEX supplemental fetch skipped for historical replay; ${ready.summary}; ${finlabMirrorSummary ?? 'FinLab canonical mirror not applied'}; source_role=legacy_ready_after_finlab_primary_attempt`
    } catch {
      // Historical replay only falls through to source fetch when target-date
      // supplemental rows are genuinely missing or below the production floor.
    }
  }
  if (!force && await env.KV.get(lockKey)) {
    console.log(`[Cron] TWSE/TPEX supplemental fetch already done today (${twDate}), skipping.`)
    const ready = await assertMarketDataReady(env.DB, twDate, { requireIndicators: false })
    return `TWSE/TPEX supplemental fetch skipped; ${ready.summary}; ${finlabMirrorSummary ?? 'FinLab canonical mirror not applied'}; source_role=legacy_ready_after_finlab_primary_attempt`
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
    return `${ready.summary}; ${finlabMirrorSummary ?? 'FinLab canonical mirror not applied'}; TWSE/TPEX supplemental fetched price=${priceCount} chip=${chipCount} margin=${marginCount}; source_role=official_fallback_after_finlab_primary_attempt`
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

  const runAsyncScreener = deps.runMarketScreenerAsync
  if (runAsyncScreener) {
    try {
      const screenerResult = await runAsyncScreener(env, triggerTime, { chainRunId: runId })
      const screenerSummary = typeof screenerResult === 'string'
        ? screenerResult
        : JSON.stringify(screenerResult)?.slice(0, 500) ?? ''
      const screenerLocked = screenerSummary.trim().toUpperCase().startsWith('LOCKED')
      const screenerStatus = screenerLocked ? 'triggered' : classifySchedulerSummary(screenerSummary)
      await logSchedulerResult(env.KV, 'screener', {
        status: screenerStatus,
        summary: screenerSummary,
        duration_ms: 0,
        run_date: triggerTime,
      })
      await logSchedulerResult(env.KV, 'evening-chain', {
        status: screenerStatus === 'triggered' || screenerStatus === 'running' ? 'running' : screenerStatus,
        summary: `event-driven chain triggered screener-v2 for ${triggerTime}; ${screenerSummary}`,
        duration_ms: 0,
        run_date: triggerTime,
        run_id: runId,
      })
      console.log(`[Queue] Event-driven: screener-v2 triggered for ${triggerTime}; awaiting callback`)
    } catch (e) {
      await logSchedulerResult(env.KV, 'evening-chain', {
        status: 'error',
        summary: `event-driven chain stopped: screener-v2 trigger failed for ${triggerTime}`,
        duration_ms: 0,
        error: String(e),
        run_date: triggerTime,
        run_id: runId,
      })
      await logSchedulerResult(env.KV, 'screener', {
        status: 'error',
        summary: e instanceof Error ? e.message : String(e),
        duration_ms: 0,
        error: String(e),
        run_date: triggerTime,
      })
      console.warn('[Queue] Event-driven screener-v2 trigger failed:', e)
    }
    return
  }

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

  await enqueuePostScreenerPipelineContinuation(env, {
    triggerTime,
    runId,
    shardCount,
    source,
  })
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
  const officialMarketSummary = await refreshOfficialMarketSummaryIfMissing(env, twDate, Date.now())
  if (officialMarketSummary?.startsWith('official_market_summary_waiting=')) {
    await scheduleSourceReadinessRetry(env, twDate, 1, officialMarketSummary)
    return `source waiting; queued official market summary retry for ${twDate}; ${officialMarketSummary}`
  }
  const canonicalSummary = await assertFinLabCanonicalReadinessReady(env, twDate)
  let bulkSummary: string
  try {
    bulkSummary = await runBulkFetch(env, force, twDate)
  } catch (e) {
    if (!isBulkPriceSourceNotReady(e)) throw e
    const message = e instanceof Error ? e.message : String(e)
    await scheduleSourceReadinessRetry(env, twDate, 1, message)
    return `source waiting; queued same-day market data retry for ${twDate}; ${message}`
  }
  const readiness = await checkEveningChainSourceReadiness(env, twDate)
  if (!readiness.ok) {
    throw new Error(`source readiness not ready after refresh: ${readiness.summary}`)
  }
  await logSchedulerResult(env.KV, 'update', {
    status: 'success',
    summary: `market data update ready for ${twDate}; FinLab primary canonical ready; official market summary ready; TWSE/TPEX supplemental refresh complete; ${canonicalSummary}; ${officialMarketSummary ?? 'official_market_summary=already_ready'}; ${bulkSummary}`,
    duration_ms: 0,
    details: readinessDetails(readiness),
    run_id: runId,
    run_date: twDate,
  })
  await runQueueUpdate(env, twDate, force)
  return `${canonicalSummary}; ${officialMarketSummary ?? 'official_market_summary=already_ready'}; TWSE/TPEX supplemental refresh complete; ${bulkSummary}; indicator queue accepted`
}

export async function runMarketCloseRefresh(env: Bindings, force = false, runDate?: string): Promise<string> {
  const twDate = resolveUpdateDate(runDate)
  const lockKey = `cron:market-close-refresh:${twDate}`
  if (!force && await env.KV.get(lockKey)) {
    const stats = await loadMarketDataReadinessStats(env.DB, twDate)
    return `SKIP: market-close-refresh already ran for ${twDate}; price=${stats.priceRowsOnLatest} latest=${stats.priceLatestDate ?? 'none'}`
  }

  const started = Date.now()
  const parts: string[] = []
  let sourceWaiting = false
  let shouldFetchOfficialPrices = officialSupplementalFetchMode(env) === 'always'

  if (!shouldFetchOfficialPrices) {
    try {
      const mirror = await syncLegacyMarketDataFromFinLabCanonical(env.DB, twDate)
      const stats = await loadMarketDataReadinessStats(env.DB, twDate)
      const finlabPriceReady =
        stats.priceLatestDate === twDate &&
        stats.priceRowsOnLatest >= 1000 &&
        Number(stats.priceTwseRowsOnLatest ?? 0) >= 900 &&
        Number(stats.priceOtcRowsOnLatest ?? 0) >= 700
      parts.push(`finlab_mirror=${mirror.priceRows}/${mirror.chipRows}/${mirror.marginRows}`)
      shouldFetchOfficialPrices = !finlabPriceReady
    } catch (e) {
      parts.push(`finlab_mirror_waiting=${e instanceof Error ? e.message : String(e)}`)
      shouldFetchOfficialPrices = officialSupplementalFetchMode(env) !== 'disabled'
      sourceWaiting = officialSupplementalFetchMode(env) === 'disabled'
    }
  }

  if (shouldFetchOfficialPrices) {
    try {
      const { bulkFetchAndStorePrices } = await import('./twseApi')
      const controllerUrl = env.ML_CONTROLLER_URL ?? env.SHIOAJI_PROXY_URL
      const priceCount = await bulkFetchAndStorePrices(env.DB, twDate, controllerUrl, env.ML_CONTROLLER_SECRET)
      parts.push(`official_prices=${priceCount}`)
    } catch (e) {
      sourceWaiting = true
      parts.push(`official_prices_waiting=${e instanceof Error ? e.message : String(e)}`)
    }
  } else {
    parts.push('official_prices=skipped_finlab_primary')
  }

  try {
    await fetchWave2Data(env, twDate)
    parts.push('wave2=attempted')
  } catch (e) {
    parts.push(`wave2_warn=${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const { fetchTaifexDayClose, fetchTaifexNightClose } = await import('./twseApi')
    const [dayClose, nightClose] = await Promise.all([
      fetchTaifexDayClose(),
      fetchTaifexNightClose(),
    ])
    if (dayClose) {
      await env.KV.put(`market:taifex_day_close:${twDate}`, JSON.stringify(dayClose), { expirationTtl: 2 * 86400 })
      parts.push(`taifex_day=${dayClose.lastPrice}`)
    } else {
      parts.push('taifex_day=missing')
    }
    if (nightClose) {
      await env.KV.put(`market:taifex_night_close:${twDate}`, JSON.stringify(nightClose), { expirationTtl: 2 * 86400 })
      parts.push(`taifex_night=${nightClose.lastPrice}`)
    } else {
      parts.push('taifex_night=missing')
    }
  } catch (e) {
    parts.push(`taifex_warn=${e instanceof Error ? e.message : String(e)}`)
  }

  try {
    const { refreshOpenPositionPostClosePriceCache } = await import('./paperIntradayPriceCache')
    const result = await refreshOpenPositionPostClosePriceCache(env, { tradeDate: twDate })
    parts.push(result.summary)
  } catch (e) {
    parts.push(`post_close_price_warn=${e instanceof Error ? e.message : String(e)}`)
  }

  const stats = await loadMarketDataReadinessStats(env.DB, twDate)
  const priceReady =
    stats.priceLatestDate === twDate &&
    stats.priceRowsOnLatest >= 1000 &&
    Number(stats.priceTwseRowsOnLatest ?? 0) >= 900 &&
    Number(stats.priceOtcRowsOnLatest ?? 0) >= 700
  const status = priceReady && !sourceWaiting ? 'success' : 'running'
  const summary = [
    status === 'running' ? 'running: market-close refresh waiting for complete close data' : 'market-close refresh complete',
    `date=${twDate}`,
    `price_latest=${stats.priceLatestDate ?? 'none'}`,
    `price_rows=${stats.priceRowsOnLatest}`,
    ...parts,
  ].join('; ')

  await logSchedulerResult(env.KV, 'market-close-refresh', {
    status,
    summary,
    duration_ms: Date.now() - started,
    run_date: twDate,
  })
  if (status === 'success') await env.KV.put(lockKey, '1', { expirationTtl: 86400 })
  return summary
}

export async function runSourceReadinessProbe(
  env: Bindings,
  force = false,
  runDate?: string,
  options: { ignoreEveningChainInFlight?: boolean } = {},
): Promise<string> {
  const twDate = resolveUpdateDate(runDate)
  const started = Date.now()
  const supplementalMode = officialSupplementalFetchMode(env)
  if (!force && await hasEveningChainSucceeded(env, twDate)) {
    const summary = `SKIP: full evening chain already succeeded for ${twDate}; readiness probe will not rerun`
    await logSchedulerResult(env.KV, 'source-readiness-probe', {
      status: 'skipped',
      summary,
      duration_ms: Date.now() - started,
      run_date: twDate,
    })
    return summary
  }
  if (!force && !options.ignoreEveningChainInFlight && await hasEveningChainInFlight(env, twDate)) {
    const summary = `running: full evening chain already in flight for ${twDate}; readiness probe will not duplicate trigger`
    await logSchedulerResult(env.KV, 'source-readiness-probe', {
      status: 'running',
      summary,
      duration_ms: Date.now() - started,
      run_date: twDate,
    })
    return summary
  }

  let readiness = await checkEveningChainSourceReadiness(env, twDate)
  let officialMarketSummaryWaiting: string | null = null
  if (!readiness.ok && hasOfficialMarketSummaryMissing(readiness)) {
    const officialSummary = await refreshOfficialMarketSummaryIfMissing(env, twDate, started)
    readiness = await checkEveningChainSourceReadiness(env, twDate)
    if (officialSummary?.startsWith('official_market_summary_waiting=')) {
      officialMarketSummaryWaiting = officialSummary
    }
  }
  if (!readiness.ok && hasFinLabRefreshableMissing(readiness)) {
    const finlabLog = await readSchedulerRunLog(env, 'finlab-v4-backfill', twDate)
    const finlabInFlight = finlabLog?.status === 'running' || finlabLog?.status === 'triggered'
    const refreshLock = await readFinLabRefreshLock(env, twDate)
    if ((!finlabInFlight && !refreshLock) || force) {
      const refreshScope = finLabRefreshScopeForReadiness(readiness)
      const finlabSummary = String(await runFinLabV4Backfill(env, twDate, force, {
        continueEveningChain: false,
        dailySourceRefresh: true,
        callbackMode: 'readiness_probe',
        ...refreshScope,
      }))
      const finlabStatus = classifySchedulerSummary(finlabSummary)
      await logSchedulerResult(env.KV, 'finlab-v4-backfill', {
        status: finlabStatus,
        summary: `readiness probe triggered daily source refresh without direct continuation; ${finlabSummary}`,
        duration_ms: 0,
        details: readinessDetails(readiness),
        run_date: twDate,
      })
      if (finlabStatus === 'error') {
        await logSchedulerResult(env.KV, 'source-readiness-probe', {
          status: 'error',
          summary: `FinLab canonical refresh failed before readiness gate: ${finlabSummary}`,
          duration_ms: Date.now() - started,
          error: finlabSummary,
          details: readinessDetails(readiness),
          run_date: twDate,
        }, env as any)
        throw new Error(`FinLab canonical refresh failed before readiness gate: ${finlabSummary}`)
      }
      await writeFinLabRefreshLock(env, twDate, finlabSummary)
      if (finlabStatus !== 'success') {
        const summary = `running: ${readiness.summary}; finlab_refresh=${finlabSummary}${officialMarketSummaryWaiting ? `; ${officialMarketSummaryWaiting}` : ''}`
        await logSchedulerResult(env.KV, 'source-readiness-probe', {
          status: 'running',
          summary,
          duration_ms: Date.now() - started,
          details: readinessDetails(readiness),
          run_date: twDate,
        })
        return summary
      }
      readiness = await checkEveningChainSourceReadiness(env, twDate)
    } else {
      const refreshState = finlabInFlight ? (finlabLog?.status ?? 'in-flight') : `cooldown ${refreshLock}`
      const summary = `running: ${readiness.summary}; finlab_refresh already ${refreshState}${officialMarketSummaryWaiting ? `; ${officialMarketSummaryWaiting}` : ''}`
      await logSchedulerResult(env.KV, 'source-readiness-probe', {
        status: 'running',
        summary,
        duration_ms: Date.now() - started,
        details: readinessDetails(readiness),
        run_date: twDate,
      })
      return summary
    }
  }

  if (!readiness.ok && officialMarketSummaryWaiting && !hasFinLabRefreshableMissing(readiness)) {
    const summary = `running: ${readiness.summary}; ${officialMarketSummaryWaiting}`
    await logSchedulerResult(env.KV, 'source-readiness-probe', {
      status: 'running',
      summary,
      duration_ms: Date.now() - started,
      details: readinessDetails(readiness),
      run_date: twDate,
    })
    return summary
  }

  if (!readiness.ok && readiness.missingKeys.includes('official_supplemental_market_data')) {
    let finlabSupplementalSummary: string | null = null
    if (supplementalMode !== 'always') {
      try {
        const mirror = await syncLegacyMarketDataFromFinLabCanonical(env.DB, twDate)
        await fetchWave2Data(env, twDate).catch((e) => console.warn('[Wave2] readiness probe FinLab refresh failed:', e))
        readiness = await checkEveningChainSourceReadiness(env, twDate)
        finlabSupplementalSummary = `finlab_probe_mirror=${mirror.priceRows}/${mirror.chipRows}/${mirror.marginRows}`
        readiness.summary = `${readiness.summary}; ${finlabSupplementalSummary}`
      } catch (e) {
        finlabSupplementalSummary = `finlab_probe_mirror_waiting=${e instanceof Error ? e.message : String(e)}`
      }
    }
    if (!readiness.ok && readiness.missingKeys.includes('official_supplemental_market_data') && supplementalMode === 'disabled') {
      const summary = `running: ${readiness.summary}; ${finlabSupplementalSummary ?? 'finlab_probe_mirror=not_attempted'}; official_supplemental_fetch=disabled`
      await logSchedulerResult(env.KV, 'source-readiness-probe', {
        status: 'running',
        summary,
        duration_ms: Date.now() - started,
        details: readinessDetails(readiness),
        run_date: twDate,
      })
      return summary
    }
  }

  if (!readiness.ok && readiness.missingKeys.includes('official_supplemental_market_data')) {
    try {
      const { bulkFetchAndStoreChipData, bulkFetchAndStorePrices } = await import('./twseApi')
      const controllerUrl = env.ML_CONTROLLER_URL ?? env.SHIOAJI_PROXY_URL
      const [{ chipCount, marginCount }, priceCount] = await Promise.all([
        bulkFetchAndStoreChipData(env.DB, twDate, controllerUrl, env.ML_CONTROLLER_SECRET),
        bulkFetchAndStorePrices(env.DB, twDate, controllerUrl, env.ML_CONTROLLER_SECRET),
      ])
      await fetchWave2Data(env, twDate).catch((e) => console.warn('[Wave2] readiness probe refresh failed:', e))
      readiness = await checkEveningChainSourceReadiness(env, twDate)
      readiness.summary = `${readiness.summary}; supplemental_probe_fetch price=${priceCount} chip=${chipCount} margin=${marginCount}`
    } catch (e) {
      if (!isBulkPriceSourceNotReady(e)) throw e
      const summary = `running: ${readiness.summary}; supplemental_fetch_waiting=${e instanceof Error ? e.message : String(e)}`
      await logSchedulerResult(env.KV, 'source-readiness-probe', {
        status: 'running',
        summary,
        duration_ms: Date.now() - started,
        details: readinessDetails(readiness),
        run_date: twDate,
      })
      return summary
    }
  }

  if (!readiness.ok) {
    const summary = `running: ${readiness.summary}`
    await logSchedulerResult(env.KV, 'source-readiness-probe', {
      status: 'running',
      summary,
      duration_ms: Date.now() - started,
      details: readinessDetails(readiness),
      run_date: twDate,
    })
    return summary
  }

  const runId = `readiness-gated-${twDate}-${Date.now().toString(36)}`
  await env.KV.put(`readiness-gated:evening-chain-triggered:${twDate}`, runId, { expirationTtl: 2 * 86400 })
  await logSchedulerResult(env.KV, 'evening-chain', {
    status: 'triggered',
    summary: `readiness probe accepted for ${twDate}; full evening chain starting; ${readiness.summary}`,
    duration_ms: 0,
    details: readinessDetails(readiness),
    run_id: runId,
    run_date: twDate,
  })
  const continuation = await continueAfterFinLabBackfill(env, twDate, force, runId)
  const summary = `triggered evening-chain: source readiness ready for ${twDate}; ${continuation}`
  await logSchedulerResult(env.KV, 'source-readiness-probe', {
    status: 'triggered',
    summary,
    duration_ms: Date.now() - started,
    details: readinessDetails(readiness),
    run_id: runId,
    run_date: twDate,
  })
  await logSchedulerResult(env.KV, 'evening-chain', {
    status: 'running',
    summary: `readiness-gated evening chain started; ${summary}`,
    duration_ms: 0,
    details: readinessDetails(readiness),
    run_id: runId,
    run_date: twDate,
  })
  return summary
}

export async function runDailyUpdate(env: Bindings, force = false, runDate?: string): Promise<string> {
  const twDate = resolveUpdateDate(runDate)
  if (!force && await hasEveningChainSucceeded(env, twDate)) {
    return `readiness-gated full chain already succeeded for ${twDate}; 22:00 fallback suppressed`
  }
  if (!force && await hasEveningChainInFlight(env, twDate)) {
    const summary = `running: readiness-gated full chain already in flight for ${twDate}; 22:00 fallback suppressed`
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'running',
      summary,
      duration_ms: 0,
      run_date: twDate,
    })
    return summary
  }
  if (force && runDate && isHistoricalReplayDate(twDate)) {
    try {
      const canonicalSummary = await assertFinLabCanonicalReadinessReady(env, twDate)
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
  const finlabSummary = String(await runFinLabV4Backfill(env, twDate, force, {
    continueEveningChain: true,
    dailySourceRefresh: true,
    callbackMode: 'evening_chain',
  }))
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
  const supplementalMode = officialSupplementalFetchMode(env)
  const forceOfficial = supplementalMode === 'always'
  const officialFallbackAllowed = supplementalMode !== 'disabled'
  const {
    fetchTwseValuation,
    fetchTpexValuation,
    fetchTwseMonthlyRevenue,
    fetchTpexMonthlyRevenue,
    fetchMarketBreadth,
    fetchTwseFinancials,
    fetchTpexFinancials,
  } = await import('./twseApi')

  let finlabFinancialRows = 0
  let finlabValuationRows = 0

  try {
    const finlabBreadth = await syncMarketBreadthFromFinLabCanonical(env.DB, today)
    if (finlabBreadth.sampleSize >= 1000) {
      console.log(
        `[Wave2] FinLab market breadth: ${finlabBreadth.advanceCount}/${finlabBreadth.declineCount}/${finlabBreadth.unchangedCount} sample=${finlabBreadth.sampleSize}`,
      )
    }
    if ((forceOfficial || finlabBreadth.sampleSize < 1000) && officialFallbackAllowed) {
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
          `[Wave2] Official fallback market breadth: ${breadth.advance_count}/${breadth.decline_count}/${breadth.unchanged_count} (${(breadth.advance_ratio * 100).toFixed(0)}%)`,
        )
      }
    }
  } catch (e) {
    console.warn('[Wave2] FinLab market breadth failed:', e)
    if (officialFallbackAllowed) {
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
          `).bind(breadth.date, breadth.advance_count, breadth.decline_count, breadth.unchanged_count, breadth.advance_ratio).run()
        }
      } catch (fallbackError) {
        console.warn('[Wave2] Official fallback market breadth failed:', fallbackError)
      }
    }
  }

  try {
    const finlabFinancials = await syncLegacyFinancialsFromFinLabCanonical(env.DB, today)
    finlabFinancialRows = finlabFinancials.financialRows
    finlabValuationRows = finlabFinancials.valuationRows
    console.log(
      `[Wave2] FinLab financials mirror: facts=${finlabFinancialRows} valuation=${finlabValuationRows}`,
    )
  } catch (e) {
    console.warn('[Wave2] FinLab financials mirror failed:', e)
  }

  if (forceOfficial || (officialFallbackAllowed && finlabValuationRows === 0)) {
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
  }

  const day = parseInt(today.slice(8, 10), 10)
  let finlabRevenueRows = 0
  if (day <= 12) {
    try {
      finlabRevenueRows = await syncLegacyRevenueFromFinLabCanonical(env.DB, today)
      console.log(`[Wave2] FinLab monthly revenue mirror: rows=${finlabRevenueRows}`)
    } catch (e) {
      console.warn('[Wave2] FinLab monthly revenue mirror failed:', e)
    }
  }

  if (day <= 12 && (forceOfficial || (officialFallbackAllowed && finlabRevenueRows === 0))) {
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

  if (forceOfficial || (officialFallbackAllowed && finlabFinancialRows === 0)) {
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
          status: 'running',
          summary: `FinLab callback completed but target-date canonical lanes are still waiting; ${message}`,
          duration_ms: 0,
          run_id: msg.runId,
          run_date: triggerTime,
        })
        await scheduleSourceReadinessRecheck(env, triggerTime, attempt, message, msg.runId)
        return
      }
      throw e
    }
    return
  }

  if (msg.type === 'source_readiness_recheck') {
    const triggerTime = msg.triggerTime
    const attempt = Number.isFinite(msg.attempt) ? Number(msg.attempt) : 1
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid source readiness recheck date ${triggerTime}, skipping.`)
      return
    }

    const summary = await runSourceReadinessProbe(env, Boolean(msg.force), triggerTime, {
      ignoreEveningChainInFlight: true,
    })
    if (summary.trim().toLowerCase().startsWith('running:')) {
      await scheduleSourceReadinessRecheck(env, triggerTime, attempt, summary, msg.runId)
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
