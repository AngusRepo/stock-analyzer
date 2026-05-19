import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireAdminJWT, requireAdminOrServiceToken, requireServiceToken } from '../lib/auth'
import { runDailyUpdate } from '../lib/updateOrchestrator'
import type { Bindings, Variables } from '../types'

export const adminWriteRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminWriteRoutes.post('/api/admin/update', async (c) => {
  const authError = await requireAdminJWT(c)
  if (authError) return authError

  const result = await runDailyUpdate(c.env)
  return c.json({ success: true, mode: 'sync', result })
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

adminWriteRoutes.post('/api/admin/observability/snapshot', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => ({}))
  const { buildLiveObservabilityEventReport, persistObservabilitySnapshot } = await import('../lib/observabilityEvents')
  const report = await buildLiveObservabilityEventReport(c.env, {
    date: body?.date ?? c.req.query('date'),
    live: body?.live === true || c.req.query('live') === '1',
  })
  const audit = await persistObservabilitySnapshot(c.env, report)
  return c.json({
    success: true,
    version: report.version,
    date: report.date,
    generated_at: report.generated_at,
    overall: report.overall,
    counts: report.counts,
    audit,
  })
})

adminWriteRoutes.post('/api/admin/research/experiments', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const { normalizeResearchExperimentInput, putResearchExperiment, buildResearchReviewPacket } = await import('../lib/researchExperimentRegistry')
  const normalized = normalizeResearchExperimentInput(body)
  if (!normalized.ok || !normalized.record) {
    return c.json({ error: 'invalid_research_experiment', errors: normalized.errors }, 400)
  }

  const dryRun = body.dry_run !== false
  if (dryRun) {
    return c.json({
      success: true,
      mode: 'dry_run',
      experiment: normalized.record,
      review_packet: buildResearchReviewPacket(normalized.record),
      hint: 'Re-POST with dry_run=false and X-Confirm-Research: true to persist in KV registry.',
    })
  }

  if (c.req.header('X-Confirm-Research') !== 'true') {
    return c.json({
      error: 'Real research registry write requires header X-Confirm-Research: true',
      hint: 'Run dry_run first. This route only persists research metadata and never retrains/promotes/deploys/trades.',
    }, 400)
  }

  await putResearchExperiment(c.env.KV, normalized.record)
  return c.json({
    success: true,
    mode: 'persisted',
    experiment: normalized.record,
    review_packet: buildResearchReviewPacket(normalized.record),
  })
})

adminWriteRoutes.post('/api/admin/research/model-upgrade/seed', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => ({}))
  const dryRun = body.dry_run !== false
  if (dryRun) {
    return c.json({
      success: true,
      mode: 'dry_run',
      hint: 'Re-POST with dry_run=false and X-Confirm-Research:true to seed Strategy Lab model-upgrade experiments. This writes metadata only.',
    })
  }
  if (c.req.header('X-Confirm-Research') !== 'true') {
    return c.json({
      error: 'Model upgrade registry seed requires header X-Confirm-Research: true',
      hint: 'This only creates Strategy Lab experiment metadata; it never trains, promotes, deploys, or trades.',
    }, 400)
  }

  const { ensureModelUpgradeResearchRegistry } = await import('../lib/modelUpgradeResearchRegistry')
  const report = await ensureModelUpgradeResearchRegistry(c.env.KV)
  return c.json({
    success: true,
    mode: 'persisted',
    ...report,
    note: 'Model upgrade Strategy Lab experiments seeded; run dry-run evaluation plans next. Production model registry and voting remain unchanged.',
  })
})

