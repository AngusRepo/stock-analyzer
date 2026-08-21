import { databaseForDataDomain } from './dataDomainRegistry'
import type { Bindings } from '../types'
import { classifyBoard } from './boardTradability'
import { loadCoreStockIdentitiesByIds } from './stockIdentityMarketBridge'

export interface CanonicalScreenerPrice {
  date: string
  stock_id: string
  Trading_Volume: number
  Trading_money: number
  open: number
  max: number
  min: number
  close: number
  spread: number
  Trading_turnover: number
}

export interface CanonicalScreenerChip {
  date: string
  stock_id: string
  name: string
  buy: number
  sell: number
  source?: string
  market_segment?: string
  broker_count?: number | null
  estimated_amount?: number | null
  concentration?: number | null
  margin_balance?: number | null
  short_balance?: number | null
  margin_prev_balance?: number | null
  margin_limit?: number | null
  margin_usage_ratio?: number | null
  short_buy?: number | null
  short_sell?: number | null
  short_stock_repayment?: number | null
  short_prev_balance?: number | null
  short_limit?: number | null
  short_usage_ratio?: number | null
  security_lending_borrow?: number | null
  security_lending_return?: number | null
  security_lending_delta?: number | null
  security_lending_balance?: number | null
  security_lending_sell?: number | null
  security_lending_sell_return?: number | null
  security_lending_sell_balance?: number | null
  security_lending_sell_limit?: number | null
}

/** @deprecated Use CanonicalScreenerPrice. The FinMind fetcher is retired. */
export type FMStockPrice = CanonicalScreenerPrice

/** @deprecated Use CanonicalScreenerChip. The FinMind fetcher is retired. */
export type FMChip = CanonicalScreenerChip

export interface CanonicalChipRow {
  stock_id: string
  date: string
  market_segment: string | null
  foreign_net: number | null
  trust_net: number | null
  dealer_net: number | null
  margin_balance?: number | null
  short_balance?: number | null
  margin_prev_balance?: number | null
  margin_limit?: number | null
  margin_usage_ratio?: number | null
  short_buy?: number | null
  short_sell?: number | null
  short_stock_repayment?: number | null
  short_prev_balance?: number | null
  short_limit?: number | null
  short_usage_ratio?: number | null
  security_lending_borrow?: number | null
  security_lending_return?: number | null
  security_lending_delta?: number | null
  security_lending_balance?: number | null
  security_lending_sell?: number | null
  security_lending_sell_return?: number | null
  security_lending_sell_balance?: number | null
  security_lending_sell_limit?: number | null
  source: string | null
  as_of_date?: string | null
}

export interface CanonicalBrokerFlowRow {
  stock_id: string
  date: string
  market_segment: string | null
  net_shares: number | null
  estimated_amount: number | null
  broker_count: number | null
  concentration: number | null
  source: string | null
  as_of_date?: string | null
}

export interface ScreenerPriceRow {
  symbol: string
  market: string | null
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  avg_price: number | null
}

export function isAutoTradablePriceRow(row: {
  market: string | null
  open: number | null
  avg_price: number | null
}): boolean {
  return classifyBoard(row).eligibleForPendingBuy
}

function toCanonicalScreenerPrice(row: ScreenerPriceRow, researchOnly = false): CanonicalScreenerPrice | null {
  if (!row.close || row.close <= 0) return null
  const synthetic = row.close
  return {
    date: row.date,
    stock_id: row.symbol,
    Trading_Volume: row.volume ?? 0,
    Trading_money: Math.round((row.avg_price ?? row.close) * (row.volume ?? 0)),
    open: researchOnly ? synthetic : (row.open ?? synthetic),
    max: researchOnly ? synthetic : (row.high ?? synthetic),
    min: researchOnly ? synthetic : (row.low ?? synthetic),
    close: row.close,
    spread: 0,
    Trading_turnover: 0,
  }
}

