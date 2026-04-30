import type { Bindings } from '../types'
import { classifyBoard } from './boardTradability'

// Types originally from finmind.ts. FinMind fetcher is retired; screener keeps
// this normalized shape internally for scoring parity.
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

  for (const row of rows) {
    const board = classifyBoard(row)
    if (board.recommendationLane === 'tradable') {
      const price = toFmPrice(row)
      if (!price) continue
      allPrices.push(price)
      laneCounts.tradable += 1
      if (board.boardType === 'OTC') tpexSymbols.add(row.symbol)
      continue
    }
    if (board.recommendationLane === 'emerging_watchlist') {
      const price = toFmPrice(row, true)
      if (!price) continue
      emergingResearchPrices.push(price)
      laneCounts.emerging_watchlist += 1
      continue
    }
    laneCounts.research_only += 1
  }

  return { allPrices, emergingResearchPrices, tpexSymbols, laneCounts }
}

export async function loadMarketDataFromD1(
  env: Bindings,
  priceDays: number = 20,
  chipDays: number = 5,
): Promise<{
  allPrices: FMStockPrice[]
  emergingResearchPrices: FMStockPrice[]
  allChips: FMChip[]
  tpexSymbols: Set<string>
  laneCounts: { tradable: number; emerging_watchlist: number; research_only: number }
}> {
  const lookbackDays = Math.ceil(priceDays * 1.5) + 7
  const chipLookback = Math.ceil(chipDays * 1.5) + 5

  const { results: dateRows } = await env.DB.prepare(
    `SELECT DISTINCT date FROM stock_prices
     WHERE date >= date('now', '-${lookbackDays} days')
     ORDER BY date DESC LIMIT ?`,
  ).bind(priceDays).all<{ date: string }>()
  const tradingDates = (dateRows ?? []).map((r) => r.date).sort()
  if (!tradingDates.length) {
    console.warn('[Screener D1] No trading dates in D1 stock_prices')
    return {
      allPrices: [],
      emergingResearchPrices: [],
      allChips: [],
      tpexSymbols: new Set(),
      laneCounts: { tradable: 0, emerging_watchlist: 0, research_only: 0 },
    }
  }
  const minDate = tradingDates[0]
  const maxDate = tradingDates[tradingDates.length - 1]

  const { results: priceRows } = await env.DB.prepare(
    `SELECT s.symbol, s.market, sp.date,
            sp.open, sp.high, sp.low, sp.close,
            sp.volume, sp.avg_price
     FROM stock_prices sp
     JOIN stocks s ON sp.stock_id = s.id
     WHERE sp.date >= ? AND sp.date <= ?
     ORDER BY s.symbol, sp.date`,
  ).bind(minDate, maxDate)
   .all<ScreenerPriceRow>()

  const { allPrices, emergingResearchPrices, tpexSymbols, laneCounts } = splitPriceRowsByBoard(priceRows ?? [])

  const { results: chipDateRows } = await env.DB.prepare(
    `SELECT DISTINCT date FROM chip_data
     WHERE date >= date('now', '-${chipLookback} days')
     ORDER BY date DESC LIMIT ?`,
  ).bind(chipDays).all<{ date: string }>()
  const chipDates = (chipDateRows ?? []).map((r) => r.date).sort()

  const allChips: FMChip[] = []
  if (chipDates.length) {
    const minChipDate = chipDates[0]
    const maxChipDate = chipDates[chipDates.length - 1]
    const { results: chipRows } = await env.DB.prepare(
      `SELECT symbol, date, foreign_buy, foreign_sell,
              trust_buy, trust_sell
       FROM chip_data
       WHERE date >= ? AND date <= ?`,
    ).bind(minChipDate, maxChipDate)
     .all<{ symbol: string; date: string;
            foreign_buy: number | null; foreign_sell: number | null;
            trust_buy: number | null; trust_sell: number | null }>()

    for (const row of (chipRows ?? [])) {
      if (row.foreign_buy != null || row.foreign_sell != null) {
        allChips.push({
          date: row.date,
          stock_id: row.symbol,
          name: '外資',
          buy: row.foreign_buy ?? 0,
          sell: row.foreign_sell ?? 0,
        })
      }
      if (row.trust_buy != null || row.trust_sell != null) {
        allChips.push({
          date: row.date,
          stock_id: row.symbol,
          name: '投信',
          buy: row.trust_buy ?? 0,
          sell: row.trust_sell ?? 0,
        })
      }
    }
  }

  return { allPrices, emergingResearchPrices, allChips, tpexSymbols, laneCounts }
}
