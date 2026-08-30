import type { Bindings, UpdateQueueMsg } from '../types'
import { runWeeklyCleanup, runWeeklyLocalMaintenance } from './localMaintenance'
import { runExternalEvidenceMaterializeDetailed } from './controllerResearchWorkflows'
import { databaseForDataDomain } from './dataDomainRegistry'
import {
  isMaintenanceLeaseBusy,
  runWithMaintenanceLease,
  summarizeMaintenanceLeaseResult,
  type MaintenanceLeaseBusy,
} from './maintenanceLease'
import { classifySchedulerSummary, logSchedulerResult } from './schedulerRunLogger'
import {
  schedulerTicketStatusForRunLog,
  updateSchedulerExecutionTicket,
  type SchedulerExecutionTicketStatus,
} from './schedulerExecutionTickets'
import { refreshPaperKellyCalibration } from './paperKellyCalibration'
import { assertAutomaticPromotionAllowed } from './shadowPromotionGovernance'

type WeeklyRegistryRunner = () => Promise<unknown>

export function requireWeeklyRegistryReadbackSuccess(result: unknown): string {
  const summary = typeof result === 'string' ? result.trim() : ''
  if (!summary.startsWith('model_registry readback=ok')) {
    throw new Error(`weekly model registry readback failed: ${summary || 'non-success response'}`)
  }
  return summary
}

async function putManualRunLog(
  kv: KVNamespace,
  task: string,
  runId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await kv.put(
    `scheduler:manual:${task}:${runId}`,
    JSON.stringify({
      task,
      run_id: runId,
      timestamp: new Date().toISOString(),
      ...payload,
    }),
    { expirationTtl: 7 * 86400 },
  )
}

export async function runWeeklyCleanupClosure(
  env: Bindings,
  registryRunner?: WeeklyRegistryRunner,
): Promise<string> {
  const cleanup = await runWeeklyCleanup(env)
  const registryReadback = registryRunner
    ? await registryRunner()
    : await (await import('./controllerWorkflows')).runWeeklyModelRegistryCheck(env)
  const registrySummary = requireWeeklyRegistryReadbackSuccess(registryReadback)
  const maintenance = await runWeeklyLocalMaintenance(env)
  if (!cleanup.ok || !maintenance.ok) {
    throw new Error(`weekly cleanup failed ${JSON.stringify({ cleanup, maintenance })}`)
  }
  const knowledgeCutoffDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  assertAutomaticPromotionAllowed('paper_kelly', 'paper_position_cap')
  const paperKelly = await refreshPaperKellyCalibration(env, {
    knowledgeCutoffDate,
    allowPromotion: true,
  })
  return `weekly_cleanup_v2 cleanup=${JSON.stringify(cleanup)} maintenance=${JSON.stringify(maintenance)} model-registry=${registrySummary} lifecycle dry-run=required paper-kelly=${paperKelly.status}:${paperKelly.runId}`
}

type DurableTaskResult = {
  summary: string
  receipt?: Record<string, unknown>
  d1Stats?: Record<string, unknown>
}

const DURABLE_TASK_RECOVERY_MAX_ATTEMPTS = 3
const DURABLE_TASK_RECOVERY_MAX_DELAY_SECONDS = 43_200
const DURABLE_TASK_RECOVERY_MIN_DELAY_SECONDS = 5
const DURABLE_TASK_RECOVERY_FENCE_OWNER = 'durable_scheduler_lease_recovery'

export class DurableTaskRecoveryEnqueueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DurableTaskRecoveryEnqueueError'
  }
}

export interface DurableTaskRecoverySchedule {
  scheduled: boolean
  reason: 'scheduled' | 'holder_replaced_scheduled' | 'deduplicated' | 'attempt_limit'
  attempt: number
  delaySeconds: number | null
  fenceKey: string | null
}