export function splitPriceRowsByBoard(rows: ScreenerPriceRow[], requiredLatestDate?: string): {
  allPrices: CanonicalScreenerPrice[]
  emergingResearchPrices: CanonicalScreenerPrice[]
  tpexSymbols: Set<string>
  laneCounts: { tradable: number; emerging_watchlist: number; research_only: number; stale_excluded: number }
} {
  const allPrices: CanonicalScreenerPrice[] = []
  const emergingResearchPrices: CanonicalScreenerPrice[] = []
  const tpexSymbols = new Set<string>()
  const laneCounts = { tradable: 0, emerging_watchlist: 0, research_only: 0, stale_excluded: 0 }
  const rowsBySymbol = new Map<string, ScreenerPriceRow[]>()

  for (const row of rows) {
    const symbol = String(row.symbol || '').trim()
    if (!symbol) continue
    const list = rowsBySymbol.get(symbol) ?? []
    list.push(row)
    rowsBySymbol.set(symbol, list)
  }

  for (const symbolRows of rowsBySymbol.values()) {
    symbolRows.sort((a, b) => String(a.date).localeCompare(String(b.date)))
    const latest = symbolRows[symbolRows.length - 1]
    if (requiredLatestDate && latest.date !== requiredLatestDate) {
      laneCounts.stale_excluded += 1
      continue
    }
    const board = classifyBoard(latest)
    if (board.recommendationLane === 'tradable') {
      for (const row of symbolRows) {
        const price = toCanonicalScreenerPrice(row)
        if (price) allPrices.push(price)
      }
      laneCounts.tradable += 1
      if (board.boardType === 'OTC') tpexSymbols.add(latest.symbol)
      continue
    }
    if (board.recommendationLane === 'emerging_watchlist') {
      laneCounts.research_only += 1
      continue
    }
    laneCounts.research_only += 1
  }

  return { allPrices, emergingResearchPrices, tpexSymbols, laneCounts }
}

function netToChip(row: {
  stock_id: string
  date: string
  market_segment?: string | null
  source?: string | null
}, role: string, net: number | null | undefined, extras: Partial<CanonicalScreenerChip> = {}, options: { preserveZeroNet?: boolean } = {}): CanonicalScreenerChip | null {
  const value = Number(net ?? 0)
  const hasMetadata = extras.broker_count != null || extras.estimated_amount != null || extras.concentration != null
  if (!Number.isFinite(value) || (value === 0 && !options.preserveZeroNet && !hasMetadata)) return null
  return {
    date: row.date,
    stock_id: row.stock_id,
    name: role,
    buy: value > 0 ? value : 0,
    sell: value < 0 ? Math.abs(value) : 0,
    source: row.source ?? 'canonical',
    market_segment: row.market_segment ?? undefined,
    ...extras,
  }
}

export function chipIdentity(chip: CanonicalScreenerChip): string {
  return `${chip.stock_id}|${chip.date}|${chip.name}`
}

export function canonicalChipRowsToFmChips(
  rows: CanonicalChipRow[],
  brokerRows: CanonicalBrokerFlowRow[] = [],
): CanonicalScreenerChip[] {
  const chips: CanonicalScreenerChip[] = []
  for (const row of rows) {
    const foreign = netToChip(row, 'foreign', row.foreign_net)
    const trust = netToChip(row, 'trust', row.trust_net)
    const dealer = netToChip(row, 'dealer', row.dealer_net)
    if (foreign) chips.push(foreign)
    if (trust) chips.push(trust)
    if (dealer) chips.push(dealer)
    if (
      row.margin_balance != null ||
      row.short_balance != null ||
      row.margin_usage_ratio != null ||
      row.short_buy != null ||
      row.short_sell != null ||
      row.short_usage_ratio != null ||
      row.security_lending_sell != null ||
      row.security_lending_sell_return != null ||
      row.security_lending_sell_balance != null ||
      row.security_lending_balance != null
    ) {
      chips.push({
        date: row.date,
        stock_id: row.stock_id,
        name: 'margin_balance',
        buy: Number(row.margin_balance ?? 0),
        sell: 0,
        source: row.source ?? 'canonical',
        market_segment: row.market_segment ?? undefined,
        margin_balance: row.margin_balance ?? null,
        short_balance: row.short_balance ?? null,
        margin_prev_balance: row.margin_prev_balance ?? null,
        margin_limit: row.margin_limit ?? null,
        margin_usage_ratio: row.margin_usage_ratio ?? null,
        short_buy: row.short_buy ?? null,
        short_sell: row.short_sell ?? null,
        short_stock_repayment: row.short_stock_repayment ?? null,
        short_prev_balance: row.short_prev_balance ?? null,
        short_limit: row.short_limit ?? null,
        short_usage_ratio: row.short_usage_ratio ?? null,
        security_lending_borrow: row.security_lending_borrow ?? null,
        security_lending_return: row.security_lending_return ?? null,
        security_lending_delta: row.security_lending_delta ?? null,
        security_lending_balance: row.security_lending_balance ?? null,
        security_lending_sell: row.security_lending_sell ?? null,
        security_lending_sell_return: row.security_lending_sell_return ?? null,
        security_lending_sell_balance: row.security_lending_sell_balance ?? null,
        security_lending_sell_limit: row.security_lending_sell_limit ?? null,
      })
    }
  }
  for (const row of brokerRows) {
    const broker = netToChip(row, 'broker_flow', row.net_shares, {
      broker_count: row.broker_count ?? null,
      estimated_amount: row.estimated_amount ?? null,
      concentration: row.concentration ?? null,
    }, { preserveZeroNet: true })
    if (broker) chips.push(broker)
  }
  return chips
}

