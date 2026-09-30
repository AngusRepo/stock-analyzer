import type { Bindings, UpdateQueueMsg } from '../types'
import { logSchedulerResult } from './schedulerRunLogger'
import { runWithMaintenanceLease } from './maintenanceLease'
import { activeDataDomainShadowBackfillRunId } from './dataDomainShadowSession'
import { databaseForDataDomain } from './dataDomainRegistry'
import { updateSchedulerExecutionTicket } from './schedulerExecutionTickets'

export type MaintenanceBacklogTask =
  | 'legacy-evidence-migration'
  | 'legacy-strategy-evidence-migration'
  | 'd1-evidence-scrub'
  | 'audit-json-retention'

const ACTIVE_TTL_SECONDS = 6 * 3600
const AUDIT_JSON_MAX_FAILURES = 3
const AUDIT_JSON_MAX_LEASE_DEFERRALS = 60
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
  deferred?: 'window_closed' | 'ops_shadow_backfill_active' | 'chunk_retry' | 'stale_chunk'
  failureAttempt?: number
  failureError?: string
  nextAuditTargets?: string[]
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

function auditJsonOpsShadowBackfillActiveResult(runId: string): MaintenanceChunkResult {
  return {
    summary: `deferred=ops_shadow_backfill_active run_id=${runId}`,
    backlogRemaining: true,
    deferred: 'ops_shadow_backfill_active',
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

async function releaseActiveRun(kv: KVNamespace, task: MaintenanceBacklogTask, runId: string): Promise<void> {
  // KV is not a CAS store. This prevents an observed successor from being deleted;
  // D1's maintenance lease remains the serialized mutation owner.
  if (await kv.get(activeKey(task)) === runId) await kv.delete(activeKey(task))
}

function auditFailureKey(): string {
  return 'maintenance:backlog-drain:audit-json-retention:failure'
}

type MaintenanceIdentity = Pick<UpdateQueueMsg, 'schedulerTicketId' | 'schedulerRunId'>

async function settleAuditTicket(env: Bindings, msg: UpdateQueueMsg, status: 'running' | 'success' | 'error' | 'skipped', summary: string, error?: string): Promise<void> {
  if (msg.maintenanceTask !== 'audit-json-retention' || !msg.schedulerTicketId) return
  if (!msg.schedulerRunId || msg.schedulerRunId !== msg.runId) throw new Error('maintenance_scheduler_identity_mismatch')
  await updateSchedulerExecutionTicket(databaseForDataDomain(env, 'ops'), {
    ticketId: msg.schedulerTicketId, runId: msg.schedulerRunId, status,
    authority: 'durable_queue', summary, error,
  })
}

async function currentAuditTicket(env: Bindings, msg: UpdateQueueMsg): Promise<{ status: string; last_summary?: string | null; last_error?: string | null } | null> {
  if (msg.maintenanceTask !== 'audit-json-retention' || !msg.schedulerTicketId) return null
  const ticket = await databaseForDataDomain(env, 'ops').prepare(`SELECT status,last_summary,last_error FROM scheduler_execution_tickets_v1 WHERE ticket_id=? AND run_id=? AND task=? AND business_date=?`)
    .bind(msg.schedulerTicketId, msg.runId, msg.maintenanceTask, msg.triggerTime).first<{ status: string; last_summary?: string | null; last_error?: string | null }>()
  if (!ticket) throw new Error('maintenance_scheduler_ticket_missing')
  return ticket
}

async function restoreAuditTerminalLog(
  env: Bindings, msg: UpdateQueueMsg, ticket: { status: string; last_summary?: string | null },
): Promise<void> {
  if (ticket.status !== 'success' && ticket.status !== 'skipped') return
  const task = 'audit-json-retention'
  type VisibleRun = { run_id?: string; status?: string; summary?: string }
  const [scheduler, cron, daily] = await Promise.all([
    env.KV.get(`scheduler:run:${task}:${msg.triggerTime}`, 'json') as Promise<VisibleRun | null>,
    env.KV.get(`cron:log:${task}:${msg.triggerTime}`, 'json') as Promise<VisibleRun | null>,
    env.KV.get(`scheduler:run:daily:${msg.triggerTime}`, 'json') as Promise<Record<string, VisibleRun> | null>,
  ])
  const visible = [scheduler, cron, daily?.[task]]
  // Do not repair an old ticket over any observed successor. KV remains a
  // non-CAS display; the D1 ticket is the authoritative terminal receipt.
  if (visible.some(entry => entry && entry.run_id !== msg.runId)) return
  const summary = ticket.last_summary ?? `durable_drain terminal=${ticket.status}`
  if (visible.every(entry => entry && entry.run_id === msg.runId && entry.status === ticket.status && entry.summary === summary)) return
  await logSchedulerResult(env.KV, task, {
    status: ticket.status, summary, duration_ms: 0,
    run_id: msg.runId, run_date: msg.triggerTime, strict: true,
  }, env)
}

async function closeSupersededAuditTicket(env: Bindings, msg: UpdateQueueMsg): Promise<void> {
  const ticket = await currentAuditTicket(env, msg)
  if (!ticket || ['success', 'error', 'skipped', 'blocked'].includes(ticket.status)) return
  try {
    await settleAuditTicket(env, msg, 'skipped', 'durable_drain owner_superseded; backlog_remaining=true')
  } catch (error) {
    const latest = await currentAuditTicket(env, msg)
    if (!latest || !['success', 'error', 'skipped', 'blocked'].includes(latest.status)) throw error
  }
}

async function finishAuditFailure(env: Bindings, msg: UpdateQueueMsg, error: string, now: Date): Promise<void> {
  const runId = String(msg.runId)
  const originalFailure = await env.KV.get(`${auditFailureKey()}:${runId}`, 'json') as Record<string, unknown> | null
  const failure = originalFailure ?? {
    run_id: runId, scheduler_ticket_id: msg.schedulerTicketId ?? null,
    worker_version: env.CF_VERSION_METADATA?.id ?? null,
    error, failed_at: now.toISOString(), backlog_remaining: true,
  }
  // D1 terminal CAS decides the owner before any cooldown is published.
  try {
    await settleAuditTicket(env, msg, 'error', 'durable_drain failed; automatic_continuation_stopped backlog_remaining=true', error)
  } catch (settlementError) {
    const latest = await currentAuditTicket(env, msg)
    if (!latest || !['success', 'skipped', 'blocked'].includes(latest.status)) throw settlementError
    await releaseActiveRun(env.KV, 'audit-json-retention', runId)
    return
  }
  // Preserve the original fault across a later deployment/recovery run.
  await env.KV.put(`${auditFailureKey()}:${runId}`, JSON.stringify(failure), { expirationTtl: 7 * 86400 })
  const currentFailure = await env.KV.get(auditFailureKey(), 'json') as { failed_at?: string } | null
  if (!currentFailure || String(currentFailure.failed_at) <= String(failure.failed_at)) {
    await env.KV.put(auditFailureKey(), JSON.stringify(failure), { expirationTtl: ACTIVE_TTL_SECONDS })
  }
  await logSchedulerResult(env.KV, 'audit-json-retention', {
    status: 'error', summary: 'durable_drain failed; automatic_continuation_stopped backlog_remaining=true',
    duration_ms: 0, run_id: runId, run_date: msg.triggerTime, error, strict: true,
  }, env)
  await releaseActiveRun(env.KV, 'audit-json-retention', runId)
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
  identity?: MaintenanceIdentity,
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
    ...(identity?.schedulerTicketId ? { schedulerTicketId: identity.schedulerTicketId, schedulerRunId: identity.schedulerRunId } : {}),
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

export type MaintenanceContinuationPhase = 'lease_busy' | 'next_attempt' | 'next_cycle' | 'chunk_retry'

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
  const existing = await env.KV.get(activeKey(input.task))
  if (existing && existing !== input.runId) {
    await closeSupersededAuditTicket(env, { ...input.message, runId: input.runId })
    return false
  }
  await env.KV.put(activeKey(input.task), input.runId, { expirationTtl: ACTIVE_TTL_SECONDS })
  try {
    await (env.UPDATE_QUEUE as any).send(input.message, { delaySeconds: input.delaySeconds })
    return true
  } catch (error) {
    if (input.task === 'audit-json-retention') {
      await finishAuditFailure(env, { ...input.message, runId: input.runId }, `continuation_send_failed:${input.phase}:${error instanceof Error ? error.message : String(error)}`, new Date())
      return false
    }
    await releaseActiveRun(env.KV, input.task, input.runId)
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
  env: Pick<Bindings, 'KV' | 'UPDATE_QUEUE'> & Partial<Bindings>,
  input: {
    task: MaintenanceBacklogTask
    runDate: string
    runId?: string
    maxAttempts?: number
    maxCycles?: number
    auditJsonOptions?: AuditJsonDrainOptions
    schedulerTicketId?: string
    schedulerRunId?: string
  },
): Promise<{ queued: boolean; runId: string; reason?: 'active' | 'failure_cooldown' }> {
  if (input.task === 'audit-json-retention' && !input.auditJsonOptions?.targets.length) {
    throw new Error('audit_json_durable_targets_missing')
  }
  const runId = input.runId ?? `${input.task}:${input.runDate}:${crypto.randomUUID()}`
  const key = activeKey(input.task)
  const existing = await env.KV.get(key)
  if (input.task === 'audit-json-retention') {
    if (Boolean(input.schedulerTicketId) !== Boolean(input.schedulerRunId) || (input.schedulerRunId && input.schedulerRunId !== runId)) throw new Error('maintenance_scheduler_identity_mismatch')
    const failure = await env.KV.get(auditFailureKey(), 'json') as { run_id: string; worker_version: string | null } | null
    if (failure && failure.worker_version === (env.CF_VERSION_METADATA?.id ?? null)) return { queued: false, runId: failure.run_id, reason: 'failure_cooldown' }
  }
  if (existing) return { queued: false, runId: existing, ...(input.task === 'audit-json-retention' ? { reason: 'active' as const } : {}) }

  await env.KV.put(key, runId, { expirationTtl: ACTIVE_TTL_SECONDS })
  try {
    const message = queueMessage(
      input.task,
      input.runDate,
      runId,
      0,
      Math.max(1, Math.min(Math.floor(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS), DEFAULT_MAX_ATTEMPTS)),
      0,
      Math.max(1, Math.min(Math.floor(input.maxCycles ?? defaultMaxCycles(input.task)), MAX_CYCLES)),
      input.auditJsonOptions,
      input,
    )
    if (input.task === 'audit-json-retention') await settleAuditTicket(env as Bindings, message, 'running', 'durable_drain queued; completion_pending=true')
    if (input.task === 'audit-json-retention') await logSchedulerResult(env.KV, input.task, {
      status: 'running', summary: 'durable_drain queued; completion_pending=true', duration_ms: 0, run_id: runId, run_date: input.runDate, strict: true,
    })
    await env.UPDATE_QUEUE.send(message)
    return { queued: true, runId }
  } catch (error) {
    try {
      await releaseActiveRun(env.KV, input.task, runId)
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'maintenance_initial_send_failed_active_release_failed',
      )
    }
    throw error
  }
}

type AuditChunkReceipt = {
  cycle: number; attempt: number; failures: number; dispatched: boolean;
  result: MaintenanceChunkResult;
}

async function runAuditChunkWithReceipt(env: Bindings, msg: UpdateQueueMsg, now: Date): Promise<MaintenanceChunkResult> {
  // New admissions carry a D1 ticket. Legacy pre-deploy queue messages retain
  // their prior compatibility path; their KV counter is not a cross-worker CAS.
  if (!msg.schedulerTicketId) return runChunk(env, 'audit-json-retention', msg, now)
  const db = databaseForDataDomain(env, 'ops')
  const ticket = await db.prepare(`SELECT metadata_json,status FROM scheduler_execution_tickets_v1 WHERE ticket_id=? AND run_id=?`)
    .bind(msg.schedulerTicketId, msg.runId).first<{ metadata_json: string; status: string }>()
  if (!ticket) throw new Error('maintenance_scheduler_ticket_missing')
  if (['success', 'error', 'skipped', 'blocked'].includes(ticket.status)) return { summary: 'terminal_ticket', backlogRemaining: true, deferred: 'stale_chunk' }
  const metadata = JSON.parse(ticket.metadata_json) as { maintenance_chunk?: AuditChunkReceipt }
  const previous = metadata.maintenance_chunk
  const cycle = msg.maintenanceCycle ?? 0
  const attempt = msg.attempt ?? 0
  if (previous && (previous.cycle > cycle || (previous.cycle === cycle && previous.attempt > attempt))) {
    return { summary: 'superseded_chunk', backlogRemaining: true, deferred: 'stale_chunk' }
  }
  const sameChunk = previous?.cycle === cycle && previous.attempt === attempt
  if (sameChunk && (previous.result.deferred !== 'chunk_retry' || previous.failures > Number(msg.maintenanceFailureAttempt ?? 0))) {
    return previous.dispatched ? { summary: 'continuation_already_dispatched', backlogRemaining: true, deferred: 'stale_chunk' } : previous.result
  }
  let result: MaintenanceChunkResult
  let failures = sameChunk ? previous.failures : 0
  try {
    // Only a completed immediate predecessor may narrow this attempt. The
    // original message keeps the full scope, so old deliveries and retries
    // without a completed receipt safely fall back to a full sweep.
    const selectedTargets = previous && previous.cycle === cycle && previous.attempt === attempt - 1
      && !previous.result.deferred ? previous.result.nextAuditTargets : undefined
    result = await runChunk(env, 'audit-json-retention', msg, now, selectedTargets)
  } catch (error) {
    failures += 1
    result = { summary: 'chunk_retry_pending', backlogRemaining: true, deferred: 'chunk_retry',
      failureAttempt: failures, failureError: error instanceof Error ? error.message : String(error) }
  }
  result = { ...result, failureAttempt: failures }
  const receipt: AuditChunkReceipt = { cycle, attempt, failures, dispatched: false, result }
  // Still inside maintenance's D1 lease. The metadata CAS also rejects any
  // unrelated concurrent ticket metadata edit; KV is display-only here.
  const saved = await db.prepare(`UPDATE scheduler_execution_tickets_v1
    SET metadata_json=json_set(metadata_json,'$.maintenance_chunk',json(?))
    WHERE ticket_id=? AND run_id=? AND metadata_json=? AND status IN ('accepted','queued','running','triggered')`)
    .bind(JSON.stringify(receipt), msg.schedulerTicketId, msg.runId, ticket.metadata_json).run()
  if (Number(saved.meta?.changes ?? 0) !== 1) throw new Error('maintenance_chunk_receipt_cas_lost')
  return result
}

async function markAuditContinuationDispatched(env: Bindings, msg: UpdateQueueMsg, result: MaintenanceChunkResult): Promise<void> {
  if (msg.maintenanceTask !== 'audit-json-retention' || !msg.schedulerTicketId) return
  await databaseForDataDomain(env, 'ops').prepare(`UPDATE scheduler_execution_tickets_v1
    SET metadata_json=json_set(metadata_json,'$.maintenance_chunk.dispatched',json('true'))
    WHERE ticket_id=? AND run_id=? AND json_extract(metadata_json,'$.maintenance_chunk.cycle')=?
      AND json_extract(metadata_json,'$.maintenance_chunk.attempt')=?
      AND json_extract(metadata_json,'$.maintenance_chunk.failures')=?
      AND COALESCE(json_extract(metadata_json,'$.maintenance_chunk.result.deferred'),'')=?`)
    .bind(msg.schedulerTicketId, msg.runId, msg.maintenanceCycle ?? 0, msg.attempt ?? 0, result.failureAttempt ?? 0, result.deferred ?? '').run()
}

async function runChunk(
  env: Bindings,
  task: MaintenanceBacklogTask,
  msg: UpdateQueueMsg,
  now: Date,
  selectedAuditTargets?: string[],
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
    const effectiveTargets = selectedAuditTargets ?? targets
    if (!effectiveTargets.length || new Set(effectiveTargets).size !== effectiveTargets.length
        || effectiveTargets.some(target => !targets.includes(target))) {
      throw new Error('audit_json_durable_target_scope_invalid')
    }
    const result = await runAuditJsonArchiveRetention(env, {
      businessDate: msg.triggerTime,
      runId: `${msg.runId ?? 'audit-json-retention'}:cycle-${msg.maintenanceCycle ?? 0}:attempt-${msg.attempt ?? 0}`,
      retentionDays: msg.maintenanceRetentionDays,
      limitPerTable: msg.maintenanceLimitPerTable,
      minBlobBytes: msg.maintenanceMinBlobBytes,
      targets: effectiveTargets,
      dryRun: false,
      confirmPhrase: AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
    })
    const failed = result.tables.filter((table) => table.status === 'failed')
    if (failed.length) {
      throw new Error(`audit json retention failed ${JSON.stringify(failed)}`)
    }
    const pendingTargets = result.tables.filter(table => table.backlog_remaining).map(table => table.target)
    const needsFullVerification = !pendingTargets.length && effectiveTargets.length < targets.length
    // Empty targets are revisited once before terminal success: their source
    // may have become eligible while another target was draining.
    const nextAuditTargets = pendingTargets.length ? pendingTargets : needsFullVerification ? targets : []
    return {
      summary: summarizeAuditJsonArchiveRun(result) + (needsFullVerification ? '; full_target_verification_pending=true' : ''),
      backlogRemaining: nextAuditTargets.length > 0,
      nextAuditTargets,
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
  const ownedMessage = { ...msg, runId }
  if (task === 'audit-json-retention') {
    if (Boolean(msg.schedulerTicketId) !== Boolean(msg.schedulerRunId) || (msg.schedulerRunId && msg.schedulerRunId !== runId)) throw new Error('maintenance_scheduler_identity_mismatch')
    const owner = await env.KV.get(activeKey(task))
    if (owner && owner !== runId) {
      await closeSupersededAuditTicket(env, ownedMessage)
      return // Stale delivery cannot mutate or release a successor.
    }
    const ticket = await currentAuditTicket(env, ownedMessage)
    if (ticket && ['success', 'error', 'skipped', 'blocked'].includes(ticket.status)) {
      if (ticket.status === 'error') await finishAuditFailure(env, ownedMessage, ticket.last_error ?? 'maintenance_terminal_error', now)
      else {
        await restoreAuditTerminalLog(env, ownedMessage, ticket)
        await releaseActiveRun(env.KV, task, runId)
      }
      return
    }
    const progress = await env.KV.get(progressKey(task), 'json') as {
      run_id?: string; attempt?: number; cycle?: number; failure_attempt?: number; error?: string
    } | null
    if (!msg.schedulerTicketId && progress?.run_id === runId && progress.attempt === attempt && progress.cycle === cycle
      && Number(progress.failure_attempt ?? 0) > Number(msg.maintenanceFailureAttempt ?? 0)) {
      // An earlier delivery already failed this chunk. Recover the continuation
      // with its persisted counter; never execute the stale attempt from zero.
      const failureAttempt = Number(progress.failure_attempt)
      if (failureAttempt >= AUDIT_JSON_MAX_FAILURES) {
        await finishAuditFailure(env, ownedMessage, progress.error ?? 'maintenance_chunk_retry_exhausted', now)
      } else {
        await sendMaintenanceContinuation(env, { task, runDate: msg.triggerTime, runId,
          message: { ...ownedMessage, maintenanceFailureAttempt: failureAttempt },
          delaySeconds: 30 * failureAttempt, phase: 'chunk_retry' })
      }
      return
    }
    const failed = await env.KV.get(`${auditFailureKey()}:${runId}`)
    if (failed) {
      await finishAuditFailure(env, ownedMessage, (JSON.parse(failed) as {error: string}).error, now)
      return
    }
  }
  let leaseResult: MaintenanceChunkResult | { skipped: true; reason: string }
  try {
    if (task === 'audit-json-retention' && !isAuditJsonDurableWindowOpen(now)) {
      leaseResult = auditJsonWindowClosedResult()
    } else {
      const opsShadowBackfillRunId = task === 'audit-json-retention'
        ? await activeDataDomainShadowBackfillRunId(env.KV, 'ops')
        : null
      leaseResult = opsShadowBackfillRunId
        ? auditJsonOpsShadowBackfillActiveResult(opsShadowBackfillRunId)
        : await runWithMaintenanceLease(env.DB, {
          taskName: `${task}:queue`,
          leaseGroup: 'd1_heavy_maintenance',
          leaseSeconds: 300,
          run: () => task === 'audit-json-retention' ? runAuditChunkWithReceipt(env, ownedMessage, now) : runChunk(env, task, msg, now),
        })
    }
  } catch (error) {
    if (task !== 'audit-json-retention' || msg.schedulerTicketId) throw error
    const failureAttempt = Math.max(0, Math.floor(msg.maintenanceFailureAttempt ?? 0)) + 1
    const errorMessage = error instanceof Error ? error.message : String(error)
    await env.KV.put(progressKey(task), JSON.stringify({
      run_id: runId, scheduler_ticket_id: msg.schedulerTicketId, attempt, cycle,
      failure_attempt: failureAttempt, error: errorMessage, backlog_remaining: true,
      worker_version: env.CF_VERSION_METADATA?.id ?? null, updated_at: now.toISOString(),
    }), { expirationTtl: ACTIVE_TTL_SECONDS })
    if (failureAttempt >= AUDIT_JSON_MAX_FAILURES) {
      await finishAuditFailure(env, ownedMessage, errorMessage, now)
      return
    }
    await logSchedulerResult(env.KV, task, {
      status: 'running', summary: `durable_drain retry_pending failure_attempt=${failureAttempt}/${AUDIT_JSON_MAX_FAILURES} backlog_remaining=true`,
      duration_ms: 0, run_id: runId, run_date: msg.triggerTime, error: errorMessage, strict: true,
    })
    await sendMaintenanceContinuation(env, {
      task, runDate: msg.triggerTime, runId,
      message: { ...ownedMessage, maintenanceFailureAttempt: failureAttempt },
      delaySeconds: 30 * failureAttempt, phase: 'chunk_retry',
    })
    return
  }

  if ('skipped' in leaseResult && leaseResult.skipped) {
    const deferrals = Math.max(0, Math.floor(msg.leaseRetryAttempt ?? 0)) + 1
    if (task === 'audit-json-retention' && deferrals >= AUDIT_JSON_MAX_LEASE_DEFERRALS) {
      await finishAuditFailure(env, ownedMessage, `maintenance_lease_deferrals_exhausted:${leaseResult.reason}`, now)
      return
    }
    await sendMaintenanceContinuation(env, {
      task,
      runDate: msg.triggerTime,
      runId,
      message: { ...queueMessage(
        task,
        msg.triggerTime,
        runId,
        attempt,
        maxAttempts,
        cycle,
        maxCycles,
        auditJsonOptionsFromMessage(msg),
        msg,
      ), ...(task === 'audit-json-retention' ? { leaseRetryAttempt: deferrals, maintenanceFailureAttempt: msg.maintenanceFailureAttempt } : {}) },
      delaySeconds: 30,
      phase: 'lease_busy',
    })
    return
  }

  const result = leaseResult as MaintenanceChunkResult
  if (result.deferred === 'stale_chunk') return
  if (result.deferred === 'chunk_retry') {
    const failureAttempt = Number(result.failureAttempt)
    const error = result.failureError ?? 'maintenance_chunk_failed'
    await env.KV.put(progressKey(task), JSON.stringify({ run_id: runId, attempt, cycle, failure_attempt: failureAttempt, error,
      backlog_remaining: true, worker_version: env.CF_VERSION_METADATA?.id ?? null, updated_at: now.toISOString() }), { expirationTtl: ACTIVE_TTL_SECONDS })
    if (failureAttempt >= AUDIT_JSON_MAX_FAILURES) {
      await finishAuditFailure(env, ownedMessage, error, now)
      return
    }
    await logSchedulerResult(env.KV, task, { status: 'running', summary: `durable_drain retry_pending failure_attempt=${failureAttempt}/${AUDIT_JSON_MAX_FAILURES} backlog_remaining=true`,
      duration_ms: 0, run_id: runId, run_date: msg.triggerTime, error, strict: true })
    if (await sendMaintenanceContinuation(env, { task, runDate: msg.triggerTime, runId,
      message: { ...ownedMessage, maintenanceFailureAttempt: failureAttempt }, delaySeconds: 30 * failureAttempt, phase: 'chunk_retry' })) {
      await markAuditContinuationDispatched(env, ownedMessage, result)
    }
    return
  }
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

  if (result.deferred === 'window_closed' || result.deferred === 'ops_shadow_backfill_active') {
    await settleAuditTicket(env, ownedMessage, 'skipped', `durable_drain ${result.summary} backlog_remaining=true`)
    await releaseActiveRun(env.KV, task, runId)
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
        msg,
      ),
      delaySeconds: 5,
      phase: 'next_attempt',
    })
    await markAuditContinuationDispatched(env, ownedMessage, result)
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
        msg,
      ),
      delaySeconds: 30,
      phase: 'next_cycle',
    })
    await markAuditContinuationDispatched(env, ownedMessage, result)
    return
  }

  if (task === 'audit-json-retention' && nextStep === 'exhausted') {
    await finishAuditFailure(env, ownedMessage, 'maintenance_drain_budget_exhausted:backlog_remaining=true', now)
    return
  }
  await settleAuditTicket(env, ownedMessage, 'success', `durable_drain complete ${result.summary}`)
  await releaseActiveRun(env.KV, task, runId)
  await logSchedulerResult(env.KV, task, {
    status: nextStep === 'exhausted' ? 'error' : 'success',
    summary: `durable_drain cycles=${cycle + 1}/${maxCycles} attempts=${attempt + 1}/${maxAttempts} backlog_remaining=${result.backlogRemaining} ${result.summary}`,
    duration_ms: 0,
    run_id: runId,
    run_date: msg.triggerTime,
  }, env)
}
