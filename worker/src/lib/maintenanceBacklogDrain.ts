import type { Bindings, UpdateQueueMsg } from '../types'
import { logSchedulerResult } from './schedulerRunLogger'
import { runWithMaintenanceLease } from './maintenanceLease'

export type MaintenanceBacklogTask =
  | 'legacy-evidence-migration'
  | 'legacy-strategy-evidence-migration'
  | 'd1-evidence-scrub'
  | 'audit-json-retention'

const ACTIVE_TTL_SECONDS = 6 * 3600
const DEFAULT_MAX_ATTEMPTS = 240
const DEFAULT_MAX_CYCLES = 4
const MAX_CYCLES = 8
const AUDIT_JSON_WINDOW_START_MINUTE_UTC = 17 * 60
const AUDIT_JSON_WINDOW_END_MINUTE_UTC = 22 * 60 + 40

export type AuditJsonDrainOptions = {
  targets: string[]
  retentionDays: number
  limitPerTable: number
  minBlobBytes: number
}

type MaintenanceChunkResult = {
  summary: string
  backlogRemaining: boolean
  deferred?: 'window_closed'
}

export function isAuditJsonDurableWindowOpen(now: Date): boolean {
  const minuteUtc = now.getUTCHours() * 60 + now.getUTCMinutes()
  return minuteUtc >= AUDIT_JSON_WINDOW_START_MINUTE_UTC
    && minuteUtc < AUDIT_JSON_WINDOW_END_MINUTE_UTC
}

function auditJsonWindowClosedResult(): MaintenanceChunkResult {
  return {
    summary: 'deferred=window_closed utc_window=17:00-22:40',
    backlogRemaining: true,
    deferred: 'window_closed',
  }
}

export type MaintenanceDrainNextStep = 'next_attempt' | 'next_cycle' | 'complete' | 'exhausted'

export function resolveMaintenanceDrainNextStep(input: {
  backlogRemaining: boolean
  attempt: number
  maxAttempts: number
  cycle: number
  maxCycles: number
}): MaintenanceDrainNextStep {
  if (!input.backlogRemaining) return 'complete'
  if (input.attempt + 1 < input.maxAttempts) return 'next_attempt'
  if (input.cycle + 1 < input.maxCycles) return 'next_cycle'
  return 'exhausted'
}
function defaultMaxCycles(task: MaintenanceBacklogTask): number {
  return task === 'd1-evidence-scrub' ? DEFAULT_MAX_CYCLES : 1
}


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
  cycle: number,
  maxCycles: number,
  auditJsonOptions?: AuditJsonDrainOptions,
): UpdateQueueMsg {
  return {
    type: 'maintenance_backlog_drain',
    maintenanceTask: task,
    cursor: 0,
    triggerTime: runDate,
    runId,
    attempt,
    maxAttempts,
    maintenanceCycle: cycle,
    maxMaintenanceCycles: maxCycles,
    ...(auditJsonOptions ? {
      maintenanceTargets: [...auditJsonOptions.targets],
      maintenanceRetentionDays: auditJsonOptions.retentionDays,
      maintenanceLimitPerTable: auditJsonOptions.limitPerTable,
      maintenanceMinBlobBytes: auditJsonOptions.minBlobBytes,
    } : {}),
  }
}

function auditJsonOptionsFromMessage(msg: UpdateQueueMsg): AuditJsonDrainOptions | undefined {
  if (msg.maintenanceTask !== 'audit-json-retention') return undefined
  return {
    targets: [...(msg.maintenanceTargets ?? [])],
    retentionDays: Number(msg.maintenanceRetentionDays),
    limitPerTable: Number(msg.maintenanceLimitPerTable),
    minBlobBytes: Number(msg.maintenanceMinBlobBytes),
  }
}

export type MaintenanceContinuationPhase = 'lease_busy' | 'next_attempt' | 'next_cycle'

