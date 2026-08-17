import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireAdminJWT, requireAdminOrServiceToken, requireServiceToken } from '../lib/auth'
import { databaseForDataDomain } from '../lib/dataDomainRegistry'
import { runDailyUpdate } from '../lib/updateOrchestrator'
import type { Bindings, Variables } from '../types'
import {
  STRATEGY_FORMAL_LABELER_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
} from '../lib/strategySpec'

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

  await databaseForDataDomain(c.env, 'ops').prepare(
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

  const report = await refreshLinUcbRewardLedger(databaseForDataDomain(c.env, 'learning'), {
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

  const persisted = await persistMetaShadowDecisionRows(databaseForDataDomain(c.env, 'learning'), normalized.rows)
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
    policy_id?: 'NeuralUCB' | 'NeuralTS' | 'NeuCB'
    start_date?: string
    end_date?: string
    limit?: number
    dry_run?: boolean
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const policyId = body.policy_id === 'NeuralTS'
    ? 'NeuralTS'
    : body.policy_id === 'NeuCB'
      ? 'NeuCB'
      : 'NeuralUCB'
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
  const report = await seedDefaultStrategySpecRegistry(databaseForDataDomain(c.env, 'learning'))
  return c.json({
    success: true,
    mode: 'persisted',
    ...report,
  })
})

adminWriteRoutes.post('/api/admin/strategy-learning/resume', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError
  if (c.req.header('X-Confirm-Strategy-Learning-Recovery') !== 'true') {
    return c.json({
      error: 'Strategy learning recovery requires header X-Confirm-Strategy-Learning-Recovery: true',
      hint: 'This only resumes an existing canonical queued or expired-running run. It cannot create a run or mutate production policy.',
    }, 400)
  }

  type Body = { date?: string }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const date = body.date ?? c.req.query('date') ?? twToday()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'date must be YYYY-MM-DD' }, 400)
  }

  const learningDb = databaseForDataDomain(c.env, 'learning')
  const opsDb = databaseForDataDomain(c.env, 'ops')
  const run = await learningDb.prepare(`
    SELECT canonical_run_id, status, cursor_symbol, expected_candidates,
           processed_candidates, expected_decision_rows, persisted_decision_rows,
           lease_owner, lease_expires_at,
           CASE WHEN lease_expires_at IS NOT NULL AND lease_expires_at < CURRENT_TIMESTAMP THEN 1 ELSE 0 END lease_expired
      FROM strategy_learning_runs
     WHERE business_date=?
     LIMIT 1
  `).bind(date).first<{
    canonical_run_id: string
    status: string
    cursor_symbol: string | null
    expected_candidates: number
    processed_candidates: number
    expected_decision_rows: number
    persisted_decision_rows: number
    lease_owner: string | null
    lease_expires_at: string | null
    lease_expired: number
  }>()
  const recoverableProgress = run
    && Number(run.processed_candidates) > 0
    && Number(run.expected_candidates) > 0
    && Number(run.processed_candidates) <= Number(run.expected_candidates)
    && Number(run.expected_decision_rows) > 0
    && Number(run.persisted_decision_rows) <= Number(run.expected_decision_rows)
  const recoverableLease = run && (
    (run.status === 'queued' && !run.lease_owner && !run.lease_expires_at)
    || (run.status === 'running' && Number(run.lease_expired) === 1)
  )
  if (!run || !recoverableLease || !recoverableProgress) {
    return c.json({ error: `canonical_resumable_strategy_learning_recovery_required:${date}`, run }, 409)
  }

  const authority = await opsDb.prepare(`
    SELECT status, canonical_run_id
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage='post_verify_chain'
     LIMIT 1
  `).bind(date).first<{ status: string; canonical_run_id: string }>()
  if (authority?.status !== 'success' || authority.canonical_run_id !== run.canonical_run_id) {
    return c.json({ error: `post_verify_canonical_authority_required:${date}`, authority, run }, 409)
  }

  await c.env.UPDATE_QUEUE.send({
    type: 'strategy_learning_materialize',
    cursor: 0,
    cursorKey: String(run.cursor_symbol ?? ''),
    triggerTime: date,
    runId: run.canonical_run_id,
    force: false,
    policyMutationAllowed: false,
    leaseRetryAttempt: 0,
  })
  return c.json({
    success: true,
    mode: run.status === 'running' ? 'canonical_resume_expired_running' : 'canonical_resume_queued',
    date,
    canonical_run_id: run.canonical_run_id,
    cursor_symbol: run.cursor_symbol,
    processed_candidates: Number(run.processed_candidates),
    expected_candidates: Number(run.expected_candidates),
    production_policy_mutation: false,
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
  const learningDb = databaseForDataDomain(c.env, 'learning')
  const opsDb = databaseForDataDomain(c.env, 'ops')
  if (!dryRun) await seedDefaultStrategySpecRegistry(learningDb)
  const report = await materializeStrategyDecisionLog(learningDb, {
    date: body.date ?? c.req.query('date') ?? twToday(),
    limit: body.limit,
    dryRun,
    candidateDb: opsDb,
    artifactEnv: c.env,
    producerRunId: `manual-strategy-learning-${body.date ?? c.req.query('date') ?? twToday()}-${Date.now().toString(36)}`,
  })
  return c.json({
    ...report,
    note: dryRun
      ? 'dry_run only; POST dry_run=false with X-Confirm-Strategy-Learning:true to persist decision evidence'
      : 'Strategy decision evidence persisted; Strategy Lab can now show match history and learning curve inputs.',
  })
})

