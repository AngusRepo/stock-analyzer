import type { Bindings, UpdateQueueMsg } from '../types'
import { twToday } from './dateUtils'
import { logSchedulerResult, type SchedulerRunLogEntry } from './schedulerRunLogger'

export const INDICATOR_QUEUE_SHARD_COUNT = 4
export const INDICATOR_QUEUE_MAX_DELIVERY_ATTEMPTS = 9
export const INDICATOR_QUEUE_STALE_MS = 8 * 60_000
export const INDICATOR_QUEUE_MAX_RECOVERIES = 6

const INDICATOR_QUEUE_STATE_TTL_SECONDS = 7 * 86400
const INDICATOR_QUEUE_WATCHDOG_LEASE_SECONDS = 7 * 60

function runPrefix(triggerTime: string, runId: string): string {
  return `cron:indicator-queue:${triggerTime}:${runId}`
}

function boundedShardCount(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 32) return INDICATOR_QUEUE_SHARD_COUNT
  return parsed
}

function schedulerRunId(entry: SchedulerRunLogEntry): string | null {
  const direct = String(entry.run_id ?? '').trim()
  if (direct) return direct
  const matched = String(entry.summary ?? '').match(/(?:^|;\s*)run_id=([^;\s]+)/)
  return matched?.[1] ?? null
}

function schedulerShardCount(entry: SchedulerRunLogEntry): number {
  const matched = String(entry.summary ?? '').match(/(?:^|;\s*)shards=(\d+)/)
  return boundedShardCount(matched?.[1])
}

export function indicatorQueueRetryDelaySeconds(attempts: number, shardIndex = 0): number {
  const safeAttempts = Math.max(1, Math.min(10, Math.floor(Number(attempts) || 1)))
  const exponential = Math.min(300, 15 * (2 ** (safeAttempts - 1)))
  return Math.min(600, exponential + Math.max(0, Math.floor(shardIndex)) * 7)
}

export async function recordIndicatorQueueMessageFailure(
  env: Bindings,
  msg: UpdateQueueMsg,
  error: unknown,
  attempts: number,
): Promise<void> {
  if (msg.type !== 'update_batch') return
  const triggerTime = String(msg.triggerTime ?? '').trim()
  const runId = String(msg.runId ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime) || !runId) return

  const shardIndex = Number.isFinite(msg.shardIndex) ? Number(msg.shardIndex) : 0
  const shardCount = boundedShardCount(msg.shardCount)
  const safeAttempts = Math.max(1, Math.floor(Number(attempts) || 1))
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1200)
  const prefix = runPrefix(triggerTime, runId)
  await env.KV.put(
    `${prefix}:failure:${shardIndex}`,
    JSON.stringify({
      trigger_time: triggerTime,
      run_id: runId,
      shard_index: shardIndex,
      shard_count: shardCount,
      cursor: Number(msg.cursor ?? 0),
      attempts: safeAttempts,
      error: message,
      failed_at: new Date().toISOString(),
    }),
    { expirationTtl: INDICATOR_QUEUE_STATE_TTL_SECONDS },
  )

  const exhausted = safeAttempts >= INDICATOR_QUEUE_MAX_DELIVERY_ATTEMPTS
  await logSchedulerResult(env.KV, 'indicator-queue', {
    status: exhausted ? 'error' : 'running',
    summary: exhausted
      ? `indicator queue delivery exhausted for ${triggerTime}; run_id=${runId}; shard=${shardIndex + 1}/${shardCount}; cursor=${Number(msg.cursor ?? 0)}; attempts=${safeAttempts}`
      : `indicator queue retry pending for ${triggerTime}; run_id=${runId}; shard=${shardIndex + 1}/${shardCount}; cursor=${Number(msg.cursor ?? 0)}; attempts=${safeAttempts}`,
    duration_ms: 0,
    run_id: runId,
    run_date: triggerTime,
    error: message,
  }, env)
}

export async function recordIndicatorQueueBatchProgress(
  env: Bindings,
  msg: UpdateQueueMsg,
  cursor: number,
  hasMore: boolean,
): Promise<void> {
  const triggerTime = String(msg.triggerTime ?? '').trim()
  const runId = String(msg.runId ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime) || !runId) return
  const shardIndex = Number.isFinite(msg.shardIndex) ? Number(msg.shardIndex) : 0
  const shardCount = boundedShardCount(msg.shardCount)
  const prefix = runPrefix(triggerTime, runId)
  await env.KV.put(`${prefix}:cursor:${shardIndex}`, String(cursor), {
    expirationTtl: INDICATOR_QUEUE_STATE_TTL_SECONDS,
  })
  await env.KV.delete(`${prefix}:failure:${shardIndex}`).catch(() => {})
  await logSchedulerResult(env.KV, 'indicator-queue', {
    status: 'running',
    summary: `indicator queue progress for ${triggerTime}; run_id=${runId}; shard=${shardIndex + 1}/${shardCount}; cursor=${cursor}; has_more=${hasMore ? 1 : 0}`,
    duration_ms: 0,
    run_id: runId,
    run_date: triggerTime,
  })
}