export async function sendMaintenanceContinuation(
  env: Bindings,
  input: {
    task: MaintenanceBacklogTask
    runDate: string
    runId: string
    message: UpdateQueueMsg
    delaySeconds: number
    phase: MaintenanceContinuationPhase
  },
): Promise<boolean> {
  await env.KV.put(activeKey(input.task), input.runId, { expirationTtl: ACTIVE_TTL_SECONDS })
  try {
    await (env.UPDATE_QUEUE as any).send(input.message, { delaySeconds: input.delaySeconds })
    return true
  } catch (error) {
    await env.KV.delete(activeKey(input.task))
    const errorMessage = error instanceof Error ? error.message : String(error)
    await logSchedulerResult(env.KV, input.task, {
      status: 'error',
      summary: `durable_drain continuation_send_failed phase=${input.phase} backlog_remaining=true`,
      duration_ms: 0,
      run_id: input.runId,
      run_date: input.runDate,
      error: errorMessage,
      strict: true,
    }, env)
    return false
  }
}

export async function enqueueMaintenanceBacklogDrain(
  env: Pick<Bindings, 'KV' | 'UPDATE_QUEUE'>,
  input: {
    task: MaintenanceBacklogTask
    runDate: string
    runId?: string
    maxAttempts?: number
    maxCycles?: number
    auditJsonOptions?: AuditJsonDrainOptions
  },
): Promise<{ queued: boolean; runId: string }> {
  if (input.task === 'audit-json-retention' && !input.auditJsonOptions?.targets.length) {
    throw new Error('audit_json_durable_targets_missing')
  }
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
      0,
      Math.max(1, Math.min(Math.floor(input.maxCycles ?? defaultMaxCycles(input.task)), MAX_CYCLES)),
      input.auditJsonOptions,
    ))
    return { queued: true, runId }
  } catch (error) {
    try {
      await env.KV.delete(key)
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'maintenance_initial_send_failed_active_release_failed',
      )
    }
    throw error
  }
}

