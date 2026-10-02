import fs from 'node:fs'
import {finalizeSinglePlan} from './premarketSinglePlan'
import { sealDailyReview,persistDailyReview } from './paperDailyPlan'
import { SWING_POLICY_VERSION } from './paperSwingPolicy'
import { runDailySnapshot } from './paperWorkerTasks'
import { settlePaperT2 } from './paperSettlementTasks'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runIntradayCheck } from './paperEntryTasks'
import { pollIntradayStopLoss, runEODExit } from './paperExitTasks'
import { persistPendingBuyActiveState } from './pendingBuyStore'
import { getTradingConfig } from './tradingConfig'
import { DEFAULT_RISK_CONFIG } from './riskConfig'
import { DEFAULT_ADAPTIVE_PARAMS } from './adaptiveConfig'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { buildMarketRegimeState } from './marketRegimeState'
import { captureL4AccountContext } from './l4AccountContext'
import { setupMorningPendingBuys } from './pendingBuyOrchestrator'
import { withPaperExecutionScope } from './paperExecutionScope'
import { storeL4PortfolioPlan } from './l4PortfolioPlan'
import { loadPendingBuySnapshot } from './pendingBuyStore'

for(const scenario of ['daily_orl','hard_stop','20_sessions']) test(`native swing full entry / ${scenario} exit through broker adapter`,async()=>{
  const f=l4NativeFixture()
  f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
  f.env.PAPER_INTRADAY_ENTRY_OWNER=SWING_POLICY_VERSION
  f.sqls.paper.exec(fs.readFileSync(new URL('../../domain-migrations/paper/0007_daily_plan_reviews.sql',import.meta.url),'utf8'))
  f.ports.allocateL4Private=async()=>{throw new Error('fixture_plan_already_supplied')}
  f.env.SHIOAJI_PROXY_URL='https://fixture.invalid'
  f.env.ML_CONTROLLER_URL='https://fixture.invalid'
  f.env.FINLAB_L5_MARKET_DATA_ENABLED='true'
  let quotePrice=20
  let limitedExitDepth=false
  let oddExitDepth=true
  f.ports.fetchFrozen=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input),time=new Date(f.ports.nowMs).toISOString()
    const quote={symbol:'2330',status:'ok',source_time:time,received_at:time,confirmed_at:time,
      quote_age_ms:0,source_age_ms:0,lot_type:'board_lot',volume_unit:'lots',
      last:20,price:20,open:20,high:20.5,low:19.5,reference_price:20,total_volume:100000,
      bid:20,ask:20,bid_prices:[20,19.95,19.9,19.85,19.8],ask_prices:[20,20.05,20.1,20.15,20.2],
      bid_volume:10,ask_volume:1,bid_volumes:[10,10,10,10,10],ask_volumes:[1,0,0,0,0]}
    if(quotePrice!==20)Object.assign(quote,{last:quotePrice,price:quotePrice,bid:quotePrice,ask:quotePrice,bid_prices:[quotePrice,quotePrice-.05,quotePrice-.1,quotePrice-.15,quotePrice-.2]})
    const odd=url.includes('lot_type=odd_lot') || String(init?.body ?? '').includes('odd_lot')
    if(odd)Object.assign(quote,{lot_type:'odd_lot',volume_unit:'shares',bid_volume:10000,ask_volume:10000,bid_volumes:[10000,10000,10000,10000,10000],ask_volumes:[10000,10000,10000,10000,10000]})
    if(limitedExitDepth)Object.assign(quote,odd
      ? {bid_volume:oddExitDepth?10000:0,bid_volumes:oddExitDepth?[10000,0,0,0,0]:[0,0,0,0,0]}
      : {bid_volume:1,bid_volumes:[1,0,0,0,0]})
    if(url.includes('orderbooks') || url.includes('snapshots') || url.includes('/quotes'))return Response.json({data:{'2330':quote}})
    if(url.includes('/orderbook/'))return Response.json({data:quote})
    if(url.includes('trend'))return Response.json({slope_5min:.002})
    if(url.includes('/snapshot/'))return Response.json({data:quote})
    if(url.includes('/l5-market-data'))return Response.json({status:'ok',quotes:{'2330':{...quote,provider:'shioaji_proxy_orderbook',ask_volumes:[1,1,1,1,1]}}})
    if(url.includes('twse.com.tw'))return Response.json({stat:'OK',data:[]})
    if(url.includes('tpex.org.tw'))return Response.json([])
    if(url.includes('/kbars/')) {
      const px=url.includes('/0050')?100:20
      const open=Date.parse('2026-09-14T09:00:00+08:00')
      return Response.json({status:'ok',source:'streaming_tick_accumulator',completed_only:true,
        data:Array.from({length:20},(_,i)=>({ts:new Date(open+i*60000).toISOString(),open:px,high:px,low:px,close:px,volume:100}))})
    }
    if(url.includes('taifex'))return new Response('',{status:503})
    throw new Error('unseeded_native_source:'+url)
  }
  try {
    f.kvs.set('trading:risk_config',JSON.stringify(DEFAULT_RISK_CONFIG))
    f.kvs.set('ml:adaptive_params',JSON.stringify({...DEFAULT_ADAPTIVE_PARAMS,recent_accuracy_30d:.6,provenance:{...DEFAULT_ADAPTIVE_PARAMS.provenance,source:'ml-controller',fallback:false}}))
    f.sqls.core.exec("INSERT INTO market_risk(date,twii_close,risk_score,risk_level) VALUES('2026-09-11',30000,10,'green'),('2026-09-10',30000,10,'green')")
    f.sqls.market.exec("INSERT INTO market_breadth(date,advance_ratio,bull_alignment_pct) VALUES('2026-09-11',.6,.6)")
    f.sqls.market.exec("INSERT INTO market_regime_factor_packets(date,schema_version,score,level,factor_json,contribution_json,source_json,freshness_json,missing_reason_json,lineage_json,generated_at) VALUES('2026-09-11','market-regime-factor-packet-v1',10,'green','[]','{}','{}','{}','{}','{}','2026-09-11T14:00:00Z')")
    f.kvs.set('market_regime_state',JSON.stringify(buildMarketRegimeState({label:'bull_market',runDate:'2026-09-11',computedAt:'2026-09-11T14:00:00Z'})))
    f.sqls.learning.exec("CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER PRIMARY KEY,artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT)")
    const l3={artifact_id:'l3-fixture',cohort_id:'cohort-fixture',payload_checksum:'a'.repeat(64),base_artifact_set_checksum:'b'.repeat(64)}
    f.sqls.learning.prepare('INSERT INTO active8_ensemble_pointer_v1(singleton_id,artifact_id,cohort_id,payload_checksum,base_artifact_set_checksum) VALUES(1,?,?,?,?)').run(...Object.values(l3))
    f.cfg.l4Distribution={scope:'private_research',constraints:{exposure_cap:.8,name_cap:.08,min_weight:.03,max_positions:5},artifact:{schema_version:'l4-distribution-v1',feature_schema:'full-l3-30-all-available-signals-v3',model_checksum:'c'.repeat(64),l3_identity:l3}} as any
    f.kvs.set('trading:config',JSON.stringify(f.cfg))
    const account=(await withPaperExecutionScope(f.ports,()=>captureL4AccountContext(f.env,'2026-09-11'))).result
    assert.equal(account.risk_limits.buys_halted,false)
    f.sqls.core.exec("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','fixture','TWSE'),(2,'0050','benchmark','TWSE')")
    const dates:string[]=[]
    for(let ms=Date.parse('2026-09-11T00:00:00Z');dates.length<60;ms-=86400000)
      if(![0,6].includes(new Date(ms).getUTCDay()))dates.unshift(new Date(ms).toISOString().slice(0,10))
    for(const d of dates)f.sqls.market.prepare('INSERT INTO stock_prices(stock_id,date,close) VALUES(2,?,?)').run(d,d===dates.at(-1)?100:98)
    f.sqls.market.exec("INSERT INTO stock_prices(stock_id,date,open,high,low,close,avg_price,volume) VALUES(1,'2026-09-11',20,20.5,19.5,20,20,1000000)")
    f.sqls.core.prepare(`INSERT INTO daily_recommendations(stock_id,symbol,name,date,rank,score,reason,signal,confidence,has_buy_signal,eligible_for_ml,eligible_for_pending_buy,alpha_allocation)
      VALUES(1,'2330','fixture','2026-09-11',1,50,'synthetic fixture','HOLD',.5,0,1,1,?)`).run(JSON.stringify({engine:'sparse_tangent_inverse_risk',selected:false}))
    const allocateNative=(context:any,cap=.08)=>{
      const python=process.env.NAV_TEST_PYTHON ?? fileURLToPath(new URL('../../../../../ml-service/.venv/Scripts/python.exe',import.meta.url))
      const script=fileURLToPath(new URL('../../../ml-controller/tests/l4_native_chain_allocator.py',import.meta.url))
      const result=spawnSync(python,['-B',script],{input:JSON.stringify({account:context,identity:l3,
        reward_ledger:f.sqls.paper.prepare('SELECT payload_json FROM l4_policy_account_rewards_v1 WHERE known_date < ?').all(context.signal_date).map(row=>JSON.parse(String(row.payload_json))),
        constraints:{...f.cfg.l4Distribution!.constraints,buy_cost:.001425,sell_cost:.004425,name_cap:cap}}),encoding:'utf8'})
      assert.equal(result.status,0,result.stderr)
      const parsed=JSON.parse(result.stdout.split('\n').find(line=>line.startsWith('{"policy"'))!)
      f.cfg.l4Distribution=parsed.policy
      f.kvs.set('trading:config',JSON.stringify(f.cfg))
      return parsed.envelope
    }
    const envelope=allocateNative(account),plan=envelope.plan
    assert.equal(plan.proof.preselection,false)
    assert.ok(plan.input_attribution.candidate_input_checksums['2330'])
    const canonical_payload=envelope.canonical_payload
    await withPaperExecutionScope(f.ports,()=>storeL4PortfolioPlan(f.env,envelope))
    await withPaperExecutionScope(f.ports,()=>setupMorningPendingBuys(f.env))
    const snapshot=(await withPaperExecutionScope(f.ports,()=>loadPendingBuySnapshot(f.env,'2026-09-14',{allowFallbackRecent:false}))).result
    assert.equal(snapshot.pendingBuys.length,1)
    assert.equal(snapshot.pendingBuys[0].symbol,'2330')
    assert.equal(snapshot.pendingBuys[0].ml_entry_price,20)
    assert.ok(snapshot.pendingBuys[0].watch_points.includes('l4_execution_reference:canonical_signal_close'))
    assert.equal(snapshot.pendingBuys[0].debate_verdict,'PENDING')
    // Synthetic external debate result, fed through the original state writer.
    await withPaperExecutionScope(f.ports,()=>persistPendingBuyActiveState(f.env,'2026-09-14',
      snapshot.pendingBuys.map(row=>({...row,debate_verdict:'APPROVED',debate_status:'completed' as any})),{...snapshot.meta,status:'ready'}))
    await withPaperExecutionScope(f.ports,async()=>{
      const input={plan_id:plan.plan_id,signal_date:'2026-09-11',context_hash:'f'.repeat(64)}
      const review=await finalizeSinglePlan(f.env,'2026-09-14',input)
      assert.equal(review.ready,true)
      assert.deepEqual(await finalizeSinglePlan(f.env,'2026-09-14',input),review)
    })
    f.ports.nowMs=Date.parse('2026-09-14T01:20:00Z')
    const result=await withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env))
    assert.equal(result.production_effect,false)
    assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,1000)
    assert.equal(f.sqls.paper.prepare('SELECT status FROM paper_order_intents').get()?.status,'partial')
    assert.equal(f.sqls.paper.prepare('SELECT amount FROM paper_settlements').get()?.amount,20029)
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,1)
    const holding:any=f.sqls.paper.prepare('SELECT * FROM paper_positions').get()
    assert.equal(holding.tp1_price,null);assert.equal(holding.tp2_price,null)
    assert.equal(holding.initial_stop,holding.entry_price*.92)
    assert.equal(JSON.parse(holding.trade_lifecycle_json).swing.entryOrLow,20)
    for(let i=0;i<2;i++){
      f.ports.nowMs+=300000
      await withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env))
    }
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,1)
    assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,1000)
    // Continue the very same account and actual filled lot across sessions.
    const sessions:string[]=[]
    for(let ms=Date.parse('2026-09-14T00:00:00Z');sessions.length<21;ms+=86400000)
      if(![0,6].includes(new Date(ms).getUTCDay()))sessions.push(new Date(ms).toISOString().slice(0,10))
    const exitDay=scenario==='20_sessions'?sessions[20]:sessions[1]
    for(const day of sessions.filter(d=>d<exitDay)) {
      f.sqls.market.prepare('INSERT INTO stock_prices(stock_id,date,close) VALUES(2,?,100)').run(day)
      f.sqls.market.prepare('INSERT INTO stock_prices(stock_id,date,close) VALUES(1,?,?)').run(day,scenario==='daily_orl'?19.8:20)
    }
    quotePrice=scenario==='hard_stop'?18.3:20
    f.ports.nowMs=Date.parse(exitDay+(scenario==='20_sessions'?'T13:24:00+08:00':'T09:05:00+08:00'))
    await withPaperExecutionScope(f.ports,()=>pollIntradayStopLoss(f.env,{halt:false,forceLiquidate:false,targetExposurePct:1,maxPositionPct:.2} as any))
    const exits:any[]=f.sqls.paper.prepare("SELECT * FROM paper_orders WHERE side='sell'").all()
    assert.equal(exits.length,1,JSON.stringify(f.sqls.paper.prepare("SELECT reason,detail_json FROM paper_execution_events WHERE side='sell'").all()))
    assert.match(exits[0].note,new RegExp('swing_'+scenario))
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_positions WHERE shares>0').get()?.n,0)
  } finally {f.close()}
})
