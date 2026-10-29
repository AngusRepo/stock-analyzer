import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { verifyPublicationReceipt } from './premarketPublicationReceipt'
function canonical(v:any):string {
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']'
  if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'
  return JSON.stringify(v)
}
function signed(p:any){const {checksum,...body}=p;return {...body,checksum:createHash('sha256').update(canonical(body)).digest('hex')}}
function fixture():any {
  const plan={execution_scope:'paper',signal_date:'2026-10-16',plan_id:'a'.repeat(64),policy_identity:'b'.repeat(64),targets:{'2330':{weight:.2}}}
  const source={run_id:'run-1',run_date:plan.signal_date,checksum:'c'.repeat(64)},context={trade_date:'2026-10-19',checksum:'d'.repeat(64)}
  const storedSnapshot='e'.repeat(64),manifest={source_run_id:source.run_id,signal_date:source.run_date,snapshot_kind:'allocation_context'}
  const publication=signed({schema_version:'premarket-serving-publication-v1',run_id:source.run_id,signal_date:source.run_date,
    trade_date:context.trade_date,context_checksum:context.checksum,l3_checksum:source.checksum,plan_id:plan.plan_id,
    policy_identity:plan.policy_identity,allocation_snapshot_id:storedSnapshot,target_count:1,closure:{prediction_seed_symbols:1,
      prediction_symbols:1,predictions_written:8,prediction_symbol_closure_passed:true,incomplete_active_model_symbols:0,
      recommendation_seed_rows:1,recommendation_closed_rows:1,recommendation_row_closure_passed:true}})
  return {plan,source,context,storedSnapshot,manifest,publication,rows:[{symbol:'2330',alpha_allocation:JSON.stringify({
    plan_id:plan.plan_id,policy_identity:plan.policy_identity,expected_return_owner:'l4_distribution',engine:'sparse_tangent_inverse_risk',allocation_weight:.2})}]}
}
test('verified serving receipt needs no parent NAV status or callback',async()=>{await verifyPublicationReceipt(fixture())})
for(const fault of ['checksum','source','context','snapshot','plan','weight','rows','closure'])test('reject publication mismatch: '+fault,async()=>{
  const input=fixture()
  if(fault==='checksum')input.publication.checksum='0'.repeat(64)
  if(fault==='source')input.source.run_id='another-run'
  if(fault==='context')input.context.checksum='f'.repeat(64)
  if(fault==='snapshot')input.manifest.source_run_id='another-run'
  if(fault==='plan')input.plan.policy_identity='f'.repeat(64)
  if(fault==='weight'){const a=JSON.parse(input.rows[0].alpha_allocation);a.allocation_weight=.3;input.rows[0].alpha_allocation=JSON.stringify(a)}
  if(fault==='rows')input.rows.push(input.rows[0])
  if(fault==='closure'){input.publication.closure.incomplete_active_model_symbols=1;input.publication=signed(input.publication)}
  await assert.rejects(verifyPublicationReceipt(input),/premarket_serving_receipt/)
})

// R33: the seed closes with unscored names, and a held name outside the seed is a locked target with no row.
function r33Fixture():any {
  const input=fixture()
  input.plan.r33_projection={}
  input.plan.targets['2330']={weight:.2,current_weight:0,locked:false}
  input.plan.targets['9999']={weight:.1,current_weight:.1,locked:true}
  input.publication.target_count=2
  Object.assign(input.publication.closure,{prediction_seed_symbols:3,prediction_symbols:2,
    r33_unscored_missing_prediction_count:1,r33_held_outside_seed_prediction_symbols:1})
  input.publication=signed(input.publication)
  return input
}
test('R33 receipt closes the seed with unscored names and a locked held name outside it',async()=>{await verifyPublicationReceipt(r33Fixture())})
test('R33 receipt closes without the optional R33 counts when they are zero',async()=>{
  const input=r33Fixture()
  delete input.plan.targets['9999'];input.publication.target_count=1
  delete input.publication.closure.r33_unscored_missing_prediction_count
  delete input.publication.closure.r33_held_outside_seed_prediction_symbols
  input.publication.closure.prediction_seed_symbols=2
  input.publication=signed(input.publication)
  await verifyPublicationReceipt(input)
})
test('a non-R33 plan still rejects a held name outside the rows',async()=>{
  const input=r33Fixture();delete input.plan.r33_projection
  await assert.rejects(verifyPublicationReceipt(input),/premarket_serving_receipt_closure_mismatch/)
})
for(const fault of ['unscored','unscored_negative','unlocked_outside','unheld_outside','held_count','target_count','seed_rows','duplicate_row'])
  test('reject R33 closure mismatch: '+fault,async()=>{
    const input=r33Fixture(), c=input.publication.closure
    if(fault==='unscored')c.r33_unscored_missing_prediction_count=2
    if(fault==='unscored_negative'){c.r33_unscored_missing_prediction_count=-1;c.prediction_symbols=4}
    if(fault==='unlocked_outside')input.plan.targets['9999'].locked=false
    if(fault==='unheld_outside')input.plan.targets['9999'].current_weight=0
      if(fault==='held_count')c.r33_held_outside_seed_prediction_symbols=2
    if(fault==='target_count')input.publication.target_count=1
    if(fault==='seed_rows')c.recommendation_seed_rows=2
    if(fault==='duplicate_row'){input.rows.push(input.rows[0]);c.recommendation_seed_rows=2;c.recommendation_closed_rows=2}
    input.publication=signed(input.publication)
    await assert.rejects(verifyPublicationReceipt(input),/premarket_serving_receipt_closure_mismatch/)
  })
test('reject an R33 row with no plan target',async()=>{
  const input=r33Fixture();input.rows[0].symbol='1101'
  await assert.rejects(verifyPublicationReceipt(input),/premarket_serving_receipt/)
})
