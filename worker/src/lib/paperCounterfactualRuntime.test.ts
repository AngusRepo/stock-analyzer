import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createCounterfactualRecorder, counterfactualZ, pollPaperCounterfactualLots } from './paperCounterfactualRuntime'
import { listOpenCounterfactualLots } from './paperCounterfactualStore'
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
    const result=await withPaperExecutionScope(f.ports,()=>pollPaperCounterfactualLots(f.env,next))
    assert.deepEqual(result.result,{observed:1,errors:[]});assert.equal(calls,1)
    assert.equal((await listOpenCounterfactualLots(f.env.PAPER_DB,1)).length,0)
    const events=JSON.parse(String(f.sqls.paper.prepare('SELECT evidence_json FROM paper_counterfactual_events_v1 WHERE version=1').get()?.evidence_json)).events
    assert.equal(events.length,3)
    assert.ok(events.every((event:any)=>event.status==='closed'&&event.reason==='swing_daily_orl'&&event.z===null))
    assert.deepEqual(f.sqls.paper.prepare('SELECT * FROM paper_accounts').all(),before)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_positions').get()?.n,0)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_orders').get()?.n,0)
    assert.deepEqual((await withPaperExecutionScope(f.ports,()=>pollPaperCounterfactualLots(f.env,next))).result,{observed:0,errors:[]})
  } finally {f.close()}
})
