import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireAdminJWT, requireAdminOrServiceToken, requireServiceToken } from '../lib/auth'
import { runDailyUpdate } from '../lib/updateOrchestrator'
import type { Bindings, Variables } from '../types'

export const adminWriteRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminWriteRoutes.post('/api/admin/update', async (c) => {
  const authError = await requireAdminJWT(c)
  if (authError) return authError

  c.executionCtx.waitUntil(runDailyUpdate(c.env))
  return c.json({ success: true, message: '每日更新已在背景執行' })
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
  const { RESEARCH_EXPERIMENT_PREFIX } = await import('../lib/researchExperimentRegistry')
  const { buildResearchEvaluationPlan } = await import('../lib/researchEvaluationPlan')
  const { putResearchEvaluationRunReport, runResearchEvaluationPlan } = await import('../lib/researchEvaluationRunner')
  const record = await c.env.KV.get(`${RESEARCH_EXPERIMENT_PREFIX}${id}`, 'json')
  if (!record) return c.json({ error: 'research experiment not found' }, 404)

  const plan = buildResearchEvaluationPlan(record as Parameters<typeof buildResearchEvaluationPlan>[0])
  const report = await runResearchEvaluationPlan(c.env, plan, body.step_ids)
  const stored = await putResearchEvaluationRunReport(c.env.KV, report)
  return c.json({
    success: report.success,
    mode: report.mode,
    plan,
    report,
    stored,
  })
})
