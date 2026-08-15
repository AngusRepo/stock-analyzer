import assert from 'node:assert/strict'
import test from 'node:test'

import { logChainedTask } from './postMarketChain'
import { startPipelineStageLeaseHeartbeat } from './pipelineStageLease'

test('lost lease after a blocked task prevents observability and the next task', async () => {
  let active = true
  let releaseTask!: () => void
  let startedTask!: () => void
  const taskStarted = new Promise<void>((resolve) => { startedTask = resolve })
  const taskBlocked = new Promise<void>((resolve) => { releaseTask = resolve })
  let kvWrites = 0
  let nextTaskRuns = 0
  const env = {
    KV: {
      async put() { kvWrites += 1 },
      async delete() { kvWrites += 1 },
      async get() { return null },
    },
  } as any
  const firstTask = logChainedTask(env, {
    runDate: '2026-08-14',
    upstreamRunId: 'run-A',
    stageLeaseOwner: 'owner-A',
    assertStageLease: async () => {
      if (!active) throw new Error('pipeline_stage_lease_lost:run-A')
    },
  }, 'blocked-task', async () => {
    startedTask()
    await taskBlocked
    return 'success'
  })
  await taskStarted
  active = false
  releaseTask()
  await assert.rejects(firstTask, /pipeline_stage_lease_lost/)
  if (active) nextTaskRuns += 1
  assert.equal(nextTaskRuns, 0)
  assert.equal(kvWrites, 0)
})

test('pipeline heartbeat latches lease loss and every later boundary fails closed', async () => {
  let live = true
  const heartbeat = startPipelineStageLeaseHeartbeat({} as D1Database, {
    businessDate: '2026-08-14',
    stage: 'post_pipeline_chain',
    canonicalRunId: 'run-A',
    leaseOwner: 'owner-A',
  }, {
    heartbeat: async () => live,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
  })
  await heartbeat.assertActive('initial')
  live = false
  await assert.rejects(heartbeat.assertActive('after-takeover'), /pipeline_stage_lease_lost/)
  assert.ok(heartbeat.leaseError())
  await assert.rejects(heartbeat.assertActive('later-boundary'), /pipeline_stage_lease_lost/)
  await heartbeat.stop()
})
