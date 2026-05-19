import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireValidToken } from '../lib/auth'
import { controllerJson } from '../lib/controllerClient'
import type { Bindings, Variables } from '../types'
import { buildDashboardV4ChartPacket } from '../lib/dashboardV4Contract'
import { readMarketRegimeState } from '../lib/marketRegimeState'
import { readV41DataRuntimeStatus } from '../lib/v41DataRuntime'

export const dashboardReadRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

function parseDashboardId(s: string | undefined | null): number | null {
  const n = Number.parseInt(s ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseDashboardPosInt(s: string | undefined | null, fallback: number, max: number): number {
  const n = Number.parseInt(s ?? '', 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, max)
}

function isStateSpaceOverlay(name: string, model: Record<string, any>): boolean {
  return (
    name === 'KalmanFilter' ||
    name === 'MarkovSwitching' ||
    model.model_type === 'state_space_overlay' ||
    model.balance_family === 'state_space'
  )
}

dashboardReadRoutes.get('/api/dashboard/v4/stocks/:id/chart', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  const id = parseDashboardId(c.req.param('id'))
  if (!id) return c.json({ error: 'invalid_stock_id' }, 400)

  const days = parseDashboardPosInt(c.req.query('days'), 180, 720)
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  const stock = await c.env.DB.prepare(
    'SELECT id, symbol, name, market, sector FROM stocks WHERE id=?',
  ).bind(id).first<any>()
  if (!stock) return c.json({ error: 'stock_not_found' }, 404)

  const signalLimit = parseDashboardPosInt(c.req.query('signals'), 80, 300)
  const flowLimit = parseDashboardPosInt(c.req.query('flow'), 90, 300)

  const [prices, signals, regimeState, dataQuality, previewEvents, finlabDiff, sectorFlow] = await Promise.all([
    c.env.DB.prepare(
      'SELECT date, open, high, low, close, volume FROM stock_prices WHERE stock_id=? AND date>=? ORDER BY date',
    ).bind(id, since).all<any>().then((r) => r.results ?? []),
    c.env.DB.prepare(`
      SELECT prediction_date, generated_at, model_name, trade_signal, direction_accuracy
      FROM predictions
      WHERE stock_id=?
      ORDER BY COALESCE(prediction_date, substr(generated_at, 1, 10)) DESC, generated_at DESC
      LIMIT ?
    `).bind(id, signalLimit).all<any>().then((r) => r.results ?? []),
    readMarketRegimeState(c.env.KV).catch(() => null),
    import('../lib/dataQualityMonitor')
      .then(({ buildDataQualityReport }) => buildDataQualityReport(c.env, { date: c.req.query('date') }))
      .catch(() => ({ overall: 'unknown', checks: [] })),
    c.env.DB.prepare(`
      SELECT event_type, status, reason, detail_json, created_at
      FROM paper_execution_events
      WHERE symbol=?
        AND event_type IN ('finlab_preview', 'finlab_execution_preview')
        AND status IN ('blocked', 'warning', 'error')
      ORDER BY created_at DESC
      LIMIT 50
    `).bind(stock.symbol).all<any>().then((r) => r.results ?? []).catch(() => []),
    c.env.KV.get('finlab:v4:latest_diff', 'json')
      .then((raw: any) => Array.isArray(raw?.rows) ? raw.rows : [])
      .catch(() => []),
    stock.sector
      ? c.env.DB.prepare(`
          SELECT date, sector, classification, total_net, foreign_net, trust_net
          FROM sector_flow
          WHERE sector=?
          ORDER BY date DESC
          LIMIT ?
        `).bind(stock.sector, flowLimit).all<any>().then((r) => r.results ?? [])
      : Promise.resolve([]),
  ])

  return c.json(buildDashboardV4ChartPacket({
    stock,
    priceRows: prices,
    modelSignals: signals,
    regimeState: regimeState as any,
    sectorFlowRows: sectorFlow,
    dataQuality: dataQuality as any,
    finlabDiffRows: finlabDiff as any[],
    previewEvents,
  }))
})

dashboardReadRoutes.get('/api/dashboard/v4/data-runtime/status', async (c) => {
  const authError = await requireValidToken(c)
  if (authError) return authError

  const date = c.req.query('date') ?? twToday()
  return c.json(await readV41DataRuntimeStatus(c.env.DB, date))
})

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
