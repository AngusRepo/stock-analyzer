import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'
import { hasServiceToken, requireAdminOrServiceToken } from '../lib/auth'
import { databaseForDataDomain } from '../lib/dataDomainRegistry'
import { resolveFinLabDispatchFence } from '../lib/finLabDispatchFence'
import { writeEvidenceArtifact } from '../lib/artifactLifecycle'
import type { EvidenceArtifactWriteInput } from '../lib/evidenceArtifactContract'
import { normalizeSingleD1BatchStatement } from '../lib/d1BatchStatement'
import {
  handleStrategyMiningCallback,
  handleStrategyMiningD1Gateway,
} from '../lib/strategyMiningGateway'
import {
  LegacyEvidenceResolveError,
  resolveLegacyScreenerEvidence,
} from '../lib/legacyEvidenceResolver'
import { isTransientD1Reset } from '../lib/d1TransientRetry'
import {
  acceptPipelineExecutionCallback,
  isPipelineStageCanonicalState,
  markPipelineStageFenced,
  queuePostPipelineStage,
  queuePostVerifyStage,
} from '../lib/pipelineStageLease'

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
  'external-evidence',
])

function requireServiceToken(c: any) {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  if (!hasServiceToken(token, c.env.STOCKVISION_AUTH_TOKEN, c.env.STOCKVISION_AUTH_TOKEN_PREVIOUS)) {
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

adminControlRoutes.post('/api/internal/strategy-mining/d1', handleStrategyMiningD1Gateway)
adminControlRoutes.post('/api/internal/strategy-mining/callback', handleStrategyMiningCallback)

export function parseScreenerArtifactInput(body: any): EvidenceArtifactWriteInput {
  if (!body || typeof body !== 'object') throw new Error('JSON object body is required')
  const schemaByDomain = new Map<string, Set<string>>([
    ['screener_funnel', new Set([
      'screener-funnel-evidence-v2',
      'screener-funnel-evidence-v3',
      'screener-funnel-evidence-index-v1',
    ])],
    ['screener_funnel_chunk', new Set(['screener-funnel-evidence-chunk-v1'])],
    ['strategy_redundancy_oof', new Set(['strategy-redundancy-oof-evidence-v1'])],
    ["strategy_route_recovery", new Set(["strategy-route-recovery-packet-v1"])],
    ['s12_research_minute_bars', new Set(['s12-research-minute-bars-v2'])],
    ['s12_structure_batch', new Set(['s12-structure-batch-summary-v1'])],
  ])
  const allowedSchemas = schemaByDomain.get(body.domain)
  if (!allowedSchemas) throw new Error('artifact domain is not allowed')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.businessDate ?? ''))) {
    throw new Error('businessDate must use YYYY-MM-DD')
  }
  if (typeof body.producerRunId !== 'string' || !body.producerRunId.trim() || body.producerRunId.length > 200) {
    throw new Error('producerRunId is required and must be <= 200 characters')
  }
  const retentionByDomain = new Map<string, Set<string>>([
    ['screener_funnel', new Set(['canonical_model_evidence', 'failed_debug'])],
    ['screener_funnel_chunk', new Set(['canonical_model_evidence', 'failed_debug'])],
    ['strategy_redundancy_oof', new Set(['canonical_model_evidence'])],
    ["strategy_route_recovery", new Set(["canonical_model_evidence"])],
    ['s12_research_minute_bars', new Set(['raw_market_unreferenced'])],
    ['s12_structure_batch', new Set(['canonical_model_evidence', 'paper_shadow', 'failed_debug'])],
  ])
  if (!retentionByDomain.get(body.domain)?.has(body.retentionClass)) {
    throw new Error('invalid artifact retentionClass for domain')
  }
  if (!allowedSchemas.has(body.schemaVersion)) throw new Error('invalid screener schemaVersion')
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    throw new Error('payload must be an object')
  }
  const rowCount = Number(body.rowCount)
  const isScreenerLogicalIndex = body.domain === 'screener_funnel'
    && body.schemaVersion === 'screener-funnel-evidence-index-v1'
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || (!isScreenerLogicalIndex && rowCount > 5000)) {
    throw new Error('rowCount must be an integer between 0 and 5000')
  }
  if (body.metadata != null && (typeof body.metadata !== 'object' || Array.isArray(body.metadata))) {
    throw new Error('metadata must be an object')
  }
  if (body.domain === 'strategy_redundancy_oof') {
    const payload = body.payload
    if (
      payload.schema_version !== 'strategy-similarity-evidence-v1'
      || !['computed', 'blocked'].includes(String(payload.status ?? ''))
      || payload.source !== 'modal_python'
      || payload.evidence_only !== true
      || payload.production_selector !== false
      || payload.production_decision_path !== false
      || payload.method !== 'networkx_connected_components_oof_residual_correlation'
      || payload.input_scope !== 'mature_oof_residual_returns_with_same_day_overlap_diagnostic'
      || !Number.isInteger(Number(payload.strategy_count))
      || Number(payload.strategy_count) < 1
      || Number(payload.eligible_oof_pair_count) !== rowCount
      || !payload.strategy_cluster_id
      || typeof payload.strategy_cluster_id !== 'object'
      || Array.isArray(payload.strategy_cluster_id)
      || !payload.pairwise_oof_evidence
      || typeof payload.pairwise_oof_evidence !== 'object'
      || Array.isArray(payload.pairwise_oof_evidence)
    ) {
      throw new Error('invalid strategy redundancy OOF artifact payload')
    }
  }
  if (body.domain === "strategy_route_recovery") {
    const payload = body.payload
    if (
      payload.schema_version !== "strategy-route-recovery-packet-v1"
      || payload.reference_contract_version !== "selection-reference-snapshot-v3"
      || payload.route_version !== "strategy-semantic-continuous-affinity-v5"
      || payload.affinity_version !== "strategy-threshold-margin-affinity-v2"
      || !/^sha256:[a-f0-9]{64}$/i.test(String(payload.strategy_registry_checksum ?? ""))
      || !/^sha256:[a-f0-9]{64}$/i.test(String(payload.input_packet_checksum ?? ""))
      || !/^sha256:[a-f0-9]{64}$/i.test(String(payload.route_score_parity_checksum ?? ""))
      || !Array.isArray(payload.route_scores)
      || Number(payload.candidate_count) !== rowCount
      || Number(payload.route_score_count) !== rowCount
      || payload.route_scores.length !== rowCount
    ) {
      throw new Error("invalid strategy route recovery artifact payload")
    }
  }
  if (body.domain === 's12_research_minute_bars') {
    if (
      typeof body.payload.symbol !== 'string'
      || !Array.isArray(body.payload.bars)
      || body.payload.bars.length !== rowCount
    ) {
      throw new Error('invalid S12 research bars artifact payload')
    }
  }
  if (body.domain === 's12_structure_batch') {
    if (
      body.payload.schema_version !== 's12-durable-structure-batch-summary-v1'
      || typeof body.payload.run_id !== 'string'
      || Number(body.payload.candidate_count) !== rowCount
      || body.payload.coverage_passed !== true
    ) {
      throw new Error('invalid S12 structure batch artifact payload')
    }
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
        || Number(chunk.row_count) > 5000
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

adminControlRoutes.post('/api/internal/evidence-artifacts/s12-research/read', async (c) => {
  const authError = requireServiceToken(c)
  if (authError) return authError
  if (!c.env.ARTIFACTS) return c.json({ error: 'artifact_r2_binding_missing' }, 503)
  const body = await c.req.json().catch(() => null) as { r2_key?: unknown } | null
  const r2Key = typeof body?.r2_key === 'string' ? body.r2_key.trim() : ''
  if (!/^evidence\/class=raw_market_unreferenced\/domain=s12_research_minute_bars\//.test(r2Key)) {
    return c.json({ error: 'invalid_s12_research_artifact_key' }, 400)
  }
  const manifest = await databaseForDataDomain(c.env, 'ops').prepare(`
    SELECT artifact_id
      FROM run_artifacts
     WHERE r2_key=?
       AND domain='s12_research_minute_bars'
       AND schema_version='s12-research-minute-bars-v2'
       AND retention_class='raw_market_unreferenced'
       AND status='ready'
     LIMIT 1
  `).bind(r2Key).first<{ artifact_id?: string }>()
  if (!manifest?.artifact_id) return c.json({ error: 'artifact_manifest_not_found' }, 404)
  const object = await c.env.ARTIFACTS.get(r2Key)
  if (!object) return c.json({ error: 'artifact_object_not_found' }, 404)
  return c.json({ ok: true, body: await object.text() })
})

adminControlRoutes.post('/api/internal/evidence-artifacts/legacy-screener/resolve', async (c) => {
  const authError = requireServiceToken(c)
  if (authError) return authError
  if (!c.env.ARTIFACTS) return c.json({ error: 'artifact_r2_binding_missing' }, 503)

  const body = await c.req.json().catch(() => null) as any
  try {
    const result = await resolveLegacyScreenerEvidence(c.env, body?.artifacts)
    return c.json({ ok: true, ...result })
  } catch (error) {
    const status = error instanceof LegacyEvidenceResolveError ? error.statusCode : 500
    const message = error instanceof Error ? error.message : 'legacy_evidence_resolve_failed'
    return c.json({ error: message }, status as any)
  }
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

  const learningDb = databaseForDataDomain(c.env, 'learning')
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
      statements.push(learningDb.prepare(sql).bind(
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
  const results = await learningDb.batch(statements)
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

adminControlRoutes.post('/api/internal/state-space-v2/callback', async (c) => {
  const authError = requireServiceToken(c)
  if (authError) return authError

  const packet = await c.req.json().catch(() => null)
  const learningDb = databaseForDataDomain(c.env, 'learning')
  const marketDb = databaseForDataDomain(c.env, 'market')
  const { persistStateSpaceV2Packet, matureStateSpaceV2Evidence } = await import('../lib/stateSpaceV2Evidence')
  try {
    const persisted = await persistStateSpaceV2Packet(learningDb, packet)
    const throughDate = String((packet as any)?.as_of_date ?? '')
    const maturity = await matureStateSpaceV2Evidence(learningDb, marketDb, throughDate)
    return c.json({
      ok: true,
      mode: 'state_space_v2_observation_only',
      production_effect: false,
      persisted,
      maturity,
    })
  } catch (error: any) {
    return c.json({
      ok: false,
      error: error?.message ?? String(error),
      mode: 'state_space_v2_observation_only',
      production_effect: false,
    }, 409)
  }
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
  let active8FreshnessStatus: string | null = null
  let active8FreshnessBusinessDate: string | null = null
  let screenerCallbackMetadata: Record<string, any> = {}
  let screenerChainRunId: string | undefined
  let screenerShouldContinue = false
  let screenerCallbackLineageAccepted = false

  if (
    body.task === 'weekly-backtest'
    && ['success', 'error', 'skipped'].includes(String(body.status))
  ) {
    if (!callbackRunDate || !callbackRunId) {
      return c.json({ error: 'weekly backtest callback missing run_date or run_id' }, 400)
    }
    const { acceptWeeklyBacktestCallback } = await import('../lib/weeklyResearchRunFence')
    const fence = await acceptWeeklyBacktestCallback(databaseForDataDomain(c.env, 'ops'), {
      runDate: callbackRunDate,
      runId: callbackRunId,
      callbackStatus: String(body.status),
    })
    if (!fence.accepted) {
      return c.json({
        success: false,
        ignored: true,
        reason: fence.reason,
        incoming_run_id: callbackRunId,
        active_run_id: fence.activeRunId,
      }, 409)
    }
  }

  if (['active8-oof-daily', 'active8-oof-weekly', 'active8-oof-monthly'].includes(body.task)) {
    const { persistActive8OofFreshnessAudit } = await import('../lib/active8OofFreshness')
    const freshnessEvidence = callbackMetadata?.oof_freshness
    const freshnessBusinessDate = freshnessEvidence && typeof freshnessEvidence === 'object'
      && typeof (freshnessEvidence as Record<string, unknown>).business_date === 'string'
      ? String((freshnessEvidence as Record<string, unknown>).business_date).slice(0, 10)
      : null
    const freshness = await persistActive8OofFreshnessAudit(c.env, {
      task: body.task,
      runId: callbackRunId,
      attemptId: callbackAttemptId,
      runDate: callbackRunDate,
      cadence: typeof callbackMetadata?.cadence === 'string' ? callbackMetadata.cadence : undefined,
      callbackStatus: body.status,
      evidence: freshnessEvidence,
    })
    active8FreshnessStatus = freshness.status
    active8FreshnessBusinessDate = freshnessBusinessDate
    if (body.status === 'success' && freshness.status !== 'fresh') {
      body.status = 'error'
      body.error = [
        'active8_oof_freshness_closure_failed',
        freshness.reason,
        `expected=${freshness.expectedMaxDate ?? 'missing'}`,
        `effective=${freshness.effectiveMaxDate ?? 'missing'}`,
      ].join(':')
      body.summary = `${String(body.summary ?? '')} ${body.error}`.trim()
    }
    const lifecycleStatus = String(callbackMetadata?.lifecycle_status ?? '').toLowerCase()
    const cadence = String(callbackMetadata?.cadence ?? '').toLowerCase()
    const continuationAttempt = Math.max(0, Number(callbackMetadata?.continuation_attempt ?? 0))
    const continuationMaxAttempts = Math.max(1, Number(callbackMetadata?.continuation_max_attempts ?? 12))
    const expectedCohortId = String(callbackMetadata?.cohort_id ?? '').trim()
    if (
      body.status === 'triggered'
      && ['weekly', 'monthly'].includes(cadence)
      // callback_status=triggered is emitted only while the weekly/monthly
      // cohort or its bound full-fit dependency still needs a continuation.
      // A cohort may already be materialized while the Modal full-fit remains
      // active, so lifecycleStatus must not narrow the durable retry here.
      && ['pending', 'spawned', 'materialized', 'shadow_evaluated'].includes(lifecycleStatus)
      && callbackRunDate
      && expectedCohortId
      && continuationAttempt < continuationMaxAttempts
    ) {
      await c.env.UPDATE_QUEUE.send({
        type: 'active8_oof_continuation',
        cursor: 0,
        triggerTime: callbackRunDate,
        runId: callbackRunId,
        oofCadence: cadence as 'weekly' | 'monthly',
        oofExpectedCohortId: expectedCohortId,
        oofContinuationAttempt: continuationAttempt + 1,
      }, { delaySeconds: 300 })
    }
  }

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

  if (body.task === 'screener' && ['success', 'error', 'skipped'].includes(String(body.status))) {
    screenerCallbackMetadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, any>
      : {}
    screenerChainRunId = typeof body.chain_run_id === 'string'
      ? body.chain_run_id
      : typeof screenerCallbackMetadata.chain_run_id === 'string'
        ? screenerCallbackMetadata.chain_run_id
        : undefined
    screenerShouldContinue = Boolean(
      screenerChainRunId
      || body.continue_post_screener_pipeline
      || screenerCallbackMetadata.continue_post_screener_pipeline,
    )
    screenerCallbackLineageAccepted = !screenerShouldContinue
    if (screenerShouldContinue) {
      if (!callbackRunDate || !screenerChainRunId || !callbackRunId) {
        return c.json({
          error: 'screener callback missing run_date, chain_run_id, or producer run_id',
        }, 400)
      }
      const { recordCanonicalScreenerCallback } = await import('../lib/screenerRecoveryWatchdog')
      const receipt = await recordCanonicalScreenerCallback(databaseForDataDomain(c.env, 'ops'), {
        businessDate: callbackRunDate,
        canonicalRunId: screenerChainRunId,
        producerRunId: callbackRunId,
        status: body.status,
        error: String(body.error ?? body.summary ?? body.status),
      })
      if (!receipt.accepted) {
        return c.json({
          success: false,
          ignored: true,
          reason: receipt.reason,
          canonical_run_id: receipt.canonicalRunId,
          producer_run_id: receipt.producerRunId,
        }, 409)
      }
      screenerCallbackLineageAccepted = true
    }
  }

  const criticalTerminalCallback = ['pipeline', 'allocator-ev-feature-snapshot-backfill', 'verify-v2']
    .includes(String(body.task))
    && ['success', 'error', 'skipped'].includes(String(body.status))
  let verifyCallbackCanonicalRunId: string | null = null
  if (criticalTerminalCallback) {
    if (!callbackRunDate || !callbackRunId) {
      return c.json({ error: 'critical callback missing run_date or run_id' }, 400)
    }
    if (body.task === 'pipeline') {
      const accepted = await acceptPipelineExecutionCallback(databaseForDataDomain(c.env, 'ops'), {
        businessDate: callbackRunDate,
        runId: callbackRunId,
        status: body.status === 'success' ? 'success' : 'error',
        error: body.error != null ? String(body.error) : null,
      })
      if (!accepted) {
        const current = await databaseForDataDomain(c.env, 'ops').prepare(`
          SELECT canonical_run_id
            FROM pipeline_stage_runs
           WHERE business_date=? AND stage='pipeline_execution'
        `).bind(callbackRunDate).first() as { canonical_run_id?: string | null } | null
        return c.json({
          success: false,
          ignored: true,
          reason: 'stale_pipeline_callback',
          incoming_run_id: callbackRunId,
          active_run_id: current?.canonical_run_id ?? null,
        }, 409)
      }
    } else {
      const stageName = body.task === 'verify-v2' ? 'verify_v2' : 'post_pipeline_chain'
      const stage = await databaseForDataDomain(c.env, 'ops').prepare(`
        SELECT canonical_run_id, cursor_key, status
          FROM pipeline_stage_runs
         WHERE business_date=? AND stage=?
      `).bind(callbackRunDate, stageName).first() as {
        canonical_run_id?: string | null
        cursor_key?: string | null
        status?: string | null
      } | null
      const identityMatches = body.task === 'verify-v2'
        ? String(stage?.cursor_key ?? '') === callbackRunId
        : String(stage?.canonical_run_id ?? '') === callbackRunId
      if (!stage || !identityMatches) {
        return c.json({
          success: false,
          ignored: true,
          reason: body.task === 'verify-v2'
            ? 'stale_verify_callback'
            : 'stale_allocator_snapshot_callback',
          incoming_run_id: callbackRunId,
          active_run_id: stage?.canonical_run_id ?? null,
          expected_producer_run_id: stage?.cursor_key ?? null,
        }, 409)
      }
      if (body.task === 'verify-v2') {
        verifyCallbackCanonicalRunId = String(stage.canonical_run_id ?? '').trim() || null
      }
    }
  }

  const logAcceptedCallbackTask = () => logSchedulerResult(c.env.KV, String(body.task), {
    status: body.status,
    summary: String(body.summary ?? ''),
    duration_ms: Number(body.duration_ms ?? 0),
    error: body.error != null ? String(body.error) : undefined,
    run_id: callbackRunId,
    attempt_id: callbackAttemptId,
    run_date: callbackRunDate,
  })
  if (!criticalTerminalCallback) await logAcceptedCallbackTask()

  if (
    body.task === 'active8-oof-daily'
    && body.status === 'success'
    && active8FreshnessStatus === 'fresh'
    && callbackRunDate
  ) {
    c.executionCtx.waitUntil((async () => {
      const readinessRunDate = active8FreshnessBusinessDate ?? callbackRunDate
      try {
        const { runDailyAllocatorEvReadiness } = await import('../lib/updateOrchestrator')
        await runDailyAllocatorEvReadiness(c.env, readinessRunDate, {
          knowledgeCutoffDate: callbackRunDate,
          runId: `${callbackRunId ?? `active8-oof-daily:${callbackRunDate}`}:allocator-readiness:${callbackAttemptId ?? Date.now()}`,
          attemptId: callbackAttemptId,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await logSchedulerResult(c.env.KV, 'allocator-ev-readiness', {
          status: 'error',
          summary: `OOF freshness follow-up readiness failed for ${readinessRunDate}: ${message}`,
          duration_ms: 0,
          error: message,
          run_id: callbackRunId,
          run_date: readinessRunDate,
        })
      }
    })())
  }

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
        await closeOptunaRunD1Lock(databaseForDataDomain(c.env, 'ops'), queueEntryId, String(body.status))
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
    if (callbackRunDate) {
      await c.env.KV.delete(`lock:screener:${callbackRunDate}`).catch(() => {})
    }

    if (body.status === 'success' && callbackRunDate && screenerShouldContinue && screenerCallbackLineageAccepted) {
      const continuationRunId = screenerChainRunId || callbackRunId || `screener-callback-${callbackRunDate}`
      const { enqueuePostScreenerPipelineContinuation } = await import('../lib/postScreenerContinuation')
      await enqueuePostScreenerPipelineContinuation(c.env, {
        triggerTime: callbackRunDate,
        runId: continuationRunId,
        shardCount: Number(body.shard_count ?? screenerCallbackMetadata.shard_count ?? 1),
        source: 'screener-v2-callback',
        summary: `event-driven chain accepted screener-v2 callback for ${callbackRunDate}; screener_run_id=${callbackRunId ?? 'n/a'}; chain_run_id=${continuationRunId}`,
      })
    } else if (body.status !== 'success' && callbackRunDate && screenerShouldContinue && screenerCallbackLineageAccepted) {
      await logSchedulerResult(c.env.KV, 'evening-chain', {
        status: body.status === 'skipped' ? 'skipped' : 'error',
        summary: `root chain stopped at screener callback: ${String(body.summary ?? body.status)}`,
        duration_ms: 0,
        error: body.error != null ? String(body.error) : undefined,
        run_id: screenerChainRunId || callbackRunId,
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
        expectedCanonicalRunId: callbackRunId,
      })
      if (continuation.canonicalRunId !== callbackRunId) {
        return c.json({ success: false, ignored: true, reason: 'stale_allocator_snapshot_callback' }, 409)
      }
      await logAcceptedCallbackTask()
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
      const callbackError = String(body.error ?? body.summary ?? body.status)
      const transientD1Failure = body.status === 'error' && isTransientD1Reset(callbackError)
      const stage = transientD1Failure
        ? await databaseForDataDomain(c.env, 'ops').prepare(`
            SELECT attempt_count FROM pipeline_stage_runs
             WHERE business_date=? AND stage='post_pipeline_chain' AND canonical_run_id=?
          `).bind(callbackRunDate, callbackRunId).first() as { attempt_count?: number | string | null } | null
        : null
      const nextAttempt = Math.max(1, Number(stage?.attempt_count ?? 1))
      if (transientD1Failure && nextAttempt < 3) {
        const callbackAttemptId = String(body.attempt_id ?? 'unknown-attempt')
        const retryDedupeKey = `allocator:snapshot-transient-retry:${callbackRunDate}:${callbackRunId}:${callbackAttemptId}`
        const alreadyScheduled = Boolean(await c.env.KV.get(retryDedupeKey))
        const marked = await markPipelineStageFenced(databaseForDataDomain(c.env, 'ops'), {
          businessDate: callbackRunDate,
          stage: 'post_pipeline_chain',
          canonicalRunId: callbackRunId,
          status: 'waiting',
          error: callbackError,
        })
        if (!marked) {
          return c.json({ success: false, ignored: true, reason: 'stale_allocator_snapshot_callback' }, 409)
        }
        if (!alreadyScheduled) {
          await (c.env.UPDATE_QUEUE as any).send({
            type: 'allocator_ev_lifecycle_recovery',
            cursor: 0,
            triggerTime: callbackRunDate,
            runId: callbackRunId,
            attempt: nextAttempt,
          }, { delaySeconds: Math.min(300, 60 * (2 ** (nextAttempt - 1))) })
          await c.env.KV.put(retryDedupeKey, new Date().toISOString(), { expirationTtl: 86400 })
        }
        await logAcceptedCallbackTask()
        await logSchedulerResult(c.env.KV, 'evening-chain', {
          status: 'running',
          summary: `allocator snapshot transient D1 failure scheduled=${!alreadyScheduled} attempt=${nextAttempt}/2; awaiting durable recovery`,
          duration_ms: 0,
          error: callbackError,
          run_id: callbackRunId,
          attempt_id: callbackAttemptId,
          run_date: callbackRunDate,
        }, c.env as any)
      } else {
        const marked = await markPipelineStageFenced(databaseForDataDomain(c.env, 'ops'), {
          businessDate: callbackRunDate,
          stage: 'post_pipeline_chain',
          canonicalRunId: callbackRunId,
          status: 'error',
          error: callbackError,
        })
        if (!marked) {
          return c.json({ success: false, ignored: true, reason: 'stale_allocator_snapshot_callback' }, 409)
        }
        await logAcceptedCallbackTask()
        await logSchedulerResult(c.env.KV, 'evening-chain', {
          status: body.status === 'skipped' ? 'skipped' : 'error',
          summary: `root chain stopped at allocator snapshot callback: ${String(body.summary ?? body.status)}`,
          duration_ms: 0,
          error: body.error != null ? String(body.error) : undefined,
          run_id: callbackRunId,
          attempt_id: body.attempt_id != null ? String(body.attempt_id) : undefined,
          run_date: callbackRunDate,
        }, c.env as any)
      }
    }
  }

  if (body.task === 'pipeline' && ['success', 'error', 'skipped'].includes(String(body.status))) {
    try {
      if (callbackRunDate) {
        const lockKey = `lock:ml-predict:${callbackRunDate}`
        const lockOwner = await c.env.KV.get(lockKey).catch(() => null)
        if (lockOwner === callbackRunId || lockOwner === '1') {
          await c.env.KV.delete(lockKey).catch(() => {})
        }
      }
      if (body.status === 'success') {
        if (!callbackRunDate || !callbackRunId) {
          throw new Error('pipeline callback missing run_date or run_id for post-pipeline continuation')
        }
        const continuation = await queuePostPipelineStage(c.env, {
          businessDate: callbackRunDate,
          runId: callbackRunId,
          authority: {
            stage: 'pipeline_execution',
            canonicalRunId: callbackRunId,
            status: 'success',
          },
        })
        if (continuation.canonicalRunId !== callbackRunId) {
          const ownershipConflict = [
            'post_pipeline_stage_owner_conflict',
            `incoming_run_id=${callbackRunId}`,
            `active_run_id=${continuation.canonicalRunId}`,
            `active_status=${continuation.status}`,
            'root_owner_unchanged=true',
          ].join(':')
          return c.json({
            ok: false,
            retryable: true,
            waiting: true,
            error: 'post_pipeline_stage_owner_conflict',
            incoming_run_id: callbackRunId,
            active_run_id: continuation.canonicalRunId,
            active_status: continuation.status,
            root_owner_unchanged: true,
            detail: ownershipConflict,
          }, 409)
        }
        const executionStillCurrent = await isPipelineStageCanonicalState(databaseForDataDomain(c.env, 'ops'), {
          businessDate: callbackRunDate,
          stage: 'pipeline_execution',
          canonicalRunId: callbackRunId,
          status: 'success',
        })
        if (!executionStillCurrent) {
          return c.json({ success: false, ignored: true, reason: 'stale_pipeline_callback' }, 409)
        }
        await logAcceptedCallbackTask()
        await logSchedulerResult(c.env.KV, 'evening-chain', {
          status: 'running',
          summary: `pipeline terminal success accepted; post-pipeline owner confirmed run_id=${callbackRunId}`,
          duration_ms: 0,
          run_id: callbackRunId,
          run_date: callbackRunDate,
          strict: true,
        }, c.env as any)
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
        const executionStillCurrent = callbackRunDate && callbackRunId
          ? await isPipelineStageCanonicalState(databaseForDataDomain(c.env, 'ops'), {
              businessDate: callbackRunDate,
              stage: 'pipeline_execution',
              canonicalRunId: callbackRunId,
              status: 'error',
            })
          : false
        if (!executionStillCurrent) {
          return c.json({ success: false, ignored: true, reason: 'stale_pipeline_callback' }, 409)
        }
        await logAcceptedCallbackTask()
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
      const callbackError = e?.message ?? 'post-pipeline callback chain failed'
      const executionStillCurrent = callbackRunDate && callbackRunId
        ? await isPipelineStageCanonicalState(databaseForDataDomain(c.env, 'ops'), {
            businessDate: callbackRunDate,
            stage: 'pipeline_execution',
            canonicalRunId: callbackRunId,
          })
        : false
      if (!executionStillCurrent) {
        return c.json({ success: false, ignored: true, reason: 'stale_pipeline_callback' }, 409)
      }
      await logSchedulerResult(c.env.KV, 'post-pipeline-chain', {
        status: 'error',
        summary: callbackError,
        duration_ms: 0,
        error: String(e),
        run_id: callbackRunId,
        run_date: callbackRunDate,
      }, c.env as any)
      return c.json({
        ok: false,
        retryable: true,
        error: 'post_pipeline_callback_chain_failed',
        detail: callbackError,
      }, 503)
    }
  }

  if (body.task === 's12-structure-batch') {
    if (!callbackRunDate || !callbackRunId) {
      return c.json({ error: 'S12 structure callback missing run_date or run_id' }, 400)
    }
    const callbackSource = String(body.metadata?.source ?? 'unknown')
    const researchOnly = ['historical_shadow', 'manual_repair'].includes(callbackSource)
    const callbackSucceeded = String(body.status) === 'success'
    const retiredServingSource = ['evening_chain', 'intraday_watch', 'intraday_session', 'unknown'].includes(callbackSource)
    await logSchedulerResult(c.env.KV, 's12-research-structure', {
      status: retiredServingSource ? 'skipped' : callbackSucceeded ? 'success' : 'error',
      summary: retiredServingSource
        ? `retired S12 serving callback drained without pipeline continuation source=${callbackSource} date=${callbackRunDate} run_id=${callbackRunId}`
        : callbackSucceeded
          ? `research-only S12 structure callback complete source=${callbackSource} date=${callbackRunDate} run_id=${callbackRunId}`
          : `research-only S12 structure callback failed source=${callbackSource}: ${String(body.summary ?? body.error ?? body.status)}`,
      duration_ms: Number(body.duration_ms ?? 0),
      error: !callbackSucceeded && researchOnly && body.error != null ? String(body.error) : undefined,
      run_id: callbackRunId,
      run_date: callbackRunDate,
    }, c.env as any)
  }

  const verifyCanContinue = body.task === 'verify-v2'
    && ['success', 'skipped'].includes(String(body.status))
    && c.env.ML_CONTROLLER_URL
  if (verifyCanContinue) {
    if (!callbackRunDate || !callbackRunId || !verifyCallbackCanonicalRunId) {
      return c.json({ error: 'verify callback missing canonical identity for post-verify continuation' }, 400)
    }
    const marked = await markPipelineStageFenced(databaseForDataDomain(c.env, 'ops'), {
      businessDate: callbackRunDate,
      stage: 'verify_v2',
      canonicalRunId: verifyCallbackCanonicalRunId,
      cursorKey: callbackRunId,
      status: 'success',
    })
    if (!marked) {
      return c.json({ success: false, ignored: true, reason: 'stale_verify_callback' }, 409)
    }
    const continuation = await queuePostVerifyStage(c.env, {
      businessDate: callbackRunDate,
      runId: verifyCallbackCanonicalRunId,
      authority: {
        stage: 'verify_v2',
        canonicalRunId: verifyCallbackCanonicalRunId,
        status: 'success',
        cursorKey: callbackRunId,
      },
    })
    if (continuation.canonicalRunId !== verifyCallbackCanonicalRunId) {
      return c.json({ success: false, ignored: true, reason: 'post_verify_stage_owner_conflict' }, 409)
    }
    await logAcceptedCallbackTask()
    await logSchedulerResult(c.env.KV, 'post-verify-chain', {
      status: 'triggered',
      summary: continuation.queued
        ? `post-verify continuation durably queued run_id=${continuation.canonicalRunId}`
        : `post-verify continuation already ${continuation.status} run_id=${continuation.canonicalRunId}`,
      duration_ms: 0,
      run_id: verifyCallbackCanonicalRunId,
      run_date: callbackRunDate,
    }, c.env as any)
  }

  if (body.task === 'verify-v2' && String(body.status) === 'error') {
    if (!callbackRunDate || !callbackRunId || !verifyCallbackCanonicalRunId) {
      return c.json({ error: 'verify callback missing canonical identity' }, 400)
    }
    const error = body.error != null ? String(body.error) : String(body.summary ?? 'verify-v2 callback failed')
    const marked = await markPipelineStageFenced(databaseForDataDomain(c.env, 'ops'), {
      businessDate: callbackRunDate,
      stage: 'verify_v2',
      canonicalRunId: verifyCallbackCanonicalRunId,
      cursorKey: callbackRunId,
      status: 'error',
      error,
    })
    if (!marked) {
      return c.json({ success: false, ignored: true, reason: 'stale_verify_callback' }, 409)
    }
    await logAcceptedCallbackTask()
    await logSchedulerResult(c.env.KV, 'post-verify-chain', {
      status: 'error',
      summary: `post-verify chain blocked by verify-v2 error: ${String(body.summary ?? '')}`,
      duration_ms: 0,
      error: body.error != null ? String(body.error) : undefined,
      run_id: verifyCallbackCanonicalRunId,
      run_date: callbackRunDate,
    }, c.env as any)
    await logSchedulerResult(c.env.KV, 'evening-chain', {
      status: 'error',
      summary: `root chain stopped at verify-v2 callback: ${String(body.summary ?? '')}`,
      duration_ms: 0,
      error: body.error != null ? String(body.error) : undefined,
      run_id: verifyCallbackCanonicalRunId,
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
