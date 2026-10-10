import assert from 'node:assert/strict'
import test from 'node:test'
import { L4_FEATURE_SCHEMA, L4_TIMEXER_FEATURE_SCHEMA, L4_ACCEPTANCE_CHECKS } from './l4ReleaseEvidence'
import { buildChampionTradingConfig, validateTradingConfig } from './tradingConfig'
import { refreshExpectedReturnServingState } from './expectedReturnServingState'
import { officialTradingRestrictionsRefreshComplete, runDailyAllocatorEvReadiness } from './updateOrchestrator'
import { runL4DistributionRefresh, runActive8OofLifecycle } from './controllerResearchWorkflows'

function fixture() {
  const config=buildChampionTradingConfig(null)
  const identity={artifact_id:'synthetic',cohort_id:'test',payload_checksum:'a'.repeat(64),base_artifact_set_checksum:'b'.repeat(64)}
  const model='c'.repeat(64)
  const receipt={schema_version:'l4-paper-acceptance-v1',feature_schema:L4_FEATURE_SCHEMA,model_checksum:model,
    checks:Object.fromEntries(L4_ACCEPTANCE_CHECKS.map(k=>[k,true])),acceptance_mode:'paper_experiment',efficacy_status:'unproven',
    experiment_authorization:{scope:'paper',approved:true,source_reference:'synthetic-test-only',model_checksum:model}}
  const artifact={schema_version:'l4-distribution-v1',feature_schema:L4_FEATURE_SCHEMA,model_checksum:model,l3_identity:identity,
    release:{scope:'paper',decision:'PASS',model_checksum:model,validation_receipt_checksum:'d'.repeat(64),
      validation_receipt:receipt,acceptance_mode:'paper_experiment',efficacy_status:'unproven'}}
  config.l4Distribution={scope:'paper',artifact,constraints:{exposure_cap:.8,name_cap:.08,min_weight:0,max_positions:5}}
  return {config,artifact,identity,receipt}
}

test('single B accepts official v2 while rejecting MLP and unknown residual schemas', () => {
  const f=fixture(), a:any=f.artifact
  Object.assign(f.config.l4Distribution!, {operating_mode:'single_b_tabpack_v1',strategy_role:'B'})
  a.model={residual_tabpack:{schema_version:'l4-three-head-residual-tabpack-official-v2'}}
  assert.deepEqual(validateTradingConfig(f.config),[])
  a.model.residual_tabpack.schema_version='unknown'
  assert.ok(validateTradingConfig(f.config).includes('single B mode requires its matching complete Paper artifact'))
  a.model.residual_tabpack.schema_version='l4-three-head-residual-tabpack-v1'
  assert.deepEqual(validateTradingConfig(f.config),[])
  a.model.residual_mlp={}
  assert.ok(validateTradingConfig(f.config).includes('single B mode requires its matching complete Paper artifact'))
})

test('independent monthly trigger cannot race the canonical B OOF parent', async () => {
  const env:any={KV:{get:async()=>({l4Distribution:{operating_mode:'single_b_tabpack_v1',strategy_role:'B',scope:'paper'}})}}
  assert.equal(await runL4DistributionRefresh(env,'2026-10-04','monthly'),
    'skipped single_b_refresh_owned_by_canonical_oof_completion')
})

test('monthly scheduler sends exogenous B profile and candidate-only controls', async () => {
  const original=globalThis.fetch, bodies:any[]=[]
  globalThis.fetch=async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({status:'spawned',execution_id:'synthetic'}),{status:200})
  }
  try {
    const env:any={ML_CONTROLLER_URL:'https://example.invalid',
      KV:{get:async()=>({l4Distribution:{operating_mode:'single_b_tabpack_v1'}})}}
    await runActive8OofLifecycle(env,'2026-10-04','monthly')
    assert.equal(bodies[0].model_profile_schema_version,'active8-release-model-profiles-v4-timexer-exo137')
    assert.equal(bodies[0].dispatch_full_fit,true)
    assert.equal(bodies[0].promote,false)
  } finally { globalThis.fetch=original }
})

test('v3 configuration and serving state agree; v2 or incomplete evidence cannot be ready',async()=>{
  const f=fixture(),writes:any[]=[]
  const env:any={KV:{get:async()=>f.config,put:async(...args:any[])=>{writes.push(args)}},
    DB:{prepare:()=>({first:async()=>f.identity})}}
  assert.deepEqual(validateTradingConfig(f.config),[])
  assert.equal((await refreshExpectedReturnServingState(env,'2026-09-14')).expected_return_owner,'l4_distribution')
  f.artifact.feature_schema='full-l3-30-calibrated-probability-v2'
  assert.ok(validateTradingConfig(f.config).length>0)
  assert.equal((await refreshExpectedReturnServingState(env,'2026-09-14')).expected_return_owner,null)
  f.artifact.feature_schema=L4_FEATURE_SCHEMA
  f.receipt.checks.partial_fills=false
  assert.ok(validateTradingConfig(f.config).includes('l4_release_engineering_evidence_incomplete'))
  assert.equal((await refreshExpectedReturnServingState(env,'2026-09-14')).expected_return_owner,null)
  assert.equal(writes.length,3)
})