adminWriteRoutes.post('/api/admin/research/model-upgrade/evaluation-run', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = {
    candidate_ids?: string[]
    limit?: number
    dry_run?: boolean
    seed_missing?: boolean
    include_ready?: boolean
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  if (body.dry_run === false) {
    return c.json({
      error: 'model_upgrade_evaluation_run_is_dry_run_only',
      hint: 'This route executes safe research dry-runs and writes review metadata only.',
    }, 400)
  }
  if (c.req.header('X-Confirm-Research') !== 'true') {
    return c.json({
      error: 'Model upgrade evaluation run requires header X-Confirm-Research: true',
      hint: 'This route may call safe dry-run controller endpoints and persist evaluation evidence; it never trains, promotes, deploys, or trades.',
    }, 400)
  }

  const { runModelUpgradeResearchEvaluations } = await import('../lib/modelUpgradeResearchRegistry')
  const report = await runModelUpgradeResearchEvaluations(c.env, {
    candidateIds: Array.isArray(body.candidate_ids) ? body.candidate_ids : undefined,
    limit: body.limit,
    seedMissing: body.seed_missing !== false,
    includeReady: body.include_ready === true,
  })
  return c.json({
    ...report,
    note: 'Model upgrade evaluation dry-runs completed. Review-ready rows still require manual Strategy Lab approval before any patch or promotion path.',
  })
})

adminWriteRoutes.post('/api/admin/research/experiments/:id/status', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = {
    status?: string
    reason?: string
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const allowed = new Set([
    'running',
    'review_ready',
    'approved_for_shadow',
    'needs_more_evidence',
    'paper_active_requested',
    'approved_for_patch',
    'rejected',
    'archived',
  ])
  const status = String(body.status ?? '').trim()
  if (!allowed.has(status)) {
    return c.json({
      error: 'invalid_research_experiment_status',
      allowed: [...allowed],
    }, 400)
  }
  if (c.req.header('X-Confirm-Research') !== 'true') {
    return c.json({
      error: 'Research experiment status update requires header X-Confirm-Research: true',
      hint: 'This updates research metadata only; it cannot retrain, promote, deploy, or trade.',
    }, 400)
  }

  const { updateResearchExperimentStatus } = await import('../lib/researchExperimentRegistry')
  const experiment = await updateResearchExperimentStatus(
    c.env.KV,
    c.req.param('id'),
    status as 'running' | 'review_ready' | 'approved_for_shadow' | 'needs_more_evidence' | 'paper_active_requested' | 'approved_for_patch' | 'rejected' | 'archived',
  )
  if (!experiment) return c.json({ error: 'research experiment not found' }, 404)
  return c.json({
    success: true,
    mode: 'metadata_only',
    experiment,
    reason: body.reason ?? null,
    production_effect: false,
    blocked_capabilities: ['production retrain', 'model promote', 'production deploy', 'paper/live trade execution'],
  })
})

adminWriteRoutes.post('/api/admin/research/experiments/:id/patch-handoff', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = {
    reviewer?: string
    reason?: string
    dry_run?: boolean
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  if (body.dry_run === false) {
    return c.json({
      error: 'research_patch_handoff_is_metadata_only',
      hint: 'This route creates a patch handoff manifest only; it never writes runtime code, model_artifact_registry, or champion pointers.',
    }, 400)
  }
  if (c.req.header('X-Confirm-Research') !== 'true') {
    return c.json({
      error: 'Research patch handoff requires header X-Confirm-Research: true',
      hint: 'This writes review metadata only; no retrain, promote, deploy, or trade is allowed.',
    }, 400)
  }

  const { createResearchPatchHandoff } = await import('../lib/researchPatchHandoff')
  const result = await createResearchPatchHandoff(c.env.KV, c.req.param('id'), {
    reviewer: body.reviewer ?? 'Wei',
    reason: body.reason,
  })
  if (result.ok === false) return c.json({ error: result.error }, result.status as 400 | 404 | 409)
  return c.json({
    success: true,
    mode: 'metadata_only',
    handoff: result.handoff,
    production_effect: false,
    note: 'Patch handoff manifest created. It is a review checklist and artifact bridge only; production registry/pointers remain unchanged.',
  })
})

