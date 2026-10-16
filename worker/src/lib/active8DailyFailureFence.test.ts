import assert from 'node:assert/strict'
import test from 'node:test'
import { assertActive8DailyFailureFenceOpen, active8DailyFailureFenceKey } from './active8DailyFailureFence'
import { runActive8OofLifecycle } from './controllerResearchWorkflows'

const day = '2026-10-14'
const fence = { schema_version: 'active8-daily-failure-fence-v1', business_date: day,
  status: 'blocked', reason: 'verified_cloud_run_terminal_failure',
  evidence_sha256: 'a'.repeat(64), failed_executions: ['active8-oof-materialize-h2hlp'] }

test('only the exact failed date is fenced; newer daily work remains available', async () => {
  const kv = { get: async (key: string) => key === active8DailyFailureFenceKey(day) ? fence : null } as any
  await assert.rejects(assertActive8DailyFailureFenceOpen(kv, day), /verified_cloud_run_failure_requires_repair/)
  await assertActive8DailyFailureFenceOpen(kv, '2026-10-15')
})

test('malformed fence fails visibly instead of reopening expensive work', async () => {
  for (const change of [{ business_date: '2026-10-15' }, { evidence_sha256: '' },
    { failed_executions: [] }, { failed_executions: ['pipeline-v2-foreign'] }, { status: 'success' }]) {
    await assert.rejects(assertActive8DailyFailureFenceOpen({ get: async () => ({ ...fence, ...change }) } as any, day), /failure_fence_invalid/)
  }
})

test('a fenced physical delivery or delayed continuation never reaches Controller', async () => {
  const previous = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('unexpected external dispatch') }
  try {
    for (const options of [{}, { continuationAttempt: 12, schedulerTicketId: 'another-ticket', schedulerRunId: 'another-run' }]) {
      await assert.rejects(runActive8OofLifecycle({ ML_CONTROLLER_URL: 'https://controller.invalid',
        KV: { get: async (key: string) => key === active8DailyFailureFenceKey(day) ? fence : null } } as any,
        day, 'daily', options), /active8_daily_blocked:verified_cloud_run_failure_requires_repair/)
    }
    assert.equal(calls, 0)
  } finally { globalThis.fetch = previous }
})
