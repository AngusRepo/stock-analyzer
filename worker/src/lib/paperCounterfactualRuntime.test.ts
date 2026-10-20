import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createCounterfactualRecorder, counterfactualZ, counterfactualSizing, counterfactualTarget,
  counterfactualCorporateCoverage, pollPaperCounterfactualLots } from './paperCounterfactualRuntime'
import { sealDailyReview } from './paperDailyPlan'
import type { FiveSlotDecision } from './fiveSlotCapitalAllocator'
import type { IntradayOHLC } from './paperIntradayData'
import type { CorporateActionSnapshot } from './paperCorporateActions'
import { openCounterfactualLot, type CounterfactualLot } from './paperCounterfactual'
import { listOpenCounterfactualLots, readCounterfactualLot } from './paperCounterfactualStore'
import { resolveAuthoritativeBuyExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { withPaperExecutionScope } from './paperExecutionScope'
import { SWING_POLICY_VERSION, type SwingEntryDecision } from './paperSwingPolicy'
import type { L4PortfolioPlan } from './l4PortfolioPlan'
import type { PendingBuy } from './pendingBuyStore'

const date='2026-10-15', now=Date.parse(date+'T09:25:00+08:00'), next='2026-10-16'
const identity={artifact_id:'base',cohort_id:'cohort',payload_checksum:'a'.repeat(64),base_artifact_set_checksum:'b'.repeat(64)}
const plan={plan_id:'1'.repeat(64),model_checksum:'2'.repeat(64),l3_identity:identity,signal_date:'2026-10-14',targets:{}} as unknown as L4PortfolioPlan
const pending={symbol:'2337',watch_points:['l4_plan:'+plan.plan_id]} as PendingBuy
const signal:SwingEntryDecision={policy:SWING_POLICY_VERSION,action:'pass',reason:'swing_or15_vwap_relative_strength',
  signalMs:now,submitUntilMs:now+60_000,orLow:95,conditions:{or_touch:true},maxBuyPrice:101}
function book(ms=now) {
  return resolveAuthoritativeBuyExecutionSnapshot({nowMs:ms,limitPrice:100,lotType:'odd_lot',observations:[{
    source:'shioaji_hub',lotType:'odd_lot',bid:100,ask:100,bidPrices:[100],askPrices:[100],
    bidVolumes:[100],askVolumes:[100],volumeUnit:'shares',sourceTime:new Date(ms).toISOString(),
  }]})
}
function fixture() {
  const f=l4NativeFixture()
  f.sqls.paper.exec(readFileSync(new URL('../../domain-migrations/paper/0012_counterfactual_recorder.sql',import.meta.url),'utf8'))
  const errors:unknown[]=[]
  const recorder=()=>createCounterfactualRecorder({db:f.env.PAPER_DB,accountId:1,now:()=>now,
    readPlan:async()=>plan,onError:error=>errors.push(error)},date)
  return {...f,recorder,errors}
}

test('blocked before sizing records missing quantity and leaves account/orders untouched; delivery is idempotent',async()=>{
  const f=fixture()
  try {
    const before=f.sqls.paper.prepare('SELECT * FROM paper_accounts').all()
    for(let i=0;i<2;i++) {
      const recorder=f.recorder()
      recorder.observe(pending,{...signal,action:'defer',reason:'swing_atr_day_veto'})
      await recorder.flush()
    }
    const rows=f.sqls.paper.prepare('SELECT reason,evidence_json FROM paper_counterfactual_signals_v1').all()
    assert.equal(rows.length,1);assert.equal(rows[0].reason,'quantity_not_reached_before_block')
    const evidence=JSON.parse(String(rows[0].evidence_json))
    assert.equal(evidence.requested_shares,null);assert.equal(evidence.fill,null);assert.equal(evidence.z,null)
    assert.equal(evidence.blocked_reason,'swing_atr_day_veto')
    assert.equal((await listOpenCounterfactualLots(f.env.PAPER_DB,1)).length,0)
    assert.deepEqual(f.sqls.paper.prepare('SELECT * FROM paper_accounts').all(),before)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_orders').get()?.n,0)
    assert.deepEqual(f.errors,[])
  } finally {f.close()}
})

test('sized rejection uses the exact captured quantity/book once; a later successful fill is excluded',async()=>{
  const f=fixture()
  try {
    const sizing={shares:100,limitPrice:100,snapshot:book()},recorder=f.recorder()
    recorder.observe(pending,signal);recorder.sized(pending.symbol,sizing)
    sizing.shares=99 // Caller mutation after observation must not rewrite the evidence.
    recorder.blocked(pending.symbol,'paper_order_risk_blocked')
    await recorder.flush();await recorder.flush()
    const lots=await listOpenCounterfactualLots(f.env.PAPER_DB,1)
    assert.equal(lots.length,1);assert.equal(lots[0].lot.entryShares,100)
    assert.equal(lots[0].lot.source.blockedReason,'paper_order_risk_blocked')
    assert.equal(lots[0].lot.source.quantitySource,'paper_entry_same_snapshot')
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_counterfactual_events_v1').get()?.n,1)
    const filled=f.recorder()
    filled.observe({...pending,symbol:'2330'},signal)
    filled.sized('2330',{shares:100,limitPrice:100,snapshot:book()})
    filled.blocked('2330','temporary_wait');filled.filled('2330')
    await filled.flush()
    assert.equal((await listOpenCounterfactualLots(f.env.PAPER_DB,1)).length,1)
    assert.deepEqual(f.errors,[])
  } finally {f.close()}
})

test('missing tables or conflicting evidence do not throw into Paper execution',async()=>{
  const f=fixture()
  try {
    f.sqls.paper.exec('DROP TABLE paper_counterfactual_lots_v1')
    const recorder=f.recorder()
    recorder.observe(pending,{...signal,action:'defer',reason:'swing_atr_day_veto'})
    await assert.doesNotReject(recorder.flush())
    assert.equal(f.errors.length,1)
  } finally {f.close()}
})

test('raw z requires the same frozen full-pool forecast, model and eight-model identity',()=>{
  const source={signalSha:'3'.repeat(64),planId:plan.plan_id,modelSha:plan.model_checksum,l3Identity:identity}
  const p:any={...plan,p6_projection:{schema_version:'p6-full-pool-projection-v1',signal_date:plan.signal_date,
    model_checksum:plan.model_checksum,l3_identity:identity,forecast_checksum:'4'.repeat(64),source_pool_checksum:'5'.repeat(64)},
    targets:{2337:{distribution:{symbol:'2337',z:-.4,model_checksum:plan.model_checksum,
      source_forecast_checksum:'4'.repeat(64),source_pool_checksum:'5'.repeat(64)}}}}
  assert.equal(counterfactualZ(p,{symbol:'2337',source}),-.4)
  assert.equal(counterfactualZ({...p,model_checksum:'6'.repeat(64)},{symbol:'2337',source}),null)
  assert.equal(counterfactualZ({...p,l3_identity:{...identity,artifact_id:'changed'}},{symbol:'2337',source}),null)
  assert.equal(counterfactualZ(p,{symbol:'2330',source}),null)
  p.targets['2337'].distribution.source_forecast_checksum='7'.repeat(64)
  assert.equal(counterfactualZ(p,{symbol:'2337',source}),null)
  assert.equal(counterfactualZ(plan,{symbol:'2337',source}),null)
})

test('runtime resumes an unheld research lot next day using observed depth; all three ORL exits leave Paper ledger unchanged',async()=>{
  const f=fixture()
  try {
    const recorder=f.recorder()
    recorder.observe(pending,signal);recorder.sized('2337',{shares:100,limitPrice:100,snapshot:book()})
    recorder.blocked('2337','paper_order_risk_blocked');await recorder.flush()
    f.sqls.core.exec("INSERT INTO stocks(id,symbol,name) VALUES(1,'2337','fixture'),(2,'0050','benchmark')")
    f.sqls.market.prepare('INSERT INTO stock_prices(stock_id,date,close) VALUES(?,?,?)').run(1,date,94)
    f.sqls.market.prepare('INSERT INTO stock_prices(stock_id,date,close) VALUES(?,?,?)').run(2,date,100)
    f.ports.nowMs=Date.parse(next+'T09:05:00+08:00')
    f.env.SHIOAJI_PROXY_URL='https://fixture.invalid'
    let calls=0
    f.ports.fetchFrozen=async(url:RequestInfo|URL,init?:RequestInit)=>{
      assert.equal(String(url),'https://fixture.invalid/orderbooks');calls++
      assert.deepEqual(JSON.parse(String(init?.body)),{symbols:['2337'],lot_type:'odd_lot'})
      const time=new Date(f.ports.nowMs).toISOString()
      return Response.json({data:{2337:{status:'ok',last:94,bid:94,ask:94,source_time:time,received_at:time,
        lot_type:'odd_lot',volume_unit:'shares',bid_prices:[94],ask_prices:[94],bid_volumes:[100],ask_volumes:[100]}}})
    }
    const before=f.sqls.paper.prepare('SELECT * FROM paper_accounts').all()
    const blocked=await withPaperExecutionScope(f.ports,()=>pollPaperCounterfactualLots(f.env,next))
    assert.deepEqual(blocked.result,{observed:1,errors:[]});assert.equal(calls,1)
    assert.equal((await listOpenCounterfactualLots(f.env.PAPER_DB,1)).length,1)
    const unknown=JSON.parse(String(f.sqls.paper.prepare('SELECT evidence_json FROM paper_counterfactual_events_v1 WHERE version=1').get()?.evidence_json)).events
    assert.ok(unknown.every((event:any)=>event.status==='unknown'&&event.reason==='corporate_snapshot_missing:'+next))
    f.kvs.set('market:corporate_actions:v1:'+next,JSON.stringify(corporateSnapshot(next)))
    f.ports.nowMs+=1000
    const result=await withPaperExecutionScope(f.ports,()=>pollPaperCounterfactualLots(f.env,next))
    assert.deepEqual(result.result,{observed:1,errors:[]});assert.equal(calls,2)
    assert.equal((await listOpenCounterfactualLots(f.env.PAPER_DB,1)).length,0)
    const persisted=JSON.parse(String(f.sqls.paper.prepare('SELECT evidence_json FROM paper_counterfactual_events_v1 WHERE version=2').get()?.evidence_json))
    const events=persisted.events
    assert.equal(persisted.input.corporateEvidence[0].source_checksum,'8'.repeat(64))
    assert.equal((await readCounterfactualLot(f.env.PAPER_DB,1,`${date}:2337:${now}`))?.lot.corporateThroughDate,next)
    assert.equal(events.length,3)
    assert.ok(events.every((event:any)=>event.status==='closed'&&event.reason==='swing_daily_orl'&&event.z===null))
    assert.deepEqual(f.sqls.paper.prepare('SELECT * FROM paper_accounts').all(),before)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_positions').get()?.n,0)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_orders').get()?.n,0)
    assert.deepEqual((await withPaperExecutionScope(f.ports,()=>pollPaperCounterfactualLots(f.env,next))).result,{observed:0,errors:[]})
  } finally {f.close()}
})

