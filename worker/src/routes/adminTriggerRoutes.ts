import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireServiceToken } from '../lib/auth'
import type { Bindings, Variables } from '../types'
import type { TaskHandler } from '../lib/adminTriggerTaskMap'
import { shouldRunScheduledTask } from '../lib/schedulerPolicy'

interface TriggerRouteDeps {
  buildTaskMap: (c: any) => Record<string, TaskHandler>
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
  'update', 'pipeline', 'post-screener-pipeline',
  'intraday-rescore',
  'alpha-quality', 'sector-leaders', 'optuna-queue',
  'weekly-backtest',
  'weekly-readiness', 'monthly-readiness',
  'model-ic-full-check',
  'weekly-optuna', 'adaptive-meta-policy-replay', 'linucb-multiplier-replay',
  'l4-alpha-ev-refresh', 'allocator-ev-fusion-refresh', 'opb-arm-prior-refresh',
  'allocator-ev-feature-snapshot-backfill',
  'monthly-optuna', 'monthly-l4-alpha-ev-refresh', 'monthly-allocator-ev-fusion-refresh', 'monthly-opb-arm-prior-refresh', 'monthly-strategy-mining', 'weekly-drift-retrain',
  'finlab-v4-backfill',
  'finlab-backfill-watchdog',
  'allocator-ev-readiness',
  'allocator-ev-lifecycle-watchdog',
  'active8-oof-lifecycle', 'active8-oof-daily', 'active8-oof-weekly', 'active8-oof-monthly',
  'strategy-learning', 'strategy-learning-finalize',
  'selection-reference-repair', 'selection-reference-identity-repair',
  's12-smcvwap-calibration',
  's12-research-recovery',
  's12-replay-backfill',
  'audit-json-retention',
  'legacy-evidence-migration', 'legacy-strategy-evidence-migration', 'legacy-hot-data-retirement', 'artifact-reconcile', 'd1-evidence-scrub', 'r2-retention-sweep',
  'orphan-reachability-gc', 'cleanup-dlq-replay', 'storage-health-check', 'storage-health-gate',
  'storage-integrity-audit', 'storage-capacity-report',
  'data-domain-shadow-backfill',
  'data-domain-shadow-backfill-next',
  'monthly-retrain',
])

