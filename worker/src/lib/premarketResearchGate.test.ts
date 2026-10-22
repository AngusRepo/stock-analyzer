import assert from 'node:assert/strict'
import test from 'node:test'
import { withPaperExecutionScope } from './paperExecutionScope'
import { postPipelineResearchAllowed } from './premarketResearchGate'
import { queuePostPipelineStage } from './pipelineStageLease'

test('research queue cannot use watchdog recovery to bypass publication and session close', async () => {
  const env = { PAPER_DAILY_PLAN_OWNER: 'premarket_once_v1', ML_CONTROLLER_URL: 'https://controller.example',
    DB: {prepare: () => {throw new Error('unexpected mutation')}},
    UPDATE_QUEUE: {send: () => {throw new Error('unexpected dispatch')}} } as any
  const publication = {signal_date: '2026-10-16', run_id: 'root', trade_date: '2026-10-19', checksum: 'a'.repeat(64)}
  let value: typeof publication | null = publication
  let httpStatus = 200
  const at = async (time: string, operation: () => Promise<unknown>) => withPaperExecutionScope({
    environment: env, accountId: 1, nowMs: Date.parse(time), databases: {},
    fetchFrozen: async () => new Response(JSON.stringify({publication: value}), {status: httpStatus}),
  }, operation)
  assert.equal((await at('2026-10-19T13:29:59+08:00', () => postPipelineResearchAllowed(env, '2026-10-16', 'root'))).result, false)
  assert.deepEqual((await at('2026-10-19T08:00:00+08:00', () => queuePostPipelineStage(env, {
    businessDate: '2026-10-16', runId: 'root', resumeWaiting: true,
  }))).result, {queued: false, canonicalRunId: 'root', status: 'waiting'})
  assert.equal((await at('2026-10-19T13:30:00+08:00', () => postPipelineResearchAllowed(env, '2026-10-16', 'root'))).result, true)
  value = null
  assert.equal((await at('2026-10-19T14:20:00+08:00', () => postPipelineResearchAllowed(env, '2026-10-16', 'root'))).result, false)
  value = {...publication, run_id: 'other'}
  await assert.rejects(at('2026-10-19T14:20:00+08:00', () => postPipelineResearchAllowed(env, '2026-10-16', 'root')), /identity_invalid/)
  httpStatus = 503
  await assert.rejects(at('2026-10-19T14:20:00+08:00', () => postPipelineResearchAllowed(env, '2026-10-16', 'root')))
  assert.equal(await postPipelineResearchAllowed({}, '2026-10-16', 'legacy'), true)
})
