import assert from 'node:assert/strict'
import {
  dispatchSchedulerBatch,
  type SchedulerBatchLeaseState,
  type SchedulerBatchLeaseStore,
} from './schedulerBatchDispatcher'

class MemoryLeaseStore implements SchedulerBatchLeaseStore {
  readonly states = new Map<string, SchedulerBatchLeaseState>()
  readonly released: string[] = []

  private key(sourceJobId: string, scheduledTime: string): string {
    return `${sourceJobId}:${scheduledTime}`
  }

  async acquire(sourceJobId: string, scheduledTime: string): Promise<SchedulerBatchLeaseState> {
    const key = this.key(sourceJobId, scheduledTime)
    const state = this.states.get(key)
    if (state === 'complete') return 'complete'
    if (state === 'busy') return 'busy'
    this.states.set(key, 'busy')
    return 'acquired'
  }

  async complete(sourceJobId: string, scheduledTime: string): Promise<void> {
    this.states.set(this.key(sourceJobId, scheduledTime), 'complete')
  }

  async release(sourceJobId: string, scheduledTime: string): Promise<void> {
    const key = this.key(sourceJobId, scheduledTime)
    this.states.delete(key)
    this.released.push(key)
  }
}

const authorization = 'Bearer scheduler-secret'
const baseUrl = 'https://worker.stockvision.invalid'

async function main(): Promise<void> {
{
  const leaseStore = new MemoryLeaseStore()
  const calls: Array<{ url: string; headers: Headers }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) })
    return Response.json({ success: true })
  }
  const input = {
    batchId: 'daily-1900-maintenance',
    scheduledAt: new Date('2026-07-19T19:00:00Z'),
    authorization,
    baseUrl,
    leaseStore,
    fetchImpl,
    now: new Date('2026-07-19T19:00:03Z'),
  }
  const first = await dispatchSchedulerBatch(input)
  assert.equal(first.success, true)
  assert.equal(first.due_count, 2)
  assert.deepEqual(first.outcomes.map((outcome) => outcome.source_job_id), ['debate-memory-retention', 'orphan-reachability-gc'])
  assert.equal(calls.length, 2)
  assert(calls.some((call) => call.url === `${baseUrl}/api/admin/trigger/debate-memory-retention`))
  assert(calls.every((call) => call.headers.get('Authorization') === authorization))
  assert(calls.every((call) => call.headers.get('X-CloudScheduler-ScheduleTime') === input.scheduledAt.toISOString()))

  const duplicate = await dispatchSchedulerBatch(input)
  assert.equal(duplicate.success, true)
  assert(duplicate.outcomes.every((outcome) => outcome.status === 'already_complete'))
  assert.equal(calls.length, 2, 'completed scheduled slot must never execute twice')
}

{
  const leaseStore = new MemoryLeaseStore()
  let attempts = 0
  const fetchImpl: typeof fetch = async () => {
    attempts += 1
    return attempts === 1
      ? Response.json({ success: false, error: 'forced' }, { status: 500 })
      : Response.json({ success: true })
  }
  const input = {
    batchId: 'daily-1900-maintenance',
    scheduledAt: new Date('2026-07-19T19:00:00Z'),
    authorization,
    baseUrl,
    leaseStore,
    fetchImpl,
  }
  const failed = await dispatchSchedulerBatch(input)
  assert.equal(failed.success, false)
  assert.equal(failed.retryable, true)
  assert(failed.outcomes.some((outcome) => outcome.status === 'error'))
  assert.equal(leaseStore.released.length, 1, 'failed task must release its lease for Cloud Scheduler retry')

  const retried = await dispatchSchedulerBatch(input)
  assert.equal(retried.success, true)
  assert(retried.outcomes.some((outcome) => outcome.status === 'success'))
  assert(retried.outcomes.some((outcome) => outcome.status === 'already_complete'))
  assert.equal(attempts, 3)
}

{
  const leaseStore = new MemoryLeaseStore()
  const calls: Array<{ url: string; headers: Headers }> = []
  const result = await dispatchSchedulerBatch({
    batchId: 'weekly-2230-research',
    scheduledAt: new Date('2026-07-18T22:30:00Z'),
    authorization,
    baseUrl,
    leaseStore,
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) })
      return Response.json({ success: true })
    },
  })
  assert.equal(result.success, true)
  assert.equal(result.due_count, 2)
  assert(calls.some((call) => /weekly-optuna\?sync=1$/.test(call.url)))
  assert(calls.some((call) => /sector-leaders\?sync=1$/.test(call.url)))
}

{
  const leaseStore = new MemoryLeaseStore()
  const scheduledAt = new Date('2026-07-18T22:30:00Z')
  const scheduledTime = scheduledAt.toISOString()
  leaseStore.states.set(`weekly-optuna:${scheduledTime}`, 'busy')
  const result = await dispatchSchedulerBatch({
    batchId: 'weekly-2230-research',
    scheduledAt,
    authorization,
    baseUrl,
    leaseStore,
    fetchImpl: async () => Response.json({ success: true }),
  })
  assert.equal(result.due_count, 2)
  assert.equal(result.success, false)
  assert.equal(result.retryable, true)
  assert(result.outcomes.some((outcome) => outcome.source_job_id === 'weekly-optuna' && outcome.status === 'busy'))
  assert(result.outcomes.some((outcome) => outcome.source_job_id === 'sector-leaders' && outcome.status === 'success'))
}

{
  let called = false
  const result = await dispatchSchedulerBatch({
    batchId: 'daily-1900-maintenance',
    scheduledAt: new Date('2026-07-19T19:05:00Z'),
    authorization,
    baseUrl,
    leaseStore: new MemoryLeaseStore(),
    fetchImpl: async () => {
      called = true
      return Response.json({ success: true })
    },
  })
  assert.equal(result.due_count, 0)
  assert.equal(result.success, true)
  assert.equal(called, false)
}

await assert.rejects(
  dispatchSchedulerBatch({
    batchId: 'daily-1900-maintenance',
    scheduledAt: new Date('2026-07-19T19:00:00Z'),
    authorization: '',
    baseUrl,
    leaseStore: new MemoryLeaseStore(),
    fetchImpl: async () => Response.json({ success: true }),
  }),
  /Missing scheduler batch authorization/,
)

console.log('schedulerBatchDispatcher: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