async function runChunk(
  env: Bindings,
  task: MaintenanceBacklogTask,
  msg: UpdateQueueMsg,
  now: Date,
): Promise<MaintenanceChunkResult> {
  if (task === 'audit-json-retention') {
    if (!isAuditJsonDurableWindowOpen(now)) return auditJsonWindowClosedResult()
    const {
      AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
      AUDIT_JSON_ARCHIVE_TARGET_IDS,
      runAuditJsonArchiveRetention,
      summarizeAuditJsonArchiveRun,
    } = await import('./auditJsonArchive')
    const targets = [...new Set(
      (msg.maintenanceTargets ?? []).map((target) => String(target).trim()).filter(Boolean),
    )]
    if (!targets.length) throw new Error('audit_json_durable_targets_missing')
    const allowedTargets = new Set<string>(AUDIT_JSON_ARCHIVE_TARGET_IDS)
    const unknownTargets = targets.filter((target) => !allowedTargets.has(target))
    if (unknownTargets.length) {
      throw new Error(`audit_json_durable_unknown_target:${unknownTargets.join(',')}`)
    }
    const result = await runAuditJsonArchiveRetention(env, {
      businessDate: msg.triggerTime,
      runId: `${msg.runId ?? 'audit-json-retention'}:cycle-${msg.maintenanceCycle ?? 0}:attempt-${msg.attempt ?? 0}`,
      retentionDays: msg.maintenanceRetentionDays,
      limitPerTable: msg.maintenanceLimitPerTable,
      minBlobBytes: msg.maintenanceMinBlobBytes,
      targets,
      dryRun: false,
      confirmPhrase: AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
    })
    const failed = result.tables.filter((table) => table.status === 'failed')
    if (failed.length) {
      throw new Error(`audit json retention failed ${JSON.stringify(failed)}`)
    }
    return {
      summary: summarizeAuditJsonArchiveRun(result),
      backlogRemaining: result.tables.some((table) => table.backlog_remaining),
    }
  }
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
  now = new Date(),
): Promise<void> {
  const task = msg.maintenanceTask
  if (!task) throw new Error('maintenance_backlog_task_missing')
  const attempt = Math.max(0, Math.floor(msg.attempt ?? 0))
  const maxAttempts = Math.max(1, Math.min(Math.floor(msg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), DEFAULT_MAX_ATTEMPTS))
  const cycle = Math.max(0, Math.floor(msg.maintenanceCycle ?? 0))
  const maxCycles = Math.max(1, Math.min(Math.floor(msg.maxMaintenanceCycles ?? defaultMaxCycles(task)), MAX_CYCLES))
  const runId = msg.runId ?? `${task}:${msg.triggerTime}:queue`
  const leaseResult = task === 'audit-json-retention' && !isAuditJsonDurableWindowOpen(now)
    ? auditJsonWindowClosedResult()
    : await runWithMaintenanceLease(env.DB, {
        taskName: `${task}:queue`,
        leaseGroup: 'd1_heavy_maintenance',
        leaseSeconds: 300,
        run: () => runChunk(env, task, msg, now),
      })

  if ('skipped' in leaseResult && leaseResult.skipped) {
    await sendMaintenanceContinuation(env, {
      task,
      runDate: msg.triggerTime,
      runId,
      message: queueMessage(
        task,
        msg.triggerTime,
        runId,
        attempt,
        maxAttempts,
        cycle,
        maxCycles,
        auditJsonOptionsFromMessage(msg),
      ),
      delaySeconds: 30,
      phase: 'lease_busy',
    })
    return
  }

  const result = leaseResult as MaintenanceChunkResult
  await env.KV.put(progressKey(task), JSON.stringify({
    run_id: runId,
    attempt,
    summary: result.summary,
    backlog_remaining: result.backlogRemaining,
    cycle,
    max_cycles: maxCycles,
    deferred: result.deferred,
    updated_at: now.toISOString(),
  }), { expirationTtl: ACTIVE_TTL_SECONDS })

  if (result.deferred === 'window_closed') {
    await env.KV.delete(activeKey(task))
    await logSchedulerResult(env.KV, task, {
      status: 'skipped',
      summary: `durable_drain ${result.summary} backlog_remaining=true`,
      duration_ms: 0,
      run_id: runId,
      run_date: msg.triggerTime,
    }, env)
    return
  }

  const nextStep = resolveMaintenanceDrainNextStep({
    backlogRemaining: result.backlogRemaining,
    attempt,
    maxAttempts,
    cycle,
    maxCycles,
  })

  if (nextStep === 'next_attempt') {
    await sendMaintenanceContinuation(env, {
      task,
      runDate: msg.triggerTime,
      runId,
      message: queueMessage(
        task,
        msg.triggerTime,
        runId,
        attempt + 1,
        maxAttempts,
        cycle,
        maxCycles,
        auditJsonOptionsFromMessage(msg),
      ),
      delaySeconds: 5,
      phase: 'next_attempt',
    })
    return
  }

  if (nextStep === 'next_cycle') {
    await sendMaintenanceContinuation(env, {
      task,
      runDate: msg.triggerTime,
      runId,
      message: queueMessage(
        task,
        msg.triggerTime,
        runId,
        0,
        maxAttempts,
        cycle + 1,
        maxCycles,
        auditJsonOptionsFromMessage(msg),
      ),
      delaySeconds: 30,
      phase: 'next_cycle',
    })
    return
  }

  await env.KV.delete(activeKey(task))
  await logSchedulerResult(env.KV, task, {
    status: nextStep === 'exhausted' ? 'error' : 'success',
    summary: `durable_drain cycles=${cycle + 1}/${maxCycles} attempts=${attempt + 1}/${maxAttempts} backlog_remaining=${result.backlogRemaining} ${result.summary}`,
    duration_ms: 0,
    run_id: runId,
    run_date: msg.triggerTime,
  }, env)
}
