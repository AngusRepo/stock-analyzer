import assert from 'node:assert/strict'
import test from 'node:test'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { withPaperExecutionScope,advancePaperExecutionClock } from './paperExecutionScope'
import { writeSwingState,readSwingState } from './paperSwingLifecycle'
import { SWING_POLICY_VERSION } from './paperSwingPolicy'
import { swingExitEvaluator } from './paperSwingRuntime'
import { checkExitConditions } from './paperExitPolicy'
import { preparePositionTakeProfit } from './positionExitArbiter'
import { adjustCanonicalCorporatePriceBasis } from './canonicalTradeLifecycle'
const lifecycle=writeSwingState({version:'canonical_trade_lifecycle_v1'},
  {policy:SWING_POLICY_VERSION,entryDate:'2026-10-02',entryPrice:100,entryOrLow:97})
const position={symbol:'2340',shares:1000,avg_cost:100,entry_price:100,initial_stop:92,trailing_stop:105,
  highest_since_entry:115,tp1_price:103,tp2_price:106,tp1_hit:1,original_shares:1000,entry_date:'2026-10-02',
  stop_multiplier:2,trade_lifecycle_json:lifecycle}
test('versioned position bypasses legacy TP, break-even, ML SELL and TP progress',()=>{
  const f=l4NativeFixture()
  try {
    for(const price of [94,104,150]) assert.equal(checkExitConditions(position,price,3,true,true,f.cfg).action,'hold')
    assert.equal(checkExitConditions(position,92,3,true,false,f.cfg).reason,'swing_hard_stop_8')
    assert.equal(preparePositionTakeProfit({lifecycle,entryDate:position.entry_date,tp1Hit:false,positionShares:1000,
      decision:{action:'hold',reason:'swing_hold'}}).progress,null)
    const adjusted=readSwingState(adjustCanonicalCorporatePriceBasis(lifecycle,.5,['split']))!
    assert.equal(adjusted.entryPrice,50);assert.equal(adjusted.entryOrLow,48.5)
  } finally {f.close()}
})
test('real daily adapter persists ORL intent; rebound and missing data do not cancel exit',async()=>{
 const f=l4NativeFixture();f.ports.nowMs=Date.parse('2026-10-05T09:04:00+08:00')
 try {
  f.sqls.core.exec("INSERT INTO stocks(id,symbol,name) VALUES(1,'0050','ETF'),(2,'2340','stock')")
  f.sqls.market.exec("INSERT INTO stock_prices(stock_id,date,close) VALUES(1,'2026-10-02',100),(2,'2026-10-02',96)")
  f.sqls.paper.prepare('INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,trade_lifecycle_json) VALUES(1,?,?,?,?,?)')
    .run('2340','stock',1000,100,lifecycle)
  const pos={...position}
  await withPaperExecutionScope(f.ports,async()=>{
    const run=swingExitEvaluator(f.env,[pos],'2026-10-05')
    assert.equal((await run(pos,105))?.action,'hold')
    assert.equal(readSwingState(pos.trade_lifecycle_json)?.pendingExit?.reason,'swing_daily_orl')
    f.sqls.market.exec('DELETE FROM stock_prices')
    advancePaperExecutionClock(Date.parse('2026-10-05T09:05:00+08:00'))
    const restart=swingExitEvaluator(f.env,[pos],'2026-10-05')
    assert.equal((await restart(pos,105))?.reason,'swing_daily_orl')
    assert.equal((await restart(pos,90))?.reason,'swing_hard_stop_8')
  })
 } finally {f.close()}
})
test('missing calendar holds without legacy fallback; catastrophic stop still works',async()=>{
 const f=l4NativeFixture();f.ports.nowMs=Date.parse('2026-10-05T09:05:00+08:00')
 try {
 f.sqls.paper.prepare('INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,trade_lifecycle_json) VALUES(1,?,?,?,?,?)').run('2340','stock',1000,100,lifecycle)
 await withPaperExecutionScope(f.ports,async()=>{
   const pos={...position}
   const run=swingExitEvaluator(f.env,[pos],'2026-10-05')
   assert.match((await run(pos,150))!.reason,/evidence_wait/)
   assert.equal((await run(pos,90))?.action,'full_sell')
   assert.equal((await run(pos,110))?.reason,'swing_hard_stop_8','unfilled disaster exit survives rebound')
 })}finally{f.close()}
})

