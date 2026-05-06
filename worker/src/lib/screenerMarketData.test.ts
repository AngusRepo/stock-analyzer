import { splitPriceRowsByBoard, type ScreenerPriceRow } from './screenerMarketData'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const rows: ScreenerPriceRow[] = [
  {
    symbol: '3585',
    market: 'OTC',
    date: '2026-04-30',
    open: null,
    high: 146.5,
    low: 113.5,
    close: 122.5,
    volume: 8119423,
    avg_price: 126.56,
  },
  {
    symbol: '7820',
    market: 'OTC',
    date: '2026-04-24',
    open: null,
    high: 180,
    low: 150,
    close: 183,
    volume: 1000,
    avg_price: 170,
  },
  {
    symbol: '7820',
    market: 'OTC',
    date: '2026-05-04',
    open: 144,
    high: 154.5,
    low: 144,
    close: 152,
    volume: 541991,
    avg_price: null,
  },
]

const result = splitPriceRowsByBoard(rows)

assert(
  result.emergingResearchPrices.some((row) => row.stock_id === '3585'),
  '3585 latest avg-price-only row should route to emerging research lane',
)
assert(
  !result.allPrices.some((row) => row.stock_id === '3585'),
  '3585 must not enter tradable lane when latest row is emerging-style',
)
assert(
  result.allPrices.filter((row) => row.stock_id === '7820').length === 2,
  '7820 should keep its full price history in tradable lane after latest row becomes executable OTC',
)
assert(
  !result.emergingResearchPrices.some((row) => row.stock_id === '7820'),
  '7820 historical emerging-style rows must not leak into emerging lane after OTC listing',
)
assert(result.laneCounts.tradable === 1, 'only 7820 should count as tradable')
assert(result.laneCounts.emerging_watchlist === 1, 'only 3585 should count as emerging research')
