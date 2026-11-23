import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SchedulerJob } from './api'
import { pipelineRunSummary, pipelineStageCards } from './pipelineStageCards'
const row=(phase:string,status='completed')=>({phase,status,elapsed_ms:10000,started_at:'2026-10-16T14:00:00Z',completed_at:'2026-10-16T14:00:10Z'})
const parent=()=>({id:'pipeline',runId:'run-a',statusRunDate:'2026-10-16',lastStatus:'waiting',summary:'dependency=input_prep',
  lastRunAt:'2026-10-16T07:02:32Z',lastDuration:'8m55s',
  pipelineProgress:{run_id:'run-a',run_date:'2026-10-16',phase:'input_prep',status:'waiting',started_at:'2026-10-16T14:00:00Z',
    phase_started_at:'2026-10-16T14:05:00Z',observed_at:'2026-10-16T14:05:00Z',execution_id:'b',completed:[],
    executions:{a:[row('node_load_inputs'),row('node_load_market_env')],b:[row('node_build_payloads','waiting')]}},
  pipelineBatches:[{phase:'input_prep',completed:5,total:23}],
} as unknown as SchedulerJob)
test('same-run continuation retains frozen inputs; deferred features never starts L2 or L3 or inherits historic time',()=>{
  const cards=pipelineStageCards(parent(),Date.parse('2026-10-16T14:06:00Z'))
  assert.deepEqual(cards.map(c=>c.stageVisualStatus),['completed','not_started','waiting','waiting','waiting','waiting'])
  assert.equal(cards[0].lastDuration,'0分20秒')
  // No snapshot receipt: the optional sub-job card is empty, not a missing stage.
  assert.equal(cards[1].summary,'本輪無子作業紀錄')
  assert.match(cards[2].summary,/5\/23/)
  assert.equal(cards[5].lastRunAt,null);assert.equal(cards[5].lastDuration,'N/A')
})
test('wrong-run history cannot turn a stage green; stale evidence does not spin',()=>{
  const p=parent();p.pipelineProgress!.run_id='old'
  assert(pipelineStageCards(p).every(c=>c.stageVisualStatus==='not_started'))
  const stale=pipelineStageCards(parent(),Date.parse('2026-10-16T15:00:00Z'))
  assert.equal(stale[2].stageVisualStatus,'stale')
  assert.equal(stale[0].stageVisualStatus,'completed')
})
test('dispatch and completed provider segment are not L3 seal; seal has its own receipt',()=>{
  const p=parent();const progress=p.pipelineProgress!
  progress.phase='dispatch_prediction';progress.status='completed'
  assert.equal(pipelineStageCards(p,Date.parse(progress.observed_at))[5].stageVisualStatus,'waiting')
  progress.executions!.c=[row('seal_l3_results') as any]
  assert.equal(pipelineStageCards(p)[5].stageVisualStatus,'completed')
})
test('missing previous telemetry is unknown, and an explicit blocked input receipt stays red',()=>{
  const p=parent();p.pipelineProgress!.executions!.a=[]
  assert.equal(pipelineStageCards(p,Date.parse('2026-10-16T14:06:00Z'))[0].stageVisualStatus,'stale')
  p.pipelineProgress!.executions!.a=[row('node_load_inputs'),
    {...row('node_load_market_env','blocked'),completed_at:'2026-10-16T14:00:20Z'}] as any
  assert.equal(pipelineStageCards(p,Date.parse('2026-10-16T14:06:00Z'))[0].stageVisualStatus,'blocked')
})

// 2026-10-22: R33 B#0 removed node_capture_atomic_inputs from the graph. Completed
// input receipts must close the first card instead of waiting on a node that never runs.
test('inputs close without an Atomic receipt; a failed payload build only blocks its own card',()=>{
  const p=parent();const progress=p.pipelineProgress!
  progress.phase='node_build_payloads';progress.status='failed';p.lastStatus='failed'
  progress.executions={a:[row('node_load_inputs'),row('node_load_market_env')],b:[row('node_build_payloads','failed')]} as any
  const cards=pipelineStageCards(p,Date.parse(progress.observed_at))
  // The sub-job cards are not downstream of the payload build that would dispatch them.
  assert.deepEqual(cards.map(c=>c.stageVisualStatus),['completed','not_started','not_started','blocked','blocked','blocked'])
  assert.equal(cards[0].name,'輸入凍結')
})