test('missing benchmark weekday cannot shorten twenty-session holding age',async()=>{
 const f=l4NativeFixture();f.ports.nowMs=Date.parse('2026-10-06T10:00:00+08:00')
 try {
  f.sqls.core.exec("INSERT INTO stocks(id,symbol,name) VALUES(1,'0050','ETF'),(2,'2340','stock')")
  f.sqls.market.exec("INSERT INTO stock_prices(stock_id,date,close) VALUES(1,'2026-10-02',100),(2,'2026-10-02',100)")
  await withPaperExecutionScope(f.ports,async()=>{
    const result=await swingExitEvaluator(f.env,[position],'2026-10-06')(position,105)
    assert.match(result!.reason,/calendar_session_missing:2026-10-05/)
  })
 }finally{f.close()}
})

test('historical closes use corporate-adjusted ORL coordinates; day20 intent survives unavailable depth',async()=>{
 const f=l4NativeFixture();const dates:string[]=[]
 for(let ms=Date.parse('2026-10-02T00:00:00Z');dates.length<21;ms+=86400000)
   if(![0,6].includes(new Date(ms).getUTCDay()))dates.push(new Date(ms).toISOString().slice(0,10))
 const last=dates[20];f.ports.nowMs=Date.parse(last+'T13:24:00+08:00')
 try {
  f.sqls.core.exec("INSERT INTO stocks(id,symbol,name) VALUES(1,'0050','ETF'),(2,'2340','stock')")
  for(const d of dates.slice(0,20))f.sqls.market.prepare('INSERT INTO stock_prices(stock_id,date,close) VALUES(1,?,100),(2,?,?)').run(d,d,d===dates[0]?98:49)
  const raw=adjustCanonicalCorporatePriceBasis(lifecycle,.5,['split'],dates[1])!
  f.sqls.paper.prepare('INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,trade_lifecycle_json) VALUES(1,?,?,?,?,?)').run('2340','stock',1000,50,raw)
  const pos={...position,trade_lifecycle_json:raw}
  await withPaperExecutionScope(f.ports,async()=>{
    assert.equal((await swingExitEvaluator(f.env,[pos],last)(pos,50))?.reason,'swing_20_sessions')
    assert.equal(readSwingState(pos.trade_lifecycle_json)?.pendingExit?.reason,'swing_20_sessions')
    f.sqls.market.exec('DELETE FROM stock_prices')
    assert.equal((await swingExitEvaluator(f.env,[pos],last)(pos,55))?.reason,'swing_20_sessions')
  })
 }finally{f.close()}
})


test('expiry fill cannot cross 13:25 while awaiting settlement metadata',async()=>{
 const {executePaperSellBatch}=await import('./paperSellTransaction')
 const f=l4NativeFixture(),cutoff=Date.parse('2026-10-02T13:25:00+08:00')
 try{
  f.ports.nowMs=cutoff-1
  const original=f.env.KV.get.bind(f.env.KV)
  f.env.KV.get=async(...args:any[])=>{advancePaperExecutionClock(cutoff);return original(...args)}
  await withPaperExecutionScope(f.ports,async()=>{
   await assert.rejects(executePaperSellBatch(f.env,[
    f.env.PAPER_DB.prepare("UPDATE paper_accounts SET cash=cash+1 WHERE id=1"),
    f.env.PAPER_DB.prepare("UPDATE paper_accounts SET cash=cash+1 WHERE id=1")
   ],'2340',1,cutoff),/submission_window_expired/)
   assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_settlements').get()?.n,0)
  })
 }finally{f.close()}
})
