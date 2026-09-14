import assert from 'node:assert/strict'
import test from 'node:test'
import { captureL4AccountContext } from './l4AccountContext'
import { withPaperExecutionScope } from './paperExecutionScope'
import { l4NativeFixture as fixture } from './l4NativeFixture.testSupport'


test('real account capture uses canonical cash, settlement, risk caps and rejects running writers',async()=>{
  const f=fixture()
  try {
    const first=await withPaperExecutionScope(f.ports,()=>captureL4AccountContext(f.env,'2026-09-11'))
    assert.equal(first.result.risk_limits.buys_halted,true) // Missing risk evidence never grants buy authority.
    assert.equal(first.result.risk_limits.exposure_cap,0)
    assert.equal(first.result.nav,1000000)
    assert.equal(first.result.available_cash,1000000)
    assert.equal(first.result.account_anchor.cash,1000000)
    assert.equal(first.result.observed_at,'2026-09-14T00:00:00.000Z')
    assert.equal(first.result.fees.buy_cost,f.cfg.fees.commission)
    f.sqls.core.exec("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','fixture','TWSE')")
    f.sqls.market.exec("INSERT INTO stock_prices(stock_id,date,close) VALUES(1,'2026-09-11',110)")
    f.sqls.paper.exec("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_date,entry_price) VALUES(1,'2330','fixture',100,100,'2026-09-10',100)")
    f.sqls.paper.exec("INSERT INTO paper_settlements(account_id,order_id,symbol,side,amount,trade_date,settlement_date) VALUES(1,1,'A','buy',10000,'2026-09-11','2026-09-15')")
    const next=await withPaperExecutionScope(f.ports,()=>captureL4AccountContext(f.env,'2026-09-11'))
    assert.equal(next.result.available_cash,990000)
    assert.equal(next.result.nav,1001000)
    assert.equal(next.result.holdings[0].market_value,11000)
    assert.equal(next.result.complete,true)
    assert.equal(next.result.account_anchor.settlement.unsettledBuyAmount,10000)
    f.sqls.paper.exec("INSERT INTO paper_order_intents(intent_key,account_id,trade_date,symbol,side,source,status) VALUES('x',1,'2026-09-14','A','buy','test','running')")
    const blocked=await withPaperExecutionScope(f.ports,()=>captureL4AccountContext(f.env,'2026-09-11'))
    assert.equal(blocked.result.complete,false)
    await assert.rejects(withPaperExecutionScope(f.ports,()=>captureL4AccountContext(f.env,'2026-08-01')),/signal_expired/)
  } finally {f.close()}
})
