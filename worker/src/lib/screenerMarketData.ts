import type { Bindings } from '../types'
import { classifyBoard } from './boardTradability'

// Screener keeps this normalized market-data shape internally for scoring parity.
export interface FMStockPrice {
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

export interface FMChip {
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
}

export interface CanonicalChipRow {
  stock_id: string
  date: string
  market_segment: string | null
  foreign_net: number | null
  trust_net: number | null
  dealer_net: number | null
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
  canonical_market_segment?: string | null
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  avg_price: number | null
}

export function isAutoTradablePriceRow(row: {
  symbol?: string | null
  market: string | null
  open: number | null
  avg_price: number | null
}): boolean {
  return classifyBoard(row).eligibleForPendingBuy
}

function toFmPrice(row: ScreenerPriceRow, researchOnly = false): FMStockPrice | null {
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

export function splitPriceRowsByBoard(rows: ScreenerPriceRow[]): {
  allPrices: FMStockPrice[]
  emergingResearchPrices: FMStockPrice[]
  tpexSymbols: Set<string>
  laneCounts: { tradable: number; emerging_watchlist: number; research_only: number }
} {
  const allPrices: FMStockPrice[] = []
  const emergingResearchPrices: FMStockPrice[] = []
  const tpexSymbols = new Set<string>()
  const laneCounts = { tradable: 0, emerging_watchlist: 0, research_only: 0 }
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
    const board = classifyBoard(latest)
    if (board.recommendationLane === 'tradable') {
      for (const row of symbolRows) {
        const price = toFmPrice(row)
        if (price) allPrices.push(price)
      }
      laneCounts.tradable += 1
      if (board.boardType === 'OTC') tpexSymbols.add(latest.symbol)
      continue
    }
    if (board.recommendationLane === 'emerging_watchlist') {
      for (const row of symbolRows) {
        const price = toFmPrice(row, true)
        if (price) emergingResearchPrices.push(price)
      }
      laneCounts.emerging_watchlist += 1
      continue
    }
    laneCounts.research_only += 1
  }

  return { allPrices, emergingResearchPrices, tpexSymbols, laneCounts }
}

function latestSymbolsForLane(rows: ScreenerPriceRow[], lane: 'tradable' | 'emerging_watchlist'): string[] {
  const rowsBySymbol = new Map<string, ScreenerPriceRow[]>()
  for (const row of rows) {
    const symbol = String(row.symbol || '').trim()
    if (!symbol) continue
    const list = rowsBySymbol.get(symbol) ?? []
    list.push(row)
    rowsBySymbol.set(symbol, list)
  }

  const symbols: string[] = []
  for (const [symbol, symbolRows] of rowsBySymbol.entries()) {
    symbolRows.sort((a, b) => String(a.date).localeCompare(String(b.date)))
    const latest = symbolRows[symbolRows.length - 1]
    if (classifyBoard(latest).recommendationLane === lane) symbols.push(symbol)
  }
  return symbols
}

function netToChip(row: {
  stock_id: string
  date: string
  market_segment?: string | null
  source?: string | null
}, role: string, net: number | null | undefined, extras: Partial<FMChip> = {}): FMChip | null {
  const value = Number(net ?? 0)
  if (!Number.isFinite(value) || value === 0) return null
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

export function chipIdentity(chip: FMChip): string {
  return `${chip.stock_id}|${chip.date}|${chip.name}`
}

export function canonicalChipRowsToFmChips(
  rows: CanonicalChipRow[],
  brokerRows: CanonicalBrokerFlowRow[] = [],
): FMChip[] {
  const chips: FMChip[] = []
  for (const row of rows) {
    const foreign = netToChip(row, 'foreign', row.foreign_net)
    const trust = netToChip(row, 'trust', row.trust_net)
    const dealer = netToChip(row, 'dealer', row.dealer_net)
    if (foreign) chips.push(foreign)
    if (trust) chips.push(trust)
    if (dealer) chips.push(dealer)
  }
  for (const row of brokerRows) {
    const broker = netToChip(row, 'broker_flow', row.net_shares, {
      broker_count: row.broker_count ?? null,
      estimated_amount: row.estimated_amount ?? null,
      concentration: row.concentration ?? null,
    })
    if (broker) chips.push(broker)
  }
  return chips
}

export function mergeCanonicalFirstChips(canonical: FMChip[], fallback: FMChip[]): FMChip[] {
  const seen = new Set<string>()
  const merged: FMChip[] = []
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
): Promise<{ chips: FMChip[]; sourceSummary: Record<string, number> }> {
  const chips: FMChip[] = []
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
      const { results } = await db.prepare(
        `SELECT stock_id, date, market_segment, foreign_net, trust_net, dealer_net, source, as_of_date
         FROM canonical_chip_daily
         WHERE date >= ? AND date <= ?`,
      ).bind(dates[0], dates[dates.length - 1]).all<CanonicalChipRow>()
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

export async function loadMarketDataFromD1(
  env: Bindings,
  priceDays: number = 20,
  chipDays: number = 5,
  asOfDate?: string,
): Promise<{
  allPrices: FMStockPrice[]
  emergingResearchPrices: FMStockPrice[]
  allChips: FMChip[]
  tpexSymbols: Set<string>
  laneCounts: { tradable: number; emerging_watchlist: number; research_only: number }
  chipSourceSummary: Record<string, number>
}> {
  const lookbackDays = Math.ceil(priceDays * 1.5) + 7
  const chipLookback = Math.ceil(chipDays * 1.5) + 5

  const maxAllowedDate = asOfDate || new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  const { results: dateRows } = await env.DB.prepare(
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
      laneCounts: { tradable: 0, emerging_watchlist: 0, research_only: 0 },
      chipSourceSummary: {},
    }
  }
  const minDate = tradingDates[0]
  const maxDate = tradingDates[tradingDates.length - 1]

  const { results: priceRows } = await env.DB.prepare(
    `SELECT s.symbol,
            CASE
              WHEN UPPER(COALESCE(cm.market_segment, '')) IN ('EMERGING', 'ESB', 'ROTC') THEN 'EMERGING'
              WHEN UPPER(COALESCE(cm.market_segment, '')) = 'ETF' THEN 'ETF'
              ELSE s.market
            END AS market,
            cm.market_segment AS canonical_market_segment,
            sp.date,
            sp.open, sp.high, sp.low, sp.close,
            sp.volume, sp.avg_price
     FROM stock_prices sp
     JOIN stocks s ON sp.stock_id = s.id
     LEFT JOIN canonical_market_daily cm
       ON cm.stock_id = s.symbol
      AND cm.date = sp.date
      AND cm.source = 'finlab.rotc_price'
     WHERE sp.date >= ? AND sp.date <= ?
     ORDER BY s.symbol, sp.date`,
  ).bind(minDate, maxDate)
   .all<ScreenerPriceRow>()

  const { allPrices, emergingResearchPrices, tpexSymbols, laneCounts } = splitPriceRowsByBoard(priceRows ?? [])
  let finalEmergingResearchPrices = emergingResearchPrices
  let finalLaneCounts = laneCounts

  // Emerging stocks often trade sparsely. A 20-market-day global window can
  // contain fewer than 15 observed bars for one emerging symbol, which makes
  // RSI/MACD/MA20 score as missing even when the wider D1 history is usable.
  const emergingSymbols = latestSymbolsForLane(priceRows ?? [], 'emerging_watchlist')
  if (emergingSymbols.length > 0) {
    const emergingPriceDays = Math.max(priceDays, 60)
    const emergingLookbackDays = Math.ceil(emergingPriceDays * 2.2) + 14
    const { results: emergingDateRows } = await env.DB.prepare(
      `SELECT DISTINCT date FROM stock_prices
       WHERE date <= ?
         AND date >= date(?, '-${emergingLookbackDays} days')
       ORDER BY date DESC LIMIT ?`,
    ).bind(maxAllowedDate, maxAllowedDate, emergingPriceDays).all<{ date: string }>()
    const emergingDates = (emergingDateRows ?? []).map((r) => r.date).sort()
    if (emergingDates.length) {
      const minEmergingDate = emergingDates[0]
      const maxEmergingDate = emergingDates[emergingDates.length - 1]
      const expandedRows: ScreenerPriceRow[] = []
      const chunkSize = 80
      for (let i = 0; i < emergingSymbols.length; i += chunkSize) {
        const chunk = emergingSymbols.slice(i, i + chunkSize)
        const placeholders = chunk.map(() => '?').join(',')
        const { results } = await env.DB.prepare(
          `SELECT s.symbol,
                  CASE
                    WHEN UPPER(COALESCE(cm.market_segment, '')) IN ('EMERGING', 'ESB', 'ROTC') THEN 'EMERGING'
                    WHEN UPPER(COALESCE(cm.market_segment, '')) = 'ETF' THEN 'ETF'
                    ELSE s.market
                  END AS market,
                  cm.market_segment AS canonical_market_segment,
                  sp.date,
                  sp.open, sp.high, sp.low, sp.close,
                  sp.volume, sp.avg_price
             FROM stock_prices sp
             JOIN stocks s ON sp.stock_id = s.id
             LEFT JOIN canonical_market_daily cm
               ON cm.stock_id = s.symbol
              AND cm.date = sp.date
              AND cm.source = 'finlab.rotc_price'
            WHERE s.symbol IN (${placeholders})
              AND sp.date >= ? AND sp.date <= ?
            ORDER BY s.symbol, sp.date`,
        ).bind(...chunk, minEmergingDate, maxEmergingDate).all<ScreenerPriceRow>()
        expandedRows.push(...(results ?? []))
      }
      const expandedSplit = splitPriceRowsByBoard(expandedRows)
      if (expandedSplit.emergingResearchPrices.length > 0) {
        finalEmergingResearchPrices = expandedSplit.emergingResearchPrices
        finalLaneCounts = {
          ...laneCounts,
          emerging_watchlist: expandedSplit.laneCounts.emerging_watchlist,
          research_only: Math.max(laneCounts.research_only, expandedSplit.laneCounts.research_only),
        }
      }
    }
  }

  const { results: chipDateRows } = await env.DB.prepare(
    `SELECT DISTINCT date FROM chip_data
     WHERE date <= ?
       AND date >= date(?, '-${chipLookback} days')
     ORDER BY date DESC LIMIT ?`,
  ).bind(maxAllowedDate, maxAllowedDate, chipDays).all<{ date: string }>()
  const chipDates = (chipDateRows ?? []).map((r) => r.date).sort()

  const { chips: canonicalChips, sourceSummary: canonicalChipSources } = await loadCanonicalChipsFromD1(
    env.DB,
    maxAllowedDate,
    chipLookback,
    chipDays,
  )
  const fallbackChips: FMChip[] = []
  if (chipDates.length) {
    const minChipDate = chipDates[0]
    const maxChipDate = chipDates[chipDates.length - 1]
    const { results: chipRows } = await env.DB.prepare(
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
    emergingResearchPrices: finalEmergingResearchPrices,
    allChips,
    tpexSymbols,
    laneCounts: finalLaneCounts,
    chipSourceSummary,
  }
}
