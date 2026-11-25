import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { L4_ALPHA_EV_CONTRACT } from './evidenceContracts'
import { historicalLearningLineageDecision } from './historicalLearningLineageGuard'
import { nextTwTradingDate } from './schedulerPolicy'
import type { SchedulerRunLogEntry } from './schedulerRunLogger'

// Each watchdog tick used to re-queue a failed post-verify with no limit, so a
// stuck date retried every 10 minutes forever (11/3 kept learning-db overloaded
// on 2026-11-04). The authorized re-queue resets attempt_count, so the
// redispatches are counted in KV per lifecycle run instead.
const POST_VERIFY_WATCHDOG_MAX_REDISPATCHES = 6
const POST_VERIFY_REDISPATCH_TTL_SECONDS = 7 * 86_400
// Learning normally closes a waiting post-verify within hours; a day means nobody will.
const POST_VERIFY_WAITING_STALE_HOURS = 24
export const S12_REPLAY_RETIRED_REASON = 'retired_fusion_maturity_backfill_new_l4_active'

/** Under the new L4 no S12 fusion replay runs, so a date has no replay_pending_maturity step. */
export async function s12ReplayRetiredUnderNewL4(kv: KVNamespace): Promise<boolean> {
  const config = await kv.get('trading:config', 'json') as { l4Distribution?: unknown } | null
  return Boolean(config?.l4Distribution)
}

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

export interface Active8ActionAuthorityState {
  pointerRows: number
  validServingRows: number
  recommendationRows: number
  actionableRows: number
}

export async function inspectActive8ActionAuthorityState(
  learningDb: D1Database,
  coreDb: D1Database,
  businessDate: string,
  verifiedPaperL3Identity?: Record<string, string>,
): Promise<Active8ActionAuthorityState> {
  const [pointer, recommendations] = await Promise.all([
    learningDb.prepare(`
      SELECT COUNT(p.singleton_id) AS pointer_rows,
             COALESCE(SUM(CASE
               WHEN a.artifact_id IS NOT NULL
                AND a.cohort_id = p.cohort_id
                AND a.payload_checksum = p.payload_checksum
                AND a.base_artifact_set_checksum = p.base_artifact_set_checksum
                AND (a.validation_decision = 'PASS' OR (
                  p.artifact_id=? AND p.cohort_id=? AND p.payload_checksum=?
                  AND p.base_artifact_set_checksum=?
                ))
                AND a.state = 'production'
                AND a.production_effect = 1
               THEN 1 ELSE 0 END), 0) AS valid_serving_rows
        FROM active8_ensemble_pointer_v1 p
        LEFT JOIN active8_ensemble_artifacts_v1 a ON a.artifact_id = p.artifact_id
       WHERE p.singleton_id = 1
    `).bind(...['artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum']
      .map(key => verifiedPaperL3Identity?.[key] ?? null))
      .first<{ pointer_rows?: number | string; valid_serving_rows?: number | string }>(),
    coreDb.prepare(`
      SELECT COUNT(*) AS recommendation_rows,
             COALESCE(SUM(CASE
               WHEN COALESCE(has_buy_signal, 0) != 0
                 OR COALESCE(eligible_for_pending_buy, 0) != 0
                 OR UPPER(COALESCE(signal, '')) IN ('BUY','STRONG_BUY','POTENTIAL_BUY')
               THEN 1 ELSE 0 END), 0) AS actionable_rows
        FROM daily_recommendations
       WHERE date = ?
    `).bind(businessDate).first<{ recommendation_rows?: number | string; actionable_rows?: number | string }>(),
  ])
  return {
    pointerRows: Number(pointer?.pointer_rows ?? 0),
    validServingRows: Number(pointer?.valid_serving_rows ?? 0),
    recommendationRows: Number(recommendations?.recommendation_rows ?? 0),
    actionableRows: Number(recommendations?.actionable_rows ?? 0),
  }
}

