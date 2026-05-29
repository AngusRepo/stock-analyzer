import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireAdminOrServiceToken } from '../lib/auth'
import type { Bindings, Variables } from '../types'

export const adminReadRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>()

adminReadRoutes.get('/api/admin/debate-ab/stats', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { results: byModel } = await c.env.DB.prepare(
    `SELECT model_assigned,
            COUNT(*) AS calls,
            AVG(conviction_score) AS avg_conviction,
            AVG(summary_len) AS avg_summary_len,
            AVG(debate_rounds) AS avg_rounds,
            SUM(CASE WHEN verdict='APPROVE'   THEN 1 ELSE 0 END) AS approves,
            SUM(CASE WHEN verdict='DOWNGRADE' THEN 1 ELSE 0 END) AS downgrades,
            SUM(CASE WHEN verdict='REJECT'    THEN 1 ELSE 0 END) AS rejects
     FROM debate_ab_log
     WHERE date >= date('now', '-30 days')
     GROUP BY model_assigned`
  ).all<any>()

  const { results: byDay } = await c.env.DB.prepare(
    `SELECT date, model_assigned, COUNT(*) AS calls, AVG(conviction_score) AS avg_conviction
     FROM debate_ab_log
     WHERE date >= date('now', '-30 days')
     GROUP BY date, model_assigned
     ORDER BY date DESC`
  ).all<any>()

  return c.json({ by_model: byModel ?? [], by_day: byDay ?? [] })
})

adminReadRoutes.get('/api/scheduler/status', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { getSchedulerStatus } = await import('../lib/schedulerStatus')
  const status = await getSchedulerStatus(c.env)
  return c.json(status)
})

adminReadRoutes.get('/api/admin/data-quality/status', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { buildDataQualityReport } = await import('../lib/dataQualityMonitor')
  return c.json(await buildDataQualityReport(c.env, { date: c.req.query('date') }))
})

async function handleDatasetSnapshotList(c: any) {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { listDatasetSnapshots } = await import('../lib/datasetSnapshots')
  return c.json({
    success: true,
    snapshots: await listDatasetSnapshots(c.env, {
      kind: c.req.query('kind'),
      businessDate: c.req.query('date'),
      accessTier: c.req.query('access_tier') as any,
      limit: Number.parseInt(c.req.query('limit') ?? '50', 10),
    }),
  })
}

async function handleDatasetSnapshotManifest(c: any) {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { getDatasetSnapshotManifest } = await import('../lib/datasetSnapshots')
  const manifest = await getDatasetSnapshotManifest(c.env, c.req.param('id'))
  if (!manifest) return c.json({ error: 'dataset snapshot not found' }, 404)
  return c.json({ success: true, manifest })
}

async function handleDatasetSnapshotPreview(c: any) {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { readDatasetSnapshotPreview } = await import('../lib/datasetSnapshots')
  const bytes = Number.parseInt(c.req.query('bytes') ?? `${128 * 1024}`, 10)
  const preview = await readDatasetSnapshotPreview(c.env, c.req.param('id'), bytes)
  const status = preview.found === false ? 404 : 200
  return c.json({ success: status === 200, ...preview }, status as any)
}

adminReadRoutes.get('/api/admin/datasets/snapshots', handleDatasetSnapshotList)
adminReadRoutes.get('/api/admin/datasets/snapshots/:id/manifest', handleDatasetSnapshotManifest)
adminReadRoutes.get('/api/admin/datasets/snapshots/:id/preview', handleDatasetSnapshotPreview)
adminReadRoutes.get('/api/datasets/snapshots', handleDatasetSnapshotList)
adminReadRoutes.get('/api/datasets/snapshots/:id/manifest', handleDatasetSnapshotManifest)
adminReadRoutes.get('/api/datasets/snapshots/:id/preview', handleDatasetSnapshotPreview)

