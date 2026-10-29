import test from 'node:test'
import assert from 'node:assert/strict'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { withPaperExecutionScope } from './paperExecutionScope'
import { checkP8DailyPnl } from './riskChecks/p8DailyPnl'
import { RISK_CONFIG_FIXTURE } from './riskConfig.testSupport'
const deps={defaults:{halt:false,maxPositionPct:.08,buyConfThreshold:.6,sellConfThreshold:.65},effectiveBuy:.6,effectiveSell:.65}
test('P8 uses current NAV against explicit previous session, not two stale closes or T+2 cash',async()=>{
  const f=l4NativeFixture()
  try {
    const add=(date:string,nav:number)=>f.sqls.paper.prepare('INSERT INTO paper_daily_snapshots(account_id,date,cash,positions_value,total_value,pnl,pnl_pct) VALUES(1,?,?,0,?,0,0)').run(date,nav,nav)
    add('2026-09-10',1e6);add('2026-09-11',950000)
    assert.equal((await withPaperExecutionScope(f.ports,()=>checkP8DailyPnl(f.env.PAPER_DB,RISK_CONFIG_FIXTURE,deps))).result,null)
    const ctx={tradeDate:'2026-09-14',previousSession:'2026-09-11',currentNav:920000,netExternalFlow:0}
    const check=(c=ctx)=>withPaperExecutionScope(f.ports,()=>checkP8DailyPnl(f.env.PAPER_DB,RISK_CONFIG_FIXTURE,deps,c))
    assert.equal((await check()).result?.halt,true)
    assert.equal((await check({...ctx,currentNav:900000,netExternalFlow:-50000})).result,null)
    assert.equal((await check({...ctx,currentNav:950000})).result,null)
    add('2026-09-15',800000) // A future row cannot contaminate the current session.
    assert.equal((await check({...ctx,currentNav:950000})).result,null)
    assert.equal((await check({...ctx,currentNav:NaN})).result?.halt,true)
  } finally {f.close()}
})
test('P8 blocks new buys when the previous-session snapshot is missing, except for a never-marked untraded account',async()=>{
  const f=l4NativeFixture()
  try {
    const add=(date:string,nav:number)=>f.sqls.paper.prepare('INSERT INTO paper_daily_snapshots(account_id,date,cash,positions_value,total_value,pnl,pnl_pct) VALUES(1,?,?,0,?,0,0)').run(date,nav,nav)
    const ctx={tradeDate:'2026-09-14',previousSession:'2026-09-11',currentNav:990000,netExternalFlow:0}
    const check=(c=ctx)=>withPaperExecutionScope(f.ports,()=>checkP8DailyPnl(f.env.PAPER_DB,RISK_CONFIG_FIXTURE,deps,c))
    // Fresh account: no snapshot, no order -> initial cash is the baseline (1% loss passes, 5% halts on loss).
    assert.equal((await check()).result,null)
    const fresh=(await check({...ctx,currentNav:950000})).result
    assert.equal(fresh?.halt,true)
    assert.match(fresh!.reason,/當日虧損/)
    // Any snapshot exists but the previous session's is missing -> fail closed.
    add('2026-09-09',1e6)
    const missing=(await check()).result
    assert.equal(missing?.halt,true)
    assert.match(missing!.reason,/^P8 risk check unavailable: previous_session_snapshot_missing:2026-09-11$/)
    // An extra later row cannot stand in for the previous session.
    add('2026-09-12',1e6)
    assert.match((await check()).result!.reason,/previous_session_snapshot_missing:2026-09-11/)
    add('2026-09-11',1e6)
    assert.equal((await check()).result,null)
  } finally {f.close()}
})
test('P8 keeps a fresh account on initial cash through its first-day fills, treats earlier orders without a snapshot as missing, and a zero baseline as invalid',async()=>{
  const f=l4NativeFixture()
  try {
    const ctx={tradeDate:'2026-09-14',previousSession:'2026-09-11',currentNav:990000,netExternalFlow:0}
    const check=()=>withPaperExecutionScope(f.ports,()=>checkP8DailyPnl(f.env.PAPER_DB,RISK_CONFIG_FIXTURE,deps,ctx))
    // Two first-day buys (09:00 and 10:00 TW) do not take the fresh-account baseline away.
    f.sqls.paper.exec("INSERT INTO paper_orders(account_id,symbol,side,shares,price,total_cost,created_at) VALUES(1,'2330','buy',1000,20,20000,'2026-09-14T01:00:00Z'),(1,'2317','buy',1000,30,30000,'2026-09-14T02:00:00Z')")
    assert.equal((await check()).result,null)
    // 2026-09-13T17:00Z is 09-14 01:00 TW: still today's order, not an earlier session's.
    f.sqls.paper.exec("INSERT INTO paper_orders(account_id,symbol,side,shares,price,total_cost,created_at) VALUES(1,'2330','buy',1,20,20,'2026-09-13T17:00:00Z')")
    assert.equal((await check()).result,null)
    // An order from an earlier TW session (09-11 23:30 TW = 15:30Z) without a snapshot is a gap, not a fresh account.
    f.sqls.paper.exec("INSERT INTO paper_orders(account_id,symbol,side,shares,price,total_cost,created_at) VALUES(1,'2330','buy',1000,20,20000,'2026-09-11T15:30:00Z')")
    assert.match((await check()).result!.reason,/previous_session_snapshot_missing:2026-09-11/)
    f.sqls.paper.exec("INSERT INTO paper_daily_snapshots(account_id,date,cash,positions_value,total_value,pnl,pnl_pct) VALUES(1,'2026-09-11',0,0,0,0,0)")
    assert.match((await check()).result!.reason,/previous_session_snapshot_invalid:2026-09-11/)
  } finally {f.close()}
})