export function mergeCanonicalFirstChips(canonical: CanonicalScreenerChip[], fallback: CanonicalScreenerChip[]): CanonicalScreenerChip[] {
  const seen = new Set<string>()
  const merged: CanonicalScreenerChip[] = []
  for (const chip of canonical) {
    const key = chipIdentity(chip)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(chip)
  }
  for (const chip of fallback) {
    const key = chipIdentity(chip)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(chip)
  }
  return merged
}

async function loadCanonicalChipsFromD1(
  db: D1Database,
  maxAllowedDate: string,
  chipLookback: number,
  chipDays: number,
): Promise<{ chips: CanonicalScreenerChip[]; sourceSummary: Record<string, number> }> {
  const chips: CanonicalScreenerChip[] = []
  const sourceSummary: Record<string, number> = {}

  try {
    const { results: canonicalDates } = await db.prepare(
      `SELECT DISTINCT date FROM canonical_chip_daily
       WHERE date <= ?
         AND date >= date(?, '-${chipLookback} days')
       ORDER BY date DESC LIMIT ?`,
    ).bind(maxAllowedDate, maxAllowedDate, chipDays).all<{ date: string }>()
    const dates = (canonicalDates ?? []).map(row => row.date).sort()
    if (dates.length) {
      let results: CanonicalChipRow[] = []
      try {
        const response = await db.prepare(
          `SELECT stock_id, date, market_segment, foreign_net, trust_net, dealer_net,
                  margin_balance, short_balance,
                  margin_prev_balance, margin_limit, margin_usage_ratio,
                  short_buy, short_sell, short_stock_repayment, short_prev_balance, short_limit, short_usage_ratio,
                  security_lending_borrow, security_lending_return, security_lending_delta, security_lending_balance,
                  security_lending_sell, security_lending_sell_return, security_lending_sell_balance, security_lending_sell_limit,
                  source, as_of_date
           FROM canonical_chip_daily
           WHERE date >= ? AND date <= ?`,
        ).bind(dates[0], dates[dates.length - 1]).all<CanonicalChipRow>()
        results = response.results ?? []
      } catch {
        const response = await db.prepare(
          `SELECT stock_id, date, market_segment, foreign_net, trust_net, dealer_net,
                  margin_balance, short_balance, source, as_of_date
           FROM canonical_chip_daily
           WHERE date >= ? AND date <= ?`,
        ).bind(dates[0], dates[dates.length - 1]).all<CanonicalChipRow>()
        results = response.results ?? []
      }
      for (const chip of canonicalChipRowsToFmChips(results ?? [])) {
        chips.push(chip)
        const source = chip.source ?? 'canonical_chip_daily'
        sourceSummary[source] = (sourceSummary[source] ?? 0) + 1
      }
    }
  } catch {
    // V4.1 migration may not be present in older local/preview D1 snapshots.
  }

  try {
    const { results: brokerDates } = await db.prepare(
      `SELECT DISTINCT date FROM canonical_broker_flow_daily
       WHERE date <= ?
         AND date >= date(?, '-${chipLookback} days')
       ORDER BY date DESC LIMIT ?`,
    ).bind(maxAllowedDate, maxAllowedDate, chipDays).all<{ date: string }>()
    const dates = (brokerDates ?? []).map(row => row.date).sort()
    if (dates.length) {
      const { results } = await db.prepare(
        `SELECT stock_id, date, market_segment, net_shares, estimated_amount,
                broker_count, concentration, source, as_of_date
         FROM canonical_broker_flow_daily
         WHERE date >= ? AND date <= ?`,
      ).bind(dates[0], dates[dates.length - 1]).all<CanonicalBrokerFlowRow>()
      for (const chip of canonicalChipRowsToFmChips([], results ?? [])) {
        chips.push(chip)
        const source = chip.source ?? 'canonical_broker_flow_daily'
        sourceSummary[source] = (sourceSummary[source] ?? 0) + 1
      }
    }
  } catch {
    // Optional broker lineage table. Missing table must not break listed/OTC scoring.
  }

  return { chips, sourceSummary }
}

