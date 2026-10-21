import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash} from 'node:crypto'
import {premarketPublicationCutoff, premarketPublicationMinutes} from './premarketPublicationWindow'
import {storeL4PortfolioPlan} from './l4PortfolioPlan'
import {withPaperExecutionScope} from './paperExecutionScope'
import {l4NativeFixture} from './l4NativeFixture.testSupport'

test('date-bound cutoff restores 08:45 on all other dates',()=>{
 for(const date of ['2026-10-09','2026-10-12','2026-10-13','2026-10-14','2026-10-15','2026-10-16','2026-10-19','2026-10-20','2026-10-21','2026-10-22']){
  const clock=['2026-10-12','2026-10-13','2026-10-14','2026-10-16','2026-10-19','2026-10-20','2026-10-21'].includes(date)?'24:00':'08:45'
  assert.equal(premarketPublicationCutoff(date),Date.parse(`${date}T${clock}:00+08:00`))
  assert.equal(premarketPublicationMinutes(date),['2026-10-12','2026-10-13','2026-10-14','2026-10-16','2026-10-19','2026-10-20','2026-10-21'].includes(date)?1440:525)
 }
})

test('optimizer publication honors the same date-bound cutoff before database writes',async()=>{
 const unsigned={schema_version:'l4-portfolio-plan-v1',owner:'l4_distribution',parent_plan_id:null,
  account_anchor:{order_watermark:0,cash:1e6,positions:[],settlement:{unsettledBuyAmount:0,unsettledSellAmount:0}},
  policy_identity:'a'.repeat(64),model_checksum:'b'.repeat(64),signal_date:'2026-10-08',account_id:1,nav_at_decision:1e6,
  weights:{A:.2},targets:{A:{weight:.2,current_weight:0,locked:false}},
  constraints:{exposure_cap:.8,name_cap:.3,min_weight:.03,max_positions:2},
  proof:{within_tolerance:true,absolute_objective_gap:0,tolerance:1e-8,evaluated_candidate_count:1,preselection:false}}
 const canonical_payload=JSON.stringify(unsigned)
 const envelope={plan:{...unsigned,plan_id:createHash('sha256').update(canonical_payload).digest('hex')},
  canonical_payload,allocation_snapshot_id:'c'.repeat(64)}
 const f=l4NativeFixture();f.env.PAPER_DAILY_PLAN_OWNER='premarket_once_v1'
 // Stop at the first write; this test proves admission timing without a published model.
 let writes=0
 f.env.PAPER_DB.batch=async()=>{writes++;throw new Error('test_first_write')}
 try{
  for(const [day,time,allowed] of [['2026-10-12','08:59:59',true],['2026-10-12','09:00:00',true],
    ['2026-10-12','13:00:00',true],['2026-10-12','23:59:59',true],
    ['2026-10-13','08:45:00',true],['2026-10-13','08:59:59',true],
    ['2026-10-13','09:00:00',true],['2026-10-13','23:59:59',true],
    ['2026-10-14','08:45:00',true],['2026-10-14','23:59:59',true],
    ['2026-10-15','08:45:00',false],['2026-10-16','08:45:00',true],
    ['2026-10-16','23:59:59',true],['2026-10-19','08:45:00',true],['2026-10-19','23:59:59',true],['2026-10-20','08:45:00',true],['2026-10-20','23:59:59',true],['2026-10-21','08:45:00',true],['2026-10-22','08:45:00',false]] as const){
   f.ports.nowMs=Date.parse(`${day}T${time}+08:00`)
   const before=writes
   await withPaperExecutionScope(f.ports,async()=>{
    await assert.rejects(storeL4PortfolioPlan(f.env,envelope),allowed?/test_first_write/:/publication_forbidden/)
   })
   assert.equal(writes-before,allowed?1:0)
  }
 }finally{f.close()}
})
