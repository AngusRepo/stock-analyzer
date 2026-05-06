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

const D1_BATCH_ALLOWED_DML = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE'])

function normalizeD1BatchStatement(raw: any, index: number) {
  const sql = typeof raw?.sql === 'string' ? raw.sql.trim() : ''
  if (!sql) throw new Error(`statement ${index}: sql is required`)
  if (sql.includes(';')) throw new Error(`statement ${index}: multiple SQL statements are not allowed`)

  const verb = sql.split(/\s+/, 1)[0]?.toUpperCase()
  if (!D1_BATCH_ALLOWED_DML.has(verb)) {
    throw new Error(`statement ${index}: only INSERT/UPDATE/DELETE/REPLACE are allowed`)
  }

  const params = Array.isArray(raw?.params) ? raw.params : []
  return { sql, params }
}

adminControlRoutes.post('/api/internal/d1/batch', async (c) => {
  const authError = requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json().catch(() => null) as any
  const rawStatements = Array.isArray(body?.statements) ? body.statements : []
  const maxStatements = Math.min(Number(body?.max_statements ?? 500) || 500, 500)
  if (!rawStatements.length) return c.json({ error: 'statements must be a non-empty array' }, 400)
  if (rawStatements.length > maxStatements) {
    return c.json({ error: `too many statements: ${rawStatements.length} > ${maxStatements}` }, 400)
  }

  let statements: Array<{ sql: string; params: any[] }>
  try {
    statements = rawStatements.map((s: any, index: number) => normalizeD1BatchStatement(s, index))
  } catch (e: any) {
    return c.json({ error: e?.message ?? 'invalid statement' }, 400)
  }

  const prepared = statements.map((s) => c.env.DB.prepare(s.sql).bind(...s.params))
  const t0 = Date.now()
  const results = await c.env.DB.batch(prepared)
  const changesTotal = results.reduce((sum: number, result: any) => {
    const meta = result?.meta ?? {}
    return sum + Number(meta.changes ?? meta.rows_written ?? 0)
  }, 0)

  return c.json({
    ok: true,
    total: statements.length,
    success_count: results.length,
    error_count: 0,
    changes_total: changesTotal,
    duration_ms: Date.now() - t0,
    mode: 'worker_d1_batch',
  })
})

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

  const body = await c.req.json().catch(() => null) as any
  if (!body) return c.json({ error: 'Invalid JSON' }, 400)

  const { getAdaptiveParams, setAdaptiveParams } = await import('../lib/adaptiveConfig')
  const current = await getAdaptiveParams(c.env.KV)
  const merged = { ...current, ...body, version: (current.version ?? 0) + 1 }
  await setAdaptiveParams(c.env.KV, merged, { source: 'manual', fallback: false })
  return c.json({ success: true, params: merged })
})

async function handleSchedulerCallback(c: any) {
  const authError = requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json().catch(() => null) as any
  if (!body || typeof body.task !== 'string' || typeof body.status !== 'string') {
    return c.json({
      error: 'Body must be { task, status, summary?, duration_ms?, error?, run_id? }',
    }, 400)
  }
  const { isSchedulerStatus, logSchedulerResult } = await import('../lib/schedulerRunLogger')
  if (!isSchedulerStatus(body.status)) {
    return c.json({ error: 'status must be one of success/skipped/error/triggered/running' }, 400)
  }

  await logSchedulerResult(c.env.KV, String(body.task), {
    status: body.status,
    summary: String(body.summary ?? ''),
    duration_ms: Number(body.duration_ms ?? 0),
    error: body.error != null ? String(body.error) : undefined,
    run_date: typeof body.run_date === 'string' ? body.run_date : typeof body.date === 'string' ? body.date : undefined,
  })

  if (body.task === 'verify-v2' && body.status === 'success' && c.env.ML_CONTROLLER_URL) {
    c.executionCtx.waitUntil((async () => {
      const t0 = Date.now()
      try {
        const { runModelIcRollingRefresh } = await import('../lib/controllerWorkflows')
        const summary = await runModelIcRollingRefresh(c.env)
        await logSchedulerResult(c.env.KV, 'model-ic-tracker', {
          status: summary.startsWith('rolling_ic failed') ? 'error' : 'success',
          summary,
          duration_ms: Date.now() - t0,
        }, c.env as any)
      } catch (e: any) {
        await logSchedulerResult(c.env.KV, 'model-ic-tracker', {
          status: 'error',
          summary: e?.message ?? 'rolling_ic refresh failed',
          duration_ms: Date.now() - t0,
          error: String(e),
        }, c.env as any)
      }
    })())
  }

  console.log(
    `[scheduler-callback] ${body.task} ${body.status} ` +
    `run_id=${body.run_id ?? '-'} duration=${body.duration_ms}ms`,
  )

  return c.json({ ok: true, task: body.task, status: body.status })
}

adminControlRoutes.post('/api/admin/scheduler-callback', handleSchedulerCallback)
adminControlRoutes.post('/api/admin/cron-callback', handleSchedulerCallback)
