import { Hono } from 'hono'
import { twToday } from '../lib/dateUtils'
import { requireAdminOrServiceToken } from '../lib/auth'
import { databaseForDataDomain } from '../lib/dataDomainRegistry'
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

adminReadRoutes.get('/api/admin/expected-return/serving-state', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const date = c.req.query('date') || twToday()
  const [
    { readCurrentExpectedReturnServingState },
    { inspectExpectedReturnCandidateEvidence },
    { inspectAllocatorEvMaturityCoverage },
  ] = await Promise.all([
    import('../lib/expectedReturnServingState'),
    import('../lib/expectedReturnCandidateEvidence'),
    import('../lib/allocatorEvDailyLifecycle'),
  ])
  const [serving, candidates, maturity] = await Promise.all([
    readCurrentExpectedReturnServingState(c.env, date),
    inspectExpectedReturnCandidateEvidence(c.env.DB),
    inspectAllocatorEvMaturityCoverage(c.env.DB, date),
  ])
  return c.json({ success: true, date, serving, candidates, maturity })
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

adminReadRoutes.get('/api/admin/datasets/audit-json-retention-plan', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { AUDIT_JSON_RETENTION_DEFAULT_DAYS, buildAuditJsonRetentionPlan } = await import('../lib/auditJsonArchive')
  const hotWindowDays = Number.parseInt(
    c.req.query('retention_days') ?? c.req.query('retentionDays') ?? `${AUDIT_JSON_RETENTION_DEFAULT_DAYS}`,
    10,
  )
  return c.json({
    success: true,
    plan: await buildAuditJsonRetentionPlan(c.env, {
      businessDate: c.req.query('date') || twToday(),
      retentionDays: hotWindowDays,
      targets: c.req.queries('target') ?? (c.req.query('targets') ? [c.req.query('targets')] : null),
    }),
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
  const learningDb = databaseForDataDomain(c.env, 'learning')
  const { specs, source } = await listStrategySpecsForLearning(learningDb)
  return c.json({
    success: true,
    version: specs[0]?.version ?? 'strategy-spec-v1',
    mode: 'read_only',
    source,
    specs: specs.map((spec) => ({ ...spec, validation: validateStrategySpec(spec) })),
    owner_boundaries: STRATEGY_OWNER_BOUNDARIES,
  })
})
adminReadRoutes.get('/api/admin/strategy/evidence-profiles', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const [
    { listStrategySpecsForLearning },
    {
      CURRENT_CANONICAL_OUTCOME_HORIZON_DAYS,
      listStrategyEvidenceProfiles,
      STRATEGY_EVIDENCE_PROFILE_VERSION,
    },
    { shadowDatabaseForDataDomain },
    { STRATEGY_ROUTE_MIN_TOTAL_DATES },
  ] = await Promise.all([
    import('../lib/strategyLearning'),
    import('../lib/strategyEvidenceProfile'),
    import('../lib/dataDomainRegistry'),
    import('../lib/strategyRouteCalibration'),
  ])
  const learningDb = databaseForDataDomain(c.env, 'learning')
  const { specs, source } = await listStrategySpecsForLearning(learningDb)
  const runtimeSpecs = specs.filter((spec) => spec.status !== 'retired')
  const shadowLearningDb = shadowDatabaseForDataDomain(c.env, 'learning') ?? learningDb
  const horizonRows = await shadowLearningDb.prepare(`
    SELECT horizon_days, COUNT(*) AS outcome_rows
      FROM canonical_selection_outcomes_v1
     GROUP BY horizon_days
     ORDER BY horizon_days
  `).all<{ horizon_days: number; outcome_rows: number }>().catch(() => ({ results: [] }))
  type StrategyEvidenceMetricApiRow = {
    strategy_id: string
    strategy_version: string
    primary_horizon_days: number
    metric_name: string
    metric_value: number | null
    metric_status: 'ready' | 'insufficient_samples' | 'dependency_pending' | 'not_available'
    sample_count: number
    mature_dates: number
    outcome_as_of_date: string
    definition_version: string
    evidence_json: string
  }
  const metricArtifactResult = await shadowLearningDb.prepare(`
    SELECT strategy_id, strategy_version, primary_horizon_days, metric_name,
           metric_value, metric_status, sample_count, mature_dates,
           outcome_as_of_date, definition_version, evidence_json
      FROM strategy_evidence_metrics_v1
     ORDER BY strategy_id, strategy_version, metric_name
  `).all<StrategyEvidenceMetricApiRow>().catch(() => ({ results: [] }))
  const multiHorizonCoverage = (horizonRows.results ?? [])
    .map((row) => ({ horizon_days: Number(row.horizon_days), outcome_rows: Number(row.outcome_rows) }))
    .filter((row) => [3, 5, 10].includes(row.horizon_days) && row.outcome_rows > 0)
  const availableOutcomeHorizonDays = [...new Set([
    CURRENT_CANONICAL_OUTCOME_HORIZON_DAYS,
    ...multiHorizonCoverage.map((row) => row.horizon_days),
  ])].sort((left, right) => left - right)
  const profiles = listStrategyEvidenceProfiles(runtimeSpecs, { availableOutcomeHorizonDays })
  const [formalPolicy, routeCalibration] = await Promise.all([
    learningDb.prepare(`
      SELECT policy_id, version, status, knowledge_cutoff_date, evidence_json, created_at
        FROM strategy_adaptive_policy_history_v2
       WHERE status='active'
       ORDER BY knowledge_cutoff_date DESC, created_at DESC
       LIMIT 1
    `).first<{
      policy_id: string
      version: string
      status: string
      knowledge_cutoff_date: string
      evidence_json: string
      created_at: string
    }>(),
    learningDb.prepare(`
      SELECT run_id, as_of_date, status, date_count, gate_json, created_at
        FROM strategy_route_calibration_runs_v1
       ORDER BY as_of_date DESC, created_at DESC
       LIMIT 1
    `).first<{
      run_id: string
      as_of_date: string
      status: string
      date_count: number
      gate_json: string
      created_at: string
    }>(),
  ])
  const productionPolicy = await learningDb.prepare(`
    SELECT base_weight_run_id, knowledge_cutoff_date, checksum, created_at
      FROM strategy_production_policy_history_v1
     WHERE status='active'
     ORDER BY knowledge_cutoff_date DESC, created_at DESC
     LIMIT 1
  `).first<{
    base_weight_run_id: string | null
    knowledge_cutoff_date: string
    checksum: string
    created_at: string
  }>().catch(() => null)

  const parseObject = (value: string | null | undefined): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(String(value ?? '{}'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {}
    } catch {
      return {}
    }
  }
  const metricArtifacts = metricArtifactResult.results ?? []
  const metricByProfile = new Map<string, StrategyEvidenceMetricApiRow[]>()
  for (const row of metricArtifacts) {
    const key = `${row.strategy_id}|${row.strategy_version}`
    metricByProfile.set(key, [...(metricByProfile.get(key) ?? []), row])
  }
  const profilesWithMetrics = profiles.map((profile) => {
    const rows = (metricByProfile.get(`${profile.strategy_id}|${profile.strategy_version}`) ?? [])
      .filter((row) => Number(row.primary_horizon_days) === profile.primary_horizon_days)
    const byMetric = new Map(rows.map((row) => [row.metric_name, row]))
    const metricEvidence = profile.required_metrics.map((metric) => {
      const row = byMetric.get(metric)
      return row ? {
        metric, value: row.metric_value, status: row.metric_status,
        sample_count: Number(row.sample_count), mature_dates: Number(row.mature_dates),
        outcome_as_of_date: row.outcome_as_of_date, definition_version: row.definition_version,
        evidence: parseObject(row.evidence_json),
      } : {
        metric, value: null, status: 'not_materialized' as const, sample_count: 0, mature_dates: 0,
        outcome_as_of_date: null, definition_version: null, evidence: {},
      }
    })
    return {
      ...profile,
      metric_evidence: metricEvidence,
      metric_completion: {
        materialized: metricEvidence.filter((row) => row.value != null).length,
        ready: metricEvidence.filter((row) => row.status === 'ready').length,
        total: metricEvidence.length,
      },
    }
  })
  const { loadStrategyEvidenceOwnerSnapshotBefore, strategyEvidenceOwnerLineageMatches } = await import('../lib/strategyEvidenceOwnerFusion')
  const evidenceOwnerSnapshot = await loadStrategyEvidenceOwnerSnapshotBefore(
    shadowLearningDb, runtimeSpecs, twToday(),
  )
  const activeProfiles = profiles.filter((profile) => profile.strategy_status === 'active')
  const metricReadyProfiles = profilesWithMetrics.filter((profile) => (
    profile.metric_completion.ready === profile.metric_completion.total
  )).length
  const metricMaterializedProfiles = profilesWithMetrics.filter((profile) => (
    profile.metric_completion.materialized === profile.metric_completion.total
  )).length
  const metricAsOfDate = metricArtifacts.map((row) => row.outcome_as_of_date).sort().at(-1) ?? null
  const formalEvidence = parseObject(formalPolicy?.evidence_json)
  const routeDates = Number(routeCalibration?.date_count ?? 0)
  const completeHorizonCoverage = [3, 5, 10].every((horizon) => (
    multiHorizonCoverage.some((row) => row.horizon_days === horizon && row.outcome_rows > 0)
  ))
  const primaryProfilesReady = profiles.filter((profile) => (
    profile.outcome_contract_status !== 'multi_horizon_pending'
  )).length
  const requiredMultiHorizonMetrics = [...new Set(activeProfiles.flatMap((profile) => profile.required_metrics))].sort()
  const materializedMultiHorizonMetrics = [...new Set(metricArtifacts
    .filter((row) => row.metric_value != null && Number.isFinite(Number(row.metric_value)))
    .map((row) => row.metric_name))].sort()
  const missingMultiHorizonMetrics = requiredMultiHorizonMetrics.filter((metric) => !materializedMultiHorizonMetrics.includes(metric))
  const formalOwnerIntegrated = completeHorizonCoverage
    && evidenceOwnerSnapshot.integration_ready
    && strategyEvidenceOwnerLineageMatches(evidenceOwnerSnapshot, productionPolicy?.base_weight_run_id)

  return c.json({
    success: true, mode: 'read_only', source,
    schema_version: STRATEGY_EVIDENCE_PROFILE_VERSION,
    runtime_strategy_count: runtimeSpecs.length,
    profile_count: profiles.length,
    complete: profiles.length === runtimeSpecs.length,
    multi_horizon_authority: formalOwnerIntegrated ? 'formal_owner' : evidenceOwnerSnapshot.integration_ready ? 'formal_owner_input_ready' : 'shadow_only',
    multi_horizon_coverage: multiHorizonCoverage,
    lanes: {
      formal: {
        lane_id: 'formal_adaptive_policy',
        label: '正式策略政策',
        version: formalPolicy?.version ?? null,
        status: formalPolicy?.status ?? 'unavailable',
        as_of_date: formalPolicy?.knowledge_cutoff_date ?? null,
        production_effect: formalEvidence.production_effect === true,
        authority: 'pending_buy_and_strategy_weights',
      },
      threshold_route_shadow: {
        lane_id: 'strategy_threshold_route_shadow',
        label: 'Shadow A：各策略門檻與路由',
        version: 'strategy-threshold-margin-affinity-v2',
        status: routeCalibration?.status ?? 'not_materialized',
        as_of_date: routeCalibration?.as_of_date ?? null,
        mature_dates: routeDates,
        required_mature_dates: STRATEGY_ROUTE_MIN_TOTAL_DATES,
        remaining_mature_dates: Math.max(0, STRATEGY_ROUTE_MIN_TOTAL_DATES - routeDates),
        gate_results: parseObject(routeCalibration?.gate_json),
        production_effect: false,
        authority: 'comparison_only',
      },
      multi_horizon_shadow: {
        lane_id: 'strategy_multi_horizon_evidence_shadow',
        label: 'Shadow B：策略專屬 3／5／10 日證據',
        version: STRATEGY_EVIDENCE_PROFILE_VERSION,
        status: formalOwnerIntegrated
          ? 'owner_integrated'
          : evidenceOwnerSnapshot.integration_ready
            ? 'owner_integration_ready'
            : completeHorizonCoverage ? 'outcomes_ready_metrics_materializing' : 'materializing',
        as_of_date: metricAsOfDate,
        horizon_coverage: multiHorizonCoverage,
        ready_primary_profiles: primaryProfilesReady,
        total_profiles: profiles.length,
        outcome_data_ready: completeHorizonCoverage && primaryProfilesReady === profiles.length,
        production_integration_ready: completeHorizonCoverage
          && evidenceOwnerSnapshot.integration_ready,
        production_owner: 'strategy-adaptive-lifecycle-v2',
        materialized_metrics: materializedMultiHorizonMetrics,
        missing_required_metrics: missingMultiHorizonMetrics,
        metric_materialized_profiles: metricMaterializedProfiles,
        metric_ready_profiles: metricReadyProfiles,
        evidence_owner_snapshot: evidenceOwnerSnapshot,
        formal_policy_lineage: productionPolicy,
        integration_effect: formalOwnerIntegrated ? 'status_aware_owner_input_active' : 'status_aware_owner_input_ready',
        production_effect: formalOwnerIntegrated,
        authority: formalOwnerIntegrated ? 'formal_owner' : 'formal_owner_input_pending_policy_closure',
      },
    },
    profiles: profilesWithMetrics,
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
    ...(await buildStrategyLearningSummary(databaseForDataDomain(c.env, 'learning'), date)),
  })
})

adminReadRoutes.get('/api/admin/strategy/policy-state', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const date = c.req.query('date') ?? twToday()
  const { buildStrategyLearningSummary, getLatestStrategyPolicyState } = await import('../lib/strategyLearning')
  const learningDb = databaseForDataDomain(c.env, 'learning')
  const summary = await buildStrategyLearningSummary(learningDb, date)
  return c.json({
    success: true,
    mode: 'read_only',
    date,
    latest: await getLatestStrategyPolicyState(learningDb),
    preview: summary.policy_state_preview,
    promotion_gate: summary.promotion_gate,
  })
})