adminReadRoutes.get('/api/admin/datasets/retention-plan', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { D1_HOT_WINDOW_DAYS, buildDatasetRetentionPlan } = await import('../lib/datasetSnapshots')
  const businessDate = c.req.query('date') || twToday()
  const hotWindowDays = Number.parseInt(
    c.req.query('hot_window_days') ?? c.req.query('hotWindowDays') ?? `${D1_HOT_WINDOW_DAYS}`,
    10,
  )
  return c.json({
    success: true,
    plan: await buildDatasetRetentionPlan(c.env, { businessDate, hotWindowDays }),
  })
})

adminReadRoutes.get('/api/admin/gate/predeploy', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { buildDeployGateReport } = await import('../lib/deployGate')
  return c.json(await buildDeployGateReport(c.env, {
    date: c.req.query('date'),
    includeLiveController: c.req.query('live') === '1',
  }))
})

adminReadRoutes.get('/api/admin/execution/pre-pilot-evidence', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { buildExecutionPrePilotEvidenceReport } = await import('../lib/executionPrePilotEvidence')
  return c.json(await buildExecutionPrePilotEvidenceReport(c.env.DB, {
    date: c.req.query('date') ?? twToday(),
    sinceUtc: c.req.query('since_utc') ?? c.req.query('sinceUtc'),
    limit: Number.parseInt(c.req.query('limit') ?? '30', 10),
  }))
})

adminReadRoutes.get('/api/admin/observability/events', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { buildLiveObservabilityEventReport, listObservabilityAuditEvents } = await import('../lib/observabilityEvents')
  const date = c.req.query('date')
  const report = await buildLiveObservabilityEventReport(c.env, {
    date,
    live: c.req.query('live') === '1',
  })
  const recent = await listObservabilityAuditEvents(c.env, {
    date: date ?? report.date,
    limit: 20,
  }).catch(() => [])

  return c.json({
    ...report,
    audit: { recent },
  })
})

adminReadRoutes.get('/api/admin/observability/audit', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { listObservabilityAuditEvents, normalizeObservabilityAuditFilters } = await import('../lib/observabilityEvents')
  const filters = normalizeObservabilityAuditFilters({
    date: c.req.query('date'),
    severity: c.req.query('severity'),
    domain: c.req.query('domain'),
    limit: c.req.query('limit'),
  })
  return c.json({
    success: true,
    date: filters.date,
    events: await listObservabilityAuditEvents(c.env, filters),
  })
})

adminReadRoutes.get('/api/admin/observability/drilldown', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { buildLiveObservabilityEventReport, listObservabilityAuditEvents } = await import('../lib/observabilityEvents')
  const { buildObservabilityDrilldown } = await import('../lib/observabilityDrilldown')
  const date = c.req.query('date')
  const report = await buildLiveObservabilityEventReport(c.env, {
    date,
    live: c.req.query('live') === '1',
  })
  const auditRows = await listObservabilityAuditEvents(c.env, {
    date: date ?? report.date,
    limit: 300,
  }).catch(() => [])
  return c.json(buildObservabilityDrilldown(report, { auditRows }))
})

adminReadRoutes.get('/api/admin/ops/runbook', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { buildOpsRunbook } = await import('../lib/opsRunbook')
  return c.json(buildOpsRunbook())
})

adminReadRoutes.get('/api/admin/ops/resource-audit', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { buildOpsResourceAudit } = await import('../lib/opsRunbook')
  return c.json(await buildOpsResourceAudit(c.env))
})

adminReadRoutes.get('/api/admin/strategy/specs', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { listStrategySpecsForLearning } = await import('../lib/strategyLearning')
  const { validateStrategySpec } = await import('../lib/strategySpec')
  const { STRATEGY_OWNER_BOUNDARIES } = await import('../lib/strategyOwnerFreeze')
  const { specs, source } = await listStrategySpecsForLearning(c.env.DB)
  return c.json({
    success: true,
    version: specs[0]?.version ?? 'strategy-spec-v1',
    mode: 'read_only',
    source,
    specs: specs.map((spec) => ({ ...spec, validation: validateStrategySpec(spec) })),
    owner_boundaries: STRATEGY_OWNER_BOUNDARIES,
  })
})

