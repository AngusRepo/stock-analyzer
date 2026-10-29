import assert from 'node:assert/strict'
import test from 'node:test'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { PAPER_ORDER_SIZING_INSERT as WRITE } from './paperEntryTasks'

test('paper_order_sizing_v1 keeps the first value per order and rejects invalid ones', () => {
  const f=l4NativeFixture()
  try {
    const db=f.sqls.paper
    const value=(id:number)=>db.prepare('SELECT portfolio_value v FROM paper_order_sizing_v1 WHERE order_id=?').get(id)?.v
    db.prepare(WRITE).run(7,1_000_000)
    db.prepare(WRITE).run(7,5)
    db.prepare('INSERT OR REPLACE INTO paper_order_sizing_v1 (order_id, portfolio_value) VALUES (?, ?)').run(7,9)
    assert.equal(value(7),1_000_000)
    assert.throws(()=>db.prepare('UPDATE paper_order_sizing_v1 SET portfolio_value=1 WHERE order_id=7').run(),/append_only/)
    assert.throws(()=>db.prepare('DELETE FROM paper_order_sizing_v1 WHERE order_id=7').run(),/append_only/)
    // Invalid values throw into the writer's catch (warn + system_log), never vanish silently.
    for(const bad of [0,-5,null]) assert.throws(()=>db.prepare(WRITE).run(8,bad),/constraint/i)
    assert.equal(value(8),undefined)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM paper_order_sizing_v1').get()?.n,1)
  } finally {f.close()}
})