adminWriteRoutes.post('/api/admin/strategy/evidence-v5/rebuild', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = {
    as_of_date?: string
    max_dates?: number
    dry_run?: boolean
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const asOfDate = body.as_of_date ?? c.req.query('as_of_date') ?? twToday()
  const maxDates = Math.max(1, Math.min(5, Math.floor(body.max_dates ?? 2)))
  const dryRun = body.dry_run !== false
  const { listHistoricalStrategyEvidenceV5Dates } = await import('../lib/strategyLearning')

  if (dryRun) {
    const candidateDates = await listHistoricalStrategyEvidenceV5Dates(databaseForDataDomain(c.env, 'learning'), { asOfDate, maxDates })
    return c.json({
      success: true,
      mode: 'dry_run',
      as_of_date: asOfDate,
      max_dates: maxDates,
      candidate_dates: candidateDates,
      note: 'Preview only; no strategy evidence or evening-chain status was mutated.',
    })
  }
  if (c.req.header('X-Confirm-Strategy-Learning') !== 'true') {
    return c.json({
      error: 'Historical strategy evidence rebuild requires header X-Confirm-Strategy-Learning: true',
      hint: 'Run dry_run first. This rebuilds PIT strategy evidence only and never marks evening-chain complete.',
    }, 400)
  }

  const runId = `strategy-evidence-rebuild-${asOfDate}-${Date.now().toString(36)}`
  await c.env.UPDATE_QUEUE.send({
    type: 'strategy_evidence_rebuild',
    cursor: 0,
    triggerTime: asOfDate,
    runId,
    strategyEvidenceMaxDates: maxDates,
  })
  return c.json({
    success: true,
    mode: 'queued',
    as_of_date: asOfDate,
    max_dates: maxDates,
    run_id: runId,
    note: 'Historical PIT strategy evidence rebuild queued on the durable owner; evening-chain scheduler status is not mutated.',
  }, 202)
})

