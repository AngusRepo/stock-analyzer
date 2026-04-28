import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireValidToken } from '../lib/auth'
import { controllerJson } from '../lib/controllerClient'
import type { Bindings, Variables } from '../types'

export const dashboardReadRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

dashboardReadRoutes.get('/api/backtest/latest', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  const row = await c.env.DB.prepare(
    'SELECT * FROM backtest_results ORDER BY run_date DESC, created_at DESC LIMIT 1'
  ).first()
  return c.json(row ?? null)
})

dashboardReadRoutes.get('/api/backtest/monte-carlo', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  const row = await c.env.DB.prepare(
    'SELECT * FROM monte_carlo_results ORDER BY run_date DESC, created_at DESC LIMIT 1'
  ).first()
  return c.json(row ?? null)
})

dashboardReadRoutes.get('/api/observability/decisions', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  const date = c.req.query('date') ?? twToday()
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM decision_logs WHERE date=? ORDER BY total_score DESC'
  ).bind(date).all()
  return c.json({ date, decisions: results ?? [] })
})

dashboardReadRoutes.get('/api/observability/model-health', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  const date = c.req.query('date') ?? twToday()
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM model_health_daily WHERE date=? ORDER BY model_name'
  ).bind(date).all()
  return c.json({ date, models: results ?? [] })
})

dashboardReadRoutes.get('/api/model-pool/status', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  try {
    return c.json(await controllerJson<any>(c.env, '/model_pool/status', { timeoutMs: 30_000 }))
  } catch (e: any) {
    return c.json({ status: 'error', error: e?.message ?? String(e) }, 502)
  }
})

dashboardReadRoutes.get('/api/model-pool/lineage', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  try {
    return c.json(await controllerJson<any>(c.env, '/model_pool/lineage', { timeoutMs: 30_000 }))
  } catch (e: any) {
    return c.json({ status: 'error', error: e?.message ?? String(e), models: {}, events: [] }, 502)
  }
})

dashboardReadRoutes.get('/api/backtest/pbo', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  const row = await c.env.DB.prepare(
    'SELECT * FROM pbo_results ORDER BY run_date DESC, created_at DESC LIMIT 1'
  ).first()
  return c.json(row ?? null)
})
