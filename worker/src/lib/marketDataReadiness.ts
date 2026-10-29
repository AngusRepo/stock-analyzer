import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { loadCoreStockIdentitiesByIds } from './stockIdentityMarketBridge'
import { writeSystemLog } from './notify'

export interface MarketDataReadinessStats {
  targetDate: string
  priceLatestDate: string | null
  priceRowsOnLatest: number
  priceTwseRowsOnLatest?: number
  priceOtcRowsOnLatest?: number
  // Coverage baseline: the fullest of the sessions before priceLatestDate (see baselineSessionStats).
  priceBaselineDate?: string | null
  priceRowsOnBaseline?: number
  chipLatestDate: string | null
  chipRowsOnLatest: number
  marginLatestDate?: string | null
  marginRowsOnLatest?: number
  // Only loaded when margin is on the target date; late-published margin can land partially.
  marginBaselineDate?: string | null
  marginRowsOnBaseline?: number
  indicatorLatestDate?: string | null
  indicatorRowsOnLatest?: number
}

export interface MarketDataReadinessOptions {
  minPriceRows?: number
  minPriceTwseRows?: number
  minPriceOtcRows?: number
  minChipRows?: number
  minMarginRows?: number
  minIndicatorRows?: number
  requireIndicators?: boolean
  requireMargin?: boolean
  // Warn-only: latest-session rows / baseline-session rows below this ratio (HL1-4#c).
  minPriceCoverageRatio?: number
  // Warn-only, same rule for margin_data on the target date (HL3-4#a).
  minMarginCoverageRatio?: number
}

export interface MarketDataReadinessResult {
  ok: boolean
  summary: string
  errors: string[]
  // Coverage warnings never change `ok`; they are reported in the summary and alerted.
  warnings: string[]
  stats: MarketDataReadinessStats
}

const DEFAULT_MIN_PRICE_ROWS = 1000
const DEFAULT_MIN_PRICE_TWSE_ROWS = 900
const DEFAULT_MIN_PRICE_OTC_ROWS = 700
const DEFAULT_MIN_CHIP_ROWS = 1000
const DEFAULT_MIN_MARGIN_ROWS = 1500
const DEFAULT_MIN_INDICATOR_ROWS = 1000
// Day-to-day price row counts move by <1% (10/20–10/28: 2191–2204); override with MARKET_DATA_PRICE_COVERAGE_MIN_RATIO.
const DEFAULT_MIN_PRICE_COVERAGE_RATIO = 0.98
// margin_data rows per session are as stable (10/20–10/28: 2101–2102); override with MARKET_DATA_MARGIN_COVERAGE_MIN_RATIO.
const DEFAULT_MIN_MARGIN_COVERAGE_RATIO = 0.98
// The baseline is the fullest of this many previous sessions, so a loss keeps warning for that many sessions.
const DEFAULT_COVERAGE_BASELINE_SESSIONS = 5

