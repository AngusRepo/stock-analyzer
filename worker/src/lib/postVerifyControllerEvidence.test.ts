import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { capturePostVerifyControllerEvidence, verifyPostVerifyControllerEvidence } from './postVerifyControllerEvidence'

const date='2026-10-16',at='2026-10-16T11:00:00+00:00',checksum='sha256:'+'a'.repeat(64)
const stable=(value:any):any=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value
const hash=async(value:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('')
function fixture() {
  const sql=new DatabaseSync(':memory:'),queries:string[]=[]
  sql.exec(`CREATE TABLE model_artifact_registry(artifact_id TEXT PRIMARY KEY,model_name TEXT,version TEXT,checksum TEXT,
    training_run_id TEXT,candidate_type TEXT,artifact_path TEXT,state TEXT,live_gate_status TEXT,promotion_decision TEXT,live_evidence_json TEXT);
    CREATE TABLE model_champion_history(event_id TEXT PRIMARY KEY,model_name TEXT,version TEXT,artifact_id TEXT,effective_at TEXT,
      retired_at TEXT,source TEXT,evidence_grade TEXT,evidence_json TEXT);
    CREATE TABLE active8_ensemble_artifacts_v1(artifact_id TEXT PRIMARY KEY,training_run_id TEXT,payload_json TEXT,
      payload_checksum TEXT,base_artifact_set_checksum TEXT,state TEXT);
    CREATE TABLE model_champion_pointers(model_name TEXT,champion_artifact_id TEXT);`)
  const db={prepare(query:string){queries.push(query);let values:any[]=[];const statement={bind(...args:any[]){values=args;return statement},
    async first(){return sql.prepare(query).get(...values)??null},async all(){return {success:true,results:sql.prepare(query).all(...values)}}};return statement}} as any
  const env={DB:db} as any
  const artifact=(id='a',model='LightGBM',state='production',live:any={})=>sql.prepare('INSERT INTO model_artifact_registry VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,model,'v1',checksum,'training-fixture','oof_full_fit_release','gs://fixture/'+id,state,'rolling_ic_passed','promoted',JSON.stringify(live))
  const history=(id='a',model='LightGBM',evidence:any={},eventId='event:'+id)=>sql.prepare('INSERT INTO model_champion_history VALUES(?,?,?,?,?,NULL,?,?,?)')
    .run(eventId,model,'v1',id,at,'model_champion_history','exact',JSON.stringify(evidence))
  const promote=(results:any[],promoted=1)=>({status:'ok',eligible:results.length,promoted,results,readback_verified:true})
  const single=()=>({status:'ok',can_promote:true,artifact_id:'a',model_name:'LightGBM',candidate_version:'v1',confirmed_at:at,errors:[]})
  return {sql,env,queries,artifact,history,promote,single}
}
function icResponse(f:ReturnType<typeof fixture>) {
  const decision={state:'shadowing',live_gate_status:'rolling_ic_passed',promotion_decision:'needs_multi_evidence_gate',
    metrics:{shadow_ic:.2,production_ic:.1,min_samples:50},root_cause:'rolling_ic_passed_needs_multi_evidence'}
  f.artifact('a','LightGBM','shadowing',{schema_version:'artifact-live-gate-v1',evaluated_at:at,
    selection_slot:'oof_full_fit_release_candidate',model_name:'LightGBM',artifact_id:'a',decision})
  f.sql.exec("UPDATE model_artifact_registry SET promotion_decision='needs_multi_evidence_gate'")
  return {status:'ok',source_of_truth:'model_artifact_registry/model_champion_pointers',run_date:date,n_rows_total:100,
    per_model_ic:{LightGBM:{status:'computed',ic:.1}},artifact_registry_updates:{status:'ok',selected:1,updated:1,
      updates:[{artifact_id:'a',model_name:'LightGBM',...decision}],errors:[]}}
}

test('IC validates full original response then exact fresh registry owner evidence',async()=>{
  const f=fixture(),response=icResponse(f)
  const proof=await capturePostVerifyControllerEvidence(f.env,'model-ic-rolling',date,response)
  assert.equal(await verifyPostVerifyControllerEvidence(f.env,proof),true)
  // A later legitimate promotion keeps the original IC decision, so it must
  // not force a replay of the prior computation just because state advances.
  f.sql.exec("UPDATE model_artifact_registry SET state='production',promotion_decision='active8_bundle_promoted',live_evidence_json=json_set(live_evidence_json,'$.promotion_controller','later')")
  assert.equal(await verifyPostVerifyControllerEvidence(f.env,proof),true)
  f.sql.exec("UPDATE model_artifact_registry SET live_evidence_json=json_set(live_evidence_json,'$.decision.metrics.shadow_ic',99)")
  assert.equal(await verifyPostVerifyControllerEvidence(f.env,proof),false)
  f.sql.close()
})
for(const fault of ['partial','errors','wrong-date','count','registry-state','malformed-models'])test(`IC rejects ${fault} despite HTTP-like outer status ok`,async()=>{
  const f=fixture(),response=icResponse(f)
  if(fault==='partial')response.artifact_registry_updates.status='partial_error'
  if(fault==='errors')response.artifact_registry_updates.errors.push('write failed' as never)
  if(fault==='wrong-date')response.run_date='2026-10-15'
  if(fault==='count')response.artifact_registry_updates.updated=0
  if(fault==='registry-state')f.sql.exec("UPDATE model_artifact_registry SET state='archived'")
  if(fault==='malformed-models')(response as any).per_model_ic='not-model-results'
  await assert.rejects(capturePostVerifyControllerEvidence(f.env,'model-ic-rolling',date,response),/post_verify_controller_/)
  f.sql.close()
})
test('single promotion verifies original history, not an unrelated current pointer',async()=>{
  const f=fixture();f.artifact();f.history()
  f.sql.exec("INSERT INTO model_champion_pointers VALUES('LightGBM','unrelated-current')")
  const proof=await capturePostVerifyControllerEvidence(f.env,'artifact-auto-promotion',date,f.promote([f.single()]))
  assert.equal(await verifyPostVerifyControllerEvidence(f.env,proof),true)
  f.sql.exec("UPDATE model_artifact_registry SET state='archived';UPDATE model_champion_history SET retired_at='2026-10-17'")
  assert.equal(await verifyPostVerifyControllerEvidence(f.env,proof),true)
  f.sql.exec('DELETE FROM model_champion_history')
  assert.equal(await verifyPostVerifyControllerEvidence(f.env,proof),false)
  assert.equal(f.queries.some(q=>/FROM model_champion_pointers/.test(q)),false)
  f.sql.close()
})
test('single promotion refuses a pointer-only or partial-error success claim',async()=>{
  const f=fixture();f.artifact()
  f.sql.exec("INSERT INTO model_champion_pointers VALUES('LightGBM','a')")
  await assert.rejects(capturePostVerifyControllerEvidence(f.env,'artifact-auto-promotion',date,f.promote([f.single()])),/history_missing/)
  f.history()
  await assert.rejects(capturePostVerifyControllerEvidence(f.env,'artifact-auto-promotion',date,
    f.promote([{...f.single(),status:'partial_error',errors:['history failed']}])) ,/partial_error/)
  f.sql.close()
})
for(const recovered of [false,true])test(`bundle promotion derives immutable history event identity; recovered=${recovered}`,async()=>{
  const f=fixture();f.artifact('a','LightGBM');f.artifact('b','XGBoost')
  const base_artifacts={LightGBM:{artifact_id:'a',version:'v1',checksum,candidate_type:'oof_full_fit_release'},
    XGBoost:{artifact_id:'b',version:'v1',checksum,candidate_type:'oof_full_fit_release'}}
  const payload=JSON.stringify(stable({base_artifacts,selected_models:['LightGBM','XGBoost']}))
  const payloadChecksum=await hash(payload),baseChecksum=await hash(JSON.stringify(stable(base_artifacts)))
  f.sql.prepare('INSERT INTO active8_ensemble_artifacts_v1 VALUES(?,?,?,?,?,?)').run('ensemble','training-fixture',payload,payloadChecksum,baseChecksum,'production')
  f.history('a','LightGBM',{ensemble_artifact_id:'ensemble',ensemble_payload_checksum:payloadChecksum,training_run_id:'training-fixture'},`champion:LightGBM:v1:training-fixture:ensemble:${payloadChecksum}`)
  f.history('b','XGBoost',{ensemble_artifact_id:'ensemble',ensemble_payload_checksum:payloadChecksum,training_run_id:'training-fixture'},`champion:XGBoost:v1:training-fixture:ensemble:${payloadChecksum}`)
  const response=f.promote([{status:'ok',can_promote:true,readback_verified:true,ensemble_artifact_id:'ensemble',
    training_run_id:'training-fixture',release_models:['LightGBM','XGBoost'],recovered_existing_commit:recovered,
    confirmed_at:recovered?'2026-10-16 11:00:00':at}],2)
  const proof=await capturePostVerifyControllerEvidence(f.env,'artifact-auto-promotion',date,response)
  assert.equal(proof.artifacts.length,2)
  assert.equal(await verifyPostVerifyControllerEvidence(f.env,proof),true)
  f.sql.exec("UPDATE active8_ensemble_artifacts_v1 SET payload_json=json_set(payload_json,'$.selected_models[0]','forged')")
  assert.equal(await verifyPostVerifyControllerEvidence(f.env,proof),false)
  f.sql.close()
})
test('legal zero promotions remain explicit and receipt/immutable identity tampering fails closed',async()=>{
  const f=fixture()
  const zero=await capturePostVerifyControllerEvidence(f.env,'artifact-auto-promotion',date,{status:'ok',eligible:0,promoted:0,results:[],readback_verified:true})
  assert.deepEqual(zero.artifacts,[])
  assert.equal(await verifyPostVerifyControllerEvidence(f.env,zero),true)
  assert.equal(await verifyPostVerifyControllerEvidence(f.env,{...zero,businessDate:'2026-10-15'}),false)
  f.artifact();f.history()
  const proof=await capturePostVerifyControllerEvidence(f.env,'artifact-auto-promotion',date,f.promote([f.single()]))
  f.sql.exec("UPDATE model_artifact_registry SET checksum='sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'")
  assert.equal(await verifyPostVerifyControllerEvidence(f.env,proof),false)
  f.sql.close()
})
test('controller owner read I/O and missing schema propagate instead of becoming optional invalidity',async()=>{
  const f=fixture();f.artifact();f.history()
  const proof=await capturePostVerifyControllerEvidence(f.env,'artifact-auto-promotion',date,f.promote([f.single()]))
  const db=f.env.DB
  f.env.DB={prepare(){return {bind(){return {async first(){throw new Error('fixture registry network timeout')}}}}}}
  await assert.rejects(verifyPostVerifyControllerEvidence(f.env,proof),/registry network timeout/)
  f.env.DB=db
  f.sql.exec('DROP TABLE model_artifact_registry')
  await assert.rejects(verifyPostVerifyControllerEvidence(f.env,proof),/no such table/)
  f.sql.close()
})

for (const [kind,result] of [['failed',{success:false,results:[]}],['missing',{success:true}],['invalid',{success:true,results:null}]] as const) {
  test(`promotion history ${kind} read result blocks verification, while successful zero rows is known invalid`,async()=>{
    const f=fixture();f.artifact();f.history()
    const proof=await capturePostVerifyControllerEvidence(f.env,'artifact-auto-promotion',date,f.promote([f.single()]))
    const db=f.env.DB
    f.env.DB={...db,prepare(query:string){
      const statement=db.prepare(query)
      if (query.includes('FROM model_champion_history')) statement.all=async()=>result
      return statement
    }}
    await assert.rejects(verifyPostVerifyControllerEvidence(f.env,proof),/owner_read_failed:promotion_history/)
    f.env.DB=db
    f.sql.exec('DELETE FROM model_champion_history')
    assert.equal(await verifyPostVerifyControllerEvidence(f.env,proof),false)
    f.sql.close()
  })
}
