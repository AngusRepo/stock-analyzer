import type { Bindings, UpdateQueueMsg } from '../types'
import { logSchedulerResult } from './schedulerRunLogger'
import { runWithMaintenanceLease } from './maintenanceLease'

export type MaintenanceBacklogTask =
  | 'legacy-evidence-migration'
  | 'legacy-strategy-evidence-migration'
  | 'd1-evidence-scrub'

const ACTIVE_TTL_SECONDS = 6 * 3600
const DEFAULT_MAX_ATTEMPTS = 240

function activeKey(task: MaintenanceBacklogTask): string {
  return `maintenance:backlog-drain:${task}:active`
}

function progressKey(task: MaintenanceBacklogTask): string {
  return `maintenance:backlog-drain:${task}:progress`
}

function queueMessage(
  task: MaintenanceBacklogTask,
  runDate: string,
  runId: string,
  attempt: number,
  maxAttempts: number,
): UpdateQueueMsg {
  return {
    type: 'maintenance_backlog_drain',
    maintenanceTask: task,
    cursor: 0,
    triggerTime: runDate,
    runId,
    attempt,
    maxAttempts,
  }
}

export async function enqueueMaintenanceBacklogDrain(
  env: Pick<Bindings, 'KV' | 'UPDATE_QUEUE'>,
  input: {
    task: MaintenanceBacklogTask
    runDate: string
    runId?: string
    maxAttempts?: number
  },
): Promise<{ queued: boolean; runId: string }> {
  const runId = input.runId ?? `${input.task}:${input.runDate}:${crypto.randomUUID()}`
  const key = activeKey(input.task)
  const existing = await env.KV.get(key)
  if (existing) return { queued: false, runId: existing }

  await env.KV.put(key, runId, { expirationTtl: ACTIVE_TTL_SECONDS })
  try {
    await env.UPDATE_QUEUE.send(queueMessage(
      input.task,
      input.runDate,
      runId,
      0,
      Math.max(1, Math.min(Math.floor(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), DEFAULT_MAX_ATTEMPTS)),
    ))
    return { queued: true, runId }
  } catch (error) {
    await env.KV.delete(key).catch(() => {})
    throw error
  }
}

async function runChunk(
  env: Bindings,
  task: MaintenanceBacklogTask,
): Promise<{ summary: string; backlogRemaining: boolean }> {
  if (task === 'legacy-strategy-evidence-migration') {
    const { runLegacyStrategyEvidenceMigration } = await import('./legacyStrategyEvidenceMigration')
    const result = await runLegacyStrategyEvidenceMigration(env, { symbolLimit: 10 })
    return {
      summary: `contexts=${result.candidate_contexts} decisions=${result.migrated_decisions} artifacts=${result.artifacts} original_bytes=${result.original_blob_bytes} compact_bytes=${result.compact_blob_bytes}`,
      backlogRemaining: result.backlog_remaining,
    }
  }
  if (task === 'legacy-evidence-migration') {
    const { runLegacyEvidenceMigration } = await import('./legacyEvidenceMigration')
    const result = await runLegacyEvidenceMigration(env, { limit: 100 })
    return {
      summary: `candidates=${result.candidates} artifacts=${result.artifacts} queued_scrubs=${result.queued_scrubs}`,
      backlogRemaining: result.backlog_remaining,
    }
  }

  const { runD1EvidenceScrub } = await import('./artifactLifecycle')
  const result = await runD1EvidenceScrub(env, { limit: 100 })
  if (result.failed || result.blocked) {
    throw new Error(`d1 evidence scrub failed ${JSON.stringify(result)}`)
  }
  return {
    summary: `candidates=${result.candidates} scrubbed=${result.scrubbed}`,
    backlogRemaining: result.candidates >= 100,
  }
}

export async function processMaintenanceBacklogDrain(
  env: Bindings,
  msg: UpdateQueueMsg,
): Promise<void> {
  const task = msg.maintenanceTask
  if (!task) throw new Error('maintenance_backlog_task_missing')
  const attempt = Math.max(0, Math.floor(msg.attempt ?? 0))
  const maxAttempts = Math.max(1, Math.min(Math.floor(msg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), DEFAULT_MAX_ATTEMPTS))
  const runId = msg.runId ?? `${task}:${msg.triggerTime}:queue`
  const leaseResult = await runWithMaintenanceLease(env.DB, {
    taskName: `${task}:queue`,
    leaseGroup: 'd1_heavy_maintenance',
    leaseSeconds: 300,
    run: () => runChunk(env, task),
  })

  if ('skipped' in leaseResult && leaseResult.skipped) {
    await (env.UPDATE_QUEUE as any).send(
      queueMessage(task, msg.triggerTime, runId, attempt, maxAttempts),
      { delaySeconds: 30 },
    )
    return
  }

  const result = leaseResult as { summary: string; backlogRemaining: boolean }
  await env.KV.put(progressKey(task), JSON.stringify({
    run_id: runId,
    attempt,
    summary: result.summary,
    backlog_remaining: result.backlogRemaining,
    updated_at: new Date().toISOString(),
  }), { expirationTtl: ACTIVE_TTL_SECONDS })

  if (result.backlogRemaining && attempt + 1 < maxAttempts) {
    await env.KV.put(activeKey(task), runId, { expirationTtl: ACTIVE_TTL_SECONDS })
    await (env.UPDATE_QUEUE as any).send(
      queueMessage(task, msg.triggerTime, runId, attempt + 1, maxAttempts),
      { delaySeconds: 5 },
    )
    return
  }

  await env.KV.delete(activeKey(task))
  await logSchedulerResult(env.KV, task, {
    status: result.backlogRemaining ? 'error' : 'success',
    summary: `durable_drain attempts=${attempt + 1}/${maxAttempts} backlog_remaining=${result.backlogRemaining} ${result.summary}`,
    duration_ms: 0,
    run_id: runId,
    run_date: msg.triggerTime,
  }, env)
}
