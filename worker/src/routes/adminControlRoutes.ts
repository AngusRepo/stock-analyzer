import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'
import { requireAdminOrServiceToken } from '../lib/auth'

export const adminControlRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function requireServiceToken(c: any) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return null
}

adminControlRoutes.get('/api/admin/adaptive-params', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { getAdaptiveParams } = await import('../lib/adaptiveConfig')
  const params = await getAdaptiveParams(c.env.KV)
  return c.json(params)
})

adminControlRoutes.post('/api/admin/adaptive-params', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON' }, 400)

  const { getAdaptiveParams, setAdaptiveParams } = await import('../lib/adaptiveConfig')
  const current = await getAdaptiveParams(c.env.KV)
  const merged = { ...current, ...body, version: (current.version ?? 0) + 1 }
  await setAdaptiveParams(c.env.KV, merged)
  return c.json({ success: true, params: merged })
})

adminControlRoutes.post('/api/admin/cron-callback', async (c) => {
  const authError = requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  if (!body || typeof body.task !== 'string' || typeof body.status !== 'string') {
    return c.json({
      error: 'Body must be { task, status, summary?, duration_ms?, error?, run_id? }',
    }, 400)
  }
  const { isCronStatus, logCronResult } = await import('../lib/schedulerRunLogger')
  if (!isCronStatus(body.status)) {
    return c.json({ error: 'status must be one of success/skipped/error/triggered/running' }, 400)
  }

  await logCronResult(c.env.KV, String(body.task), {
    status: body.status,
    summary: String(body.summary ?? ''),
    duration_ms: Number(body.duration_ms ?? 0),
    error: body.error != null ? String(body.error) : undefined,
  })

  if (body.task === 'verify-v2' && body.status === 'success' && c.env.ML_CONTROLLER_URL) {
    c.executionCtx.waitUntil((async () => {
      const t0 = Date.now()
      try {
        const { runModelIcRollingRefresh } = await import('../lib/controllerWorkflows')
        const summary = await runModelIcRollingRefresh(c.env)
        await logCronResult(c.env.KV, 'model-ic-tracker', {
          status: summary.startsWith('rolling_ic failed') ? 'error' : 'success',
          summary,
          duration_ms: Date.now() - t0,
        }, c.env as any)
      } catch (e: any) {
        await logCronResult(c.env.KV, 'model-ic-tracker', {
          status: 'error',
          summary: e?.message ?? 'rolling_ic refresh failed',
          duration_ms: Date.now() - t0,
          error: String(e),
        }, c.env as any)
      }
    })())
  }

  console.log(
    `[cron-callback] ${body.task} ${body.status} ` +
    `run_id=${body.run_id ?? '-'} duration=${body.duration_ms}ms`,
  )

  return c.json({ ok: true, task: body.task, status: body.status })
})
