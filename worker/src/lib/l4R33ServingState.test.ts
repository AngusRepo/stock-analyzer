import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readCurrentExpectedReturnServingState } from './expectedReturnServingState'
import { L4_ACCEPTANCE_CHECKS, L4_R33_FEATURE_SCHEMA, R33_MODELS } from './l4ReleaseEvidence'
import { R33_EQUAL7_ISOTONIC } from './paperStrategyMode'

const l3={artifact_id:'r33-equal7:c1:0123456789abcdef',cohort_id:'c1',payload_checksum:'d'.repeat(64),base_artifact_set_checksum:'e'.repeat(64)}

function env(config:any) {
  const sql=new DatabaseSync(':memory:')
  sql.exec('CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER PRIMARY KEY,artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT)')
  sql.prepare('INSERT INTO active8_ensemble_pointer_v1 VALUES(1,?,?,?,?)').run(...Object.values(l3))
  const statement=(query:string,args:any[]=[]):any=>({bind:(...v:any[])=>statement(query,v),first:async()=>sql.prepare(query).get(...args) ?? null})
  const db:any={prepare:statement}
  return {KV:{get:async(key:string)=>key==='trading:config'?config:null},DB:db,LEARNING_DB:db,MULTI_D1_ACTIVE_DOMAINS:'learning'} as any
}

function policy(): any {
  const model={schema_version:'r33-seven-model-equal-z-isotonic-v1',feature_names:[...R33_MODELS.flatMap(m=>[`${m}_z`,`${m}_available`]),'score']}
  const checksum='b'.repeat(64)
  const receipt={schema_version:'l4-paper-acceptance-v1',feature_schema:L4_R33_FEATURE_SCHEMA,model_checksum:checksum,
    checks:Object.fromEntries(L4_ACCEPTANCE_CHECKS.map(k=>[k,true])),acceptance_mode:'paper_experiment',efficacy_status:'unproven',
    experiment_authorization:{approved:true,scope:'paper',model_checksum:checksum,source_reference:'synthetic-test-only'}}
  return {scope:'paper',operating_mode:R33_EQUAL7_ISOTONIC,strategy_role:'B',
    artifact:{schema_version:'l4-distribution-v1',feature_schema:L4_R33_FEATURE_SCHEMA,model,model_checksum:checksum,l3_identity:l3,
      release:{scope:'paper',decision:'PASS',model_checksum:checksum,acceptance_mode:'paper_experiment',efficacy_status:'unproven',
        validation_receipt:receipt,validation_receipt_checksum:'f'.repeat(64)}}}
}

test('R33 L4 release serves only with its operating mode',async()=>{
  assert.equal((await readCurrentExpectedReturnServingState(env({l4Distribution:policy()}))).expected_return_owner,'l4_distribution')
  const wrongMode={...policy(),operating_mode:'single_b_full_mlp_median_v1'}
  const state=await readCurrentExpectedReturnServingState(env({l4Distribution:wrongMode}))
  assert.equal(state.expected_return_owner,null)
  assert.deepEqual(state.hard_alerts,['new_l4_release_or_l3_identity_invalid'])
  const noMode=policy();delete noMode.operating_mode
  assert.equal((await readCurrentExpectedReturnServingState(env({l4Distribution:noMode}))).expected_return_owner,null)
})
