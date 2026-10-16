import assert from 'node:assert/strict'
import test from 'node:test'
import {l4NativeFixture} from './l4NativeFixture.testSupport'
import {reconcileHistoricalPipeline} from './historicalPipelineReconcile'
const error='paired_nav:atomic_collection:historical_not_prospective; paired_nav:atomic_daily:requires_allocation_and_native_execution; paired_nav:atomic_candidate_setup:paired_nav_atomic_no_executable_plans'
const now=()=>Date.parse('2026-10-16T15:00:00+08:00')
const input={signal_date:'2026-10-15',morning_context:{trade_date:'2026-10-16'},l3_receipt:{run_date:'2026-10-15',run_id:'sealed-root'}}
for(const scenario of ['success','unknown','bad_error','live'])test(`receipt-only owner reservation is fenced: ${scenario}`,async()=>{
 const f=l4NativeFixture();let calls=0,verified=0
 f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1';f.env.LIVE_EXECUTION_CLIENT_ENABLED='0'
 f.env.LIVE_EXECUTION_SUBMIT_GUARD_ENABLED=scenario==='live'?'1':'0'
 try{
  f.sqls.ops.prepare("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key,attempt_count,last_error) VALUES(?,?,?,?,?,?,?)")
   .run('2026-10-15','pipeline_execution','sealed-root','error','old-execution',1,scenario==='bad_error'?'d1_write:failed':error)
  const deps={now,readL4PortfolioPlan:async()=>({plan_id:'a'.repeat(64)} as any),
   verifyStoredFormalServing:async()=>{verified++},dispatch:async()=>{calls++;if(scenario==='unknown')throw new Error('outcome unknown');return {status:'dispatched',execution_name:'jobs/executions/terminal-only'}}}
  if(scenario==='success'){
   const result=await reconcileHistoricalPipeline(f.env,input,deps)
   assert.equal(result.previous_error,error);assert.equal(result.canonical_run_id,'sealed-root')
   assert.equal(result.nav_credit,0)
  }else await assert.rejects(reconcileHistoricalPipeline(f.env,input,deps))
  const row=f.sqls.ops.prepare("SELECT * FROM pipeline_stage_runs WHERE business_date='2026-10-15' AND stage='pipeline_execution'").get() as any
  assert.equal(row.canonical_run_id,'sealed-root')
  assert.equal(row.status,scenario==='success'?'waiting':scenario==='unknown'?'running':'error')
  assert.equal(row.attempt_count,['success','unknown'].includes(scenario)?2:1)
  await assert.rejects(reconcileHistoricalPipeline(f.env,input,deps))
  assert.equal(calls,['success','unknown'].includes(scenario)?1:0)
  assert.equal(verified,['success','unknown'].includes(scenario)?1:0)
 }finally{f.close()}
})
