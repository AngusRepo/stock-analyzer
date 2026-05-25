import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'
import { requireAdminOrServiceToken } from '../lib/auth'

export const adminControlRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const REPORT_ARTIFACT_TASKS = new Set([
  'pipeline',
  'dataset-snapshot-export',
  'regime-compute',
  'backtest',
  'backtest-replay',
  'weekly-backtest',
  'weekly-optuna',
  'optuna-queue',
  'pbo',
  'monte-carlo',
  'finlab-v4-backfill',
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
const D1_QUERY_ALLOWED_READ = new Set(['SELECT', 'WITH'])
const D1_QUERY_MAX_ROWS_CAP = 250000
const D1_QUERY_FORBIDDEN_MUTATION = /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA|VACUUM|ATTACH|DETACH|TRUNCATE)\b/i

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

function normalizeD1QueryStatement(raw: any) {
  const sql = typeof raw?.sql === 'string' ? raw.sql.trim() : ''
  if (!sql) throw new Error('sql is required')
  if (sql.includes(';')) throw new Error('multiple SQL statements are not allowed')
  if (sql.includes('--') || sql.includes('/*') || sql.includes('*/')) {
    throw new Error('SQL comments are not allowed')
  }

  const verb = sql.split(/\s+/, 1)[0]?.toUpperCase()
  if (!D1_QUERY_ALLOWED_READ.has(verb)) {
    throw new Error('only SELECT/WITH are allowed')
  }
  if (verb === 'WITH' && D1_QUERY_FORBIDDEN_MUTATION.test(sql)) {
    throw new Error('WITH query must be read-only')
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

adminControlRoutes.post('/api/internal/d1/query', async (c) => {
  const authError = requireServiceToken(c)
  if (authError) return authError

  const body = await c.req.json().catch(() => null) as any
  let statement: { sql: string; params: any[] }
  try {
    statement = normalizeD1QueryStatement(body)
  } catch (e: any) {
    return c.json({ error: e?.message ?? 'invalid query' }, 400)
  }

  const maxRows = Math.min(Math.max(Number(body?.max_rows ?? D1_QUERY_MAX_ROWS_CAP) || D1_QUERY_MAX_ROWS_CAP, 1), D1_QUERY_MAX_ROWS_CAP)
  const t0 = Date.now()
  const result = await c.env.DB.prepare(statement.sql).bind(...statement.params).all()
  const rows = result.results ?? []
  if (rows.length > maxRows) {
    return c.json({ error: `too many rows: ${rows.length} > ${maxRows}` }, 413)
  }

  return c.json({
    ok: true,
    results: rows,
    meta: result.meta ?? {},
    duration_ms: Date.now() - t0,
    mode: 'worker_d1_query',
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
  const { classifySchedulerSummary, isSchedulerStatus, logSchedulerResult } = await import('../lib/schedulerRunLogger')
  if (!isSchedulerStatus(body.status)) {
    return c.json({ error: 'status must be one of success/skipped/error/triggered/running' }, 400)
  }
  const callbackRunDate = typeof body.run_date === 'string'
    ? body.run_date
    : typeof body.date === 'string'
      ? body.date
      : undefined
  const callbackRunId = typeof body.run_id === 'string' ? body.run_id : undefined
  const callbackMetadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : undefined
  let callbackSummary = String(body.summary ?? '')
  let optunaClosure: Record<string, unknown> | null = null
  if (String(body.task) === 'optuna-queue') {
    const { closeOptunaQueueCallbackRun } = await import('../lib/optunaRunClosure')
    optunaClosure = await closeOptunaQueueCallbackRun(c.env, {
      status: body.status,
      runId: callbackRunId,
      runDate: callbackRunDate,
      summary: callbackSummary,
      durationMs: Number(body.duration_ms ?? 0),
      error: body.error != null ? String(body.error) : undefined,
      metadata: callbackMetadata,
    })
  }
  const schedulerRunDate = typeof optunaClosure?.business_date === 'string'
    ? optunaClosure.business_date
    : callbackRunDate

  if (String(body.task) === 'regime-compute' && body.status === 'success') {
    const newLabel = String(callbackMetadata?.regime_label_en ?? '').trim()
    if (newLabel) {
      try {
        const { detectRegimeShift } = await import('../lib/riskTriggers')
        const rawPrev = callbackMetadata?.prev_label
        const prevLabel = typeof rawPrev === 'string' && rawPrev.trim() ? rawPrev : null
        const shiftSummary = await detectRegimeShift(c.env, prevLabel, newLabel)
        callbackSummary = `${callbackSummary} shift=${shiftSummary}`.slice(0, 1200)
      } catch (e: any) {
        callbackSummary = `${callbackSummary} shift=hook_error(${String(e?.message ?? e).slice(0, 80)})`.slice(0, 1200)
      }
    }
  }

  await logSchedulerResult(c.env.KV, String(body.task), {
    status: body.status,
    summary: callbackSummary,
    duration_ms: Number(body.duration_ms ?? 0),
    error: body.error != null ? String(body.error) : undefined,
    run_id: callbackRunId,
    run_date: schedulerRunDate,
    metadata: callbackMetadata,
  })

  c.executionCtx.waitUntil((async () => {
    try {
      const { recordSchedulerCallbackComputeProfile } = await import('../lib/computeProfileEvents')
      await recordSchedulerCallbackComputeProfile(c.env, {
        task: String(body.task),
        status: String(body.status),
        durationMs: Number(body.duration_ms ?? 0),
        runDate: schedulerRunDate,
        runId: callbackRunId,
        metadata: callbackMetadata,
      })
    } catch (e) {
      console.warn('[scheduler-callback] compute profile event failed:', e)
    }
  })())

  if (
    String(body.task) !== 'optuna-queue' &&
    REPORT_ARTIFACT_TASKS.has(String(body.task)) &&
    body.status === 'success' &&
    schedulerRunDate &&
    callbackRunId
  ) {
    c.executionCtx.waitUntil((async () => {
      try {
        const { recordSchedulerRunReportArtifact } = await import('../lib/datasetSnapshots')
        await recordSchedulerRunReportArtifact(c.env, {
          task: String(body.task),
          status: String(body.status),
          businessDate: schedulerRunDate,
          runId: callbackRunId,
          summary: callbackSummary,
          durationMs: Number(body.duration_ms ?? 0),
          error: body.error != null ? String(body.error) : undefined,
          metadata: callbackMetadata,
        })
      } catch (e) {
        console.warn('[scheduler-callback] R2 scheduler report artifact failed:', e)
      }
    })())
  }

  if (
    (String(body.task) === 'weekly-optuna' || String(body.task) === 'monthly-optuna') &&
    body.status === 'success'
  ) {
    c.executionCtx.waitUntil((async () => {
      try {
        const candidateIds = Array.isArray(callbackMetadata?.candidate_ids)
          ? callbackMetadata.candidate_ids.map((id: unknown) => String(id)).filter(Boolean)
          : []
        const { runParameterCandidateValidationChain } = await import('../lib/controllerResearchWorkflows')
        const summary = await runParameterCandidateValidationChain(c.env, {
          cadence: String(callbackMetadata?.cadence ?? String(body.task).replace('-optuna', '')),
          runDate: callbackRunDate,
          runId: callbackRunId,
          candidateIds,
          source: String(body.task),
          metadata: callbackMetadata,
        })
        await logSchedulerResult(c.env.KV, 'parameter-candidate-validation', {
          status: classifySchedulerSummary(summary),
          summary,
          duration_ms: 0,
          run_id: callbackRunId,
          run_date: schedulerRunDate,
        }, c.env as any)
      } catch (e: any) {
        await logSchedulerResult(c.env.KV, 'parameter-candidate-validation', {
          status: 'error',
          summary: e?.message ?? 'parameter candidate validation chain failed',
          duration_ms: 0,
          error: String(e),
          run_id: callbackRunId,
          run_date: schedulerRunDate,
        }, c.env as any)
      }
    })())
  }

  if (
    String(body.task) === 'weekly-backtest' &&
    body.status === 'success' &&
    String(callbackMetadata?.source ?? '') === 'backtest_research_bundle'
  ) {
    c.executionCtx.waitUntil((async () => {
      try {
        const { runWeeklyModelArtifactValidation } = await import('../lib/controllerResearchWorkflows')
        const summary = await runWeeklyModelArtifactValidation(c.env)
        await logSchedulerResult(c.env.KV, 'model-artifact-validation', {
          status: classifySchedulerSummary(summary),
          summary,
          duration_ms: 0,
          run_id: callbackRunId,
          run_date: schedulerRunDate,
        }, c.env as any)
      } catch (e: any) {
        await logSchedulerResult(c.env.KV, 'model-artifact-validation', {
          status: 'error',
          summary: e?.message ?? 'model artifact validation after weekly-backtest callback failed',
          duration_ms: 0,
          error: String(e),
          run_id: callbackRunId,
          run_date: schedulerRunDate,
        }, c.env as any)
      }
    })())
  }

  if (body.task === 'pipeline' && ['success', 'error', 'skipped'].includes(String(body.status))) {
    try {
      if (callbackRunDate) {
        await c.env.KV.delete(`lock:ml-predict:${callbackRunDate}`).catch(() => {})
      }
      if (body.status === 'success') {
        c.executionCtx.waitUntil((async () => {
          try {
            const { runPostPipelineCallbackChain } = await import('../lib/postMarketChain')
            await runPostPipelineCallbackChain(c.env, {
              runDate: callbackRunDate,
              upstreamRunId: callbackRunId,
            })
          } catch (e: any) {
            await logSchedulerResult(c.env.KV, 'post-pipeline-chain', {
              status: 'error',
              summary: e?.message ?? 'post-pipeline callback chain failed',
              duration_ms: 0,
              error: String(e),
              run_id: callbackRunId,
              run_date: callbackRunDate,
            }, c.env as any)
          }
        })())
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
    }
  }

  if (body.task === 'verify-v2' && body.status === 'success' && c.env.ML_CONTROLLER_URL) {
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
      }
    })())
  }

  console.log(
    `[scheduler-callback] ${body.task} ${body.status} ` +
    `run_id=${body.run_id ?? '-'} duration=${body.duration_ms}ms`,
  )

  return c.json({ ok: true, task: body.task, status: body.status, optuna_closure: optunaClosure })
}

adminControlRoutes.post('/api/admin/scheduler-callback', handleSchedulerCallback)
adminControlRoutes.post('/api/admin/cron-callback', handleSchedulerCallback)