export async function runIndicatorQueueRecoveryWatchdog(
  env: Bindings,
  runDate?: string,
): Promise<string> {
  const triggerTime = String(runDate || twToday()).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(triggerTime)) {
    throw new Error(`indicator_queue_watchdog_invalid_date:${triggerTime}`)
  }
  const entry = await env.KV.get(
    `scheduler:run:indicator-queue:${triggerTime}`,
    'json',
  ) as SchedulerRunLogEntry | null
  if (!entry) return `skipped: indicator queue receipt missing for ${triggerTime}`
  if (entry.status === 'success') return `skipped: indicator queue already complete for ${triggerTime}`

  const runId = schedulerRunId(entry)
  if (!runId) throw new Error(`indicator_queue_watchdog_run_id_missing:${triggerTime}`)
  const shardCount = schedulerShardCount(entry)
  const timestampMs = Date.parse(String(entry.timestamp ?? ''))
  const ageMs = Number.isFinite(timestampMs) ? Date.now() - timestampMs : Number.POSITIVE_INFINITY
  if (ageMs < INDICATOR_QUEUE_STALE_MS) {
    return `skipped: indicator queue heartbeat fresh for ${triggerTime}; run_id=${runId}; age_ms=${Math.max(0, ageMs)}`
  }

  const prefix = runPrefix(triggerTime, runId)
  const leaseKey = `${prefix}:watchdog-lease`
  if (await env.KV.get(leaseKey)) {
    return `skipped: indicator queue watchdog lease active for ${triggerTime}; run_id=${runId}`
  }
  await env.KV.put(leaseKey, new Date().toISOString(), {
    expirationTtl: INDICATOR_QUEUE_WATCHDOG_LEASE_SECONDS,
  })

  const recoveryKey = `${prefix}:watchdog-recoveries`
  const recoveryCount = Number.parseInt((await env.KV.get(recoveryKey)) ?? '0', 10) || 0
  if (recoveryCount >= INDICATOR_QUEUE_MAX_RECOVERIES) {
    const error = `indicator queue watchdog exhausted for ${triggerTime}; run_id=${runId}; recoveries=${recoveryCount}`
    await Promise.all([
      logSchedulerResult(env.KV, 'indicator-queue', {
        status: 'error', summary: error, duration_ms: 0, run_id: runId, run_date: triggerTime, error,
      }, env),
      logSchedulerResult(env.KV, 'evening-chain', {
        status: 'error', summary: error, duration_ms: 0, run_id: runId, run_date: triggerTime, error,
      }, env),
    ])
    throw new Error(error)
  }

  const done = await env.KV.list({ prefix: `${prefix}:done:` })
  const doneShards = new Set(done.keys
    .map((key) => Number(key.name.slice(key.name.lastIndexOf(':') + 1)))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < shardCount))
  if (doneShards.size >= shardCount) {
    await env.UPDATE_QUEUE.send({
      type: 'finalize_update', cursor: 0, triggerTime, runId, shardCount, attempt: 1, continuationAttempt: 1,
    })
    const nextRecovery = recoveryCount + 1
    await env.KV.put(recoveryKey, String(nextRecovery), {
      expirationTtl: INDICATOR_QUEUE_STATE_TTL_SECONDS,
    })
    const summary = `indicator finalizer re-enqueued for ${triggerTime}; run_id=${runId}; recovery=${nextRecovery}/${INDICATOR_QUEUE_MAX_RECOVERIES}; done=${doneShards.size}/${shardCount}`
    await logSchedulerResult(env.KV, 'indicator-queue-watchdog', {
      status: 'success', summary, duration_ms: 0, run_id: runId, run_date: triggerTime,
    })
    return summary
  }

  const missingShards = Array.from({ length: shardCount }, (_, index) => index)
    .filter((index) => !doneShards.has(index))
  const cursors = await Promise.all(missingShards.map(async (shardIndex) => ({
    shardIndex,
    cursor: Number.parseInt((await env.KV.get(`${prefix}:cursor:${shardIndex}`)) ?? '0', 10) || 0,
  })))
  await env.UPDATE_QUEUE.sendBatch(cursors.map(({ shardIndex, cursor }) => ({
    body: { type: 'update_batch', cursor, triggerTime, runId, shardIndex, shardCount } as UpdateQueueMsg,
  })))
  const nextRecovery = recoveryCount + 1
  await env.KV.put(recoveryKey, String(nextRecovery), {
    expirationTtl: INDICATOR_QUEUE_STATE_TTL_SECONDS,
  })
  const cursorSummary = cursors.map(({ shardIndex, cursor }) => `${shardIndex}:${cursor}`).join(',')
  const summary = `indicator queue stale shards re-enqueued for ${triggerTime}; run_id=${runId}; recovery=${nextRecovery}/${INDICATOR_QUEUE_MAX_RECOVERIES}; done=${doneShards.size}/${shardCount}; cursors=${cursorSummary}`
  await Promise.all([
    logSchedulerResult(env.KV, 'indicator-queue-watchdog', {
      status: 'success', summary, duration_ms: 0, run_id: runId, run_date: triggerTime,
    }),
    logSchedulerResult(env.KV, 'indicator-queue', {
      status: 'running', summary, duration_ms: 0, run_id: runId, run_date: triggerTime,
    }),
    logSchedulerResult(env.KV, 'evening-chain', {
      status: 'running', summary, duration_ms: 0, run_id: runId, run_date: triggerTime,
    }),
  ])
  return summary
}
