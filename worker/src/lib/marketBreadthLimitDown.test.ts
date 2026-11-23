import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calcMarketRisk } from './marketRisk'
import { isTwEquityLimitDownClose } from './twEquityMarketContract'
import { syncMarketBreadthFromFinLabCanonical } from './updateOrchestrator'
import { l4NativeFixture } from './l4NativeFixture.testSupport'

test('limit-down is the previous-close band limit rounded up to the tick', () => {
  // 47.3 * 0.9 = 42.57 -> 0.05 tick -> 42.60
  assert.equal(isTwEquityLimitDownClose(42.6, 47.3), true)
  assert.equal(isTwEquityLimitDownClose(42.65, 47.3), false)
  // 105 * 0.9 = 94.5 on a 0.1 tick
  assert.equal(isTwEquityLimitDownClose(94.5, 105), true)
  assert.equal(isTwEquityLimitDownClose(94.6, 105), false)
  assert.equal(isTwEquityLimitDownClose(9, 10, { unrestricted: true }), false)
  assert.equal(isTwEquityLimitDownClose(0, 10), false)
  assert.equal(isTwEquityLimitDownClose(9, 0), false)
})

test('daily breadth counts limit-down against the previous close, not the open', async () => {
  const f = l4NativeFixture()
  try {
    const stock = f.sqls.core.prepare('INSERT INTO stocks(symbol,name,market) VALUES(?,?,?)')
    const price = f.sqls.market.prepare('INSERT INTO canonical_market_daily(stock_id,date,open,close,source,lineage_json,as_of_date) VALUES(?,?,?,?,?,?,?)')
    const day = (symbol: string, prev: number, open: number, close: number, source = 'finlab.price') => {
      price.run(symbol, '2026-10-08', prev, prev, source, '{}', '2026-10-08')
      price.run(symbol, '2026-10-12', open, close, source, '{}', '2026-10-12')
    }
    for (let i = 0; i < 1000; i++) {
      const symbol = String(2000 + i)
      stock.run(symbol, symbol, 'TWSE')
      day(symbol, 10, 10, 10)
    }
    stock.run('9001', 'locked', 'TWSE'); day('9001', 47.3, 42.6, 42.6) // one-price limit-down
    stock.run('9002', 'intraday', 'OTC'); day('9002', 105, 100, 94.5) // fell to the limit intraday
    stock.run('9003', 'open-drop', 'TWSE'); day('9003', 115, 120.5, 108.5) // -10% from a gapped-up open, far above the 103.5 limit
    stock.run('9004', 'emerging', 'OTC'); day('9004', 50, 50, 40, 'finlab.rotc_price') // no price band
    const result = await syncMarketBreadthFromFinLabCanonical(f.env, '2026-10-12')
    assert.equal(result.sampleSize, 1004)
    assert.equal(result.limitDownCount, 2)
    const row: any = f.sqls.market.prepare('SELECT limit_down_count FROM market_breadth WHERE date=?').get('2026-10-12')
    assert.equal(row.limit_down_count, 2)
  } finally { f.close() }
})

test('market risk carries same-day limit-down count and fraction from market_breadth', async () => {
  const target = '2026-08-20'
  const days = ['2026-08-14', '2026-08-17', '2026-08-18', '2026-08-19', target]
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('offline') }) as typeof fetch
  const breadth = (limitDown: number | null) => ({
    prepare(sql: string) {
      return {
        bind() { return this },
        async all() {
          if (sql.includes('market_breadth')) {
            return { results: [...days].reverse().map((date) => ({
              date, advance_count: 900, decline_count: 1000, unchanged_count: 100, sample_size: 2000,
              limit_down_count: date === target ? limitDown : 0,
            })) }
          }
          return { results: [] }
        },
      }
    },
  } as unknown as D1Database)
  try {
    const risk = await calcMarketRisk(breadth(18), undefined, undefined, target)
    assert.equal(risk.limitDownCount, 18)
    assert.equal(risk.limitDownPct, 0.009)
    const missing = await calcMarketRisk(breadth(null), undefined, undefined, target)
    assert.equal(missing.limitDownCount, null)
    assert.equal(missing.limitDownPct, null)
  } finally { globalThis.fetch = realFetch }
})
