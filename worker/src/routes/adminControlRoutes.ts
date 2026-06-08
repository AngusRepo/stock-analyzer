import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'
import { requireAdminOrServiceToken } from '../lib/auth'

export const adminControlRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const REPORT_ARTIFACT_TASKS = new Set([
  'pipeline',
  'finlab-v4-backfill',
  'backtest',
  'weekly-optuna',
  'optuna-queue',
  'pbo',
  'monte-carlo',
  'alpha-quality',
  'weekly-audit',
  'lifecycle',
  'monthly-optuna',
  'monthly-retrain',
])

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

function nullableText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function nullableInteger(value: unknown): number | null {
  const parsed = nullableNumber(value)
  return parsed === null ? null : Math.trunc(parsed)
}

function stateSpaceSeriesMetaBySymbol(body: any): Map<string, any> {
  const out = new Map<string, any>()
  const rows = Array.isArray(body?.series_meta) ? body.series_meta : []
  for (const row of rows) {
    const symbol = nullableText(row?.symbol)
    if (symbol) out.set(symbol, row)
  }
  return out
}

adminControlRoutes.post('/api/internal/state-space-shadow/callback', async (c) => {
  const authError = requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json().catch(() => null) as any
  const runDate = nullableText(body?.run_date)
  if (!body || !runDate) {
    return c.json({ error: 'run_date is required' }, 400)
  }

  const result = body?.result && typeof body.result === 'object' ? body.result : {}
  const overlays = result?.overlays && typeof result.overlays === 'object' ? result.overlays : {}
  const seriesMeta = stateSpaceSeriesMetaBySymbol(body)
  const runId = nullableText(body?.run_id) ?? ''
  const horizon = nullableInteger(body?.horizon)
  const functionCallId = nullableText(body?.function_call_id)
  const elapsedS = nullableNumber(body?.elapsed_s ?? result?.elapsed_s)
  const callbackJson = JSON.stringify({
    schema_version: body?.schema_version ?? null,
    source: body?.source ?? null,
    version_by_model: body?.version_by_model ?? null,
    result_metrics: result?.metrics ?? null,
  })

  const statements = []
  const sql = `
    INSERT INTO state_space_shadow_results (
      run_date, run_id, source, model_name, symbol, stock_id, horizon,
      forecast_pct, up_prob, confidence, direction, model_version, n_used,
      degraded, fallback_reason, error, diagnostics_json, overlay_json,
      callback_json, function_call_id, elapsed_s, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(run_date, run_id, model_name, symbol) DO UPDATE SET
      source=excluded.source,
      stock_id=excluded.stock_id,
      horizon=excluded.horizon,
      forecast_pct=excluded.forecast_pct,
      up_prob=excluded.up_prob,
      confidence=excluded.confidence,
      direction=excluded.direction,
      model_version=excluded.model_version,
      n_used=excluded.n_used,
      degraded=excluded.degraded,
      fallback_reason=excluded.fallback_reason,
      error=excluded.error,
      diagnostics_json=excluded.diagnostics_json,
      overlay_json=excluded.overlay_json,
      callback_json=excluded.callback_json,
      function_call_id=excluded.function_call_id,
      elapsed_s=excluded.elapsed_s,
      updated_at=datetime('now')
  `

  for (const [modelName, overlay] of Object.entries(overlays) as Array<[string, any]>) {
    const rows = Array.isArray(overlay?.results) ? overlay.results : []
    for (const row of rows) {
      const symbol = nullableText(row?.symbol)
      if (!symbol) continue
      const meta = seriesMeta.get(symbol) ?? {}
      statements.push(c.env.DB.prepare(sql).bind(
        runDate,
        runId,
        nullableText(body?.source) ?? 'modal_state_space_shadow',
        modelName,
        symbol,
        nullableInteger(row?.stock_id ?? meta?.stock_id),
        horizon,
        nullableNumber(row?.forecast_pct),
        nullableNumber(row?.up_prob),
        nullableNumber(row?.confidence),
        nullableText(row?.direction),
        nullableText(row?.model_version ?? overlay?.version),
        nullableInteger(row?.n_used),
        row?.degraded ? 1 : 0,
        nullableText(row?.fallback_reason),
        nullableText(row?.error),
        JSON.stringify(row?.diagnostics ?? null),
        JSON.stringify(row),
        callbackJson,
        functionCallId,
        elapsedS,
      ))
    }
  }

  if (!statements.length) {
    return c.json({ ok: true, total: 0, success_count: 0, mode: 'state_space_shadow_callback' })
  }

  const t0 = Date.now()
  const results = await c.env.DB.batch(statements)
  const changesTotal = results.reduce((sum: number, item: any) => {
    const meta = item?.meta ?? {}
    return sum + Number(meta.changes ?? meta.rows_written ?? 0)
  }, 0)
  return c.json({
    ok: true,
    total: statements.length,
    success_count: results.length,
    changes_total: changesTotal,
    duration_ms: Date.now() - t0,
    mode: 'state_space_shadow_callback',
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
  const callbackRunDate = typeof body.run_date === 'string'
    ? body.run_date
    : typeof body.date === 'string'
      ? body.date
      : undefined
  const callbackRunId = typeof body.run_id === 'string' ? body.run_id : undefined

  await logSchedulerResult(c.env.KV, String(body.task), {
    status: body.status,
    summary: String(body.summary ?? ''),
    duration_ms: Number(body.duration_ms ?? 0),
    error: body.error != null ? String(body.error) : undefined,
    run_id: callbackRunId,
    run_date: callbackRunDate,
  })

  if (
    REPORT_ARTIFACT_TASKS.has(String(body.task)) &&
    body.status === 'success' &&
    callbackRunDate &&
    callbackRunId
  ) {
    c.executionCtx.waitUntil((async () => {
      try {
        const { recordSchedulerRunReportArtifact } = await import('../lib/datasetSnapshots')
        await recordSchedulerRunReportArtifact(c.env, {
          task: String(body.task),
          status: String(body.status),
          businessDate: callbackRunDate,
          runId: callbackRunId,
          summary: String(body.summary ?? ''),
          durationMs: Number(body.duration_ms ?? 0),
          error: body.error != null ? String(body.error) : undefined,
        })
      } catch (e) {
        console.warn('[scheduler-callback] R2 scheduler report artifact failed:', e)
      }
    })())
  }

  if (body.task === 'finlab-v4-backfill' && ['success', 'error', 'skipped'].includes(String(body.status))) {
    const continueEveningChain = Boolean(
      body.continue_evening_chain ||
      body.result?.continue_evening_chain ||
      body.metadata?.continue_evening_chain,
    )
    const forceContinuation = Boolean(
      body.force ||
      body.result?.force ||
      body.metadata?.force,
    )
    if (body.status === 'success' && continueEveningChain && callbackRunDate) {
      await logSchedulerResult(c.env.KV, 'evening-chain', {
        status: 'running',
        summary: `FinLab canonical backfill completed for ${callbackRunDate}; queueing market data continuation`,
        duration_ms: 0,
        run_id: callbackRunId,
        run_date: callbackRunDate,
      })
      await c.env.UPDATE_QUEUE.send({
        type: 'finlab_backfill_complete',
        cursor: 0,
        triggerTime: callbackRunDate,
        runId: callbackRunId,
        force: forceContinuation,
        attempt: 1,
      })
    } else if (body.status !== 'success' && continueEveningChain) {
      await logSchedulerResult(c.env.KV, 'update', {
        status: body.status === 'skipped' ? 'skipped' : 'error',
        summary: `FinLab canonical backfill blocked market data continuation: ${String(body.summary ?? body.status)}`,
        duration_ms: 0,
        error: body.error != null ? String(body.error) : undefined,
        run_id: callbackRunId,
        run_date: callbackRunDate,
      }, c.env as any)
      await logSchedulerResult(c.env.KV, 'evening-chain', {
        status: body.status === 'skipped' ? 'skipped' : 'error',
        summary: `root chain stopped at FinLab canonical callback: ${String(body.summary ?? body.status)}`,
        duration_ms: 0,
        error: body.error != null ? String(body.error) : undefined,
        run_id: callbackRunId,
        run_date: callbackRunDate,
      }, c.env as any)
    }
  }

  if (body.task === 'pipeline' && ['success', 'error', 'skipped'].includes(String(body.status))) {
    try {
      if (callbackRunDate) {
        await c.env.KV.delete(`lock:ml-predict:${callbackRunDate}`).catch(() => {})
      }
      if (body.status === 'success') {
        const { runPostPipelineCallbackChain } = await import('../lib/postMarketChain')
        await runPostPipelineCallbackChain(c.env, {
          runDate: callbackRunDate,
          upstreamRunId: callbackRunId,
        })
      } else {
        await logSchedulerResult(c.env.KV, 'evening-chain', {
          status: body.status === 'skipped' ? 'skipped' : 'error',
          summary: `root chain stopped at pipeline callback: ${String(body.summary ?? body.status)}`,
          duration_ms: 0,
          error: body.error != null ? String(body.error) : undefined,
          run_id: callbackRunId,
          run_date: callbackRunDate,
        }, c.env as any)
      }
    } catch (e: any) {
      await logSchedulerResult(c.env.KV, 'post-pipeline-chain', {
        status: 'error',
        summary: e?.message ?? 'post-pipeline callback chain failed',
        duration_ms: 0,
        error: String(e),
        run_id: callbackRunId,
        run_date: callbackRunDate,
      }, c.env as any)
      await logSchedulerResult(c.env.KV, 'evening-chain', {
        status: 'error',
        summary: e?.message ?? 'root chain stopped in post-pipeline callback chain',
        duration_ms: 0,
        error: String(e),
        run_id: callbackRunId,
        run_date: callbackRunDate,
      }, c.env as any)
    }
  }

  const verifyCanContinue =
    body.task === 'verify-v2' &&
    ['success', 'skipped'].includes(String(body.status)) &&
    c.env.ML_CONTROLLER_URL
  if (verifyCanContinue) {
    await logSchedulerResult(c.env.KV, 'post-verify-chain', {
      status: 'triggered',
      summary: 'post-verify chain accepted by verify-v2 callback',
      duration_ms: 0,
      run_id: callbackRunId,
      run_date: callbackRunDate,
    }, c.env as any)
    c.executionCtx.waitUntil((async () => {
      try {
        const { runPostVerifyCallbackChain } = await import('../lib/postMarketChain')
        await runPostVerifyCallbackChain(c.env, {
          runDate: callbackRunDate,
          upstreamRunId: callbackRunId,
        })
      } catch (e: any) {
        await logSchedulerResult(c.env.KV, 'post-verify-chain', {
          status: 'error',
          summary: e?.message ?? 'post-verify callback chain failed',
          duration_ms: 0,
          error: String(e),
          run_id: callbackRunId,
          run_date: callbackRunDate,
        }, c.env as any)
        await logSchedulerResult(c.env.KV, 'evening-chain', {
          status: 'error',
          summary: e?.message ?? 'root chain stopped in post-verify callback chain',
          duration_ms: 0,
          error: String(e),
          run_id: callbackRunId,
          run_date: callbackRunDate,
        }, c.env as any)
      }
    })())
  }

  if (body.task === 'verify-v2' && String(body.status) === 'error') {
    await logSchedulerResult(c.env.KV, 'post-verify-chain', {
      status: 'error',
      summary: `post-verify chain blocked by verify-v2 error: ${String(body.summary ?? '')}`,
      duration_ms: 0,
      error: body.error != null ? String(body.error) : undefined,
      run_id: callbackRunId,
      run_date: callbackRunDate,
    }, c.env as any)
    await logSchedulerResult(c.env.KV, 'evening-chain', {
      status: 'error',
      summary: `root chain stopped at verify-v2 callback: ${String(body.summary ?? '')}`,
      duration_ms: 0,
      error: body.error != null ? String(body.error) : undefined,
      run_id: callbackRunId,
      run_date: callbackRunDate,
    }, c.env as any)
  }

  console.log(
    `[scheduler-callback] ${body.task} ${body.status} ` +
    `run_id=${body.run_id ?? '-'} duration=${body.duration_ms}ms`,
  )

  return c.json({ ok: true, task: body.task, status: body.status })
}

adminControlRoutes.post('/api/admin/scheduler-callback', handleSchedulerCallback)
adminControlRoutes.post('/api/admin/cron-callback', handleSchedulerCallback)