function normalizeRows(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function coverageWarning(
  label: string,
  latestDate: string | null | undefined,
  latestRows: number | undefined,
  baselineDate: string | null | undefined,
  baselineRows: number | undefined,
  minRatio: number,
): string | null {
  const baseline = normalizeRows(baselineRows)
  if (!latestDate || !baselineDate || baseline <= 0 || !(minRatio > 0)) return null
  const ratio = normalizeRows(latestRows) / baseline
  if (ratio >= minRatio) return null
  return `${label} coverage=${normalizeRows(latestRows)}/${baseline} (${ratio.toFixed(3)} < ${minRatio}) ` +
    `${latestDate} vs ${baselineDate}`
}

function envRatio(env: Partial<Bindings>, name: string, fallback: number): number {
  const raw = (env as Record<string, unknown>)[name]
  const value = raw == null || raw === '' ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback
}

export function evaluateMarketDataReadiness(
  stats: MarketDataReadinessStats,
  options: MarketDataReadinessOptions = {},
): MarketDataReadinessResult {
  const minPriceRows = options.minPriceRows ?? DEFAULT_MIN_PRICE_ROWS
  const minPriceTwseRows = options.minPriceTwseRows ?? DEFAULT_MIN_PRICE_TWSE_ROWS
  const minPriceOtcRows = options.minPriceOtcRows ?? DEFAULT_MIN_PRICE_OTC_ROWS
  const minChipRows = options.minChipRows ?? DEFAULT_MIN_CHIP_ROWS
  const minMarginRows = options.minMarginRows ?? DEFAULT_MIN_MARGIN_ROWS
  const minIndicatorRows = options.minIndicatorRows ?? DEFAULT_MIN_INDICATOR_ROWS
  const requireIndicators = options.requireIndicators ?? true
  const requireMargin = options.requireMargin ?? false
  const errors: string[] = []

  if (stats.priceLatestDate !== stats.targetDate) {
    errors.push(`price latest=${stats.priceLatestDate ?? 'none'} expected=${stats.targetDate}`)
  }
  if (normalizeRows(stats.priceRowsOnLatest) < minPriceRows) {
    errors.push(`price rows=${stats.priceRowsOnLatest}/${minPriceRows}`)
  }
  if (stats.priceTwseRowsOnLatest !== undefined && normalizeRows(stats.priceTwseRowsOnLatest) < minPriceTwseRows) {
    errors.push(`TWSE price rows=${stats.priceTwseRowsOnLatest}/${minPriceTwseRows}`)
  }
  if (stats.priceOtcRowsOnLatest !== undefined && normalizeRows(stats.priceOtcRowsOnLatest) < minPriceOtcRows) {
    errors.push(`OTC price rows=${stats.priceOtcRowsOnLatest}/${minPriceOtcRows}`)
  }
  if (stats.chipLatestDate !== stats.targetDate) {
    errors.push(`chip latest=${stats.chipLatestDate ?? 'none'} expected=${stats.targetDate}`)
  }
  if (normalizeRows(stats.chipRowsOnLatest) < minChipRows) {
    errors.push(`chip rows=${stats.chipRowsOnLatest}/${minChipRows}`)
  }
  if (requireMargin && stats.marginLatestDate !== stats.targetDate) {
    errors.push(`margin latest=${stats.marginLatestDate ?? 'none'} expected=${stats.targetDate}`)
  }
  if (requireMargin && normalizeRows(stats.marginRowsOnLatest) < minMarginRows) {
    errors.push(`margin rows=${stats.marginRowsOnLatest ?? 0}/${minMarginRows}`)
  }
  if (requireIndicators && stats.indicatorLatestDate !== undefined && stats.indicatorLatestDate !== stats.targetDate) {
    errors.push(`indicator latest=${stats.indicatorLatestDate ?? 'none'} expected=${stats.targetDate}`)
  }
  if (requireIndicators && stats.indicatorRowsOnLatest !== undefined && normalizeRows(stats.indicatorRowsOnLatest) < minIndicatorRows) {
    errors.push(`indicator rows=${stats.indicatorRowsOnLatest}/${minIndicatorRows}`)
  }

  const warnings = [
    coverageWarning('price', stats.priceLatestDate, stats.priceRowsOnLatest,
      stats.priceBaselineDate, stats.priceRowsOnBaseline,
      options.minPriceCoverageRatio ?? DEFAULT_MIN_PRICE_COVERAGE_RATIO),
    stats.marginLatestDate === stats.targetDate
      ? coverageWarning('margin', stats.marginLatestDate, stats.marginRowsOnLatest,
        stats.marginBaselineDate, stats.marginRowsOnBaseline,
        options.minMarginCoverageRatio ?? DEFAULT_MIN_MARGIN_COVERAGE_RATIO)
      : null,
  ].filter((warning): warning is string => warning !== null)

  return {
    ok: errors.length === 0,
    summary: (errors.length
      ? `market data not ready: ${errors.join('; ')}`
      : `market data ready for ${stats.targetDate}: price=${stats.priceRowsOnLatest}` +
        (stats.priceTwseRowsOnLatest !== undefined ? ` TWSE=${stats.priceTwseRowsOnLatest}` : '') +
        (stats.priceOtcRowsOnLatest !== undefined ? ` OTC=${stats.priceOtcRowsOnLatest}` : '') +
        `, chip=${stats.chipRowsOnLatest}` +
        (stats.marginRowsOnLatest !== undefined ? `, margin=${stats.marginRowsOnLatest}` : '') +
        (stats.indicatorRowsOnLatest !== undefined ? `, indicators=${stats.indicatorRowsOnLatest}` : '')) +
      // Failure text stays unchanged: retry classifiers match on it.
      (warnings.length && !errors.length ? `; coverage_warn: ${warnings.join('; ')}` : ''),
    errors,
    warnings,
    stats,
  }
}

async function latestTableStats(db: D1Database, table: string): Promise<{ latestDate: string | null; rowsOnLatest: number }> {
  const latest = await db.prepare(`SELECT MAX(date) AS latest_date FROM ${table}`).first<{ latest_date: string | null }>()
  const latestDate = latest?.latest_date ?? null
  if (!latestDate) return { latestDate: null, rowsOnLatest: 0 }
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE date = ?`).bind(latestDate).first<{ count: number }>()
  return { latestDate, rowsOnLatest: normalizeRows(row?.count) }
}

async function targetAwareTableStats(
  db: D1Database,
  table: string,
  targetDate: string,
): Promise<{ latestDate: string | null; rowsOnLatest: number }> {
  const target = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE date = ?`)
    .bind(targetDate)
    .first<{ count: number }>()
  const targetRows = normalizeRows(target?.count)
  if (targetRows > 0) return { latestDate: targetDate, rowsOnLatest: targetRows }
  return latestTableStats(db, table)
}