test('L3 request preparation cannot turn blocked TimesFM enrichment green',()=>{
  const p=parent();const progress=p.pipelineProgress!
  progress.phase='modal_inference';progress.status='running'
  progress.executions!.b=[row('node_l2_timesfm_enrich','blocked'),
    {...row('prepare_prediction_request'),completed_at:'2026-10-16T14:01:00Z'}] as any
  const cards=pipelineStageCards(p,Date.parse(progress.observed_at))
  assert.equal(cards[4].stageVisualStatus,'blocked')
  assert.match(cards[4].summary,/TimesFM 條件未滿足/)
  assert.equal(cards[5].stageVisualStatus,'running')
})

test('a newer successful enrichment clears the earlier blocked outcome',()=>{
  const p=parent();const progress=p.pipelineProgress!
  progress.phase='modal_inference';progress.status='running'
  progress.executions!.b=[row('node_l2_timesfm_enrich','blocked')] as any
  progress.executions!.c=[{...row('node_l2_timesfm_enrich'),completed_at:'2026-10-16T14:01:00Z'},
    {...row('prepare_prediction_request'),completed_at:'2026-10-16T14:02:00Z'}] as any
  assert.equal(pipelineStageCards(p,Date.parse(progress.observed_at))[4].stageVisualStatus,'completed')
})

test('an active enrichment retry cannot inherit the earlier request completion',()=>{
  const p=parent();const progress=p.pipelineProgress!
  progress.phase='node_l2_timesfm_enrich';progress.status='running'
  progress.executions!.b=[row('node_l2_timesfm_enrich','blocked'),
    {...row('prepare_prediction_request'),completed_at:'2026-10-16T14:01:00Z'}] as any
  const cards=pipelineStageCards(p,Date.parse(progress.observed_at))
  assert.equal(cards[4].stageVisualStatus,'running')
  assert.equal(cards[5].stageVisualStatus,'waiting')
})

const at=Date.parse('2026-10-16T14:06:00Z')
const work=(p:SchedulerJob, status:'running'|'waiting'|'failed'|'unknown'='running')=>({
  run_id:p.runId!,run_date:p.statusRunDate!,phase:p.pipelineProgress!.phase,stage_id:'a'.repeat(64),
  status,active:status==='running'?2:0,completed:5,total:23,observed_at:new Date(at).toISOString(),
})

test('verified snapshot child runs while the parent yields; future L2/L3 wait without invented starts',()=>{
  const p=parent();p.pipelineProgress!.phase='input_snapshot'
  p.pipelineWork={...work(p),active:1,completed:0,total:1}
  const cards=pipelineStageCards(p,at)
  assert.deepEqual(cards.map(c=>c.stageVisualStatus),['completed','running','waiting','waiting','waiting','waiting'])
  assert.match(cards[1].summary,/快照匯出中/)
  assert.match(cards[2].summary,/等待輸入快照匯出完成/)
  assert.match(cards[4].summary,/等待特徵與推論輸入組裝完成/)
  assert.match(cards[5].summary,/等待L2 特徵增強完成/)
  assert.equal(cards[4].lastRunAt,null);assert.equal(cards[4].lastDuration,'N/A')
})

test('unclaimed dispatch and completed export awaiting callback stay yellow, never green',()=>{
  const p=parent();p.pipelineProgress!.phase='input_snapshot'
  p.pipelineWork={...work(p,'waiting'),active:0,completed:1,total:1}
  assert.equal(pipelineStageCards(p,at)[1].stageVisualStatus,'waiting')
  delete p.pipelineWork
  assert.equal(pipelineStageCards(p,at)[1].stageVisualStatus,'waiting')
})

test('claimed feature batches run; preparation after L2 belongs to the L2 card',()=>{
  const p=parent();p.pipelineWork=work(p)
  let cards=pipelineStageCards(p,at)
  assert.equal(cards[2].stageVisualStatus,'running')
  assert.match(cards[2].summary,/已完成 5\/23 · 執行中 2/)
  p.pipelineProgress!.phase='prepare_prediction_request'
  p.pipelineProgress!.executions!.b=[row('node_build_payloads')] as any
  p.pipelineWork=work(p)
  cards=pipelineStageCards(p,at)
  assert.equal(cards[3].stageVisualStatus,'completed')
  assert.equal(cards[4].stageVisualStatus,'running')
  assert.equal(cards[5].stageVisualStatus,'waiting')
})

