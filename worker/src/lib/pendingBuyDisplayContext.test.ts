import assert from 'node:assert/strict'
import {test} from 'node:test'
import {projectPendingPlan} from './pendingBuyDisplayContext'
import type {L4PortfolioPlan} from './l4PortfolioPlan'
test('display projection uses exact daily plan review, including zero, not optimizer weight',()=>{
 const id='a'.repeat(64)
 const plan={plan_id:id,nav_at_decision:966998.13,targets:{'6994':{weight:.125,locked:false}},
 execution_review:{tradeDate:'2026-10-05',weights:{'6994':.0625},checksum:'b'.repeat(64),finalizedAtMs:1791158577538}} as unknown as L4PortfolioPlan
 const points=[`l4_plan:${id}`]
 assert.equal(projectPendingPlan(plan,'6994',points,'2026-10-05')?.target_value,60437.383125)
 assert.equal(projectPendingPlan(plan,'6994',points,'2026-10-05')?.executable,false)
 assert.equal(projectPendingPlan(plan,'6994',[], '2026-10-05'),null)
 assert.equal(projectPendingPlan(plan,'6994',points,'2026-10-06'),null)
 plan.execution_review!.weights['6994']=0
 assert.equal(projectPendingPlan(plan,'6994',points,'2026-10-05')?.target_value,0)
})
