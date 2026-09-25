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

test('native full chain executes positive L4 target through real entry owner',async()=>{
  const f=l4NativeFixture()
  f.ports.allocateL4Private=async()=>{throw new Error('fixture_plan_already_supplied')}
  f.env.SHIOAJI_PROXY_URL='https://fixture.invalid'
  f.env.ML_CONTROLLER_URL='https://fixture.invalid'
  f.env.FINLAB_L5_MARKET_DATA_ENABLED='true'
  let limitedExitDepth=false
  let oddExitDepth=true
  f.ports.fetchFrozen=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input),time=new Date(f.ports.nowMs).toISOString()
    const quote={symbol:'2330',status:'ok',source_time:time,received_at:time,confirmed_at:time,
      quote_age_ms:0,source_age_ms:0,lot_type:'board_lot',volume_unit:'lots',
      last:20,price:20,open:20,high:20.5,low:19.5,reference_price:20,total_volume:100000,
      bid:20,ask:20,bid_prices:[20,19.95,19.9,19.85,19.8],ask_prices:[20,20.05,20.1,20.15,20.2],
      bid_volume:10,ask_volume:1,bid_volumes:[10,10,10,10,10],ask_volumes:[1,0,0,0,0]}
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
    if(url.includes('/kbars/'))return Response.json({data:[]})
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
    f.sqls.core.exec("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','fixture','TWSE')")
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
      snapshot.pendingBuys.map(row=>({...row,debate_verdict:'APPROVED',debate_status:'completed' as any})),snapshot.meta))
    f.ports.nowMs=Date.parse('2026-09-14T01:45:00Z')
    const result=await withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env))
    assert.equal(result.production_effect,false)
    assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,1000)
    assert.equal(f.sqls.paper.prepare('SELECT status FROM paper_order_intents').get()?.status,'partial')
    assert.equal(f.sqls.paper.prepare('SELECT amount FROM paper_settlements').get()?.amount,20029)
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,1)
    const topupProgress={schema_version:'position-tp1-progress-v1',entry_date:'2026-09-14',target_shares:2000,filled_shares:1000}
    f.sqls.paper.prepare("UPDATE paper_positions SET trade_lifecycle_json=json_set(trade_lifecycle_json,'$.position_tp1_progress',json(?))").run(JSON.stringify(topupProgress))
    for(let index=0;index<2;index++) {
      f.ports.nowMs+=60_000
      await withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env))
    }
    assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,3000)
    assert.deepEqual(JSON.parse(String(f.sqls.paper.prepare('SELECT trade_lifecycle_json FROM paper_positions').get()?.trade_lifecycle_json)).position_tp1_progress,topupProgress)
    f.sqls.paper.exec("UPDATE paper_positions SET trade_lifecycle_json=json_remove(trade_lifecycle_json,'$.position_tp1_progress')")

    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,3)
    assert.equal(f.sqls.paper.prepare('SELECT SUM(amount) n FROM paper_settlements').get()?.n,60087)
    f.ports.nowMs+=60_000
    await withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env))
    assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,3999)
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,4)
    // Completed target and fractional dust must not create another order or debate.
    f.ports.nowMs+=60_000
    await withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env))
    await withPaperExecutionScope(f.ports,()=>setupMorningPendingBuys(f.env))
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='buy'").get()?.n,4)
    const completed=(await withPaperExecutionScope(f.ports,()=>loadPendingBuySnapshot(f.env,'2026-09-14',{allowFallbackRecent:false}))).result
    assert.equal(completed.pendingBuys.length,0)
    f.ports.nowMs=Date.parse('2026-09-14T06:00:00Z')
    const firstClose=(await withPaperExecutionScope(f.ports,()=>runDailySnapshot(f.env,{date:'2026-09-14'}))).result
    assert.equal(firstClose.valuation.nav,999885)
    // Next session receives the same L3/L4 model and a tighter approved test risk arm.
    f.sqls.core.exec("INSERT INTO market_risk(date,twii_close,risk_score,risk_level) VALUES('2026-09-14',30000,10,'green')")
    f.sqls.market.exec("INSERT INTO stock_prices(stock_id,date,open,high,low,close,avg_price,volume) VALUES(1,'2026-09-14',20,20.5,19.5,20,20,1000000)")
    f.sqls.market.exec("INSERT INTO market_breadth(date,advance_ratio,bull_alignment_pct) SELECT '2026-09-14',advance_ratio,bull_alignment_pct FROM market_breadth WHERE date='2026-09-11'")
    f.sqls.market.exec("INSERT INTO market_regime_factor_packets(date,schema_version,score,level,factor_json,contribution_json,source_json,freshness_json,missing_reason_json,lineage_json,generated_at) SELECT '2026-09-14',schema_version,score,level,factor_json,contribution_json,source_json,freshness_json,missing_reason_json,lineage_json,'2026-09-14T14:00:00Z' FROM market_regime_factor_packets WHERE date='2026-09-11'")
    f.kvs.set('market_regime_state',JSON.stringify(buildMarketRegimeState({label:'bull_market',runDate:'2026-09-14',computedAt:'2026-09-14T14:00:00Z'})))
    f.sqls.core.exec("INSERT INTO daily_recommendations(stock_id,symbol,name,date,rank,score,reason,signal,confidence,has_buy_signal,eligible_for_ml,eligible_for_pending_buy,alpha_allocation) SELECT stock_id,symbol,name,'2026-09-14',rank,score,reason,signal,confidence,has_buy_signal,eligible_for_ml,eligible_for_pending_buy,alpha_allocation FROM daily_recommendations WHERE date='2026-09-11'")
    f.ports.nowMs=Date.parse('2026-09-15T00:00:00Z')
    const nextAccount=(await withPaperExecutionScope(f.ports,()=>captureL4AccountContext(f.env,'2026-09-14'))).result
    const reduced=allocateNative(nextAccount,.03001)
    await withPaperExecutionScope(f.ports,()=>storeL4PortfolioPlan(f.env,reduced))
    f.ports.nowMs=Date.parse('2026-09-15T01:45:00Z')
    // A simultaneous position-policy TP1 cannot hide a larger L4 reduction.
    // Use the real poll, sell transaction and evidence event, then restore this isolated fixture.
    f.sqls.paper.exec('SAVEPOINT simultaneous_exit_probe')
    try {
      f.sqls.paper.exec("UPDATE paper_positions SET entry_price=18,tp1_price=19,tp1_hit=0,original_shares=3999,initial_stop=10,trailing_stop=10,trade_lifecycle_json=NULL")
      f.sqls.paper.exec("UPDATE paper_orders SET note='' WHERE side='buy'")
      await withPaperExecutionScope(f.ports,()=>pollIntradayStopLoss(f.env))
      assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,1500)
      const event=f.sqls.paper.prepare("SELECT detail_json FROM paper_execution_events WHERE side='sell' AND event_type='paper_order' ORDER BY id DESC LIMIT 1").get()
      const pointer=JSON.parse(String(event?.detail_json)).evidence_pointer
      assert.ok(pointer?.r2_key)
      const artifact=JSON.parse(f.artifacts.get(pointer.r2_key)!)
      const evidence=artifact.payload.detail.exit_arbitration
      assert.equal(evidence.selected_owner,'l4_target')
      assert.equal(evidence.requested_shares,2499)
      assert.equal(evidence.proposals[0].requestedShares,1000)
      assert.equal(evidence.proposals[1].requestedShares,2499)
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").get()?.n,1)
      assert.equal(f.sqls.paper.prepare('SELECT tp1_hit FROM paper_positions').get()?.tp1_hit,1)
      await withPaperExecutionScope(f.ports,()=>pollIntradayStopLoss(f.env))
      assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,1500)
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").get()?.n,1)
    } finally {
      f.sqls.paper.exec('ROLLBACK TO simultaneous_exit_probe; RELEASE simultaneous_exit_probe')
    }
    // Resume a durable intraday partial TP1 at the EOD owner without restarting its quantity.
    f.sqls.paper.exec('SAVEPOINT eod_progress_probe')
    try {
      f.sqls.paper.exec("UPDATE paper_positions SET shares=2999,entry_price=18,tp1_price=19,tp2_price=30,tp1_hit=0,original_shares=4000,initial_stop=10,trailing_stop=10")
      f.sqls.paper.prepare('UPDATE paper_positions SET trade_lifecycle_json=?').run(JSON.stringify({
        position_tp1_progress:{schema_version:'position-tp1-progress-v1',entry_date:'2026-09-14',target_shares:2000,filled_shares:1000},
      }))
      f.sqls.paper.exec("UPDATE paper_orders SET note='' WHERE side='buy'")
      await withPaperExecutionScope(f.ports,()=>runEODExit(f.env))
      assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,1999)
      assert.equal(f.sqls.paper.prepare('SELECT tp1_hit FROM paper_positions').get()?.tp1_hit,1)
      await withPaperExecutionScope(f.ports,()=>runEODExit(f.env))
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").get()?.n,1)
    } finally {
      f.sqls.paper.exec('ROLLBACK TO eod_progress_probe; RELEASE eod_progress_probe')
    }
    const originalMinimumTrade=f.cfg.position.minPositionValue
    f.sqls.paper.exec('SAVEPOINT multifill_exit_probe')
    try {
      limitedExitDepth=true
      oddExitDepth=false
      f.sqls.paper.exec("UPDATE paper_positions SET entry_price=18,tp1_price=19,tp1_hit=0,original_shares=4000,initial_stop=10,trailing_stop=10,trade_lifecycle_json=NULL")
      f.sqls.paper.exec("UPDATE paper_orders SET note='' WHERE side='buy'")
      f.sqls.paper.exec("CREATE TRIGGER fail_progress_receivable BEFORE INSERT ON paper_settlements WHEN NEW.side='sell' BEGIN SELECT RAISE(ABORT,'progress_rollback_probe'); END")
      await assert.rejects(withPaperExecutionScope(f.ports,()=>pollIntradayStopLoss(f.env)),/progress_rollback_probe/)
      assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,3999)
      assert.equal(f.sqls.paper.prepare('SELECT trade_lifecycle_json FROM paper_positions').get()?.trade_lifecycle_json,null)
      f.sqls.paper.exec('DROP TRIGGER fail_progress_receivable')
      for(const [remaining,filled,hit] of [[2999,1000,0],[1999,2000,1]]) {
        await withPaperExecutionScope(f.ports,()=>pollIntradayStopLoss(f.env))
        const position=f.sqls.paper.prepare('SELECT shares,tp1_hit,trade_lifecycle_json FROM paper_positions').get()!
        assert.equal(position.shares,remaining)
        assert.equal(position.tp1_hit,hit)
        assert.equal(JSON.parse(String(position.trade_lifecycle_json)).position_tp1_progress.filled_shares,filled)
      }
      oddExitDepth=true
      await withPaperExecutionScope(f.ports,()=>pollIntradayStopLoss(f.env))
      // The 499-share residual is below the configured 30k minimum, not another TP1.
      assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,1999)
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").get()?.n,2)
      f.cfg.position.minPositionValue=1000
      f.kvs.set('trading:config',JSON.stringify(f.cfg))
      await withPaperExecutionScope(f.ports,()=>pollIntradayStopLoss(f.env))
      assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,1500)
      assert.deepEqual(f.sqls.paper.prepare("SELECT shares FROM paper_orders WHERE side='sell' ORDER BY id").all().map(r=>r.shares),[1000,1000,499])
      await withPaperExecutionScope(f.ports,()=>pollIntradayStopLoss(f.env))
      assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").get()?.n,3)
    } finally {
      limitedExitDepth=false
      oddExitDepth=true
      f.cfg.position.minPositionValue=originalMinimumTrade
      f.kvs.set('trading:config',JSON.stringify(f.cfg))
      f.sqls.paper.exec('ROLLBACK TO multifill_exit_probe; RELEASE multifill_exit_probe')
    }
    f.sqls.paper.exec("CREATE TRIGGER fail_sell_receivable BEFORE INSERT ON paper_settlements WHEN NEW.side='sell' BEGIN SELECT RAISE(ABORT,'injected_settlement_failure'); END")
    await assert.rejects(withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env)),/injected_settlement_failure/)
    assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,3999)
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").get()?.n,0)
    f.sqls.paper.exec('DROP TRIGGER fail_sell_receivable')
    f.ports.nowMs+=60_000
    await withPaperExecutionScope(f.ports,()=>runIntradayCheck(f.env))
    console.log('CHAIN_ORDERS',JSON.stringify(f.sqls.paper.prepare('SELECT side,shares,price,total_cost FROM paper_orders').all()))
    assert.equal(f.sqls.paper.prepare('SELECT shares FROM paper_positions').get()?.shares,1500)
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").get()?.n,1)
    f.ports.nowMs=Date.parse('2026-09-15T06:00:00Z')
    const close=(await withPaperExecutionScope(f.ports,()=>runDailySnapshot(f.env,{date:'2026-09-15'}))).result
    assert.equal(close.valuation.nav,999664)
    const reward=JSON.parse(String(f.sqls.paper.prepare('SELECT payload_json FROM l4_policy_account_rewards_v1 ORDER BY known_date DESC LIMIT 1').get()?.payload_json))
    assert.equal(reward.complete,true)
    assert.equal(reward.includes_costs,true)
    assert.equal(reward.arm_id,reduced.plan.opb.arm_id)
    assert.equal(reward.reward,close.valuation.nav!/nextAccount.nav-1)
    // Real T+2 settlement transfers receivables/liabilities to cash exactly once.
    f.ports.nowMs=Date.parse('2026-09-17T00:00:00Z')
    f.kvs.set('market:corporate_actions:v1:2026-09-17',JSON.stringify({schema_version:'paper-corporate-source-v1',
      session_date:'2026-09-17',observed_at:'2026-09-17T00:00:00Z',source_checksum:'f'.repeat(64),
      covered_symbols:['2330'],actions:[],blockers:{},tax_basis:'gross_before_personal_tax'}))
    await withPaperExecutionScope(f.ports,()=>settlePaperT2(f.env))
    await withPaperExecutionScope(f.ports,()=>settlePaperT2(f.env))
    assert.equal(f.sqls.paper.prepare('SELECT cash FROM paper_accounts WHERE id=1').get()?.cash,969664)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_settlements WHERE settled=0').get()?.n,0)
    // The closed account receipt, with its original policy identity, reaches native OPB.
    // Unchanged price/risk input is synthetic; the reward itself comes from actual fills.
    const learned=allocateNative({...nextAccount,signal_date:'2026-09-16',nav:999664,available_cash:969664,
      holdings:[{symbol:'2330',shares:1500,market_value:30000,sector:'TECH'}]},.03001)
    assert.equal(learned.plan.opb.status,'learned_policy')
    assert.notEqual(learned.plan.opb.arm_id,'base')
    assert.equal(Object.keys(learned.plan.opb.arm_statistics).length,6)
    assert.equal(learned.plan.opb.samples,1)
    assert.equal(learned.plan.opb.fabricated_prior_samples,0)
    assert.equal(learned.plan.opb.arm_statistics.base.reward_mean,reward.reward)
    assert.ok(f.artifacts.size>0)
    // A corrupt L4 target cannot suppress the original holding-risk exit owner.
    // This explicit synthetic stop acts on the position created by the real entry/ledger above.
    f.sqls.paper.prepare("UPDATE l4_portfolio_plans_v1 SET payload_json='{}' WHERE plan_id=?").run(reduced.plan.plan_id)
    const heldLifecycle=JSON.parse(String(f.sqls.paper.prepare("SELECT trade_lifecycle_json FROM paper_positions WHERE account_id=1 AND symbol='2330'").get()?.trade_lifecycle_json))
    heldLifecycle.entry.stopLoss=21
    heldLifecycle.entry.s12.structureStop=21
    heldLifecycle.entry.s12.exitPlan.trailingInitial=21
    f.sqls.paper.prepare("UPDATE paper_positions SET trade_lifecycle_json=?,highest_since_entry=24 WHERE account_id=1 AND symbol='2330'").run(JSON.stringify(heldLifecycle))
    f.ports.nowMs=Date.parse('2026-09-17T01:45:00Z')
    await withPaperExecutionScope(f.ports,()=>pollIntradayStopLoss(f.env))
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_positions').get()?.n,0)
    const hardExit=f.sqls.paper.prepare("SELECT shares,source,note FROM paper_orders WHERE side='sell' ORDER BY id DESC LIMIT 1").get()
    assert.equal(hardExit?.shares,1500)
    assert.equal(hardExit?.source,'intraday_exit')
    assert.match(String(hardExit?.note),/stop|停損/i)
    const exitCount=f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").get()?.n
    await withPaperExecutionScope(f.ports,()=>pollIntradayStopLoss(f.env))
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) n FROM paper_orders WHERE side='sell'").get()?.n,exitCount)
    // A private candidate never receives or caches formal release authority.
    assert.equal(f.cfg.l4Distribution.artifact.release,undefined)
    await assert.rejects(getTradingConfig(f.env.KV),/validated Paper release/)
    await assert.rejects(storeL4PortfolioPlan(f.env,{plan,canonical_payload,allocation_snapshot_id:'e'.repeat(64)}),/private_plan_cannot_publish/)
  } finally {f.close()}
})
