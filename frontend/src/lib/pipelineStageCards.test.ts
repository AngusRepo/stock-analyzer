import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SchedulerJob } from './api'
import { pipelineStageCards } from './pipelineStageCards'
const row=(phase:string,status='completed')=>({phase,status,elapsed_ms:10000,started_at:'2026-10-16T14:00:00Z',completed_at:'2026-10-16T14:00:10Z'})
const parent=()=>({id:'pipeline',runId:'run-a',statusRunDate:'2026-10-16',lastStatus:'waiting',summary:'dependency=input_prep',
  lastRunAt:'2026-10-16T07:02:32Z',lastDuration:'8m55s',
  pipelineProgress:{run_id:'run-a',run_date:'2026-10-16',phase:'input_prep',status:'waiting',started_at:'2026-10-16T14:00:00Z',
    phase_started_at:'2026-10-16T14:05:00Z',observed_at:'2026-10-16T14:05:00Z',execution_id:'b',completed:[],
    executions:{a:[row('node_capture_atomic_inputs')],b:[row('node_build_payloads','waiting')]}},
  pipelineBatches:[{phase:'input_prep',completed:5,total:23}],
} as unknown as SchedulerJob)
test('same-run continuation retains Atomic; deferred features never starts L2 or L3 or inherits historic time',()=>{
  const cards=pipelineStageCards(parent(),Date.parse('2026-10-16T14:06:00Z'))
  assert.deepEqual(cards.map(c=>c.stageVisualStatus),['completed','waiting','not_started','not_started'])
  assert.equal(cards[0].lastDuration,'0分10秒')
  assert.match(cards[1].summary,/5\/23/)
  assert.equal(cards[3].lastRunAt,null);assert.equal(cards[3].lastDuration,'N/A')
})
test('wrong-run history cannot turn a stage green; stale evidence does not spin',()=>{
  const p=parent();p.pipelineProgress!.run_id='old'
  assert(pipelineStageCards(p).every(c=>c.stageVisualStatus==='not_started'))
  const stale=pipelineStageCards(parent(),Date.parse('2026-10-16T15:00:00Z'))
  assert.equal(stale[1].stageVisualStatus,'stale')
  assert.equal(stale[0].stageVisualStatus,'completed')
})
test('dispatch and completed provider segment are not L3 seal; seal has its own receipt',()=>{
  const p=parent();const progress=p.pipelineProgress!
  progress.phase='dispatch_prediction';progress.status='completed'
  assert.equal(pipelineStageCards(p,Date.parse(progress.observed_at))[3].stageVisualStatus,'waiting')
  progress.executions!.c=[row('seal_l3_results') as any]
  assert.equal(pipelineStageCards(p)[3].stageVisualStatus,'completed')
})
test('missing previous telemetry is unknown, and an explicit blocked Atomic receipt stays red',()=>{
  const p=parent();p.pipelineProgress!.executions!.a=[]
  assert.equal(pipelineStageCards(p,Date.parse('2026-10-16T14:06:00Z'))[0].stageVisualStatus,'stale')
  p.pipelineProgress!.executions!.a=[row('node_capture_atomic_inputs','blocked') as any]
  assert.equal(pipelineStageCards(p,Date.parse('2026-10-16T14:06:00Z'))[0].stageVisualStatus,'blocked')
})

test('L3 request preparation cannot turn blocked TimesFM enrichment green',()=>{
  const p=parent();const progress=p.pipelineProgress!
  progress.phase='modal_inference';progress.status='running'
  progress.executions!.b=[row('node_l2_timesfm_enrich','blocked'),
    {...row('prepare_prediction_request'),completed_at:'2026-10-16T14:01:00Z'}] as any
  const cards=pipelineStageCards(p,Date.parse(progress.observed_at))
  assert.equal(cards[2].stageVisualStatus,'blocked')
  assert.match(cards[2].summary,/TimesFM 條件未滿足/)
  assert.equal(cards[3].stageVisualStatus,'running')
})

test('a newer successful enrichment clears the earlier blocked outcome',()=>{
  const p=parent();const progress=p.pipelineProgress!
  progress.phase='modal_inference';progress.status='running'
  progress.executions!.b=[row('node_l2_timesfm_enrich','blocked')] as any
  progress.executions!.c=[{...row('node_l2_timesfm_enrich'),completed_at:'2026-10-16T14:01:00Z'},
    {...row('prepare_prediction_request'),completed_at:'2026-10-16T14:02:00Z'}] as any
  assert.equal(pipelineStageCards(p,Date.parse(progress.observed_at))[2].stageVisualStatus,'completed')
})

test('an active enrichment retry cannot inherit the earlier request completion',()=>{
  const p=parent();const progress=p.pipelineProgress!
  progress.phase='node_l2_timesfm_enrich';progress.status='running'
  progress.executions!.b=[row('node_l2_timesfm_enrich','blocked'),
    {...row('prepare_prediction_request'),completed_at:'2026-10-16T14:01:00Z'}] as any
  const cards=pipelineStageCards(p,Date.parse(progress.observed_at))
  assert.equal(cards[2].stageVisualStatus,'running')
  assert.equal(cards[3].stageVisualStatus,'not_started')
})
