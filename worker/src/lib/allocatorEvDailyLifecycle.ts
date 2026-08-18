import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { L4_ALPHA_EV_CONTRACT } from './evidenceContracts'
import { historicalLearningLineageDecision } from './historicalLearningLineageGuard'
import { nextTwTradingDate } from './schedulerPolicy'
import type { SchedulerRunLogEntry } from './schedulerRunLogger'

export type AllocatorEvLifecycleState =
  | 'lineage_ready'
  | 'snapshot_ready'
  | 'verify_triggered'
  | 'replay_pending_maturity'
  | 'replay_enqueued'
  | 'replay_complete'
  | 'error'

export interface AllocatorEvLifecycleRow {
  business_date: string
  state: AllocatorEvLifecycleState
  native_lineage_rows: number
  snapshot_run_id: string | null
  snapshot_rows: number
  replay_rows: number
  replay_maturity_as_of_date: string | null
  upstream_run_id: string | null
  attempt_count: number
  last_error: string | null
  updated_at: string
}

export interface AllocatorSnapshotClosure {
  businessDate: string
  recommendationRows: number
  recommendationMaxCreatedAt: string | null
  nativeLineageRows: number
  runNativeLineageRows: number
  reconstructedLineageRows: number
  rejectedLineageRows: number
  snapshotRunId: string | null
  expectedRows: number
  publishedRows: number
  actualRows: number
  snapshotMaxGeneratedAt: string | null
  ready: boolean
}

export interface AllocatorEvMaturityCoverage {
  asOfDate: string
  snapshotRows: number
  snapshotDates: number
  strictL4PitRows: number
  strictL4PitDates: number
  indexedL4PitRows: number
  indexedL4PitDates: number
  indexedL4PitMaxDate: string | null
  indexedL4PitBaseMaxDate: string | null
  indexedL4PitCohortId: string | null
  shadowL4PitMaxDate: string | null
  shadowL4PitCohortId: string | null
  incompatibleOrLegacyL4Rows: number
  latestSnapshotDate: string | null
  state: 'awaiting_first_point_in_time_l4' | 'accumulating_point_in_time_l4'
}

type AllocatorEvSchedulerEvidence = Pick<
  SchedulerRunLogEntry,
  'status' | 'summary' | 'run_id'
>

export interface AllocatorEvRecoveryUpstreamGate {
  ready: boolean
  blockers: string[]
  rootStatus: string
  pipelineStatus: string
  mlPredictStatus: string
  rootRunId: string | null
  pipelineRunId: string | null
  mlPredictRunId: string | null
}

function schedulerEvidenceText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Fail closed unless the canonical pipeline and ML child evidence describe the
 * same successful run and explicitly prove complete active-model coverage.
 *
 * The root chain can already be terminal-error because a downstream callback
 * failed; that is exactly what this watchdog is allowed to recover. A root
 * error owned by the pipeline callback itself is upstream failure and must not
 * be bypassed.
 */
export function evaluateAllocatorEvRecoveryUpstreamGate(input: {
  root: AllocatorEvSchedulerEvidence | null
  pipeline: AllocatorEvSchedulerEvidence | null
  mlPredict: AllocatorEvSchedulerEvidence | null
}): AllocatorEvRecoveryUpstreamGate {
  const rootStatus = schedulerEvidenceText(input.root?.status) || 'missing'
  const pipelineStatus = schedulerEvidenceText(input.pipeline?.status) || 'missing'
  const mlPredictStatus = schedulerEvidenceText(input.mlPredict?.status) || 'missing'
  const rootRunId = schedulerEvidenceText(input.root?.run_id) || null
  const pipelineRunId = schedulerEvidenceText(input.pipeline?.run_id) || null
  const mlPredictRunId = schedulerEvidenceText(input.mlPredict?.run_id) || null
  const rootSummary = schedulerEvidenceText(input.root?.summary)
  const mlPredictSummary = schedulerEvidenceText(input.mlPredict?.summary)
  const blockers: string[] = []

  if (pipelineStatus !== 'success') {
    blockers.push(`pipeline_terminal_not_success:${pipelineStatus}`)
  }
  if (mlPredictStatus !== 'success') {
    blockers.push(`ml_predict_terminal_not_success:${mlPredictStatus}`)
  }
  if (!rootRunId) blockers.push('root_run_id_missing')
  if (!pipelineRunId) blockers.push('pipeline_run_id_missing')
  if (!mlPredictRunId) blockers.push('ml_predict_run_id_missing')
  if (rootRunId && pipelineRunId && rootRunId !== pipelineRunId) {
    blockers.push(`root_pipeline_run_id_mismatch:root=${rootRunId}:pipeline=${pipelineRunId}`)
  }
  if (rootRunId && mlPredictRunId && rootRunId !== mlPredictRunId) {
    blockers.push(`root_ml_run_id_mismatch:root=${rootRunId}:ml=${mlPredictRunId}`)
  }
  if (pipelineRunId && mlPredictRunId && pipelineRunId !== mlPredictRunId) {
    blockers.push(`pipeline_ml_run_id_mismatch:pipeline=${pipelineRunId}:ml=${mlPredictRunId}`)
  }
  if (!/(?:^|\s)active_model_closure=true(?:\s|$)/i.test(mlPredictSummary)) {
    blockers.push('active_model_closure_not_proven')
  }

  const rootStoppedAtPipeline = /^root chain stopped at pipeline callback:/i.test(rootSummary)
  const downstreamRootRecovery = /^(?:root chain stopped in post-pipeline callback chain:|root chain stopped at allocator snapshot callback:)/i.test(rootSummary)
  if (['error', 'skipped'].includes(rootStatus) && rootStoppedAtPipeline) {
    blockers.push(`root_pipeline_terminal_error:${rootStatus}`)
  } else if (!['running', 'triggered', 'success'].includes(rootStatus)
    && !(['error', 'skipped'].includes(rootStatus) && downstreamRootRecovery)) {
    blockers.push(`root_terminal_not_recoverable:${rootStatus}`)
  }

  return {
    ready: blockers.length === 0,
    blockers,
    rootStatus,
    pipelineStatus,
    mlPredictStatus,
    rootRunId,
    pipelineRunId,
    mlPredictRunId,
  }
}