adminReadRoutes.get('/api/admin/entry-model-v2/replay/latest', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const { getLatestEntryModelReplayReport } = await import('../lib/entryModelReplay')
  const latest = await getLatestEntryModelReplayReport(c.env.DB)
  return c.json({
    success: true,
    mode: 'read_only',
    latest,
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

  let candidateSource = 'request_body'
  const { listStrategySpecsForLearning, listStrategyLearningCandidates } = await import('../lib/strategyLearning')
  const { dryRunStrategySpec, listStrategySpecs } = await import('../lib/strategyLab')
  const { specs, source: specSource } = await listStrategySpecsForLearning(c.env.DB)
  if (!candidates.length) {
    candidates = await listStrategyLearningCandidates(c.env.DB, date, limit) as unknown as Array<Record<string, unknown>>
    candidateSource = 'screener_funnel_scoring_pass'
  }
  const runtimeSpecs = listStrategySpecs(specs)
  return c.json({
    success: true,
    mode: 'dry_run',
    date,
    source: candidateSource,
    spec_source: specSource,
    candidate_count: candidates.length,
    strategy_count: runtimeSpecs.length,
    results: runtimeSpecs.map((spec) => dryRunStrategySpec(spec, candidates as any)),
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

  const opsDb = databaseForDataDomain(c.env, 'ops')
  const { results } = await opsDb.prepare(
    `SELECT source, provider, model, SUM(est_usd) AS total_usd, COUNT(*) AS calls,
            SUM(COALESCE(tokens_in, 0)) AS tokens_in, SUM(COALESCE(tokens_out, 0)) AS tokens_out
     FROM cost_events WHERE date >= date('now', '-30 days')
     GROUP BY source, provider, model ORDER BY total_usd DESC`
  ).all<any>()

  const total = (results ?? []).reduce((sum: number, row: any) => sum + (row.total_usd ?? 0), 0)
  const { results: daily } = await opsDb.prepare(
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

adminReadRoutes.get('/api/admin/cron-logs', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const date = c.req.query('date') ?? twToday()
  const { getCronLogs } = await import('../lib/schedulerRunLogger')
  const logs = await getCronLogs(c.env.KV, date)
  return c.json({ date, logs })
})

adminReadRoutes.get('/api/admin/data-domains/cutover-readiness', async (c) => {
  const authError = await requireAdminOrServiceToken(c)
  if (authError) return authError

  const [
    { inspectDataDomainCutoverReadiness },
    { inspectLatestEveningChainClosure },
  ] = await Promise.all([
    import('../lib/dataDomainCutoverReadiness'),
    import('../lib/dataDomainShadowBackfillDrain'),
  ])
  const latestEveningChain = await inspectLatestEveningChainClosure(c.env.KV)
  const report = await inspectDataDomainCutoverReadiness(c.env.DB, c.req.query('domain'), {
    upstreamTerminalReady: latestEveningChain.terminalSuccess,
    parityNotBefore: latestEveningChain.timestamp,
    learningTargetDb: c.env.LEARNING_DB,
  })
  return c.json({ success: true, latest_evening_chain: latestEveningChain, ...report })
})