// Report-only baseline: the session with the most rows among the `sessions` before latestDate.
// A failed lookup yields no coverage warning and never blocks readiness.
async function baselineSessionStats(
  db: D1Database,
  table: string,
  latestDate: string | null,
  sessions: number,
): Promise<{ baselineDate: string | null; rowsOnBaseline: number }> {
  if (!latestDate) return { baselineDate: null, rowsOnBaseline: 0 }
  try {
    const row = await db.prepare(`
      SELECT date, COUNT(*) AS count FROM ${table}
       WHERE date IN (SELECT DISTINCT date FROM ${table} WHERE date < ? ORDER BY date DESC LIMIT ?)
       GROUP BY date ORDER BY count DESC, date DESC LIMIT 1
    `).bind(latestDate, sessions).first<{ date: string | null; count: number }>()
    return { baselineDate: row?.date ?? null, rowsOnBaseline: normalizeRows(row?.count) }
  } catch (error) {
    console.warn(`[MarketDataReadiness] baseline ${table} lookup failed:`, error)
    return { baselineDate: null, rowsOnBaseline: 0 }
  }
}

async function latestPriceSegmentStats(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  latestDate: string | null,
): Promise<{ twseRows: number; otcRows: number }> {
  if (!latestDate) return { twseRows: 0, otcRows: 0 }
  const marketDb = databaseForDataDomain(env, 'market')
  const { results } = await marketDb.prepare(`
    SELECT stock_id
      FROM stock_prices
     WHERE date = ?
  `).bind(latestDate).all<{ stock_id: number | string }>()
  const ids = (results ?? []).map((row) => Number(row.stock_id)).filter(Number.isSafeInteger)
  const identities = await loadCoreStockIdentitiesByIds(env, ids)
  let twseRows = 0
  let otcRows = 0
  for (const row of results ?? []) {
    const market = String(identities.get(Number(row.stock_id))?.market ?? '').trim().toUpperCase()
    if (market === 'TWSE') twseRows += 1
    else if (market === 'OTC') otcRows += 1
  }
  return { twseRows, otcRows }
}

