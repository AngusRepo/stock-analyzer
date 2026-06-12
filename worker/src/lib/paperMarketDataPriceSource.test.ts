import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/lib/paperMarketData.ts', 'utf8')

assert(
  source.includes('SELECT sp.close as price FROM stock_prices sp'),
  'getLatestPrice must use official close for EOD current price',
)

assert(
  source.includes('SELECT s.symbol, sp.close as price'),
  'batchGetLatestPrices must use official close for EOD current price',
)

assert(
  !source.includes('COALESCE(sp.avg_price, sp.close)'),
  'paper portfolio current price must not fall back to avg_price',
)

console.log('paperMarketDataPriceSource.test.ts passed')
