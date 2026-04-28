import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireAdminJWT, requireServiceToken } from '../lib/auth'
import { runDailyUpdate } from '../lib/updateOrchestrator'
import type { Bindings, Variables } from '../types'

export const adminWriteRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminWriteRoutes.post('/api/admin/update', async (c) => {
  const authError = await requireAdminJWT(c)
  if (authError) return authError

  c.executionCtx.waitUntil(runDailyUpdate(c.env))
  return c.json({ success: true, message: '每日更新已在背景執行' })
})

adminWriteRoutes.post('/api/admin/costs/manual', async (c) => {
  const authError = await requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  if (!body?.source || typeof body.est_usd !== 'number') {
    return c.json({ error: 'Required: {source, est_usd, date?, model?, meta?}' }, 400)
  }

  const now = new Date()
  const date = body.date ?? twToday()

  await c.env.DB.prepare(
    `INSERT INTO cost_events (ts, date, source, provider, model, tokens_in, tokens_out, compute_sec, est_usd, meta)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
  ).bind(
    now.toISOString(),
    date,
    body.source,
    body.provider ?? 'manual',
    body.model ?? null,
    body.compute_sec ?? 0,
    body.est_usd,
    body.meta ? JSON.stringify(body.meta) : null,
  ).run()

  return c.json({ ok: true, recorded_usd: body.est_usd })
})
