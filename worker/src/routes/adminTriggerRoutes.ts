import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { resolveEveningWatchdogBusinessDate } from '../lib/eveningWatchdogBusinessDate'
import { resolveActive8DailyBusinessDate } from '../lib/active8DailyBusinessDate'
import { requireServiceToken } from '../lib/auth'
import type { Bindings, Variables } from '../types'
import type { SchedulerCallbackContext, TaskHandler } from '../lib/adminTriggerTaskMap'
import { resolveNextTwSessionClosure, shouldRunScheduledTask } from '../lib/schedulerPolicy'
import { databaseForDataDomain } from '../lib/dataDomainRegistry'
import {
  admitSchedulerExecutionTicket,
  schedulerDeliveryIdentity,
  schedulerTicketStatusForRunLog,
  settleSchedulerHttpTicket,
  updateSchedulerExecutionTicket,
  type SchedulerExecutionTicketAuthority,
  type SchedulerTicketAdmission,
  type SchedulerExecutionTicketStatus,
} from '../lib/schedulerExecutionTickets'

interface TriggerRouteDeps {
  buildTaskMap: (c: any, schedulerContext?: SchedulerCallbackContext) => Record<string, TaskHandler>
}

const SCHEDULER_TASK_ALIASES: Record<string, string> = {
  'model-ic-tracker': 'model-ic-full-check',
}

export function resolveSchedulerTaskAlias(task: string): string {
  return SCHEDULER_TASK_ALIASES[task] ?? task
}
const SYNC_REQUIRED_TASKS = new Set([
  'evening-chain',
  'market-close-refresh',
  'daily-execution-paper-lineage',
  'paired-native-execution',
  'update', 'pipeline', 'post-screener-pipeline',
  'intraday-rescore',
  'alpha-quality', 'sector-leaders', 'optuna-queue',
  'weekly-backtest',
  'weekly-drift-retrain',
  'weekly-readiness', 'monthly-readiness',
  'model-ic-full-check',
  'weekly-optuna', 'adaptive-meta-policy-replay', 'linucb-multiplier-replay',
  'l4-alpha-ev-refresh', 'allocator-ev-fusion-refresh', 'opb-arm-prior-refresh',
  'allocator-ev-feature-snapshot-backfill',
  'monthly-optuna', 'monthly-l4-alpha-ev-refresh', 'monthly-allocator-ev-fusion-refresh', 'monthly-opb-arm-prior-refresh', 'monthly-strategy-mining',
  'finlab-v4-backfill',
  'finlab-backfill-watchdog',
  'indicator-queue-watchdog',
  'allocator-ev-readiness',
  'allocator-ev-lifecycle-watchdog',
  'active8-oof-lifecycle', 'active8-oof-daily', 'active8-oof-weekly', 'active8-oof-monthly',
  'strategy-learning', 'strategy-learning-finalize',
  'selection-reference-repair', 'selection-reference-identity-repair',
  's12-research-recovery',
  's12-replay-backfill',
  'audit-json-retention',
  'retention-archive-only',
  'retention-hot-window-drain',
  'legacy-evidence-migration', 'legacy-strategy-evidence-migration', 'legacy-hot-data-retirement', 'artifact-reconcile', 'd1-evidence-scrub', 'r2-retention-sweep',
  'orphan-reachability-gc', 'cleanup-dlq-replay', 'storage-health-check', 'storage-health-gate',
  'storage-integrity-audit', 'storage-capacity-report',
  'learning-retention-readiness', 'legacy-learning-deletion-readiness',
  'data-domain-shadow-backfill',
  'data-domain-shadow-backfill-next',
  'data-domain-control-revision-trigger-install',
  'data-domain-writer-epoch-trigger-install',
  'data-domain-cutover-probe',
  'strategy-evidence-metrics',
  'strategy-evidence-owner-calibration',
])

function isDurableQueueTask(task: string): task is 'external-evidence' | 'weekly-cleanup' | 's12-smcvwap-calibration' {
  return task === 'external-evidence' || task === 'weekly-cleanup' || task === 's12-smcvwap-calibration'
}

