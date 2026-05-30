export interface MarketDataReadinessStats {
  targetDate: string
  priceLatestDate: string | null
  priceRowsOnLatest: number
  priceTwseRowsOnLatest?: number
  priceOtcRowsOnLatest?: number
  chipLatestDate: string | null
  chipRowsOnLatest: number
  chipSourceTable?: string
  institutionalAmountLatestDate?: string | null
  institutionalAmountRowsOnLatest?: number
  indicatorLatestDate?: string | null
  indicatorRowsOnLatest?: number
}

export interface MarketDataReadinessOptions {
  minPriceRows?: number
  minPriceTwseRows?: number
  minPriceOtcRows?: number
  minChipRows?: number
  minInstitutionalAmountRows?: number
  minIndicatorRows?: number
  requireIndicators?: boolean
  requireInstitutionalAmount?: boolean
  allowHistoricalLatestAfterTarget?: boolean
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
const DEFAULT_MIN_INSTITUTIONAL_AMOUNT_ROWS = 8
const DEFAULT_MIN_INDICATOR_ROWS = 1000

function normalizeRows(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function dateIsReadyForTarget(actualDate: string | null | undefined, targetDate: string, allowHistorical: boolean): boolean {
  if (actualDate === targetDate) return true
  return Boolean(allowHistorical && actualDate && actualDate > targetDate)
}

export function evaluateMarketDataReadiness(
  stats: MarketDataReadinessStats,
  options: MarketDataReadinessOptions = {},
): MarketDataReadinessResult {
  const minPriceRows = options.minPriceRows ?? DEFAULT_MIN_PRICE_ROWS
  const minPriceTwseRows = options.minPriceTwseRows ?? DEFAULT_MIN_PRICE_TWSE_ROWS
  const minPriceOtcRows = options.minPriceOtcRows ?? DEFAULT_MIN_PRICE_OTC_ROWS
  const minChipRows = options.minChipRows ?? DEFAULT_MIN_CHIP_ROWS
  const minInstitutionalAmountRows = options.minInstitutionalAmountRows ?? DEFAULT_MIN_INSTITUTIONAL_AMOUNT_ROWS
  const minIndicatorRows = options.minIndicatorRows ?? DEFAULT_MIN_INDICATOR_ROWS
  const requireIndicators = options.requireIndicators ?? true
  const requireInstitutionalAmount = Boolean(options.requireInstitutionalAmount)
  const allowHistorical = Boolean(options.allowHistoricalLatestAfterTarget)
  const errors: string[] = []

  if (!dateIsReadyForTarget(stats.priceLatestDate, stats.targetDate, allowHistorical)) {
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
  if (!dateIsReadyForTarget(stats.chipLatestDate, stats.targetDate, allowHistorical)) {
    errors.push(`chip latest=${stats.chipLatestDate ?? 'none'} expected=${stats.targetDate}`)
  }
  if (normalizeRows(stats.chipRowsOnLatest) < minChipRows) {
    errors.push(`chip rows=${stats.chipRowsOnLatest}/${minChipRows}`)
  }
  if (
    requireInstitutionalAmount &&
    !dateIsReadyForTarget(stats.institutionalAmountLatestDate, stats.targetDate, allowHistorical)
  ) {
    errors.push(`institutional_amount latest=${stats.institutionalAmountLatestDate ?? 'none'} expected=${stats.targetDate}`)
  }
  if (
    requireInstitutionalAmount &&
    normalizeRows(stats.institutionalAmountRowsOnLatest) < minInstitutionalAmountRows
  ) {
    errors.push(`institutional_amount rows=${stats.institutionalAmountRowsOnLatest ?? 0}/${minInstitutionalAmountRows}`)
  }
  if (
    requireIndicators &&
    stats.indicatorLatestDate !== undefined &&
    !dateIsReadyForTarget(stats.indicatorLatestDate, stats.targetDate, allowHistorical)
  ) {
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
        (stats.chipSourceTable ? ` source=${stats.chipSourceTable}` : '') +
        (stats.institutionalAmountRowsOnLatest !== undefined ? `, institutional_amount=${stats.institutionalAmountRowsOnLatest}` : '') +
        (stats.indicatorRowsOnLatest !== undefined ? `, indicators=${stats.indicatorRowsOnLatest}` : ''),
    errors,
    stats,
  }
}

async function latestTableStats(
  db: D1Database,
  table: string,
  targetDate?: string,
): Promise<{ latestDate: string | null; rowsOnLatest: number }> {
  const latest = await db.prepare(`SELECT MAX(date) AS latest_date FROM ${table}`).first<{ latest_date: string | null }>()
  const latestDate = latest?.latest_date ?? null
  if (!latestDate) return { latestDate: null, rowsOnLatest: 0 }
  const countDate = targetDate && latestDate >= targetDate ? targetDate : latestDate
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE date = ?`).bind(countDate).first<{ count: number }>()
  return { latestDate, rowsOnLatest: normalizeRows(row?.count) }
}

async function latestChipStats(
  db: D1Database,
  targetDate?: string,
): Promise<{ latestDate: string | null; rowsOnLatest: number; sourceTable: string }> {
  const canonical = await latestTableStats(db, 'canonical_chip_daily', targetDate).catch(() => null)
  if (canonical && normalizeRows(canonical.rowsOnLatest) > 0) {
    return { ...canonical, sourceTable: 'canonical_chip_daily' }
  }
  const legacy = await latestTableStats(db, 'chip_data', targetDate)
  return { ...legacy, sourceTable: 'chip_data' }
}

async function latestPriceSegmentStats(
  db: D1Database,
  latestDate: string | null,
): Promise<{ twseRows: number; otcRows: number }> {
  if (!latestDate) return { twseRows: 0, otcRows: 0 }
  const row = await db.prepare(`
    SELECT
      SUM(CASE WHEN s.market = 'TWSE' THEN 1 ELSE 0 END) AS twse_rows,
      SUM(CASE WHEN s.market = 'OTC' THEN 1 ELSE 0 END) AS otc_rows
    FROM stock_prices sp
    JOIN stocks s ON s.id = sp.stock_id
    WHERE sp.date = ?
  `).bind(latestDate).first<{ twse_rows: number | null; otc_rows: number | null }>()
  return {
    twseRows: normalizeRows(row?.twse_rows),
    otcRows: normalizeRows(row?.otc_rows),
  }
}

export async function loadMarketDataReadinessStats(
  db: D1Database,
  targetDate: string,
  options: MarketDataReadinessOptions = {},
): Promise<MarketDataReadinessStats> {
  const historicalTargetDate = options.allowHistoricalLatestAfterTarget ? targetDate : undefined
  const [price, chip, institutionalAmount, indicators] = await Promise.all([
    latestTableStats(db, 'stock_prices', historicalTargetDate),
    latestChipStats(db, historicalTargetDate),
    latestTableStats(db, 'canonical_institutional_amount_daily', historicalTargetDate).catch(() => ({ latestDate: null, rowsOnLatest: 0 })),
    latestTableStats(db, 'technical_indicators', historicalTargetDate),
  ])
  const priceSegmentDate = historicalTargetDate && price.latestDate && price.latestDate >= historicalTargetDate
    ? historicalTargetDate
    : price.latestDate
  const priceSegments = await latestPriceSegmentStats(db, priceSegmentDate)
  return {
    targetDate,
    priceLatestDate: price.latestDate,
    priceRowsOnLatest: price.rowsOnLatest,
    priceTwseRowsOnLatest: priceSegments.twseRows,
    priceOtcRowsOnLatest: priceSegments.otcRows,
    chipLatestDate: chip.latestDate,
    chipRowsOnLatest: chip.rowsOnLatest,
    chipSourceTable: chip.sourceTable,
    institutionalAmountLatestDate: institutionalAmount.latestDate,
    institutionalAmountRowsOnLatest: institutionalAmount.rowsOnLatest,
    indicatorLatestDate: indicators.latestDate,
    indicatorRowsOnLatest: indicators.rowsOnLatest,
  }
}

export async function assertMarketDataReady(
  db: D1Database,
  targetDate: string,
  options: MarketDataReadinessOptions = {},
): Promise<MarketDataReadinessResult> {
  const stats = await loadMarketDataReadinessStats(db, targetDate, options)
  const result = evaluateMarketDataReadiness(stats, options)
  if (!result.ok) {
    throw new Error(result.summary)
  }
  return result
}
