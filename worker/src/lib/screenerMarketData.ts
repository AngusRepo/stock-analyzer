import type { Bindings } from '../types'

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

export async function loadMarketDataFromD1(
  env: Bindings,
  priceDays: number = 20,
  chipDays: number = 5,
): Promise<{
  allPrices: FMStockPrice[]
  allChips: FMChip[]
  tpexSymbols: Set<string>
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
    return { allPrices: [], allChips: [], tpexSymbols: new Set() }
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
   .all<{ symbol: string; market: string | null; date: string;
          open: number; high: number; low: number; close: number;
          volume: number; avg_price: number | null }>()

  const allPrices: FMStockPrice[] = []
  const tpexSymbols = new Set<string>()
  for (const row of (priceRows ?? [])) {
    if (!row.close || row.close <= 0) continue
    if (row.market === 'OTC') tpexSymbols.add(row.symbol)
    allPrices.push({
      date: row.date,
      stock_id: row.symbol,
      Trading_Volume: row.volume ?? 0,
      Trading_money: Math.round((row.avg_price ?? row.close) * (row.volume ?? 0)),
      open: row.open,
      max: row.high,
      min: row.low,
      close: row.close,
      spread: 0,
      Trading_turnover: 0,
    })
  }

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

  return { allPrices, allChips, tpexSymbols }
}
