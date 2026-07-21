import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireServiceToken } from '../lib/auth'
import type { Bindings, Variables } from '../types'
import type { TaskHandler } from '../lib/adminTriggerTaskMap'
import { shouldRunScheduledTask } from '../lib/schedulerPolicy'
import { getSchedulerBatch, resolveDueSchedulerBatchJobs } from '../lib/schedulerBatchPlan'
import { D1SchedulerBatchLeaseStore, dispatchSchedulerBatch, normalizeSchedulerBatchSlot } from '../lib/schedulerBatchDispatcher'

interface TriggerRouteDeps {
  buildTaskMap: (c: any) => Record<string, TaskHandler>
}

const SYNC_REQUIRED_TASKS = new Set([
  'evening-chain',
  'market-close-refresh',
  'update', 'pipeline', 'post-screener-pipeline',
  'intraday-rescore',
  'alpha-quality', 'sector-leaders', 'optuna-queue',
  'weekly-cleanup', 'weekly-backtest',
  'weekly-optuna', 'adaptive-meta-policy-replay', 'linucb-multiplier-replay',
  'l4-alpha-ev-refresh', 'allocator-ev-fusion-refresh', 'opb-arm-prior-refresh',
  'allocator-ev-feature-snapshot-backfill',
  'monthly-optuna', 'monthly-l4-alpha-ev-refresh', 'monthly-allocator-ev-fusion-refresh', 'monthly-opb-arm-prior-refresh', 'monthly-strategy-mining', 'weekly-drift-retrain',
  'finlab-v4-backfill',
  'finlab-backfill-watchdog',
  'allocator-ev-lifecycle-watchdog',
  'active8-oof-lifecycle', 'active8-oof-daily', 'active8-oof-weekly', 'active8-oof-monthly',
  'external-evidence',
  'strategy-learning',
  'strategy-threshold-calibration',
  's12-smcvwap-calibration',
  's12-research-recovery',
  's12-replay-backfill',
  'audit-json-retention',
  'legacy-evidence-migration', 'legacy-strategy-evidence-migration', 'legacy-hot-data-retirement', 'artifact-reconcile', 'd1-evidence-scrub', 'r2-retention-sweep',
  'orphan-reachability-gc', 'cleanup-dlq-replay', 'storage-health-gate',
  'storage-integrity-audit', 'storage-capacity-report',
  'monthly-retrain',
])

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

  routes.post('/api/admin/scheduler-batch/:batch', async (c) => {
    const authError = await requireServiceToken(c)
    if (authError) return authError

    const batchId = c.req.param('batch')
    if (!getSchedulerBatch(batchId)) return c.json({ success: false, error: `Unknown scheduler batch: ${batchId}` }, 404)

    const dryRun = c.req.query('dry_run') === '1'
    const rawScheduledTime = c.req.header('X-CloudScheduler-ScheduleTime') ||
      (dryRun ? c.req.query('scheduled_time') : undefined)
    if (!rawScheduledTime) {
      return c.json({ success: false, error: 'Missing X-CloudScheduler-ScheduleTime' }, 400)
    }
    const scheduledAt = new Date(rawScheduledTime)
    if (Number.isNaN(scheduledAt.getTime())) {
      return c.json({ success: false, error: 'Invalid X-CloudScheduler-ScheduleTime' }, 400)
    }

    if (dryRun) {
      const scheduledSlot = normalizeSchedulerBatchSlot(scheduledAt)
      const due = resolveDueSchedulerBatchJobs(batchId, scheduledSlot)
      return c.json({
        success: true,
        dry_run: true,
        batch_id: batchId,
        scheduled_time: scheduledSlot.toISOString(),
        received_scheduled_time: scheduledAt.toISOString(),
        due: due.map((job) => ({ id: job.id, task: job.task, query: job.query, headers: job.headers })),
      })
    }

    const result = await dispatchSchedulerBatch({
      batchId,
      scheduledAt,
      authorization: c.req.header('Authorization') ?? '',
      baseUrl: new URL(c.req.url).origin,
      leaseStore: new D1SchedulerBatchLeaseStore(c.env.DB),
      fetchImpl: async (input, init) => routes.fetch(new Request(input, init), c.env, c.executionCtx),
    })
    if (!result.success) return c.json(result, 503)
    return c.json(result)
  })

  routes.post('/api/admin/trigger/:task', async (c) => {
    const authError = await requireServiceToken(c)
    if (authError) return authError

    const rlKey = `ratelimit:admin:${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 13)}`
    const rlCount = parseInt((await c.env.KV.get(rlKey)) ?? '0', 10)
    if (rlCount >= 100) return c.json({ error: 'Rate limit exceeded (100/hr)' }, 429)
    await c.env.KV.put(rlKey, String(rlCount + 1), { expirationTtl: 3600 })

    const task = c.req.param('task')
    const requestedRunDate = c.req.query('date') || undefined
    const taskMap = deps.buildTaskMap(c)
    const fn = taskMap[task]
    if (!fn) return c.json({ error: `Unknown task: ${task}`, available: Object.keys(taskMap) }, 400)

    if (requestedRunDate) {
      const {
        historicalLearningLineageBlockedMessage,
        historicalLearningLineageDecision,
      } = await import('../lib/historicalLearningLineageGuard')
      const lineageBoundary = await historicalLearningLineageDecision(c.env.DB, task, requestedRunDate)
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
      'strategy-threshold-calibration',
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
      'storage-health-gate',
      'storage-integrity-audit',
      'storage-capacity-report',
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
      'optuna-queue',
      'external-evidence',
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
    try {
      const result = await fn()
      const summary = typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 200) ?? ''
      await logSchedulerResult(c.env.KV, task, {
        status: classifySchedulerSummary(summary),
        summary,
        duration_ms: Date.now() - t0,
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
