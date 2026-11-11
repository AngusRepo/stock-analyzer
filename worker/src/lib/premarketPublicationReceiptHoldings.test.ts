import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { verifyPublicationReceipt } from './premarketPublicationReceipt'

// l4_distribution_runtime plans carry rows ∪ holdings: a held name outside the seed has a
// target but no recommendation row, and must not block the day's receipt.
function canonical(v:any):string {
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']'
  if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'
  return JSON.stringify(v)
}
function signed(p:any){const {checksum,...body}=p;return {...body,checksum:createHash('sha256').update(canonical(body)).digest('hex')}}
const plan_id='a'.repeat(64), policy_identity='b'.repeat(64)
const row=(symbol:string,weight:number)=>({symbol,alpha_allocation:JSON.stringify({plan_id,policy_identity,
  expected_return_owner:'l4_distribution',engine:'sparse_tangent_inverse_risk',allocation_weight:weight})})

/** Two seed rows; `extra` targets have no recommendation row. */
function fixture(extra:Record<string,any>={}, seedRows=2):any {
  const targets:Record<string,any>={
    '2330':{weight:.2,current_weight:0,locked:false,expected_return_gross:.01},
    '2317':{weight:0,current_weight:0,locked:false,expected_return_gross:null},
    ...extra,
  }
  const plan={execution_scope:'paper',signal_date:'2026-10-30',plan_id,policy_identity,targets}
  const source={run_id:'run-1',run_date:plan.signal_date,checksum:'c'.repeat(64)},context={trade_date:'2026-11-02',checksum:'d'.repeat(64)}
  const storedSnapshot='e'.repeat(64),manifest={source_run_id:source.run_id,signal_date:source.run_date,snapshot_kind:'allocation_context'}
  const publication=signed({schema_version:'premarket-serving-publication-v1',run_id:source.run_id,signal_date:source.run_date,
    trade_date:context.trade_date,context_checksum:context.checksum,l3_checksum:source.checksum,plan_id,policy_identity,
    allocation_snapshot_id:storedSnapshot,target_count:Object.keys(targets).length,closure:{prediction_seed_symbols:2,
      prediction_symbols:2,predictions_written:16,prediction_symbol_closure_passed:true,incomplete_active_model_symbols:0,
      recommendation_seed_rows:seedRows,recommendation_closed_rows:seedRows,recommendation_row_closure_passed:true}})
  return {plan,source,context,storedSnapshot,manifest,publication,rows:[row('2330',.2),row('2317',0)]}
}
const held={weight:.1,current_weight:.1,locked:true,expected_return_gross:null}
const closure=/premarket_serving_receipt_closure_mismatch/

test('a held name outside the seed passes the receipt closure',async()=>{
  await verifyPublicationReceipt(fixture({'2454':held}))
  await verifyPublicationReceipt(fixture({'2454':held,'1101':{...held,weight:.05,current_weight:.05}}))
})

test('the original all-seeded plan still passes',async()=>{await verifyPublicationReceipt(fixture())})

for(const [name,target] of Object.entries({
  'a non-held target': {weight:.1,current_weight:0,locked:false,expected_return_gross:.02},
  'an unlocked holding': {...held,locked:false},
  'a locked target with zero weight held': {...held,weight:0,current_weight:0},
  'a locked target with missing current weight': {weight:.1,locked:true,expected_return_gross:null},
  'a locked flag that is not true': {...held,locked:1},
}))test(`${name} outside the rows is still rejected`,async()=>{
  await assert.rejects(verifyPublicationReceipt(fixture({'2454':target})),closure)
})

test('row count must still equal the seed and closed rows',async()=>{
  // Seed says 3 rows while D1 holds 2; the held target must not stand in for the missing row.
  await assert.rejects(verifyPublicationReceipt(fixture({'2454':held},3)),closure)
  const seedLong=fixture({'2454':held})
  seedLong.publication.closure.recommendation_seed_rows=3
  seedLong.publication=signed(seedLong.publication)
  await assert.rejects(verifyPublicationReceipt(seedLong),closure)
  const seedShort=fixture({'2454':held})
  seedShort.publication.closure.recommendation_seed_rows=1
  seedShort.publication=signed(seedShort.publication)
  await assert.rejects(verifyPublicationReceipt(seedShort),closure)
  const closedShort=fixture({'2454':held})
  closedShort.publication.closure.recommendation_closed_rows=1
  closedShort.publication=signed(closedShort.publication)
  await assert.rejects(verifyPublicationReceipt(closedShort),closure)
  const duplicate=fixture({'2454':held})
  duplicate.rows[1]=duplicate.rows[0]
  await assert.rejects(verifyPublicationReceipt(duplicate),closure)
  // A duplicated row must not count toward the seed even when every other target is a holding.
  const duplicateHeld=fixture({'2454':held})
  delete duplicateHeld.plan.targets['2317']
  duplicateHeld.rows[1]=duplicateHeld.rows[0]
  duplicateHeld.publication.target_count=2
  duplicateHeld.publication=signed(duplicateHeld.publication)
  await assert.rejects(verifyPublicationReceipt(duplicateHeld),closure)
  const notClosed=fixture({'2454':held})
  notClosed.publication.closure.recommendation_row_closure_passed=false
  notClosed.publication=signed(notClosed.publication)
  await assert.rejects(verifyPublicationReceipt(notClosed),closure)
})

test('target_count must still equal the plan targets including holdings',async()=>{
  const input=fixture({'2454':held})
  input.publication.target_count=2
  input.publication=signed(input.publication)
  await assert.rejects(verifyPublicationReceipt(input),closure)
})

test('a plan of holdings only, with no served rows, is rejected',async()=>{
  const input=fixture({'2454':held},0)
  input.rows=[]
  delete input.plan.targets['2330']; delete input.plan.targets['2317']
  input.publication.target_count=1
  input.publication=signed(input.publication)
  await assert.rejects(verifyPublicationReceipt(input),closure)
})

test('a served row outside the plan targets is still rejected',async()=>{
  // Every target is either served or held, so only the readback can catch the stray row.
  const input=fixture({'2454':held})
  delete input.plan.targets['2317']
  input.rows[1]=row('9999',0)
  input.publication.target_count=2
  input.publication=signed(input.publication)
  await assert.rejects(verifyPublicationReceipt(input),/premarket_serving_receipt_plan_readback_mismatch/)
})
