import { isAutoTradablePriceRow } from './screenerMarketData'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

assert(
  !isAutoTradablePriceRow({ market: 'EMERGING', open: null, avg_price: 100.53 }),
  'explicit EMERGING market rows must not enter auto-tradable screener universe',
)

assert(
  !isAutoTradablePriceRow({ market: 'EMERGING', open: 70.52, avg_price: 69.92 }),
  'explicit FinLab EMERGING rows must stay research-only even when the canonical row has executable OHLC',
)

assert(
  !isAutoTradablePriceRow({ market: 'OTC', open: null, avg_price: 100.53 }),
  'emerging-style OHLC rows must be blocked even when stale market metadata says OTC',
)

assert(
  isAutoTradablePriceRow({ market: 'OTC', open: 52.4, avg_price: null }),
  'regular OTC rows with an opening price remain tradable',
)
