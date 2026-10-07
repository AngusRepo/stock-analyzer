import fs from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import {l4NativeFixture} from './l4NativeFixture.testSupport'
import {getAvailableCash} from './dateUtils'

const sql=fs.readFileSync(new URL('../../../tools/repair_paper_3004_odd_lot_fee_20261007.sql',import.meta.url),'utf8')
const statements=sql.split(';').map(s=>s.trim()).filter(Boolean)

function fixture(){
  const f=l4NativeFixture(),db=f.sqls.paper
  db.exec(`UPDATE paper_accounts SET cash=933951.13 WHERE id=1;
    INSERT INTO paper_orders(id,account_id,symbol,name,side,shares,price,commission,tax,total_cost,source,note,created_at)
      VALUES(96,1,'3004','3004','buy',31,122,20,0,3802,'auto_ml','{"retained":"original intent"}','2026-10-07 04:10:21');
    INSERT INTO paper_positions(id,account_id,symbol,name,shares,avg_cost,entry_price,entry_date)
      VALUES(2,1,'3004','3004',31,3802.0/31,122,'2026-10-07');
    INSERT INTO paper_settlements(id,account_id,order_id,symbol,side,amount,trade_date,settlement_date,settled)
      VALUES(84,1,96,'3004','buy',3802,'2026-10-07','2026-10-12',0);
    INSERT INTO paper_execution_events(id,account_id,trade_date,symbol,event_type,status,reason,detail_json,order_id)
      VALUES(170752,1,'2026-10-07','3004','paper_order','partial','paper_order_partial_fill','{"immutable":"original evidence"}',96);`)
  return f
}
const rows=(f:ReturnType<typeof fixture>)=>({
  orders:f.sqls.paper.prepare('SELECT * FROM paper_orders ORDER BY id').all(),
  positions:f.sqls.paper.prepare('SELECT * FROM paper_positions ORDER BY id').all(),
  settlements:f.sqls.paper.prepare('SELECT * FROM paper_settlements ORDER BY id').all(),
  events:f.sqls.paper.prepare('SELECT * FROM paper_execution_events ORDER BY id').all(),
  accounts:f.sqls.paper.prepare('SELECT * FROM paper_accounts ORDER BY id').all(),
})
const repair=(f:ReturnType<typeof fixture>,extra:string[]=[])=>f.env.PAPER_DB.batch(
  [...statements,...extra].map(s=>f.env.PAPER_DB.prepare(s)))

test('order96 correction updates cost/T+2 liability once, preserving price, cash and original evidence',async()=>{
  const f=fixture()
  try{
    const cash=await getAvailableCash(f.env.PAPER_DB,1)
    await repair(f)
    const order:any=f.sqls.paper.prepare('SELECT * FROM paper_orders WHERE id=96').get()
    assert.equal(order.price,122);assert.equal(order.shares,31);assert.equal(order.commission,5);assert.equal(order.total_cost,3787)
    assert.equal(JSON.parse(order.note).retained,'original intent')
    assert.equal(JSON.parse(order.note).fee_correction.monthly_rebate,0)
    assert.equal(f.sqls.paper.prepare('SELECT avg_cost FROM paper_positions WHERE id=2').get()?.avg_cost,3787/31)
    assert.equal(f.sqls.paper.prepare('SELECT amount FROM paper_settlements WHERE id=84').get()?.amount,3787)
    assert.equal(f.sqls.paper.prepare('SELECT settled FROM paper_settlements WHERE id=84').get()?.settled,0)
    assert.equal(f.sqls.paper.prepare('SELECT cash FROM paper_accounts WHERE id=1').get()?.cash,933951.13)
    assert.equal(await getAvailableCash(f.env.PAPER_DB,1),cash+15)
    assert.equal(f.sqls.paper.prepare('SELECT detail_json FROM paper_execution_events WHERE id=170752').get()?.detail_json,'{"immutable":"original evidence"}')
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_execution_events WHERE status='completed' AND event_type='accounting_correction'").get()?.n,1)
    const beforeRetry=rows(f)
    await repair(f)
    assert.deepEqual(rows(f),beforeRetry)
  }finally{f.close()}
})

for(const stale of [
  "UPDATE paper_positions SET shares=30 WHERE id=2",
  "UPDATE paper_orders SET commission=19 WHERE id=96",
  "UPDATE paper_settlements SET settled=1 WHERE id=84",
  "INSERT INTO paper_orders(account_id,symbol,side,shares,price,total_cost,created_at) VALUES(1,'3004','buy',1,122,123,'2026-10-07 05:00:00')",
])test('correction rejects changed account state: '+stale,async()=>{
  const f=fixture()
  try{f.sqls.paper.exec(stale);const before=rows(f);await repair(f);assert.deepEqual(rows(f),before)}finally{f.close()}
})

test('correction failure rolls back every order, position, settlement and audit mutation',async()=>{
  const f=fixture()
  try{
    const before=rows(f)
    await assert.rejects(repair(f,['INSERT INTO missing_fee_correction_fixture VALUES(1)']),/missing_fee_correction_fixture/)
    assert.deepEqual(rows(f),before)
  }finally{f.close()}
})