async function readAllocatorEvSchedulerEvidence(
  kv: KVNamespace,
  task: 'evening-chain' | 'pipeline' | 'ml-predict',
  businessDate: string,
): Promise<AllocatorEvSchedulerEvidence | null> {
  try {
    const value = await kv.get(`scheduler:run:${task}:${businessDate}`, 'json')
    return value && typeof value === 'object'
      ? value as AllocatorEvSchedulerEvidence
      : null
  } catch {
    return null
  }
}

export async function inspectAllocatorEvRecoveryUpstreamGate(
  kv: KVNamespace,
  businessDate: string,
): Promise<AllocatorEvRecoveryUpstreamGate> {
  const [root, pipeline, mlPredict] = await Promise.all([
    readAllocatorEvSchedulerEvidence(kv, 'evening-chain', businessDate),
    readAllocatorEvSchedulerEvidence(kv, 'pipeline', businessDate),
    readAllocatorEvSchedulerEvidence(kv, 'ml-predict', businessDate),
  ])
  return evaluateAllocatorEvRecoveryUpstreamGate({ root, pipeline, mlPredict })
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export async function inspectAllocatorEvMaturityCoverage(
  db: D1Database,
  asOfDate: string,
): Promise<AllocatorEvMaturityCoverage> {
  if (!validDate(asOfDate)) throw new Error(`invalid allocator EV maturity date: ${asOfDate}`)
  const [row, indexed, shadow] = await Promise.all([
    db.prepare(`
    WITH classified AS (
      SELECT snapshot_date,
             l4_model_version,
             CASE WHEN
               l4_model_version IS NOT NULL
               AND json_extract(alpha_allocation, '$.snapshot_l4_available') = 1
               AND date(json_extract(alpha_allocation, '$.l4_alpha_ev.trained_until')) < date(snapshot_date)
               AND json_extract(alpha_allocation, '$.l4_alpha_ev.artifact_contract_version') = ?
               AND json_extract(alpha_allocation, '$.l4_alpha_ev.feature_semantic_version') = ?
               AND json_extract(alpha_allocation, '$.l4_alpha_ev.label_schema_version') = ?
               AND json_extract(alpha_allocation, '$.l4_alpha_ev.point_in_time_prediction_lineage.schema_version') = 'l4-point-in-time-prediction-lineage-v1'
               AND date(json_extract(alpha_allocation, '$.l4_alpha_ev.point_in_time_prediction_lineage.prediction_date')) = date(snapshot_date)
               AND date(json_extract(alpha_allocation, '$.l4_alpha_ev.point_in_time_prediction_lineage.trained_until')) < date(snapshot_date)
             THEN 1 ELSE 0 END AS strict_l4_pit
        FROM allocator_ev_feature_snapshots
       WHERE snapshot_source = 'allocator_ev_asof_backfill_v2'
         AND date(snapshot_date) <= date(?)
    )
    SELECT COUNT(*) AS snapshot_rows,
           COUNT(DISTINCT snapshot_date) AS snapshot_dates,
           COALESCE(SUM(strict_l4_pit), 0) AS strict_l4_pit_rows,
           COUNT(DISTINCT CASE WHEN strict_l4_pit = 1 THEN snapshot_date END) AS strict_l4_pit_dates,
           COALESCE(SUM(CASE WHEN l4_model_version IS NOT NULL AND strict_l4_pit = 0 THEN 1 ELSE 0 END), 0) AS incompatible_or_legacy_l4_rows,
           MAX(snapshot_date) AS latest_snapshot_date
      FROM classified
  `).bind(
    L4_ALPHA_EV_CONTRACT.artifactContractVersion,
    L4_ALPHA_EV_CONTRACT.featureSemanticVersion,
    L4_ALPHA_EV_CONTRACT.labelSchemaVersion,
    asOfDate,
  ).first<{
    snapshot_rows?: number
    snapshot_dates?: number
    strict_l4_pit_rows?: number
    strict_l4_pit_dates?: number
    incompatible_or_legacy_l4_rows?: number
    latest_snapshot_date?: string | null
  }>(),
    db.prepare(`
      SELECT a.cohort_id,
             a.row_count,
             a.date_count,
             a.max_date
        FROM active8_oof_materialized_artifacts a
        JOIN active8_oof_cohorts c ON c.cohort_id = a.cohort_id
       WHERE a.artifact_kind = 'l4_predictions'
         AND c.status = 'ready'
         AND a.row_count > 0
         AND a.date_count > 0
         AND date(a.max_date) <= date(?)
       ORDER BY a.max_date DESC, a.updated_at DESC, c.updated_at DESC, a.cohort_id DESC
       LIMIT 1
    `).bind(asOfDate).first<{
      cohort_id?: string | null
      row_count?: number
      date_count?: number
      max_date?: string | null
    }>(),
    db.prepare(`
      SELECT f.cohort_id, f.row_count, f.date_count, f.max_date
        FROM active8_oof_forward_extension_coverage f
        JOIN active8_oof_cohorts c ON c.cohort_id = f.cohort_id
       WHERE f.artifact_kind = 'l4_predictions'
         AND c.status = 'ready'
         AND f.coverage_status = 'verified'
         AND f.promotion_eligible = 0
         AND f.training_dispatched = 0
         AND f.policy_version = 'verified-frozen-forward-monitoring-v1'
         AND f.row_count > 0
         AND f.date_count > 0
         AND date(f.knowledge_cutoff_date) <= date(?)
         AND date(f.max_date) <= date(?)
       ORDER BY f.max_date DESC, f.knowledge_cutoff_date DESC, f.updated_at DESC, f.cohort_id DESC
       LIMIT 1
    `).bind(asOfDate, asOfDate).first<{
      cohort_id?: string | null
      row_count?: number
      date_count?: number
      max_date?: string | null
    }>(),
  ])
  const nativeStrictL4PitRows = Number(row?.strict_l4_pit_rows ?? 0)
  const nativeStrictL4PitDates = Number(row?.strict_l4_pit_dates ?? 0)
  const indexedL4PitRows = Number(indexed?.row_count ?? 0)
  const indexedL4PitDates = Number(indexed?.date_count ?? 0)
  const strictL4PitRows = Math.max(nativeStrictL4PitRows, indexedL4PitRows)
  const strictL4PitDates = Math.max(nativeStrictL4PitDates, indexedL4PitDates)
  const indexedL4PitMaxDate = [indexed?.max_date, shadow?.max_date]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null
  return {
    asOfDate,
    snapshotRows: Number(row?.snapshot_rows ?? 0),
    snapshotDates: Number(row?.snapshot_dates ?? 0),
    strictL4PitRows,
    strictL4PitDates,
    indexedL4PitRows,
    indexedL4PitDates,
    indexedL4PitMaxDate,
    indexedL4PitBaseMaxDate: indexed?.max_date ?? null,
    indexedL4PitCohortId: indexed?.cohort_id ?? null,
    shadowL4PitMaxDate: shadow?.max_date ?? null,
    shadowL4PitCohortId: shadow?.cohort_id ?? null,
    incompatibleOrLegacyL4Rows: Number(row?.incompatible_or_legacy_l4_rows ?? 0),
    latestSnapshotDate: row?.latest_snapshot_date ?? null,
    state: strictL4PitRows > 0
      ? 'accumulating_point_in_time_l4'
      : 'awaiting_first_point_in_time_l4',
  }
}

function maturitySummary(coverage: AllocatorEvMaturityCoverage): string {
  return `l4_pit_state=${coverage.state} l4_pit_rows=${coverage.strictL4PitRows} `
    + `l4_pit_dates=${coverage.strictL4PitDates} legacy_l4_rows=${coverage.incompatibleOrLegacyL4Rows}`
}

export async function readAllocatorEvLifecycle(
  db: D1Database,
  businessDate: string,
): Promise<AllocatorEvLifecycleRow | null> {
  return await db.prepare(`
    SELECT business_date, state, native_lineage_rows, snapshot_run_id,
           snapshot_rows, replay_rows, replay_maturity_as_of_date,
           upstream_run_id, attempt_count, last_error, updated_at
      FROM allocator_ev_daily_lifecycle
     WHERE business_date = ?
     LIMIT 1
  `).bind(businessDate).first<AllocatorEvLifecycleRow>()
}

export async function recordAllocatorEvLifecycle(
  db: D1Database,
  input: {
    businessDate: string
    state: AllocatorEvLifecycleState
    nativeLineageRows?: number
    snapshotRunId?: string | null
    snapshotRows?: number
    replayRows?: number
    replayMaturityAsOfDate?: string | null
    upstreamRunId?: string | null
    lastError?: string | null
    incrementAttempt?: boolean
    expectedLifecycleRunId?: string | null
    stageAuthority?: {
      businessDate?: string
      stage: string
      canonicalRunId: string
      leaseOwner?: string | null
    }
  },
  authorityDb: D1Database = db,
): Promise<boolean> {
  if (!validDate(input.businessDate)) throw new Error(`invalid allocator EV lifecycle date: ${input.businessDate}`)
  const closed = input.state === 'replay_complete' ? new Date().toISOString() : null
  const authority = input.stageAuthority
  const splitAuthorityDb = Boolean(authority && authorityDb !== db)
  const hasAuthority = async (): Promise<boolean> => {
    if (!authority) return true
    const row = await authorityDb.prepare(`
      SELECT 1 AS authorized
        FROM pipeline_stage_runs authority
       WHERE authority.business_date=?
         AND authority.stage=?
         AND authority.canonical_run_id=?
         AND (? IS NULL OR (
           authority.status='running'
           AND authority.lease_owner=?
           AND authority.lease_expires_at >= CURRENT_TIMESTAMP
         ))
       LIMIT 1
    `).bind(
      authority.businessDate ?? input.businessDate,
      authority.stage,
      authority.canonicalRunId,
      authority.leaseOwner ?? null,
      authority.leaseOwner ?? null,
    ).first<{ authorized: number }>()
    return Boolean(row?.authorized)
  }
  if (splitAuthorityDb && !(await hasAuthority())) return false
  const authoritySql = authority && !splitAuthorityDb
    ? `EXISTS (
        SELECT 1 FROM pipeline_stage_runs authority
         WHERE authority.business_date=?
           AND authority.stage=?
           AND authority.canonical_run_id=?
           AND (? IS NULL OR (
             authority.status='running'
             AND authority.lease_owner=?
             AND authority.lease_expires_at >= CURRENT_TIMESTAMP
           ))
      )`
    : '1=1'
  const authorityBindings = authority && !splitAuthorityDb
    ? [
        authority.businessDate ?? input.businessDate,
        authority.stage,
        authority.canonicalRunId,
        authority.leaseOwner ?? null,
        authority.leaseOwner ?? null,
      ]
    : []
  const expectedLifecycleRunId = input.expectedLifecycleRunId?.trim() || null
  const updated = await db.prepare(`
    INSERT INTO allocator_ev_daily_lifecycle (
      business_date, state, native_lineage_rows, snapshot_run_id,
      snapshot_rows, replay_rows, replay_maturity_as_of_date,
      upstream_run_id, attempt_count, last_error, created_at, updated_at, closed_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?
     WHERE ${authoritySql}
       AND (
         ? IS NULL
         OR EXISTS (
           SELECT 1 FROM allocator_ev_daily_lifecycle current_lifecycle
            WHERE current_lifecycle.business_date=?
              AND current_lifecycle.upstream_run_id=?
         )
       )
    ON CONFLICT(business_date) DO UPDATE SET
      state = CASE
        WHEN allocator_ev_daily_lifecycle.state = 'replay_complete' THEN allocator_ev_daily_lifecycle.state
        WHEN excluded.state = 'error' THEN excluded.state
        WHEN allocator_ev_daily_lifecycle.state = 'replay_enqueued'
         AND excluded.state = 'replay_pending_maturity' THEN excluded.state
        WHEN (CASE excluded.state
          WHEN 'lineage_ready' THEN 1 WHEN 'snapshot_ready' THEN 2 WHEN 'verify_triggered' THEN 3
          WHEN 'replay_pending_maturity' THEN 4 WHEN 'replay_enqueued' THEN 5 WHEN 'replay_complete' THEN 6
          ELSE 0 END) >=
          (CASE allocator_ev_daily_lifecycle.state
          WHEN 'lineage_ready' THEN 1 WHEN 'snapshot_ready' THEN 2 WHEN 'verify_triggered' THEN 3
          WHEN 'replay_pending_maturity' THEN 4 WHEN 'replay_enqueued' THEN 5 WHEN 'replay_complete' THEN 6
          ELSE 0 END)
        THEN excluded.state
        ELSE allocator_ev_daily_lifecycle.state
      END,
      native_lineage_rows = MAX(allocator_ev_daily_lifecycle.native_lineage_rows, excluded.native_lineage_rows),
      snapshot_run_id = COALESCE(excluded.snapshot_run_id, allocator_ev_daily_lifecycle.snapshot_run_id),
      snapshot_rows = MAX(allocator_ev_daily_lifecycle.snapshot_rows, excluded.snapshot_rows),
      replay_rows = MAX(allocator_ev_daily_lifecycle.replay_rows, excluded.replay_rows),
      replay_maturity_as_of_date = COALESCE(excluded.replay_maturity_as_of_date, allocator_ev_daily_lifecycle.replay_maturity_as_of_date),
      upstream_run_id = COALESCE(excluded.upstream_run_id, allocator_ev_daily_lifecycle.upstream_run_id),
      attempt_count = allocator_ev_daily_lifecycle.attempt_count + excluded.attempt_count,
      last_error = excluded.last_error,
      updated_at = CURRENT_TIMESTAMP,
      closed_at = COALESCE(excluded.closed_at, allocator_ev_daily_lifecycle.closed_at)
    WHERE ${authoritySql}
      AND (? IS NULL OR allocator_ev_daily_lifecycle.upstream_run_id=?)
    RETURNING business_date
  `).bind(
    input.businessDate,
    input.state,
    Math.max(0, Number(input.nativeLineageRows ?? 0)),
    input.snapshotRunId ?? null,
    Math.max(0, Number(input.snapshotRows ?? 0)),
    Math.max(0, Number(input.replayRows ?? 0)),
    input.replayMaturityAsOfDate ?? null,
    input.upstreamRunId ?? null,
    input.incrementAttempt ? 1 : 0,
    input.lastError ?? null,
    closed,
    ...authorityBindings,
    expectedLifecycleRunId,
    input.businessDate,
    expectedLifecycleRunId,
    ...authorityBindings,
    expectedLifecycleRunId,
    expectedLifecycleRunId,
  ).first<{ business_date: string }>()
  if (!updated) return false
  return splitAuthorityDb ? await hasAuthority() : true
}

export async function inspectAllocatorSnapshotClosure(
  db: D1Database,
  businessDate: string,
  options: {
    allowPointInTimeReconstruction?: boolean
    learningDb?: D1Database
    opsDb?: D1Database
    coreDb?: D1Database
    kv?: KVNamespace
    nowMs?: number
  } = {},
): Promise<AllocatorSnapshotClosure> {
  if (!validDate(businessDate)) throw new Error(`invalid allocator snapshot date: ${businessDate}`)
  const learningDb = options.learningDb ?? db
  const opsDb = options.opsDb ?? db
  const coreDb = options.coreDb ?? db
  const nowMs = options.nowMs ?? Date.now()
  const today = new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10)
  let nextSessionOpenUtc: string | null = null
  if (businessDate < today && options.kv) {
    try {
      const nextSessionDate = await nextTwTradingDate(options.kv, businessDate, db, {
        requireOfficialFutureCalendar: true,
        nowMs,
      })
      nextSessionOpenUtc = `${nextSessionDate}T01:00:00.000Z`
    } catch (error) {
      console.warn(`[allocatorEvDailyLifecycle] next session unresolved for ${businessDate}:`, error)
    }
  }
  const [canonicalHead, references, run, actual] = await Promise.all([
    opsDb.prepare(`
      SELECT run_id
        FROM canonical_run_heads
       WHERE logical_run_key = ?
       LIMIT 1
    `).bind(`screener:${businessDate}:TW:production:market_screener`)
      .first<{ run_id?: string | null }>(),
    learningDb.prepare(`
      SELECT symbol, producer_run_id
        FROM selection_reference_snapshots_v1
       WHERE signal_date = ?
         AND score_components IS NOT NULL
         AND json_extract(score_components, '$.version') = 'score_v2'
    `).bind(businessDate).all<{ symbol: string; producer_run_id: string }>(),
    learningDb.prepare(`
      SELECT run_id, expected_rows, published_rows, status,
             native_lineage_rows, reconstructed_lineage_rows, rejected_lineage_rows
        FROM allocator_ev_snapshot_runs
       WHERE snapshot_date = ?
         AND snapshot_source = 'allocator_ev_asof_backfill_v2'
       ORDER BY datetime(created_at) DESC, run_id DESC
       LIMIT 1
    `).bind(businessDate).first<{
      run_id?: string
      expected_rows?: number
      published_rows?: number
      status?: string
      native_lineage_rows?: number
      reconstructed_lineage_rows?: number
      rejected_lineage_rows?: number
    }>(),
    learningDb.prepare(`
      SELECT COUNT(*) AS row_count,
             MAX(generated_at) AS max_generated_at
        FROM allocator_ev_feature_snapshots
       WHERE snapshot_date = ?
         AND snapshot_source = 'allocator_ev_asof_backfill_v2'
    `).bind(businessDate).first<{ row_count?: number; max_generated_at?: string | null }>(),
  ])
  const canonicalRunId = String(canonicalHead?.run_id ?? '').trim()
  const canonicalSymbols = new Set(
    (references.results ?? [])
      .filter((row) => canonicalRunId && String(row.producer_run_id ?? '').trim() === canonicalRunId)
      .map((row) => String(row.symbol ?? '').trim())
      .filter(Boolean),
  )
  const [recommendations, predictions] = await Promise.all([
    coreDb.prepare(`
      SELECT COALESCE(dr.stock_id, st.id) AS stock_id, dr.symbol, dr.created_at
        FROM daily_recommendations dr
        LEFT JOIN stocks st ON st.symbol = dr.symbol
       WHERE dr.date = ?
    `).bind(businessDate).all<{ stock_id?: number | string | null; symbol: string; created_at?: string | null }>(),
    learningDb.prepare(`
      SELECT DISTINCT stock_id
        FROM predictions
       WHERE prediction_date >= ?
         AND prediction_date < date(?, '+1 day')
         AND model_name = 'ensemble'
         AND stock_id IS NOT NULL
         AND forecast_data IS NOT NULL
         AND (
           date(datetime(generated_at, '+8 hours')) <= substr(prediction_date, 1, 10)
           OR (? IS NOT NULL AND datetime(generated_at) < datetime(?))
         )
    `).bind(businessDate, businessDate, nextSessionOpenUtc, nextSessionOpenUtc)
      .all<{ stock_id: number | string }>(),
  ])
  const canonicalRecommendations = (recommendations.results ?? [])
    .filter((row) => canonicalSymbols.has(String(row.symbol ?? '').trim()))
  const causalPredictionStockIds = new Set(
    (predictions.results ?? []).map((row) => String(row.stock_id)),
  )
  const canonicalRecommendationMaxCreatedAt = canonicalRecommendations.reduce<string | null>((latest, row) => {
    const createdAt = String(row.created_at ?? '').trim()
    return createdAt && (!latest || createdAt > latest) ? createdAt : latest
  }, null)
  const lineage = {
    recommendation_rows: canonicalRecommendations.length,
    recommendation_max_created_at: canonicalRecommendationMaxCreatedAt,
    row_count: canonicalRecommendations.filter((row) =>
      row.stock_id != null && causalPredictionStockIds.has(String(row.stock_id))).length,
  }
  const expectedRows = Number(run?.expected_rows ?? 0)
  const publishedRows = Number(run?.published_rows ?? 0)
  const actualRows = Number(actual?.row_count ?? 0)
  const runNativeLineageRows = Number(run?.native_lineage_rows ?? 0)
  const reconstructedLineageRows = Number(run?.reconstructed_lineage_rows ?? 0)
  const rejectedLineageRows = Number(run?.rejected_lineage_rows ?? 0)
  const recommendationRows = Number(lineage?.recommendation_rows ?? 0)
  const recommendationMaxCreatedAt = lineage?.recommendation_max_created_at ?? null
  const snapshotMaxGeneratedAt = actual?.max_generated_at ?? null
  const snapshotFresh = Boolean(recommendationMaxCreatedAt && snapshotMaxGeneratedAt)
    && Date.parse(String(snapshotMaxGeneratedAt)) >= Date.parse(`${recommendationMaxCreatedAt}Z`)
  const commonReady = run?.status === 'ready'
    && expectedRows > 0
    && recommendationRows === expectedRows
    && publishedRows === expectedRows
    && actualRows === expectedRows
    && snapshotFresh
  const nativeReady = Number(lineage?.row_count ?? 0) === expectedRows
    && runNativeLineageRows === expectedRows
    && reconstructedLineageRows === 0
    && rejectedLineageRows === 0
  const reconstructedReady = options.allowPointInTimeReconstruction === true
    && reconstructedLineageRows > 0
    && runNativeLineageRows + reconstructedLineageRows === expectedRows
    && rejectedLineageRows === 0
  return {
    businessDate,
    recommendationRows,
    recommendationMaxCreatedAt,
    nativeLineageRows: Number(lineage?.row_count ?? 0),
    runNativeLineageRows,
    reconstructedLineageRows,
    rejectedLineageRows,
    snapshotRunId: run?.run_id ?? null,
    expectedRows,
    publishedRows,
    actualRows,
    snapshotMaxGeneratedAt,
    ready: commonReady && (nativeReady || reconstructedReady),
  }
}