test('wrong run/date/phase and expired child observations cannot manufacture running',()=>{
  for(const override of [{run_id:'old'},{run_date:'2026-10-15'},{phase:'prepare_prediction_request'},
    {observed_at:'2026-10-16T14:04:00Z'},{observed_at:'2026-10-16T14:08:00Z'},{observed_at:'bad'}]) {
    const p=parent();p.pipelineWork={...work(p),...override}
    assert.equal(pipelineStageCards(p,at)[2].stageVisualStatus,'waiting')
  }
})

test('a running child stays blue across one poll and modest browser clock skew',()=>{
  for(const skew of [-45_000,75_000]) {
    const p=parent();p.pipelineWork=work(p)
    assert.equal(pipelineStageCards(p,at+skew)[2].stageVisualStatus,'running')
  }
})

test('a failed child blocks its card and downstream; stale evidence still needs confirmation',()=>{
  const p=parent();p.pipelineWork=work(p,'failed')
  assert.deepEqual(pipelineStageCards(p,at).map(c=>c.stageVisualStatus),['completed','not_started','blocked','blocked','blocked','blocked'])
  assert.equal(pipelineStageCards(p,at)[3].lastStatus,'blocked')
  p.pipelineWork={...work(p,'unknown'),observed_at:new Date(at+60*60_000).toISOString()}
  assert.equal(pipelineStageCards(p,at+60*60_000)[2].stageVisualStatus,'stale')
})

test('pre-L2 preparation belongs to input freezing and is its end once the controller records it',()=>{
  const p=parent(),progress=p.pipelineProgress!
  const at=Date.parse(progress.observed_at)
  progress.phase='node_prepare_l2_inputs';progress.status='running';progress.phase_started_at='2026-10-16T14:00:30Z'
  progress.executions={a:[row('node_load_inputs'),row('node_load_market_env'),row('node_attach_serving_context')]} as any
  let cards=pipelineStageCards(p,at)
  assert.equal(cards[0].stageVisualStatus,'running','attach done but prep running: inputs are not frozen yet')
  assert.equal(cards[1].stageVisualStatus,'waiting')
  // 2026-10-22: roster mismatch raised inside the prep phase.
  progress.status='failed'
  progress.executions={a:[row('node_load_inputs'),row('node_load_market_env'),row('node_attach_serving_context'),
    {...row('node_prepare_l2_inputs','failed'),completed_at:'2026-10-16T14:00:40Z'}]} as any
  cards=pipelineStageCards(p,at)
  assert.equal(cards[0].stageVisualStatus,'blocked')
  assert.deepEqual(cards.slice(1).map(c=>c.lastStatus),['blocked','blocked','blocked','blocked','blocked'])
  progress.phase='node_build_payloads';progress.status='running'
  progress.executions={a:[row('node_load_inputs'),row('node_load_market_env'),row('node_attach_serving_context'),row('node_prepare_l2_inputs')]} as any
  assert.equal(pipelineStageCards(p,at)[0].stageVisualStatus,'completed')
})

test('a run inside serving-context attach is not closed by the legacy market-env end',()=>{
  const p=parent(),progress=p.pipelineProgress!
  progress.phase='node_attach_serving_context';progress.status='running';progress.phase_started_at='2026-10-16T14:00:20Z'
  progress.executions={a:[row('node_load_inputs'),row('node_load_market_env')]} as any
  const at=Date.parse(progress.observed_at)
  assert.deepEqual(pipelineStageCards(p,at).map(c=>c.stageVisualStatus),['running','waiting','waiting','waiting','waiting','waiting'])
  progress.status='failed';p.lastStatus='failed'
  progress.executions={a:[row('node_load_inputs'),row('node_load_market_env'),
    {...row('node_attach_serving_context','failed'),completed_at:'2026-10-16T14:00:30Z'}]} as any
  const cards=pipelineStageCards(p,at)
  assert.equal(cards[0].stageVisualStatus,'blocked')
  assert.deepEqual(cards.slice(1).map(c=>c.lastStatus),['blocked','blocked','blocked','blocked','blocked'])
})

