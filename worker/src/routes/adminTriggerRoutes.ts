import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireServiceToken } from '../lib/auth'
import type { Bindings, Variables } from '../types'
import type { TaskHandler } from '../lib/adminTriggerTaskMap'
import { shouldRunScheduledTask } from '../lib/schedulerPolicy'

interface TriggerRouteDeps {
  buildTaskMap: (c: any) => Record<string, TaskHandler>
}

const SYNC_REQUIRED_TASKS = new Set(['update', 'pipeline'])

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
  ).catch((error) => {
    console.warn(`[AdminTrigger] run log write failed task=${task} run_id=${runId}:`, error)
  })
}

export function createAdminTriggerRoutes(deps: TriggerRouteDeps) {
  const routes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

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
      'weekly-optuna',
      'monthly-optuna',
      'weekly-cleanup',
      'optuna-queue',
      'retrain',
    ])

    if (longRunning.has(task) && !syncMode) {
      const t0 = Date.now()
      const runId = buildRunId(task)
      await logSchedulerResult(c.env.KV, task, {
        status: 'running',
        summary: `started (background) run_id=${runId}`,
        duration_ms: 0,
        run_date: requestedRunDate,
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