function corporateSnapshot(day: string): CorporateActionSnapshot {
  return {schema_version:'paper-corporate-source-v1',session_date:day,observed_at:day+'T08:00:00+08:00',
    source_checksum:'8'.repeat(64),covered_symbols:['2337'],actions:[],blockers:{},tax_basis:'gross_before_personal_tax'}
}
test('research sizing uses the allocator cap and observed lot book; veto, stale, wrong lot and late data stay missing',async()=>{
  const quote:IntradayOHLC={last:100,low:99,high:101,referencePrice:100,bid:100,ask:100,source:'shioaji',
    lotType:'odd_lot',volumeUnit:'shares',bidPrices:[100],askPrices:[100],bidVolumes:[100],askVolumes:[100],
    quoteTime:new Date(now).toISOString(),confirmationTime:new Date(now).toISOString()}
  const input={nowMs:now,signal,quote,decision:{action:'buy',budgetCap:10_000,reason:'l4_target'} as FiveSlotDecision,
    context:{exact_cash:20_000,exact_nav:100_000},minPositionValue:10_000,slippageTicks:1,maxBookAgeMs:1500,maxDisagreementTicks:1,
    preTrade:{symbol:'2337',currentPrice:100,entryPrice:100,bestAsk:100,previousClose:100,quoteAgeMs:0,
      quoteSource:'shioaji' as const,marketRiskLevel:'normal',technical:{action:'defer',reason:'swing_atr_day_veto'},
      policy:{limitUpPct:.1,requoteDeviationMax:.1,requoteDiscount:.01,requoteStopFallback:.08}}}
  const before=JSON.stringify(input),result=counterfactualSizing(input)
  assert.equal(result.sizing?.shares,100)
  assert.equal(result.sizing?.quantitySource,'paper_allocator_counterfactual_snapshot')
  assert.equal(JSON.stringify(input),before)
  assert.equal(counterfactualSizing({...input,decision:{...input.decision,action:'skip',reason:'risk_cap'}}).reason,'counterfactual_allocator:risk_cap')
  assert.equal(counterfactualSizing({...input,decision:{...input.decision,budgetCap:100_000}}).reason,'execution_lot_type_mismatch')
  assert.equal(counterfactualSizing({...input,nowMs:now+60_000}).reason,'signal_observation_window_missed')
  assert.equal(counterfactualSizing({...input,nowMs:now+2000}).sizing,null)
  const f=fixture()
  try {
    const recorder=f.recorder()
    recorder.observe(pending,{...signal,action:'defer',reason:'swing_atr_day_veto'})
    recorder.sized('2337',result.sizing!)
    await recorder.flush()
    const lot=(await listOpenCounterfactualLots(f.env.PAPER_DB,1))[0].lot
    assert.equal(lot.entryShares,100)
    assert.equal(lot.source.sizingEvidence?.sizing_fill_price,100)
    assert.equal(lot.source.quantitySource,'paper_allocator_counterfactual_snapshot')
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_orders').get()?.n,0)
  } finally {f.close()}
})
test('explicit zero target binds signed review, known time and model; absent/conditional/positive targets do not liquidate',async()=>{
  const p:L4PortfolioPlan={...plan,schema_version:'l4-portfolio-plan-v1',owner:'l4_distribution',account_id:1,parent_plan_id:null,
    policy_identity:'c'.repeat(64),nav_at_decision:100_000,
    account_anchor:{order_watermark:0,cash:100_000,positions:[],settlement:{unsettledBuyAmount:0,unsettledSellAmount:0}},
    weights:{2337:0},targets:{2337:{weight:0,current_weight:.1,locked:false,expected_return_gross:null}},
    constraints:{exposure_cap:.8,name_cap:.3,min_weight:.03,max_positions:5},
    proof:{within_tolerance:true,preselection:false,absolute_objective_gap:0,tolerance:1e-8,evaluated_candidate_count:1},
    opb:{enabled:false,status:'fixed',arm_id:'base'},
    sealed_execution:{schema_version:'l4-sealed-execution-v1',rotation_mode:'selected_ready_or_filled',expiry:'retain_until_next_seal',
      exit_rules:{2337:{mode:'unconditional',reason:'explicit_zero'}}}}
  p.execution_review=await sealDailyReview({plan:p,tradeDate:date,nowMs:Date.parse(date+'T08:00:00+08:00'),contextHash:'d'.repeat(64),restrictions:[]})
  const lot=openCounterfactualLot({lotId:'target',accountId:1,symbol:'2337',date,signalMs:now,nowMs:now,
    observableUntilMs:now+60_000,requestedShares:100,limitPrice:100,entryOrLow:95,snapshot:book(),
    source:{signalSha:'3'.repeat(64),planId:plan.plan_id,modelSha:plan.model_checksum,l3Identity:identity}}).lot!
  const target=await counterfactualTarget(p,lot,date,now,100)
  assert.equal(target.targetExit?.shares,100)
  assert.ok(target.targetExit?.decisionId.includes(p.execution_review.checksum))
  assert.equal((await counterfactualTarget(p,{...lot,symbol:'2330'},date,now,100)).reason,'target_symbol_not_explicit')
  assert.equal((await counterfactualTarget(p,lot,next,now,100)).targetExit,null)
  assert.equal((await counterfactualTarget(p,lot,date,Date.parse(date+'T07:59:00+08:00'),100)).targetExit,null)
  assert.equal((await counterfactualTarget({...p,model_checksum:'9'.repeat(64)},lot,date,now,100)).targetExit,null)
  assert.equal((await counterfactualTarget({...p,execution_review:{...p.execution_review,checksum:'0'.repeat(64)}},lot,date,now,100)).reason,'target_review_invalid')
  assert.equal((await counterfactualTarget({...p,sealed_execution:undefined},lot,date,now,100)).reason,'target_rotation_readiness_missing')
  const positive:L4PortfolioPlan={...p,sealed_execution:undefined,execution_review:undefined,weights:{2337:.1},
    targets:{2337:{...p.targets['2337'],weight:.1}}}
  positive.execution_review=await sealDailyReview({plan:positive,tradeDate:date,nowMs:Date.parse(date+'T08:00:00+08:00'),contextHash:'d'.repeat(64),restrictions:[]})
  assert.equal((await counterfactualTarget(positive,lot,date,now,100)).reason,'target_reduction_requires_research_account_anchor')
})
test('corporate coverage cannot infer missing data is zero or apply a later snapshot retroactively',async()=>{
  const lot={symbol:'2337',swing:{entryDate:date}} as CounterfactualLot
  const input={lot,date:next,nowMs:Date.parse(next+'T09:05:00+08:00'),calendar:[date,next],
    read:async()=>corporateSnapshot(next)}
  assert.equal((await counterfactualCorporateCoverage(input)).throughDate,next)
  assert.equal((await counterfactualCorporateCoverage({...input,read:async()=>null})).reason,'corporate_snapshot_missing:'+next)
  assert.equal((await counterfactualCorporateCoverage({...input,read:async()=>({...corporateSnapshot(next),covered_symbols:[]})})).reason,'corporate_symbol_not_covered:'+next)
  const action={action_id:'cash-1',symbol:'2337',kind:'cash' as const,ex_date:next,payable_date:null,cash_per_share:2,stock_per_share:0}
  assert.equal((await counterfactualCorporateCoverage({...input,read:async()=>({...corporateSnapshot(next),actions:[action]})})).reason,'corporate_research_adjustment_required:'+next+':cash-1')
  assert.equal((await counterfactualCorporateCoverage({...input,lot:{...lot,corporateThroughDate:next},
    read:async()=>({...corporateSnapshot(next),actions:[action]})})).reason,'corporate_research_adjustment_required:'+next+':cash-1')
  assert.ok((await counterfactualCorporateCoverage({...input,read:async()=>({...corporateSnapshot(next),observed_at:next+'T10:00:00+08:00'})})).reason?.startsWith('corporate_snapshot_invalid:'))
})
