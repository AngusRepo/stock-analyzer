import {
  getSchedulerBatch,
  resolveDueSchedulerBatchJobs,
  type SchedulerBatchSourceJob,
} from './schedulerBatchPlan'

const RUNNING_OWNER = 'scheduler_batch_running'
const COMPLETE_OWNER = 'scheduler_batch_complete'
const RUNNING_TTL_MS = 10 * 60 * 1000
const COMPLETE_TTL_MS = 14 * 86400 * 1000

export type SchedulerBatchLeaseState = 'acquired' | 'complete' | 'busy'

export interface SchedulerBatchLeaseStore {
  acquire(sourceJobId: string, scheduledTime: string, now: Date): Promise<SchedulerBatchLeaseState>
  complete(sourceJobId: string, scheduledTime: string, now: Date): Promise<void>
  release(sourceJobId: string, scheduledTime: string): Promise<void>
}

export class D1SchedulerBatchLeaseStore implements SchedulerBatchLeaseStore {
  constructor(private readonly db: D1Database) {}

  private lockKey(sourceJobId: string, scheduledTime: string): string {
    return `scheduler-batch:${sourceJobId}:${scheduledTime}`
  }

  async acquire(sourceJobId: string, scheduledTime: string, now: Date): Promise<SchedulerBatchLeaseState> {
    const lockKey = this.lockKey(sourceJobId, scheduledTime)
    const nowIso = now.toISOString()
    await this.db.prepare(`
      DELETE FROM scheduler_locks
      WHERE owner = ?
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `).bind(COMPLETE_OWNER, nowIso).run()
    const expiresAt = new Date(now.getTime() + RUNNING_TTL_MS).toISOString()
    const result = await this.db.prepare(`
      INSERT INTO scheduler_locks (lock_key, owner, run_date, run_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(lock_key) DO UPDATE SET
        owner=excluded.owner,
        run_date=excluded.run_date,
        run_id=excluded.run_id,
        created_at=excluded.created_at,
        expires_at=excluded.expires_at
      WHERE scheduler_locks.owner != ?
        AND scheduler_locks.expires_at IS NOT NULL
        AND scheduler_locks.expires_at <= excluded.created_at
    `).bind(
      lockKey,
      RUNNING_OWNER,
      scheduledTime.slice(0, 10),
      scheduledTime,
      nowIso,
      expiresAt,
      COMPLETE_OWNER,
    ).run()
    if (Number(result.meta?.changes ?? 0) > 0) return 'acquired'

    const existing = await this.db.prepare(`
      SELECT owner
      FROM scheduler_locks
      WHERE lock_key = ?
      LIMIT 1
    `).bind(lockKey).first<{ owner: string }>()
    return existing?.owner === COMPLETE_OWNER ? 'complete' : 'busy'
  }

  async complete(sourceJobId: string, scheduledTime: string, now: Date): Promise<void> {
    const result = await this.db.prepare(`
      UPDATE scheduler_locks
      SET owner = ?, expires_at = ?
      WHERE lock_key = ?
        AND owner = ?
        AND run_id = ?
    `).bind(
      COMPLETE_OWNER,
      new Date(now.getTime() + COMPLETE_TTL_MS).toISOString(),
      this.lockKey(sourceJobId, scheduledTime),
      RUNNING_OWNER,
      scheduledTime,
    ).run()
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new Error(`Scheduler batch completion lease lost: ${sourceJobId}`)
    }
  }

  async release(sourceJobId: string, scheduledTime: string): Promise<void> {
    await this.db.prepare(`
      DELETE FROM scheduler_locks
      WHERE lock_key = ?
        AND owner = ?
        AND run_id = ?
    `).bind(this.lockKey(sourceJobId, scheduledTime), RUNNING_OWNER, scheduledTime).run()
  }
}

export interface SchedulerBatchDispatchOutcome {
  source_job_id: string
  task: string
  status: 'success' | 'already_complete' | 'busy' | 'error'
  http_status?: number
  detail?: string
}

export interface SchedulerBatchDispatchResult {
  success: boolean
  retryable: boolean
  batch_id: string
  scheduled_time: string
  received_scheduled_time: string
  due_count: number
  outcomes: SchedulerBatchDispatchOutcome[]
}

interface DispatchInput {
  batchId: string
  scheduledAt: Date
  authorization: string
  baseUrl: string
  leaseStore: SchedulerBatchLeaseStore
  fetchImpl: typeof fetch
  now?: Date
}

function buildTaskUrl(baseUrl: string, job: SchedulerBatchSourceJob): string {
  const url = new URL(`/api/admin/trigger/${encodeURIComponent(job.task)}`, baseUrl)
  if (job.query) {
    const params = new URLSearchParams(job.query)
    for (const [name, value] of params) url.searchParams.append(name, value)
  }
  return url.toString()
}

export function normalizeSchedulerBatchSlot(scheduledAt: Date): Date {
  if (Number.isNaN(scheduledAt.getTime())) throw new Error('Invalid scheduler batch scheduled time')
  const slot = new Date(scheduledAt)
  slot.setUTCSeconds(0, 0)
  return slot
}

async function dispatchSourceJob(
  input: DispatchInput,
  job: SchedulerBatchSourceJob,
  scheduledTime: string,
): Promise<SchedulerBatchDispatchOutcome> {
  const lease = await input.leaseStore.acquire(job.id, scheduledTime, input.now ?? new Date())
  if (lease === 'complete') return { source_job_id: job.id, task: job.task, status: 'already_complete' }
  if (lease === 'busy') return { source_job_id: job.id, task: job.task, status: 'busy', detail: 'retry after active lease expires' }

  try {
    const response = await input.fetchImpl(buildTaskUrl(input.baseUrl, job), {
      method: 'POST',
      headers: {
        Authorization: input.authorization,
        ...job.headers,
        'X-CloudScheduler-ScheduleTime': scheduledTime,
        'X-StockVision-Scheduler-Batch': input.batchId,
        'X-StockVision-Scheduler-Source-Job': job.id,
        'X-StockVision-Scheduler-Schedule-Time': scheduledTime,
      },
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`)
    const parsed = body ? JSON.parse(body) as { success?: boolean } : {}
    if (parsed.success === false) throw new Error(`Task returned success=false: ${body.slice(0, 300)}`)
    await input.leaseStore.complete(job.id, scheduledTime, input.now ?? new Date())
    return { source_job_id: job.id, task: job.task, status: 'success', http_status: response.status }
  } catch (error) {
    await input.leaseStore.release(job.id, scheduledTime)
    return {
      source_job_id: job.id,
      task: job.task,
      status: 'error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function dispatchSchedulerBatch(input: DispatchInput): Promise<SchedulerBatchDispatchResult> {
  if (!getSchedulerBatch(input.batchId)) throw new Error(`Unknown scheduler batch: ${input.batchId}`)

  if (!input.authorization) throw new Error('Missing scheduler batch authorization')

  const scheduledSlot = normalizeSchedulerBatchSlot(input.scheduledAt)
  const receivedScheduledTime = input.scheduledAt.toISOString()
  const scheduledTime = scheduledSlot.toISOString()
  const due = resolveDueSchedulerBatchJobs(input.batchId, scheduledSlot)
  const outcomes = await Promise.all(due.map((job) => dispatchSourceJob(input, job, scheduledTime)))
  const retryable = outcomes.some((outcome) => outcome.status === 'busy' || outcome.status === 'error')
  return {
    success: !retryable,
    retryable,
    batch_id: input.batchId,
    scheduled_time: scheduledTime,
    received_scheduled_time: receivedScheduledTime,
    due_count: due.length,
    outcomes,
  }
}