adminReadRoutes.get('/api/admin/strategy/learning', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const date = c.req.query('date') ?? twToday()
  const { buildStrategyLearningSummary } = await import('../lib/strategyLearning')
  return c.json({
    success: true,
    mode: 'read_only',
    ...(await buildStrategyLearningSummary(c.env.DB, date)),
  })
})

adminReadRoutes.get('/api/admin/strategy/policy-state', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const date = c.req.query('date') ?? twToday()
  const { buildStrategyLearningSummary, getLatestStrategyPolicyState } = await import('../lib/strategyLearning')
  const summary = await buildStrategyLearningSummary(c.env.DB, date)
  return c.json({
    success: true,
    mode: 'read_only',
    date,
    latest: await getLatestStrategyPolicyState(c.env.DB),
    preview: summary.policy_state_preview,
    promotion_gate: summary.promotion_gate,
  })
})

adminReadRoutes.post('/api/admin/strategy/dry-run', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  type StrategyDryRunBody = {
    date?: string
    candidates?: Array<Record<string, unknown>>
  }
  const body: StrategyDryRunBody = await c.req.json<StrategyDryRunBody>().catch(() => ({} as StrategyDryRunBody))
  const date = body.date ?? c.req.query('date') ?? twToday()
  const limit = Math.max(1, Math.min(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 200))
  let candidates = body.candidates ?? []
  const normalizeStrategyCandidate = (candidate: Record<string, unknown>) => {
    const { score_components: scoreComponents, ...rest } = candidate
    return {
      ...rest,
      score_v2: candidate.score_v2 ?? scoreComponents,
    }
  }

  if (!candidates.length) {
    const { results } = await c.env.DB.prepare(`
      SELECT symbol, name, sector, industry, score_components,
             current_price
      FROM daily_recommendations
      WHERE date = ?
      ORDER BY rank ASC,
        CASE WHEN json_valid(score_components) THEN
          COALESCE(
            CAST(json_extract(score_components, '$.finalScore') AS REAL),
            CAST(json_extract(score_components, '$.total') AS REAL),
            0
          ) ELSE 0 END DESC,
        symbol ASC
      LIMIT ?
    `).bind(date, limit).all<Record<string, unknown>>()
    candidates = (results ?? []).map(normalizeStrategyCandidate)
  }
  const strategyCandidates = candidates.map(normalizeStrategyCandidate)

  const { listStrategySpecs, dryRunStrategySpec } = await import('../lib/strategyLab')
  const specs = listStrategySpecs()
  return c.json({
    success: true,
    mode: 'dry_run',
    date,
    source: body.candidates?.length ? 'request_body' : 'daily_recommendations',
    candidate_count: strategyCandidates.length,
    results: specs.map((spec) => dryRunStrategySpec(spec, strategyCandidates as any)),
  })
})

adminReadRoutes.get('/api/admin/research/experiments', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const limit = Math.max(1, Math.min(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 100))
  const { listResearchExperiments, buildResearchReviewPacket } = await import('../lib/researchExperimentRegistry')
  const { buildResearchEvaluationPlan } = await import('../lib/researchEvaluationPlan')
  const {
    buildMetaLearningDecisionPacket,
    buildMetaLearningEvidenceMatrix,
    listMetaLearningTracks,
    listMetaRewardLedgerRows,
    listMetaShadowDecisionEvidence,
  } = await import('../lib/metaLearningResearchTrack')
  const experiments = await listResearchExperiments(c.env.KV, limit)
  const metaLearningTracks = listMetaLearningTracks(experiments)
  const [rewardLedger, shadowDecisions] = await Promise.all([
    listMetaRewardLedgerRows(c.env.DB),
    listMetaShadowDecisionEvidence(c.env.DB),
  ])
  return c.json({
    success: true,
    mode: 'read_only',
    experiments: experiments.map((record) => ({
      ...record,
      review_packet: buildResearchReviewPacket(record),
      evaluation_plan: buildResearchEvaluationPlan(record),
    })),
    meta_learning_tracks: metaLearningTracks,
    meta_learning_evidence_matrix: buildMetaLearningEvidenceMatrix(metaLearningTracks, { rewardLedger, shadowDecisions }),
    meta_learning_decision_packet: buildMetaLearningDecisionPacket(experiments),
  })
})

