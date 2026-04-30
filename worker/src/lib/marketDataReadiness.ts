export interface MarketDataReadinessStats {
  targetDate: string
  priceLatestDate: string | null
  priceRowsOnLatest: number
  chipLatestDate: string | null
  chipRowsOnLatest: number
}

export interface MarketDataReadinessOptions {
  minPriceRows?: number
  minChipRows?: number
}

export interface MarketDataReadinessResult {
  ok: boolean
  summary: string
  errors: string[]
  stats: MarketDataReadinessStats
}

const DEFAULT_MIN_PRICE_ROWS = 1000
const DEFAULT_MIN_CHIP_ROWS = 1000

function normalizeRows(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function evaluateMarketDataReadiness(
  stats: MarketDataReadinessStats,
  options: MarketDataReadinessOptions = {},
): MarketDataReadinessResult {
  const minPriceRows = options.minPriceRows ?? DEFAULT_MIN_PRICE_ROWS
  const minChipRows = options.minChipRows ?? DEFAULT_MIN_CHIP_ROWS
  const errors: string[] = []

  if (stats.priceLatestDate !== stats.targetDate) {
    errors.push(`price latest=${stats.priceLatestDate ?? 'none'} expected=${stats.targetDate}`)
  }
  if (normalizeRows(stats.priceRowsOnLatest) < minPriceRows) {
    errors.push(`price rows=${stats.priceRowsOnLatest}/${minPriceRows}`)
  }
  if (stats.chipLatestDate !== stats.targetDate) {
    errors.push(`chip latest=${stats.chipLatestDate ?? 'none'} expected=${stats.targetDate}`)
  }
  if (normalizeRows(stats.chipRowsOnLatest) < minChipRows) {
    errors.push(`chip rows=${stats.chipRowsOnLatest}/${minChipRows}`)
  }

  return {
    ok: errors.length === 0,
    summary: errors.length
      ? `market data not ready: ${errors.join('; ')}`
      : `market data ready for ${stats.targetDate}: price=${stats.priceRowsOnLatest}, chip=${stats.chipRowsOnLatest}`,
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

export async function loadMarketDataReadinessStats(
  db: D1Database,
  targetDate: string,
): Promise<MarketDataReadinessStats> {
  const [price, chip] = await Promise.all([
    latestTableStats(db, 'stock_prices'),
    latestTableStats(db, 'chip_data'),
  ])
  return {
    targetDate,
    priceLatestDate: price.latestDate,
    priceRowsOnLatest: price.rowsOnLatest,
    chipLatestDate: chip.latestDate,
    chipRowsOnLatest: chip.rowsOnLatest,
  }
}

export async function assertMarketDataReady(
  db: D1Database,
  targetDate: string,
  options: MarketDataReadinessOptions = {},
): Promise<MarketDataReadinessResult> {
  const stats = await loadMarketDataReadinessStats(db, targetDate)
  const result = evaluateMarketDataReadiness(stats, options)
  if (!result.ok) {
    throw new Error(result.summary)
  }
  return result
}
