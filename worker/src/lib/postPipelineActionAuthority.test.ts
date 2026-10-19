import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { inspectPostPipelineActionAuthority } from './postPipelineActionAuthority'
import { inspectActive8ActionAuthorityState } from './allocatorEvDailyLifecycle'
import { L4_FEATURE_SCHEMA, L4_ACCEPTANCE_CHECKS } from './l4ReleaseEvidence'

async function main() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER,artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT);
    CREATE TABLE active8_ensemble_artifacts_v1(artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT,validation_decision TEXT,state TEXT,production_effect INTEGER);
    CREATE TABLE daily_recommendations(date TEXT,has_buy_signal INTEGER,eligible_for_pending_buy INTEGER,signal TEXT);
    CREATE TABLE l4_portfolio_head_v1(account_id INTEGER,plan_id TEXT);
    CREATE TABLE l4_portfolio_plans_v1(account_id INTEGER,plan_id TEXT,payload_json TEXT,activated INTEGER);`)
  const identity = { artifact_id:'l3-A', cohort_id:'cohort-A', payload_checksum:'d'.repeat(64), base_artifact_set_checksum:'e'.repeat(64) }
  sql.prepare('INSERT INTO active8_ensemble_pointer_v1 VALUES(1,?,?,?,?)').run(...Object.values(identity))
  sql.prepare("INSERT INTO active8_ensemble_artifacts_v1 VALUES(?,?,?,?,'FAIL','production',1)").run(...Object.values(identity))
  sql.exec("INSERT INTO daily_recommendations VALUES('2026-10-14',1,1,'BUY')")
  const model='b'.repeat(64), planId='a'.repeat(64)
  const plan:any={schema_version:'l4-portfolio-plan-v1',owner:'l4_distribution',execution_scope:'paper',parent_plan_id:null,
    plan_id:planId,policy_identity:'c'.repeat(64),model_checksum:model,signal_date:'2026-10-14',account_id:1,nav_at_decision:1e6,
    l3_identity:identity,weights:{A:.2},targets:{A:{weight:.2,current_weight:0,locked:false,expected_return_gross:.02}},
    constraints:{exposure_cap:.8,name_cap:.3,min_weight:0,max_positions:5},
    proof:{within_tolerance:true,absolute_objective_gap:0,tolerance:1e-8,evaluated_candidate_count:1,preselection:false}}
  sql.prepare('INSERT INTO l4_portfolio_head_v1 VALUES(1,?)').run(planId)
  sql.prepare('INSERT INTO l4_portfolio_plans_v1 VALUES(1,?,?,1)').run(planId,JSON.stringify(plan))
  const receipt={schema_version:'l4-paper-acceptance-v1',feature_schema:L4_FEATURE_SCHEMA,model_checksum:model,
    checks:Object.fromEntries(L4_ACCEPTANCE_CHECKS.map(key=>[key,true])),acceptance_mode:'paper_experiment',efficacy_status:'unproven',
    experiment_authorization:{approved:true,scope:'paper',model_checksum:model,source_reference:'synthetic-test-only'}}
  const config:any={l4Distribution:{scope:'paper',artifact:{schema_version:'l4-distribution-v1',feature_schema:L4_FEATURE_SCHEMA,
    model_checksum:model,l3_identity:identity,release:{scope:'paper',decision:'PASS',model_checksum:model,
      acceptance_mode:'paper_experiment',efficacy_status:'unproven',validation_receipt:receipt,validation_receipt_checksum:'f'.repeat(64)}}}}
  function statement(query:string,args:any[]=[]):any {return {bind:(...v:any[])=>statement(query,v),first:async()=>sql.prepare(query).get(...args)??null}}
  const db:any={prepare:statement}
  const env:any={DB:db,LEARNING_DB:db,CORE_DB:db,PAPER_DB:db,MULTI_D1_ACTIVE_DOMAINS:'learning,core,paper',MULTI_D1_STRICT:'true',KV:{get:async()=>config}}
  assert.equal((await inspectActive8ActionAuthorityState(db,db,'2026-10-14')).validServingRows,0,'legacy FAIL still blocked')
  assert.equal((await inspectPostPipelineActionAuthority(env,'2026-10-14')).validServingRows,1,'verified Paper owner uses paired L3 integrity, not legacy ranking result')
  sql.exec("UPDATE active8_ensemble_artifacts_v1 SET payload_checksum='corrupt'")
  assert.equal((await inspectPostPipelineActionAuthority(env,'2026-10-14')).validServingRows,0,'checksum corruption remains blocked')
  sql.prepare('UPDATE active8_ensemble_artifacts_v1 SET payload_checksum=?,production_effect=0').run(identity.payload_checksum)
  assert.equal((await inspectPostPipelineActionAuthority(env,'2026-10-14')).validServingRows,0,'disabled artifact remains blocked')
  sql.exec('UPDATE active8_ensemble_artifacts_v1 SET production_effect=1')
  await assert.rejects(inspectPostPipelineActionAuthority(env,'2026-10-13'),/paper_plan_missing/)
  config.l4Distribution.artifact.release.decision='FAIL'
  await assert.rejects(inspectPostPipelineActionAuthority(env,'2026-10-14'),/release_evidence_missing/)
  config.l4Distribution.artifact.release.decision='PASS'
  sql.exec("UPDATE active8_ensemble_pointer_v1 SET cohort_id='changed'")
  await assert.rejects(inspectPostPipelineActionAuthority(env,'2026-10-14'),/paired_l3_changed/)
  sql.close()
  console.log('PASS post-pipeline Paper authority: valid release, exact L3 identity, corrupted/disabled/replaced artifacts and wrong dates')
}
main().catch(error=>{console.error(error);process.exitCode=1})