adminWriteRoutes.post('/api/admin/strategy/redundancy/backfill', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = {
    start_date?: string
    end_date?: string
    dry_run?: boolean
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const startDate = body.start_date ?? c.req.query('start_date') ?? twToday()
  const endDate = body.end_date ?? c.req.query('end_date') ?? startDate
  const dryRun = body.dry_run !== false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
    return c.json({ error: 'valid start_date/end_date are required' }, 400)
  }
  const spanDays = Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000)
  if (!Number.isFinite(spanDays) || spanDays > 31) {
    return c.json({ error: 'strategy redundancy backfill range must be <= 31 calendar days' }, 400)
  }
  if (!dryRun && c.req.header('X-Confirm-Strategy-Learning') !== 'true') {
    return c.json({
      error: 'Strategy redundancy backfill requires header X-Confirm-Strategy-Learning: true',
      hint: 'Run dry_run first. This writes PIT evidence only and never changes strategy weights or recommendations.',
    }, 400)
  }

  const opsDb = databaseForDataDomain(c.env, 'ops')
  const learningDb = databaseForDataDomain(c.env, 'learning')
  const canonicalRows = await opsDb.prepare(`
    SELECT substr(logical_run_key, 10, 10) AS signal_date, run_id
      FROM canonical_run_heads
     WHERE logical_run_key LIKE 'screener:%:TW:production:market_screener'
       AND substr(logical_run_key, 10, 10) BETWEEN ? AND ?
  `).bind(startDate, endDate).all<{ signal_date: string; run_id: string }>()
  const canonicalRunByDate = new Map(
    (canonicalRows.results ?? []).map((row) => [row.signal_date, row.run_id]),
  )
  const dateRows = await learningDb.prepare(`
    SELECT DISTINCT mr.signal_date, mr.producer_run_id
      FROM strategy_label_matrix_runs_v4 mr
     WHERE mr.signal_date BETWEEN ? AND ?
       AND mr.status='ready'
       AND mr.labeler_version IN (?, ?)
       AND NOT EXISTS (
         SELECT 1 FROM strategy_label_matrix_v4 m
          WHERE m.producer_run_id=mr.producer_run_id
            AND m.labeler_version IS NOT mr.labeler_version
       )
       AND NOT EXISTS (
         SELECT 1 FROM selection_reference_snapshots_v1 r
          WHERE r.producer_run_id=mr.producer_run_id
            AND r.strategy_labeler_version IS NOT mr.labeler_version
       )
     ORDER BY mr.signal_date
  `).bind(
    startDate,
    endDate,
    STRATEGY_FORMAL_LABELER_VERSION,
    STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
  ).all<{ signal_date: string; producer_run_id: string }>()
  const dates = (dateRows.results ?? [])
    .filter((row) => canonicalRunByDate.get(row.signal_date) === row.producer_run_id)
    .map((row) => row.signal_date)
  const {
    prepareStrategyRedundancyBackfill,
    rebuildStrategyRedundancyArtifactForDate,
  } = await import('../lib/marketScreener')
  const results: Array<Record<string, unknown>> = []
  for (const date of dates) {
    try {
      if (dryRun) {
        const result = await prepareStrategyRedundancyBackfill(c.env, date)
        results.push({ ...result, payload: undefined, status: 'eligible' })
      } else {
        const result = await rebuildStrategyRedundancyArtifactForDate(c.env, date)
        results.push({
          ...result,
          payload: undefined,
          status: result.status,
        })
      }
    } catch (error) {
      results.push({
        as_of_date: date,
        status: 'blocked',
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      })
    }
  }
  const blocked = results.filter((row) => row.status === 'blocked').length
  return c.json({
    success: dates.length > 0 && blocked === 0,
    mode: dryRun ? 'dry_run' : 'persisted',
    start_date: startDate,
    end_date: endDate,
    dates_found: dates.length,
    blocked_dates: blocked,
    results,
  })
})

