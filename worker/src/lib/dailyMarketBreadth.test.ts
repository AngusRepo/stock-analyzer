import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { ensureDailyMarketBreadth } from './updateOrchestrator'
import { l4NativeFixture } from './l4NativeFixture.testSupport'

test('daily canonical breadth fills the missing day before regime without historical HTTP', async () => {
  const f = l4NativeFixture()
  const fetch = globalThis.fetch
  globalThis.fetch = async () => { throw Error('unexpected official network') }
  try {
    const stock = f.sqls.core.prepare('INSERT INTO stocks(symbol,name,market) VALUES(?,?,?)')
    const price = f.sqls.market.prepare('INSERT INTO canonical_market_daily(stock_id,date,open,close,source,lineage_json,as_of_date) VALUES(?,?,?,?,?,?,?)')
    for (let i = 0; i < 1002; i++) {
      const symbol = String(1000+i)
      stock.run(symbol,symbol,i%2 ? 'OTC' : 'TWSE')
      price.run(symbol,'2026-10-08',10,10,'finlab.price','{}','2026-10-08')
      price.run(symbol,'2026-10-12',10,i%3 === 0 ? 11 : i%3 === 1 ? 9 : 10,'finlab.price','{}','2026-10-12')
    }
    await ensureDailyMarketBreadth(f.env,'2026-10-12')
    const row:any = f.sqls.market.prepare('SELECT * FROM market_breadth WHERE date=?').get('2026-10-12')
    assert.equal(row.sample_size,1002)
    assert.equal(row.advance_count,334); assert.equal(row.decline_count,334); assert.equal(row.unchanged_count,334)
    f.sqls.market.exec('DELETE FROM canonical_market_daily')
    await ensureDailyMarketBreadth(f.env,'2026-10-12')
    await assert.rejects(ensureDailyMarketBreadth(f.env,'2026-10-13'),/daily_market_breadth_incomplete/)
    assert.equal(f.sqls.market.prepare('SELECT COUNT(*) AS n FROM market_breadth').get()?.n,1)
    const source=fs.readFileSync('src/lib/updateOrchestrator.ts','utf8')
    const bulk=source.slice(source.indexOf('export async function runBulkFetch'),source.indexOf('export async function runQueueUpdate'))
    assert(bulk.indexOf('ensureDailyMarketBreadth(env, twDate)') < bulk.indexOf('TWSE/TPEX supplemental bulk fetch skipped'))
    const regime=source.slice(source.indexOf('async function ensureSameDateRegimeReady('),source.indexOf('async function finalizeUpdateChain('))
    assert(regime.indexOf('ensureDailyMarketBreadth(env, triggerTime)') < regime.indexOf('prepareIndicatorRegime(env'))
  } finally { globalThis.fetch=fetch; f.close() }
})