function isDurableQueueTask(task: string): task is 'external-evidence' | 'weekly-cleanup' {
  return task === 'external-evidence' || task === 'weekly-cleanup'
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
    const boundary = await historicalLearningLineageDecision(c.env.DB, c.env.KV, task, signalDate)
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

    const rlKey = `ratelimit:admin:${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 13)}`
    const rlCount = parseInt((await c.env.KV.get(rlKey)) ?? '0', 10)
    if (rlCount >= 100) return c.json({ error: 'Rate limit exceeded (100/hr)' }, 429)
    await c.env.KV.put(rlKey, String(rlCount + 1), { expirationTtl: 3600 })

    const requestedTask = c.req.param('task')
    const task = resolveSchedulerTaskAlias(requestedTask)
    const requestedRunDate = c.req.query('date') || undefined
    const taskMap = deps.buildTaskMap(c)
    const fn = taskMap[task]
    if (!fn) return c.json({ error: `Unknown task: ${task}`, available: Object.keys(taskMap) }, 400)

    if (requestedRunDate) {
      const {
        historicalLearningLineageBlockedMessage,
        historicalLearningLineageDecision,
      } = await import('../lib/historicalLearningLineageGuard')
      const lineageBoundary = await historicalLearningLineageDecision(c.env.DB, c.env.KV, task, requestedRunDate)
      if (!lineageBoundary.allowed) {
        return c.json({
          success: false,
          error: historicalLearningLineageBlockedMessage(lineageBoundary),
          boundary: lineageBoundary,
        }, 409)
      }
    }

    const { classifySchedulerSummary, logSchedulerResult } = await import('../lib/schedulerRunLogger')
    if (!c.req.query('force')) {
      const decision = await shouldRunScheduledTask({ task, kv: c.env.KV })
      if (!decision.shouldRun) {
        const summary = `skipped by scheduler policy: ${decision.reason}`
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
    }

    const { inspectStorageAdmission } = await import('../lib/storageAdmissionControl')
    const storageAdmission = await inspectStorageAdmission(c.env, task)
    if (!storageAdmission.allowed) {
      const summary = `blocked by storage admission: ${storageAdmission.reason} utilization=${storageAdmission.utilizationPct ?? 'unknown'}%`
      if (task === 'optuna-queue') {
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
    if (SYNC_REQUIRED_TASKS.has(task) && !syncMode) {
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
      'monte-carlo',
      'pbo',
      'alpha-quality',
      'finlab-v4-backfill',
      'finlab-backfill-watchdog',
      'allocator-ev-lifecycle-watchdog',
  'active8-oof-lifecycle', 'active8-oof-daily', 'active8-oof-weekly', 'active8-oof-monthly',
      'strategy-learning',
      's12-smcvwap-calibration',
      's12-research-recovery',
      's12-replay-backfill',
      'audit-json-retention',
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
      'data-domain-shadow-backfill',
      'weekly-optuna',
      'l4-alpha-ev-refresh',
      'allocator-ev-fusion-refresh',
      'opb-arm-prior-refresh',
      'allocator-ev-feature-snapshot-backfill',
      'weekly-drift-retrain',
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
      'retrain',
      'monthly-retrain',
      'adaptive-meta-policy-replay',
      'linucb-multiplier-replay',
      'neural-ucb-shadow',
      'neural-ts-shadow',
      'neucb-shadow',
    ])

    if (longRunning.has(task) && !syncMode) {
      const t0 = Date.now()
      const runId = buildRunId(task)
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
      if (isDurableQueueTask(task)) {
        const runDate = requestedRunDate ?? twToday()
        try {
          await c.env.UPDATE_QUEUE.send({
            type: 'scheduled_admin_task',
            scheduledTask: task,
            cursor: 0,
            triggerTime: runDate,
            runId,
          })
        } catch (error) {
          const summary = error instanceof Error ? error.message : String(error)
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
          }, 503)
        }
        return c.json({
          success: true,
          message: `${task} queued for durable execution`,
          triggered_at: new Date().toISOString(),
          mode: 'durable_queue',
          run_id: runId,
          run_date: runDate,
        }, 202)
      }

      c.executionCtx.waitUntil((async () => {
        try {
          const result = await fn()
          const summary = typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 200) ?? ''
          await logSchedulerResult(c.env.KV, task, {
            status: classifySchedulerSummary(summary),
            summary,
            duration_ms: Date.now() - t0,
            run_id: runId,
            run_date: requestedRunDate,
          })
          await putRunLog(c.env.KV, task, runId, {
            status: classifySchedulerSummary(summary),
            summary,
            duration_ms: Date.now() - t0,
            run_date: requestedRunDate,
          })
        } catch (e: any) {
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
            summary: e?.message ?? 'Unknown error',
            duration_ms: Date.now() - t0,
            error: String(e),
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
      }, 202)
    }

    const t0 = Date.now()
    const syncRunId = buildRunId(task)
    try {
      const result = await fn()
      const summary = typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 200) ?? ''
      await logSchedulerResult(c.env.KV, task, {
        status: classifySchedulerSummary(summary),
        summary,
        duration_ms: Date.now() - t0,
        run_id: syncRunId,
        run_date: requestedRunDate,
      })
      return c.json({ success: true, message: `${task} 執行成功`, triggered_at: new Date().toISOString(), result })
    } catch (e: any) {
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
      return c.json({ success: false, message: `${task} 執行失敗`, error: e.message }, 500)
    }
  })

  routes.get('/api/admin/trigger-health', async (c) => {
    const authError = await requireServiceToken(c)
    if (authError) return authError
    return c.json({ ok: true, date: twToday() })
  })

  return routes
}