adminReadRoutes.get('/api/admin/research/experiments/:id/evaluation-plan', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const id = c.req.param('id')
  const { RESEARCH_EXPERIMENT_PREFIX } = await import('../lib/researchExperimentRegistry')
  const { buildResearchEvaluationPlan } = await import('../lib/researchEvaluationPlan')
  const record = await c.env.KV.get(`${RESEARCH_EXPERIMENT_PREFIX}${id}`, 'json') as any
  if (!record) return c.json({ error: 'research experiment not found' }, 404)
  return c.json({
    success: true,
    mode: 'read_only',
    plan: buildResearchEvaluationPlan(record),
  })
})

adminReadRoutes.get('/api/admin/research/experiments/:id/evaluation-runs', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const id = c.req.param('id')
  const limit = Math.max(1, Math.min(Number.parseInt(c.req.query('limit') ?? '20', 10) || 20, 50))
  const { listResearchEvaluationRunReports } = await import('../lib/researchEvaluationRunner')
  return c.json({
    success: true,
    mode: 'read_only',
    experiment_id: id,
    runs: await listResearchEvaluationRunReports(c.env.KV, id, limit),
  })
})

adminReadRoutes.get('/api/admin/research/experiments/:id/patch-handoffs', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const id = c.req.param('id')
  const limit = Math.max(1, Math.min(Number.parseInt(c.req.query('limit') ?? '10', 10) || 10, 50))
  const { listResearchPatchHandoffs } = await import('../lib/researchPatchHandoff')
  return c.json({
    success: true,
    mode: 'read_only',
    experiment_id: id,
    handoffs: await listResearchPatchHandoffs(c.env.KV, id, limit),
  })
})

adminReadRoutes.get('/api/admin/research/experiments/:id/artifact-intents', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const id = c.req.param('id')
  const limit = Math.max(1, Math.min(Number.parseInt(c.req.query('limit') ?? '10', 10) || 10, 50))
  const { listResearchArtifactIntents } = await import('../lib/researchArtifactIntent')
  return c.json({
    success: true,
    mode: 'read_only',
    experiment_id: id,
    intents: await listResearchArtifactIntents(c.env.KV, id, limit),
  })
})

adminReadRoutes.get('/api/admin/research/model-upgrade/status', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { buildModelUpgradeResearchStatus } = await import('../lib/modelUpgradeResearchRegistry')
  return c.json(await buildModelUpgradeResearchStatus(c.env.KV))
})

adminReadRoutes.post('/api/admin/research/gate', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const body = await c.req.json<any>().catch(() => ({}))
  const { evaluateResearchInternGate } = await import('../lib/researchInternGate')
  return c.json({
    success: true,
    mode: 'read_only',
    gate: evaluateResearchInternGate(body),
  })
})

adminReadRoutes.get('/api/admin/costs/today', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const date = c.req.query('date') ?? twToday()
  const { results } = await c.env.DB.prepare(
    `SELECT source, provider, model, calls, tokens_in_total, tokens_out_total,
            compute_sec_total, est_usd_total
     FROM cost_daily WHERE date = ? ORDER BY est_usd_total DESC`
  ).bind(date).all<any>()

  const total = (results ?? []).reduce((sum: number, row: any) => sum + (row.est_usd_total ?? 0), 0)
  return c.json({ date, total_usd: Math.round(total * 10000) / 10000, breakdown: results ?? [] })
})

