import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeStockIdentitySymbols } from './stockIdentityMarketBridge'

assert.deepEqual(normalizeStockIdentitySymbols([' 2330 ', '2330', '', '2317']), ['2330', '2317'])
const source = fs.readFileSync('src/lib/stockIdentityMarketBridge.ts', 'utf8')
assert(source.includes("databaseForDataDomain(env, 'core')"))
assert(!source.includes('.DB.prepare'))
assert(source.includes("databaseForDataDomain(env, 'market')"))
// Newest rows per id come from a bounded backward seek, not a rank over each stock's history
// (equivalence and plan: stockIdentityMarketBridgePriceHistorySeek.test.ts).
assert(source.includes('FROM json_each(?) AS ids'))
assert(source.includes('ORDER BY recent.date DESC'))
assert(!source.includes('ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY date DESC)'))

console.log('stock identity market bridge contract passed')
