import assert from 'node:assert/strict'
import fs from 'node:fs'

const readiness = fs.readFileSync('src/lib/marketDataReadiness.ts', 'utf8')
const screener = fs.readFileSync('src/lib/screenerMarketData.ts', 'utf8')
const pipeline = fs.readFileSync('src/lib/mlPipelineTrigger.ts', 'utf8')
const marketRisk = fs.readFileSync('src/lib/marketRisk.ts', 'utf8')

assert(readiness.includes('loadCoreStockIdentitiesByIds(env, ids)'))
assert(!readiness.includes('JOIN stocks'))
assert(screener.includes('loadCoreStockIdentitiesByIds('))
assert(!screener.includes('JOIN stocks s ON sp.stock_id = s.id'))
assert(screener.includes("const marketDb = databaseForDataDomain(env, 'market')"))
assert(!screener.includes('loadScreenerPriceRowsPaged(env.DB, tradingDates)'))
assert(!pipeline.includes('assertMarketDataReady(env.DB, twDate)'))
assert(!pipeline.includes('upsertMarketRegimeFactorPacket(env.DB'))
assert(marketRisk.includes('FROM canonical_institutional_amount_daily'))
assert(!marketRisk.includes('JOIN stocks s ON s.symbol = c.symbol'))

console.log('market D1 split read/write ownership contract passed')