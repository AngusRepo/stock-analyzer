import { splitPriceRowsByBoard } from './screenerMarketData'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const split = splitPriceRowsByBoard([
  {
    symbol: '2330',
    market: 'TWSE',
    date: '2026-04-29',
    open: 1200,
    high: 1210,
    low: 1190,
    close: 1205,
    volume: 1000000,
    avg_price: null,
  },
  {
    symbol: '7879',
    market: 'OTC',
    date: '2026-04-29',
    open: null,
    high: null,
    low: null,
    close: 101.5,
    volume: 120000,
    avg_price: 100.53,
  },
])

assert(split.allPrices.length === 1, 'listed/TWSE rows should enter the auto-tradable lane')
assert(split.emergingResearchPrices.length === 0, 'avg-price-only rows should not enter retired emerging research lane')
assert(split.tpexSymbols.size === 0, 'stale OTC metadata must not mark emerging-style rows as TPEX tradable')
assert(split.laneCounts.tradable === 1, 'tradable lane count should be explicit')
assert(split.laneCounts.emerging_watchlist === 0, 'emerging lane should remain disabled')
assert(split.laneCounts.research_only === 1, 'avg-price-only rows should count as research-only')
