import fs from 'node:fs'
import {finalizeSinglePlan} from './premarketSinglePlan'
import {readL4ExecutionPlan} from './paperDailyPlanRuntime'
import {requestL4Replan} from './l4Replan'
import { sealDailyReview,persistDailyReview } from './paperDailyPlan'
import { SWING_POLICY_VERSION } from './paperSwingPolicy'
import { runDailySnapshot } from './paperWorkerTasks'
import { settlePaperT2 } from './paperSettlementTasks'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runIntradayCheck } from './paperEntryTasks'
import { pollIntradayStopLoss, runEODExit } from './paperExitTasks'
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
import { withPaperExecutionScope, advancePaperExecutionClock } from './paperExecutionScope'
import { storeL4PortfolioPlan } from './l4PortfolioPlan'
import { loadPendingBuySnapshot, replacePendingBuyState } from './pendingBuyStore'
import { latchAtrOnce } from './paperAtrOnceState'
import { ATR_ONCE_POLICY } from './paperAtrOnce'

for(const scenario of ['daily_orl','hard_stop','20_sessions','closing_auction','atr_veto','missing_book','unchanged_stream_book','atr_sparse_warmup','atr_sparse_missing','clock_domain','clock_domain_stale','clock_domain_dead_heartbeat','odd_lot_fee','holding_503_recovery','all_books_missing','controller_static_book','wide_live_book','submit_expired']) test(
  scenario==='missing_book'?'native swing missing broker book updates baseline without entry'
    : scenario==='unchanged_stream_book'?'native swing enters on unchanged live stream book'
      :`native swing full entry / ${scenario} exit through broker adapter`,async()=>{
  const f=l4NativeFixture()
  f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
  f.env.PAPER_INTRADAY_ENTRY_OWNER=SWING_POLICY_VERSION
  f.sqls.paper.exec(fs.readFileSync(new URL('../../domain-migrations/paper/0007_daily_plan_reviews.sql',import.meta.url),'utf8'))
  f.ports.allocateL4Private=async()=>{throw new Error('fixture_plan_already_supplied')}
  f.env.SHIOAJI_PROXY_URL='https://fixture.invalid'
  if(scenario.startsWith('atr_sparse')) {
    f.env.S12_RESEARCH_KBARS_URL='https://fixture.invalid'
    f.env.PROXY_SERVICE_TOKEN='test-token'
  }
  f.env.ML_CONTROLLER_URL='https://fixture.invalid'
  f.env.FINLAB_L5_MARKET_DATA_ENABLED='true'
  let quotePrice=20
  let limitedExitDepth=false
  let oddExitDepth=true
  let initialStaticBookMissing=true
  let warmupRequests=0
  let l5Returned=false
  let boardReads=0
  let holdingUnavailable=false
  const preparePaper=f.env.PAPER_DB.prepare.bind(f.env.PAPER_DB)
  f.env.PAPER_DB.prepare=(query:string)=>{
    if((scenario.startsWith('clock_domain') || scenario==='submit_expired') && l5Returned) {
      // Account/risk work elapses AFTER L5 quality, BEFORE the final HTTP read.
      // This is processing time, not six seconds of fresh-book transport.
      f.ports.nowMs+=scenario==='submit_expired'?61_000:6_000
      advancePaperExecutionClock(f.ports.nowMs)
      l5Returned=false
    }
    return preparePaper(query)
  }
  f.ports.fetchFrozen=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input)
    const time=new Date(f.ports.nowMs).toISOString()
    if(url.includes('/atr-warmup/')) {
      warmupRequests++
      if(scenario==='atr_sparse_missing')return new Response('ticks unavailable',{status:504})
      return Response.json({status:'ok',source:'shioaji_ticks_atr_warmup_v1',completed_only:true,
        data:Array.from({length:6},(_,i)=>({ts:`2026-09-11T13:${20+i}:00+08:00`,open:20,high:20,low:20,close:20,volume:i===0?1:0}))})
    }
    if(url.includes('/orderbook/watchlist'))return Response.json({status:'ok',symbols:['2330'],lot_type:'odd_lot'})
    const quote={symbol:'2330',status:'ok',source_time:time,received_at:time,confirmed_at:time,
      quote_age_ms:0,source_age_ms:0,lot_type:'board_lot',volume_unit:'lots',
      last:20,price:20,open:20,high:20.5,low:19.5,reference_price:20,total_volume:100000,
      bid:20,ask:20,bid_prices:[20,19.95,19.9,19.85,19.8],ask_prices:[20,20.05,20.1,20.15,20.2],
      bid_volume:10,ask_volume:1,bid_volumes:[10,10,10,10,10],ask_volumes:[1,0,0,0,0]}
    if(['unchanged_stream_book','controller_static_book','submit_expired'].includes(scenario) && time.startsWith('2026-09-14'))Object.assign(quote,{
      source_time:new Date(f.ports.nowMs-20_000).toISOString(),confirmation_mode:'quote_session_static_book',
      stream_heartbeat_age_ms:200,session_epoch:7,
    })
    if(scenario.startsWith('clock_domain'))Object.assign(quote,{
      source_time:new Date(f.ports.nowMs-6_000).toISOString(),
      confirmed_at:new Date(f.ports.nowMs+24).toISOString(),
      source_age_ms:6_024,quote_age_ms:scenario==='clock_domain_stale'?2_000:0,
      confirmation_mode:'quote_session_static_book',session_epoch:7,
      stream_heartbeat_age_ms:scenario==='clock_domain_dead_heartbeat'?11_000:633,
    })
    if(quotePrice!==20)Object.assign(quote,{last:quotePrice,price:quotePrice,bid:quotePrice,ask:quotePrice,bid_prices:[quotePrice,quotePrice-.05,quotePrice-.1,quotePrice-.15,quotePrice-.2]})
    const odd=url.includes('lot_type=odd_lot') || String(init?.body ?? '').includes('odd_lot')
    if(odd)Object.assign(quote,{lot_type:'odd_lot',volume_unit:'shares',bid_volume:10000,ask_volume:10000,bid_volumes:[10000,10000,10000,10000,10000],ask_volumes:[10000,10000,10000,10000,10000]})
    if(odd && ['odd_lot_fee','holding_503_recovery'].includes(scenario))Object.assign(quote,{ask_volume:31,ask_volumes:[31,0,0,0,0]})
    if(scenario==='wide_live_book')Object.assign(quote,{ask:20.5,ask_prices:[20.5,20.55,20.6,20.65,20.7]})
    if(holdingUnavailable && odd && url.includes('orderbook'))return new Response('odd lot unavailable',{status:503})
    if(url.includes('orderbook') && !url.includes('watchlist') && !odd) {
      boardReads++
      if(boardReads===3 && (scenario.startsWith('clock_domain') || scenario==='submit_expired'))l5Returned=true
    }
    if(limitedExitDepth)Object.assign(quote,odd
      ? {bid_volume:oddExitDepth?10000:0,bid_volumes:oddExitDepth?[10000,0,0,0,0]:[0,0,0,0,0]}
      : {bid_volume:1,bid_volumes:[1,0,0,0,0]})
    if(holdingUnavailable && (url.includes('snapshots') || url.includes('/quotes')))return Response.json({data:{}})
    if(url.includes('orderbooks') || url.includes('snapshots') || url.includes('/quotes')){
      const missing=['missing_book','all_books_missing'].includes(scenario) || (scenario==='unchanged_stream_book'
        && initialStaticBookMissing && url.includes('orderbooks'))
      if(scenario==='unchanged_stream_book' && url.includes('orderbooks'))initialStaticBookMissing=false
      return Response.json({data:missing?(scenario==='all_books_missing'?{}:{'0050':{...quote,symbol:'0050'}}):{'2330':quote}})
    }
    if(scenario==='all_books_missing' && url.includes('/orderbook/'))return new Response('no book',{status:503})
    if(url.includes('/orderbook/'))return Response.json({data:quote})
    if(url.includes('trend'))return Response.json({slope_5min:.002})
    if(url.includes('/snapshot/'))return Response.json({data:quote})
    if(url.includes('/l5-market-data')) {
      if(scenario==='controller_static_book')throw new Error('swing_must_not_reenter_lossy_controller_quote_adapter')
      l5Returned=true
      return Response.json({status:'ok',quotes:scenario==='unchanged_stream_book'
      ? {} : {'2330':{...quote,source_time:scenario.startsWith('clock_domain')?new Date(f.ports.nowMs-80).toISOString():quote.source_time,
        provider:'shioaji_proxy_orderbook',ask_volumes:[1,1,1,1,1]}}})
    }
    if(url.includes('twse.com.tw'))return Response.json({stat:'OK',data:[]})
    if(url.includes('tpex.org.tw'))return Response.json([])
    if(url.includes('/kbars/')) {
      if(scenario.startsWith('atr_sparse') && url.includes('start=2026-09-11'))return Response.json({data:[
        {ts:'2026-09-11T13:20:00+08:00',open:20,high:20,low:20,close:20,volume:1},
        {ts:'2026-09-11T13:25:00+08:00',open:20,high:20,low:20,close:20,volume:1},
      ]})
      const px=url.includes('/0050')?100:20
      const open=Date.parse('2026-09-14T09:00:00+08:00')
      if(scenario.startsWith('atr_sparse'))return Response.json({status:'ok',source:'streaming_tick_accumulator',completed_only:true,
        data:Array.from({length:25},(_,i)=>({ts:new Date(open+i*60000).toISOString(),open:px+(px===20&&i>=15?.1:0),high:px+(px===20&&i>=15?.1:0),low:px+(px===20&&i>=15?.1:0),close:px+(px===20&&i>=15?.1:0),volume:100}))})
      return Response.json({status:'ok',source:'streaming_tick_accumulator',completed_only:true,
        data:Array.from({length:scenario==='closing_auction'?260:scenario==='holding_503_recovery'?Math.max(25,Math.floor((f.ports.nowMs-open)/60000)):25},(_,i)=>({ts:new Date(open+i*60000).toISOString(),open:px+(px===20?(i>=20?(scenario==='atr_veto'?0:.1):i>=15?-.01:0):0),high:px+(px===20?(i>=20?(scenario==='atr_veto'?0:.1):i>=15?-.01:0):0),low:px+(px===20?(i>=20?(scenario==='atr_veto'?0:.1):i>=15?-.01:0):0),close:px+(px===20?(i>=20?(scenario==='atr_veto'?0:.1):i>=15?-.01:0):0),volume:100}))})
    }
    if(url.includes('taifex'))return new Response('',{status:503})
    throw new Error('unseeded_native_source:'+url)
  }
  try {
    if(['odd_lot_fee','holding_503_recovery'].includes(scenario)) {
      f.sqls.paper.exec('UPDATE paper_accounts SET cash=100000,initial_cash=100000 WHERE id=1')
      f.cfg.position.minPositionValue=1000
    }
    f.kvs.set('trading:risk_config',JSON.stringify(DEFAULT_RISK_CONFIG))
    f.kvs.set('ml:adaptive_params',JSON.stringify({...DEFAULT_ADAPTIVE_PARAMS,recent_accuracy_30d:.6,provenance:{...DEFAULT_ADAPTIVE_PARAMS.provenance,source:'ml-controller',fallback:false}}))
    f.sqls.core.exec("INSERT INTO market_risk(date,twii_close,risk_score,risk_level) VALUES('2026-09-11',30000,10,'green'),('2026-09-10',30000,10,'green')")
    f.sqls.market.exec("INSERT INTO market_breadth(date,advance_ratio,bull_alignment_pct) VALUES('2026-09-11',.6,60)")
    f.sqls.market.exec("INSERT INTO market_regime_factor_packets(date,schema_version,score,level,factor_json,contribution_json,source_json,freshness_json,missing_reason_json,lineage_json,generated_at) VALUES('2026-09-11','market-regime-factor-packet-v1',10,'green','[]','{}','{}','{}','{}','{}','2026-09-11T14:00:00Z')")
    f.kvs.set('market_regime_state',JSON.stringify(buildMarketRegimeState({label:'bull_market',runDate:'2026-09-11',computedAt:'2026-09-11T14:00:00Z'})))
    f.seedRiskQuality('2026-09-11')
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
    // Publication and entry must work while the advisory debate is pending.
    if(scenario==='daily_orl')await withPaperExecutionScope(f.ports,()=>requestL4Replan(f.env,plan.plan_id,['2330'],'debate_risk_reject'))
    await withPaperExecutionScope(f.ports,async()=>{
      const input={plan_id:plan.plan_id,signal_date:'2026-09-11',context_hash:'f'.repeat(64)}
      const review=await finalizeSinglePlan(f.env,'2026-09-14',input)
      assert.equal(review.ready,true)
      assert.deepEqual(await finalizeSinglePlan(f.env,'2026-09-14',input),review)
      if(scenario==='daily_orl')assert.deepEqual((await readL4ExecutionPlan(f.env))?.execution_review?.weights,plan.weights)
    })
    if(scenario==='missing_book') await withPaperExecutionScope(f.ports,()=>replacePendingBuyState(f.env,{
      tradeDate:'2026-09-14',sourceRecoDate:'2026-09-11',status:'ready',
      pendingBuys:[snapshot.pendingBuys[0],{...snapshot.pendingBuys[0],symbol:'0050',name:'benchmark'}],
    }))
    f.ports.nowMs=Date.parse(scenario==='closing_auction'?'2026-09-14T13:20:00+08:00':'2026-09-14T01:25:00Z')
    if(scenario.startsWith('clock_domain'))f.ports.nowMs+=10_000
    if(scenario.startsWith('atr_sparse'))await latchAtrOnce(f.env.PAPER_DB,1,'2026-09-14','2330',{
      policy:ATR_ONCE_POLICY,status:'unknown',reason:'swing_atr_warmup_missing',firstSignalMs:Date.parse('2026-09-14T09:20:00+08:00'),
    })
    if(scenario==='all_books_missing') {
      await assert.rejects(withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env)),/intraday_authoritative_market_data_unavailable_all_symbols/)
      const row:any=f.sqls.paper.prepare("SELECT detail_json FROM paper_execution_events WHERE source=? ORDER BY id DESC LIMIT 1").get(SWING_POLICY_VERSION)
      assert.equal(JSON.parse(row.detail_json).signal.conditions.ma60,true)
      assert.equal(JSON.parse(row.detail_json).signal.conditions.quote,false)
      assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_order_intents').get()?.n,0)
      return
    }
    const result=await withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env))
    assert.equal(result.production_effect,false)
    if(['clock_domain_stale','clock_domain_dead_heartbeat'].includes(scenario)) {
      assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_order_intents').get()?.n,0)
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,0)
      const blocked:any=f.sqls.paper.prepare("SELECT detail_json FROM paper_execution_events WHERE status='allocator_skip' ORDER BY id DESC LIMIT 1").get()
      assert.match(blocked.detail_json,/l5_status=blocked/)
      assert.match(blocked.detail_json,/missing_l5_quote/)
      return
    }
    if(['wide_live_book','submit_expired'].includes(scenario)) {
      assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_order_intents').get()?.n,0)
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,0)
      const events=JSON.stringify(f.sqls.paper.prepare('SELECT reason,detail_json FROM paper_execution_events').all())
      assert.match(events,scenario==='wide_live_book'?/wide_l5_spread/:/swing_next_bar_submission_missed/)
      return
    }
    if(scenario==='atr_sparse_missing') {
      assert.equal(warmupRequests,1)
      assert.equal(f.sqls.paper.prepare('SELECT status FROM paper_atr_once_v1').get()?.status,'unknown')
      assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_order_intents').get()?.n,0)
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,0)
      return
    }
    if(scenario==='atr_sparse_warmup') {
      const atr:any=f.sqls.paper.prepare('SELECT status,first_signal_ms FROM paper_atr_once_v1').get()
      assert.equal(atr.status,'passed');assert.equal(atr.first_signal_ms,Date.parse('2026-09-14T09:20:00+08:00'))
      assert.equal(warmupRequests,1)
    }
    if(scenario==='missing_book') {
      const row:any=f.sqls.paper.prepare("SELECT status,detail_json FROM paper_execution_events WHERE symbol='2330' AND source=? ORDER BY id DESC LIMIT 1").get(SWING_POLICY_VERSION)
      assert.equal(row?.status,'defer')
      const conditions=JSON.parse(row.detail_json).signal.conditions
      assert.equal(conditions.ma60,true)
      assert.equal(conditions.opening_limit,true)
      assert.equal(conditions.quote,false)
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,0)
      return
    }
    if(scenario==='atr_veto') {
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,0)
      assert.equal(f.sqls.paper.prepare('SELECT status FROM paper_atr_once_v1').get()?.status,'veto')
      assert.equal(f.sqls.paper.prepare("SELECT reason FROM paper_execution_events WHERE reason='swing_atr_day_veto' LIMIT 1").get()?.reason,'swing_atr_day_veto')
      return
    }
    const filledShares=['odd_lot_fee','holding_503_recovery'].includes(scenario)?31:1000
    assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,filledShares)
    assert.equal(f.sqls.paper.prepare('SELECT status FROM paper_order_intents').get()?.status,'partial')
    assert.equal(f.sqls.paper.prepare('SELECT amount FROM paper_settlements').get()?.amount,['odd_lot_fee','holding_503_recovery'].includes(scenario)?621:20028)
    if(scenario==='odd_lot_fee') {
      const buy:any=f.sqls.paper.prepare("SELECT price,commission,total_cost FROM paper_orders WHERE side='buy'").get()
      assert.equal(buy.price,20);assert.equal(buy.commission,1);assert.equal(buy.total_cost,621)
      assert.equal(f.sqls.paper.prepare('SELECT cash FROM paper_accounts').get()?.cash,100000,'unsettled fee must not credit settled cash')
      assert.equal(f.sqls.paper.prepare('SELECT avg_cost FROM paper_positions').get()?.avg_cost,621/31)
    }
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,1)
    const holding:any=f.sqls.paper.prepare('SELECT * FROM paper_positions').get()
    assert.equal(holding.tp1_price,null);assert.equal(holding.tp2_price,null)
    assert.equal(holding.initial_stop,holding.entry_price*.92)
    assert.equal(JSON.parse(holding.trade_lifecycle_json).swing.entryOrLow,20)
    if(scenario==='holding_503_recovery') {
      holdingUnavailable=true
      f.ports.nowMs=Date.parse('2026-09-14T01:30:00Z')
      const blocked=await withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env))
      assert.equal(blocked.result.status,'partial')
      assert.deepEqual(blocked.result.missing_symbols,['2330'])
      const latest:any=f.sqls.paper.prepare("SELECT detail_json FROM paper_execution_events WHERE source=? ORDER BY id DESC LIMIT 1").get(SWING_POLICY_VERSION)
      assert.equal(JSON.parse(latest.detail_json).signal.signalMs,f.ports.nowMs,'holding 503 must not suppress the new complete-bar assessment')
      assert.equal(f.sqls.paper.prepare("SELECT reason FROM paper_execution_events ORDER BY id DESC LIMIT 1").get()?.reason,'holding_risk_evidence_unavailable')
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,1,'no exposure increase with incomplete holding risk evidence')
      assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,31)
      holdingUnavailable=false
      f.ports.nowMs=Date.parse('2026-09-14T01:35:00Z')
      const recovered=await withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env))
      assert.equal(recovered.result.status,'ok')
      assert.deepEqual(recovered.result.missing_symbols,[])
      const recoveredSignal:any=f.sqls.paper.prepare("SELECT detail_json FROM paper_execution_events WHERE source=? ORDER BY id DESC LIMIT 1").get(SWING_POLICY_VERSION)
      assert.equal(JSON.parse(recoveredSignal.detail_json).signal.signalMs,f.ports.nowMs)
      assert.equal(f.sqls.paper.prepare("SELECT reason FROM paper_execution_events WHERE status='allocator_skip' ORDER BY id DESC LIMIT 1").get()?.reason,'daily_plan_existing_position')
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,1)
      return
    }
    if(['controller_static_book'].includes(scenario))return
    for(let i=0;i<2;i++){
      f.ports.nowMs+=300000
      await withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env))
    }
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,1)
    assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,filledShares)
    if(scenario==='unchanged_stream_book' || scenario==='atr_sparse_warmup')return
    // Continue the very same account and actual filled lot across sessions.
    const sessions:string[]=[]
    for(let ms=Date.parse('2026-09-14T00:00:00Z');sessions.length<21;ms+=86400000)
      if(![0,6].includes(new Date(ms).getUTCDay()))sessions.push(new Date(ms).toISOString().slice(0,10))
    const exitDay=scenario==='20_sessions'?sessions[20]:sessions[1]
    for(const day of sessions.filter(d=>d<exitDay)) {
      f.sqls.market.prepare('INSERT INTO stock_prices(stock_id,date,close) VALUES(2,?,100)').run(day)
      f.sqls.market.prepare('INSERT INTO stock_prices(stock_id,date,close) VALUES(1,?,?)').run(day,scenario==='daily_orl'?19.8:20)
    }
    quotePrice=['hard_stop','closing_auction','clock_domain','odd_lot_fee'].includes(scenario)?18.3:20
    f.ports.nowMs=Date.parse(exitDay+(scenario==='20_sessions'?'T13:24:00+08:00':scenario==='closing_auction'?'T13:25:00+08:00':'T09:05:00+08:00'))
    await withPaperExecutionScope(f.ports,()=>pollIntradayStopLoss(f.env,{halt:false,forceLiquidate:false,targetExposurePct:1,maxPositionPct:.2} as any))
    if(scenario==='closing_auction') {
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").get()?.n,0)
      const blocked:any=f.sqls.paper.prepare('SELECT shares,trade_lifecycle_json FROM paper_positions').get()
      assert.equal(blocked.shares,1000)
      assert.equal(JSON.parse(blocked.trade_lifecycle_json).swing.pendingExit.reason,'swing_hard_stop_8')
      quotePrice=20 // A rebound must not erase the deferred disaster exit.
      f.ports.nowMs=Date.parse(sessions[2]+'T09:05:00+08:00')
      await withPaperExecutionScope(f.ports,()=>pollIntradayStopLoss(f.env,{halt:false,forceLiquidate:false,targetExposurePct:1,maxPositionPct:.2} as any))
    }
    const exits:any[]=f.sqls.paper.prepare("SELECT * FROM paper_orders WHERE side='sell'").all()
    assert.equal(exits.length,1,JSON.stringify(f.sqls.paper.prepare("SELECT reason,detail_json FROM paper_execution_events WHERE side='sell'").all()))
    assert.match(exits[0].note,new RegExp('swing_'+(['closing_auction','clock_domain','odd_lot_fee'].includes(scenario)?'hard_stop':scenario)))
    if(scenario==='odd_lot_fee')assert.equal(exits[0].commission,1,'odd-lot hard-stop sell uses the same NT$1 minimum')
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_positions WHERE shares>0').get()?.n,0)
  } finally {f.close()}
})
