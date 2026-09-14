import assert from 'node:assert/strict'
import test from 'node:test'
import { L4_FEATURE_SCHEMA, L4_ACCEPTANCE_CHECKS } from './l4ReleaseEvidence'
import { buildChampionTradingConfig, validateTradingConfig } from './tradingConfig'
import { refreshExpectedReturnServingState } from './expectedReturnServingState'

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