adminReadRoutes.get('/api/admin/costs/month', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { results } = await c.env.DB.prepare(
    `SELECT source, provider, model, SUM(est_usd) AS total_usd, COUNT(*) AS calls,
            SUM(COALESCE(tokens_in, 0)) AS tokens_in, SUM(COALESCE(tokens_out, 0)) AS tokens_out
     FROM cost_events WHERE date >= date('now', '-30 days')
     GROUP BY source, provider, model ORDER BY total_usd DESC`
  ).all<any>()

  const total = (results ?? []).reduce((sum: number, row: any) => sum + (row.total_usd ?? 0), 0)
  const { results: daily } = await c.env.DB.prepare(
    `SELECT date, ROUND(SUM(est_usd), 4) AS total_usd
     FROM cost_events WHERE date >= date('now', '-30 days')
     GROUP BY date ORDER BY date`
  ).all<any>()

  return c.json({
    total_usd: Math.round(total * 10000) / 10000,
    by_source: results ?? [],
    by_day: daily ?? [],
  })
})

function computeProfileMissingWaitColumns(error: unknown): boolean {
  const message = String(error)
  return /no such column/i.test(message) || /has no column named/i.test(message)
}

function parseProfileJson(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

function normalizeComputeProfileReadRow(row: any): Record<string, unknown> {
  const profile = parseProfileJson(row.profile_json)
  const metadata = parseProfileJson(profile.metadata)
  return {
    ...row,
    await_sec: firstNumber(row.await_sec, profile.await_sec, profile.orchestration_await_sec, profile.remote_wait_sec, metadata.await_sec),
    compute_owner: firstString(row.compute_owner, profile.compute_owner, metadata.compute_owner, row.provider),
    remote_function: firstString(row.remote_function, profile.remote_function, profile.function_name, metadata.remote_function, row.job_name),
    profile,
  }
}

adminReadRoutes.get('/api/admin/compute-profiles', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const date = c.req.query('date') ?? twToday()
  const job = c.req.query('job')?.trim()
  const provider = c.req.query('provider')?.trim()
  const limit = Math.max(1, Math.min(Number(c.req.query('limit') ?? 100) || 100, 500))
  const where = ['event_date = ?']
  const params: any[] = [date]
  if (job) {
    where.push('job_name = ?')
    params.push(job)
  }
  if (provider) {
    where.push('provider = ?')
    params.push(provider)
  }
  params.push(limit)

  const baseColumns = [
    'id',
    'event_date',
    'provider',
    'job_name',
    'run_id',
    'wall_sec',
    'compute_sec',
    'cpu',
    'memory_mb',
    'gpu',
    'est_usd',
    'rows',
    'features',
    'symbols',
    'trials',
    'cache_hit_ratio',
    'profile_json',
    'created_at',
  ].join(', ')
  const waitColumns = `${baseColumns}, await_sec, compute_owner, remote_function`
  const sql = (columns: string) => `
    SELECT ${columns}
    FROM compute_profile_events
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `

  let legacyColumns = false
  let results: any[] = []
  try {
    const query = await c.env.DB.prepare(sql(waitColumns)).bind(...params).all<any>()
    results = query.results ?? []
  } catch (error) {
    if (!computeProfileMissingWaitColumns(error)) throw error
    legacyColumns = true
    const query = await c.env.DB.prepare(sql(baseColumns)).bind(...params).all<any>()
    results = query.results ?? []
  }

  return c.json({
    date,
    job: job ?? null,
    provider: provider ?? null,
    limit,
    legacy_columns: legacyColumns,
    profiles: results.map(normalizeComputeProfileReadRow),
  })
})

adminReadRoutes.get('/api/admin/cron-logs', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const date = c.req.query('date') ?? twToday()
  const { getCronLogs } = await import('../lib/schedulerRunLogger')
  const logs = await getCronLogs(c.env.KV, date)
  return c.json({ date, logs })
})
