import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireServiceToken } from '../lib/auth'
import type { Bindings, Variables } from '../types'
import type { TaskHandler } from '../lib/adminTriggerTaskMap'

interface TriggerRouteDeps {
  buildTaskMap: (c: any) => Record<string, TaskHandler>
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
    const dataTasks = new Set([
      'screener',
      'update',
      'ml',
      'recommendation',
      'paper-trade',
      'morning-setup',
      'intraday-check',
      'eod-exit',
      'pipeline',
      'adapt',
    ])

    if (dataTasks.has(task) && !c.req.query('force')) {
      const twNow = new Date(Date.now() + 8 * 3600_000)
      const dayOfWeek = twNow.getUTCDay()
      const twDate = twNow.toISOString().slice(0, 10)
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
      const isHoliday = await c.env.KV.get(`holiday:${twDate}`)
      if (isWeekend || isHoliday) {
        return c.json({
          error: `今天是${isWeekend ? '週末' : '假日'}，不可手動執行 ${task}；如需強制執行請帶 force=1`,
        }, 400)
      }
    }

    const taskMap = deps.buildTaskMap(c)
    const fn = taskMap[task]
    if (!fn) return c.json({ error: `Unknown task: ${task}`, available: Object.keys(taskMap) }, 400)

    const { classifyCronSummary, logCronResult } = await import('../lib/cronLogger')
    const syncMode = c.req.query('sync') === '1'
    const longRunning = new Set([
      'pipeline',
      'ml',
      'update',
      'recommendation',
      'screener',
      'backtest',
      'monte-carlo',
      'pbo',
      'alpha-quality',
      'weekly-optuna',
      'optuna-queue',
      'retrain',
    ])

    if (longRunning.has(task) && !syncMode) {
      const t0 = Date.now()
      await logCronResult(c.env.KV, task, { status: 'running', summary: 'started (background)', duration_ms: 0 })
      c.executionCtx.waitUntil((async () => {
        try {
          const result = await fn()
          const summary = typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 200) ?? ''
          await logCronResult(c.env.KV, task, { status: classifyCronSummary(summary), summary, duration_ms: Date.now() - t0 })
        } catch (e: any) {
          await logCronResult(
            c.env.KV,
            task,
            {
              status: 'error',
              summary: e?.message ?? 'Unknown error',
              duration_ms: Date.now() - t0,
              error: String(e),
            },
            c.env as any,
          )
        }
      })())
      return c.json({
        success: true,
        message: `${task} 已改為背景執行，請查看 cron log`,
        triggered_at: new Date().toISOString(),
        mode: 'async',
      })
    }

    const t0 = Date.now()
    try {
      const result = await fn()
      const summary = typeof result === 'string' ? result : JSON.stringify(result)?.slice(0, 200) ?? ''
      await logCronResult(c.env.KV, task, { status: classifyCronSummary(summary), summary, duration_ms: Date.now() - t0 })
      return c.json({ success: true, message: `${task} 執行成功`, triggered_at: new Date().toISOString(), result })
    } catch (e: any) {
      await logCronResult(
        c.env.KV,
        task,
        { status: 'error', summary: e?.message ?? 'Unknown error', duration_ms: Date.now() - t0, error: String(e) },
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
