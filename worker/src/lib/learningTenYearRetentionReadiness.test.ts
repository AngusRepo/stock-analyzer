import assert from 'node:assert/strict'
import { test } from 'node:test'
import { learningRetentionBlockers } from './learningTenYearRetentionReadiness'
const base={policyReady:true,navReady:true,asOfDate:'2026-09-22',datasets:[{dataset_id:'predictions',candidate_rows:0}],receipts:[{dataset_id:'hot-drain:predictions',status:'cycle_complete',backlog_remaining:0,updated_at:'2026-09-22 02:30:00'}]}
test('configured 120/3650 policy and NAV recovery alone cannot declare Learning complete',()=>{
 assert.deepEqual(learningRetentionBlockers({...base,receipts:[]}),['retention_executor_not_current:predictions'])
})
test('only completed current receipts with zero actual backlog satisfy retention check',()=>{
 assert.deepEqual(learningRetentionBlockers(base),[])
 for(const patch of [{status:'error'},{backlog_remaining:1},{updated_at:'2026-09-01'},{updated_at:'2026-09-23'}])
  assert(learningRetentionBlockers({...base,receipts:[{...base.receipts[0],...patch}]}).length)
 assert.deepEqual(learningRetentionBlockers({...base,datasets:[{dataset_id:'predictions',candidate_rows:1}]}),['retention_backlog:predictions'])
 assert(learningRetentionBlockers({...base,navReady:false}).includes('nav_cold_storage_not_closed'))
})
