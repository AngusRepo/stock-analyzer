import assert from 'node:assert/strict'
import test from 'node:test'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { checkP5Losses } from './riskChecks/p5Losses'
import { runPortfolioChecks } from './riskChain'
import { resolveCircuitAdjustedSingleNameCap } from './riskPositionSizing'
import { checkP9IntradayDrawdown, mergeIntradayPortfolioRisk } from './intradayPortfolioRisk'
import { DEFAULT_RISK_CONFIG } from './riskConfig'
import { DEFAULT_ADAPTIVE_PARAMS } from './adaptiveConfig'
import { buildMarketRegimeState } from './marketRegimeState'
import { withPaperExecutionScope } from './paperExecutionScope'
import type { CircuitBreakerState } from './riskTypes'

const deps = {
  defaults: { halt: false, maxPositionPct: .08, buyConfThreshold: .6, sellConfThreshold: .65 },
  effectiveBuy: .6, effectiveSell: .65,
}
function sell(f: ReturnType<typeof l4NativeFixture>, pnl: number) {
  f.sqls.paper.prepare(`INSERT INTO paper_orders(account_id,symbol,side,shares,price,total_cost,note)
    VALUES(1,'2330','sell',1,20,20,?)`).run(JSON.stringify({realized_pnl:pnl}))
}
function seedRisk(f: ReturnType<typeof l4NativeFixture>) {
  f.sqls.learning.exec('CREATE TABLE IF NOT EXISTS active8_ensemble_pointer_v1(singleton_id INTEGER PRIMARY KEY,artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT)')
  f.kvs.set('trading:risk_config', JSON.stringify(DEFAULT_RISK_CONFIG))
  f.kvs.set('ml:adaptive_params', JSON.stringify({...DEFAULT_ADAPTIVE_PARAMS,
    recent_accuracy_30d:.6, provenance:{...DEFAULT_ADAPTIVE_PARAMS.provenance,source:'ml-controller',fallback:false}}))
  f.sqls.core.exec("INSERT INTO market_risk(date,twii_close,risk_score,risk_level) VALUES('2026-09-11',30000,10,'green'),('2026-09-10',30000,10,'green')")
  f.sqls.market.exec("INSERT INTO market_breadth(date,advance_ratio,bull_alignment_pct) VALUES('2026-09-11',.6,60)")
  f.sqls.market.exec("INSERT INTO market_regime_factor_packets(date,schema_version,score,level,factor_json,contribution_json,source_json,freshness_json,missing_reason_json,lineage_json,generated_at) VALUES('2026-09-11','market-regime-factor-packet-v1',10,'green','[]','{}','{}','{}','{}','{}','2026-09-11T14:00:00Z')")
  f.kvs.set('market_regime_state', JSON.stringify(buildMarketRegimeState({label:'bull_market',runDate:'2026-09-11',computedAt:'2026-09-11T14:00:00Z'})))
  f.seedRiskQuality('2026-09-11')
}
const chain = (f: ReturnType<typeof l4NativeFixture>) => withPaperExecutionScope(f.ports, () =>
  runPortfolioChecks({paper:f.env.PAPER_DB,core:f.env.CORE_DB,market:f.env.MARKET_DB,learning:f.env.LEARNING_DB}, f.cfg, f.env.KV, deps))

test('two losses do not scale; three nonconsecutive losses in five sells scale without halting', async () => {
  const f = l4NativeFixture()
  try {
    sell(f,-1);sell(f,100);sell(f,-1);sell(f,100)
    assert.equal(await checkP5Losses(f.env.PAPER_DB,deps),null)
    sell(f,-1)
    const decision=await checkP5Losses(f.env.PAPER_DB,deps)
    assert.equal(decision?.halt,false)
    assert.equal(decision?.maxPositionPct,.04)
    assert.equal(decision?.buyConfThreshold,.6)
    assert.match(decision?.reason ?? '',/部位上限.*50%/)
  } finally {f.close()}
})

test('empty account with today\'s three loss amounts keeps a nonzero buy cap without rearm or ledger writes', async () => {
  const f=l4NativeFixture()
  try {
    seedRisk(f)
    for(const pnl of [-2884,-93,-1852])sell(f,pnl)
    const before=f.sqls.paper.prepare('SELECT * FROM paper_orders').all()
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_positions').get()?.n,0)
    for(let i=0;i<3;i++) {
      const {result}=await chain(f)
      assert.equal(result.halt,false)
      assert.deepEqual(result.haltReasons,[])
      assert.ok(result.triggeredLayers.includes('P5'))
      assert.equal(result.maxPositionPct,.04,'polling must not compound the sizing reduction')
      assert.equal(resolveCircuitAdjustedSingleNameCap({configuredSingleNameCap:.125,
        circuitBaselinePositionPct:.08,circuitEffectivePositionPct:result.maxPositionPct}),.0625)
    }
    assert.deepEqual(f.sqls.paper.prepare('SELECT * FROM paper_orders').all(),before)
    assert.equal(f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_p5_rearms_v1').get()?.n,0)
  } finally {f.close()}
})

for(const hardGate of ['P1','P8','P9','S1','missing_market_evidence'])test(`P5 scaling cannot override ${hardGate}`,async()=>{
  const f=l4NativeFixture()
  try {
    seedRisk(f)
    for(let i=0;i<3;i++)sell(f,-1)
    if(hardGate==='S1')f.kvs.set('trading:risk_config',JSON.stringify({...DEFAULT_RISK_CONFIG,
      system:{...DEFAULT_RISK_CONFIG.system,killSwitch:true}}))
    if(hardGate==='missing_market_evidence')f.sqls.core.exec('DELETE FROM market_risk_quality_v1')
    if(hardGate==='P1' || hardGate==='P8') {
      const navs=hardGate==='P1'?[1000000,950000,800000]:[1000000,965000]
      for(const [i,nav] of navs.entries())f.sqls.paper.prepare(`INSERT INTO paper_daily_snapshots
        (account_id,date,cash,positions_value,total_value,pnl,pnl_pct) VALUES(1,?,?,0,?,0,0)`)
        .run(hardGate==='P8' ? ['2026-09-11','2026-09-14'][i] : `2026-09-${10+i}`,nav,nav)
    }
    let result: CircuitBreakerState = (await chain(f)).result
    if(hardGate==='P9') {
      await withPaperExecutionScope(f.ports,()=>checkP9IntradayDrawdown(f.env.PAPER_DB,f.env.KV,1,
        '2026-09-14',1000000,DEFAULT_RISK_CONFIG,deps))
      const p9=await withPaperExecutionScope(f.ports,()=>checkP9IntradayDrawdown(f.env.PAPER_DB,f.env.KV,1,
        '2026-09-14',940000,DEFAULT_RISK_CONFIG,deps))
      result=mergeIntradayPortfolioRisk(result,p9.result.state)
    }
    assert.equal(result.halt,true)
    assert.equal(result.maxPositionPct,0)
    assert.ok((result.haltReasons?.length ?? 0)>0)
    assert.ok(result.triggeredLayers?.includes(hardGate==='missing_market_evidence'?'P3':hardGate))
  } finally {f.close()}
})

test('P5 never clears an existing hard halt in its input defaults',async()=>{
  const f=l4NativeFixture()
  try {
    for(let i=0;i<3;i++)sell(f,-1)
    const decision=await checkP5Losses(f.env.PAPER_DB,{...deps,defaults:{...deps.defaults,halt:true,maxPositionPct:0}})
    assert.equal(decision?.halt,true)
    assert.equal(decision?.maxPositionPct,0)
  } finally {f.close()}
})