function staleVerifyTrigger(row: AllocatorEvLifecycleRow | null): boolean {
  if (row?.state !== 'verify_triggered') return false
  const updatedAt = Date.parse(row.updated_at)
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= 15 * 60_000
}

async function resolveLifecycleBusinessDate(db: D1Database, requestedDate?: string): Promise<string> {
  if (requestedDate) {
    if (!validDate(requestedDate)) throw new Error(`invalid allocator EV lifecycle date: ${requestedDate}`)
    return requestedDate
  }
  const recoverableSourceError = await db.prepare(`
    SELECT business_date
      FROM allocator_ev_daily_lifecycle
     WHERE state = 'error'
       AND last_error LIKE 'terminal market-data source error:%'
       AND datetime(updated_at) <= datetime('now', '-12 hours')
     ORDER BY business_date ASC
     LIMIT 1
  `).first<{ business_date?: string | null }>()
  const recoverableDate = String(recoverableSourceError?.business_date ?? '').trim().slice(0, 10)
  if (validDate(recoverableDate)) return recoverableDate
  const pending = await db.prepare(`
    SELECT business_date
      FROM allocator_ev_daily_lifecycle
     WHERE state = 'replay_pending_maturity'
     ORDER BY business_date ASC
     LIMIT 1
  `).first<{ business_date?: string | null }>()
  const pendingDate = String(pending?.business_date ?? '').trim().slice(0, 10)
  if (validDate(pendingDate)) {
    const { loadFusionSnapshotReplayCoverage } = await import('./s12ReplayTradeOutcome')
    const coverage = await loadFusionSnapshotReplayCoverage(db, pendingDate, twTodayDate())
    if (coverage.matureMissingRows > 0) return pendingDate
  }
  const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const latest = await db.prepare(`
    SELECT MAX(prediction_date) AS business_date
      FROM predictions
     WHERE model_name = 'ensemble'
       AND prediction_date <= ?
  `).bind(twToday).first<{ business_date?: string | null }>()
  const businessDate = String(latest?.business_date ?? '').trim().slice(0, 10)
  if (!validDate(businessDate)) throw new Error(`allocator EV lifecycle has no ensemble prediction date through ${twToday}`)
  return businessDate
}