function maintenanceLeaseExpiryMs(value: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

export function durableTaskRecoveryDelaySeconds(leaseExpiresAt: string, nowMs = Date.now()): number {
  const expiresAtMs = maintenanceLeaseExpiryMs(leaseExpiresAt)
  const requested = Number.isFinite(expiresAtMs)
    ? Math.ceil((expiresAtMs - nowMs) / 1000) + DURABLE_TASK_RECOVERY_MIN_DELAY_SECONDS
    : 30
  return Math.min(
    DURABLE_TASK_RECOVERY_MAX_DELAY_SECONDS,
    Math.max(DURABLE_TASK_RECOVERY_MIN_DELAY_SECONDS, requested),
  )
}

function durableTaskRecoveryFenceKey(
  task: NonNullable<UpdateQueueMsg['scheduledTask']>,
  runDate: string,
  holderOwnerId: string,
  attempt: number,
): string {
  return `durable_task_recovery:${task}:${runDate}:${holderOwnerId}:${attempt}`
}

export async function scheduleDurableTaskLeaseRecovery(
  opsDb: D1Database,
  queue: Queue<UpdateQueueMsg>,
  msg: UpdateQueueMsg,
  busy: MaintenanceLeaseBusy,
  nowMs = Date.now(),
): Promise<DurableTaskRecoverySchedule> {
  const task = msg.scheduledTask
  if (!task) throw new DurableTaskRecoveryEnqueueError('durable recovery missing scheduled task')
  const currentAttempt = Math.max(0, Math.floor(Number(msg.durableTaskRecoveryAttempt ?? 0)))
  const expectedOwner = String(msg.durableTaskExpectedLeaseOwner ?? '').trim()
  const holderReplaced = Boolean(expectedOwner && expectedOwner !== busy.holderOwnerId)
  if (currentAttempt >= DURABLE_TASK_RECOVERY_MAX_ATTEMPTS) {
    return {
      scheduled: false,
      reason: 'attempt_limit',
      attempt: currentAttempt,
      delaySeconds: null,
      fenceKey: null,
    }
  }

  const nextAttempt = currentAttempt + 1
  const runId = msg.runId || `${task}-${msg.triggerTime}`
  const fenceKey = durableTaskRecoveryFenceKey(task, msg.triggerTime, busy.holderOwnerId, nextAttempt)
  const delaySeconds = durableTaskRecoveryDelaySeconds(busy.leaseExpiresAt, nowMs)
  const fenceTtlSeconds = Math.min(86_400, Math.max(300, delaySeconds + 900))
  const fenceExpiryModifier = `+${fenceTtlSeconds} seconds`
  let claimed: { lock_key?: string | null } | null
  try {
    claimed = await opsDb.prepare(`
      INSERT INTO scheduler_locks (
        lock_key, owner, run_date, run_id, created_at, expires_at
      ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, datetime('now', ?))
      ON CONFLICT(lock_key) DO UPDATE SET
        owner=excluded.owner,
        run_date=excluded.run_date,
        run_id=excluded.run_id,
        created_at=excluded.created_at,
        expires_at=excluded.expires_at
      WHERE scheduler_locks.expires_at IS NULL
         OR scheduler_locks.expires_at <= CURRENT_TIMESTAMP
      RETURNING lock_key
    `).bind(
      fenceKey,
      DURABLE_TASK_RECOVERY_FENCE_OWNER,
      msg.triggerTime,
      runId,
      fenceExpiryModifier,
    ).first<{ lock_key?: string | null }>()
  } catch (error) {
    throw new DurableTaskRecoveryEnqueueError(
      `durable recovery fence failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (String(claimed?.lock_key ?? '') !== fenceKey) {
    const existingFence = await opsDb.prepare(`
      SELECT owner, run_id
        FROM scheduler_locks
       WHERE lock_key=?
         AND expires_at > CURRENT_TIMESTAMP
    `).bind(fenceKey).first<{
      owner?: string | null
      run_id?: string | null
    }>()
    const sameClaimResume = String(existingFence?.owner ?? '') === DURABLE_TASK_RECOVERY_FENCE_OWNER
      && String(existingFence?.run_id ?? '') === runId
    if (!sameClaimResume) {
      return {
        scheduled: false,
        reason: 'deduplicated',
        attempt: nextAttempt,
        delaySeconds: null,
        fenceKey,
      }
    }
  }

  try {
    await queue.send({
      ...msg,
      runId,
      durableTaskRecoveryAttempt: nextAttempt,
      durableTaskExpectedLeaseOwner: busy.holderOwnerId,
    }, { delaySeconds })
  } catch (error) {
    await opsDb.prepare(`
      DELETE FROM scheduler_locks
       WHERE lock_key=? AND owner=? AND run_id=?
    `).bind(fenceKey, DURABLE_TASK_RECOVERY_FENCE_OWNER, runId).run().catch(() => {})
    throw new DurableTaskRecoveryEnqueueError(
      `durable recovery enqueue failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return {
    scheduled: true,
    reason: holderReplaced ? 'holder_replaced_scheduled' : 'scheduled',
    attempt: nextAttempt,
    delaySeconds,
    fenceKey,
  }
}

export async function releaseDurableTaskRecoveryFence(
  opsDb: D1Database,
  msg: UpdateQueueMsg,
  runId: string,
): Promise<boolean> {
  const task = msg.scheduledTask
  const attempt = Math.max(0, Math.floor(Number(msg.durableTaskRecoveryAttempt ?? 0)))
  const expectedOwner = String(msg.durableTaskExpectedLeaseOwner ?? '').trim()
  if (!task || attempt <= 0 || !expectedOwner) return false
  const fenceKey = durableTaskRecoveryFenceKey(task, msg.triggerTime, expectedOwner, attempt)
  const released = await opsDb.prepare(`
    DELETE FROM scheduler_locks
     WHERE lock_key=? AND owner=? AND run_id=?
    RETURNING lock_key
  `).bind(fenceKey, DURABLE_TASK_RECOVERY_FENCE_OWNER, runId).first<{ lock_key?: string | null }>()
  return String(released?.lock_key ?? '') === fenceKey
}

async function putTerminalReceipt(
  kv: KVNamespace,
  task: string,
  runDate: string,
  runId: string,
  result: DurableTaskResult,
): Promise<void> {
  await kv.put(
    'scheduler:terminal:' + task + ':' + runDate,
    JSON.stringify({
      schema_version: 'scheduler_terminal_receipt_v1',
      task,
      run_date: runDate,
      run_id: runId,
      status: 'success',
      summary: result.summary,
      materialization_receipt: result.receipt ?? null,
      d1_stats: result.d1Stats ?? null,
      completed_at: new Date().toISOString(),
    }),
    { expirationTtl: 30 * 86400 },
  )
}

export type DurableSchedulerTaskRunner = (
  task: NonNullable<UpdateQueueMsg['scheduledTask']>,
  env: Bindings,
  runDate: string,
) => Promise<DurableTaskResult | MaintenanceLeaseBusy>

async function runDurableTask(
  task: NonNullable<UpdateQueueMsg['scheduledTask']>,
  env: Bindings,
  runDate: string,
): Promise<DurableTaskResult | MaintenanceLeaseBusy> {
  if (task === 'external-evidence') {
    const result = await runExternalEvidenceMaterializeDetailed(env, runDate)
    return { summary: result.summary, receipt: result.receipt, d1Stats: result.d1Stats }
  }
  if (task === 's12-smcvwap-calibration') {
    const [
      {
        ensureS12TwCalibrationTables,
        inspectS12TwCalibrationLifecycleCensoring,
        runS12TwCalibration,
      },
      { resolveS12CalibrationCadence },
      { acquireS12ResearchLeaseDetailed, assertS12ResearchLeaseRenewed, releaseS12ResearchLease },
    ] = await Promise.all([
      import('./s12TwEquityCalibration'),
      import('./s12CalibrationCadence'),
      import('./s12ResearchLease'),
    ])
    const cadence = resolveS12CalibrationCadence('auto', runDate)
    const learningDb = databaseForDataDomain(env, 'learning')
    const canonicalRunId = `s12-tw-calibration-${cadence}-${runDate}`
    const opsDb = databaseForDataDomain(env, 'ops')
    const leased = await runWithMaintenanceLease(opsDb, {
      taskName: `s12-smcvwap-calibration:${runDate}`,
      leaseGroup: `s12_smcvwap_calibration:${runDate}`,
      leaseSeconds: 600,
      run: async (): Promise<DurableTaskResult | MaintenanceLeaseBusy> => {
        const researchLeaseRunId = `${canonicalRunId}:research:${crypto.randomUUID()}`
        const researchLease = await acquireS12ResearchLeaseDetailed(
          opsDb,
          researchLeaseRunId,
          runDate,
          1800,
        )
        if (researchLease.acquired === false) {
          return {
            skipped: true,
            reason: `maintenance_lease_busy:${researchLease.holderOwner}:${researchLease.leaseExpiresAt}`,
            leaseGroup: 's12:research-market-data',
            holderTaskName: researchLease.holderOwner,
            holderOwnerId: researchLease.holderRunId,
            leaseExpiresAt: researchLease.leaseExpiresAt,
          }
        }
        try {
          await ensureS12TwCalibrationTables(learningDb)
        const existing = await learningDb.prepare(`
          SELECT status, artifacts_written, summary_json
            FROM s12_tw_calibration_runs
           WHERE run_id=? AND run_date=? AND cadence=?
        `).bind(canonicalRunId, runDate, cadence).first<{
          status?: string | null
          artifacts_written?: number | string | null
          summary_json?: string | null
        }>()
        let replaceExistingRunArtifacts = false
        if (existing) {
          const artifactRows = await learningDb.prepare(`
            SELECT artifact_id
              FROM s12_tw_calibration_artifacts
             WHERE run_id=?
             ORDER BY artifact_id
          `).bind(canonicalRunId).all<{ artifact_id?: string | null }>()
          const artifactIds = (artifactRows.results ?? [])
            .map((row) => String(row.artifact_id ?? ''))
            .filter(Boolean)
          const expectedArtifacts = Math.max(0, Number(existing.artifacts_written ?? 0))
          if (artifactIds.length === expectedArtifacts) {
            return {
              summary: `s12_tw_calibration idempotent run_id=${canonicalRunId} status=${existing.status ?? 'completed'} written=${expectedArtifacts}`,
              receipt: {
                status: existing.status ?? 'completed',
                cadence,
                written: expectedArtifacts,
                artifact_ids: artifactIds,
                artifact_count_parity: true,
                idempotent: true,
                canonical_run_id: canonicalRunId,
              },
            }
          }
          replaceExistingRunArtifacts = true
          console.warn(
            `[S12 calibration] incomplete canonical receipt will be atomically rebuilt run_id=${canonicalRunId} expected=${expectedArtifacts} actual=${artifactIds.length}`,
          )
        }
        const lifecycleCensoring = await inspectS12TwCalibrationLifecycleCensoring(
          learningDb,
          runDate,
          cadence,
        )
        if (lifecycleCensoring.recentEnqueuedRows > 0) {
          const holderDates = lifecycleCensoring.recentEnqueuedDates.join(',') || 'unknown'
          return {
            skipped: true,
            reason: `maintenance_lease_busy:s12-replay-lifecycle:${holderDates}`,
            leaseGroup: 's12:research-market-data',
            holderTaskName: 's12-replay-backfill',
            holderOwnerId: `replay-lifecycle-enqueued:${holderDates}`,
            leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          }
        }
        if (lifecycleCensoring.staleEnqueuedRows > 0 || lifecycleCensoring.missingOrOtherRows > 0) {
          console.warn(
            '[S12 calibration] excluded non-terminal replay lifecycle evidence '
            + JSON.stringify({
              stale_enqueued_rows: lifecycleCensoring.staleEnqueuedRows,
              stale_enqueued_dates: lifecycleCensoring.staleEnqueuedDates,
              missing_or_other_rows: lifecycleCensoring.missingOrOtherRows,
              missing_or_other_dates: lifecycleCensoring.missingOrOtherDates,
            }),
          )
        }
        const result = await runS12TwCalibration(learningDb, {
          runDate,
          cadence,
          dryRun: false,
          replaceExistingRunArtifacts,
          lifecycleCensoring,
          beforeCommit: () => assertS12ResearchLeaseRenewed(opsDb, researchLeaseRunId),
        })
        return {
          summary: result.summary,
          receipt: {
            status: result.status,
            cadence,
            written: result.written,
            artifact_ids: result.artifacts.map((artifact) => artifact.artifactId),
            idempotent: false,
            canonical_run_id: canonicalRunId,
          },
        }
        } finally {
          await releaseS12ResearchLease(opsDb, researchLeaseRunId)
        }
      },
    })
    return leased
  }
  return {
    summary: summarizeMaintenanceLeaseResult(await runWithMaintenanceLease(databaseForDataDomain(env, 'ops'), {
      taskName: 'weekly-cleanup',
      leaseGroup: 'd1_heavy_maintenance',
      leaseSeconds: 300,
      run: () => runWeeklyCleanupClosure(env),
    })),
  }
}

export async function processDurableSchedulerTask(
  msg: UpdateQueueMsg,
  env: Bindings,
  options: { runTask?: DurableSchedulerTaskRunner } = {},
): Promise<void> {
  const task = msg.scheduledTask
  if (task !== 'external-evidence' && task !== 'weekly-cleanup' && task !== 's12-smcvwap-calibration') {
    throw new Error(`unsupported durable scheduler task: ${String(task)}`)
  }
  const runDate = msg.triggerTime
  const runId = msg.runId || `${task}-${Date.now()}`
  const startedAt = Date.now()
  const ticketDb = databaseForDataDomain(env, 'ops')
  const updateTicket = async (
    status: SchedulerExecutionTicketStatus,
    summary: string,
    error?: string,
  ): Promise<void> => {
    if (!msg.schedulerTicketId) return
    await updateSchedulerExecutionTicket(ticketDb, {
      ticketId: msg.schedulerTicketId,
      runId,
      status,
      authority: 'durable_queue',
      summary,
      error,
    })
  }

  try {
    await updateTicket('running', 'durable queue consumer started')
    const taskResult = await (options.runTask ?? runDurableTask)(task, env, runDate)
    if (isMaintenanceLeaseBusy(taskResult)) {
      const opsDb = databaseForDataDomain(env, 'ops')
      const recovery = await scheduleDurableTaskLeaseRecovery(
        opsDb,
        env.UPDATE_QUEUE,
        { ...msg, runId },
        taskResult,
      )
      if (recovery.reason === 'attempt_limit') {
        const result = {
          status: 'error' as const,
          summary: [
            'durable_recovery_exhausted',
            taskResult.reason,
            `owner=${taskResult.holderOwnerId}`,
            `attempt=${recovery.attempt}/${DURABLE_TASK_RECOVERY_MAX_ATTEMPTS}`,
          ].join(' '),
          duration_ms: Date.now() - startedAt,
          run_id: runId,
          run_date: runDate,
          error: 'bounded durable lease recovery exhausted',
        }
        await updateTicket('error', result.summary, result.error)
        await logSchedulerResult(env.KV, task, result, env)
        await putManualRunLog(env.KV, task, runId, result)
        await releaseDurableTaskRecoveryFence(opsDb, msg, runId)
        return
      }
      const result = {
        status: 'running' as const,
        summary: [
          'durable_duplicate_ack',
          taskResult.reason,
          `owner=${taskResult.holderOwnerId}`,
          `recovery=${recovery.reason}`,
          `attempt=${recovery.attempt}/${DURABLE_TASK_RECOVERY_MAX_ATTEMPTS}`,
          `delay_seconds=${recovery.delaySeconds ?? 'none'}`,
        ].join(' '),
        duration_ms: Date.now() - startedAt,
        run_id: runId,
        run_date: runDate,
      }
      await updateTicket('running', result.summary)
      await logSchedulerResult(env.KV, task, result, env)
      await putManualRunLog(env.KV, task, runId, result)
      if (recovery.reason !== 'deduplicated') {
        await releaseDurableTaskRecoveryFence(opsDb, msg, runId)
      }
      return
    }
    const status = classifySchedulerSummary(taskResult.summary)
    const result = {
      status,
      summary: taskResult.summary,
      details: taskResult.receipt
        ? ['materialization_receipt=' + JSON.stringify(taskResult.receipt)]
        : undefined,
      duration_ms: Date.now() - startedAt,
      run_id: runId,
      run_date: runDate,
    } as const
    await updateTicket(schedulerTicketStatusForRunLog(status), result.summary)
    await logSchedulerResult(env.KV, task, result, env)
    await putManualRunLog(env.KV, task, runId, { ...result, ...taskResult })
    if (status === 'success') {
      await putTerminalReceipt(env.KV, task, runDate, runId, taskResult)
    }
    await releaseDurableTaskRecoveryFence(databaseForDataDomain(env, 'ops'), msg, runId)
  } catch (error) {
    const recoveryEnqueueRetry = error instanceof DurableTaskRecoveryEnqueueError
    const message = error instanceof Error ? error.message : String(error)
    const result = {
      status: recoveryEnqueueRetry ? 'running' as const : 'error' as const,
      summary: recoveryEnqueueRetry ? `durable_recovery_enqueue_retry ${message}` : message,
      duration_ms: Date.now() - startedAt,
      run_id: runId,
      run_date: runDate,
      error: String(error),
    }
    await updateTicket(recoveryEnqueueRetry ? 'running' : 'error', result.summary, recoveryEnqueueRetry ? undefined : result.error)
    await logSchedulerResult(env.KV, task, result, env)
    await putManualRunLog(env.KV, task, runId, result)
    throw error
  }
}
