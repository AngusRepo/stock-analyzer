import test from 'node:test'
import assert from 'node:assert/strict'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { withPaperExecutionScope } from './paperExecutionScope'
import { checkP8DailyPnl } from './riskChecks/p8DailyPnl'
import { DEFAULT_RISK_CONFIG } from './riskConfig'
const deps={defaults:{halt:false,maxPositionPct:.08,buyConfThreshold:.6,sellConfThreshold:.65},effectiveBuy:.6,effectiveSell:.65}
test('P8 uses current NAV against explicit previous session, not two stale closes or T+2 cash',async()=>{
  const f=l4NativeFixture()
  try {
    const add=(date:string,nav:number)=>f.sqls.paper.prepare('INSERT INTO paper_daily_snapshots(account_id,date,cash,positions_value,total_value,pnl,pnl_pct) VALUES(1,?,?,0,?,0,0)').run(date,nav,nav)
    add('2026-09-10',1e6);add('2026-09-11',950000)
    assert.equal((await withPaperExecutionScope(f.ports,()=>checkP8DailyPnl(f.env.PAPER_DB,DEFAULT_RISK_CONFIG,deps))).result,null)
    const ctx={tradeDate:'2026-09-14',previousSession:'2026-09-11',currentNav:920000,netExternalFlow:0}
    const check=(c=ctx)=>withPaperExecutionScope(f.ports,()=>checkP8DailyPnl(f.env.PAPER_DB,DEFAULT_RISK_CONFIG,deps,c))
    assert.equal((await check()).result?.halt,true)
    assert.equal((await check({...ctx,currentNav:900000,netExternalFlow:-50000})).result,null)
    assert.equal((await check({...ctx,currentNav:950000})).result,null)
    add('2026-09-15',800000) // A future row cannot contaminate the current session.
    assert.equal((await check({...ctx,currentNav:950000})).result,null)
    assert.equal((await check({...ctx,currentNav:NaN})).result?.halt,true)
  } finally {f.close()}
})
