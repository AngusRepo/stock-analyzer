import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { sealedPremarketDisplay } from './schedulerPipelinePhase'
const base = { businessDate: '2026-10-02', stage: { business_date: '2026-10-02',
  canonical_run_id: 'run-1', status: 'waiting', last_error: 'awaiting_premarket' },
  log: { run_date: '2026-10-02', run_id: 'run-1', status: 'triggered',
    summary: 'awaiting_premarket l3_sealed=true cloud_compute_stopped=true' } }
test('overnight checkpoint separates completed L3 from pending L4 and root', () => {
  for (const jobId of ['pipeline', 'recommendation', 'evening-chain'])
    assert.equal(sealedPremarketDisplay({ ...base, jobId })?.lastStatus, 'waiting')
  assert.equal(sealedPremarketDisplay({ ...base, jobId: 'ml-predict' })?.lastStatus, 'success')
  assert.equal(sealedPremarketDisplay({ ...base, jobId: 'verify-v2' }), null)
  const pending = sealedPremarketDisplay({ ...base, jobId: 'recommendation' })!
  assert.equal(pending.lastRunAt, null); assert.equal(pending.lastDuration, 'N/A')
  assert.equal(pending.nextRun, '等待盤前資訊')
})
test('a summary alone, a stale run or a different business date cannot assert L3 success', () => {
  assert.equal(sealedPremarketDisplay({ ...base, jobId: 'ml-predict', stage: undefined }), null)
  assert.equal(sealedPremarketDisplay({ ...base, jobId: 'ml-predict', log: { ...base.log, run_id: 'old' } }), null)
  assert.equal(sealedPremarketDisplay({ ...base, jobId: 'ml-predict', businessDate: '2026-10-03' }), null)
  assert.equal(sealedPremarketDisplay({ ...base, jobId: 'ml-predict', log: { ...base.log, summary: 'waiting' } }), null)
})
test('actual error and resumed/completed stages retain authority', () => {
  for (const ticketStatus of ['error', 'blocked', 'success', 'skipped'])
    assert.equal(sealedPremarketDisplay({ ...base, jobId: 'evening-chain', ticketStatus }), null)
  for (const status of ['running', 'error', 'success'])
    assert.equal(sealedPremarketDisplay({ ...base, jobId: 'pipeline', stage: { ...base.stage, status } }), null)
})
