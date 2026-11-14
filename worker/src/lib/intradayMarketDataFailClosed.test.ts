import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')

assert(source.includes('s12_market_data_unavailable'), 'missing quote cycles must persist a current S12 data error')
assert(source.includes('authoritative_market_data_unavailable'), 'pending buy must expose authoritative market-data outage')
assert(source.includes("throw new Error('intraday_authoritative_market_data_unavailable_all_symbols')"), 'all-symbol quote outage must fail scheduler execution')
assert(!source.includes('if (priceMap.size === 0) return'), 'quote outage must not silently return HTTP 200')
assert(source.includes('contract_bypass_allowed: false'), 'market-data outage must not re-enable a legacy entry owner')

console.log('intraday market-data fail-closed tests passed')

// AUD-20 behaviour: an unquoted holding is marked only at the previous session's exact close (holiday aware);
// an older close is not a mark, so the NAV is incomplete and new buys stop before sizing.
import test from 'node:test'
import nodeAssert from 'node:assert/strict'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { getPrevTradingDay } from './paperMarketData'
import { batchGetClosingPricesByDomain } from './paperMarketDomainData'
import { computePaperPositionValuation } from './paperAccountValue'
import { databaseForDataDomain } from './dataDomainRegistry'

test('AUD-20: previous-session close marks an unquoted holding; only an older close leaves it missing and blocks new buys', async () => {
  const f = l4NativeFixture()
  try {
    f.kvs.set('holiday:2026-09-11', 'fixture holiday')
    f.sqls.core.exec("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'A','a','TWSE'),(2,'B','b','TWSE')")
    f.sqls.market.exec(`INSERT INTO stock_prices(stock_id,date,open,high,low,close,avg_price,volume) VALUES
      (1,'2026-09-10',50,50,50,50,50,1000),(2,'2026-09-09',30,30,30,30,30,1000)`)
    const previousSession = await getPrevTradingDay(databaseForDataDomain(f.env, 'core'), f.env.KV, '2026-09-14')
    nodeAssert.equal(previousSession, '2026-09-10', 'Friday 09-11 is a holiday')
    const closes = await batchGetClosingPricesByDomain(f.env, ['A', 'B'], previousSession)
    nodeAssert.deepEqual([...closes], [['A', 50]], 'B has only an older close: never used as a mark')
    const valuation = computePaperPositionValuation({
      positions: [{ symbol: 'A', shares: 1000 }, { symbol: 'B', shares: 200 }], quotePrices: new Map(), fallbackPrices: closes,
    } as any)
    nodeAssert.deepEqual(valuation.fallbackSymbols, ['A'])
    nodeAssert.deepEqual(valuation.missingSymbols, ['B'])
  } finally { f.close() }
  // The entry path stops on a missing mark before any sizing, recording the dated fallback.
  const gate = source.slice(source.indexOf('if (positionValuation.missingSymbols.length > 0) {'))
  nodeAssert.ok(source.includes('batchGetClosingPricesByDomain(env, quoteMissingPosSymbols, previousSession)'))
  nodeAssert.ok(gate.indexOf('return holdingPoll') < gate.indexOf('requireCompletePaperPositionValue'))
  nodeAssert.ok(gate.slice(0, gate.indexOf('return holdingPoll')).includes("reason: 'intraday_nav_marks_missing'"))
  nodeAssert.ok(gate.slice(0, gate.indexOf('return holdingPoll')).includes('fallback_price_date: previousSession'))
})

test('AUD-20: the corporate-action reference close is the previous trading session exact close (weekend + holiday aware)', async () => {
  const { corporateReferenceCloses } = await import('./paperCorporateActions')
  const f = l4NativeFixture()
  try {
    // Session Monday 09-14; Friday 09-11 is a holiday, so the reference session is Thursday 09-10.
    f.kvs.set('holiday:2026-09-11', 'fixture holiday')
    f.sqls.core.exec("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'A','a','TWSE'),(2,'S','s','TWSE')")
    f.sqls.market.exec(`INSERT INTO stock_prices(stock_id,date,open,high,low,close,avg_price,volume) VALUES
      (1,'2026-09-09',40,40,40,40,40,1000),(1,'2026-09-10',41,41,41,41,41,1000),(1,'2026-09-11',99,99,99,99,99,1000),
      (2,'2026-09-08',20,20,20,20,20,1000)`)
    const closes = await corporateReferenceCloses(f.env, ['A', 'S'], '2026-09-14')
    // A: the 09-10 close, not the stray holiday row nor 09-09. S (suspended since 09-08): no reference, so the
    // action fails closed downstream (paper_corporate_previous_close_missing) instead of using an older close.
    nodeAssert.deepEqual([...closes], [['A', 41]])
    nodeAssert.deepEqual([...await corporateReferenceCloses(f.env, [], '2026-09-14')], [])
  } finally { f.close() }
})