export async function loadMarketDataReadinessStats(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  targetDate: string,
): Promise<MarketDataReadinessStats> {
  const marketDb = databaseForDataDomain(env, 'market')
  const [price, chip, margin, indicators] = await Promise.all([
    targetAwareTableStats(marketDb, 'stock_prices', targetDate),
    targetAwareTableStats(marketDb, 'chip_data', targetDate),
    targetAwareTableStats(marketDb, 'margin_data', targetDate),
    targetAwareTableStats(marketDb, 'technical_indicators', targetDate),
  ])
  const rawSessions = Number((env as Record<string, unknown>).MARKET_DATA_COVERAGE_BASELINE_SESSIONS)
  const sessions = Number.isInteger(rawSessions) && rawSessions >= 1 && rawSessions <= 20
    ? rawSessions : DEFAULT_COVERAGE_BASELINE_SESSIONS
  const [priceSegments, priceBaseline, marginBaseline] = await Promise.all([
    latestPriceSegmentStats(env, price.latestDate),
    baselineSessionStats(marketDb, 'stock_prices', price.latestDate, sessions),
    baselineSessionStats(marketDb, 'margin_data', margin.latestDate === targetDate ? targetDate : null, sessions),
  ])
  return {
    targetDate,
    priceLatestDate: price.latestDate,
    priceRowsOnLatest: price.rowsOnLatest,
    priceTwseRowsOnLatest: priceSegments.twseRows,
    priceOtcRowsOnLatest: priceSegments.otcRows,
    priceBaselineDate: priceBaseline.baselineDate,
    priceRowsOnBaseline: priceBaseline.rowsOnBaseline,
    chipLatestDate: chip.latestDate,
    chipRowsOnLatest: chip.rowsOnLatest,
    marginLatestDate: margin.latestDate,
    marginRowsOnLatest: margin.rowsOnLatest,
    marginBaselineDate: marginBaseline.baselineDate,
    marginRowsOnBaseline: marginBaseline.rowsOnBaseline,
    indicatorLatestDate: indicators.latestDate,
    indicatorRowsOnLatest: indicators.rowsOnLatest,
  }
}

export async function assertMarketDataReady(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  targetDate: string,
  options: MarketDataReadinessOptions = {},
): Promise<MarketDataReadinessResult> {
  const stats = await loadMarketDataReadinessStats(env, targetDate)
  const result = evaluateMarketDataReadiness(stats, {
    ...options,
    minPriceCoverageRatio: options.minPriceCoverageRatio
      ?? envRatio(env, 'MARKET_DATA_PRICE_COVERAGE_MIN_RATIO', DEFAULT_MIN_PRICE_COVERAGE_RATIO),
    minMarginCoverageRatio: options.minMarginCoverageRatio
      ?? envRatio(env, 'MARKET_DATA_MARGIN_COVERAGE_MIN_RATIO', DEFAULT_MIN_MARGIN_COVERAGE_RATIO),
  })
  if (!result.ok) {
    throw new Error(result.summary)
  }
  // Only data accepted as ready can shrink the universe silently, so only that is alerted.
  if (result.warnings.length) await alertMarketDataCoverage(env, targetDate, result.warnings)
  return result
}

/**
 * One alert per business date and warning kind across all readiness callers; never blocks readiness.
 * The alert is the ops system_logs record plus the console line; no notify channel is used.
 */
async function alertMarketDataCoverage(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  targetDate: string,
  warnings: string[],
): Promise<void> {
  console.warn(`[MarketDataReadiness] coverage_warn ${targetDate}: ${warnings.join('; ')}`)
  const kinds = [...new Set(warnings.map((warning) => warning.split(' ')[0]))].sort().join(',')
  const dedupKey = `cron:alert:market-data-coverage:${targetDate}:${kinds}`
  // A failed dedup read counts as not yet recorded, so it never costs the record.
  const claimed = await Promise.resolve().then(() => env.KV?.get(dedupKey)).catch(() => null)
  if (claimed) return
  try {
    // Record before the dedup claim. writeSystemLog swallows insert errors, so a failed insert still claims the date.
    await writeSystemLog(databaseForDataDomain(env, 'ops'), 'warn', 'market-data-coverage',
      `market data coverage below the recent baseline for ${targetDate}: ${warnings.join('; ')}`,
      { target_date: targetDate, warnings, blocking: false })
    await env.KV?.put(dedupKey, '1', { expirationTtl: 86400 })
  } catch {
    // Alerting must never block readiness.
  }
}
