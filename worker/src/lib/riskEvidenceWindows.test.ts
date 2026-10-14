import assert from 'node:assert/strict'
import test from 'node:test'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { withPaperExecutionScope } from './paperExecutionScope'
import { checkP7Streak, independentPredictionCohorts } from './riskChecks/p7Streak'
import { checkP5Losses,evaluateBoundedLosses, type P5LossGuardPolicy } from './riskChecks/p5Losses'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'
import { checkCanonicalMarketRestriction } from './riskChecks/canonicalMarketRestriction'
import { checkP3MarketRisk } from './riskChecks/p3MarketRisk'
import { checkP4Breadth } from './riskChecks/p4Breadth'
import { sellReceiptExitCategory } from './paperExitAttribution'
const deps={defaults:{halt:false,maxPositionPct:.08,buyConfThreshold:.6,sellConfThreshold:.65},effectiveBuy:.6,effectiveSell:.65}
test('P5 recognizes explicit legacy stop codes without treating L4 losses or unknown reasons as stops',()=>{
  assert.equal(sellReceiptExitCategory({reason:'[intraday] swing_hard_stop_8 (mkt=30.3, -1 tick fill)'}),'hard_stop')
  assert.equal(sellReceiptExitCategory({reason:'[intraday] swing_daily_orl (mkt=120, -1 tick fill)'}),'structural_stop')
  assert.equal(sellReceiptExitCategory({reason:'[intraday] [L4Target] plan=abc;target=0 (mkt=471.5, -1 tick fill)'}),'model_rotation')
  assert.equal(sellReceiptExitCategory({reason:'unknown',realized_pnl:-5000}),'unknown')
  assert.equal(sellReceiptExitCategory({reason:'swing_hard_stop_8_extra'}),'unknown')
  assert.equal(sellReceiptExitCategory({reason:'swing_hard_stop_8',exit_category:'model_rotation'}),'model_rotation')
  const policy:P5LossGuardPolicy={lookbackSessions:5,releaseAfterSessions:2,channel:'stopouts',minimumLossValue:0,minimumClosedTrades:3,maximumClosedTrades:5,scale:.5}
  const rows=['swing_hard_stop_8','swing_daily_orl','s12_position_structural_stop_full_exit','[L4Target] plan=x;target=0']
    .map((reason,i)=>({symbol:String(i),created_at:'2026-10-14 01:00:00',note:JSON.stringify({reason,
      entry_date:'2026-10-01',realized_pnl:-10})}))
  const result=evaluateBoundedLosses(rows,[],['2026-10-14'],policy)
  assert.equal(result.losses,3);assert.equal(result.total,3);assert.equal(result.triggered,true)
})
test('P7 ignores stale models, future labels, duplicate stocks and overlapping label windows',async()=>{
  const f=l4NativeFixture();f.ports.nowMs=Date.parse('2026-10-14T10:00:00+08:00')
  try {
    f.sqls.learning.exec("CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER PRIMARY KEY,artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT);INSERT INTO active8_ensemble_pointer_v1 VALUES(1,'current','cohort','checksum','base')")
    const ev={artifact_id:'current',cohort_id:'cohort',artifact_checksum:'checksum',base_artifact_set_checksum:'base',forecast_horizon_bars:5}
    const add=(date:string,end:string,extra={})=>f.sqls.learning.prepare(`INSERT INTO predictions(stock_id,model_name,prediction_date,generated_at,verified_at,
      direction_correct,verification_label_schema_version,verification_label_end_date,verification_label_known_date,forecast_data)
      VALUES(1,'ensemble',?,'2026-09-01 00:00:00','2026-10-13 00:00:00',0,?,?,?,?)`).run(date,
        'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4',end,end,JSON.stringify({ensemble_v2:{...ev,...extra}}))
    add('2026-10-01','2026-10-09');add('2026-10-02','2026-10-12');add('2026-10-05','2026-10-13')
    for(let i=0;i<10;i++)add('2026-10-05','2026-10-13')
    for(const date of ['2026-08-01','2026-08-10','2026-08-20','2026-09-01','2026-09-10'])add(date,date,{artifact_id:'stale'})
    add('2026-10-06','2026-10-15')
    const check=()=>withPaperExecutionScope(f.ports,()=>checkP7Streak(f.env.LEARNING_DB,DEFAULT_TRADING_CONFIG,deps))
    assert.equal((await check()).result,null)
    for(const [date,end] of [['2026-09-01','2026-09-07'],['2026-09-08','2026-09-14'],['2026-09-15','2026-09-21'],['2026-09-22','2026-09-28']])add(date,end)
    assert.equal((await check()).result?.maxPositionPct,.024)
    const selected=independentPredictionCohorts([{date:'2026-10-05',end_date:'2026-10-13',accuracy:0,samples:100},
      {date:'2026-10-02',end_date:'2026-10-12',accuracy:0,samples:100}])
    assert.equal(selected.length,1)
  } finally {f.close()}
})
test('P5 groups partial exits, separates rotation from stops and expires by sessions',()=>{
  const policy:P5LossGuardPolicy={lookbackSessions:5,releaseAfterSessions:2,channel:'stopouts',minimumLossValue:0,minimumClosedTrades:3,maximumClosedTrades:5,scale:.5}
  const sessions=['2026-10-14','2026-10-13','2026-10-12','2026-10-09','2026-10-08']
  const sell=(symbol:string,date:string,category='hard_stop')=>({symbol,created_at:date+' 03:00:00',price:10,shares:1,
    note:JSON.stringify({entry_date:'2026-10-01',realized_pnl:-10,exit_category:category})})
  const partials=[sell('2327',sessions[0]),sell('2327',sessions[0]),sell('3374',sessions[0],'model_rotation')]
  assert.equal(evaluateBoundedLosses(partials,[],sessions,policy).triggered,false)
  const three=[...partials,sell('2308',sessions[0]),sell('2337',sessions[0])]
  assert.equal(evaluateBoundedLosses(three,[],sessions,policy).triggered,true)
  assert.equal(evaluateBoundedLosses(three,[{symbol:'2327',entry_date:'2026-10-01'}],sessions,policy).triggered,false)
  assert.equal(evaluateBoundedLosses(['A','B','C'].map(s=>sell(s,sessions[2])),[],sessions,policy).triggered,false)
  const all=evaluateBoundedLosses(three,[],sessions,{...policy,channel:'net_pnl'})
  assert.equal(all.losses,4);assert.equal(all.netPnl,-50)
  const gain=sell('GAIN',sessions[0],'model_rotation');gain.note=JSON.stringify({entry_date:'2026-10-01',realized_pnl:100,exit_category:'model_rotation'})
  assert.equal(evaluateBoundedLosses([...three,gain],[],sessions,{...policy,channel:'net_pnl'}).triggered,false)
  const earlierGain=sell('2327','2026-10-07')
  earlierGain.note=JSON.stringify({entry_date:'2026-10-01',realized_pnl:100,exit_category:'model_rotation'})
  assert.equal(evaluateBoundedLosses([...three,earlierGain],[],sessions,policy).losses,2,
    'a trade closed inside the window includes earlier partial-sale gains')
})
test('P5 database window reads all partial proceeds of each recently closed position',async()=>{
  const f=l4NativeFixture();f.ports.nowMs=Date.parse('2026-10-14T10:00:00+08:00')
  try {
    const add=(symbol:string,day:string,pnl:number)=>f.sqls.paper.prepare(`INSERT INTO paper_orders
      (account_id,symbol,side,shares,price,total_cost,note,created_at) VALUES(1,?,'sell',1,10,10,?,?)`)
      .run(symbol,JSON.stringify({entry_date:'2026-10-01',realized_pnl:pnl,exit_category:'hard_stop'}),day+' 01:00:00')
    add('A','2026-10-07',100)
    for(const s of ['A','B','C'])add(s,'2026-10-14',-10)
    const window={sessions:['2026-10-14','2026-10-13','2026-10-12'],policy:{lookbackSessions:3,releaseAfterSessions:2,
      channel:'stopouts' as const,minimumLossValue:0,minimumClosedTrades:3,maximumClosedTrades:5,scale:.5}}
    assert.equal((await withPaperExecutionScope(f.ports,()=>checkP5Losses(f.env.PAPER_DB,deps,window))).result,null)
    add('D','2026-10-14',-10)
    assert.equal((await withPaperExecutionScope(f.ports,()=>checkP5Losses(f.env.PAPER_DB,deps,window))).result?.maxPositionPct,.04)
  } finally {f.close()}
})

test('one market owner preserves old P3/P4 minima and hard halts without multiplication',async()=>{
  for(const level of ['green','orange','red','black']) {
    const context:any={status:'ready',level,targetExposureCap:.45,deRiskExistingPositions:true,reasons:['test'],
      blockers:[],breadthLevel:level==='green'?null:level,advanceRatio:.1,bullAlignmentRatio:.1}
    const [a,b,merged]=await Promise.all([checkP3MarketRisk(context,DEFAULT_TRADING_CONFIG,deps),
      checkP4Breadth(context,DEFAULT_TRADING_CONFIG,deps),checkCanonicalMarketRestriction(context,DEFAULT_TRADING_CONFIG,deps)])
    assert.equal(merged?.maxPositionPct,Math.min(a?.maxPositionPct ?? .08,b?.maxPositionPct ?? .08))
    assert.equal(merged?.halt,Boolean(a?.halt||b?.halt))
    assert.equal(merged?.marketRestrictionEvidence.aggregation,'minimum_not_product')
  }
})