const SCREENER_PRICE_DATE_PAGE_SIZE = 5
const SCREENER_PRICE_PAGE_CONCURRENCY = 3
const SCREENER_PRICE_PAGE_MAX_ATTEMPTS = 3

function waitForPricePageRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

interface ScreenerPriceStorageRow {
  stock_id: number | string
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  avg_price: number | null
}

async function loadScreenerPriceDatePage(
  db: D1Database,
  minDate: string,
  maxDate: string,
): Promise<ScreenerPriceStorageRow[]> {
  let lastError: unknown
  for (let attempt = 1; attempt <= SCREENER_PRICE_PAGE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await db.prepare(
        `SELECT stock_id, date, open, high, low, close, volume, avg_price
           FROM stock_prices
          WHERE date >= ? AND date <= ?
          ORDER BY stock_id, date`,
      ).bind(minDate, maxDate).all<ScreenerPriceStorageRow>()
      return result.results ?? []
    } catch (error) {
      lastError = error
      if (attempt < SCREENER_PRICE_PAGE_MAX_ATTEMPTS) {
        await waitForPricePageRetry(250 * (2 ** (attempt - 1)))
      }
    }
  }
  throw lastError
}

export async function loadScreenerPriceRowsPaged(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  tradingDates: string[],
): Promise<ScreenerPriceRow[]> {
  const marketDb = databaseForDataDomain(env, 'market')
  const storageRows: ScreenerPriceStorageRow[] = []
  const pages: string[][] = []
  for (let offset = 0; offset < tradingDates.length; offset += SCREENER_PRICE_DATE_PAGE_SIZE) {
    pages.push(tradingDates.slice(offset, offset + SCREENER_PRICE_DATE_PAGE_SIZE))
  }
  for (let offset = 0; offset < pages.length; offset += SCREENER_PRICE_PAGE_CONCURRENCY) {
    const batch = pages.slice(offset, offset + SCREENER_PRICE_PAGE_CONCURRENCY)
    const batchRows = await Promise.all(batch.map((pageDates) =>
      loadScreenerPriceDatePage(marketDb, pageDates[0], pageDates[pageDates.length - 1])))
    for (const pageRows of batchRows) storageRows.push(...pageRows)
  }
  const identities = await loadCoreStockIdentitiesByIds(
    env,
    storageRows.map((row) => Number(row.stock_id)).filter(Number.isSafeInteger),
  )
  return storageRows.flatMap((row) => {
    const identity = identities.get(Number(row.stock_id))
    if (!identity?.symbol) return []
    return [{
      symbol: identity.symbol,
      market: identity.market,
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      avg_price: row.avg_price,
    }]
  })
}
export async function loadMarketDataFromD1(
  env: Bindings,
  priceDays: number = 20,
  chipDays: number = 5,
  asOfDate?: string,
): Promise<{
  allPrices: CanonicalScreenerPrice[]
  emergingResearchPrices: CanonicalScreenerPrice[]
  allChips: CanonicalScreenerChip[]
  tpexSymbols: Set<string>
  laneCounts: { tradable: number; emerging_watchlist: number; research_only: number; stale_excluded: number }
  chipSourceSummary: Record<string, number>
}> {
  const lookbackDays = Math.ceil(priceDays * 1.5) + 7
  const chipLookback = Math.ceil(chipDays * 1.5) + 5

  const maxAllowedDate = asOfDate || new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  const marketDb = databaseForDataDomain(env, 'market')
  const { results: dateRows } = await marketDb.prepare(
    `SELECT DISTINCT date FROM stock_prices
     WHERE date <= ?
       AND date >= date(?, '-${lookbackDays} days')
     ORDER BY date DESC LIMIT ?`,
  ).bind(maxAllowedDate, maxAllowedDate, priceDays).all<{ date: string }>()
  const tradingDates = (dateRows ?? []).map((r) => r.date).sort()
  if (!tradingDates.length) {
    console.warn('[Screener D1] No trading dates in D1 stock_prices')
    return {
      allPrices: [],
      emergingResearchPrices: [],
      allChips: [],
      tpexSymbols: new Set(),
      laneCounts: { tradable: 0, emerging_watchlist: 0, research_only: 0, stale_excluded: 0 },
      chipSourceSummary: {},
    }
  }
  const maxDate = tradingDates[tradingDates.length - 1]

  const priceRows = await loadScreenerPriceRowsPaged(env, tradingDates)
  const { allPrices, tpexSymbols, laneCounts } = splitPriceRowsByBoard(priceRows ?? [], maxDate)

  const { results: chipDateRows } = await marketDb.prepare(
    `SELECT DISTINCT date FROM chip_data
     WHERE date <= ?
       AND date >= date(?, '-${chipLookback} days')
     ORDER BY date DESC LIMIT ?`,
  ).bind(maxAllowedDate, maxAllowedDate, chipDays).all<{ date: string }>()
  const chipDates = (chipDateRows ?? []).map((r) => r.date).sort()

  const { chips: canonicalChips, sourceSummary: canonicalChipSources } = await loadCanonicalChipsFromD1(
    marketDb,
    maxAllowedDate,
    chipLookback,
    chipDays,
  )
  const fallbackChips: CanonicalScreenerChip[] = []
  if (chipDates.length) {
    const minChipDate = chipDates[0]
    const maxChipDate = chipDates[chipDates.length - 1]
    const { results: chipRows } = await marketDb.prepare(
      `SELECT symbol, date, foreign_buy, foreign_sell,
              trust_buy, trust_sell, dealer_buy, dealer_sell
       FROM chip_data
       WHERE date >= ? AND date <= ?`,
    ).bind(minChipDate, maxChipDate)
     .all<{ symbol: string; date: string;
            foreign_buy: number | null; foreign_sell: number | null;
            trust_buy: number | null; trust_sell: number | null;
            dealer_buy: number | null; dealer_sell: number | null }>()

    for (const row of (chipRows ?? [])) {
      if (row.foreign_buy != null || row.foreign_sell != null) {
        fallbackChips.push({
          date: row.date,
          stock_id: row.symbol,
          name: '外資',
          buy: row.foreign_buy ?? 0,
          sell: row.foreign_sell ?? 0,
          source: 'legacy.chip_data',
        })
      }
      if (row.trust_buy != null || row.trust_sell != null) {
        fallbackChips.push({
          date: row.date,
          stock_id: row.symbol,
          name: '投信',
          buy: row.trust_buy ?? 0,
          sell: row.trust_sell ?? 0,
          source: 'legacy.chip_data',
        })
      }
      if (row.dealer_buy != null || row.dealer_sell != null) {
        fallbackChips.push({
          date: row.date,
          stock_id: row.symbol,
          name: 'dealer',
          buy: row.dealer_buy ?? 0,
          sell: row.dealer_sell ?? 0,
          source: 'legacy.chip_data',
        })
      }
    }
  }
  const allChips = mergeCanonicalFirstChips(canonicalChips, fallbackChips)
  const canonicalKeys = new Set(canonicalChips.map(chipIdentity))
  const chipSourceSummary = { ...canonicalChipSources }
  for (const chip of fallbackChips) {
    if (canonicalKeys.has(chipIdentity(chip))) continue
    const source = chip.source ?? 'legacy.chip_data'
    chipSourceSummary[source] = (chipSourceSummary[source] ?? 0) + 1
  }

  return {
    allPrices,
    emergingResearchPrices: [],
    allChips,
    tpexSymbols,
    laneCounts,
    chipSourceSummary,
  }
}