export function evidenceOnlySnapshotNotApplicable(
  snapshot: AllocatorSnapshotClosure,
  authority: Active8ActionAuthorityState,
): boolean {
  return authority.pointerRows === 0
    && authority.validServingRows === 0
    && authority.recommendationRows > 0
    && authority.recommendationRows === snapshot.recommendationRows
    && authority.actionableRows === 0
    && snapshot.nativeLineageRows === 0
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
         AND f.policy_version = 'verified-frozen-forward-monitoring-v2'
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
    // Owner of canonical_market_daily, which confirms past trading sessions.
    marketDb?: D1Database
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
      const nextSessionDate = await nextTwTradingDate(options.kv, businessDate, options.marketDb ?? db, {
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

function twTodayDate(nowMs = Date.now()): string {
  return new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10)
}

// States a date can still leave on its own; replay_complete is the only terminal state.
const NON_TERMINAL_LIFECYCLE_STATES: readonly AllocatorEvLifecycleState[] = [
  'lineage_ready', 'snapshot_ready', 'verify_triggered', 'replay_pending_maturity', 'replay_enqueued', 'error',
]
// A non-terminal date older than the recovery window has no automatic owner. Each one used to be
// re-selected every tick and blocked every newer date (09-23 from 11/23 23:50); it is now reported
// once per (date, run, state) and skipped.
const OUTSIDE_WINDOW_REPORT_TTL_SECONDS = 365 * 86_400
// Same per-run cap as post-verify: a date whose post-pipeline chain keeps failing must not be
// redispatched every tick, now that every date in the window is inspected each tick.
const POST_PIPELINE_WATCHDOG_MAX_REDISPATCHES = 6
// Quota-blocked legacy replay waits for the next post-market window instead of polling the exhausted one.
const SOURCE_ERROR_PREFIX = 'terminal market-data source error:'
const SOURCE_ERROR_RETRY_HOURS = 12
const POST_PIPELINE_INCOMPLETE_STATUSES = ['queued', 'running', 'waiting', 'error'] as const

type LifecycleTickContext = {
  // Same owner selection as runPostPipelineCallbackChain: the new L4 distribution owns closure.
  newL4Distribution: boolean
  // The tick redispatches at most one date; later dates wait for the next tick.
  dispatchedDate: string | null
  nowMs: number
}

async function lifecycleTickContext(env: Bindings, nowMs: number): Promise<LifecycleTickContext> {
  const config = await env.KV.get('trading:config', 'json') as { l4Distribution?: unknown } | null
  return { newL4Distribution: config?.l4Distribution != null, dispatchedDate: null, nowMs }
}

/** Reports a fact once per key; a KV failure reports it again next tick instead of losing the tick. */
async function reportOnce(kv: KVNamespace, keys: string[], nowMs: number): Promise<{ fresh: boolean[]; fenceFailed: boolean }> {
  try {
    const seen = await Promise.all(keys.map(async key => Boolean(await kv.get(key))))
    const fresh = seen.map(value => !value)
    await Promise.all(keys.filter((_, index) => fresh[index]).map(key =>
      kv.put(key, new Date(nowMs).toISOString(), { expirationTtl: OUTSIDE_WINDOW_REPORT_TTL_SECONDS })))
    return { fresh, fenceFailed: false }
  } catch (error) {
    console.warn('[allocatorEvDailyLifecycle] report fence unavailable:', error)
    return { fresh: keys.map(() => true), fenceFailed: true }
  }
}

// A deferred date is not a failure: the next tick dispatches it.
function dispatchDeferred(ctx: LifecycleTickContext, businessDate: string): string | null {
  return ctx.dispatchedDate && ctx.dispatchedDate !== businessDate
    ? `recovery_dispatch=deferred_one_date_per_tick dispatched_date=${ctx.dispatchedDate}`
    : null
}

function d1Utc(value: string | null | undefined): number {
  const text = String(value ?? '').trim()
  if (!text) return Number.NaN
  return Date.parse(!/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text)
}

// Embedded text must not carry markers classifySchedulerRunSummary reads (status=, not_sent:, not delivered:).
const summaryDetail = (value: string | null | undefined, max = 300) =>
  String(value ?? 'missing').replace(/status=/gi, 'status:').replace(/not[_\s]+(sent|delivered):/gi, 'not_$1=')
    .replace(/\s+/g, '_').slice(0, max)

export async function runAllocatorEvLifecycleWatchdog(
  env: Bindings,
  requestedDate?: string,
  options: { nowMs?: number } = {},
): Promise<string> {
  const ctx = await lifecycleTickContext(env, options.nowMs ?? Date.now())
  if (requestedDate) {
    if (!validDate(requestedDate)) throw new Error(`invalid allocator EV lifecycle date: ${requestedDate}`)
    return runAllocatorEvLifecycleDate(env, requestedDate, ctx)
  }
  return runAllocatorEvLifecycleWindow(env, ctx)
}

/**
 * Inspects every date of the recovery window each tick (newest first, today always included) instead
 * of one selected date, so one stuck date can no longer hide the others (11-23 post-pipeline failed 9
 * attempts and 11-12 never created its post-pipeline while the tick re-reported 09-23).
 */
async function runAllocatorEvLifecycleWindow(
  env: Bindings,
  ctx: LifecycleTickContext,
): Promise<string> {
  const nowMs = ctx.nowMs
  const learningDb = databaseForDataDomain(env, 'learning')
  const opsDb = databaseForDataDomain(env, 'ops')
  const today = twTodayDate(nowMs)
  const { strategyLearningRecoveryWindowStart } = await import('./strategyLearningRecoveryWatchdog')
  const windowStart = await strategyLearningRecoveryWindowStart(env, today)
  const nonTerminal = NON_TERMINAL_LIFECYCLE_STATES.map(() => '?').join(',')
  const incompleteStages = POST_PIPELINE_INCOMPLETE_STATUSES.map(() => '?').join(',')
  const [pipelineRows, waitingPostPipelineRows, windowLifecycleRows, outsideRows, outsideStageRows] = await Promise.all([
    opsDb.prepare(`
      SELECT business_date
        FROM pipeline_stage_runs
       WHERE stage = 'pipeline_execution' AND status = 'success'
         AND business_date >= ? AND business_date <= ?
    `).bind(windowStart, today).all<{ business_date: string }>(),
    opsDb.prepare(`
      SELECT business_date
        FROM pipeline_stage_runs
       WHERE stage = 'post_pipeline_chain' AND status = 'waiting'
         AND business_date >= ? AND business_date <= ?
    `).bind(windowStart, today).all<{ business_date: string }>(),
    learningDb.prepare(`
      SELECT business_date, state
        FROM allocator_ev_daily_lifecycle
       WHERE business_date >= ? AND business_date <= ?
    `).bind(windowStart, today).all<{ business_date: string; state: AllocatorEvLifecycleState }>(),
    learningDb.prepare(`
      SELECT business_date, state, upstream_run_id, last_error, updated_at
        FROM allocator_ev_daily_lifecycle
       WHERE state IN (${nonTerminal})
         AND business_date < ?
    `).bind(...NON_TERMINAL_LIFECYCLE_STATES, windowStart)
      .all<OutsideLifecycleRow>(),
    // A date that left the window with its post-pipeline unfinished and no lifecycle row (11-23 shape).
    opsDb.prepare(`
      SELECT business_date, status, canonical_run_id
        FROM pipeline_stage_runs
       WHERE stage = 'post_pipeline_chain' AND status IN (${incompleteStages})
         AND business_date < ?
    `).bind(...POST_PIPELINE_INCOMPLETE_STATUSES, windowStart)
      .all<{ business_date: string; status: string; canonical_run_id: string | null }>(),
  ])
  const outside = (outsideRows.results ?? [])
    .filter(row => validDate(String(row.business_date).slice(0, 10)))
    .sort((a, b) => b.business_date.localeCompare(a.business_date))
  // The legacy S12 replay matures after five sessions, past the four-session window: its oldest
  // cohort (and the oldest quota-blocked replay past its back-off) stays owned here, one per tick.
  const legacyOwned = ctx.newL4Distribution ? [] : [
    outside.filter(row => row.state === 'replay_pending_maturity').at(-1),
    outside.filter(row => row.state === 'error' && String(row.last_error ?? '').startsWith(SOURCE_ERROR_PREFIX)
      && nowMs - d1Utc(row.updated_at) >= SOURCE_ERROR_RETRY_HOURS * 3_600_000).at(-1),
  ].filter((row): row is OutsideLifecycleRow => Boolean(row)).map(row => row.business_date)
  const pipelineDates = new Set((pipelineRows.results ?? []).map(row => String(row.business_date).slice(0, 10)))
  const waitingPostPipeline = new Set((waitingPostPipelineRows.results ?? []).map(row => String(row.business_date).slice(0, 10)))
  const lifecycleStates = new Map((windowLifecycleRows.results ?? [])
    .map(row => [String(row.business_date).slice(0, 10), row.state] as const))
  const dates = [...new Set([today, ...pipelineDates, ...lifecycleStates.keys()])]
    .filter(validDate)
    .sort()
    .reverse()
  dates.push(...[...new Set(legacyOwned)].sort().reverse())

  // Failed dates lead the summary so a truncated notification still names them.
  const failedLines: string[] = []
  const lines: string[] = []
  for (const businessDate of dates) {
    const state = lifecycleStates.get(businessDate)
    if (state === 'replay_complete' && !waitingPostPipeline.has(businessDate)) {
      lines.push(`${businessDate}=complete`)
      continue
    }
    if (!state && !pipelineDates.has(businessDate)) {
      // Today before its pipeline execution succeeds (it settles at the next premarket).
      lines.push(`${businessDate}=pending_pipeline_execution`)
      continue
    }
    let summary: string
    try {
      summary = await runAllocatorEvLifecycleDate(env, businessDate, ctx)
    } catch (error) {
      summary = `status=failed ${error instanceof Error ? error.message : String(error)}`
    }
    if (/\bstatus=(?:failed|error)\b/i.test(summary)) failedLines.push(`${businessDate}=failed:${summaryDetail(summary, 600)}`)
    else lines.push(`${businessDate}=ok:${summaryDetail(summary, 600)}`)
  }
  const incomplete = failedLines.length

  const legacy = new Set(legacyOwned)
  const unowned = [
    ...outside.filter(row => !legacy.has(row.business_date))
      .map(row => ({ date: row.business_date, run: row.upstream_run_id, state: String(row.state) })),
    ...(outsideStageRows.results ?? []).filter(row => validDate(String(row.business_date).slice(0, 10)))
      .map(row => ({ date: row.business_date, run: row.canonical_run_id, state: `post_pipeline_${row.status}` })),
  ].sort((a, b) => b.date.localeCompare(a.date) || a.state.localeCompare(b.state))
  // Fence only after the report text exists: a tick that dies before returning reports it again.
  const { fresh, fenceFailed } = await reportOnce(env.KV, unowned.map(row =>
    `allocator-ev-lifecycle:outside-window-reported:${row.date}:${row.run || 'none'}:${row.state}`), nowMs)
  const newlyOutside = unowned.filter((_, index) => fresh[index])
  const failed = incomplete > 0 || newlyOutside.length > 0
  const listed = newlyOutside.slice(0, 40).map(row => `${row.date}:${row.state}`).join(',')
  const outsideText = newlyOutside.length
    ? ` outside_window_unowned=${listed}${newlyOutside.length > 40 ? `,+${newlyOutside.length - 40}` : ''} `
      + 'recovery_dispatch=not_queued manual_review_required'
    : ''
  return `status=${failed ? 'failed' : 'success'} allocator EV lifecycle window=${windowStart}..${today} `
    + `dates=${dates.length} incomplete=${incomplete} dispatched=${ctx.dispatchedDate ?? 'none'} `
    + `outside_window_new=${newlyOutside.length} outside_window_known=${unowned.length - newlyOutside.length}`
    + `${fenceFailed ? ' outside_window_fence=unavailable' : ''}${outsideText}; ${[...failedLines, ...lines].join('; ')}`
}

type OutsideLifecycleRow = {
  business_date: string
  state: AllocatorEvLifecycleState
  upstream_run_id: string | null
  last_error: string | null
  updated_at: string | null
}

async function runAllocatorEvLifecycleDate(
  env: Bindings,
  businessDate: string,
  ctx: LifecycleTickContext,
): Promise<string> {
  const learningDb = databaseForDataDomain(env, 'learning')
  const coreDb = databaseForDataDomain(env, 'core')
  const opsDb = databaseForDataDomain(env, 'ops')
  const lifecycle = await readAllocatorEvLifecycle(learningDb, businessDate)
  if (staleVerifyTrigger(lifecycle)) {
    const verifyStage = await opsDb.prepare(`
      SELECT status, canonical_run_id, cursor_key
        FROM pipeline_stage_runs
       WHERE business_date=? AND stage='verify_v2'
    `).bind(businessDate).first<{
      status?: string | null
      canonical_run_id?: string | null
      cursor_key?: string | null
    }>()
    if (verifyStage?.status !== 'success') {
      return `status=failed allocator EV lifecycle stale post-verify is not recoverable date=${businessDate} verify_status=${verifyStage?.status ?? 'missing'}`
    }
    const lifecycleRunId = String(lifecycle?.upstream_run_id ?? '').trim()
    const verifyCanonicalRunId = String(verifyStage.canonical_run_id ?? '').trim()
    const verifyCursorKey = String(verifyStage.cursor_key ?? '').trim()
    if (!lifecycleRunId || verifyCanonicalRunId !== lifecycleRunId || !verifyCursorKey) {
      return `status=failed allocator EV lifecycle post-verify authority mismatch date=${businessDate} `
        + `lifecycle_run_id=${lifecycleRunId || 'missing'} `
        + `verify_canonical_run_id=${verifyCanonicalRunId || 'missing'} `
        + `verify_cursor_key=${verifyCursorKey || 'missing'}`
    }
    // Read before re-queueing: the queue transition clears last_error. A
    // previous dispatch that ended in error or lost its lease did not complete,
    // so this tick fails even though it redispatches again.
    const previousStage = await opsDb.prepare(`
      SELECT status, canonical_run_id, last_error, attempt_count,
             CASE WHEN lease_expires_at < CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS lease_expired,
             CASE WHEN datetime(updated_at) <= datetime('now', ?) THEN 1 ELSE 0 END AS waiting_stale
        FROM pipeline_stage_runs
       WHERE business_date=? AND stage='post_verify_chain'
    `).bind(`-${POST_VERIFY_WAITING_STALE_HOURS} hours`, businessDate).first<{
      status?: string | null
      canonical_run_id?: string | null
      last_error?: string | null
      attempt_count?: number | string | null
      lease_expired?: number | null
      waiting_stale?: number | null
    }>()
    const detail = (value: string | null | undefined) =>
      String(value ?? 'missing').replace(/status=/gi, 'status:').replace(/\s+/g, '_').slice(0, 300)
    const sameRun = previousStage?.canonical_run_id === lifecycleRunId
    const leaseExpired = Number(previousStage?.lease_expired) === 1
    // PV1105: re-queueing a waiting/success/in-flight post-verify re-ran its non-retry-safe tasks every
    // tick (11/16 model-ic-rolling UNCERTAIN checkpoint). Only error or an expired lease is re-queued.
    if (sameRun && (['waiting', 'success', 'queued'].includes(String(previousStage?.status))
      || (previousStage?.status === 'running' && !leaseExpired))) {
      if (previousStage?.status === 'success' && await s12ReplayRetiredUnderNewL4(env.KV)) {
        const closed = await recordAllocatorEvLifecycle(learningDb, {
          businessDate,
          state: 'replay_complete',
          replayMaturityAsOfDate: businessDate,
          upstreamRunId: lifecycleRunId,
          expectedLifecycleRunId: lifecycleRunId,
        })
        return `status=success allocator EV lifecycle replay_not_applicable=${S12_REPLAY_RETIRED_REASON} `
          + `date=${businessDate} run_id=${lifecycleRunId} lifecycle=${closed ? 'replay_complete' : 'unchanged'}`
      }
      if (previousStage?.status === 'waiting') {
        // A waiting stage whose learning run already failed was never closed (11/17, 11/18); closing it
        // here also covers dates outside the learning watchdog's lookback. Neither branch re-queues.
        const { propagateStrategyLearningFailureAfterWaiting } = await import('./strategyLearningRunState')
        const learningError = await propagateStrategyLearningFailureAfterWaiting(opsDb, {
          businessDate, canonicalRunId: lifecycleRunId,
        }, env.KV)
        if (learningError) {
          return `status=failed allocator EV lifecycle post-verify closed by failed strategy-learning date=${businessDate} `
            + `run_id=${lifecycleRunId} learning_error=${detail(learningError)} recovery_dispatch=not_queued`
        }
        if (Number(previousStage.waiting_stale) === 1) {
          return `status=failed allocator EV lifecycle post-verify waiting_stale date=${businessDate} run_id=${lifecycleRunId} `
            + `waiting_hours>=${POST_VERIFY_WAITING_STALE_HOURS} recovery_dispatch=not_queued manual_review_required`
        }
      }
      return `status=success allocator EV lifecycle recovery_observation=post_verify_current date=${businessDate} `
        + `downstream_status=${previousStage?.status}`
    }
    const previousIncomplete = sameRun
      && (previousStage.status === 'error' || (previousStage.status === 'running' && leaseExpired))
    if (previousIncomplete && previousStage.status === 'error') {
      // A post-verify closed by a terminal learning failure cannot be fixed by re-running it: the rerun
      // re-executes its tasks and fails on the same learning row.
      const learning = await opsDb.prepare(`
        SELECT status, canonical_run_id FROM strategy_learning_runs WHERE business_date=?
      `).bind(businessDate).first<{ status?: string | null; canonical_run_id?: string | null }>()
      if (learning?.status === 'error' && learning.canonical_run_id === lifecycleRunId) {
        const closed = await s12ReplayRetiredUnderNewL4(env.KV) && await recordAllocatorEvLifecycle(learningDb, {
          businessDate,
          state: 'replay_complete',
          replayMaturityAsOfDate: businessDate,
          upstreamRunId: lifecycleRunId,
          expectedLifecycleRunId: lifecycleRunId,
        })
        return `status=failed allocator EV lifecycle post-verify blocked by terminal strategy-learning date=${businessDate} `
          + `run_id=${lifecycleRunId} previous_error=${detail(previousStage.last_error)} `
          + `recovery_dispatch=not_queued lifecycle=${closed ? 'replay_complete' : 'unchanged'}`
      }
    }
    const deferred = dispatchDeferred(ctx, businessDate)
    if (deferred) {
      return `status=waiting allocator EV lifecycle post-verify recovery deferred date=${businessDate} `
        + `run_id=${lifecycleRunId} previous_status=${previousStage?.status ?? 'missing'} ${deferred}`
    }
    const redispatchKey = `allocator-ev-lifecycle:post-verify-redispatches:${businessDate}:${lifecycleRunId}`
    const redispatches = Number.parseInt((await env.KV.get(redispatchKey)) ?? '0', 10) || 0
    if (previousIncomplete) {
      if (redispatches >= POST_VERIFY_WATCHDOG_MAX_REDISPATCHES) {
        return `status=failed allocator EV lifecycle post-verify redispatch exhausted date=${businessDate} run_id=${lifecycleRunId} `
          + `previous_status=${previousStage?.status} redispatches=${redispatches} `
          + `previous_error=${detail(previousStage?.last_error)} `
          + 'recovery_dispatch=not_queued manual_redispatch_required'
      }
      await env.KV.put(redispatchKey, String(redispatches + 1), { expirationTtl: POST_VERIFY_REDISPATCH_TTL_SECONDS })
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
      attempt: Math.max(1, Number(lifecycle?.attempt_count ?? 0) + 1),
    })
    if (continuation.queued) ctx.dispatchedDate = businessDate
    if (previousIncomplete) {
      return `status=failed allocator EV lifecycle post-verify dispatch incomplete date=${businessDate} run_id=${lifecycleRunId} `
        + `previous_status=${previousStage?.status} previous_attempts=${Number(previousStage?.attempt_count ?? 0)} `
        + `previous_error=${String(previousStage?.last_error ?? 'missing').replace(/status=/gi, 'status:').replace(/\s+/g, '_').slice(0, 300)} `
        + `recovery_dispatch=${continuation.queued ? 'post_verify_queued' : `not_queued downstream_status=${continuation.status}`}`
    }
    return continuation.queued
      ? `status=success allocator EV lifecycle recovery_dispatch=post_verify_queued date=${businessDate} run_id=${continuation.canonicalRunId}`
      : `status=success allocator EV lifecycle recovery_observation=post_verify_current date=${businessDate} downstream_status=${continuation.status}`
  }

  // S12 fusion replay is retired under the new L4: a date waiting for (or left enqueued by) the replay
  // has no replay owner left, so it closes the way a successful post-verify does instead of enqueueing
  // the retired chunk.
  if ((lifecycle?.state === 'replay_pending_maturity' || lifecycle?.state === 'replay_enqueued') && ctx.newL4Distribution) {
    const lifecycleRunId = String(lifecycle.upstream_run_id ?? '').trim() || null
    const closed = await recordAllocatorEvLifecycle(learningDb, {
      businessDate,
      state: 'replay_complete',
      replayMaturityAsOfDate: lifecycle.replay_maturity_as_of_date ?? businessDate,
      upstreamRunId: lifecycleRunId,
      expectedLifecycleRunId: lifecycleRunId,
    })
    return `status=success allocator EV lifecycle replay_not_applicable=${S12_REPLAY_RETIRED_REASON} `
      + `date=${businessDate} run_id=${lifecycleRunId ?? 'missing'} lifecycle=${closed ? 'replay_complete' : 'unchanged'}`
  }

  if (lifecycle?.state === 'error' && String(lifecycle.last_error ?? '').startsWith(SOURCE_ERROR_PREFIX)
    && !(ctx.nowMs - d1Utc(lifecycle.updated_at) >= SOURCE_ERROR_RETRY_HOURS * 3_600_000)) {
    return `status=waiting allocator EV lifecycle replay source error back-off date=${businessDate} `
      + `retry_after_hours=${SOURCE_ERROR_RETRY_HOURS} last_error=${summaryDetail(lifecycle.last_error)} recovery_dispatch=not_queued`
  }

  const postPipelineStage: PostPipelineStageRow | null = await opsDb.prepare(`
    SELECT status, canonical_run_id, updated_at, lease_expires_at, attempt_count, last_error
      FROM pipeline_stage_runs
     WHERE business_date=? AND stage='post_pipeline_chain'
  `).bind(businessDate).first<PostPipelineStageRow>()
  const stageAgeMs = Date.now() - d1Utc(postPipelineStage?.updated_at)
  const stageLeaseLive = d1Utc(postPipelineStage?.lease_expires_at) >= Date.now()
  const callbackInFlight = ['queued', 'running', 'waiting'].includes(String(postPipelineStage?.status ?? ''))
    && (postPipelineStage?.status !== 'running' || stageLeaseLive)
    && Number.isFinite(stageAgeMs)
    && stageAgeMs >= 0
    && stageAgeMs < 15 * 60_000
  const postVerifyReached = lifecycle && ['replay_pending_maturity', 'replay_enqueued', 'replay_complete'].includes(lifecycle.state)
  const postPipelineReached = lifecycle
    && [
      'verify_triggered', 'replay_pending_maturity', 'replay_enqueued', 'replay_complete',
    ].includes(lifecycle.state)
  const reconcileWaitingPostPipeline = async () => {
    if (!lifecycle?.upstream_run_id
      || postPipelineStage?.canonical_run_id !== lifecycle.upstream_run_id
      || postPipelineStage?.status !== 'waiting') return
    const { markPipelineStageFenced } = await import('./pipelineStageLease')
    await markPipelineStageFenced(opsDb, {
      businessDate,
      stage: 'post_pipeline_chain',
      canonicalRunId: lifecycle.upstream_run_id,
      status: 'success',
      error: null,
    })
  }

  if (ctx.newL4Distribution) {
    // runPostPipelineCallbackChain refuses to run past an incomplete original-plan closure
    // (l4_distribution_original_plan_closure_incomplete), so the watchdog reads the same owner.
    // The legacy allocator snapshot has no meaning here and must not write lifecycle error.
    if (postPipelineReached) {
      // The chain proved the closure before it advanced the lifecycle. It is not re-read: it only
      // holds while that day's plan is the head, and the next session's plan supersedes it.
      await reconcileWaitingPostPipeline()
      return `status=success allocator EV lifecycle observed date=${businessDate} state=${lifecycle?.state} `
        + `lifecycle_complete=${lifecycle?.state === 'replay_complete' ? 1 : 0} closure_owner=l4_distribution`
    }
    const { readL4PortfolioPlan } = await import('./l4PortfolioPlan')
    const head = await readL4PortfolioPlan(env)
    if (head && head.signal_date > businessDate) {
      // The closure only holds while the day's plan is the head. Once a later session's plan replaced
      // it neither the chain nor this watchdog can close the day, so it is reported once with the
      // post-pipeline's own cause rather than as a closure gap.
      const runId = postPipelineStage?.canonical_run_id ?? 'none'
      const { fresh } = await reportOnce(env.KV,
        [`allocator-ev-lifecycle:head-advanced-reported:${businessDate}:${runId}:${head.plan_id}`], ctx.nowMs)
      const text = `allocator EV lifecycle post-pipeline unrecoverable head_advanced date=${businessDate} `
        + `head_signal_date=${head.signal_date} post_pipeline_status=${postPipelineStage?.status ?? 'missing'} `
        + `post_pipeline_attempts=${Number(postPipelineStage?.attempt_count ?? 0)} `
        + `post_pipeline_error=${summaryDetail(postPipelineStage?.last_error)} recovery_dispatch=not_queued`
      return fresh[0] ? `status=failed ${text} manual_review_required` : `status=success ${text} already_reported`
    }
    const { inspectL4DistributionClosure } = await import('./l4DistributionClosure')
    const closure = await inspectL4DistributionClosure(env, businessDate)
    if (closure.recommendationRows <= 0) {
      return `skipped: allocator EV lifecycle has no recommendations for ${businessDate} closure_owner=l4_distribution`
    }
    const callbackGraceActive = !closure.ready && callbackInFlight
    if (callbackGraceActive) {
      return `status=success allocator EV lifecycle callback_observation=pending date=${businessDate} `
        + `stage=${postPipelineStage?.status} age_seconds=${Math.floor(stageAgeMs / 1000)} `
        + `run_id=${postPipelineStage?.canonical_run_id ?? 'unknown'} closure_owner=l4_distribution`
    }
    if (!closure.ready) {
      return `status=failed allocator EV lifecycle l4_distribution_original_plan_closure_incomplete date=${businessDate} `
        + `recommendations=${closure.recommendationRows} expected=${closure.expectedRows} matched=${closure.nativeLineageRows} `
        + `unmatched=${closure.rejectedLineageRows} post_pipeline_status=${postPipelineStage?.status ?? 'missing'} `
        + `post_pipeline_attempts=${Number(postPipelineStage?.attempt_count ?? 0)} `
        + `post_pipeline_error=${summaryDetail(postPipelineStage?.last_error)} recovery_dispatch=not_queued`
    }
    return queuePostPipelineRecovery(env, ctx, businessDate, lifecycle, postPipelineStage, stageLeaseLive)
  }

  const [snapshot, actionAuthority] = await Promise.all([
    inspectAllocatorSnapshotClosure(learningDb, businessDate, {
      allowPointInTimeReconstruction: true,
      learningDb,
      opsDb,
      coreDb,
      marketDb: databaseForDataDomain(env, 'market'),
      kv: env.KV,
    }),
    inspectActive8ActionAuthorityState(learningDb, coreDb, businessDate),
  ])
  if (snapshot.nativeLineageRows <= 0) {
    if (snapshot.recommendationRows <= 0) {
      return `skipped: allocator EV lifecycle has no Score V2 recommendations for ${businessDate}`
    }
    if (actionAuthority.pointerRows !== actionAuthority.validServingRows) {
      throw new Error(
        `active8_serving_pointer_integrity_invalid:pointer=${actionAuthority.pointerRows}:valid=${actionAuthority.validServingRows}`,
      )
    }
    if (evidenceOnlySnapshotNotApplicable(snapshot, actionAuthority)) {
      return `skipped: allocator EV snapshot not applicable under attested Active8 evidence-only authority `
        + `date=${businessDate} recommendations=${snapshot.recommendationRows} actionable=0 production_effect=0`
    }
    const reason = `missing point-in-time ensemble lineage before next executable session open `
      + `recommendations=${snapshot.recommendationRows}`
    await recordAllocatorEvLifecycle(databaseForDataDomain(env, 'learning'), {
      businessDate,
      state: 'error',
      nativeLineageRows: 0,
      lastError: reason,
      incrementAttempt: true,
    })
    throw new Error(`allocator_ev_missing_point_in_time_lineage:${businessDate}:${reason}`)
  }
  const callbackGraceActive = !snapshot.ready && callbackInFlight
  if (callbackGraceActive) {
    return `status=success allocator EV lifecycle callback_observation=pending date=${businessDate} `
      + `stage=${postPipelineStage?.status} age_seconds=${Math.floor(stageAgeMs / 1000)} `
      + `run_id=${postPipelineStage?.canonical_run_id ?? 'unknown'} `
      + `lineage=${snapshot.nativeLineageRows} expected=${snapshot.expectedRows} actual=${snapshot.actualRows}`
  }
  if (snapshot.ready && postPipelineReached) await reconcileWaitingPostPipeline()
  let matureReplayMissingRows = 0
  if (lifecycle?.state === 'replay_pending_maturity') {
    const { loadSplitFusionSnapshotReplayCoverage } = await import('./s12ReplaySplitReadModels')
    const coverage = await loadSplitFusionSnapshotReplayCoverage(env, businessDate, twTodayDate(ctx.nowMs))
    matureReplayMissingRows = coverage.matureMissingRows
  }
  if (snapshot.ready && lifecycle?.state === 'replay_pending_maturity' && matureReplayMissingRows > 0) {
    const deferred = dispatchDeferred(ctx, businessDate)
    if (deferred) {
      return `status=waiting allocator EV lifecycle replay deferred date=${businessDate} `
        + `mature_missing=${matureReplayMissingRows} ${deferred}`
    }
    const maturityAsOfDate = twTodayDate(ctx.nowMs)
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
      return `skipped: allocator EV lifecycle stale replay enqueue ignored date=${businessDate} run_id=${runId}`
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
    ctx.dispatchedDate = businessDate
    return `status=success allocator EV lifecycle replay_dispatch=enqueued date=${businessDate} mature_missing=${matureReplayMissingRows} as_of=${maturityAsOfDate}`
  }
  if (snapshot.ready && (
    (postVerifyReached && matureReplayMissingRows === 0)
    || (lifecycle?.state === 'verify_triggered' && !staleVerifyTrigger(lifecycle))
  )) {
    const lifecycleComplete = lifecycle?.state === 'replay_complete'
    return `status=success allocator EV lifecycle observed date=${businessDate} state=${lifecycle?.state} lifecycle_complete=${lifecycleComplete ? 1 : 0} snapshot_rows=${snapshot.actualRows}`
  }
  const repairBoundary = !snapshot.ready
    ? await historicalLearningLineageDecision(databaseForDataDomain(env, 'market'), env.KV, 'evening-chain', businessDate)
    : null
  if (!snapshot.ready && repairBoundary && !repairBoundary.allowed) {
    return `skipped: allocator EV native snapshot repair window closed for historical date=${businessDate} `
      + `reason=${repairBoundary.reason} next_session=${repairBoundary.nextSessionDate ?? 'missing'} `
      + `next_open_utc=${repairBoundary.nextSessionOpenUtc ?? 'missing'} `
      + `recommendations=${snapshot.recommendationRows} lineage=${snapshot.nativeLineageRows} `
      + `run_native=${snapshot.runNativeLineageRows} reconstructed=${snapshot.reconstructedLineageRows} `
      + `rejected=${snapshot.rejectedLineageRows} expected=${snapshot.expectedRows} published=${snapshot.publishedRows} actual=${snapshot.actualRows} `
      + `recommendation_max=${snapshot.recommendationMaxCreatedAt ?? 'missing'} snapshot_max=${snapshot.snapshotMaxGeneratedAt ?? 'missing'}`
  }
  return queuePostPipelineRecovery(env, ctx, businessDate, lifecycle, postPipelineStage, stageLeaseLive)
}

type PostPipelineStageRow = {
  status?: string | null
  canonical_run_id?: string | null
  updated_at?: string | null
  lease_expires_at?: string | null
  attempt_count?: number | string | null
  last_error?: string | null
}

async function queuePostPipelineRecovery(
  env: Bindings,
  ctx: LifecycleTickContext,
  businessDate: string,
  lifecycle: AllocatorEvLifecycleRow | null,
  postPipelineStage: PostPipelineStageRow | null,
  stageLeaseLive: boolean,
): Promise<string> {
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

  const recoveryRunId = upstreamGate.pipelineRunId
  if (!recoveryRunId) throw new Error('allocator_ev_recovery_gate_invariant:pipeline_run_id_missing')
  const deferred = dispatchDeferred(ctx, businessDate)
  if (deferred) {
    return `status=waiting allocator EV lifecycle post-pipeline recovery deferred date=${businessDate} `
      + `run_id=${recoveryRunId} post_pipeline_status=${postPipelineStage?.status ?? 'missing'} ${deferred}`
  }
  const previousIncomplete = postPipelineStage?.canonical_run_id === recoveryRunId
    && (postPipelineStage.status === 'error' || (postPipelineStage.status === 'running' && !stageLeaseLive))
  const redispatchKey = `allocator-ev-lifecycle:post-pipeline-redispatches:${businessDate}:${recoveryRunId}`
  const redispatches = Number.parseInt((await env.KV.get(redispatchKey)) ?? '0', 10) || 0
  if (redispatches >= POST_PIPELINE_WATCHDOG_MAX_REDISPATCHES) {
    return `status=failed allocator EV lifecycle post-pipeline redispatch exhausted date=${businessDate} run_id=${recoveryRunId} `
      + `post_pipeline_status=${postPipelineStage?.status ?? 'missing'} redispatches=${redispatches} `
      + `previous_error=${summaryDetail(postPipelineStage?.last_error)} recovery_dispatch=not_queued manual_redispatch_required `
      + `reset_kv_key=${redispatchKey}`
  }
  const { queuePostPipelineStage } = await import('./pipelineStageLease')
  // Stage claims also count routing/callback failures that never reached the
  // allocator snapshot. Only the lifecycle counter scopes this retry budget.
  const recoveryAttempt = Math.max(0, Number(lifecycle?.attempt_count ?? 0))
  // A post-pipeline stage the 14:20 dispatch never created (11-12) is created under the pipeline
  // execution's own success authority, as runPostcloseResearch does; an existing one is only resumed.
  const continuation = postPipelineStage
    ? await queuePostPipelineStage(env, {
      businessDate,
      runId: recoveryRunId,
      resumeWaiting: true,
      expectedCanonicalRunId: recoveryRunId,
      attempt: recoveryAttempt,
    })
    : await queuePostPipelineStage(env, {
      businessDate,
      runId: recoveryRunId,
      authority: { stage: 'pipeline_execution', canonicalRunId: recoveryRunId, status: 'success' },
      attempt: recoveryAttempt,
    })
  if (continuation.queued) {
    ctx.dispatchedDate = businessDate
    await env.KV.put(redispatchKey, String(redispatches + 1), { expirationTtl: POST_VERIFY_REDISPATCH_TTL_SECONDS })
  }
  if (previousIncomplete) {
    // The previous dispatch did not complete; the tick fails even though it redispatches.
    return `status=failed allocator EV lifecycle post-pipeline dispatch incomplete date=${businessDate} run_id=${recoveryRunId} `
      + `previous_status=${postPipelineStage?.status} previous_attempts=${Number(postPipelineStage?.attempt_count ?? 0)} `
      + `previous_error=${summaryDetail(postPipelineStage?.last_error)} `
      + `recovery_dispatch=${continuation.queued ? 'post_pipeline_queued' : `not_queued downstream_status=${continuation.status}`}`
  }
  return continuation.queued
    ? `status=success allocator EV lifecycle recovery_dispatch=post_pipeline_queued date=${businessDate} attempt=${recoveryAttempt} run_id=${continuation.canonicalRunId}`
    : `status=success allocator EV lifecycle recovery_observation=post_pipeline_current date=${businessDate} downstream_status=${continuation.status} run_id=${continuation.canonicalRunId}`
}
