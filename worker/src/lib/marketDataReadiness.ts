import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { loadCoreStockIdentitiesByIds } from './stockIdentityMarketBridge'

export interface MarketDataReadinessStats {
  targetDate: string
  priceLatestDate: string | null
  priceRowsOnLatest: number
  priceTwseRowsOnLatest?: number
  priceOtcRowsOnLatest?: number
  chipLatestDate: string | null
  chipRowsOnLatest: number
  indicatorLatestDate?: string | null
  indicatorRowsOnLatest?: number
}

export interface MarketDataReadinessOptions {
  minPriceRows?: number
  minPriceTwseRows?: number
  minPriceOtcRows?: number
  minChipRows?: number
  minIndicatorRows?: number
  requireIndicators?: boolean
}

export interface MarketDataReadinessResult {
  ok: boolean
  summary: string
  errors: string[]
  stats: MarketDataReadinessStats
}

const DEFAULT_MIN_PRICE_ROWS = 1000
const DEFAULT_MIN_PRICE_TWSE_ROWS = 900
const DEFAULT_MIN_PRICE_OTC_ROWS = 700
const DEFAULT_MIN_CHIP_ROWS = 1000
const DEFAULT_MIN_INDICATOR_ROWS = 1000

function normalizeRows(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function evaluateMarketDataReadiness(
  stats: MarketDataReadinessStats,
  options: MarketDataReadinessOptions = {},
): MarketDataReadinessResult {
  const minPriceRows = options.minPriceRows ?? DEFAULT_MIN_PRICE_ROWS
  const minPriceTwseRows = options.minPriceTwseRows ?? DEFAULT_MIN_PRICE_TWSE_ROWS
  const minPriceOtcRows = options.minPriceOtcRows ?? DEFAULT_MIN_PRICE_OTC_ROWS
  const minChipRows = options.minChipRows ?? DEFAULT_MIN_CHIP_ROWS
  const minIndicatorRows = options.minIndicatorRows ?? DEFAULT_MIN_INDICATOR_ROWS
  const requireIndicators = options.requireIndicators ?? true
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
  if (requireIndicators && stats.indicatorLatestDate !== undefined && stats.indicatorLatestDate !== stats.targetDate) {
    errors.push(`indicator latest=${stats.indicatorLatestDate ?? 'none'} expected=${stats.targetDate}`)
  }
  if (requireIndicators && stats.indicatorRowsOnLatest !== undefined && normalizeRows(stats.indicatorRowsOnLatest) < minIndicatorRows) {
    errors.push(`indicator rows=${stats.indicatorRowsOnLatest}/${minIndicatorRows}`)
  }

  return {
    ok: errors.length === 0,
    summary: errors.length
      ? `market data not ready: ${errors.join('; ')}`
      : `market data ready for ${stats.targetDate}: price=${stats.priceRowsOnLatest}` +
        (stats.priceTwseRowsOnLatest !== undefined ? ` TWSE=${stats.priceTwseRowsOnLatest}` : '') +
        (stats.priceOtcRowsOnLatest !== undefined ? ` OTC=${stats.priceOtcRowsOnLatest}` : '') +
        `, chip=${stats.chipRowsOnLatest}` +
        (stats.indicatorRowsOnLatest !== undefined ? `, indicators=${stats.indicatorRowsOnLatest}` : ''),
    errors,
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
  const [price, chip, indicators] = await Promise.all([
    targetAwareTableStats(marketDb, 'stock_prices', targetDate),
    targetAwareTableStats(marketDb, 'chip_data', targetDate),
    targetAwareTableStats(marketDb, 'technical_indicators', targetDate),
  ])
  const priceSegments = await latestPriceSegmentStats(env, price.latestDate)
  return {
    targetDate,
    priceLatestDate: price.latestDate,
    priceRowsOnLatest: price.rowsOnLatest,
    priceTwseRowsOnLatest: priceSegments.twseRows,
    priceOtcRowsOnLatest: priceSegments.otcRows,
    chipLatestDate: chip.latestDate,
    chipRowsOnLatest: chip.rowsOnLatest,
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
  const result = evaluateMarketDataReadiness(stats, options)
  if (!result.ok) {
    throw new Error(result.summary)
  }
  return result
}