function twTodayDate(): string {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

export async function runAllocatorEvLifecycleWatchdog(
  env: Bindings,
  requestedDate?: string,
): Promise<string> {
  const businessDate = await resolveLifecycleBusinessDate(env.DB, requestedDate)
  const [snapshot, maturity] = await Promise.all([
    inspectAllocatorSnapshotClosure(env.DB, businessDate, {
      allowPointInTimeReconstruction: true,
      learningDb: databaseForDataDomain(env, 'learning'),
      opsDb: databaseForDataDomain(env, 'ops'),
      coreDb: databaseForDataDomain(env, 'core'),
      kv: env.KV,
    }),
    inspectAllocatorEvMaturityCoverage(databaseForDataDomain(env, 'learning'), businessDate),
  ])
  if (snapshot.nativeLineageRows <= 0) {
    if (snapshot.recommendationRows <= 0) {
      return `skipped: allocator EV lifecycle has no Score V2 recommendations for ${businessDate}; ${maturitySummary(maturity)}`
    }
    const reason = `missing point-in-time ensemble lineage before next executable session open `
      + `recommendations=${snapshot.recommendationRows}; ${maturitySummary(maturity)}`
    await recordAllocatorEvLifecycle(databaseForDataDomain(env, 'learning'), {
      businessDate,
      state: 'error',
      nativeLineageRows: 0,
      lastError: reason,
      incrementAttempt: true,
    })
    throw new Error(`allocator_ev_missing_point_in_time_lineage:${businessDate}:${reason}`)
  }
  const postPipelineStage = await databaseForDataDomain(env, 'ops').prepare(`
    SELECT status, canonical_run_id, updated_at, lease_expires_at, attempt_count
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage='post_pipeline_chain'
  `).bind(businessDate).first<{
    status?: string | null
    canonical_run_id?: string | null
    updated_at?: string | null
    lease_expires_at?: string | null
    attempt_count?: number | string | null
  }>()
  const stageTimestamp = String(postPipelineStage?.updated_at ?? '').trim()
  const stageTimestampUtc = stageTimestamp && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(stageTimestamp)
    ? `${stageTimestamp.replace(' ', 'T')}Z`
    : stageTimestamp
  const stageAgeMs = Date.now() - Date.parse(stageTimestampUtc)
  const stageLeaseExpiresAt = String(postPipelineStage?.lease_expires_at ?? '').trim()
  const stageLeaseExpiresAtUtc = stageLeaseExpiresAt && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(stageLeaseExpiresAt)
    ? `${stageLeaseExpiresAt.replace(' ', 'T')}Z`
    : stageLeaseExpiresAt
  const stageLeaseLive = Date.parse(stageLeaseExpiresAtUtc) >= Date.now()
  const callbackGraceActive = !snapshot.ready
    && ['queued', 'running', 'waiting'].includes(String(postPipelineStage?.status ?? ''))
    && (postPipelineStage?.status !== 'running' || stageLeaseLive)
    && Number.isFinite(stageAgeMs)
    && stageAgeMs >= 0
    && stageAgeMs < 15 * 60_000
  if (callbackGraceActive) {
    return `allocator EV lifecycle awaiting durable callback date=${businessDate} `
      + `stage=${postPipelineStage?.status} age_seconds=${Math.floor(stageAgeMs / 1000)} `
      + `run_id=${postPipelineStage?.canonical_run_id ?? 'unknown'} `
      + `lineage=${snapshot.nativeLineageRows} expected=${snapshot.expectedRows} actual=${snapshot.actualRows}`
  }
  const lifecycle = await readAllocatorEvLifecycle(databaseForDataDomain(env, 'learning'), businessDate)
  const postVerifyReached = lifecycle && ['replay_pending_maturity', 'replay_enqueued', 'replay_complete'].includes(lifecycle.state)
  const postPipelineReached = lifecycle
    && [
      'verify_triggered', 'replay_pending_maturity', 'replay_enqueued', 'replay_complete',
    ].includes(lifecycle.state)
  if (
    snapshot.ready
    && postPipelineReached
    && lifecycle?.upstream_run_id
    && postPipelineStage?.canonical_run_id === lifecycle.upstream_run_id
    && postPipelineStage?.status === 'waiting'
  ) {
    const { markPipelineStageFenced } = await import('./pipelineStageLease')
    await markPipelineStageFenced(env.DB, {
      businessDate,
      stage: 'post_pipeline_chain',
      canonicalRunId: lifecycle.upstream_run_id,
      status: 'success',
      error: null,
    })
  }
  let matureReplayMissingRows = 0
  if (lifecycle?.state === 'replay_pending_maturity') {
    const { loadFusionSnapshotReplayCoverage } = await import('./s12ReplayTradeOutcome')
    const coverage = await loadFusionSnapshotReplayCoverage(env.DB, businessDate, twTodayDate())
    matureReplayMissingRows = coverage.matureMissingRows
  }
  if (snapshot.ready && lifecycle?.state === 'replay_pending_maturity' && matureReplayMissingRows > 0) {
    const maturityAsOfDate = twTodayDate()
    const runId = `allocator-ev-lifecycle-mature-replay-${businessDate}-${Date.now()}`
    const replayRecorded = await recordAllocatorEvLifecycle(databaseForDataDomain(env, 'learning'), {
      businessDate,
      state: 'replay_enqueued',
      replayMaturityAsOfDate: maturityAsOfDate,
      upstreamRunId: lifecycle.upstream_run_id,
      expectedLifecycleRunId: lifecycle.upstream_run_id,
      incrementAttempt: true,
    })
    if (!replayRecorded) {
      return `allocator EV lifecycle stale replay enqueue ignored date=${businessDate} run_id=${runId}`
    }
    await env.UPDATE_QUEUE.send({
      type: 's12_replay_backfill_chunk',
      cursor: 0,
      triggerTime: businessDate,
      runId,
      replayScope: 'fusion_snapshot_missing',
      maturityAsOfDate,
      statusRunDate: businessDate,
      lifecycleRunId: lifecycle.upstream_run_id,
    } as any)
    return `allocator EV lifecycle replay enqueued date=${businessDate} mature_missing=${matureReplayMissingRows} as_of=${maturityAsOfDate}; ${maturitySummary(maturity)}`
  }
  if (snapshot.ready && (
    (postVerifyReached && matureReplayMissingRows === 0)
    || (lifecycle?.state === 'verify_triggered' && !staleVerifyTrigger(lifecycle))
  )) {
    return `allocator EV lifecycle current date=${businessDate} state=${lifecycle?.state} snapshot_rows=${snapshot.actualRows}; ${maturitySummary(maturity)}`
  }
  if (snapshot.ready && lifecycle?.state === 'verify_triggered') {
    const verifyStage = await databaseForDataDomain(env, 'ops').prepare(`
      SELECT status, canonical_run_id, cursor_key
        FROM pipeline_stage_runs
       WHERE business_date=? AND stage='verify_v2'
    `).bind(businessDate).first<{
      status?: string | null
      canonical_run_id?: string | null
      cursor_key?: string | null
    }>()
    if (verifyStage?.status === 'success') {
      const lifecycleRunId = String(lifecycle.upstream_run_id ?? '').trim()
      const verifyCanonicalRunId = String(verifyStage.canonical_run_id ?? '').trim()
      const verifyCursorKey = String(verifyStage.cursor_key ?? '').trim()
      if (!lifecycleRunId || verifyCanonicalRunId !== lifecycleRunId || !verifyCursorKey) {
        return `allocator EV lifecycle post-verify authority mismatch date=${businessDate} `
          + `lifecycle_run_id=${lifecycleRunId || 'missing'} `
          + `verify_canonical_run_id=${verifyCanonicalRunId || 'missing'} `
          + `verify_cursor_key=${verifyCursorKey || 'missing'}`
      }
      const { queuePostVerifyStage } = await import('./pipelineStageLease')
      const continuation = await queuePostVerifyStage(env, {
        businessDate,
        runId: lifecycleRunId,
        resumeWaiting: true,
        expectedCanonicalRunId: lifecycleRunId,
        authority: {
          stage: 'verify_v2',
          canonicalRunId: lifecycleRunId,
          status: 'success',
          cursorKey: verifyCursorKey,
        },
        attempt: Math.max(1, Number(lifecycle.attempt_count ?? 0) + 1),
      })
      return continuation.queued
        ? `allocator EV lifecycle recovered post-verify date=${businessDate} run_id=${continuation.canonicalRunId}`
        : `allocator EV lifecycle post-verify current date=${businessDate} status=${continuation.status}`
    }
  }
  const repairBoundary = !snapshot.ready
    ? await historicalLearningLineageDecision(env.DB, env.KV, 'evening-chain', businessDate)
    : null
  if (!snapshot.ready && repairBoundary && !repairBoundary.allowed) {
    return `skipped: allocator EV native snapshot repair window closed for historical date=${businessDate} `
      + `reason=${repairBoundary.reason} next_session=${repairBoundary.nextSessionDate ?? 'missing'} `
      + `next_open_utc=${repairBoundary.nextSessionOpenUtc ?? 'missing'} `
      + `recommendations=${snapshot.recommendationRows} lineage=${snapshot.nativeLineageRows} `
      + `run_native=${snapshot.runNativeLineageRows} reconstructed=${snapshot.reconstructedLineageRows} `
      + `rejected=${snapshot.rejectedLineageRows} expected=${snapshot.expectedRows} published=${snapshot.publishedRows} actual=${snapshot.actualRows} `
      + `recommendation_max=${snapshot.recommendationMaxCreatedAt ?? 'missing'} snapshot_max=${snapshot.snapshotMaxGeneratedAt ?? 'missing'}; `
      + `${maturitySummary(maturity)}`
  }

  const upstreamGate = await inspectAllocatorEvRecoveryUpstreamGate(env.KV, businessDate)
  if (!upstreamGate.ready) {
    return `skipped: allocator EV lifecycle upstream closure not proven date=${businessDate} `
      + `root=${upstreamGate.rootStatus} pipeline=${upstreamGate.pipelineStatus} `
      + `ml_predict=${upstreamGate.mlPredictStatus} `
      + `root_run_id=${upstreamGate.rootRunId ?? 'missing'} `
      + `pipeline_run_id=${upstreamGate.pipelineRunId ?? 'missing'} `
      + `ml_run_id=${upstreamGate.mlPredictRunId ?? 'missing'} `
      + `blockers=${upstreamGate.blockers.join(',')}`
  }

  const { queuePostPipelineStage } = await import('./pipelineStageLease')
  const recoveryRunId = upstreamGate.pipelineRunId
  if (!recoveryRunId) throw new Error('allocator_ev_recovery_gate_invariant:pipeline_run_id_missing')
  const recoveryAttempt = Math.max(1, Number(postPipelineStage?.attempt_count ?? 1))
  const continuation = await queuePostPipelineStage(env, {
    businessDate,
    runId: recoveryRunId,
    resumeWaiting: true,
    expectedCanonicalRunId: recoveryRunId,
    attempt: recoveryAttempt,
  })
  return continuation.queued
    ? `allocator EV lifecycle recovery queued date=${businessDate} attempt=${recoveryAttempt} run_id=${continuation.canonicalRunId}`
    : `allocator EV lifecycle recovery current date=${businessDate} status=${continuation.status} run_id=${continuation.canonicalRunId}`
}
