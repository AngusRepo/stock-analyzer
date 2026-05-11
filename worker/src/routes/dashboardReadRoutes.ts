import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireValidToken } from '../lib/auth'
import { controllerJson } from '../lib/controllerClient'
import type { Bindings, Variables } from '../types'

export const dashboardReadRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function isStateSpaceOverlay(name: string, model: Record<string, any>): boolean {
  return (
    name === 'KalmanFilter' ||
    name === 'MarkovSwitching' ||
    model.model_type === 'state_space_overlay' ||
    model.balance_family === 'state_space'
  )
}

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
  try {
    const lineage = await controllerJson<any>(c.env, '/model_pool/lineage', { timeoutMs: 30_000 })
    const models = Object.entries(lineage?.models ?? {})
      .filter(([modelName, raw]) => !isStateSpaceOverlay(modelName, raw as Record<string, any>))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([modelName, raw]) => {
        const model = raw as Record<string, any>
        const ic = model.ic_4w_avg ?? model.rolling_ic ?? null
        return {
          date,
          model_name: modelName,
          lifecycle_status: model.status ?? 'unknown',
          lifecycle_weight: model.weight_mult ?? 1,
          ic_mean: ic,
          ic_4w_avg: model.ic_4w_avg ?? null,
          rolling_ic: model.rolling_ic ?? null,
          last_ic_status: model.last_ic_status ?? null,
          last_ic_root_cause: model.last_ic_root_cause ?? model.lifecycle_diagnosis?.root_cause ?? null,
          last_ic_sample_count: model.last_ic_sample_count ?? 0,
          last_ic_error: model.last_ic_error ?? model.lifecycle_diagnosis?.error ?? null,
          lifecycle_diagnosis: model.lifecycle_diagnosis ?? null,
          weekly_ic_count: Array.isArray(model.weekly_ic) ? model.weekly_ic.length : 0,
          metadata_exists: model.metadata_exists ?? null,
          drift_detected: Number(model.consecutive_negative_weeks ?? 0) > 0 ? 1 : 0,
          created_at: lineage?.last_updated ?? new Date().toISOString(),
          source_of_truth: 'model_pool.json',
        }
      })
    return c.json({ date, models, source_of_truth: 'model_pool.json', last_updated: lineage?.last_updated ?? null })
  } catch (e: any) {
    return c.json({
      date,
      models: [],
      source_of_truth: 'model_pool.json',
      error: 'model_pool_unavailable',
      warning: e?.message ?? String(e),
    }, 502)
  }
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

dashboardReadRoutes.get('/api/model-pool/artifact_registry', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  const params = new URLSearchParams()
  for (const key of ['model_name', 'state', 'candidate_type', 'limit']) {
    const value = c.req.query(key)
    if (value) params.set(key, value)
  }
  const qs = params.toString()

  try {
    return c.json(await controllerJson<any>(c.env, `/model_pool/artifact_registry${qs ? `?${qs}` : ''}`, { timeoutMs: 30_000 }))
  } catch (e: any) {
    return c.json({ status: 'error', error: e?.message ?? String(e), artifacts: [] }, 502)
  }
})

dashboardReadRoutes.get('/api/model-pool/artifact_registry/selection', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  const params = new URLSearchParams()
  for (const key of ['model_name', 'limit']) {
    const value = c.req.query(key)
    if (value) params.set(key, value)
  }
  const qs = params.toString()

  try {
    return c.json(await controllerJson<any>(c.env, `/model_pool/artifact_registry/selection${qs ? `?${qs}` : ''}`, { timeoutMs: 30_000 }))
  } catch (e: any) {
    return c.json({ status: 'error', error: e?.message ?? String(e), models: {} }, 502)
  }
})

dashboardReadRoutes.get('/api/model-pool/artifact_registry/promotion_queue', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  const params = new URLSearchParams()
  for (const key of ['model_name', 'limit']) {
    const value = c.req.query(key)
    if (value) params.set(key, value)
  }
  const qs = params.toString()

  try {
    return c.json(await controllerJson<any>(c.env, `/model_pool/artifact_registry/promotion_queue${qs ? `?${qs}` : ''}`, { timeoutMs: 30_000 }))
  } catch (e: any) {
    return c.json({ status: 'error', error: e?.message ?? String(e), queue: [] }, 502)
  }
})

dashboardReadRoutes.post('/api/model-pool/artifact_registry/promotion_controller', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  try {
    const body = await c.req.json().catch(() => ({}))
    return c.json(await controllerJson<any>(c.env, '/model_pool/artifact_registry/promotion_controller', {
      method: 'POST',
      jsonBody: body,
      timeoutMs: 30_000,
    }))
  } catch (e: any) {
    return c.json({ status: 'error', error: e?.message ?? String(e) }, 502)
  }
})

dashboardReadRoutes.get('/api/model-pool/artifact_registry/champion_pointers', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  const params = new URLSearchParams()
  for (const key of ['model_name', 'limit']) {
    const value = c.req.query(key)
    if (value) params.set(key, value)
  }
  const qs = params.toString()

  try {
    return c.json(await controllerJson<any>(c.env, `/model_pool/artifact_registry/champion_pointers${qs ? `?${qs}` : ''}`, { timeoutMs: 30_000 }))
  } catch (e: any) {
    return c.json({ status: 'error', error: e?.message ?? String(e), models: {} }, 502)
  }
})

dashboardReadRoutes.post('/api/model-pool/artifact_registry/champion_pointers/backfill', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  try {
    const body = await c.req.json().catch(() => ({}))
    return c.json(await controllerJson<any>(c.env, '/model_pool/artifact_registry/champion_pointers/backfill', {
      method: 'POST',
      jsonBody: body,
      timeoutMs: 30_000,
    }))
  } catch (e: any) {
    return c.json({ status: 'error', error: e?.message ?? String(e) }, 502)
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
