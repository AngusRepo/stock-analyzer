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

test('native morning admits L3 HOLD with a positive L4 target and canonical execution price',async()=>{
  const f=l4NativeFixture()
  f.ports.allocateL4Private=async()=>{throw new Error('fixture_plan_already_supplied')}
  f.ports.fetchFrozen=async(input:RequestInfo|URL)=>{assert.match(String(input),/taifex/);return new Response('',{status:503})}
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
    f.sqls.market.exec("INSERT INTO stock_prices(stock_id,date,open,high,low,close,avg_price,volume) VALUES(1,'2026-09-11',100,102,98,100,100,1000000)")
    f.sqls.core.prepare(`INSERT INTO daily_recommendations(stock_id,symbol,name,date,rank,score,reason,signal,confidence,has_buy_signal,eligible_for_ml,eligible_for_pending_buy,alpha_allocation)
      VALUES(1,'2330','fixture','2026-09-11',1,50,'synthetic fixture','HOLD',.5,0,1,1,?)`).run(JSON.stringify({engine:'sparse_tangent_inverse_risk',selected:false}))
    const raw:any={execution_scope:'private_research',schema_version:'l4-portfolio-plan-v1',owner:'l4_distribution',parent_plan_id:null,
      account_anchor:account.account_anchor,policy_identity:'d'.repeat(64),model_checksum:'c'.repeat(64),l3_identity:l3,
      signal_date:'2026-09-11',account_id:1,nav_at_decision:1e6,weights:{'2330':.05},
      targets:{'2330':{weight:.05,current_weight:0,locked:false,expected_return_gross:.02}},
      constraints:{exposure_cap:account.risk_limits.exposure_cap,name_cap:account.risk_limits.name_cap,min_weight:.03,max_positions:5},
      proof:{within_tolerance:true,absolute_objective_gap:0,tolerance:1e-8,evaluated_candidate_count:1,preselection:false},opb:{enabled:false,status:'fixed_policy',arm_id:'base'}}
    const canonical_payload=JSON.stringify(raw),plan={...raw,plan_id:createHash('sha256').update(canonical_payload).digest('hex')}
    await withPaperExecutionScope(f.ports,()=>storeL4PortfolioPlan(f.env,{plan,canonical_payload,allocation_snapshot_id:'e'.repeat(64)}))
    await withPaperExecutionScope(f.ports,()=>setupMorningPendingBuys(f.env))
    const snapshot=(await withPaperExecutionScope(f.ports,()=>loadPendingBuySnapshot(f.env,'2026-09-14',{allowFallbackRecent:false}))).result
    assert.equal(snapshot.pendingBuys.length,1)
    assert.equal(snapshot.pendingBuys[0].symbol,'2330')
    assert.equal(snapshot.pendingBuys[0].ml_entry_price,100)
    assert.ok(snapshot.pendingBuys[0].watch_points.includes('l4_execution_reference:canonical_signal_close'))
    assert.equal(snapshot.pendingBuys[0].debate_verdict,'PENDING')
    f.sqls.ops.exec("UPDATE pipeline_stage_runs SET status='error' WHERE business_date='2026-09-11' AND stage='pipeline_execution'")
    await withPaperExecutionScope(f.ports,()=>setupMorningPendingBuys(f.env))
    const invalidSource=(await withPaperExecutionScope(f.ports,()=>loadPendingBuySnapshot(f.env,'2026-09-14',{allowFallbackRecent:false}))).result
    assert.equal(invalidSource.pendingBuys.length,0)
    assert.equal(invalidSource.meta?.status,'halted')
    assert.equal(invalidSource.meta?.error_message,'source_pipeline_execution_error')
    // A private candidate never receives or caches formal release authority.
    assert.equal(f.cfg.l4Distribution.artifact.release,undefined)
    await assert.rejects(getTradingConfig(f.env.KV),/validated Paper release/)
    await assert.rejects(storeL4PortfolioPlan(f.env,{plan,canonical_payload,allocation_snapshot_id:'e'.repeat(64)}),/private_plan_cannot_publish/)
  } finally {f.close()}
})
