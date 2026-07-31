import type { Bindings, UpdateQueueMsg } from '../types'
import {
  historicalLearningLineageBlockedMessage,
  historicalLearningLineageDecision,
} from './historicalLearningLineageGuard'
import { checkAlerts } from './localMaintenance'
import { crawlAndStoreNews } from './news'
import { computeAndStoreIndicators } from './technicalIndicators'
import { fetchAndStoreStockData } from '../routes/stocks'
import { assertMarketDataReady, loadMarketDataReadinessStats } from './marketDataReadiness'
import { runRegimeCompute } from './controllerDailyWorkflows'
import { readMarketRegimeState } from './marketRegimeState'
import {
  runAllocatorEvFeatureSnapshotBackfill,
  runFinLabV4Backfill,
  runOpbArmPriorRefresh,
} from './controllerResearchWorkflows'
import { runOfficialMarketSummaryRefresh } from './officialMarketSummaryRefresh'
import { enqueuePostScreenerPipelineContinuation } from './postScreenerContinuation'
import {
  claimPipelineStage,
  enqueuePipelineStage,
  markPipelineStage,
} from './pipelineStageLease'
import { classifySchedulerSummary, logSchedulerResult } from './schedulerRunLogger'
import { refreshExpectedReturnServingState } from './expectedReturnServingState'
import {
  resolveEveningChainClosureDurationMs,
  resolveEveningChainRunAuthority,
} from './eveningChainRunAuthority'
import { inspectExpectedReturnLifecycleHealth } from './expectedReturnServingRegistry'
import { fetchPunishedStocks } from './twseApi'
import {
  finLabCanonicalDatasetsForLane,
  finLabContractFlagDefault,
  finLabRequiredFieldsForLane,
  finLabSentinelFieldForLane,
} from './finlabSourceContract'

import { triggerPendingS12FormalEv } from './s12FormalEvTrigger'
const UPDATE_BATCH_SIZE = 40
const UPDATE_SHARD_COUNT = 4
const INDICATOR_BATCH_CONCURRENCY = 4
const NEWS_BATCH_CONCURRENCY = 2
const FINALIZE_RECHECK_DELAY_MS = 30_000
const FINALIZE_RECHECK_MAX_ATTEMPTS = 10
const FINALIZE_ORPHAN_REPAIR_DELAY_MS = 2 * 60_000
const FINALIZE_CONTINUATION_RETRY_DELAY_SECONDS = 2 * 60
const FINALIZE_CONTINUATION_MAX_ATTEMPTS = 45
const SOURCE_READINESS_RETRY_DELAY_SECONDS = 10 * 60
const SOURCE_READINESS_RETRY_MAX_ATTEMPTS = 9
const SOURCE_READINESS_FINLAB_REFRESH_COOLDOWN_SECONDS = 45 * 60
const FINLAB_PENDING_WATCHDOG_STALE_MS = 15 * 60_000
const FINLAB_PENDING_WATCHDOG_MAX_ATTEMPTS = 3
const STRATEGY_LEARNING_QUEUE_CHUNK_SIZE = 80
const S12_REPLAY_QUEUE_CHUNK_SIZE = 20
const S12_CANDIDATE_SNAPSHOT_CHUNK_SIZE = 1
const S12_CANDIDATE_SNAPSHOT_RESEARCH_TIMEOUT_MS = 10_000
const S12_REPLAY_LEASE_RETRY_BASE_DELAY_SECONDS = 60
const S12_REPLAY_LEASE_RETRY_MAX_DELAY_SECONDS = 180
const S12_REPLAY_LEASE_RETRY_MAX_ATTEMPTS = 60

function s12ReplayLeaseRetryDelaySeconds(signalDate: string, attempt: number): number {
  const seed = `${signalDate}:${attempt}`
    .split('')
    .reduce((hash, char) => ((hash * 33) ^ char.charCodeAt(0)) >>> 0, 5381)
  const jitterWindow = S12_REPLAY_LEASE_RETRY_MAX_DELAY_SECONDS - S12_REPLAY_LEASE_RETRY_BASE_DELAY_SECONDS
  return S12_REPLAY_LEASE_RETRY_BASE_DELAY_SECONDS + (seed % (jitterWindow + 1))
}
const FINLAB_CANONICAL_DAILY_CHECKS = [
  {
    key: 'canonical_market_daily:listed_otc',
    table: 'canonical_market_daily',
    minRows: 1000,
  },
  {
    key: 'canonical_chip_daily:listed_otc',
    table: 'canonical_chip_daily',
    minRows: 1000,
  },
  {
    key: 'canonical_institutional_amount_daily:listed_otc',
    table: 'canonical_institutional_amount_daily',
    minRows: 1,
  },
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
  const checks = await finLabCanonicalDailyReadinessChecks(db, targetDate)
  const errors = checks.filter((check) => !check.ok).map((check) => check.summary)
  if (errors.length) {
    throw new Error(`FinLab canonical daily not ready: ${errors.join('; ')}`)
  }
  return `FinLab canonical ready for ${targetDate}: ${checks.map((row) => row.summary).join(' ')}`
}

type ReadinessCheck = {
  key: string
  ok: boolean
  summary: string
}

async function finLabCanonicalDailyReadinessChecks(
  db: D1Database,
  targetDate: string,
): Promise<ReadinessCheck[]> {
  const stats = await Promise.all(
    FINLAB_CANONICAL_DAILY_CHECKS.map((check) => finLabCanonicalTableStats(db, check.table, targetDate)),
  )
  const checks: ReadinessCheck[] = []
  for (const stat of stats) {
    const check = FINLAB_CANONICAL_DAILY_CHECKS.find((item) => item.table === stat.table)!
    const parts: string[] = []
    if (!stat.latestDate || stat.latestDate < targetDate) {
      parts.push(`${stat.table} latest=${stat.latestDate ?? 'none'} before expected=${targetDate}`)
    }
    if (stat.rowsOnTarget < check.minRows) {
      parts.push(`${stat.table} target_rows=${stat.rowsOnTarget}/${check.minRows} date=${targetDate}`)
    }
    if (parts.length) {
      checks.push({
        key: check.key,
        ok: false,
        summary: parts.join('; '),
      })
    } else {
      checks.push({
        key: check.key,
        ok: true,
        summary: `${stat.table}=${stat.rowsOnTarget}`,
      })
    }
  }
  return checks
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
  error?: string
  timestamp?: string
  run_id?: string
}

function schedulerSummaryField(entry: SchedulerRunSnapshot | null, field: string): string | null {
  const match = String(entry?.summary ?? '').match(new RegExp(`(?:^|\\s)${field}=([^\\s;]+)`))
  return match?.[1] ?? null
}

function isFinLabQuotaLimitLog(entry: SchedulerRunSnapshot | null): boolean {
  const text = `${entry?.summary ?? ''} ${entry?.error ?? ''}`
  return /Usage exceed|quota|VIP program|5000\s*MB\/day/i.test(text)
}

async function readSchedulerRunLogKey(
  env: Bindings,
  key: string,
): Promise<SchedulerRunSnapshot | null> {
  try {
    return await env.KV.get(key, 'json') as SchedulerRunSnapshot | null
  } catch (error) {
    const raw = await env.KV.get(key).catch(() => null)
    console.warn(`[updateOrchestrator] malformed scheduler run log ignored key=${key}:`, error)
    return raw
      ? {
          status: 'error',
          summary: `malformed scheduler run log ignored: ${raw.slice(0, 160)}`,
        }
      : null
  }
}