adminWriteRoutes.post('/api/admin/research/experiments/:id/artifact-intent', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = {
    model_name?: string
    artifact_version?: string
    artifact_path?: string
    metadata_path?: string
    training_manifest_path?: string
    feature_policy_version?: string
    checksum?: string
    reviewer?: string
    reason?: string
    dry_run?: boolean
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  if (body.dry_run === false) {
    return c.json({
      error: 'research_artifact_intent_is_metadata_only',
      hint: 'This route creates registry-intent metadata only; it does not write model_artifact_registry.',
    }, 400)
  }
  if (c.req.header('X-Confirm-Research') !== 'true') {
    return c.json({
      error: 'Research artifact intent requires header X-Confirm-Research: true',
      hint: 'This writes preflight metadata only; no registry write, retrain, promote, deploy, or trade is allowed.',
    }, 400)
  }

  const { createResearchArtifactIntent } = await import('../lib/researchArtifactIntent')
  const result = await createResearchArtifactIntent(c.env.KV, c.req.param('id'), body)
  if (result.ok === false) return c.json({ error: result.error }, result.status as 400 | 404 | 409)
  return c.json({
    success: true,
    mode: 'metadata_only',
    intent: result.intent,
    production_effect: false,
    note: 'Artifact registration intent created. It is a preflight packet only; model_artifact_registry remains unchanged.',
  })
})

adminWriteRoutes.post('/api/admin/research/experiments/:id/evaluation-plan/run', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type EvaluationRunBody = {
    dry_run?: boolean
    step_ids?: string[]
  }
  const body = await c.req.json<EvaluationRunBody>().catch(() => ({} as EvaluationRunBody))
  if (body.dry_run === false) {
    return c.json({
      error: 'research evaluation only supports dry_run=true',
      hint: 'P5 research control plane can execute dry-run backtest/walk-forward/verify only; it cannot retrain, promote, deploy or trade.',
    }, 400)
  }

  const id = c.req.param('id')
  const { RESEARCH_EXPERIMENT_PREFIX, updateResearchExperimentStatus } = await import('../lib/researchExperimentRegistry')
  const { buildResearchEvaluationPlan } = await import('../lib/researchEvaluationPlan')
  const { putResearchEvaluationRunReport, runResearchEvaluationPlan } = await import('../lib/researchEvaluationRunner')
  const record = await c.env.KV.get(`${RESEARCH_EXPERIMENT_PREFIX}${id}`, 'json')
  if (!record) return c.json({ error: 'research experiment not found' }, 404)

  const plan = buildResearchEvaluationPlan(record as Parameters<typeof buildResearchEvaluationPlan>[0])
  const report = await runResearchEvaluationPlan(c.env, plan, body.step_ids)
  const stored = await putResearchEvaluationRunReport(c.env.KV, report)
  const experiment = await updateResearchExperimentStatus(
    c.env.KV,
    id,
    report.verdict === 'ready_for_review' ? 'review_ready' : 'running',
  )
  return c.json({
    success: report.success,
    mode: report.mode,
    plan,
    report,
    stored,
    experiment,
  })
})

adminWriteRoutes.post('/api/admin/meta-learning/linucb/reward-ledger/refresh', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type RefreshBody = {
    start_date?: string
    end_date?: string
    limit?: number
    dry_run?: boolean
  }
  const body = await c.req.json<RefreshBody>().catch(() => ({} as RefreshBody))
  const { refreshLinUcbRewardLedger } = await import('../lib/metaLearningRewardLedger')
  const dryRun = body.dry_run !== false
  if (!dryRun && c.req.header('X-Confirm-Meta-Learning') !== 'true') {
    return c.json({
      error: 'LinUCB reward ledger write requires header X-Confirm-Meta-Learning: true',
      hint: 'Run dry_run first. This route only persists meta-learning evidence rows; it never deploys, promotes, retrains or trades.',
    }, 400)
  }

  const report = await refreshLinUcbRewardLedger(c.env.DB, {
    startDate: body.start_date,
    endDate: body.end_date,
    limit: body.limit,
    dryRun,
  })
  return c.json({
    ...report,
    note: dryRun
      ? 'dry_run only; POST dry_run=false with X-Confirm-Meta-Learning:true to persist reward ledger evidence'
      : 'LinUCB reward ledger evidence persisted; Strategy Lab / OBS can now show per-arm samples and reward history',
  })
})

