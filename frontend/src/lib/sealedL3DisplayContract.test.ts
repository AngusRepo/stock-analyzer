import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { buildAttemptAwareJobMap } from '../components/observability/executionChainAttemptState'
import type { SchedulerJob } from './api'
const { sealedPremarketDisplay } = createRequire(import.meta.url)('../../../worker/src/lib/schedulerPipelinePhase') as typeof import('../../../worker/src/lib/schedulerPipelinePhase')
const base = { businessDate: '2026-10-02', stage: { business_date: '2026-10-02',
  canonical_run_id: 'run-1', status: 'waiting', last_error: 'awaiting_premarket' },
  log: { run_date: '2026-10-02', run_id: 'run-1', status: 'triggered',
    summary: 'awaiting_premarket l3_sealed=true cloud_compute_stopped=true' } }
test('sealed L3 API projection retains identity through the OBS replay projection', () => {
  const projection = sealedPremarketDisplay({ ...base, jobId: 'ml-predict' })!
  const l3 = { id: 'ml-predict', statusRunDate: base.businessDate,
    ...projection } as SchedulerJob
  const l4 = { id: 'pipeline', lastStatus: 'running', pipelinePhase: 'premarket_l4',
    runId: base.stage.canonical_run_id, statusRunDate: base.businessDate } as SchedulerJob
  const scope = { columns: [['pipeline'], ['ml-predict']] }
  const before = buildAttemptAwareJobMap(new Map([['pipeline', l4],
    ['ml-predict', { ...l3, runId: null }]]), scope, () => null)
  assert.equal(before.get('ml-predict')?.lastStatus, 'waiting')
  assert.equal(l3.runId, base.stage.canonical_run_id)
  const after = buildAttemptAwareJobMap(new Map([['pipeline', l4], ['ml-predict', l3]]), scope, () => null)
  assert.equal(after.get('pipeline')?.lastStatus, 'running')
  assert.equal(after.get('ml-predict')?.lastStatus, 'success')
  for (const stale of [{ ...l3, runId: 'old-run' }, { ...l3, statusRunDate: '2026-10-01' }]) {
    const result = buildAttemptAwareJobMap(new Map([['pipeline', l4], ['ml-predict', stale]]), scope, () => null)
    assert.equal(result.get('ml-predict')?.lastStatus, 'waiting')
  }
})