async function readSchedulerRunLog(
  env: Bindings,
  task: string,
  runDate: string,
): Promise<SchedulerRunSnapshot | null> {
  return (
    await readSchedulerRunLogKey(env, `scheduler:run:${task}:${runDate}`)
  ) ?? (
    await readSchedulerRunLogKey(env, `cron:log:${task}:${runDate}`)
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

function taipeiDateFromIso(value: string | null | undefined): string | null {
  const ms = Date.parse(String(value ?? ''))
  if (!Number.isFinite(ms)) return null
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)
}

async function tradingRestrictionsDailyReadinessCheck(
  env: Bindings,
  targetDate: string,
): Promise<ReadinessCheck> {
  const key = 'canonical_trading_restrictions:daily_micro_lane'
  try {
    const [quality, canonical, checkedAt, officialRefresh] = await Promise.all([
      env.DB.prepare(`
        SELECT freshness_status, missing_rate, latest_materialization, metrics_json
          FROM source_quality_metrics
         WHERE source = 'finlab'
           AND dataset = 'trading_restrictions'
           AND as_of_date = ?
         ORDER BY latest_materialization DESC
         LIMIT 1
      `).bind(targetDate).first<{
        freshness_status: string | null
        missing_rate: number | null
        latest_materialization: string | null
        metrics_json: string | null
      }>(),
      env.DB.prepare(`
        SELECT COUNT(*) AS count,
               MAX(source_date) AS latest_source_date,
               MAX(updated_at) AS latest_materialization
          FROM canonical_trading_restrictions
         WHERE source = 'finlab.trading_attention'
           AND source_date <= ?
           AND (end_date IS NULL OR end_date >= ?)
      `).bind(targetDate, targetDate).first<{
        count: number | null
        latest_source_date: string | null
        latest_materialization: string | null
      }>(),
      env.KV.get('market:trading_restrictions:checked_at'),
      env.KV.get('market:trading_restrictions:refresh_status', 'json') as Promise<{
        status?: string
        trade_date?: string
        checked_at?: string
        source_counts?: Record<string, number>
      } | null>,
    ])
    const freshness = String(quality?.freshness_status ?? '').trim().toLowerCase()
    const finlabFresh = Boolean(quality) && !/empty|missing|failed|stale|disabled|error/i.test(freshness)
    if (finlabFresh) {
      return {
        key,
        ok: true,
        summary: `${key} finlab=${quality?.freshness_status ?? 'ok'} materialized=${quality?.latest_materialization ?? 'n/a'}`,
      }
    }
    const checkedDate = taipeiDateFromIso(checkedAt)
    const refreshComplete = officialRefresh?.status === 'success'
      && officialRefresh.trade_date === targetDate
      && checkedDate === targetDate
    if (refreshComplete) {
      return {
        key,
        ok: true,
        summary: `${key} official_complete checked_at=${checkedAt} sources=${JSON.stringify(officialRefresh?.source_counts ?? {})}`,
      }
    }

    const canonicalRows = Number(canonical?.count ?? 0)
    return {
      key,
      ok: false,
      summary: `${key} waiting: finlab=${quality?.freshness_status ?? 'missing'} official=${officialRefresh?.status ?? 'missing'} checked_at=${checkedAt ?? 'missing'} canonical_active_rows=${canonicalRows} canonical_latest_source_date=${canonical?.latest_source_date ?? 'missing'} canonical_materialized=${canonical?.latest_materialization ?? 'missing'}`,
    }
  } catch (e) {
    return {
      key,
      ok: false,
      summary: `${key} query failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

async function ensureTradingRestrictionsDailyReadiness(
  env: Bindings,
  targetDate: string,
): Promise<ReadinessCheck> {
  let readiness = await tradingRestrictionsDailyReadinessCheck(env, targetDate)
  if (readiness.ok || isHistoricalReplayDate(targetDate)) return readiness
  const { refreshOfficialTradingRestrictions } = await import('./tradingRestrictions')
  await refreshOfficialTradingRestrictions(env, targetDate)
  readiness = await tradingRestrictionsDailyReadinessCheck(env, targetDate)
  if (!readiness.ok) {
    throw new Error(`official trading restrictions refresh did not satisfy readiness: ${readiness.summary}`)
  }
  return readiness
}

async function checkEveningChainSourceReadiness(
  env: Bindings,
  targetDate: string,
): Promise<SourceReadinessSnapshot> {
  const checks: ReadinessCheck[] = []

  checks.push(...await finLabCanonicalDailyReadinessChecks(env.DB, targetDate))
  checks.push(await tradingRestrictionsDailyReadinessCheck(env, targetDate))

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
    countReadinessRows(
      env.DB,
      'canonical_fundamental_features:valuation_daily_union',
      "SELECT COUNT(*) AS count FROM canonical_fundamental_features WHERE available_date = ? AND as_of_date <= ? AND source = 'finlab.daily_valuation' AND (pe IS NOT NULL OR pb IS NOT NULL)",
      [targetDate, targetDate],
      1500,
    ),
    countReadinessRows(
      env.DB,
      'canonical_fundamental_features:valuation_daily_pe',
      "SELECT COUNT(*) AS count FROM canonical_fundamental_features WHERE available_date = ? AND as_of_date <= ? AND source = 'finlab.daily_valuation' AND pe IS NOT NULL",
      [targetDate, targetDate],
      1000,
    ),
    countReadinessRows(
      env.DB,
      'canonical_fundamental_features:valuation_daily_pb',
      "SELECT COUNT(*) AS count FROM canonical_fundamental_features WHERE available_date = ? AND as_of_date <= ? AND source = 'finlab.daily_valuation' AND pb IS NOT NULL",
      [targetDate, targetDate],
      1500,
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

type FinLabKeyScopeEntry = {
  lane: string
  fields: string[]
}

type FinLabRefreshScope = {
  lanes?: string
  canonicalDatasets?: string
  keyScope?: FinLabKeyScopeEntry[]
  keyScopeJson?: string
}

type FinLabRetryScope = FinLabRefreshScope & {
  requestedLanes: string[]
  skippedFetchedLanes: string[]
  keyScopeJson?: string
  retryKeyCount: number
  skippedReadyKeyCount: number
  sentinelKeyCount: number
  quotaBlockedKeyCount: number
  sourceNotReadyLanes: string[]
  partialFailedLanes: string[]
  fullyReadyLanes: string[]
  blockedDatasets: string[]
  materializedDatasets: string[]
}

type SourceKeyReportRow = {
  lane: string | null
  field: string | null
  api_key: string | null
  required: number | null
  status: string | null
  rows: number | null
  target_rows: number | null
  latest_date: string | null
}

function envFlag(env: Bindings, name: string, fallback: boolean): boolean {
  const raw = String((env as Record<string, unknown>)[name] ?? '').trim().toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false
  return fallback
}

function finLabKeyReportEnabled(env: Bindings): boolean {
  return envFlag(env, 'FINLAB_KEY_REPORT_ENABLED', finLabContractFlagDefault('FINLAB_KEY_REPORT_ENABLED'))
}

function finLabKeyLevelRetryEnabled(env: Bindings): boolean {
  return envFlag(env, 'FINLAB_KEY_LEVEL_RETRY_ENABLED', finLabContractFlagDefault('FINLAB_KEY_LEVEL_RETRY_ENABLED'))
}

function finLabArtifactReuseEnabled(env: Bindings): boolean {
  return envFlag(env, 'FINLAB_ARTIFACT_REUSE_ENABLED', finLabContractFlagDefault('FINLAB_ARTIFACT_REUSE_ENABLED'))
}

function emptyFinLabRetryScope(sourceScope: FinLabRefreshScope, requestedLanes: string[]): FinLabRetryScope {
  return {
    ...sourceScope,
    requestedLanes,
    skippedFetchedLanes: [],
    retryKeyCount: 0,
    skippedReadyKeyCount: 0,
    sentinelKeyCount: 0,
    quotaBlockedKeyCount: 0,
    sourceNotReadyLanes: [],
    partialFailedLanes: [],
    fullyReadyLanes: [],
    blockedDatasets: [],
    materializedDatasets: [],
  }
}

function csvList(value: string | undefined): string[] {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function csvJoin(values: Iterable<string>): string | undefined {
  const list = Array.from(new Set(Array.from(values).map((item) => item.trim()).filter(Boolean)))
  return list.length ? list.join(',') : undefined
}

function canonicalDatasetsForLanes(lanes: string[]): string | undefined {
  const datasets = new Set<string>()
  for (const lane of lanes) {
    for (const dataset of finLabCanonicalDatasetsForLane(lane)) {
      datasets.add(dataset)
    }
  }
  return csvJoin(datasets)
}

function keyScopeJsonForLanes(sourceScope: FinLabRefreshScope, lanes: string[]): string | undefined {
  const allow = new Set(lanes)
  const entries = (sourceScope.keyScope ?? [])
    .filter((entry) => allow.has(entry.lane))
    .map((entry) => ({ lane: entry.lane, fields: entry.fields }))
  return entries.some((entry) => entry.fields.length > 0) ? JSON.stringify(entries) : undefined
}

function finLabRefreshScopeForReadiness(readiness: SourceReadinessSnapshot): FinLabRefreshScope {
  const lanes = new Set<string>()
  const datasets = new Set<string>()
  const keyScope = new Map<string, string[]>()

  const addLane = (lane: string, canonicalDatasets: string[], fields: string[] = []) => {
    lanes.add(lane)
    for (const dataset of canonicalDatasets) datasets.add(dataset)
    if (fields.length || !keyScope.has(lane)) keyScope.set(lane, fields)
  }

  for (const key of readiness.missingKeys) {
    if (!isFinLabRefreshableMissingKey(key)) continue
    if (key === 'finlab_primary_canonical') {
      addLane('daily_price', ['canonical_market_daily'])
      addLane('chip_diversity', ['canonical_chip_daily'])
      addLane('institutional_amount_summary', ['canonical_institutional_amount_daily'])
      continue
    }
    if (key.startsWith('canonical_market_daily:')) {
      addLane('daily_price', ['canonical_market_daily'])
      continue
    }
    if (key.startsWith('canonical_chip_daily:')) {
      addLane('chip_diversity', ['canonical_chip_daily'])
      continue
    }
    if (key.startsWith('canonical_institutional_amount_daily:')) {
      addLane('institutional_amount_summary', ['canonical_institutional_amount_daily'])
      continue
    }
    if (key.startsWith('canonical_market_index_daily:')) {
      addLane('regime_context', ['canonical_market_index_daily'])
      continue
    }
    if (key.startsWith('canonical_futures_daily:')) {
      addLane('regime_context', ['canonical_futures_daily'])
      continue
    }
    if (key.startsWith('canonical_regime_context_daily:')) {
      addLane('regime_context', ['canonical_regime_context_daily'])
      continue
    }
    if (key.startsWith('canonical_broker_flow_daily:') || key.startsWith('canonical_broker_rank_daily:')) {
      addLane('broker_flow_diversity', ['canonical_broker_flow_daily', 'canonical_broker_rank_daily'])
      continue
    }
    if (key.startsWith('canonical_fundamental_features:valuation_daily')) {
      addLane('fundamental_factor_diversity', ['canonical_fundamental_features'], ['pe', 'pb'])
      continue
    }
    if (key.startsWith('canonical_trading_restrictions:')) {
      addLane('trading_restrictions', ['canonical_trading_restrictions'])
    }
  }
  const keyScopeEntries = Array.from(lanes)
    .map((lane) => ({ lane, fields: keyScope.get(lane) ?? [] }))
  const keyScopeJson = keyScopeEntries.some((entry) => entry.fields.length > 0)
    ? JSON.stringify(keyScopeEntries)
    : undefined

  return {
    lanes: csvJoin(lanes),
    canonicalDatasets: csvJoin(datasets),
    keyScope: keyScopeEntries,
    keyScopeJson,
  }
}

async function fetchedFinLabSourceLanesForTarget(db: D1Database, targetDate: string): Promise<Set<string>> {
  const runPattern = `finlab-v4-daily-${targetDate.replace(/-/g, '')}-%`
  const rows = await db.prepare(`
    SELECT dataset_lane, MAX(finlab_rows) AS finlab_rows
      FROM source_diff_report
     WHERE source = 'finlab'
       AND run_id LIKE ?
     GROUP BY dataset_lane
  `).bind(runPattern).all<{ dataset_lane: string | null; finlab_rows: number | null }>()
  const lanes = new Set<string>()
  for (const row of rows.results ?? []) {
    const lane = String(row.dataset_lane ?? '').trim()
    if (lane && Number(row.finlab_rows ?? 0) > 0) lanes.add(lane)
  }
  return lanes
}

async function readFinLabSourceKeyReportForTarget(
  db: D1Database,
  targetDate: string,
  lanes: string[],
): Promise<SourceKeyReportRow[]> {
  const requestedLanes = Array.from(new Set(lanes.map((lane) => lane.trim()).filter(Boolean)))
  if (!requestedLanes.length) return []
  const placeholders = requestedLanes.map(() => '?').join(',')
  try {
    const rows = await db.prepare(`
      SELECT lane, field, api_key, required, status, rows, target_rows, latest_date
        FROM source_key_report
       WHERE target_date = ?
         AND lane IN (${placeholders})
    `).bind(targetDate, ...requestedLanes).all<SourceKeyReportRow>()
    return rows.results ?? []
  } catch (error) {
    console.warn('[FinLab] source_key_report unavailable; falling back to lane-level retry scope:', error)
    return []
  }
}

function finLabSourceKeyReady(row: SourceKeyReportRow): boolean {
  const status = String(row.status ?? '').toLowerCase()
  if (status !== 'ok' && status !== 'skipped_reused') return false
  return Number(row.target_rows ?? row.rows ?? 0) > 0
}

function finLabSourceKeyLooksSourceNotReady(row: SourceKeyReportRow): boolean {
  const status = String(row.status ?? '').toLowerCase()
  return status === 'empty' || status === 'missing_target_date' || status === 'source_not_ready'
}

function finLabSourceKeyQuotaBlocked(row: SourceKeyReportRow): boolean {
  return String(row.status ?? '').toLowerCase() === 'quota_blocked'
}

async function finLabRetryScopeForReadiness(
  env: Bindings,
  targetDate: string,
  readiness: SourceReadinessSnapshot,
  options: { allowFetchedLaneRefetch?: boolean } = {},
): Promise<FinLabRetryScope> {
  const sourceScope = finLabRefreshScopeForReadiness(readiness)
  const requestedLanes = csvList(sourceScope.lanes)
  if (!requestedLanes.length) {
    return emptyFinLabRetryScope(sourceScope, requestedLanes)
  }

  const laneLevelRetryScope = async (): Promise<FinLabRetryScope> => {
    const fetchedLanes = await fetchedFinLabSourceLanesForTarget(env.DB, targetDate)
    const retryLanes = options.allowFetchedLaneRefetch
      ? requestedLanes
      : requestedLanes.filter((lane) => !fetchedLanes.has(lane))
    const skippedFetchedLanes = options.allowFetchedLaneRefetch
      ? []
      : requestedLanes.filter((lane) => fetchedLanes.has(lane))
    return {
      ...emptyFinLabRetryScope({
        lanes: csvJoin(retryLanes),
        canonicalDatasets: canonicalDatasetsForLanes(retryLanes),
        keyScope: sourceScope.keyScope?.filter((entry) => retryLanes.includes(entry.lane)),
        keyScopeJson: keyScopeJsonForLanes(sourceScope, retryLanes),
      }, requestedLanes),
      skippedFetchedLanes,
    }
  }

  if (!finLabKeyReportEnabled(env) || !finLabKeyLevelRetryEnabled(env)) {
    return laneLevelRetryScope()
  }

  const keyRows = await readFinLabSourceKeyReportForTarget(env.DB, targetDate, requestedLanes)
  if (keyRows.length) {
    const rowsByLane = new Map<string, SourceKeyReportRow[]>()
    for (const row of keyRows) {
      const lane = String(row.lane ?? '').trim()
      if (!lane) continue
      rowsByLane.set(lane, [...(rowsByLane.get(lane) ?? []), row])
    }

    const retryLanes: string[] = []
    const skippedFetchedLanes: string[] = []
    const keyScope: Array<{ lane: string; fields: string[] }> = []
    const sourceNotReadyLanes: string[] = []
    const partialFailedLanes: string[] = []
    const fullyReadyLanes: string[] = []
    const blockedDatasets = new Set<string>()
    const materializedDatasets = new Set<string>()
    let retryKeyCount = 0
    let skippedReadyKeyCount = 0
    let sentinelKeyCount = 0
    let quotaBlockedKeyCount = 0

    for (const lane of requestedLanes) {
      const laneRows = rowsByLane.get(lane) ?? []
      const contractRequiredFields = finLabRequiredFieldsForLane(lane)
      if (!laneRows.length) {
        retryLanes.push(lane)
        keyScope.push({ lane, fields: contractRequiredFields })
        retryKeyCount += contractRequiredFields.length
        partialFailedLanes.push(lane)
        for (const dataset of finLabCanonicalDatasetsForLane(lane)) blockedDatasets.add(dataset)
        continue
      }

      const rowsByField = new Map<string, SourceKeyReportRow>()
      for (const row of laneRows) {
        const field = String(row.field ?? '').trim()
        if (field && !rowsByField.has(field)) rowsByField.set(field, row)
      }
      const requiredRows = contractRequiredFields.length
        ? contractRequiredFields.map((field) => rowsByField.get(field)).filter(Boolean) as SourceKeyReportRow[]
        : laneRows.filter((row) => Number(row.required ?? 0) !== 0)
      const scopedRows = requiredRows.length ? requiredRows : laneRows
      const readyRows = scopedRows.filter(finLabSourceKeyReady)
      const missingRequiredFields = contractRequiredFields.filter((field) => !rowsByField.has(field))
      const retryRows = scopedRows.filter((row) => !finLabSourceKeyReady(row))
      skippedReadyKeyCount += readyRows.length
      quotaBlockedKeyCount += retryRows.filter(finLabSourceKeyQuotaBlocked).length

      if (!retryRows.length && !missingRequiredFields.length) {
        const readyFields = Array.from(new Set(
          scopedRows.map((row) => String(row.field ?? '').trim()).filter(Boolean),
        ))
        fullyReadyLanes.push(lane)
        for (const dataset of finLabCanonicalDatasetsForLane(lane)) materializedDatasets.add(dataset)
        if (finLabArtifactReuseEnabled(env)) {
          retryLanes.push(lane)
          keyScope.push({ lane, fields: readyFields })
        }
        continue
      }

      const hasReadyRows = readyRows.length > 0
      const retryableRows = retryRows.filter((row) => !finLabSourceKeyQuotaBlocked(row))
      const entireLaneLooksUnavailable = !hasReadyRows && !missingRequiredFields.length && retryableRows.length > 0 && retryableRows.every(finLabSourceKeyLooksSourceNotReady)
      const fields = entireLaneLooksUnavailable
        ? [finLabSentinelFieldForLane(lane) ?? '']
        : [
            ...retryableRows.map((row) => String(row.field ?? '').trim()).filter(Boolean),
            ...missingRequiredFields,
          ]
      const uniqueFields = Array.from(new Set(fields.filter(Boolean)))

      if (uniqueFields.length) {
        retryLanes.push(lane)
        keyScope.push({ lane, fields: uniqueFields })
        retryKeyCount += uniqueFields.length
        partialFailedLanes.push(lane)
        for (const dataset of finLabCanonicalDatasetsForLane(lane)) blockedDatasets.add(dataset)
      } else if (retryRows.some(finLabSourceKeyQuotaBlocked)) {
        partialFailedLanes.push(lane)
        for (const dataset of finLabCanonicalDatasetsForLane(lane)) blockedDatasets.add(dataset)
      }
      if (entireLaneLooksUnavailable) {
        sourceNotReadyLanes.push(lane)
        sentinelKeyCount += uniqueFields.length
      }
    }

    return {
      lanes: csvJoin(retryLanes),
      canonicalDatasets: canonicalDatasetsForLanes(retryLanes),
      requestedLanes,
      skippedFetchedLanes,
      keyScopeJson: retryLanes.length ? JSON.stringify(keyScope) : undefined,
      retryKeyCount,
      skippedReadyKeyCount,
      sentinelKeyCount,
      quotaBlockedKeyCount,
      sourceNotReadyLanes,
      partialFailedLanes,
      fullyReadyLanes,
      blockedDatasets: Array.from(blockedDatasets),
      materializedDatasets: Array.from(materializedDatasets),
    }
  }

  return laneLevelRetryScope()
}

function finLabRetryScopeSuffix(scope: FinLabRetryScope): string {
  const parts: string[] = []
  if (scope.lanes) parts.push(`retry_lanes=${scope.lanes}`)
  if (scope.retryKeyCount) parts.push(`retry_keys=${scope.retryKeyCount}`)
  if (scope.skippedReadyKeyCount) parts.push(`skipped_ok_keys=${scope.skippedReadyKeyCount}`)
  if (scope.sentinelKeyCount) parts.push(`sentinel_keys=${scope.sentinelKeyCount}`)
  if (scope.quotaBlockedKeyCount) parts.push(`quota_blocked_keys=${scope.quotaBlockedKeyCount}`)
  if (scope.skippedFetchedLanes.length) {
    parts.push(`skipped_fetched_lanes=${scope.skippedFetchedLanes.join(',')}`)
  }
  if (scope.sourceNotReadyLanes.length) {
    parts.push(`source_not_ready_lanes=${scope.sourceNotReadyLanes.join(',')}`)
  }
  if (scope.materializedDatasets.length) parts.push(`materialized_datasets=${scope.materializedDatasets.join(',')}`)
  if (scope.blockedDatasets.length) parts.push(`blocked_datasets=${scope.blockedDatasets.join(',')}`)
  return parts.length ? `; ${parts.join('; ')}` : ''
}

function finLabRetryScopeDetails(scope: FinLabRetryScope): string[] {
  const details: string[] = []
  if (scope.retryKeyCount) details.push(`retry_keys=${scope.retryKeyCount}`)
  if (scope.skippedReadyKeyCount) details.push(`skipped_ok_keys=${scope.skippedReadyKeyCount}`)
  if (scope.sentinelKeyCount) details.push(`sentinel_keys=${scope.sentinelKeyCount}`)
  if (scope.quotaBlockedKeyCount) details.push(`quota_blocked_keys=${scope.quotaBlockedKeyCount}`)
  if (scope.materializedDatasets.length) details.push(`materialized_datasets=${scope.materializedDatasets.join(',')}`)
  if (scope.blockedDatasets.length) details.push(`blocked_datasets=${scope.blockedDatasets.join(',')}`)
  return details
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
): Promise<{ rows: number; sampleSize: number; advanceCount: number; declineCount: number; unchangedCount: number; limitDownCount: number }> {
  const breadth = await db.prepare(`
    WITH current_prices AS (
      SELECT c.stock_id, c.date, c.open, c.close
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
      SELECT cur.open AS open, cur.close AS close, prev.close AS prev_close
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
      SUM(CASE WHEN close = prev_close THEN 1 ELSE 0 END) AS unchanged_count,
      SUM(CASE WHEN open > 0 AND close >= open * 0.9 AND close <= open * 0.905 THEN 1 ELSE 0 END) AS limit_down_count
    FROM paired
  `).bind(targetDate).first<{
    sample_size: number | null
    advance_count: number | null
    decline_count: number | null
    unchanged_count: number | null
    limit_down_count: number | null
  }>()

  const sampleSize = Number(breadth?.sample_size ?? 0)
  const advanceCount = Number(breadth?.advance_count ?? 0)
  const declineCount = Number(breadth?.decline_count ?? 0)
  const unchangedCount = Number(breadth?.unchanged_count ?? 0)
  const limitDownCount = Number(breadth?.limit_down_count ?? 0)
  if (sampleSize < 1000) {
    return { rows: 0, sampleSize, advanceCount, declineCount, unchangedCount, limitDownCount }
  }
  const ratio = sampleSize > 0 ? advanceCount / sampleSize : null
  const result = await db.prepare(`
    INSERT INTO market_breadth (
      date, advance_count, decline_count, unchanged_count, advance_ratio, sample_size, limit_down_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      advance_count=excluded.advance_count,
      decline_count=excluded.decline_count,
      unchanged_count=excluded.unchanged_count,
      advance_ratio=excluded.advance_ratio,
      sample_size=excluded.sample_size,
      limit_down_count=excluded.limit_down_count
  `).bind(targetDate, advanceCount, declineCount, unchangedCount, ratio, sampleSize, limitDownCount).run()
  return {
    rows: d1ChangeCount(result),
    sampleSize,
    advanceCount,
    declineCount,
    unchangedCount,
    limitDownCount,
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
        AND f.as_of_date <= ?
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
  `).bind(targetDate, targetDate, targetDate).run()

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
        AND f.as_of_date <= ?
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
  `).bind(targetDate, targetDate, currentQuarter).run()

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

async function ensureSameDateRegimeReady(
  env: Bindings,
  triggerTime: string,
  runId: string | undefined,
  source: string,
): Promise<string> {
  const current = await readMarketRegimeState(env.KV)
  if (current?.source === 'hmm' && current.run_date === triggerTime) {
    return `regime=${current.label} idx=${current.regime_index} kv=verified source=existing`
  }

  await logSchedulerResult(env.KV, 'regime-compute', {
    status: 'running',
    summary: `pre-screener regime-compute started for ${triggerTime}; run_id=${runId ?? 'n/a'}; source=${source}`,
    duration_ms: 0,
    run_date: triggerTime,
  })
  const startedAt = Date.now()
  try {
    const summary = String(await runRegimeCompute(env, triggerTime))
    await logSchedulerResult(env.KV, 'regime-compute', {
      status: 'success',
      summary: `pre-screener ${summary}; source=${source}`,
      duration_ms: Date.now() - startedAt,
      run_date: triggerTime,
    })
    return summary
  } catch (error) {
    await logSchedulerResult(env.KV, 'regime-compute', {
      status: 'error',
      summary: `pre-screener regime-compute failed for ${triggerTime}; source=${source}`,
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      run_date: triggerTime,
    })
    throw error
  }
}
async function finalizeUpdateChain(
  env: Bindings,
  deps: ProcessUpdateBatchDeps,
  triggerTime: string,
  runId: string,
  shardCount: number,
  continuationAttempt = 1,
): Promise<void> {
  const readiness = await checkEveningChainSourceReadiness(env, triggerTime)
  if (!readiness.ok) {
    await deferFinalizeContinuation(env, triggerTime, runId, shardCount, continuationAttempt, `canonical source not ready: ${readiness.summary}`)
    return
  }

  const finalKey = `cron:indicator-queue:${triggerTime}:${runId}:finalized`
  try {
    const acquired = await acquireFinalizeLock(env, triggerTime, runId)
    if (!acquired) {
      console.log(`[Queue] Finalize already acquired for ${triggerTime} ${runId}`)
      const repaired = await repairFinalizeContinuationIfNeeded(env, deps, triggerTime, runId, shardCount)
      if (!repaired) {
        await deferFinalizeContinuation(env, triggerTime, runId, shardCount, continuationAttempt, 'finalizer lease is still owned by the original continuation')
      }
      return
    }
    await env.KV.put(finalKey, '1', { expirationTtl: 7 * 86400 })
    await runFinalizeContinuation(env, deps, triggerTime, runId, shardCount, 'lock-acquired')
  } catch (error) {
    await deferFinalizeContinuation(env, triggerTime, runId, shardCount, continuationAttempt, error instanceof Error ? error.message : String(error))
  }
}

async function deferFinalizeContinuation(
  env: Bindings,
  triggerTime: string,
  runId: string,
  shardCount: number,
  continuationAttempt: number,
  reason: string,
): Promise<void> {
  if (continuationAttempt >= FINALIZE_CONTINUATION_MAX_ATTEMPTS) {
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'error',
      summary: `indicator finalizer continuation exhausted for ${triggerTime}; run_id=${runId}`,
      duration_ms: 0, error: reason, run_id: runId, run_date: triggerTime,
    })
    throw new Error(`indicator finalizer continuation exhausted: ${reason}`)
  }
  await logSchedulerResult(env.KV, 'evening-chain', {
    status: 'running',
    summary: `indicator finalizer deferred for ${triggerTime}; run_id=${runId}; continuation_attempt=${continuationAttempt}; reason=${reason}`,
    duration_ms: 0, run_id: runId, run_date: triggerTime,
  })
  await env.UPDATE_QUEUE.send({
    type: 'finalize_update', cursor: 0, triggerTime, runId, shardCount, attempt: 1,
    continuationAttempt: continuationAttempt + 1,
  }, { delaySeconds: FINALIZE_CONTINUATION_RETRY_DELAY_SECONDS } as any)
}

export async function refreshMatureStrategyEvidenceBeforeScreener(
  env: Bindings,
  asOfDate: string,
  runId: string,
): Promise<string> {
  const startedAt = Date.now()
  try {
    const { recoverMatureSelectionEvidence } = await import('./matureSelectionEvidenceRecovery')
    const { materializeCanonicalSelectionLabelsV4 } = await import('./canonicalSelectionLabels')
    const { refreshStrategyMarginalEdgeV4 } = await import('./strategyMarginalEdgeV4')
    const { refreshStrategyRewardLedger } = await import('./strategyLearning')
    const recovery = await recoverMatureSelectionEvidence(env, asOfDate, {
      maxRecoveryDates: 4,
    })
    const labels = await materializeCanonicalSelectionLabelsV4(env.DB, { asOfDate })
    const marginalEdge = await refreshStrategyMarginalEdgeV4(env.DB, asOfDate)
    const rewards = await refreshStrategyRewardLedger(env.DB, { endDate: asOfDate, dryRun: false })
    const summary = [
      `mature_recovery=${recovery.summary}`,
      `labels=${labels.persisted_rows}`,
      `pending=${labels.pending_rows}`,
      `unavailable=${labels.unavailable_rows}`,
      `edge=${marginalEdge.status}:eligible=${marginalEdge.eligibleStrategies}:dates=${marginalEdge.sampleDates}`,
      `reward_source=${rewards.source_rows}`,
      `reward_rows=${rewards.persisted_rows}`,
    ].join(' ')
    await logSchedulerResult(env.KV, 'strategy-learning-mature-evidence', {
      status: 'success',
      summary,
      duration_ms: Date.now() - startedAt,
      run_id: runId,
      run_date: asOfDate,
    }, env)
    return summary
  } catch (error) {
    await logSchedulerResult(env.KV, 'strategy-learning-mature-evidence', {
      status: 'error',
      summary: `mature evidence refresh failed before screener for ${asOfDate}`,
      duration_ms: Date.now() - startedAt,
      run_id: runId,
      run_date: asOfDate,
      error: String(error),
    }, env)
    throw error
  }
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
  const matureStrategyEvidence = await refreshMatureStrategyEvidenceBeforeScreener(env, triggerTime, runId)
  console.log(`[Queue] Mature strategy evidence refreshed before screener: ${matureStrategyEvidence}`)
  const regimeSummary = await ensureSameDateRegimeReady(env, triggerTime, runId, 'indicator-finalizer')
  console.log(`[Queue] Same-date regime ready before screener: ${regimeSummary}`)

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
): Promise<boolean> {
  const lock = await loadFinalizeLock(env, triggerTime, runId)
  if (!finalizeLockIsRepairable(lock)) {
    console.log(`[Queue] Finalize lock is recent; waiting for original finalizer ${triggerTime} ${runId}`)
    return false
  }

  if (await hasPipelineEvidence(env, triggerTime)) {
    console.log(`[Queue] Finalize continuation already reached pipeline for ${triggerTime} ${runId}`)
    return true
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
    return true
  }

  await logSchedulerResult(env.KV, 'evening-chain', {
    status: 'running',
    summary: `event-driven chain repairing stale finalizer lock before screener for ${triggerTime}; run_id=${runId}`,
    duration_ms: 0,
    run_date: triggerTime,
  })
  await runFinalizeContinuation(env, deps, triggerTime, runId, shardCount, 'stale-lock-repair')
  return true
}

async function runDailyAllocatorEvReadiness(
  env: Bindings,
  triggerTime: string,
): Promise<{ ok: boolean; summary: string }> {
  const started = Date.now()
  const parts: string[] = []
  const health = await inspectExpectedReturnLifecycleHealth(env, triggerTime)
  const servingState = await refreshExpectedReturnServingState(env, triggerTime)
  const priorOwner = servingState.expected_return_owner
  parts.push(`expected_return_serving_state=${servingState.state}`)
  parts.push(`expected_return_action_gate=${servingState.action_gate}`)
  parts.push(`required_oof_max_date=${health.expected_mature_signal_date ?? 'unresolved'}`)
  parts.push(`newly_mature_signal_date=${health.newly_mature_signal_date ?? 'unresolved'}`)
  parts.push(`oof_snapshot_max=${health.oof_max_dates.allocator_ev_snapshots ?? 'missing'}`)
  parts.push(`oof_l4_max=${health.oof_max_dates.l4_predictions ?? 'missing'}`)

  for (const owner of ['l4_alpha_ev', 'allocator_ev_fusion'] as const) {
    const artifactState = servingState.artifacts[owner]
    const candidate = health.latest_candidates[owner]
    const task = owner === 'l4_alpha_ev' ? 'l4-alpha-ev-refresh' : 'allocator-ev-fusion-refresh'
    const candidateDecision = String(candidate?.offline_gate_decision ?? 'missing')
    const candidateVersion = String(candidate?.version ?? 'missing')
    const ownerAlerts = [...health.alerts, ...servingState.hard_alerts]
      .filter((alert) => alert.startsWith(`${owner}:`))
    parts.push(`${owner}_serving=${artifactState.artifact_state}:${artifactState.model_version ?? 'none'}`)
    parts.push(`${owner}_latest_candidate=${candidateVersion}:${candidateDecision}`)
    await logSchedulerResult(env.KV, task, {
      status: ownerAlerts.length > 0 ? 'error' : artifactState.eligible ? 'success' : 'skipped',
      summary: [
        `canonical OOF owner inspection for ${triggerTime}`,
        `serving=${artifactState.artifact_state}`,
        `version=${artifactState.model_version ?? 'none'}`,
        `candidate=${candidateVersion}`,
        `candidate_gate=${candidateDecision}`,
        ownerAlerts.length > 0 ? `alerts=${ownerAlerts.join(',')}` : '',
      ].filter(Boolean).join(' '),
      duration_ms: Date.now() - started,
      run_date: triggerTime,
    })
  }
  if (priorOwner) {
    const opbStarted = Date.now()
    try {
      const opbSummary = await runOpbArmPriorRefresh(env, triggerTime, priorOwner)
      parts.push(`opb_prior=${opbSummary}`)
      await logSchedulerResult(env.KV, 'opb-arm-prior-refresh', {
        status: 'success',
        summary: `daily-chain ${opbSummary}`,
        duration_ms: Date.now() - opbStarted,
        run_date: triggerTime,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      parts.push(`opb_prior_not_ready=${message}`)
      await logSchedulerResult(env.KV, 'opb-arm-prior-refresh', {
        status: 'skipped',
        summary: `daily-chain OPB prior retained; challenger not ready owner=${priorOwner}`,
        duration_ms: Date.now() - opbStarted,
        error: message,
        run_date: triggerTime,
      })
    }
  } else {
    parts.push('opb_prior_not_ready=no_production_expected_return_owner')
    await logSchedulerResult(env.KV, 'opb-arm-prior-refresh', {
      status: 'skipped',
      summary: 'daily-chain OPB prior retained; no production L4/Fusion expected-return owner',
      duration_ms: 0,
      run_date: triggerTime,
    })
  }

  const hardAlerts = [...new Set([...health.alerts, ...servingState.hard_alerts])]
  const warnings = [...new Set([...health.warnings, ...servingState.warnings])]
  if (hardAlerts.length > 0) parts.push(`hard_alerts=${hardAlerts.join(',')}`)
  if (warnings.length > 0) parts.push(`warnings=${warnings.join(',')}`)
  const summary = `allocator EV model readiness before pipeline for ${triggerTime}; ${parts.join(' | ')}`
  await logSchedulerResult(env.KV, 'allocator-ev-readiness', {
    status: hardAlerts.length > 0 ? 'error' : 'success',
    summary,
    duration_ms: Date.now() - started,
    error: hardAlerts.length > 0 ? hardAlerts.join(',') : undefined,
    run_date: triggerTime,
  })
  return { ok: true, summary }
}

async function continuePostScreenerPipeline(
  env: Bindings,
  deps: ProcessUpdateBatchDeps,
  triggerTime: string,
  runId?: string,
  snapshotsReady = false,
): Promise<void> {
  if (!snapshotsReady) {
    await ensureSameDateRegimeReady(env, triggerTime, runId, 'post-screener-callback')

    const snapshotRunId = runId ?? `s12-candidate-snapshot-${triggerTime}-${Date.now().toString(36)}`
    await logSchedulerResult(env.KV, 's12-structure-snapshot', {
      status: 'running',
      summary: `pre-pipeline S12 canonical snapshot chunks queued for ${triggerTime}; run_id=${snapshotRunId}`,
      duration_ms: 0,
      run_id: snapshotRunId,
      run_date: triggerTime,
    })
    const durableEnabled = ['1', 'true', 'yes', 'on'].includes(
      String((env as any).S12_DURABLE_STRUCTURE_JOB_ENABLED ?? '').trim().toLowerCase(),
    )
    if (durableEnabled) {
      if (!env.ML_CONTROLLER_URL || !env.ML_CONTROLLER_SECRET) throw new Error('s12_structure_controller_missing')
      const response = await fetch(`${env.ML_CONTROLLER_URL.replace(/\/$/, '')}/s12-structure/batch/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Controller-Token': env.ML_CONTROLLER_SECRET,
        },
        body: JSON.stringify({
          run_date: triggerTime,
          chain_run_id: snapshotRunId,
          source: 'evening_chain',
        }),
        signal: AbortSignal.timeout(30_000),
      })
      const payload = await response.json().catch(() => ({})) as any
      if (!response.ok) {
        throw new Error(`s12_structure_batch_trigger_${response.status}:${JSON.stringify(payload).slice(0, 300)}`)
      }
      await logSchedulerResult(env.KV, 's12-structure-snapshot', {
        status: 'triggered',
        summary: `durable S12 structure job triggered date=${triggerTime} run_id=${payload.run_id ?? 'unknown'} execution=${payload.execution_id ?? 'unknown'} callback expected`,
        duration_ms: 0,
        run_id: payload.run_id ?? snapshotRunId,
        run_date: triggerTime,
      }, env)
      return
    }
    await env.UPDATE_QUEUE.send({
      type: 's12_candidate_snapshot_chunk', cursor: 0, cursorKey: '',
      triggerTime, runId: snapshotRunId, attempt: 1,
    })
    return
  }

  const evReadiness = await runDailyAllocatorEvReadiness(env, triggerTime)
  if (!evReadiness.ok) {
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'error',
      summary: `event-driven chain stopped: allocator EV readiness failed before pipeline for ${triggerTime}; ${evReadiness.summary}`,
      duration_ms: 0,
      error: evReadiness.summary,
      run_id: runId,
      run_date: triggerTime,
    })
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
        run_id: runId,
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
      run_id: runId,
      run_date: triggerTime,
    })
    console.log(`[Queue] Event-driven: triggered runMLAndRiskV2 after update complete for ${triggerTime}`)
  } catch (e) {
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'error',
      summary: `event-driven chain stopped: pipeline trigger failed for ${triggerTime}`,
      duration_ms: 0,
      error: String(e),
      run_id: runId,
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
  await ensureTradingRestrictionsDailyReadiness(env, twDate)
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
  const supplementalMode = officialSupplementalFetchMode(env)
  const shouldFetchOfficialPrices = supplementalMode !== 'disabled'

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
    sourceWaiting = true
    parts.push('official_prices=disabled')
  }

  try {
    await fetchWave2Data(env, twDate, { finLabMirror: false })
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

export async function runDailyUpdate(env: Bindings, force = false, runDate?: string): Promise<string> {
  const twDate = resolveUpdateDate(runDate)
  if (runDate && isHistoricalReplayDate(twDate)) {
    const lineageBoundary = await historicalLearningLineageDecision(env.DB, env.KV, 'evening-chain', twDate)
    if (!lineageBoundary.allowed) throw new Error(historicalLearningLineageBlockedMessage(lineageBoundary))
  }
  if (!force && await hasEveningChainSucceeded(env, twDate)) {
    return `full evening chain already succeeded for ${twDate}; 21:00 root suppressed`
  }
  if (!force && await hasEveningChainInFlight(env, twDate)) {
    const summary = `running: full evening chain already in flight for ${twDate}; 21:00 root suppressed`
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
  const fallbackReadiness = await checkEveningChainSourceReadiness(env, twDate)
  if (fallbackReadiness.ok) {
    const continuation = await continueAfterFinLabBackfill(env, twDate, force, `evening-ready-${twDate}`)
    return `triggered evening-chain: source readiness already ready for ${twDate}; ${continuation}`
  }
  if (!hasFinLabRefreshableMissing(fallbackReadiness)) {
    const summary = `running: 21:00 evening-chain waiting at non-FinLab source-readiness gate; ${fallbackReadiness.summary}`
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'running',
      summary,
      duration_ms: 0,
      details: readinessDetails(fallbackReadiness),
      run_date: twDate,
    })
    return summary
  }
  const finlabLog = await readSchedulerRunLog(env, 'finlab-v4-backfill', twDate)
  if (!force && isFinLabQuotaLimitLog(finlabLog)) {
    const summary = `running: 21:00 evening-chain skipped FinLab data.get refetch; quota_exhausted_no_refetch=${finlabLog?.summary ?? finlabLog?.error ?? 'quota limit'}; ${fallbackReadiness.summary}`
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'running',
      summary,
      duration_ms: 0,
      details: readinessDetails(fallbackReadiness),
      run_date: twDate,
    })
    return summary
  }
  const refreshScope = await finLabRetryScopeForReadiness(env, twDate, fallbackReadiness, {
    allowFetchedLaneRefetch: force,
  })
  if (!refreshScope.lanes) {
    const summary = `running: 21:00 evening-chain skipped FinLab data.get refetch; canonical_apply_pending_no_refetch${finLabRetryScopeSuffix(refreshScope)}; ${fallbackReadiness.summary}`
    await logSchedulerResult(env.KV, 'finlab-v4-backfill', {
      status: 'skipped',
      summary: `21:00 evening-chain skipped FinLab data.get refetch; canonical_apply_pending_no_refetch${finLabRetryScopeSuffix(refreshScope)}`,
      duration_ms: 0,
      details: [...readinessDetails(fallbackReadiness), ...finLabRetryScopeDetails(refreshScope)],
      run_date: twDate,
    })
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'running',
      summary,
      duration_ms: 0,
      details: [...readinessDetails(fallbackReadiness), ...finLabRetryScopeDetails(refreshScope)],
      run_date: twDate,
    })
    return summary
  }
  const finlabSummary = String(await runFinLabV4Backfill(env, twDate, force, {
    continueEveningChain: true,
    dailySourceRefresh: true,
    callbackMode: 'evening_chain',
    lanes: refreshScope.lanes,
    canonicalDatasets: refreshScope.canonicalDatasets,
    keyScopeJson: refreshScope.keyScopeJson,
    reuseSuccessfulArtifacts: finLabArtifactReuseEnabled(env) && Boolean(refreshScope.keyScopeJson),
  }))
  const finlabStatus = classifySchedulerSummary(finlabSummary)
  const finlabRunId = schedulerSummaryField({ summary: finlabSummary }, 'run_id') ?? undefined
  await logSchedulerResult(env.KV, 'finlab-v4-backfill', {
    status: finlabStatus,
    summary: `${finlabSummary}${finLabRetryScopeSuffix(refreshScope)}`,
    duration_ms: 0,
    details: [...readinessDetails(fallbackReadiness), ...finLabRetryScopeDetails(refreshScope)],
    run_id: finlabRunId,
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

export async function runFinLabBackfillWatchdog(env: Bindings, runDate?: string): Promise<string> {
  const twDate = resolveUpdateDate(runDate)
  if (await hasEveningChainSucceeded(env, twDate)) {
    return `skipped: evening-chain already succeeded for ${twDate}`
  }

  const finlabLog = await readSchedulerRunLog(env, 'finlab-v4-backfill', twDate)
  if (finlabLog?.status === 'running') {
    return `skipped: FinLab start heartbeat received for ${twDate}`
  }
  const retriablePartialFailure = finlabLog?.status === 'error' && (
    /partial_failed/i.test(finlabLog.summary ?? '') ||
    /source_key_blockers/i.test(finlabLog.summary ?? '') ||
    /required_wide_field_incomplete/i.test(finlabLog.summary ?? '') ||
    /materializer_(?:blocked|failed)/i.test(finlabLog.summary ?? '')
  )
  if ((finlabLog?.status !== 'triggered' && !retriablePartialFailure) || !finlabLog.timestamp) {
    return `skipped: no pending FinLab trigger for ${twDate}`
  }

  const triggeredAt = Date.parse(finlabLog.timestamp)
  const ageMs = Number.isFinite(triggeredAt) ? Date.now() - triggeredAt : Number.POSITIVE_INFINITY
  if (ageMs < FINLAB_PENDING_WATCHDOG_STALE_MS) {
    return `skipped: FinLab ${retriablePartialFailure ? 'partial failure' : 'trigger'} age=${Math.max(0, Math.floor(ageMs / 1000))}s below watchdog threshold`
  }

  const runId = finlabLog.run_id ?? schedulerSummaryField(finlabLog, 'run_id')
  const functionCallId = schedulerSummaryField(finlabLog, 'function_call_id')
  const previousAttempt = Number.parseInt(schedulerSummaryField(finlabLog, 'dispatch_attempt') ?? '1', 10)
  if (!runId) throw new Error(`FinLab watchdog cannot recover ${twDate}: pending run_id missing`)
  if (previousAttempt >= FINLAB_PENDING_WATCHDOG_MAX_ATTEMPTS) {
    const summary = `failed: FinLab pending watchdog exhausted run_id=${runId} dispatch_attempt=${previousAttempt}`
    await logSchedulerResult(env.KV, 'finlab-v4-backfill', {
      status: 'error', summary, duration_ms: ageMs, run_id: runId, run_date: twDate,
    }, env as any)
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'error', summary, duration_ms: ageMs, run_id: runId, run_date: twDate,
    }, env as any)
    return summary
  }

  const nextAttempt = previousAttempt + 1
  const retryKey = `finlab:pending-watchdog:${twDate}:${runId}:${nextAttempt}`
  if (await env.KV.get(retryKey)) {
    return `skipped: FinLab watchdog retry already claimed run_id=${runId} dispatch_attempt=${nextAttempt}`
  }
  await env.KV.put(retryKey, new Date().toISOString(), { expirationTtl: 3600 })
  // Reserve the attempt before cancellation/spawn so a late callback from the
  // superseded call cannot overwrite the active dispatch while HTTP is in flight.
  await logSchedulerResult(env.KV, 'finlab-v4-backfill', {
    status: 'triggered',
    summary: `triggered FinLab watchdog dispatch reservation run_id=${runId} function_call_id=${functionCallId ?? 'unknown'} dispatch_attempt=${nextAttempt}`,
    duration_ms: 0,
    run_id: runId,
    run_date: twDate,
  })

  try {
    const readiness = await checkEveningChainSourceReadiness(env, twDate)
    const refreshScope = await finLabRetryScopeForReadiness(env, twDate, readiness, {
      allowFetchedLaneRefetch: retriablePartialFailure,
    })
    if (!refreshScope.lanes) {
      await env.KV.delete(retryKey)
      return `skipped: FinLab watchdog found no source keys eligible for refetch${finLabRetryScopeSuffix(refreshScope)}`
    }
    const summary = String(await runFinLabV4Backfill(env, twDate, false, {
      continueEveningChain: true,
      dailySourceRefresh: true,
      callbackMode: 'evening_chain',
      lanes: refreshScope.lanes,
      canonicalDatasets: refreshScope.canonicalDatasets,
      keyScopeJson: refreshScope.keyScopeJson,
      reuseSuccessfulArtifacts: true,
      runId,
      dispatchAttempt: nextAttempt,
      supersedeFunctionCallId: functionCallId ?? undefined,
    }))
    const status = classifySchedulerSummary(summary)
    await logSchedulerResult(env.KV, 'finlab-v4-backfill', {
      status,
      summary: `${summary}; watchdog_retriggered_from_attempt=${previousAttempt}`,
      duration_ms: 0,
      run_id: runId,
      run_date: twDate,
    })
    await logSchedulerResult(env.KV, 'evening-chain', {
      status: 'triggered',
      summary: `FinLab watchdog retriggered ${retriablePartialFailure ? 'partial failure' : 'pending dispatch'} run_id=${runId} dispatch_attempt=${nextAttempt}; awaiting callback`,
      duration_ms: 0,
      run_id: runId,
      run_date: twDate,
    })
    return summary
  } catch (error) {
    await env.KV.delete(retryKey)
    throw error
  }
}

