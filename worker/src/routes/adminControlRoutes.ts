import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'
import { requireAdminOrServiceToken } from '../lib/auth'
import { resolveFinLabDispatchFence } from '../lib/finLabDispatchFence'
import { writeEvidenceArtifact } from '../lib/artifactLifecycle'
import type { EvidenceArtifactWriteInput } from '../lib/evidenceArtifactContract'
import { normalizeSingleD1BatchStatement } from '../lib/d1BatchStatement'
import { markPipelineStage, queuePostPipelineStage, queuePostVerifyStage } from '../lib/pipelineStageLease'

export const adminControlRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const REPORT_ARTIFACT_TASKS = new Set([
  'screener',
  'pipeline',
  'finlab-v4-backfill',
  'backtest',
  'weekly-optuna',
  'optuna-per-regime',
  'optuna-queue',
  'pbo',
  'monte-carlo',
  'alpha-quality',
  'weekly-audit',
  'lifecycle',
  'monthly-optuna',
  'parameter-candidate-validation',
  'monthly-strategy-mining',
  'monthly-retrain',
  'external-evidence',
])

function requireServiceToken(c: any) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token || token !== c.env.STOCKVISION_AUTH_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  return null
}

function normalizeD1BatchStatement(raw: any, index: number) {
  const sql = normalizeSingleD1BatchStatement(raw?.sql, index)
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

function parseScreenerArtifactInput(body: any): EvidenceArtifactWriteInput {
  if (!body || typeof body !== 'object') throw new Error('JSON object body is required')
  const schemaByDomain = new Map<string, Set<string>>([
    ['screener_funnel', new Set([
      'screener-funnel-evidence-v2',
      'screener-funnel-evidence-v3',
      'screener-funnel-evidence-index-v1',
    ])],
    ['screener_funnel_chunk', new Set(['screener-funnel-evidence-chunk-v1'])],
  ])
  const allowedSchemas = schemaByDomain.get(body.domain)
  if (!allowedSchemas) throw new Error('domain must be screener_funnel or screener_funnel_chunk')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.businessDate ?? ''))) {
    throw new Error('businessDate must use YYYY-MM-DD')
  }
  if (typeof body.producerRunId !== 'string' || !body.producerRunId.trim() || body.producerRunId.length > 200) {
    throw new Error('producerRunId is required and must be <= 200 characters')
  }
  if (!['canonical_model_evidence', 'failed_debug'].includes(body.retentionClass)) {
    throw new Error('invalid screener retentionClass')
  }
  if (!allowedSchemas.has(body.schemaVersion)) throw new Error('invalid screener schemaVersion')
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    throw new Error('payload must be an object')
  }
  const rowCount = Number(body.rowCount)
  if (!Number.isInteger(rowCount) || rowCount < 0 || rowCount > 5000) {
    throw new Error('rowCount must be an integer between 0 and 5000')
  }
  if (body.metadata != null && (typeof body.metadata !== 'object' || Array.isArray(body.metadata))) {
    throw new Error('metadata must be an object')
  }
  if (body.domain === 'screener_funnel_chunk') {
    const chunkIndex = Number(body.payload.chunk_index)
    const chunkCount = Number(body.payload.chunk_count)
    const rowStart = Number(body.payload.row_start)
    const rowEnd = Number(body.payload.row_end_exclusive)
    if (
      body.payload.storage_mode !== 'chunked_r2_child_v1'
      || body.payload.logical_domain !== 'screener_funnel'
      || ![
        'screener-funnel-evidence-v2',
        'screener-funnel-evidence-v3',
      ].includes(body.payload.logical_schema_version)
      || !Array.isArray(body.payload.items)
      || body.payload.items.length !== rowCount
      || !Number.isInteger(chunkIndex)
      || !Number.isInteger(chunkCount)
      || chunkIndex < 0
      || chunkCount <= chunkIndex
      || !Number.isInteger(rowStart)
      || !Number.isInteger(rowEnd)
      || rowStart < 0
      || rowEnd - rowStart !== rowCount
    ) {
      throw new Error('invalid screener chunk payload')
    }
  }
  if (body.schemaVersion === 'screener-funnel-evidence-index-v1') {
    const chunks = body.payload.chunks
    if (
      body.payload.storage_mode !== 'chunked_r2_manifest_v1'
      || ![
        'screener-funnel-evidence-v2',
        'screener-funnel-evidence-v3',
      ].includes(body.payload.logical_schema_version)
      || !/^sha256:[a-f0-9]{64}$/i.test(String(body.payload.logical_payload_checksum ?? ''))
      || !body.payload.payload_header
      || typeof body.payload.payload_header !== 'object'
      || Array.isArray(body.payload.payload_header)
      || !Array.isArray(chunks)
      || Number(body.payload.item_count) !== rowCount
      || !chunks.length
    ) {
      throw new Error('invalid screener chunk manifest payload')
    }
    let expectedRowStart = 0
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]
      const rowStart = Number(chunk?.row_start)
      const rowEnd = Number(chunk?.row_end_exclusive)
      if (
        !chunk
        || typeof chunk !== 'object'
        || Number(chunk.chunk_index) !== index
        || rowStart !== expectedRowStart
        || !Number.isInteger(rowEnd)
        || rowEnd < rowStart
        || Number(chunk.row_count) !== rowEnd - rowStart
        || typeof chunk.artifact_id !== 'string'
        || !chunk.artifact_id.startsWith('artifact:screener_funnel_chunk:')
        || typeof chunk.r2_key !== 'string'
        || !chunk.r2_key.includes('/domain=screener_funnel_chunk/')
        || !/^sha256:[a-f0-9]{64}$/i.test(String(chunk.checksum ?? ''))
        || chunk.schema_version !== 'screener-funnel-evidence-chunk-v1'
      ) {
        throw new Error(`invalid screener chunk manifest entry:${index}`)
      }
      expectedRowStart = rowEnd
    }
    if (expectedRowStart !== rowCount) throw new Error('screener chunk manifest row coverage mismatch')
  }
  return {
    domain: body.domain,
    businessDate: body.businessDate,
    producerRunId: body.producerRunId.trim(),
    retentionClass: body.retentionClass,
    schemaVersion: body.schemaVersion,
    payload: body.payload,
    rowCount,
    canonicalRunId: typeof body.canonicalRunId === 'string' ? body.canonicalRunId : null,
    metadata: body.metadata ?? {},
    createdAt: typeof body.createdAt === 'string' ? body.createdAt : undefined,
  }
}
adminControlRoutes.post('/api/internal/evidence-artifacts/screener-funnel', async (c) => {
  const authError = requireServiceToken(c)
  if (authError) return authError
  if (!c.env.ARTIFACTS) return c.json({ error: 'artifact_r2_binding_missing' }, 503)

  const body = await c.req.json().catch(() => null)
  let input: EvidenceArtifactWriteInput
  try {
    input = parseScreenerArtifactInput(body)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'invalid artifact input' }, 400)
  }

  const manifest = await writeEvidenceArtifact(c.env, input)
  return c.json({ ok: true, manifest })
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
  const authError = await requireServiceToken(c)
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
  const callbackAttemptId = typeof body.attempt_id === 'string' ? body.attempt_id : undefined
  const callbackMetadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : undefined

  if (body.task === 'finlab-v4-backfill' && callbackRunDate) {
    const current = await c.env.KV.get(
      `scheduler:run:finlab-v4-backfill:${callbackRunDate}`,
      'json',
    ) as { run_id?: string; summary?: string } | null
    const fence = resolveFinLabDispatchFence({
      activeRunId: current?.run_id,
      activeSummary: current?.summary,
      incomingRunId: callbackRunId,
      incomingAttempt: body.dispatch_attempt ?? body.metadata?.dispatch_attempt,
    })
    if (fence.ignored) {
      return c.json({
        success: true,
        ignored: true,
        reason: fence.reason,
        run_id: callbackRunId,
        dispatch_attempt: fence.incomingAttempt,
        active_run_id: current?.run_id ?? null,
        active_dispatch_attempt: fence.activeAttempt,
      })
    }
  }

  await logSchedulerResult(c.env.KV, String(body.task), {
    status: body.status,
    summary: String(body.summary ?? ''),
    duration_ms: Number(body.duration_ms ?? 0),
    error: body.error != null ? String(body.error) : undefined,
    run_id: callbackRunId,
    attempt_id: callbackAttemptId,
    run_date: callbackRunDate,
  })

  if (body.task === 'optuna-per-regime' && ['success', 'error', 'skipped'].includes(String(body.status))) {
    const queueEntryId = nullableText(body.queue_entry_id ?? body.metadata?.queue_entry_id)
    if (queueEntryId && callbackRunId) {
      const { closeOptunaRunD1Lock, settleTriggeredEntry } = await import('../lib/optunaQueue')
      const settled = await settleTriggeredEntry(c.env.KV, {
        id: queueEntryId,
        run_id: callbackRunId,
        outcome: body.status,
        sandbox_id: nullableText(body.sandbox_id ?? body.result?.push?.sandbox_id) ?? undefined,
        note: `callback_${body.status} run_id=${callbackRunId} summary=${String(body.summary ?? '').slice(0, 240)}`,
        error: body.error != null ? String(body.error) : undefined,
        max_retries: 3,
      })
      if (settled.applied) {
        await closeOptunaRunD1Lock(c.env.DB, queueEntryId, String(body.status))
      } else {
        console.warn(
          `[scheduler-callback] ignored optuna-per-regime callback queue_entry_id=${queueEntryId} ` +
          `run_id=${callbackRunId} reason=${settled.reason}`,
        )
      }
    }
  }
  if (
    (String(body.task) === 'weekly-optuna' || String(body.task) === 'monthly-optuna') &&
    body.status === 'success'
  ) {
    c.executionCtx.waitUntil((async () => {
      try {
        const metadataCandidateIds = Array.isArray(callbackMetadata?.candidate_ids)
          ? callbackMetadata.candidate_ids.map((id: unknown) => String(id)).filter(Boolean)
          : []
        const candidateIds = metadataCandidateIds.length > 0
          ? metadataCandidateIds
          : (typeof body.candidate_id === 'string' && body.candidate_id ? [body.candidate_id] : [])
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
          run_date: callbackRunDate,
        })
      } catch (error: any) {
        await logSchedulerResult(c.env.KV, 'parameter-candidate-validation', {
          status: 'error',
          summary: error?.message ?? 'parameter candidate validation chain failed',
          duration_ms: 0,
          error: String(error),
          run_id: callbackRunId,
          run_date: callbackRunDate,
        })
      }
    })())
  }
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

  if (body.task === 'screener' && ['success', 'error', 'skipped'].includes(String(body.status))) {
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
    const chainRunId = typeof body.chain_run_id === 'string'
      ? body.chain_run_id
      : typeof metadata.chain_run_id === 'string'
        ? metadata.chain_run_id
        : undefined
    const shouldContinue = Boolean(
      chainRunId ||
      body.continue_post_screener_pipeline ||
      metadata.continue_post_screener_pipeline,
    )

    if (callbackRunDate) {
      await c.env.KV.delete(`lock:screener:${callbackRunDate}`).catch(() => {})
    }

    if (body.status === 'success' && callbackRunDate && shouldContinue) {
      const continuationRunId = chainRunId || callbackRunId || `screener-callback-${callbackRunDate}`
      const { enqueuePostScreenerPipelineContinuation } = await import('../lib/postScreenerContinuation')
      await enqueuePostScreenerPipelineContinuation(c.env, {
        triggerTime: callbackRunDate,
        runId: continuationRunId,
        shardCount: Number(body.shard_count ?? metadata.shard_count ?? 1),
        source: 'screener-v2-callback',
        summary: `event-driven chain accepted screener-v2 callback for ${callbackRunDate}; screener_run_id=${callbackRunId ?? 'n/a'}; chain_run_id=${continuationRunId}`,
      })
    } else if (body.status !== 'success' && callbackRunDate && shouldContinue) {
      await logSchedulerResult(c.env.KV, 'evening-chain', {
        status: body.status === 'skipped' ? 'skipped' : 'error',
        summary: `root chain stopped at screener callback: ${String(body.summary ?? body.status)}`,
        duration_ms: 0,
        error: body.error != null ? String(body.error) : undefined,
        run_id: chainRunId || callbackRunId,
        run_date: callbackRunDate,
      }, c.env as any)
    }
  }

  if (
    body.task === 'allocator-ev-feature-snapshot-backfill'
    && ['success', 'error', 'skipped'].includes(String(body.status))
  ) {
    if (!callbackRunDate || !callbackRunId) {
      return c.json({ error: 'allocator snapshot callback missing run_date or run_id' }, 400)
    }
    if (body.status === 'success') {
      const continuation = await queuePostPipelineStage(c.env, {
        businessDate: callbackRunDate,
        runId: callbackRunId,
        resumeWaiting: true,
      })
      await logSchedulerResult(c.env.KV, 'post-pipeline-chain', {
        status: 'triggered',
        summary: continuation.queued
          ? `snapshot callback resumed canonical stage run_id=${continuation.canonicalRunId}`
          : `snapshot callback observed canonical stage status=${continuation.status} run_id=${continuation.canonicalRunId}`,
        duration_ms: 0,
        run_id: continuation.canonicalRunId,
        run_date: callbackRunDate,
      }, c.env as any)
    } else {
      await logSchedulerResult(c.env.KV, 'evening-chain', {
        status: body.status === 'skipped' ? 'skipped' : 'error',
        summary: `root chain stopped at allocator snapshot callback: ${String(body.summary ?? body.status)}`,
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
        if (!callbackRunDate || !callbackRunId) {
          throw new Error('pipeline callback missing run_date or run_id for post-pipeline continuation')
        }
        const continuation = await queuePostPipelineStage(c.env, {
          businessDate: callbackRunDate,
          runId: callbackRunId,
        })
        await logSchedulerResult(c.env.KV, 'post-pipeline-chain', {
          status: 'triggered',
          summary: continuation.queued
            ? `post-pipeline canonical stage durably queued run_id=${continuation.canonicalRunId}`
            : `post-pipeline canonical stage already status=${continuation.status} run_id=${continuation.canonicalRunId}`,
          duration_ms: 0,
          run_id: continuation.canonicalRunId,
          run_date: callbackRunDate,
        }, c.env as any)
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
    if (!callbackRunDate || !callbackRunId) {
      return c.json({ error: 'verify callback missing run_date or run_id for post-verify continuation' }, 400)
    }
    await markPipelineStage(c.env.DB, {
      businessDate: callbackRunDate,
      stage: 'verify_v2',
      status: 'success',
    })
    const continuation = await queuePostVerifyStage(c.env, {
      businessDate: callbackRunDate,
      runId: callbackRunId,
      resumeWaiting: true,
    })
    await logSchedulerResult(c.env.KV, 'post-verify-chain', {
      status: 'triggered',
      summary: continuation.queued
        ? `post-verify continuation durably queued run_id=${continuation.canonicalRunId}`
        : `post-verify continuation already ${continuation.status} run_id=${continuation.canonicalRunId}`,
      duration_ms: 0,
      run_id: callbackRunId,
      run_date: callbackRunDate,
    }, c.env as any)
  }

  if (body.task === 'verify-v2' && String(body.status) === 'error') {
    if (callbackRunDate) {
      await markPipelineStage(c.env.DB, {
        businessDate: callbackRunDate,
        stage: 'verify_v2',
        status: 'error',
        error: body.error != null ? String(body.error) : String(body.summary ?? 'verify-v2 callback failed'),
      })
    }
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
