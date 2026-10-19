import assert from 'node:assert/strict'
import test from 'node:test'
import {atomicInputFailureOnly,historicalAtomicFailureOnly,verifyFormalServingClosure} from './premarketServingClosure'

const error='paired_nav:atomic_daily:paired_nav_source_or_capture_failed; paired_nav:atomic_candidate_setup:paired_nav_atomic_daily_inputs_missing'
function fixture(): Parameters<typeof verifyFormalServingClosure>[0] {
  const plan={plan_id:'a'.repeat(64),policy_identity:'b'.repeat(64),execution_scope:'paper',signal_date:'2026-10-14',targets:{A:{weight:.1},B:{weight:0}}} as any
  const log={status:'error' as const,run_id:'run',run_date:'2026-10-14',error,duration_ms:1,timestamp:'2026-10-15T00:00:00Z'}
  return {runId:'run',signalDate:'2026-10-14',error,plan,
    manifest:{source_run_id:'run',signal_date:'2026-10-14',snapshot_kind:'allocation_context'},
    prediction:{...log,task:'ml-predict',summary:'run_id=run symbols=2/2 rows=16 models=8 incomplete_active_model_symbols=0 symbol_closure=True active_model_closure=True'},
    recommendation:{...log,task:'recommendation',summary:'run_id=run recos_updated=2 filtered=0 seed_rows=2 closure=True'},
    rows:['A','B'].map(symbol=>({symbol,alpha_allocation:JSON.stringify({plan_id:plan.plan_id,policy_identity:plan.policy_identity,
      expected_return_owner:'l4_distribution',engine:'sparse_tangent_inverse_risk',allocation_weight:plan.targets[symbol].weight})}))}
}
test('complete formal Paper outputs admit the same plan while original research errors remain',()=>{
  const f=fixture(),before=JSON.stringify(f)
  verifyFormalServingClosure(f)
  assert.equal(JSON.stringify(f),before)
  assert.ok(atomicInputFailureOnly(error))
})
const historicalError='paired_nav:atomic_collection:historical_not_prospective; paired_nav:atomic_daily:requires_allocation_and_native_execution; paired_nav:atomic_candidate_setup:paired_nav_atomic_no_executable_plans'
function historicalFixture(){
  const f=fixture();f.signalDate='2026-10-15';f.plan.signal_date=f.signalDate;f.error=historicalError
  f.historicalRecoveryTradeDate='2026-10-16'
  f.nowMs=Date.parse('2026-10-16T14:00:00+08:00')
  Object.assign(f.manifest!,{signal_date:f.signalDate,prospective:0,frozen_at:'2026-10-16T13:33:25+08:00'})
  for(const log of [f.prediction!,f.recommendation!]){log.run_date=f.signalDate;log.error=historicalError}
  return f
}
test('exact historical recovery publishes verified formal plan without changing failed NAV evidence',()=>{
  const f=historicalFixture(),before=JSON.stringify(f)
  verifyFormalServingClosure(f);assert.equal(JSON.stringify(f),before)
  assert.ok(historicalAtomicFailureOnly(historicalError));assert.equal(atomicInputFailureOnly(historicalError),false)
})
test('historical recovery rejects other dates, prospective claims and partial or extra failures',()=>{
  for(const change of [
    (f:ReturnType<typeof historicalFixture>)=>{delete f.historicalRecoveryTradeDate},
    (f:ReturnType<typeof historicalFixture>)=>{f.historicalRecoveryTradeDate='2026-10-19'},
    (f:ReturnType<typeof historicalFixture>)=>{f.manifest!.prospective=1},
    (f:ReturnType<typeof historicalFixture>)=>{f.manifest!.frozen_at='2026-10-16T08:00:00+08:00'},
    (f:ReturnType<typeof historicalFixture>)=>{f.manifest!.frozen_at='2026-10-16T15:00:00+08:00'},
    (f:ReturnType<typeof historicalFixture>)=>{f.prediction!.error='prediction_failed'},
    (f:ReturnType<typeof historicalFixture>)=>{f.error+='; d1_write:failed'},
  ]){const f=historicalFixture();change(f);assert.throws(()=>verifyFormalServingClosure(f))}
  for(const e of ['',historicalError.split(';')[0],historicalError+'; paired_nav:unknown_corruption'])assert.equal(historicalAtomicFailureOnly(e),false)
})
test('serving errors, live scope, stale identities and incomplete outputs fail closed',()=>{
  const mutations:Array<(f:ReturnType<typeof fixture>)=>void>=[
    f=>{f.error+='; d1_write:failed'},f=>{f.error='paired_nav:unknown_corruption'},
    f=>{f.plan.execution_scope='private_research'},f=>{f.plan.signal_date='2026-10-13'},
    f=>{f.manifest!.source_run_id='other'},f=>{f.manifest=null},
    f=>{f.prediction!.run_id='other'},f=>{f.recommendation!.run_date='2026-10-13'},
    f=>{f.prediction!.error='prediction_failed'},f=>{f.prediction!.status='running'},
    f=>{f.prediction!.summary=f.prediction!.summary.replace('symbols=2/2','symbols=1/2')},
    f=>{f.prediction!.summary=f.prediction!.summary.replace('incomplete_active_model_symbols=0','incomplete_active_model_symbols=1')},
    f=>{f.recommendation!.summary=f.recommendation!.summary.replace('closure=True','closure=False')},
    f=>{f.rows.pop()},f=>{f.rows[1]=f.rows[0]},
    f=>{f.rows[0].alpha_allocation=f.rows[0].alpha_allocation!.replace('0.1','0.2')},
    f=>{f.rows[0].alpha_allocation=f.rows[0].alpha_allocation!.replace('a'.repeat(64),'c'.repeat(64))},
  ]
  for(const change of mutations){const f=fixture();change(f);assert.throws(()=>verifyFormalServingClosure(f))}
  for(const error of ['',null,'paired_nav:atomic_daily:other'])assert.equal(atomicInputFailureOnly(error),false)
})