test('resuming after the feature wait runs in the feature card and leaves input freezing time alone',()=>{
  const p=parent(),progress=p.pipelineProgress!
  progress.executions={a:[row('node_load_inputs'),row('node_load_market_env'),row('node_attach_serving_context'),
    row('node_prepare_l2_inputs'),row('node_build_payloads','waiting')]} as any
  const frozen=pipelineStageCards(p,Date.parse(progress.observed_at))[0]
  progress.phase='node_resume_l2_inputs';progress.status='running'
  progress.phase_started_at='2026-10-16T15:30:00Z';progress.observed_at='2026-10-16T15:30:05Z'
  const cards=pipelineStageCards(p,Date.parse('2026-10-16T15:31:00Z'))
  assert.equal(cards[0].stageVisualStatus,'completed')
  assert.equal(cards[0].stageElapsed,frozen.stageElapsed)
  assert.equal(cards[0].lastDuration,frozen.lastDuration)
  assert.equal(cards[3].stageVisualStatus,'running')
  assert.match(cards[3].summary,/L2 前輸入重新驗證/)
})

test('sequence input preparation runs in the L2 card instead of leaving it unstarted',()=>{
  const p=parent(),progress=p.pipelineProgress!
  progress.executions={a:[row('node_load_inputs'),row('node_load_market_env'),row('node_attach_serving_context'),
    row('node_prepare_l2_inputs'),row('node_build_payloads')]} as any
  progress.phase='node_prepare_sequence_inputs';progress.status='running'
  progress.phase_started_at='2026-10-16T15:30:00Z';progress.observed_at='2026-10-16T15:30:05Z'
  const cards=pipelineStageCards(p,Date.parse('2026-10-16T15:31:00Z'))
  assert.equal(cards[4].stageVisualStatus,'running')
  assert.match(cards[4].summary,/序列與 L2 輸入準備/)
  assert.doesNotMatch(cards[4].summary,/本輪尚未開始/)
})

test('a finished run stops every clock at its last evidence',()=>{
  const p=parent(),progress=p.pipelineProgress!
  p.lastStatus='success'
  progress.phase='modal_inference';progress.status='running'
  progress.phase_started_at='2026-10-16T14:05:00Z';progress.observed_at='2026-10-16T14:07:00Z'
  const early=pipelineStageCards(p,Date.parse('2026-10-16T14:10:00Z'))
  const late=pipelineStageCards(p,Date.parse('2026-10-16T22:00:00Z'))
  assert.deepEqual(late.map(c=>c.stageElapsed),early.map(c=>c.stageElapsed))
  assert.deepEqual(late.map(c=>c.lastDuration),early.map(c=>c.lastDuration))
  assert.equal(late[5].stageElapsed,'2分0秒')
  assert.notEqual(late[5].stageVisualStatus,'running')
  assert.equal(pipelineRunSummary(p,Date.parse('2026-10-16T22:00:00Z')),pipelineRunSummary(p,Date.parse('2026-10-16T14:10:00Z')))
  assert.match(pipelineRunSummary(p,Date.parse('2026-10-16T22:00:00Z')),/經過 7分0秒/)
})

test('a failed parent stops the current card even if its last receipt says running',()=>{
  const p=parent(),progress=p.pipelineProgress!
  p.lastStatus='failed';progress.status='running'
  for (const at of [Date.parse('2026-10-16T14:06:00Z'),Date.parse('2026-10-16T18:00:00Z')]) {
    const cards=pipelineStageCards(p,at)
    assert.deepEqual(cards.map(c=>c.stageVisualStatus),['completed','not_started','blocked','blocked','blocked','blocked'])
    assert.doesNotMatch(cards[2].lastDuration,/進行中/)
  }
})
test('FU8-A: a ticket runId that differs from the canonical run still shows the canonical progress',()=>{
  const now=Date.parse('2026-10-16T14:06:00Z')
  const ticket={...parent(),runId:'ticket-1',canonicalRunId:'run-a'} as SchedulerJob
  assert.deepEqual(pipelineStageCards(ticket,now).map(c=>c.stageVisualStatus),['completed','not_started','waiting','waiting','waiting','waiting'])
  assert.match(pipelineRunSummary(ticket,now),/^Pipeline · /)
  // Without the canonical id the ticket id alone cannot claim the progress.
  const legacy={...parent(),runId:'ticket-1'} as SchedulerJob
  assert(pipelineStageCards(legacy,now).every(c=>c.stageVisualStatus==='not_started'))
  // A stale canonical id is still rejected, and the run date check stays.
  const stale={...parent(),runId:'run-a',canonicalRunId:'run-old'} as SchedulerJob
  assert(pipelineStageCards(stale,now).every(c=>c.stageVisualStatus==='not_started'))
  assert.equal(pipelineRunSummary(stale,now),'本輪階段紀錄尚未取得')
  const otherDay={...parent(),runId:'ticket-1',canonicalRunId:'run-a',statusRunDate:'2026-10-15'} as SchedulerJob
  assert(pipelineStageCards(otherDay,now).every(c=>c.stageVisualStatus==='not_started'))
  // A null canonical id falls back to the ticket runId.
  const fallback={...parent(),canonicalRunId:null} as SchedulerJob
  assert.equal(pipelineStageCards(fallback,now)[0].stageVisualStatus,'completed')
})

