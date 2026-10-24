import assert from 'node:assert/strict'
import test from 'node:test'
import { isSchedulerRunStatus, classifySchedulerRunSummary, resolveMonotonicSchedulerEntry, type SchedulerRunLogEntry } from './schedulerRunLogger'
import { resolveSchedulerLogStatus } from './schedulerStatus'
import { verifyServingOnlyCallback, runPostcloseResearch } from './postcloseResearch'

test('scheduled postclose work remains waiting, not stale running or successful research',()=>{
  assert.equal(isSchedulerRunStatus('waiting'),true)
  assert.equal(classifySchedulerRunSummary('status=waiting until after market close'),'waiting')
  const entry:SchedulerRunLogEntry={task:'post-pipeline-chain',status:'waiting',summary:'queued_postclose',duration_ms:0,
    timestamp:'2026-10-19T00:00:00Z',run_date:'2026-10-16',run_id:'root'}
  assert.deepEqual(resolveSchedulerLogStatus(entry,{id:'post-pipeline-chain',group:'pipeline_chain'},Date.parse('2026-10-19T05:00:00Z')),
    {status:'waiting',staleRunning:false})
  assert.equal(resolveMonotonicSchedulerEntry({...entry,status:'success'},entry).status,'success')
})

test('serving callback cannot defer validation using an unverified receipt',async()=>{
  const original=globalThis.fetch
  const checksum='a'.repeat(64)
  const env={PAPER_DAILY_PLAN_OWNER:'premarket_once_v1',ML_CONTROLLER_URL:'https://controller.example'} as any
  let actual=checksum;let calls=0
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({publication:{checksum:actual,signal_date:'2026-10-16',run_id:'root'}}),{status:200})}
  try {
    await verifyServingOnlyCallback(env,'2026-10-16','root',checksum)
    actual='b'.repeat(64)
    await assert.rejects(verifyServingOnlyCallback(env,'2026-10-16','root',checksum),/receipt_mismatch/)
    await assert.rejects(verifyServingOnlyCallback(env,'2026-10-16','other-root',actual),/receipt_mismatch/)
    await assert.rejects(verifyServingOnlyCallback(env,'2026-10-16','root','bad'),/callback_invalid/)
    assert.equal(calls,3)
  } finally {globalThis.fetch=original}
})

test('Worker cannot invoke research before the requested trading session closes',async()=>{
  await assert.rejects(runPostcloseResearch({PAPER_DAILY_PLAN_OWNER:'premarket_once_v1'} as any,'2100-01-01'),/before_close/)
})