function buildRunId(task: string): string {
  const suffix = Math.random().toString(36).slice(2, 10)
  return `${task}-${Date.now()}-${suffix}`
}

async function putRunLog(
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

export function createAdminTriggerRoutes(deps: TriggerRouteDeps) {
  const routes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

  routes.get('/api/admin/historical-lineage-boundary', async (c) => {
    const authError = await requireServiceToken(c)
    if (authError) return authError

    const task = c.req.query('task') || 'pipeline'
    const signalDate = c.req.query('date') || ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(signalDate)) {
      return c.json({ success: false, error: 'date must be YYYY-MM-DD' }, 400)
    }
    const {
      HISTORICAL_CANONICAL_LINEAGE_WRITER_TASKS,
      historicalLearningLineageDecision,
    } = await import('../lib/historicalLearningLineageGuard')
    if (!HISTORICAL_CANONICAL_LINEAGE_WRITER_TASKS.has(task)) {
      return c.json({ success: false, error: `unsupported historical lineage task: ${task}` }, 400)
    }
    const boundary = await historicalLearningLineageDecision(databaseForDataDomain(c.env, 'market'), c.env.KV, task, signalDate)
    return c.json({
      success: true,
      schema_version: 'historical-learning-lineage-boundary-v1',
      calendar_owner: 'worker.schedulerPolicy.nextTwTradingDate',
      boundary,
    })
  })

  routes.post('/api/admin/trigger/:task', async (c) => {
    const authError = await requireServiceToken(c)
    if (authError) return authError

    const requestedTask = c.req.param('task')
    const task = resolveSchedulerTaskAlias(requestedTask)
    const maintenanceBackfill = task === 'data-domain-shadow-backfill'
    const minuteTask = task === 'intraday-check' || task === 'paired-native-execution' || task === 'strategy-nav-execution'
    const rateLimitNamespace = maintenanceBackfill
      ? 'admin-maintenance:data-domain-shadow-backfill'
      : minuteTask ? `admin-minute:${task}` : 'admin'
    const rateLimit = maintenanceBackfill ? 500 : minuteTask ? 90 : 100
    const rlKey = `ratelimit:${rateLimitNamespace}:${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 13)}`
    let requestedRunDate = c.req.query('date') || undefined
    const schedulerContext: SchedulerCallbackContext = {}
    const taskMap = deps.buildTaskMap(c, schedulerContext)
    const fn = taskMap[task]
    if (!fn) return c.json({ error: `Unknown task: ${task}`, available: Object.keys(taskMap) }, 400)

    const ticketDb = databaseForDataDomain(c.env, 'ops')
    let ticketAdmission: SchedulerTicketAdmission
    try {
      requestedRunDate = await resolveEveningWatchdogBusinessDate(c.env, task, requestedRunDate)
      requestedRunDate = await resolveActive8DailyBusinessDate(c.env, task, requestedRunDate)
      schedulerContext.businessDate = requestedRunDate
      ticketAdmission = await admitSchedulerExecutionTicket(ticketDb, {
        identity: schedulerDeliveryIdentity(c.req.raw.headers),
        task,
        requestedRunDate,
        proposedRunId: buildRunId(task),
        metadata: { requested_task: requestedTask },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const identityConflict = message.includes('Cloud Scheduler') || message.includes('unmanaged Cloud Scheduler')
      return c.json(
        { success: false, error: `scheduler ticket admission failed: ${message}` },
        identityConflict ? 409 : 503,
      )
    }
    const executionRunId = ticketAdmission.ticket.run_id
    const schedulerTicketId = ticketAdmission.ticket.ticket_id
    schedulerContext.schedulerTicketId = schedulerTicketId
    schedulerContext.schedulerRunId = executionRunId
    if (task === 'audit-json-retention') schedulerContext.businessDate = ticketAdmission.ticket.business_date
    const updateTicket = (
      status: SchedulerExecutionTicketStatus,
      authority: SchedulerExecutionTicketAuthority,
      summary?: string,
      error?: string,
    ) => updateSchedulerExecutionTicket(ticketDb, {
      ticketId: schedulerTicketId,
      runId: executionRunId,
      status,
      authority,
      summary,
      error,
    })
    // FU17: post-execution result. A blocked result keeps a ticket its owner already triggered; true
    // then means the owner keeps the ticket and its scheduler run log, so the caller skips that log.
    const settleTicket = async (status: SchedulerExecutionTicketStatus, summary: string): Promise<boolean> => {
      const settled = await settleSchedulerHttpTicket(ticketDb, { ticketId: schedulerTicketId, runId: executionRunId, status, summary })
      return status === 'blocked' && settled.status === 'triggered'
    }
    if (!ticketAdmission.shouldExecute) {
      const terminal = ['success', 'error', 'skipped', 'blocked'].includes(ticketAdmission.ticket.status)
      const response = {
        success: ticketAdmission.ticket.status === 'success' || ticketAdmission.ticket.status === 'skipped',
        duplicate: true,
        reason: ticketAdmission.reason,
        task,
        run_id: executionRunId,
        ticket_id: schedulerTicketId,
        ticket_status: ticketAdmission.ticket.status,
      }
      return terminal ? c.json(response, 200) : c.json(response, 202)
    }

    const rlCount = parseInt((await c.env.KV.get(rlKey)) ?? '0', 10)
    if (rlCount >= rateLimit) {
      const summary = `rate limit exceeded (${rateLimit}/hr)`
      await updateTicket('blocked', 'scheduler_http', summary, summary)
      return c.json({ success: false, error: summary, ticket_id: schedulerTicketId }, 429)
    }
    await c.env.KV.put(rlKey, String(rlCount + 1), { expirationTtl: 3600 })

    if (requestedRunDate) {      const {
        historicalLearningLineageBlockedMessage,
        historicalLearningLineageDecision,
      } = await import('../lib/historicalLearningLineageGuard')
      const lineageBoundary = await historicalLearningLineageDecision(databaseForDataDomain(c.env, 'market'), c.env.KV, task, requestedRunDate)
      if (!lineageBoundary.allowed) {
        await updateTicket('blocked', 'scheduler_http', 'historical learning lineage boundary blocked')
        return c.json({
          success: false,
          error: historicalLearningLineageBlockedMessage(lineageBoundary),
          boundary: lineageBoundary,
        }, 409)
      }
    }

    const {
      classifySchedulerSummary, logSchedulerResult, redactSchedulerRunText, schedulerRunLogSummary,
    } = await import('../lib/schedulerRunLogger')
    if (!c.req.query('force')) {
      const decision = await shouldRunScheduledTask({ task, kv: c.env.KV, checkAdHocClosure: true, alertEnv: c.env })
      if (!decision.shouldRun) {
        const summary = `skipped by scheduler policy: ${decision.reason}`
        await updateTicket('skipped', 'scheduler_http', summary)
        await logSchedulerResult(c.env.KV, task, { status: 'skipped', summary, duration_ms: 0, run_date: requestedRunDate })
        return c.json({
          success: true,
          skipped: true,
          task,
          tw_date: decision.twDate,
          policy: decision.policy.kind,
          reason: decision.reason,
          message: `${task} ${summary}`,
        })
      }
      if (task === 'evening-chain') {
        // A closure announced tonight for the next session must be on record
        // before the chain resolves its target trading date.
        await resolveNextTwSessionClosure(c.env.KV, decision.twDate, c.env)
          .catch((error) => console.error('[evening-chain] next-session closure check failed:', error))
      }
    }

    const { inspectStorageAdmission } = await import('../lib/storageAdmissionControl')
    const storageAdmission = await inspectStorageAdmission(c.env, task)
    if (!storageAdmission.allowed) {
      const summary = `blocked by storage admission: ${storageAdmission.reason} utilization=${storageAdmission.utilizationPct ?? 'unknown'}%`
      if (task === 'optuna-queue') {
        await updateTicket('skipped', 'scheduler_http', summary)
        await logSchedulerResult(c.env.KV, task, {
          status: 'skipped',
          summary,
          duration_ms: 0,
          run_date: requestedRunDate,
        }, c.env as any)
        return c.json({
          success: true,
          skipped: true,
          task,
          reason: summary,
          storage_admission: storageAdmission,
        })
      }
      await updateTicket('blocked', 'scheduler_http', summary, summary)
      await logSchedulerResult(c.env.KV, task, {
        status: 'error',
        summary,
        duration_ms: 0,
        run_date: requestedRunDate,
        strict: true,
      }, c.env as any)
      return c.json({
        success: false,
        error: summary,
        storage_admission: storageAdmission,
      }, 507)
    }

    const syncMode = c.req.query('sync') === '1'
    if (task === 's12-smcvwap-calibration' && syncMode) {
      await updateTicket('blocked', 'scheduler_http', 's12 calibration sync bypass is forbidden')
      return c.json({
        success: false,
        error: 's12 calibration requires durable queue execution; sync bypass is forbidden',
      }, 409)
    }
    if (SYNC_REQUIRED_TASKS.has(task) && !syncMode) {
      await updateTicket('blocked', 'scheduler_http', `${task} requires sync=1`)
      return c.json({
        success: false,
        error: `${task} requires sync=1 so Scheduler can observe data-readiness failures`,
      }, 409)
    }

    const longRunning = new Set([
      'pipeline',
      'evening-chain',
      'market-close-refresh',
      'ml',
      'update',
      'ml-warmup',
      'recommendation',
      'screener',
      'intraday-rescore',
      'backtest',
      'weekly-backtest',
      'weekly-drift-retrain',
      'monte-carlo',
      'pbo',
      'alpha-quality',
      'finlab-v4-backfill',
      'finlab-backfill-watchdog',
      'indicator-queue-watchdog',
      'allocator-ev-lifecycle-watchdog',
  'active8-oof-lifecycle', 'active8-oof-daily', 'active8-oof-weekly', 'active8-oof-monthly',
      'strategy-learning',
      's12-smcvwap-calibration',
      's12-research-recovery',
      's12-replay-backfill',
      'audit-json-retention',
      'retention-archive-only',
      'retention-hot-window-drain',
      'artifact-reconcile',
      'legacy-evidence-migration',
      'legacy-strategy-evidence-migration',
      'legacy-hot-data-retirement',
      'd1-evidence-scrub',
      'r2-retention-sweep',
      'orphan-reachability-gc',
      'cleanup-dlq-replay',
      'storage-health-check',
      'storage-health-gate',
      'storage-integrity-audit',
      'storage-capacity-report',
      'learning-retention-readiness',
      'legacy-learning-deletion-readiness',
      'data-domain-shadow-backfill',
      'data-domain-writer-epoch-trigger-install',
      'weekly-optuna',
      'l4-alpha-ev-refresh',
      'allocator-ev-fusion-refresh',
      'opb-arm-prior-refresh',
      'allocator-ev-feature-snapshot-backfill',
      'monthly-optuna',
      'monthly-l4-alpha-ev-refresh',
      'monthly-allocator-ev-fusion-refresh',
      'monthly-opb-arm-prior-refresh',
      'monthly-strategy-mining',
      'weekly-cleanup',
      'weekly-readiness',
      'monthly-readiness',
      'optuna-queue',
      'external-evidence',
      'strategy-learning-finalize',
      'selection-reference-repair',
      'selection-reference-identity-repair',
      'adaptive-meta-policy-replay',
      'linucb-multiplier-replay',
      'neural-ucb-shadow',
      'neural-ts-shadow',
      'neucb-shadow',
    ])

    if (longRunning.has(task) && !syncMode) {
      const t0 = Date.now()
      const runId = executionRunId
      const durableQueue = isDurableQueueTask(task)
      await updateTicket(
        durableQueue ? 'queued' : 'running',
        durableQueue ? 'durable_queue' : 'scheduler_http',
        'accepted by admin trigger',
      )
      await logSchedulerResult(c.env.KV, task, {
        status: 'running',
        summary: `started (background) run_id=${runId}`,
        duration_ms: 0,
        run_id: runId,
        run_date: requestedRunDate,
        strict: true,
      })
      await putRunLog(c.env.KV, task, runId, {
        status: 'running',
        summary: 'started (background)',
        duration_ms: 0,
        run_date: requestedRunDate,
      })
      // HTTP waitUntil is capped after response; these 100s+ tasks require the 15-minute Queue consumer owner.
      if (durableQueue) {
        const runDate = requestedRunDate ?? twToday()
        try {
          await c.env.UPDATE_QUEUE.send({
            type: 'scheduled_admin_task',
            scheduledTask: task,
            cursor: 0,
            triggerTime: runDate,
            runId,
            schedulerTicketId,
          })
        } catch (error) {
          const summary = error instanceof Error ? error.message : String(error)
          await updateTicket('error', 'durable_queue', `durable queue enqueue failed: ${summary}`, summary)
          await logSchedulerResult(c.env.KV, task, {
            status: 'error',
            summary: `durable queue enqueue failed: ${summary}`,
            duration_ms: Date.now() - t0,
            run_id: runId,
            run_date: runDate,
            strict: true,
          }, c.env as any)
          await putRunLog(c.env.KV, task, runId, {
            status: 'error',
            summary: `durable queue enqueue failed: ${summary}`,
            duration_ms: Date.now() - t0,
            run_date: runDate,
          })
          return c.json({
            success: false,
            error: `durable queue enqueue failed: ${summary}`,
            task,
            run_id: runId,
            ticket_id: schedulerTicketId,
          }, 503)
        }
        return c.json({
          success: true,
          message: `${task} queued for durable execution`,
          triggered_at: new Date().toISOString(),
          mode: 'durable_queue',
          run_id: runId,
          run_date: runDate,
          ticket_id: schedulerTicketId,
        }, 202)
      }

      c.executionCtx.waitUntil((async () => {
        try {
          const result = await fn()
          const summary = typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 200) ?? ''
          const logSummary = schedulerRunLogSummary(result, c.env)
          const status = classifySchedulerSummary(summary)
          // Maintenance's queue owns its ticket from admission through terminal receipt.
          const maintenanceOwned = task === 'audit-json-retention' && /\bmaintenance_owner=durable_queue\b/.test(summary)
          const ownerKept = !maintenanceOwned && await settleTicket(schedulerTicketStatusForRunLog(status), summary)
          if (!maintenanceOwned && !ownerKept && !await finLabOwnsRunLog(c.env, task, requestedRunDate, summary)) await logSchedulerResult(c.env.KV, task, {
            status,
            summary: logSummary,
            duration_ms: Date.now() - t0,
            run_id: finLabRunLogId(task, summary) ?? runId,
            run_date: requestedRunDate,
          })
          if (!maintenanceOwned) await putRunLog(c.env.KV, task, runId, {
            status,
            summary: logSummary,
            duration_ms: Date.now() - t0,
            run_date: requestedRunDate,
          })
        } catch (e: any) {
          await updateTicket('error', 'scheduler_http',
            redactSchedulerRunText(e?.message ?? 'Unknown error', c.env), redactSchedulerRunText(String(e), c.env))
          await logSchedulerResult(
            c.env.KV,
            task,
            {
              status: 'error',
              summary: e?.message ?? 'Unknown error',
              duration_ms: Date.now() - t0,
              run_id: runId,
              error: String(e),
              run_date: requestedRunDate,
            },
            c.env as any,
          )
          await putRunLog(c.env.KV, task, runId, {
            status: 'error',
            summary: redactSchedulerRunText(e?.message ?? 'Unknown error', c.env),
            duration_ms: Date.now() - t0,
            error: redactSchedulerRunText(String(e), c.env),
            run_date: requestedRunDate,
          })
        }
      })())
      return c.json({
        success: true,
        message: `${task} 已改為背景執行，請查看 scheduler run log`,
        triggered_at: new Date().toISOString(),
        mode: 'async',
        run_id: runId,
        ticket_id: schedulerTicketId,
      }, 202)
    }

    const t0 = Date.now()
    const syncRunId = executionRunId
    await updateTicket('running', 'scheduler_http', 'sync execution started')
    try {
      const result = await fn()
      const summary = typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 200) ?? ''
      const logSummary = schedulerRunLogSummary(result, c.env)
      const status = classifySchedulerSummary(summary)
      const maintenanceOwned = task === 'audit-json-retention' && /\bmaintenance_owner=durable_queue\b/.test(summary)
      const ownerKept = !maintenanceOwned && await settleTicket(schedulerTicketStatusForRunLog(status), summary)
      if (!maintenanceOwned && !ownerKept && !await finLabOwnsRunLog(c.env, task, requestedRunDate, summary)) await logSchedulerResult(c.env.KV, task, {
        status,
        summary: logSummary,
        duration_ms: Date.now() - t0,
        run_id: finLabRunLogId(task, summary) ?? syncRunId,
        run_date: requestedRunDate,
        strict: task === 'data-domain-shadow-backfill-next',
      })
      return c.json({
        success: task === 'audit-json-retention' ? status !== 'error' : true,
        message: maintenanceOwned ? `${task} queued; completion pending` : task === 'audit-json-retention' ? `${task} status=${status}` : `${task} 執行成功`,
        triggered_at: new Date().toISOString(),
        result,
        run_id: syncRunId,
        ticket_id: schedulerTicketId,
      }, maintenanceOwned ? 202 : 200)
    } catch (e: any) {
      await updateTicket('error', 'scheduler_http',
        redactSchedulerRunText(e?.message ?? 'Unknown error', c.env), redactSchedulerRunText(String(e), c.env))
      await logSchedulerResult(
        c.env.KV,
        task,
        {
          status: 'error',
          summary: e?.message ?? 'Unknown error',
          duration_ms: Date.now() - t0,
          run_id: syncRunId,
          error: String(e),
          run_date: requestedRunDate,
        },
        c.env as any,
      )
      return c.json({ success: false, message: `${task} 執行失敗`, error: e.message, run_id: syncRunId, ticket_id: schedulerTicketId }, 500)
    }
  })

  routes.get('/api/admin/trigger-health', async (c) => {
    const authError = await requireServiceToken(c)
    if (authError) return authError
    return c.json({ ok: true, date: twToday() })
  })

  return routes
}

/** R8-a: a manual FinLab dispatch left unconfirmed by an HTML 5xx never overwrites a start heartbeat that already arrived. */
/**
 * The FinLab flow keeps its own run log when (a) a start heartbeat already superseded an unconfirmed
 * dispatch, or (b) a root run was suppressed because the late-lane watchdog owns tonight's chain (C28-25).
 */
async function finLabOwnsRunLog(env: Bindings, task: string, runDate: string | undefined, summary: string): Promise<boolean> {
  const { FINLAB_LATE_LANE_WATCHDOG_OWNER, finLabDispatchSupersededByStart } = await import('../lib/updateOrchestrator')
  if (summary.includes(FINLAB_LATE_LANE_WATCHDOG_OWNER)) return true
  if (task !== 'finlab-v4-backfill') return false
  return finLabDispatchSupersededByStart(env, runDate, summary)
}

/** The FinLab scheduler log is keyed by the FinLab run_id (the watchdog resend and the callback fence read it), not the ticket id. */
function finLabRunLogId(task: string, summary: string): string | null {
  return task === 'finlab-v4-backfill' ? summary.match(/(?:^|\s)run_id=([^\s;]+)/)?.[1] ?? null : null
}