// Wei 11/18: snapshot export / feature batches / assembly are three cards; the controller execution
// that consumes a detached sub-job records it as a receipt (registration -> consumption).
const t0=Date.parse('2026-11-17T09:00:00Z')
const rec=(phase:string,startMin:number,minutes:number,status='completed')=>({phase,status,elapsed_ms:Math.round(minutes*60_000),
  started_at:new Date(t0+startMin*60_000).toISOString(),completed_at:new Date(t0+(startMin+minutes)*60_000).toISOString()})
const deferredRun=()=>{
  const p=parent(),progress=p.pipelineProgress!
  p.runId='run-1117';p.statusRunDate='2026-11-17';p.lastStatus='running'
  Object.assign(progress,{run_id:'run-1117',run_date:'2026-11-17',phase:'node_l3_formal_predict',status:'running',
    started_at:new Date(t0-60_000).toISOString(),phase_started_at:new Date(t0+40*60_000).toISOString(),observed_at:new Date(t0+41*60_000).toISOString()})
  progress.executions={
    a:[rec('node_load_inputs',-1,0.5),rec('node_load_market_env',-0.5,0.2),rec('node_attach_serving_context',-0.3,0.1),
      rec('node_prepare_l2_inputs',-0.2,0.2),rec('node_build_payloads',0,3,'waiting')],
    b:[rec('input_snapshot',3,6),rec('node_resume_l2_inputs',9,0.6),rec('node_build_payloads',9.6,4,'waiting')],
    c:[rec('input_prep',13.6,5.8),rec('node_resume_l2_inputs',19.4,0.5),rec('node_build_payloads',19.9,3.5),
      rec('node_prepare_sequence_inputs',23.4,1),rec('prepare_prediction_request',24.4,0.6,'waiting')],
    d:[rec('node_l2_timesfm_enrich',40,0.5)],
  } as any
  return p
}

test('11/17-shaped deferred run: snapshot, feature batches and assembly each carry their own time',()=>{
  const cards=pipelineStageCards(deferredRun(),t0+41*60_000)
  assert.deepEqual(cards.slice(1,4).map(c=>[c.name,c.stageVisualStatus,c.lastDuration]),[
    ['輸入快照匯出','completed','6分0秒'],['特徵批次','completed','5分48秒'],['特徵與推論輸入組裝','completed','11分36秒']])
  // The three cards add up to the 23.4 min the assembly card spans on the wall clock.
  assert.equal(cards[3].stageElapsed,'23分24秒')
  assert.equal(cards[1].stageElapsed,'6分0秒')
  assert.equal(cards[0].lastDuration,'1分0秒')
  // The 15.4 min wait for the L2 request is not a sub-job receipt: L2 keeps its own receipts only.
  assert.equal(cards[4].lastDuration,'2分6秒（已記錄）')
})

test('a run that dispatches no sub-job leaves those cards empty, never missing',()=>{
  const p=deferredRun(),progress=p.pipelineProgress!
  delete p.pipelineBatches
  progress.executions={a:[rec('node_load_inputs',-1,0.5),rec('node_prepare_l2_inputs',-0.5,0.5),
    rec('node_build_payloads',0,3),rec('node_prepare_sequence_inputs',3,1)]} as any
  const cards=pipelineStageCards(p,t0+41*60_000)
  assert.deepEqual(cards.slice(1,3).map(c=>[c.stageVisualStatus,c.summary,c.lastDuration]),
    [['noop','本輪無子作業紀錄','N/A'],['noop','本輪無子作業紀錄','N/A']])
  // Checked, nothing dispatched: counts toward daily readiness like any other no-action stage.
  assert.deepEqual(cards.slice(1,3).map(c=>c.lastStatus),['skip','skip'])
  assert.equal(cards[3].lastDuration,'3分0秒')
})

