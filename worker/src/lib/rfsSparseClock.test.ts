import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeRfs, type RfsSummary } from './rfsSparseClock'
const latest: RfsSummary = {plan_id:'p',policy_identity:'policy',model_checksum:'m',signal_date:'2026-10-01',status:'collecting',packet_checksum:'checksum',blockers:'[]',candidate_count:634}
test('count valid allocation pairs, never candidate rows or blocked attempts',()=>{
  const c=summarizeRfs(latest,'p',{samples:3,dates:2,blocked:1},[])
  assert.equal(c.sample_count,3);assert.equal(c.distinct_dates,2);assert.equal(c.coverage,.75)
  assert.equal(c.incumbent_delta,null);assert.equal(c.confidence_bound,null)
  assert.equal(c.details.candidate_count,634)
})
test('missing current plan receipt is visible despite historical samples',()=>{
  const c=summarizeRfs(latest,'new',{samples:3,dates:2,blocked:0},[])
  assert.equal(c.status,'blocked');assert.ok(c.blockers.includes('current_published_plan_comparison_missing'))
})
test('mature fixed-basket results retain 5/20 horizon and no NAV authority',()=>{
  const c=summarizeRfs(latest,'p',{samples:3,dates:2,blocked:0},[{horizon:5,dates:2,mean_delta:.01},{horizon:20,dates:1,mean_delta:-.02}])
  assert.equal(c.incumbent_delta,.01);assert.equal(c.details.mean_delta_20,-.02)
  assert.equal(c.details.production_effect,false);assert.equal(c.auto_promote,false)
})
