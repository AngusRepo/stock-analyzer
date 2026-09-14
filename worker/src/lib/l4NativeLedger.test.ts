import assert from 'node:assert/strict'
import test from 'node:test'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { l4BuySettlementStatements } from './paperOrderIntent'
import { withPaperExecutionScope } from './paperExecutionScope'
import { getUnsettledSettlementSummary, computePaperTotalValue } from './paperAccountValue'

test('native L4 buy ledger publishes partial fill with T+2 liability atomically and rolls back failed batch',async()=>{
  const f=l4NativeFixture(),db=f.ports.databases.paper
  try {
    const input={symbol:'2330',totalCost:40057,tradeDate:'2026-09-14',settlementDate:'2026-09-16',intentKey:'fixture-intent',status:'partial' as const}
    f.sqls.paper.exec("INSERT INTO paper_order_intents(intent_key,account_id,trade_date,symbol,side,source,status) VALUES('fixture-intent',1,'2026-09-14','2330','buy','auto_ml','running')")
    const statements=()=>[
      db.prepare("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost) VALUES(1,'2330','fixture',400,100.1425)"),
      db.prepare("INSERT INTO paper_orders(account_id,symbol,name,side,shares,price,commission,tax,total_cost,source,note) VALUES(1,'2330','fixture','buy',400,100,57,0,40057,'auto_ml',?)").bind(JSON.stringify({intent_key:input.intentKey})),
      ...l4BuySettlementStatements(f.env,input)]
    await assert.rejects(withPaperExecutionScope(f.ports,()=>db.batch([...statements(),db.prepare('INSERT INTO missing_fixture_table VALUES(1)')])),/missing_fixture_table/)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_orders').get()?.n,0)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_positions').get()?.n,0)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_settlements').get()?.n,0)
    assert.equal(f.sqls.paper.prepare('SELECT status FROM paper_order_intents').get()?.status,'running')
    await withPaperExecutionScope(f.ports,()=>db.batch(statements()))
    const intent=f.sqls.paper.prepare('SELECT status,order_id FROM paper_order_intents').get()
    assert.equal(intent?.status,'partial')
    const settlement=f.sqls.paper.prepare('SELECT order_id,amount,settlement_date FROM paper_settlements').get()
    assert.equal(settlement?.order_id,intent?.order_id)
    assert.equal(settlement?.amount,40057)
    assert.equal(settlement?.settlement_date,'2026-09-16')
    const summary=await getUnsettledSettlementSummary(db,1)
    assert.equal(computePaperTotalValue({settledCash:1e6,positionsValue:40000,netUnsettledSettlement:summary.netUnsettledSettlement}),999943)
  } finally {f.close()}
})