test('a sealed or post-L3 run with no sub-job receipt counts both sub-job cards as checked',()=>{
  // Sealed runs report awaiting_premarket and premarket L4 phases sit outside every card (currentIndex -1).
  for (const [phase,summary] of [['awaiting_premarket','awaiting_premarket l3_sealed=true'],['node_write_d1','running']]) {
    const p=deferredRun(),progress=p.pipelineProgress!
    delete p.pipelineBatches;p.summary=summary;p.lastStatus=phase==='awaiting_premarket'?'waiting':'running'
    Object.assign(progress,{phase,status:phase==='awaiting_premarket'?'waiting':'running'})
    progress.executions={a:[rec('node_load_inputs',-1,0.5),rec('node_prepare_l2_inputs',-0.5,0.5),
      rec('node_build_payloads',0,3),rec('node_prepare_sequence_inputs',3,1)]} as any
    const cards=pipelineStageCards(p,t0+41*60_000)
    assert.deepEqual(cards.slice(1,3).map(c=>[c.stageVisualStatus,c.lastStatus,c.summary]),
      [['noop','skip','本輪無子作業紀錄'],['noop','skip','本輪無子作業紀錄']],phase)
  }
  // Assembly still waiting on a deferral: the sub-job may yet run, so it is not checked.
  const p=deferredRun(),progress=p.pipelineProgress!
  delete p.pipelineBatches;Object.assign(progress,{phase:'node_write_d1',status:'running'})
  progress.executions={a:[rec('node_load_inputs',-1,0.5),rec('node_build_payloads',0,3,'waiting')]} as any
  assert.deepEqual(pipelineStageCards(p,t0+41*60_000).slice(1,3).map(c=>c.stageVisualStatus),['not_started','not_started'])
})

test('the seal alone checks sub-job cards, only for this run; a sub-job dispatched after assembly is not checked',()=>{
  const sealedRun=()=>{
    const p=deferredRun(),progress=p.pipelineProgress!
    delete p.pipelineBatches;p.summary='awaiting_premarket l3_sealed=true';p.lastStatus='waiting'
    Object.assign(progress,{phase:'awaiting_premarket',status:'waiting'})
    // An older controller or a truncated history: no assembly receipt survives, the seal still proves the run passed it.
    progress.executions={a:[rec('node_load_inputs',-1,0.5),rec('seal_l3_results',20,1)]} as any
    return p
  }
  assert.deepEqual(pipelineStageCards(sealedRun(),t0+41*60_000).slice(1,3).map(c=>c.stageVisualStatus),['noop','noop'])
  const other=sealedRun();other.pipelineProgress!.run_id='another-run'
  assert.deepEqual(pipelineStageCards(other,t0+41*60_000).slice(1,3).map(c=>c.stageVisualStatus),['not_started','not_started'])
  // Assembly is done but an L2-time snapshot is now waiting: its own card waits, the batch card is checked.
  const p=deferredRun(),progress=p.pipelineProgress!
  delete p.pipelineBatches;p.lastStatus='running'
  Object.assign(progress,{phase:'input_snapshot',status:'waiting'})
  progress.executions={a:[rec('node_load_inputs',-1,0.5),rec('node_build_payloads',0,3),rec('node_prepare_sequence_inputs',3,1)]} as any
  const cards=pipelineStageCards(p,t0+41*60_000)
  assert.equal(cards[1].stageVisualStatus,'waiting')
  assert.deepEqual([cards[2].stageVisualStatus,cards[2].summary],['noop','本輪無子作業紀錄'])
})

test('time between controller executions is never inferred as a sub-job without its receipt',()=>{
  const p=deferredRun(),progress=p.pipelineProgress!
  progress.executions={a:[rec('node_build_payloads',0,3,'waiting')],b:[rec('node_resume_l2_inputs',9,0.5),rec('node_build_payloads',9.5,1)]} as any
  const cards=pipelineStageCards(p,t0+41*60_000)
  assert.equal(cards[1].lastDuration,'N/A')
  assert.equal(cards[3].lastDuration,'4分30秒')
})