adminWriteRoutes.post('/api/admin/strategy/marginal-edge-v4/refresh', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = {
    as_of_date?: string
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const asOfDate = body.as_of_date ?? c.req.query('as_of_date') ?? twToday()
  if (c.req.header('X-Confirm-Strategy-Learning') !== 'true') {
    return c.json({
      error: 'Strategy marginal-edge refresh requires header X-Confirm-Strategy-Learning: true',
      hint: 'This persists shadow marginal-edge evidence with promotion disabled and never marks evening-chain complete.',
    }, 400)
  }

  const { refreshStrategyMarginalEdgeV4 } = await import('../lib/strategyMarginalEdgeV4')
  const report = await refreshStrategyMarginalEdgeV4(databaseForDataDomain(c.env, 'learning'), asOfDate, { allowPromotion: false })
  return c.json({
    success: true,
    mode: 'persisted_shadow',
    as_of_date: asOfDate,
    promotion_allowed: false,
    ...report,
    note: 'Marginal-edge evidence refreshed without promotion or evening-chain scheduler mutation.',
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
  const report = await refreshStrategyRewardLedger(databaseForDataDomain(c.env, 'learning'), {
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
  const report = await refreshStrategyAdaptivePolicyState(databaseForDataDomain(c.env, 'learning'), {
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

adminWriteRoutes.post('/api/admin/strategy/production-policy/recover', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = { date?: string; dry_run?: boolean }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const date = body.date ?? c.req.query('date') ?? twToday()
  const dryRun = body.dry_run !== false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: 'date must be YYYY-MM-DD' }, 400)
  }
  if (!dryRun && c.req.header('X-Confirm-Strategy-Production-Policy') !== 'true') {
    return c.json({
      error: 'Production policy recovery requires header X-Confirm-Strategy-Production-Policy: true',
      hint: 'This writes one immutable firewall policy row. It cannot promote strategies or submit orders.',
    }, 400)
  }

  const closure = await databaseForDataDomain(c.env, 'learning').prepare(`
    SELECT status, labeler_version, evaluation_contract_version, candidate_count, strategy_count, matrix_rows
      FROM strategy_evidence_rebuild_runs_v5
     WHERE signal_date=?
  `).bind(date).first<{
    status?: string
    labeler_version?: string
    evaluation_contract_version?: string
    candidate_count?: number | string
    strategy_count?: number | string
    matrix_rows?: number | string
  }>()
  if (
    closure?.status !== 'success'
    || closure.labeler_version !== 'strategy-decision-log-pit-reconstruction-v7-revenue-pit-fuse-v1'
    || closure.evaluation_contract_version !== 'strategy-evaluation-v2'
    || Number(closure.candidate_count ?? 0) <= 0
    || Number(closure.strategy_count ?? 0) <= 0
    || Number(closure.matrix_rows ?? 0) !== Number(closure.candidate_count) * Number(closure.strategy_count)
  ) {
    return c.json({ error: `formal_strategy_evidence_closure_required:${date}`, closure }, 409)
  }

  const [{ refreshStrategyAdaptivePolicyState, listStrategySpecsForLearning }, { refreshStrategyProductionContributionPolicy }] = await Promise.all([
    import('../lib/strategyLearning'),
    import('../lib/strategyProductionPolicyService'),
  ])
  const learningDb = databaseForDataDomain(c.env, 'learning')
  const [policy, specsResult] = await Promise.all([
    refreshStrategyAdaptivePolicyState(learningDb, { date, dryRun: true }),
    listStrategySpecsForLearning(learningDb, { applyAdaptivePolicy: false }),
  ])
  const eligibleStrategyIds = policy.promotion_gate
    .filter((gate) => gate.allocation_eligible === true)
    .map((gate) => gate.strategy_id)
    .sort()
  if (dryRun) {
    return c.json({
      success: true,
      mode: 'dry_run',
      date,
      eligible_strategy_ids: eligibleStrategyIds,
      closure,
      note: 'No production policy row was written.',
    })
  }

  const recovered = await refreshStrategyProductionContributionPolicy(learningDb, {
    knowledgeCutoffDate: date,
    strategies: specsResult.specs,
    gates: policy.promotion_gate,
    adaptiveState: policy.policy_state,
  })
  return c.json({
    success: true,
    mode: 'persisted',
    date,
    eligible_strategy_ids: eligibleStrategyIds,
    policy_id: recovered.state.policy_id,
    policy_version: recovered.state.version,
    checksum: recovered.checksum,
    inserted: recovered.inserted,
    note: 'One immutable production firewall row persisted; no strategy promotion or order submission occurred.',
  })
})

adminWriteRoutes.post('/api/admin/entry-model-v2/replay', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type Body = {
    start_date?: string
    end_date?: string
    limit?: number
    symbols?: string[]
    min_rank?: number
    max_rank?: number
    dry_run?: boolean
  }
  const body = await c.req.json<Body>().catch(() => ({} as Body))
  const startDate = body.start_date ?? c.req.query('start_date') ?? c.req.query('date') ?? twToday()
  const endDate = body.end_date ?? c.req.query('end_date') ?? c.req.query('date') ?? startDate
  const dryRun = body.dry_run !== false
  if (!dryRun && c.req.header('X-Confirm-Entry-Model-Replay') !== 'true') {
    return c.json({
      error: 'Entry Model V2 replay persistence requires header X-Confirm-Entry-Model-Replay: true',
      hint: 'Run dry_run first. This stores replay evidence only; it never promotes entry gates, deploys, retrains, or trades.',
    }, 400)
  }

  const {
    buildEntryModelReplayReportFromD1,
    persistEntryModelReplayReport,
  } = await import('../lib/entryModelReplay')
  const report = await buildEntryModelReplayReportFromD1(c.env.DB, {
    startDate,
    endDate,
    limit: body.limit,
    symbols: Array.isArray(body.symbols) ? body.symbols : undefined,
    minRank: body.min_rank,
    maxRank: body.max_rank,
  })
  const persisted = dryRun ? null : await persistEntryModelReplayReport(databaseForDataDomain(c.env, 'learning'), report)
  return c.json({
    success: true,
    mode: dryRun ? 'dry_run' : 'persisted',
    persisted,
    report,
    note: dryRun
      ? 'dry_run only; POST dry_run=false with X-Confirm-Entry-Model-Replay:true to persist replay evidence'
      : 'Entry Model V2 replay report persisted; promotion gate remains evidence-only until explicit production approval.',
  })
})