adminWriteRoutes.post('/api/admin/meta-learning/shadow-decisions', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => null)
  if (!body) return c.json({ error: 'Invalid JSON body' }, 400)

  const {
    normalizeMetaShadowDecisionInput,
    persistMetaShadowDecisionRows,
    summarizeMetaShadowDecisionRows,
  } = await import('../lib/metaLearningShadowDecisions')
  const normalized = normalizeMetaShadowDecisionInput(body)
  if (!normalized.ok) {
    return c.json({ error: 'invalid_meta_shadow_decisions', errors: normalized.errors }, 400)
  }

  const dryRun = body.dry_run !== false
  if (dryRun) {
    return c.json({
      success: true,
      mode: 'dry_run',
      policy_id: normalized.rows[0]?.policy_id,
      summary: summarizeMetaShadowDecisionRows(normalized.rows),
      rows: normalized.rows.slice(0, 20),
      hint: 'Re-POST with dry_run=false and X-Confirm-Meta-Learning: true to persist shadow evidence.',
    })
  }

  if (c.req.header('X-Confirm-Meta-Learning') !== 'true') {
    return c.json({
      error: 'Meta shadow decision write requires header X-Confirm-Meta-Learning: true',
      hint: 'Run dry_run first. This route only persists shadow evidence rows; it never deploys, promotes, retrains or trades.',
    }, 400)
  }

  const persisted = await persistMetaShadowDecisionRows(c.env.DB, normalized.rows)
  return c.json({
    success: true,
    mode: 'persisted',
    policy_id: normalized.rows[0]?.policy_id,
    persisted_rows: persisted,
    summary: summarizeMetaShadowDecisionRows(normalized.rows),
  })
})

adminWriteRoutes.post('/api/admin/meta-learning/neural-shadow/run', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = {
    policy_id?: 'NeuralUCB' | 'NeuralTS'
    start_date?: string
    end_date?: string
    limit?: number
    dry_run?: boolean
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const policyId = body.policy_id === 'NeuralTS' ? 'NeuralTS' : 'NeuralUCB'
  const dryRun = body.dry_run !== false
  if (!dryRun && c.req.header('X-Confirm-Meta-Learning') !== 'true') {
    return c.json({
      error: 'Neural shadow run persistence requires header X-Confirm-Meta-Learning: true',
      hint: 'Run dry_run first. This route only persists shadow evidence rows; it never deploys, promotes, retrains production models or trades.',
    }, 400)
  }

  const { runNeuralMetaShadow } = await import('../lib/metaLearningShadowRunner')
  const report = await runNeuralMetaShadow(c.env, {
    policyId,
    startDate: body.start_date,
    endDate: body.end_date,
    limit: body.limit,
    dryRun,
  })
  return c.json({
    ...report,
    note: 'Neural meta shadow challenger evidence only; production LinUCB / trading config remain unchanged.',
  })
})

adminWriteRoutes.post('/api/admin/strategy/spec-registry/seed', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => ({}))
  const dryRun = body.dry_run !== false
  const { DEFAULT_STRATEGY_SPECS } = await import('../lib/strategySpec')
  if (dryRun) {
    return c.json({
      success: true,
      mode: 'dry_run',
      strategy_count: DEFAULT_STRATEGY_SPECS.length,
      hint: 'Re-POST with dry_run=false and X-Confirm-Strategy-Learning:true to persist seed specs.',
    })
  }
  if (c.req.header('X-Confirm-Strategy-Learning') !== 'true') {
    return c.json({
      error: 'Strategy registry seed requires header X-Confirm-Strategy-Learning: true',
      hint: 'This writes strategy metadata only; it never deploys, promotes, retrains or trades.',
    }, 400)
  }
  const { seedDefaultStrategySpecRegistry } = await import('../lib/strategyLearning')
  const report = await seedDefaultStrategySpecRegistry(c.env.DB)
  return c.json({
    success: true,
    mode: 'persisted',
    ...report,
  })
})