export async function fetchWave2Data(
  env: Bindings,
  today: string,
  options: { finLabMirror?: boolean } = {},
): Promise<void> {
  const supplementalMode = officialSupplementalFetchMode(env)
  const forceOfficial = supplementalMode === 'always'
  const officialFallbackAllowed = supplementalMode !== 'disabled'
  const useFinLabMirror = options.finLabMirror !== false
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

  const fetchOfficialBreadth = async () => {
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

  if (useFinLabMirror) {
    try {
      const finlabBreadth = await syncMarketBreadthFromFinLabCanonical(env.DB, today)
      if (finlabBreadth.sampleSize >= 1000) {
        console.log(
          `[Wave2] FinLab market breadth: ${finlabBreadth.advanceCount}/${finlabBreadth.declineCount}/${finlabBreadth.unchangedCount} sample=${finlabBreadth.sampleSize}`,
        )
      }
      if ((forceOfficial || finlabBreadth.sampleSize < 1000) && officialFallbackAllowed) {
        await fetchOfficialBreadth()
      }
    } catch (e) {
      console.warn('[Wave2] FinLab market breadth failed:', e)
      if (officialFallbackAllowed) {
        try {
          await fetchOfficialBreadth()
        } catch (fallbackError) {
          console.warn('[Wave2] Official fallback market breadth failed:', fallbackError)
        }
      }
    }
  } else if (officialFallbackAllowed) {
    try {
      await fetchOfficialBreadth()
    } catch (fallbackError) {
      console.warn('[Wave2] Official fallback market breadth failed:', fallbackError)
    }
  }

  if (useFinLabMirror) {
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
  if (useFinLabMirror && day <= 12) {
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
  if (msg.type === 'data_domain_shadow_backfill') {
    const { processDataDomainShadowBackfillDrain } = await import('./dataDomainShadowBackfillDrain')
    await processDataDomainShadowBackfillDrain(env, msg)
    return
  }

  if (msg.type === 'maintenance_backlog_drain') {
    const { processMaintenanceBacklogDrain } = await import('./maintenanceBacklogDrain')
    await processMaintenanceBacklogDrain(env, msg)
    return
  }

  if (msg.type === 's12_research_recovery') {
    const triggerTime = msg.triggerTime
    const runId = msg.runId || `s12-research-recovery-${triggerTime}-${Date.now()}`
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid S12 research recovery date ${triggerTime}, skipping.`)
      return
    }
    const { loadS12ResearchUsageStatus } = await import('./s12RuntimeBars')
    const usage = await loadS12ResearchUsageStatus(env)
    if (usage.status !== 'ok') {
      await logSchedulerResult(env.KV, 's12-research-recovery', {
        status: 'error',
        summary: `quota preflight failed date=${triggerTime} bytes=${usage.bytes} limit=${usage.limit_bytes} remaining=${usage.remaining_bytes}; reconstruction=0`,
        duration_ms: 0,
        run_id: runId,
        run_date: triggerTime,
      }, env)
      return
    }

    const { runS12CandidateStructureSnapshots } = await import('./s12CandidateStructureSnapshots')
    const reconstruction = await runS12CandidateStructureSnapshots(env, triggerTime, {
      source: 's12_candidate_snapshot_reconstruction',
    })
    const terminalSourceFailure = Object.keys(reconstruction.skip_reasons).some((reason) => (
      reason.includes('shioaji_research_bandwidth_exhausted')
      || reason.includes('s12_research_service_')
      || reason.includes('missing_intraday_bars')
      || reason.includes('empty_kbars')
    ))
    const complete = reconstruction.attempted > 0
      && reconstruction.persisted === reconstruction.attempted
      && reconstruction.errors === 0
      && !terminalSourceFailure
    if (!complete) {
      await logSchedulerResult(env.KV, 's12-research-recovery', {
        status: 'error',
        summary: `reconstruction incomplete date=${triggerTime} attempted=${reconstruction.attempted} persisted=${reconstruction.persisted} skipped=${reconstruction.skipped} errors=${reconstruction.errors} source_failure=${terminalSourceFailure ? 1 : 0}`,
        duration_ms: 0,
        run_id: runId,
        run_date: triggerTime,
      }, env)
      return
    }

    const snapshotSummary = await runAllocatorEvFeatureSnapshotBackfill(env, {
      startDate: triggerTime,
      endDate: triggerTime,
      dryRun: false,
      candidateLimit: 1000,
      l4MinSamples: 500,
      l4MinDates: 20,
    })
    await logSchedulerResult(env.KV, 's12-research-recovery', {
      status: 'success',
      summary: `quota_ok remaining=${usage.remaining_bytes} reconstruction=${reconstruction.persisted}/${reconstruction.attempted} ready=${reconstruction.ready} snapshot=${JSON.stringify(snapshotSummary).slice(0, 500)}`,
      duration_ms: 0,
      run_id: runId,
      run_date: triggerTime,
    }, env)
    return
  }

  if (msg.type === 'post_pipeline_chain') {
    const triggerTime = msg.triggerTime
    const runId = msg.runId || `post-pipeline-chain-${triggerTime}`
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid post-pipeline chain date ${triggerTime}, skipping.`)
      return
    }
    const {
      claimPipelineStage,
      enqueuePipelineStage,
      markPipelineStage,
    } = await import('./pipelineStageLease')
    await enqueuePipelineStage(env.DB, {
      businessDate: triggerTime,
      stage: 'post_pipeline_chain',
      runId,
      resumeWaiting: true,
    })
    const claimed = await claimPipelineStage(env.DB, {
      businessDate: triggerTime,
      stage: 'post_pipeline_chain',
      ownerId: runId,
      leaseSeconds: 900,
    })
    if (!claimed) {
      console.log(`[Queue] post-pipeline stage already claimed/closed date=${triggerTime}`)
      return
    }
    const { runPostPipelineCallbackChain } = await import('./postMarketChain')
    try {
      const status = await runPostPipelineCallbackChain(env, {
        runDate: triggerTime,
        upstreamRunId: claimed.canonical_run_id,
        recoveryAttempt: Math.max(
          0,
          Number(msg.attempt ?? 0),
          Number(claimed.attempt_count ?? 1) - 1,
        ),
      })
      await markPipelineStage(env.DB, {
        businessDate: triggerTime,
        stage: 'post_pipeline_chain',
        status,
      })
    } catch (error) {
      await markPipelineStage(env.DB, {
        businessDate: triggerTime,
        stage: 'post_pipeline_chain',
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    return
  }

  if (msg.type === 'post_verify_chain') {
    const triggerTime = msg.triggerTime
    const runId = msg.runId || `post-verify-chain-${triggerTime}`
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid post-verify chain date ${triggerTime}, skipping.`)
      return
    }
    const {
      claimPipelineStage,
      enqueuePipelineStage,
      markPipelineStage,
    } = await import('./pipelineStageLease')
    await enqueuePipelineStage(env.DB, {
      businessDate: triggerTime,
      stage: 'post_verify_chain',
      runId,
      resumeWaiting: true,
    })
    const claimed = await claimPipelineStage(env.DB, {
      businessDate: triggerTime,
      stage: 'post_verify_chain',
      ownerId: runId,
      leaseSeconds: 900,
    })
    if (!claimed) {
      console.log(`[Queue] post-verify stage already claimed/closed date=${triggerTime}`)
      return
    }
    const { runPostVerifyCallbackChain } = await import('./postMarketChain')
    try {
      const status = await runPostVerifyCallbackChain(env, {
        runDate: triggerTime,
        upstreamRunId: claimed.canonical_run_id,
        recoveryAttempt: Math.max(
          0,
          Number(msg.attempt ?? 0),
          Number(claimed.attempt_count ?? 1) - 1,
        ),
      })
      await markPipelineStage(env.DB, {
        businessDate: triggerTime,
        stage: 'post_verify_chain',
        status,
      })
    } catch (error) {
      await markPipelineStage(env.DB, {
        businessDate: triggerTime,
        stage: 'post_verify_chain',
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    return
  }

  if (msg.type === 'allocator_ev_lifecycle_recovery') {
    const triggerTime = msg.triggerTime
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid allocator EV lifecycle recovery date ${triggerTime}, skipping.`)
      return
    }
    const { queuePostPipelineStage } = await import('./pipelineStageLease')
    await queuePostPipelineStage(env, {
      businessDate: triggerTime,
      runId: msg.runId || `allocator-ev-lifecycle-recovery-${triggerTime}`,
      resumeWaiting: true,
      attempt: Math.max(1, Number(msg.attempt ?? 1)),
    })
    return
  }

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
        await scheduleSourceReadinessRetry(env, triggerTime, attempt, message)
        return
      }
      throw e
    }
    return
  }

  if (msg.type === 'meta_learning_shadow_closure') {
    const triggerTime = msg.triggerTime
    const runId = msg.runId || `meta-learning-shadow-${triggerTime}`
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid meta-learning shadow date ${triggerTime}, skipping.`)
      return
    }

    const startedAt = Date.now()
    try {
      const { runMetaLearningShadowClosure } = await import('./postMarketChain')
      const summary = await runMetaLearningShadowClosure(env, {
        runDate: triggerTime,
        upstreamRunId: runId,
      })
      await logSchedulerResult(env.KV, 'meta-learning-shadow', {
        status: 'success',
        summary,
        duration_ms: Date.now() - startedAt,
        run_id: runId,
        run_date: triggerTime,
      }, env)
    } catch (error: any) {
      const summary = error?.message ?? String(error)
      await logSchedulerResult(env.KV, 'meta-learning-shadow', {
        status: 'error',
        summary,
        duration_ms: Date.now() - startedAt,
        run_id: runId,
        run_date: triggerTime,
        error: String(error),
      }, env)
      throw error
    }
    return
  }

  if (msg.type === 'strategy_learning_materialize') {
    const triggerTime = msg.triggerTime
    const runId = msg.runId || `strategy-learning-${triggerTime}`
    const requestedCursor = String(msg.cursorKey ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid strategy-learning date ${triggerTime}, skipping.`)
      return
    }

    const {
      finalizeStrategyLearningEvidenceV5,
      listStrategySpecsForLearning,
      materializeStrategyDecisionLogChunk,
      seedDefaultStrategySpecRegistry,
    } = await import('./strategyLearning')
    if (!requestedCursor) {
      await seedDefaultStrategySpecRegistry(env.DB)
    }
    const { specs } = await listStrategySpecsForLearning(env.DB)
    const {
      checkpointStrategyLearningPage,
      claimStrategyLearningPage,
      completeStrategyLearningRun,
      deferStrategyLearningFinalizer,
      failStrategyLearningRun,
      initializeStrategyLearningRun,
      markStrategyLearningRunFinalized,
    } = await import('./strategyLearningRunState')
    const state = await initializeStrategyLearningRun(env.DB, {
      businessDate: triggerTime,
      runId,
      strategyCount: specs.length,
    })
    if (state.status === 'success') {
      console.log(`[Queue] strategy-learning already complete date=${triggerTime} run_id=${state.canonical_run_id}`)
      return
    }
    const expectedCandidates = Math.max(0, Number(state.expected_candidates ?? 0))
    const expectedRows = Math.max(0, Number(state.expected_decision_rows ?? 0))
    const materializationAlreadyComplete = expectedCandidates > 0
      && expectedRows > 0
      && Number(state.processed_candidates) === expectedCandidates
      && Number(state.persisted_decision_rows) === expectedRows
    const durableCursor = String(state.cursor_symbol ?? '')
    if (requestedCursor && requestedCursor !== durableCursor) {
      console.log(`[Queue] stale strategy-learning cursor ignored date=${triggerTime} requested=${requestedCursor} durable=${durableCursor}`)
      return
    }
    const canonicalRunId = state.canonical_run_id
    const finalizerAttemptId = `${canonicalRunId}:finalize:${Date.now().toString(36)}`
    const claimed = await claimStrategyLearningPage(env.DB, {
      businessDate: triggerTime,
      runId: canonicalRunId,
      cursorSymbol: durableCursor,
      leaseSeconds: 300,
    })
    if (!claimed) {
      console.log(`[Queue] strategy-learning page already claimed date=${triggerTime} cursor=${durableCursor}`)
      return
    }

    let materializationValidated = materializationAlreadyComplete
    try {
      let chunk: Awaited<ReturnType<typeof materializeStrategyDecisionLogChunk>> | null = null
      if (!materializationAlreadyComplete) {
        chunk = await materializeStrategyDecisionLogChunk(env.DB, {
        date: triggerTime,
        afterSymbol: durableCursor,
        limit: STRATEGY_LEARNING_QUEUE_CHUNK_SIZE,
        dryRun: false,
        artifactEnv: env,
        producerRunId: `${canonicalRunId}:after=${encodeURIComponent(durableCursor || 'start')}`,
      })
      if (chunk.has_more && (!chunk.next_cursor_symbol || chunk.next_cursor_symbol === durableCursor)) {
        throw new Error(`strategy_learning_keyset_stalled:${durableCursor}`)
      }
      const checkpointed = await checkpointStrategyLearningPage(env.DB, {
        businessDate: triggerTime,
        runId: canonicalRunId,
        previousCursor: durableCursor,
        nextCursor: chunk.next_cursor_symbol,
        processedCandidates: chunk.candidate_count,
        persistedRows: chunk.persisted_rows,
      })
      if (!checkpointed) throw new Error(`strategy_learning_checkpoint_conflict:${durableCursor}`)

      if (chunk.has_more) {
        await logSchedulerResult(env.KV, 'strategy-learning', {
          status: 'running',
          summary: `materialized keyset after=${durableCursor || 'start'} candidates=${chunk.candidate_count} decision_rows=${chunk.persisted_rows}; next=${chunk.next_cursor_symbol}`,
          duration_ms: 0,
          run_id: canonicalRunId,
          run_date: triggerTime,
        })
        await env.UPDATE_QUEUE.send({
          type: 'strategy_learning_materialize',
          cursor: 0,
          cursorKey: chunk.next_cursor_symbol,
          triggerTime,
          runId: canonicalRunId,
          force: Boolean(msg.force),
        })
        return
      }
      }

      const coverage = await completeStrategyLearningRun(env.DB, {
        businessDate: triggerTime,
        runId: canonicalRunId,
      })
      materializationValidated = true

      const productionAuthority = Boolean(msg.force)
        ? await resolveEveningChainRunAuthority(env, {
            businessDate: triggerTime,
            canonicalRunId,
          })
        : null
      const currentBusinessDateRun = productionAuthority?.allowed === true
      const runScope = productionAuthority?.runScope ?? 'historical_replay'
      const authorityReason = productionAuthority?.reason ?? 'queue_not_marked_production_eligible'
      const chainDurationMs = await resolveEveningChainClosureDurationMs(env.DB, triggerTime)
      const {
        auditEveningChainEvidenceClosure,
        resolveExpectedMatureSignalDate,
        summarizeEveningChainEvidenceClosure,
      } = await import('./eveningChainEvidenceClosure')
      const historicalPriorityDate = await resolveExpectedMatureSignalDate(env, triggerTime)
      const { recoverMatureSelectionEvidence } = await import('./matureSelectionEvidenceRecovery')
      const matureRecovery = await recoverMatureSelectionEvidence(env, triggerTime, {
        maxRecoveryDates: 4,
      })
      let closureSummary = ''
      const { decisionEvidence, historicalEvidence, labels, marginalEdge, routeBackfillEligibility, rewards, policy, thresholdCalibration }
        = await finalizeStrategyLearningEvidenceV5(env.DB, triggerTime, {
          allowPromotion: currentBusinessDateRun,
          persistPolicy: currentBusinessDateRun,
          calibrateThresholds: currentBusinessDateRun,
          calibrationCadence: 'daily_drift',
          historicalPriorityDate,
          beforePromotion: async () => {
            const closureAudit = await auditEveningChainEvidenceClosure(
              env,
              triggerTime,
              String(state.producer_run_id ?? ''),
            )
            closureSummary = summarizeEveningChainEvidenceClosure(closureAudit)
          },
        })
      if (!closureSummary) throw new Error('evening_chain_evidence_closure_callback_missing')
      const summary = [
      `materialized_complete candidates=${coverage.candidateRows}/${coverage.expectedCandidates} rows=${coverage.decisionRows}/${coverage.expectedRows}`,
      `last_candidates=${chunk?.candidate_count ?? 0}`,
      `last_decision_rows=${chunk?.persisted_rows ?? 0}`,
      `mature_recovery=${matureRecovery.summary}`,
      `selection_decisions=${decisionEvidence.finalSignalRows}/${decisionEvidence.referenceRows}`,
      `selection_ev_owner=${decisionEvidence.evOwnerRows}`,
      `strategy_pit_rebuild=${historicalEvidence.successfulDates}/${historicalEvidence.attemptedDates}`,
      `strategy_pit_blocked=${historicalEvidence.blockedDates}`,
      `selection_labels=${labels.persisted_rows}`,
      `selection_pending=${labels.pending_rows}`,
      `selection_unavailable=${labels.unavailable_rows}`,
      `strategy_edge=${marginalEdge.status}:eligible=${marginalEdge.eligibleStrategies}:dates=${marginalEdge.sampleDates}`,
      `route_backfill_eligible=${routeBackfillEligibility.filter((row) => row.status === 'eligible').length}`,
      `route_backfill_unavailable=${routeBackfillEligibility.filter((row) => row.status === 'unavailable').length}`,
      `route_backfill_pending=${routeBackfillEligibility.filter((row) => row.status === 'pending_maturity').length}`,
      `reward_source_rows=${rewards.source_rows}`,
      `reward_rows=${rewards.persisted_rows}`,
      `policy=${policy ? policy.policy_state.status : 'skipped_historical'}`,
      `threshold_calibration=${thresholdCalibration ? thresholdCalibration.status : 'skipped_historical'}`,
      `evidence_closure=${closureSummary}`,
      `run_scope=${runScope}`,
      `production_authority=${authorityReason}`,
      ].join(' ')

      await logSchedulerResult(env.KV, 'strategy-learning', {
        status: 'success', summary, duration_ms: chainDurationMs, run_id: canonicalRunId,
        attempt_id: finalizerAttemptId, run_date: triggerTime, run_scope: runScope,
      })
      await logSchedulerResult(env.KV, 'post-verify-chain', {
        status: 'success', summary: `strategy-learning queue closed; ${summary}`,
        duration_ms: chainDurationMs, run_id: canonicalRunId, attempt_id: finalizerAttemptId,
        run_date: triggerTime, run_scope: runScope,
      })
      await logSchedulerResult(env.KV, 'evening-chain', {
        status: 'success', summary: `root chain closed after queued strategy-learning: ${summary}`,
        duration_ms: chainDurationMs, run_id: canonicalRunId, attempt_id: finalizerAttemptId,
        run_date: triggerTime, run_scope: runScope,
      })
      await markStrategyLearningRunFinalized(env.DB, { businessDate: triggerTime, runId: canonicalRunId })
      return
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (materializationValidated) {
        await deferStrategyLearningFinalizer(env.DB, {
          businessDate: triggerTime,
          runId: canonicalRunId,
          error: errorMessage,
        })
      } else {
        await failStrategyLearningRun(env.DB, {
          businessDate: triggerTime,
          error: errorMessage,
        })
      }
      await Promise.allSettled([
        logSchedulerResult(env.KV, 'strategy-learning', {
          status: 'error', summary: errorMessage, error: errorMessage, duration_ms: 0,
          run_id: canonicalRunId, attempt_id: finalizerAttemptId, run_date: triggerTime,
        }),
        logSchedulerResult(env.KV, 'post-verify-chain', {
          status: 'error', summary: `strategy-learning finalizer blocked: ${errorMessage}`,
          error: errorMessage, duration_ms: 0, run_id: canonicalRunId,
          attempt_id: finalizerAttemptId, run_date: triggerTime,
        }),
        logSchedulerResult(env.KV, 'evening-chain', {
          status: 'error', summary: `root chain blocked by strategy-learning evidence audit: ${errorMessage}`,
          error: errorMessage, duration_ms: 0, run_id: canonicalRunId,
          attempt_id: finalizerAttemptId, run_date: triggerTime,
        }),
      ])
      throw error
    }
  }

  if (msg.type === 'source_readiness_retry') {
    const triggerTime = msg.triggerTime
    const attempt = Number.isFinite(msg.attempt) ? Number(msg.attempt) : 1
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid source readiness retry date ${triggerTime}, skipping.`)
      return
    }

    try {
      const readiness = await checkEveningChainSourceReadiness(env, triggerTime)
      if (hasFinLabRefreshableMissing(readiness)) {
        const retrySummary = await runDailyUpdate(env, true, triggerTime)
        await logSchedulerResult(env.KV, 'evening-chain', {
          status: 'running',
          summary: `canonical source retry dispatched for ${triggerTime}; ${retrySummary}`,
          duration_ms: 0,
          run_date: triggerTime,
        })
        return
      }
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
    const continuationAttempt = Number.isFinite(msg.continuationAttempt)
      ? Number(msg.continuationAttempt)
      : 1
    const donePrefix = `cron:indicator-queue:${triggerTime}:${runId}:done:`
    await new Promise((resolve) => setTimeout(resolve, FINALIZE_RECHECK_DELAY_MS))
    const done = await env.KV.list({ prefix: donePrefix })
    const doneCount = new Set(done.keys.map((k) => k.name)).size

    if (doneCount >= shardCount) {
      await finalizeUpdateChain(env, deps, triggerTime, runId, shardCount, continuationAttempt)
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
        continuationAttempt,
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

  if (msg.type === 's12_intraday_setup_watch_complete') {
    const triggerTime = msg.triggerTime
    const runId = msg.runId || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime) || !runId) {
      throw new Error('invalid_s12_intraday_setup_watch_completion_message')
    }
    const summary = await triggerPendingS12FormalEv(env, triggerTime)
    await logSchedulerResult(env.KV, 's12-intraday-setup-watch', {
      status: summary.status === 'empty' ? 'success' : summary.status,
      summary: `formal EV continuation ${summary.status}; ready=${summary.ready_count} date=${triggerTime} run_id=${runId}`,
      duration_ms: 0,
      run_id: runId,
      run_date: triggerTime,
    }, env)
    return
  }


  if (msg.type === 's12_structure_batch_complete') {
    const triggerTime = msg.triggerTime
    const runId = msg.runId || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime) || !runId) {
      throw new Error('invalid_s12_structure_batch_completion_message')
    }
    const coverage = await env.DB.prepare(`
      SELECT COUNT(*) reference_rows,
             SUM(CASE WHEN s.symbol IS NOT NULL THEN 1 ELSE 0 END) persisted_rows,
             SUM(CASE WHEN s.ready=1 THEN 1 ELSE 0 END) ready_rows,
             SUM(CASE WHEN s.state='data_unavailable' THEN 1 ELSE 0 END) unavailable_rows,
             SUM(CASE WHEN s.symbol IS NOT NULL AND s.ready=0
                       AND s.state<>'data_unavailable' THEN 1 ELSE 0 END) blocked_rows
        FROM selection_reference_snapshots_v1 r
        LEFT JOIN s12_structure_snapshots s
          ON s.trade_date=r.signal_date AND s.symbol=r.symbol
         AND s.source='s12_candidate_snapshot' AND s.pending_run_id=?
       WHERE r.signal_date=?
         AND EXISTS (
           SELECT 1 FROM canonical_run_heads h
            WHERE h.logical_run_key='screener:' || r.signal_date || ':TW:production:market_screener'
              AND h.run_id=r.producer_run_id
         )
    `).bind(runId, triggerTime).first<{
      reference_rows?: number
      persisted_rows?: number
      ready_rows?: number
      unavailable_rows?: number
      blocked_rows?: number
    }>()
    const referenceRows = Number(coverage?.reference_rows ?? 0)
    const persistedRows = Number(coverage?.persisted_rows ?? 0)
    if (referenceRows <= 0 || persistedRows !== referenceRows) {
      const summary = `durable S12 canonical snapshot coverage=${persistedRows}/${referenceRows} date=${triggerTime} run_id=${runId}`
      await logSchedulerResult(env.KV, 's12-structure-snapshot', {
        status: 'error', summary, duration_ms: 0, run_id: runId, run_date: triggerTime,
      }, env)
      await logSchedulerResult(env.KV, 'evening-chain', {
        status: 'error',
        summary: `event-driven chain stopped: ${summary}`,
        duration_ms: 0,
        run_id: runId,
        run_date: triggerTime,
      }, env)
      return
    }
    await logSchedulerResult(env.KV, 's12-structure-snapshot', {
      status: 'success',
      summary: `durable S12 canonical snapshots complete coverage=${persistedRows}/${referenceRows} ready=${Number(coverage?.ready_rows ?? 0)} blocked=${Number(coverage?.blocked_rows ?? 0)} unavailable=${Number(coverage?.unavailable_rows ?? 0)} date=${triggerTime} run_id=${runId}`,
      duration_ms: 0,
      run_id: runId,
      run_date: triggerTime,
    }, env)
    const stage = `s12_snapshot_pipeline:${runId}`
    const stageState = await enqueuePipelineStage(env.DB, {
      businessDate: triggerTime,
      stage,
      runId,
      resumeWaiting: true,
    })
    const ownerId = `s12-durable-finalizer:${runId}:${crypto.randomUUID()}`
    const claim = await claimPipelineStage(env.DB, {
      businessDate: triggerTime,
      stage,
      ownerId,
      leaseSeconds: 900,
    })
    if (!claim) {
      console.log(`[Queue] Duplicate durable S12 finalizer suppressed date=${triggerTime} run_id=${runId} status=${stageState.row.status}`)
      return
    }
    try {
      await continuePostScreenerPipeline(env, deps, triggerTime, runId, true)
      await markPipelineStage(env.DB, {
        businessDate: triggerTime,
        stage,
        status: 'success',
      })
    } catch (error) {
      await markPipelineStage(env.DB, {
        businessDate: triggerTime,
        stage,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    return
  }

  if (msg.type === 's12_candidate_snapshot_chunk') {
    const triggerTime = msg.triggerTime
    const runId = msg.runId || `s12-candidate-snapshot-${triggerTime}-${Date.now().toString(36)}`
    const afterSymbol = String(msg.cursorKey ?? '').trim()
    const attempt = Math.max(1, Number(msg.attempt ?? 1))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid S12 candidate snapshot date ${triggerTime}, skipping.`)
      return
    }
    const {
      loadS12PipelineSeedSymbolsByDate,
      runS12CandidateStructureSnapshots,
    } = await import('./s12CandidateStructureSnapshots')
    const candidates = await loadS12PipelineSeedSymbolsByDate(
      env.DB, triggerTime, S12_CANDIDATE_SNAPSHOT_CHUNK_SIZE, afterSymbol,
    )
    const symbols = candidates.slice(0, S12_CANDIDATE_SNAPSHOT_CHUNK_SIZE)
    if (!symbols.length) {
      await logSchedulerResult(env.KV, 's12-structure-snapshot', {
        status: 'error',
        summary: `pre-pipeline S12 canonical reference set empty for ${triggerTime}; run_id=${runId}`,
        duration_ms: 0,
        run_id: runId,
        run_date: triggerTime,
      }, env)
      return
    }
    let snapshotResult
    try {
      snapshotResult = await runS12CandidateStructureSnapshots(env, triggerTime, {
        limit: S12_CANDIDATE_SNAPSHOT_CHUNK_SIZE,
        symbols,
        pendingRunId: runId,
        researchTimeoutMs: S12_CANDIDATE_SNAPSHOT_RESEARCH_TIMEOUT_MS,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.startsWith('s12_research_lease_busy:')) throw error
      const leaseRetryAttempt = Math.max(0, Number(msg.leaseRetryAttempt ?? 0))
      if (leaseRetryAttempt >= S12_REPLAY_LEASE_RETRY_MAX_ATTEMPTS) throw error
      const delaySeconds = s12ReplayLeaseRetryDelaySeconds(triggerTime, leaseRetryAttempt + 1)
      await env.UPDATE_QUEUE.send({
        ...msg,
        leaseRetryAttempt: leaseRetryAttempt + 1,
      }, { delaySeconds } as any)
      await logSchedulerResult(env.KV, 's12-structure-snapshot', {
        status: 'running',
        summary: `pre-pipeline S12 research lease busy; date=${triggerTime} after=${afterSymbol || 'start'} deferred_attempt=${leaseRetryAttempt + 1} delay_seconds=${delaySeconds}`,
        duration_ms: 0,
        run_id: runId,
        run_date: triggerTime,
      })
      return
    }
    const complete = snapshotResult.attempted === symbols.length
      && snapshotResult.persisted === symbols.length
      && snapshotResult.errors === 0
    if (!complete) {
      if (attempt < 3) {
        await env.UPDATE_QUEUE.send({ ...msg, attempt: attempt + 1 }, { delaySeconds: 60 } as any)
        await logSchedulerResult(env.KV, 's12-structure-snapshot', {
          status: 'running',
          summary: `pre-pipeline S12 chunk retry date=${triggerTime} after=${afterSymbol || 'start'} persisted=${snapshotResult.persisted}/${symbols.length} errors=${snapshotResult.errors} attempt=${attempt + 1}/3`,
          duration_ms: 0,
          run_id: runId,
          run_date: triggerTime,
        })
        return
      }
      await logSchedulerResult(env.KV, 'evening-chain', {
        status: 'error',
        summary: `event-driven chain stopped: incomplete S12 snapshot chunk date=${triggerTime} after=${afterSymbol || 'start'} persisted=${snapshotResult.persisted}/${symbols.length} errors=${snapshotResult.errors}`,
        duration_ms: 0,
        run_id: runId,
        run_date: triggerTime,
      }, env)
      return
    }
    const hasMore = candidates.length > S12_CANDIDATE_SNAPSHOT_CHUNK_SIZE
    const cursorKey = symbols[symbols.length - 1].symbol
    if (hasMore) {
      await env.UPDATE_QUEUE.send({
        type: 's12_candidate_snapshot_chunk', cursor: 0, cursorKey,
        triggerTime, runId, attempt: 1,
      })
      await logSchedulerResult(env.KV, 's12-structure-snapshot', {
        status: 'running',
        summary: `pre-pipeline S12 chunk complete date=${triggerTime} through=${cursorKey} persisted=${snapshotResult.persisted} ready=${snapshotResult.ready} unavailable=${snapshotResult.unavailable}${snapshotResult.unavailable > 0 ? ' analysis_continues=1 execution_fail_closed=1' : ''} queued_next=1`,
        duration_ms: 0,
        run_id: runId,
        run_date: triggerTime,
      })
      return
    }
    const coverage = await env.DB.prepare(`
      SELECT COUNT(*) reference_rows,
             SUM(CASE WHEN s.symbol IS NOT NULL THEN 1 ELSE 0 END) persisted_rows
             ,SUM(CASE WHEN s.ready=1 THEN 1 ELSE 0 END) ready_rows
             ,SUM(CASE WHEN s.state='data_unavailable' THEN 1 ELSE 0 END) unavailable_rows
             ,SUM(CASE WHEN s.symbol IS NOT NULL AND s.ready=0 AND s.state<>'data_unavailable' THEN 1 ELSE 0 END) blocked_rows
        FROM selection_reference_snapshots_v1 r
        LEFT JOIN s12_structure_snapshots s
          ON s.trade_date=r.signal_date AND s.symbol=r.symbol
         AND s.source='s12_candidate_snapshot' AND s.pending_run_id=?
       WHERE r.signal_date=?
         AND EXISTS (
           SELECT 1 FROM canonical_run_heads h
            WHERE h.logical_run_key='screener:' || r.signal_date || ':TW:production:market_screener'
              AND h.run_id=r.producer_run_id
         )
    `).bind(runId, triggerTime).first<{
      reference_rows?: number
      persisted_rows?: number
      ready_rows?: number
      unavailable_rows?: number
      blocked_rows?: number
    }>()
    const referenceRows = Number(coverage?.reference_rows ?? 0)
    const persistedRows = Number(coverage?.persisted_rows ?? 0)
    const readyRows = Number(coverage?.ready_rows ?? 0)
    const unavailableRows = Number(coverage?.unavailable_rows ?? 0)
    const blockedRows = Number(coverage?.blocked_rows ?? 0)
    if (referenceRows <= 0 || persistedRows !== referenceRows) {
      await logSchedulerResult(env.KV, 'evening-chain', {
        status: 'error',
        summary: `event-driven chain stopped: S12 canonical snapshot coverage=${persistedRows}/${referenceRows} date=${triggerTime} run_id=${runId}`,
        duration_ms: 0,
        run_id: runId,
        run_date: triggerTime,
      }, env)
      return
    }
    await logSchedulerResult(env.KV, 's12-structure-snapshot', {
      status: 'success',
      summary: `pre-pipeline S12 canonical snapshots complete coverage=${persistedRows}/${referenceRows} ready=${readyRows} blocked=${blockedRows} unavailable=${unavailableRows}${unavailableRows > 0 ? ' analysis_continues=1 execution_fail_closed=1' : ''} date=${triggerTime} run_id=${runId}`,
      duration_ms: 0,
      run_id: runId,
      run_date: triggerTime,
    })
    const finalizerStage = `s12_snapshot_pipeline:${runId}`
    const finalizerState = await enqueuePipelineStage(env.DB, {
      businessDate: triggerTime,
      stage: finalizerStage,
      runId,
      resumeWaiting: true,
    })
    const finalizerOwner = `s12-snapshot-finalizer:${runId}:${crypto.randomUUID()}`
    const finalizerClaim = await claimPipelineStage(env.DB, {
      businessDate: triggerTime,
      stage: finalizerStage,
      ownerId: finalizerOwner,
      leaseSeconds: 900,
    })
    if (!finalizerClaim) {
      console.log(
        `[Queue] Duplicate S12 snapshot finalizer suppressed date=${triggerTime} run_id=${runId} status=${finalizerState.row.status}`,
      )
      return
    }
    try {
      await continuePostScreenerPipeline(env, deps, triggerTime, runId, true)
      await markPipelineStage(env.DB, {
        businessDate: triggerTime,
        stage: finalizerStage,
        status: 'success',
      })
    } catch (error) {
      await markPipelineStage(env.DB, {
        businessDate: triggerTime,
        stage: finalizerStage,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    return
  }

  if (msg.type === 's12_replay_backfill_chunk') {
    const triggerTime = msg.triggerTime
    const runId = msg.runId || `s12-replay-backfill-${triggerTime}-${Date.now()}`
    const offset = Math.max(0, Number.isFinite(msg.cursor) ? Number(msg.cursor) : 0)
    const requestedScope = (msg as any).replayScope
    const requestedMaturityDate = String((msg as any).maturityAsOfDate ?? '').slice(0, 10)
    const maturityAsOfDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedMaturityDate)
      ? requestedMaturityDate
      : new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    const requestedStatusRunDate = String((msg as any).statusRunDate ?? '').slice(0, 10)
    const statusRunDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedStatusRunDate)
      ? requestedStatusRunDate
      : triggerTime
    const replayScope = requestedScope === 'fusion_snapshot_missing'
      ? 'fusion_snapshot_missing'
      : requestedScope === 'fusion_snapshot_structure'
        ? 'fusion_snapshot_structure'
        : requestedScope === 'signed_eligible_repair'
          ? 'signed_eligible_repair'
        : 'l0'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
      console.log(`[Queue] Invalid S12 replay backfill date ${triggerTime}, skipping.`)
      return
    }
    const {
      loadFusionSnapshotMissingReplaySymbols,
      loadFusionSnapshotReplayCoverage,
      loadFusionSnapshotSymbols,
      loadSignedEligibleRepairSymbolsByHistoricalDate,
      isS12ReplayRetryableUnavailableReason,
      runS12HistoricalReplayForDate,
    } = await import('./s12ReplayTradeOutcome')
    if (replayScope === 'fusion_snapshot_structure') {
      const symbols = await loadFusionSnapshotSymbols(env.DB, triggerTime, UPDATE_BATCH_SIZE, offset)
      const { runS12CandidateStructureSnapshots } = await import('./s12CandidateStructureSnapshots')
      const snapshotResult = await runS12CandidateStructureSnapshots(env, triggerTime, {
        limit: UPDATE_BATCH_SIZE,
        symbols,
      })
      const nextOffset = offset + symbols.length
      const hasMore = symbols.length === UPDATE_BATCH_SIZE
      await logSchedulerResult(env.KV, 's12-structure-snapshot', {
        status: hasMore ? 'running' : 'success',
        summary: `historical canonical cohort date=${triggerTime} offset=${offset} attempted=${snapshotResult.attempted} persisted=${snapshotResult.persisted} ready=${snapshotResult.ready} setup=${snapshotResult.setup_only} skipped=${snapshotResult.skipped} errors=${snapshotResult.errors} ${hasMore ? 'queued_next=1' : 'complete=1'}`,
        duration_ms: 0,
        run_id: runId,
        run_date: triggerTime,
      }, env)
      if (hasMore) {
        await env.UPDATE_QUEUE.send({
          type: 's12_replay_backfill_chunk',
          cursor: nextOffset,
          triggerTime,
          runId,
          replayScope,
          statusRunDate,
        } as any)
      }
      return
    }
    const dynamicCohortScope = replayScope === 'fusion_snapshot_missing' || replayScope === 'signed_eligible_repair'
    const cohortSymbols = replayScope === 'fusion_snapshot_missing'
      ? await loadFusionSnapshotMissingReplaySymbols(env.DB, triggerTime, maturityAsOfDate)
      : replayScope === 'signed_eligible_repair'
        ? await loadSignedEligibleRepairSymbolsByHistoricalDate(env.DB, triggerTime)
        : undefined
    let result
    try {
      result = await runS12HistoricalReplayForDate(env, triggerTime, {
        limit: S12_REPLAY_QUEUE_CHUNK_SIZE,
        offset: dynamicCohortScope ? 0 : offset,
        persist: true,
        symbols: cohortSymbols,
        maturityAsOfDate,
        signedEligibleRepair: replayScope === 'signed_eligible_repair',
        persistUnavailableOutcomes: dynamicCohortScope,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.startsWith('s12_research_lease_busy:')) throw error
      const leaseRetryAttempt = Math.max(0, Number((msg as any).leaseRetryAttempt ?? 0))
      if (leaseRetryAttempt >= S12_REPLAY_LEASE_RETRY_MAX_ATTEMPTS) {
        await logSchedulerResult(env.KV, 's12-replay-backfill', {
          status: 'error',
          summary: `date=${triggerTime} scope=${replayScope} research lease remained busy after ${leaseRetryAttempt} deferred attempts`,
          duration_ms: 0,
          run_id: runId,
          run_date: statusRunDate,
        }, env)
        return
      }
      const delaySeconds = s12ReplayLeaseRetryDelaySeconds(triggerTime, leaseRetryAttempt + 1)
      await env.UPDATE_QUEUE.send({
        ...(msg as any),
        leaseRetryAttempt: leaseRetryAttempt + 1,
      }, { delaySeconds } as any)
      await logSchedulerResult(env.KV, 's12-replay-backfill', {
        status: 'running',
        summary: `date=${triggerTime} scope=${replayScope} research lease busy; deferred_attempt=${leaseRetryAttempt + 1}/${S12_REPLAY_LEASE_RETRY_MAX_ATTEMPTS} delay_seconds=${delaySeconds}`,
        duration_ms: 0,
        run_id: runId,
        run_date: statusRunDate,
      }, env)
      return
    }
    const nextOffset = dynamicCohortScope
      ? 0
      : offset + Math.max(0, Number(result.attempted ?? 0))
    const remainingReplaySymbols = replayScope === 'fusion_snapshot_missing'
      ? await loadFusionSnapshotMissingReplaySymbols(env.DB, triggerTime, maturityAsOfDate)
      : replayScope === 'signed_eligible_repair'
        ? await loadSignedEligibleRepairSymbolsByHistoricalDate(env.DB, triggerTime)
        : []
    const terminalDataSourceReason = String(result.terminal_data_source_reason ?? '').trim()
    const retryableUnavailableOnly = replayScope === 'fusion_snapshot_missing'
      && Number(result.attempted ?? 0) > 0
      && result.outcomes.length > 0
      && result.outcomes.every((outcome) => (
        outcome.observation_kind === 'unavailable'
        && isS12ReplayRetryableUnavailableReason(outcome.status_reason)
      ))
    const dynamicCohortStalled = dynamicCohortScope
      && !retryableUnavailableOnly
      && !terminalDataSourceReason
      && Number(cohortSymbols?.length ?? 0) > 0
      && remainingReplaySymbols.length >= Number(cohortSymbols?.length ?? 0)
      && (
        replayScope === 'signed_eligible_repair'
        || Number(result.persisted ?? 0) === 0
      )
    const hasMore = terminalDataSourceReason || dynamicCohortStalled || retryableUnavailableOnly
      ? false
      : dynamicCohortScope
      ? remainingReplaySymbols.length > 0 && Number(result.persisted ?? 0) > 0
      : nextOffset < Number(result.l0_symbols ?? 0) && Number(result.attempted ?? 0) > 0
    if (terminalDataSourceReason || dynamicCohortStalled) {
      const failureReason = terminalDataSourceReason
        ? `terminal market-data source error: ${terminalDataSourceReason}`
        : replayScope === 'signed_eligible_repair'
          ? `signed replay made no strict-eligible lineage progress remaining=${remainingReplaySymbols.length}`
          : `dynamic replay made no persistence progress remaining=${remainingReplaySymbols.length}`
      await logSchedulerResult(env.KV, 's12-replay-backfill', {
        status: 'error',
        summary: `date=${triggerTime} scope=${replayScope} offset=${offset} ${failureReason}; requeue=0`,
        duration_ms: 0,
        run_id: runId,
        run_date: statusRunDate,
      }, env)
      if (replayScope === 'fusion_snapshot_missing') {
        const { recordAllocatorEvLifecycle } = await import('./allocatorEvDailyLifecycle')
        await recordAllocatorEvLifecycle(env.DB, {
          businessDate: triggerTime,
          state: 'error',
          replayRows: Math.max(0, Number(result.persisted ?? 0)),
          replayMaturityAsOfDate: maturityAsOfDate,
          upstreamRunId: runId,
          lastError: failureReason,
        })
      }
      return
    }
    const replayCoverage = replayScope === 'fusion_snapshot_missing' && !hasMore
      ? await loadFusionSnapshotReplayCoverage(env.DB, triggerTime, maturityAsOfDate)
      : null
    const replayClosed = !hasMore && (
      replayScope === 'signed_eligible_repair'
        ? remainingReplaySymbols.length === 0
        : replayScope !== 'fusion_snapshot_missing' || (
          remainingReplaySymbols.length === 0
          && replayCoverage !== null
          && replayCoverage.totalSnapshotRows > 0
          && replayCoverage.replayRows === replayCoverage.totalSnapshotRows
          && replayCoverage.matureMissingRows === 0
          && replayCoverage.pendingMaturityRows === 0
        )
    )
    const summary = [
      `s12_replay_backfill signal_date=${result.signal_date}`,
      `execution_dates=${result.execution_dates.join(',') || 'none'}`,
      `unresolved_execution_dates=${result.unresolved_execution_dates}`,
      `scope=${replayScope}`,
      `offset=${offset}`,
      `next_offset=${nextOffset}`,
      `l0=${result.l0_symbols}`,
      `attempted=${result.attempted}`,
      `executed=${result.executed}`,
      `setup_only=${result.setup_only}`,
      `skipped=${result.skipped}`,
      `persisted=${result.persisted}`,
      `retryable_unavailable_only=${retryableUnavailableOnly ? 1 : 0}`,
      replayCoverage
        ? `coverage=${replayCoverage.replayRows}/${replayCoverage.totalSnapshotRows}`
          + ` mature_missing=${replayCoverage.matureMissingRows}`
          + ` pending_maturity=${replayCoverage.pendingMaturityRows}`
        : 'coverage=not_applicable',
      hasMore
        ? 'queued_next=1'
        : replayClosed
          ? 'complete=1'
          : replayCoverage && replayCoverage.pendingMaturityRows > 0
            ? `waiting_for_replay_maturity=${replayCoverage.pendingMaturityRows}`
            : `waiting_for_replay_data=${remainingReplaySymbols.length}`,
    ].join(' ')
    await logSchedulerResult(env.KV, 's12-replay-backfill', {
      status: hasMore || !replayClosed ? 'running' : 'success',
      summary,
      duration_ms: 0,
      run_id: runId,
      run_date: statusRunDate,
    }, env)
    if (hasMore) {
      await env.UPDATE_QUEUE.send({
        type: 's12_replay_backfill_chunk',
        cursor: nextOffset,
        triggerTime,
        runId,
        replayScope,
        maturityAsOfDate,
        statusRunDate,
      } as any)
    } else if (replayClosed) {
      const { recordAllocatorEvLifecycle } = await import('./allocatorEvDailyLifecycle')
      await recordAllocatorEvLifecycle(env.DB, {
        businessDate: triggerTime,
        state: 'replay_complete',
        replayRows: replayCoverage?.replayRows ?? 0,
        replayMaturityAsOfDate: maturityAsOfDate,
        upstreamRunId: runId,
      })
    } else {
      const { recordAllocatorEvLifecycle } = await import('./allocatorEvDailyLifecycle')
      await recordAllocatorEvLifecycle(env.DB, {
        businessDate: triggerTime,
        state: replayCoverage && replayCoverage.pendingMaturityRows > 0
          ? 'replay_pending_maturity'
          : 'replay_enqueued',
        replayRows: replayCoverage?.replayRows ?? 0,
        replayMaturityAsOfDate: maturityAsOfDate,
        upstreamRunId: runId,
        lastError: replayCoverage && replayCoverage.pendingMaturityRows > 0
          ? `waiting for stock-specific five-session maturity symbols=${replayCoverage.pendingMaturityRows}`
          : retryableUnavailableOnly
            ? `waiting for retryable S12 lifecycle bars symbols=${remainingReplaySymbols.length}`
          : `waiting for complete five-session replay data symbols=${remainingReplaySymbols.length}`,
      })
    }
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