test('TimeXer v4 keeps exact input coordinates and matching Paper evidence', async () => {
  const f=fixture(), a:any=f.artifact
  a.feature_schema=L4_TIMEXER_FEATURE_SCHEMA
  f.receipt.feature_schema=L4_TIMEXER_FEATURE_SCHEMA
  const names=['LightGBM','XGBoost','ExtraTrees','TabM','GNN','DLinear','PatchTST','iTransformer']
    .flatMap(model=>['raw','rank','available'].map(suffix=>`${model}_${suffix}`))
    .concat(['ml_edge_norm','ensemble_directional_margin','l3_rank_mean','l3_rank_sd','l3_rank_range','l3_available_fraction'])
    .sort().map(name=>name.replace('DLinear_','TimeXer_'))
  a.model={recipe:{names}}
  const env:any={KV:{get:async()=>f.config,put:async()=>{}},DB:{prepare:()=>({first:async()=>f.identity})}}
  assert.deepEqual(validateTradingConfig(f.config),[])
  assert.equal((await refreshExpectedReturnServingState(env,'2026-09-14')).expected_return_owner,'l4_distribution')
  f.receipt.feature_schema=L4_FEATURE_SCHEMA
  assert.ok(validateTradingConfig(f.config).includes('l4_release_feature_schema_mismatch'))
  f.receipt.feature_schema=L4_TIMEXER_FEATURE_SCHEMA
  a.model.recipe.names=[...names].sort()
  assert.ok(validateTradingConfig(f.config).length>0)
  assert.equal((await refreshExpectedReturnServingState(env,'2026-09-14')).expected_return_owner,null)
  a.model.recipe.names=names
  delete a.release
  assert.ok(validateTradingConfig(f.config).length>0)
})



test('new L4 allocation readiness follows serving release, not retired EV OOF tables', async () => {
  const f=fixture()
  const store=new Map<string,string>()
  const env:any={
    KV:{
      get:async(key:string,kind?:string)=>{
        if (key==='trading:config') return f.config
        const value=store.get(key) ?? null
        return value!==null && kind==='json' ? JSON.parse(value) : value
      },
      put:async(key:string,value:string)=>{store.set(key,value)},
    },
    DB:{prepare:()=>({first:async()=>f.identity})},
  }
  const date='2026-09-23'
  const ready=await runDailyAllocatorEvReadiness(env,date,{runId:'l4-ready'})
  assert.equal(ready.state,'ready')
  assert.match(ready.summary,/legacy_ev_oof=retired_incompatible/)
  assert.equal(JSON.parse(store.get('scheduler:run:allocator-ev-readiness:'+date)!).status,'success')
  f.artifact.release.decision='FAIL'
  const invalid=await runDailyAllocatorEvReadiness(env,date,{runId:'l4-invalid'})
  assert.equal(invalid.state,'fatal')
  assert.equal(JSON.parse(store.get('scheduler:run:allocator-ev-readiness:'+date)!).status,'error')
})


test('official restriction readiness accepts a completed historical refresh after midnight', () => {
  const checkedAt='2026-09-23T16:27:28Z'
  const receipt={status:'success',trade_date:'2026-09-23',checked_at:checkedAt}
  assert.equal(officialTradingRestrictionsRefreshComplete(receipt,checkedAt,'2026-09-23'),true)
  assert.equal(officialTradingRestrictionsRefreshComplete(receipt,checkedAt,'2026-09-24'),false)
  assert.equal(officialTradingRestrictionsRefreshComplete(receipt,'2026-09-23T16:28:00Z','2026-09-23'),false)
  assert.equal(officialTradingRestrictionsRefreshComplete({...receipt,status:'error'},checkedAt,'2026-09-23'),false)
})


test('explicit 131 monthly profile keeps candidate-only controls for both roles', async () => {
  const original=globalThis.fetch, bodies:any[]=[]
  globalThis.fetch=async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({status:'spawned',execution_id:'synthetic'}),{status:200})
  }
  try {
    for (const [mode,profile] of [
      ['single_b_tabpack_v1','active8-release-model-profiles-v6-timexer-exo131'],
      [undefined,'active8-release-model-profiles-v6-timexer-price131'],
    ]) {
      const env:any={ML_CONTROLLER_URL:'https://example.invalid',
        ACTIVE8_FEATURE_SEMANTIC_VERSION:'formal131-without-unverified-daily-owners-v1',
        KV:{get:async()=>({l4Distribution:{operating_mode:mode}})}}
      await runActive8OofLifecycle(env,'2026-10-08','monthly')
      const body=bodies.at(-1)
      assert.equal(body.model_profile_schema_version,profile)
      assert.equal(body.promote,false)
      assert.equal(body.dispatch_full_fit,true)
    }
    const count=bodies.length
    await assert.rejects(runActive8OofLifecycle({ML_CONTROLLER_URL:'https://example.invalid',
      ACTIVE8_FEATURE_SEMANTIC_VERSION:'unknown',KV:{get:async()=>null}} as any,'2026-10-08','monthly'),
      /active8_feature_semantic_unknown/)
    assert.equal(bodies.length,count)
  } finally {globalThis.fetch=original}
})