adminWriteRoutes.post('/api/admin/strategy/decision-log/materialize', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = {
    date?: string
    limit?: number
    dry_run?: boolean
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const dryRun = body.dry_run !== false
  if (!dryRun && c.req.header('X-Confirm-Strategy-Learning') !== 'true') {
    return c.json({
      error: 'Strategy decision log materialization requires header X-Confirm-Strategy-Learning: true',
      hint: 'Run dry_run first. This persists shadow/active strategy evidence only; it never changes production decisions.',
    }, 400)
  }
  const { materializeStrategyDecisionLog, seedDefaultStrategySpecRegistry } = await import('../lib/strategyLearning')
  if (!dryRun) await seedDefaultStrategySpecRegistry(c.env.DB)
  const report = await materializeStrategyDecisionLog(c.env.DB, {
    date: body.date ?? c.req.query('date') ?? twToday(),
    limit: body.limit,
    dryRun,
  })
  return c.json({
    ...report,
    note: dryRun
      ? 'dry_run only; POST dry_run=false with X-Confirm-Strategy-Learning:true to persist decision evidence'
      : 'Strategy decision evidence persisted; Strategy Lab can now show match history and learning curve inputs.',
  })
})

adminWriteRoutes.post('/api/admin/strategy/reward-ledger/refresh', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = {
    start_date?: string
    end_date?: string
    limit?: number
    dry_run?: boolean
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const dryRun = body.dry_run !== false
  if (!dryRun && c.req.header('X-Confirm-Strategy-Learning') !== 'true') {
    return c.json({
      error: 'Strategy reward ledger refresh requires header X-Confirm-Strategy-Learning: true',
      hint: 'Run dry_run first. This persists strategy reward evidence only; it never changes production decisions.',
    }, 400)
  }
  const { refreshStrategyRewardLedger } = await import('../lib/strategyLearning')
  const report = await refreshStrategyRewardLedger(c.env.DB, {
    startDate: body.start_date,
    endDate: body.end_date,
    limit: body.limit,
    dryRun,
  })
  return c.json({
    ...report,
    note: dryRun
      ? 'dry_run only; POST dry_run=false with X-Confirm-Strategy-Learning:true to persist reward ledger evidence'
      : 'Strategy reward ledger persisted; adaptive policy can consume strategy-level reward curves.',
  })
})

adminWriteRoutes.post('/api/admin/strategy/policy-state/refresh', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = {
    date?: string
    dry_run?: boolean
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const dryRun = body.dry_run !== false
  if (!dryRun && c.req.header('X-Confirm-Strategy-Learning') !== 'true') {
    return c.json({
      error: 'Strategy adaptive policy refresh requires header X-Confirm-Strategy-Learning: true',
      hint: 'Run dry_run first. This persists shadow policy state only; it never changes production strategy, model vote, deploy or trading.',
    }, 400)
  }
  const { refreshStrategyAdaptivePolicyState } = await import('../lib/strategyLearning')
  const report = await refreshStrategyAdaptivePolicyState(c.env.DB, {
    date: body.date ?? c.req.query('date') ?? twToday(),
    dryRun,
  })
  return c.json({
    ...report,
    note: dryRun
      ? 'dry_run only; POST dry_run=false with X-Confirm-Strategy-Learning:true to persist shadow adaptive policy state'
      : 'Strategy adaptive policy shadow state persisted; production strategy remains unchanged until explicit Wei approval and promotion wiring.',
  })
})
