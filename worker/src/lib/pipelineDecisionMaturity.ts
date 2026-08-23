import type { Bindings } from '../types'
import { inspectAllocatorEvMaturityCoverage } from './allocatorEvDailyLifecycle'
import { databaseForDataDomain } from './dataDomainRegistry'
import {
  adaptExpectedReturnCandidate,
  adaptExpectedReturnShadow,
  type ExpectedReturnCandidateDbRow,
  type ExpectedReturnCandidateEvidence,
  type ExpectedReturnShadowDbRow,
  type ExpectedReturnShadowEvidence,
} from './expectedReturnMaturityEvidence'
import { readCurrentExpectedReturnServingState } from './expectedReturnServingState'
import { SELECTION_REFERENCE_CONTRACT_VERSION } from './selectionReferenceEvidence'
import {
  STRATEGY_ROUTE_CHALLENGER_VERSION,
  STRATEGY_ROUTE_MIN_OOS_DATES,
  STRATEGY_ROUTE_MIN_TOTAL_DATES,
  STRATEGY_ROUTE_MIN_TRAIN_DATES,
  STRATEGY_ROUTE_PURGE_DATES,
} from './strategyRouteCalibration'
import {
  STRATEGY_FORMAL_LABELER_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
} from './strategySpec'

export type PipelineMaturityStatus =
  | 'serving'
  | 'ready'
  | 'collecting'
  | 'failed_quality'
  | 'blocked'
  | 'unavailable'

export type PipelineContributionMode = 'production' | 'shadow' | 'evidence_only'

export interface PipelineMaturityProgress {
  current: number
  required: number
  remaining: number
  ratio: number
  unit: 'rows' | 'dates'
  complete: boolean
}

export interface PipelineMaturityMetric {
  key: string
  label: string
  value: number | string | boolean | null
  target?: number | string | boolean | null
  comparator?: 'gte' | 'gt' | 'lt' | 'eq'
  unit?: 'rows' | 'dates' | 'ratio' | 'return' | 'r_multiple' | 'score' | 'count' | 'status'
  passed?: boolean | null
  note?: string
  availability?: 'available' | 'pending' | 'not_applicable' | 'missing' | 'blocked'
  reason_code?: string | null
  scope?: 'promotion_gate' | 'lifecycle' | 'monitoring' | 'diagnostic' | 'production'
}

export interface PipelineMaturityBlockerGroup {
  scope: 'offline_candidate' | 'serving_pointer' | 'frozen_forward' | 'runtime_guard'
  title: string
  blockers: string[]
}

export interface PipelineMaturityStage {
  id: 'threshold_margin_affinity_v2' | 'oof_redundancy' | 'route_score_v2' | 'l4' | 'fusion'
  layer: string
  title: string
  version: string | null
  status: PipelineMaturityStatus
  contribution_mode: PipelineContributionMode
  maturity_kind: 'daily_coverage' | 'paired_oof' | 'calibration' | 'artifact_quality'
  progress: PipelineMaturityProgress | null
  decision: string
  contribution: string
  production_effect: string
  blockers: string[]
  blocker_groups?: PipelineMaturityBlockerGroup[]
  metrics: PipelineMaturityMetric[]
  history?: Array<{
    evidence_date: string
    value: number | null
    target: number | null
    unit: PipelineMaturityMetric['unit']
    artifact_contract_version?: string | null
    identity_valid?: boolean
  }>
  lineage: {
    requested_date: string
    evidence_date: string | null
    oof_max_date?: string | null
    oof_applicable?: boolean
    evidence_semantics?: string
    artifact_id?: string | null
    model_version?: string | null
    source: string
    updated_at?: string | null
    cadence?: 'daily' | 'weekly' | 'monthly' | 'manual' | 'event-driven' | 'unknown'
    role?: 'candidate' | 'serving' | 'monitoring' | 'runtime_guard'
    date_semantic?: 'candidate_cutoff' | 'current_pointer_effective_at' | 'monitoring_business_date' | 'latest_prediction_date'
    oof_unavailable_reason?: string | null
    evidence_scopes?: {
      offline_candidate?: {
        cadence: 'daily' | 'weekly' | 'monthly' | 'manual' | 'event-driven' | 'unknown'
        role: 'candidate'
        date_semantic: 'candidate_cutoff'
        availability: 'available' | 'blocked' | 'missing'
        reason_code: string | null
        identity_assurance: string | null
        identity_schema_version: string | null
        artifact_id: string | null
        artifact_path: string | null
        artifact_checksum: string | null
        identity_valid: boolean
        identity_blockers: string[]
        model_version: string | null
        artifact_contract_version: string | null
        validation_schema_version: string | null
        source_run_date: string | null
        updated_at: string | null
        oof_max_date: string | null
      }
      serving_pointer?: {
        cadence: 'event-driven'
        role: 'serving'
        date_semantic: 'current_pointer_effective_at'
        availability: 'available' | 'blocked' | 'missing'
        artifact_state: string | null
        observed_at: string | null
        reason_code: string | null
        artifact_id: string | null
        model_version: string | null
        artifact_contract_version: string | null
        serving_mode: string | null
        updated_at: string | null
      }
      frozen_forward?: {
        cadence: 'daily'
        role: 'monitoring'
        date_semantic: 'monitoring_business_date'
        availability: 'available' | 'blocked' | 'missing'
        reason_code: string | null
        evaluation_id: string | null
        identity_schema_version: string | null
        subject_artifact_checksum: string | null
        evaluator_contract_checksum: string | null
        artifact_path: string | null
        artifact_checksum: string | null
        identity_blockers: string[]
        identity_valid: boolean
        cohort_id: string | null
        model_version: string | null
        validation_schema_version: string | null
        business_date: string | null
        oof_max_date: string | null
        updated_at: string | null
      }
      runtime_guard?: {
        cadence: 'daily'
        role: 'runtime_guard'
        date_semantic: 'latest_prediction_date'
        availability: 'available' | 'blocked'
        reason_code: string | null
        artifact_id: string
        model_fingerprint: string
        model_version: string
        state: string
        evaluable_date_count: number
        degraded_streak: number
        recovery_streak: number
        last_prediction_date: string
        lineage_bound: boolean
      }
    }
  }
}
export interface StrategyRouteBundleMaturity {
  version: string
  status: PipelineMaturityStatus
  contribution_mode: PipelineContributionMode
  threshold_coverage_ready: boolean
  current_route_coverage_complete: boolean
  current_route_rows: number
  current_reference_rows: number
  route_calibration_status: string | null
  route_mature_dates: number
  route_required_dates: number
  promoted_run_id: string | null
  blockers: string[]
}


export interface PipelineDecisionMaturityPacket {
  schema_version: 'pipeline-decision-maturity-v2'
  requested_date: string
  generated_at: string
  current_selection_signal_owner: 'score_v2_formal_ml'
  current_expected_return_owner: 'l4_alpha_ev' | 'allocator_ev_fusion' | null
  current_execution_owner: 'allocator_opb_policy' | 'none_fail_closed'
  action_gate: 'expected_return_owner' | 'canonical_l4_required'
  strategy_route_bundle: StrategyRouteBundleMaturity
  summary: {
    production: number
    shadow: number
    ready: number
    collecting: number
    failed_or_blocked: number
  }
  stages: PipelineMaturityStage[]
}

type QueryResult<T> = { value: T | null; error: string | null }

type CanonicalHead = { signal_date: string; run_id: string }

type SectorPitReadiness = {
  first_signal_date: string | null
  latest_signal_date: string | null
  signal_dates: number | null
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function optionalFinite(value: unknown): number | null {
  const parsed = Number(value)
  return value == null || value === '' || !Number.isFinite(parsed) ? null : parsed
}

function jsonRecord(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => String(item).trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 220)
}

async function safeQuery<T>(work: () => Promise<T>): Promise<QueryResult<T>> {
  try {
    return { value: await work(), error: null }
  } catch (error) {
    return { value: null, error: safeError(error) }
  }
}

export function maturityProgress(
  currentInput: unknown,
  requiredInput: unknown,
  unit: PipelineMaturityProgress['unit'],
): PipelineMaturityProgress | null {
  const required = optionalFinite(requiredInput)
  const currentValue = optionalFinite(currentInput)
  if (required == null || required <= 0 || currentValue == null) return null
  const current = Math.max(0, currentValue)
  return {
    current,
    required,
    remaining: Math.max(0, required - current),
    ratio: Math.max(0, Math.min(1, current / required)),
    unit,
    complete: current >= required,
  }
}

function metric(
  key: string,
  label: string,
  value: unknown,
  options: Omit<PipelineMaturityMetric, 'key' | 'label' | 'value'> = {},
): PipelineMaturityMetric {
  return { key, label, value: value == null ? null : value as any, ...options }
}

function gateMetric(
  key: string,
  label: string,
  value: unknown,
  target: number,
  unit: PipelineMaturityMetric['unit'],
  comparator: 'gte' | 'gt' = 'gte',
  options: Pick<PipelineMaturityMetric, 'availability' | 'reason_code' | 'scope' | 'note'> = {},
): PipelineMaturityMetric {
  const current = optionalFinite(value)
  return metric(key, label, current, {
    target,
    comparator,
    unit,
    passed: current == null ? null : comparator === 'gte' ? current >= target : current > target,
    ...options,
  })
}

function unavailableStage(
  id: PipelineMaturityStage['id'],
  layer: string,
  title: string,
  requestedDate: string,
  source: string,
  errors: Array<string | null>,
): PipelineMaturityStage {
  return {
    id,
    layer,
    title,
    version: null,
    status: 'unavailable',
    contribution_mode: 'evidence_only',
    maturity_kind: 'artifact_quality',
    progress: null,
    decision: '沒有可驗證的正式 evidence，不能推定成熟或通過。',
    contribution: '本階段不提供 production 決策貢獻。',
    production_effect: 'fail closed；不把缺資料當成 0 分或負樣本。',
    blockers: errors.filter((item): item is string => Boolean(item)).map((item) => `query_failed:${item}`),
    metrics: [],
    lineage: { requested_date: requestedDate, evidence_date: null, source },
  }
}

function candidateStatus(
  servingState: string | undefined,
  decision: string | null | undefined,
  dateCount: number | null,
  minDates: number,
): PipelineMaturityStatus {
  if (servingState === 'serving') return 'serving'
  if (dateCount == null) return 'blocked'
  if (String(decision ?? '').toUpperCase() === 'FAIL' && dateCount >= minDates) return 'failed_quality'
  if (dateCount < minDates) return 'collecting'
  return 'blocked'
}

function contributionModeForServing(state: string | undefined): PipelineContributionMode {
  if (state === 'serving') return 'production'
  if (state === 'safe_abstention') return 'evidence_only'
  return 'shadow'
}
function evidenceAvailability(
  evidence: { identity_valid: boolean; identity_blockers: string[] } | null | undefined,
  missingReason: string,
): { availability: 'available' | 'blocked' | 'missing'; reason_code: string | null } {
  if (!evidence) return { availability: 'missing', reason_code: missingReason }
  if (!evidence.identity_valid) {
    return {
      availability: 'blocked',
      reason_code: evidence.identity_blockers[0] ?? 'evidence_identity_invalid',
    }
  }
  return { availability: 'available', reason_code: null }
}

function servingPointerScope(
  serving: { artifact_state: string; serving_available: boolean; blockers: string[] } | null | undefined,
): { availability: 'available' | 'blocked' | 'missing'; reason_code: string | null } {
  if (!serving || serving.artifact_state === 'missing') {
    return { availability: 'missing', reason_code: 'serving_pointer_missing' }
  }
  if (serving.artifact_state === 'safe_abstention') {
    return { availability: 'available', reason_code: 'safe_abstention_pointer_active' }
  }
  if (!serving.serving_available || serving.artifact_state !== 'serving') {
    return {
      availability: 'blocked',
      reason_code: serving.blockers[0] ?? `serving_pointer_${serving.artifact_state}`,
    }
  }
  return { availability: 'available', reason_code: null }
}


export async function buildPipelineDecisionMaturityPacket(
  env: Bindings,
  requestedDate: string,
): Promise<PipelineDecisionMaturityPacket> {
  if (!validDate(requestedDate)) throw new Error(`invalid_pipeline_maturity_date:${requestedDate}`)
  const learningDb = databaseForDataDomain(env, 'learning')
  const marketDb = databaseForDataDomain(env, 'market')

  const canonicalHead = await safeQuery(() => databaseForDataDomain(env, 'ops').prepare(`
    SELECT substr(logical_run_key, 10, 10) signal_date, run_id
      FROM canonical_run_heads
     WHERE logical_run_key LIKE 'screener:%:TW:production:market_screener'
       AND substr(logical_run_key, 10, 10) <= ?
     ORDER BY substr(logical_run_key, 10, 10) DESC, updated_at DESC
     LIMIT 1
  `).bind(requestedDate).first<CanonicalHead>())
  const head = canonicalHead.value

  const [reference, matrix, redundancy, routeRun, routeHead, evRows, evShadowRows, serving, l4Maturity, sectorPit] = await Promise.all([
    safeQuery(() => head ? learningDb.prepare(`
      SELECT COUNT(*) reference_rows,
             SUM(CASE WHEN strategy_challenger_affinity_version=? THEN 1 ELSE 0 END) affinity_v2_rows,
             SUM(CASE WHEN strategy_challenger_route_version=? AND strategy_challenger_route_score IS NOT NULL THEN 1 ELSE 0 END) challenger_route_rows,
             AVG(strategy_router_score) incumbent_route_avg,
             AVG(strategy_challenger_route_score) challenger_route_avg,
             SUM(CASE WHEN strategy_selected=1 THEN 1 ELSE 0 END) strategy_selected_rows,
             SUM(CASE WHEN allocation_selected=1 THEN 1 ELSE 0 END) allocation_selected_rows
        FROM selection_reference_snapshots_v1
       WHERE signal_date=? AND producer_run_id=? AND hard_gate_passed=1
         AND EXISTS (
           SELECT 1 FROM strategy_label_matrix_runs_v4 mr
            WHERE mr.signal_date=selection_reference_snapshots_v1.signal_date
              AND mr.producer_run_id=selection_reference_snapshots_v1.producer_run_id
              AND mr.status='ready'
              AND mr.reference_contract_version=?
              AND mr.labeler_version IN (?, ?)
              AND mr.labeler_version=selection_reference_snapshots_v1.strategy_labeler_version
         )
    `).bind(
      STRATEGY_ROUTE_CHALLENGER_VERSION,
      STRATEGY_ROUTE_CHALLENGER_VERSION,
      head.signal_date,
      head.run_id,
      SELECTION_REFERENCE_CONTRACT_VERSION,
      STRATEGY_FORMAL_LABELER_VERSION,
      STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
    ).first<any>() : Promise.resolve(null)),
    safeQuery(() => head ? learningDb.prepare(`
      SELECT r.status, r.reference_candidate_count, r.strategy_count,
             r.expected_cell_count, r.persisted_cell_count, r.labeler_version,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1) matched_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1
                 AND m.affinity_evidence_count>0) raw_threshold_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1
                 AND m.affinity_evidence_count>0 AND m.challenger_affinity_version=?) projected_threshold_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.challenger_affinity_version=?) challenger_projection_cells,
             r.updated_at
        FROM strategy_label_matrix_runs_v4 r
       WHERE r.signal_date=? AND r.producer_run_id=?
         AND r.status='ready'
         AND r.reference_contract_version=?
         AND r.labeler_version IN (?, ?)
       LIMIT 1
    `).bind(
      STRATEGY_ROUTE_CHALLENGER_VERSION,
      STRATEGY_ROUTE_CHALLENGER_VERSION,
      head.signal_date,
      head.run_id,
      SELECTION_REFERENCE_CONTRACT_VERSION,
      STRATEGY_FORMAL_LABELER_VERSION,
      STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
    ).first<any>() : Promise.resolve(null)),
    safeQuery(() => learningDb.prepare(`
      SELECT artifact_id, as_of_date, status, source_contract, strategy_count,
             paired_date_count, oof_max_date, edge_count, effective_strategy_count,
             json_extract(graph_json, '$.paired_date_requirement') paired_date_requirement,
             json_extract(graph_json, '$.pair_count_with_any_overlap') overlap_pair_count,
             json_extract(graph_json, '$.eligible_oof_pair_count') eligible_pair_count,
             evidence_artifact_id, created_at
       FROM strategy_redundancy_artifacts_v1
       WHERE as_of_date<=?
       ORDER BY as_of_date DESC, created_at DESC
       LIMIT 1
    `).bind(requestedDate).first<any>()),
    safeQuery(() => learningDb.prepare(`
      SELECT run_id, artifact_version, as_of_date, status, candidate_route_version,
             route_floor, sample_count, date_count, train_start_date, train_end_date,
             oos_start_date, oos_end_date, top_bucket_net_return,
             top_bucket_net_return_lcb90, residual_spread, residual_spread_lcb90,
             brier_score, climatology_brier_score, log_loss, gate_json, created_at
        FROM strategy_route_calibration_runs_v1
       WHERE as_of_date<=? AND sample_count>0 AND date_count>0
       ORDER BY as_of_date DESC, created_at DESC
       LIMIT 1
    `).bind(requestedDate).first<any>()),
    safeQuery(() => learningDb.prepare(`
      SELECT h.run_id, h.artifact_version, h.candidate_route_version,
             h.route_floor, h.promoted_at
        FROM strategy_route_calibration_head_v1 h
        JOIN strategy_route_calibration_runs_v1 r ON r.run_id=h.run_id
       WHERE h.singleton_id=1 AND r.status='promoted' AND r.as_of_date<=?
       LIMIT 1
    `).bind(requestedDate).first<any>()),
    safeQuery(() => learningDb.prepare(`
      WITH ranked AS (
        SELECT model_name, artifact_id, version, candidate_type, training_run_id,
               checksum, artifact_path, state, source_run_date,
               offline_gate_decision, offline_gate_failed_gates,
               live_gate_status, updated_at, offline_evidence_json,
               ROW_NUMBER() OVER (
                 PARTITION BY model_name
                 ORDER BY source_run_date DESC, updated_at DESC, artifact_id DESC
               ) ordinal
          FROM model_artifact_registry
         WHERE ((model_name='l4_alpha_ev' AND candidate_type='l4_alpha_ev_refresh')
             OR (model_name='allocator_ev_fusion' AND candidate_type='allocator_ev_fusion_refresh'))
           AND source_run_date IS NOT NULL
           AND source_run_date GLOB '????-??-??'
           AND source_run_date<=?
      )
      SELECT model_name, artifact_id, version, candidate_type, training_run_id,
             checksum, artifact_path, state, source_run_date,
             offline_gate_decision, offline_gate_failed_gates,
             live_gate_status, updated_at, offline_evidence_json
        FROM ranked WHERE ordinal=1
    `).bind(requestedDate).all<ExpectedReturnCandidateDbRow>().then((result) => result.results ?? [])),
    safeQuery(() => learningDb.prepare(`
      WITH latest_batch AS (
        SELECT business_date, cohort_id, base_manifest_checksum, extension_manifest_checksum
          FROM expected_return_shadow_evaluation_packets
         WHERE business_date <= ? AND policy_decision='shadow_only'
         ORDER BY business_date DESC, updated_at DESC, evaluation_id DESC
         LIMIT 1
      ),
      ranked_batch AS (
        SELECT p.evaluation_id, p.identity_schema_version,
               p.subject_artifact_checksum, p.evaluator_contract_checksum,
               p.cohort_id, p.base_manifest_checksum,
               p.extension_manifest_checksum, p.artifact_path, p.artifact_checksum,
               p.business_date, p.model_name, p.model_version,
               p.oof_max_date, p.oof_date_count, p.oof_row_count,
               p.quality_decision, p.policy_decision, p.validation_packet_json, p.updated_at,
               ROW_NUMBER() OVER (
                 PARTITION BY p.model_name
                 ORDER BY p.updated_at DESC, p.evaluation_id DESC
               ) ordinal
          FROM expected_return_shadow_evaluation_packets p
          JOIN latest_batch b
            ON p.business_date=b.business_date
           AND p.cohort_id=b.cohort_id
           AND p.base_manifest_checksum=b.base_manifest_checksum
           AND p.extension_manifest_checksum=b.extension_manifest_checksum
         WHERE p.policy_decision='shadow_only'
      )
      SELECT evaluation_id, identity_schema_version,
             subject_artifact_checksum, evaluator_contract_checksum,
             cohort_id, base_manifest_checksum, extension_manifest_checksum,
             artifact_path, artifact_checksum, business_date, model_name, model_version,
             oof_max_date, oof_date_count, oof_row_count, quality_decision,
             policy_decision, validation_packet_json, updated_at
        FROM ranked_batch
       WHERE ordinal=1
       ORDER BY model_name
    `).bind(requestedDate).all<ExpectedReturnShadowDbRow>().then((result) => result.results ?? [])),
    safeQuery(() => readCurrentExpectedReturnServingState({ ...env, DB: learningDb }, requestedDate)),
    safeQuery(() => inspectAllocatorEvMaturityCoverage(learningDb, requestedDate)),
    safeQuery(() => marketDb.prepare(`
      WITH session_calendar AS (
        SELECT DISTINCT date(date) trading_date
          FROM canonical_market_daily
         WHERE stock_id='0050' AND source='finlab.price' AND date(date)<=date(?)
      ), sessions AS (
        SELECT trading_date,
               LAG(trading_date) OVER (ORDER BY trading_date) previous_session
          FROM session_calendar
      ), sector_sources AS (
        SELECT date(date) source_date, COUNT(DISTINCT classification) layer_count,
               MAX(COALESCE(updated_at, created_at)) source_available_at
          FROM sector_flow
         WHERE pit_lineage_version='sector-flow-pit-v1'
         GROUP BY date(date)
      ), ready_signals AS (
        SELECT sessions.trading_date signal_date
          FROM sessions
          JOIN sector_sources ON sector_sources.source_date=sessions.previous_session
         WHERE sector_sources.layer_count=4
           AND datetime(sector_sources.source_available_at)
               <= datetime(sessions.trading_date || 'T13:30:00+08:00')
      )
      SELECT MIN(signal_date) first_signal_date,
             MAX(signal_date) latest_signal_date,
             COUNT(*) signal_dates
        FROM ready_signals
    `).bind(requestedDate).first<SectorPitReadiness>()),
  ])

  const stages: PipelineMaturityStage[] = []
  let referenceRow = reference.value
  let matrixRow = matrix.value
  if (head && (!referenceRow || !matrixRow)) {
    const incumbentMatrix = await safeQuery(() => learningDb.prepare(`
      SELECT r.status, r.reference_candidate_count, r.strategy_count,
             r.expected_cell_count, r.persisted_cell_count, r.labeler_version,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1) matched_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1
                 AND m.affinity_evidence_count>0) raw_threshold_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1
                 AND m.affinity_evidence_count>0 AND m.challenger_affinity_version=?) projected_threshold_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.challenger_affinity_version=?) challenger_projection_cells,
             r.updated_at
        FROM strategy_label_matrix_runs_v4 r
       WHERE r.signal_date=? AND r.producer_run_id=?
         AND r.status='ready'
         AND r.reference_contract_version=?
         AND r.labeler_version NOT IN (?, ?)
       ORDER BY r.updated_at DESC
       LIMIT 1
    `).bind(
      STRATEGY_ROUTE_CHALLENGER_VERSION,
      STRATEGY_ROUTE_CHALLENGER_VERSION,
      head.signal_date,
      head.run_id,
      SELECTION_REFERENCE_CONTRACT_VERSION,
      STRATEGY_FORMAL_LABELER_VERSION,
      STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
    ).first<any>())
    const incumbentMatrixRow = incumbentMatrix.value
    if (incumbentMatrixRow) {
      const incumbentReference = await safeQuery(() => learningDb.prepare(`
        SELECT COUNT(*) reference_rows,
               SUM(CASE WHEN strategy_challenger_affinity_version=? THEN 1 ELSE 0 END) affinity_v2_rows,
               SUM(CASE WHEN strategy_challenger_route_version=? AND strategy_challenger_route_score IS NOT NULL THEN 1 ELSE 0 END) challenger_route_rows,
               AVG(strategy_router_score) incumbent_route_avg,
               AVG(strategy_challenger_route_score) challenger_route_avg,
               SUM(CASE WHEN strategy_selected=1 THEN 1 ELSE 0 END) strategy_selected_rows,
               SUM(CASE WHEN allocation_selected=1 THEN 1 ELSE 0 END) allocation_selected_rows
          FROM selection_reference_snapshots_v1
         WHERE signal_date=? AND producer_run_id=? AND hard_gate_passed=1
           AND strategy_labeler_version=?
           AND EXISTS (
             SELECT 1 FROM strategy_label_matrix_runs_v4 mr
              WHERE mr.signal_date=selection_reference_snapshots_v1.signal_date
                AND mr.producer_run_id=selection_reference_snapshots_v1.producer_run_id
                AND mr.status='ready'
                AND mr.reference_contract_version=?
                AND mr.labeler_version=selection_reference_snapshots_v1.strategy_labeler_version
           )
      `).bind(
        STRATEGY_ROUTE_CHALLENGER_VERSION,
        STRATEGY_ROUTE_CHALLENGER_VERSION,
        head.signal_date,
        head.run_id,
        incumbentMatrixRow.labeler_version,
        SELECTION_REFERENCE_CONTRACT_VERSION,
      ).first<any>())
      if (incumbentReference.value) {
        matrixRow = incumbentMatrixRow
        referenceRow = incumbentReference.value
      }
    }
  }
  if (!head || !referenceRow || !matrixRow) {
    stages.push(unavailableStage(
      'threshold_margin_affinity_v2', 'L1', 'Threshold-margin affinity V2', requestedDate,
      'selection_reference_snapshots_v1 + strategy_label_matrix_v4',
      [canonicalHead.error, reference.error, matrix.error, !head ? 'canonical_run_head_missing' : null],
    ))
  } else {
    const formalLabeler = (
      matrixRow.labeler_version === STRATEGY_FORMAL_LABELER_VERSION
      || matrixRow.labeler_version === STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION
    )
    const matched = finite(matrixRow.matched_rows)
    const rawCovered = finite(matrixRow.raw_threshold_rows)
    const projected = finite(matrixRow.projected_threshold_rows)
    const projectionCells = finite(matrixRow.challenger_projection_cells)
    const referenceProjectionRows = finite(referenceRow.affinity_v2_rows)
    const rawComplete = matched > 0 && rawCovered === matched
    const projectionComplete = projected === matched && projectionCells === finite(matrixRow.expected_cell_count) && referenceProjectionRows === finite(referenceRow.reference_rows)
    const complete = rawComplete && projectionComplete
    const blockers = [
      ...(formalLabeler ? [] : [`formal_labeler_upgrade_pending:${matrixRow.labeler_version}`]),
      ...(rawComplete ? [] : ['threshold_margin_evidence_incomplete']),
      ...(projectionComplete ? [] : ['challenger_affinity_projection_incomplete']),
    ]
    stages.push({
      id: 'threshold_margin_affinity_v2',
      layer: 'L1',
      title: 'Threshold-margin affinity V2',
      version: STRATEGY_ROUTE_CHALLENGER_VERSION,
      status: formalLabeler ? (complete ? 'ready' : 'blocked') : 'collecting',
      contribution_mode: formalLabeler ? 'shadow' : 'evidence_only',
      maturity_kind: 'daily_coverage',
      progress: maturityProgress(projected, matched, 'rows'),
      decision: !formalLabeler
        ? `既有 production run 的 ${projected}/${matched} 筆 threshold/challenger evidence 仍存在；正式 revenue-PIT labeler 尚未物化，不能冒充 formal V2 通過。`
        : complete
          ? `當日 ${projected}/${matched} 筆策略命中均有 threshold margin 與 challenger affinity projection。`
        : rawComplete
          ? `Raw threshold margin 已完整 ${rawCovered}/${matched}；但 challenger projection 只有 ${projected}/${matched}，全矩陣 ${projectionCells}/${finite(matrixRow.expected_cell_count)}。`
          : `Raw threshold margin 只有 ${rawCovered}/${matched}，尚未具備完整 projection 前置證據。`,
      contribution: '用各策略自己的門檻距離與 signal strength 產生 challenger affinity，避免所有策略共用同一份 raw quality。',
      production_effect: formalLabeler
        ? '目前只餵給 challenger route；不直接改變 incumbent route、L4 或 BUY/HOLD。'
        : 'Incumbent production 選股仍有資料並持續運作；此 fallback 只供可觀測性，不取得 formal promotion 權限。',
      blockers,
      metrics: [
        gateMetric('raw_threshold_rows', 'Raw threshold margin', rawCovered, matched, 'rows'),
        gateMetric('projected_threshold_rows', 'Projected strategy hits', projected, matched, 'rows'),
        gateMetric('challenger_projection_cells', 'Projected PIT matrix cells', projectionCells, finite(matrixRow.expected_cell_count), 'rows'),
        gateMetric('reference_projection_rows', 'Projected reference universe', referenceProjectionRows, finite(referenceRow.reference_rows), 'rows'),
        metric('strategy_count', 'Strategy count', matrixRow.strategy_count, { unit: 'count' }),
        metric('matrix_cells', 'PIT matrix cells', matrixRow.persisted_cell_count, { target: matrixRow.expected_cell_count, comparator: 'eq', unit: 'rows', passed: finite(matrixRow.persisted_cell_count) === finite(matrixRow.expected_cell_count) }),
        metric('challenger_route_rows', 'Downstream challenger route rows', referenceRow.challenger_route_rows, { unit: 'rows', note: 'Route V2 是下游 calibration，不列入本 L1 daily coverage gate。' }),
      ],
      lineage: {
        requested_date: requestedDate,
        evidence_date: head.signal_date,
        oof_applicable: false,
        evidence_semantics: 'Daily canonical decision-universe coverage; this is not cumulative and not OOF.',
        artifact_id: head.run_id,
        source: formalLabeler
          ? 'canonical selection reference + formal strategy matrix'
          : 'canonical selection reference + incumbent exact-run strategy matrix (display-only fallback)',
        updated_at: matrixRow.updated_at ?? null,
      },
    })
  }

  const redundancyRow = redundancy.value
  if (!redundancyRow) {
    stages.push(unavailableStage('oof_redundancy', 'L1.25', 'OOF redundancy', requestedDate, 'strategy_redundancy_artifacts_v1', [redundancy.error]))
  } else {
    const required = Math.max(0, finite(redundancyRow.paired_date_requirement))
    const current = finite(redundancyRow.paired_date_count)
    const isPass = redundancyRow.status === 'pass'
    const status: PipelineMaturityStatus = isPass
      ? 'ready'
      : redundancyRow.status === 'pending_maturity'
        ? 'collecting'
        : 'failed_quality'
    stages.push({
      id: 'oof_redundancy',
      layer: 'L1.25',
      title: 'OOF redundancy',
      version: 'strategy-similarity-evidence-v1',
      status,
      contribution_mode: isPass ? 'production' : 'evidence_only',
      maturity_kind: 'paired_oof',
      progress: maturityProgress(current, required, 'dates'),
      decision: isPass
        ? `已有 ${current} 個 paired OOF dates，可估計策略重複與 residualized marginal support。`
        : `目前 ${current}/${required} 個 paired OOF dates；相似度未知，不把缺 evidence 當成零重複。`,
      contribution: '在同日、同市場、成本後 residual return 上辨識策略重複，對高度相關命中採遞減增益。',
      production_effect: isPass
        ? '相似度圖可調整策略組合的邊際支持，但不能強制 Top-K 或 sector quota。'
        : '尚未成熟時不做 redundancy shrink；保留各策略原始貢獻。',
      blockers: isPass ? [] : [redundancyRow.status === 'pending_maturity' ? 'insufficient_paired_mature_oof_residual_returns' : `redundancy_${redundancyRow.status}`],
      metrics: [
        gateMetric('paired_dates', 'Paired OOF dates', current, required, 'dates'),
        metric('oof_max_date', 'OOF max date', redundancyRow.oof_max_date, { unit: 'status' }),
        metric('overlap_pairs', 'Pairs with overlap', redundancyRow.overlap_pair_count, { unit: 'count' }),
        metric('eligible_pairs', 'Eligible OOF pairs', redundancyRow.eligible_pair_count, { unit: 'count' }),
        metric('edge_count', 'Redundancy graph edges', redundancyRow.edge_count, { unit: 'count' }),
        metric('effective_strategies', 'Effective strategies', redundancyRow.effective_strategy_count, { unit: 'count' }),
      ],
      lineage: {
        requested_date: requestedDate,
        evidence_date: redundancyRow.as_of_date,
        oof_max_date: redundancyRow.oof_max_date ?? null,
        oof_applicable: true,
        evidence_semantics: 'Latest paired mature residual-return cutoff; as_of_date can be newer than oof_max_date.',
        artifact_id: redundancyRow.evidence_artifact_id ?? redundancyRow.artifact_id,
        source: redundancyRow.source_contract,
        updated_at: redundancyRow.created_at,
      },
    })
  }

  const route = routeRun.value
  const promotedRoute = routeHead.value
  if (!route) {
    stages.push(unavailableStage('route_score_v2', 'L1.5', 'New route score', requestedDate, 'strategy_route_calibration_runs_v1', [routeRun.error, routeHead.error]))
  } else {
    const gates = jsonRecord(route.gate_json)
    const promoted = Boolean(promotedRoute?.run_id && promotedRoute.candidate_route_version === STRATEGY_ROUTE_CHALLENGER_VERSION)
    const dateCount = finite(route.date_count)
    const status: PipelineMaturityStatus = promoted
      ? 'serving'
      : route.status === 'pending_maturity'
        ? 'collecting'
        : route.status === 'pass'
          ? 'ready'
          : 'failed_quality'
    stages.push({
      id: 'route_score_v2',
      layer: 'L1.5',
      title: 'New route score',
      version: route.candidate_route_version ?? STRATEGY_ROUTE_CHALLENGER_VERSION,
      status,
      contribution_mode: promoted ? 'production' : 'shadow',
      maturity_kind: 'calibration',
      progress: maturityProgress(dateCount, STRATEGY_ROUTE_MIN_TOTAL_DATES, 'dates'),
      decision: promoted
        ? `使用 train-only 選出的 route floor ${finite(promotedRoute.route_floor).toFixed(2)} 路由正式候選。`
        : `Challenger 已計算，但只有 ${dateCount}/${STRATEGY_ROUTE_MIN_TOTAL_DATES} 個成熟日期，未取代 incumbent route。`,
      contribution: '融合 threshold-margin affinity、策略邊際支持、可靠度與市場情境，決定候選進入 L2/L3 的優先程度。',
      production_effect: promoted
        ? '通過 train/purge/OOS、成本後 top bucket、residual spread 與 calibration gate 後才作用於 production。'
        : 'shadow learning only；不因候選分數較高而改寫今日 production route。',
      blockers: promoted ? [] : Object.entries(gates).filter(([, passed]) => passed === false).map(([gate]) => gate),
      metrics: [
        gateMetric('mature_dates', 'Mature labeled dates', dateCount, STRATEGY_ROUTE_MIN_TOTAL_DATES, 'dates'),
        gateMetric('train_dates', 'Train dates', STRATEGY_ROUTE_MIN_TRAIN_DATES, STRATEGY_ROUTE_MIN_TRAIN_DATES, 'dates'),
        gateMetric('purge_dates', 'Purged date groups', STRATEGY_ROUTE_PURGE_DATES, STRATEGY_ROUTE_PURGE_DATES, 'dates'),
        gateMetric('oos_dates', 'Required OOS dates', STRATEGY_ROUTE_MIN_OOS_DATES, STRATEGY_ROUTE_MIN_OOS_DATES, 'dates'),
        metric('sample_count', 'Labeled route observations', route.sample_count, { unit: 'rows' }),
        metric('incumbent_route_avg', 'Incumbent route avg', referenceRow?.incumbent_route_avg ?? null, { unit: 'score' }),
        metric('challenger_route_avg', 'Challenger route avg', referenceRow?.challenger_route_avg ?? null, { unit: 'score' }),
        metric('route_floor', 'Train-selected route floor', route.route_floor, { unit: 'score', passed: route.route_floor == null ? null : true }),
        gateMetric('top_bucket_lcb90', 'Top bucket net return LCB90', route.top_bucket_net_return_lcb90, 0, 'return', 'gt'),
        gateMetric('residual_spread_lcb90', 'Residual spread LCB90', route.residual_spread_lcb90, 0, 'return', 'gt'),
        metric('brier', 'Brier vs climatology', route.brier_score, { target: route.climatology_brier_score, comparator: 'lt', unit: 'ratio', passed: optionalFinite(route.brier_score) != null && optionalFinite(route.climatology_brier_score) != null ? finite(route.brier_score) < finite(route.climatology_brier_score) : null }),
      ],
      lineage: {
        requested_date: requestedDate,
        evidence_date: route.as_of_date,
        artifact_id: route.run_id,
        oof_max_date: route.oos_end_date ?? null,
        oof_applicable: true,
        evidence_semantics: 'Train/purge/OOS route calibration cutoff; independent from daily affinity coverage.',
        source: 'purged chronological route calibration',
        updated_at: route.created_at,
      },
    })
  }


  const evCandidates = new Map<string, ExpectedReturnCandidateEvidence>(
    (evRows.value ?? []).map((row) => {
      const evidence = adaptExpectedReturnCandidate(row)
      return [evidence.model_name, evidence]
    }),
  )
  const servingState = serving.value
  const runtimeGuard = servingState?.runtime_forward_guard
  const maturity = l4Maturity.value
  const sectorReadiness = sectorPit.value
  const shadowRows = evShadowRows.value ?? []
  const shadowModels = new Set(shadowRows.map((row) => row.model_name))
  const shadowPairComplete = shadowRows.length === 2
    && shadowModels.has('l4_alpha_ev')
    && shadowModels.has('allocator_ev_fusion')
    && shadowModels.size === 2
  const shadowBatchReason = shadowRows.length === 0
    ? 'frozen_forward_packet_missing'
    : shadowPairComplete ? null : 'frozen_forward_pair_incomplete'
  const evShadow = new Map<string, ExpectedReturnShadowEvidence>(
    shadowRows.map((row) => [row.model_name, adaptExpectedReturnShadow(row)]),
  )

  const l4 = evCandidates.get('l4_alpha_ev')
  const l4ShadowPacket = evShadow.get('l4_alpha_ev')
  const l4Shadow = shadowPairComplete && l4ShadowPacket?.identity_valid ? l4ShadowPacket : undefined
  const l4Serving = servingState?.artifacts.l4_alpha_ev
  if (!l4 && !l4Serving) {
    stages.push(unavailableStage('l4', 'L4', 'Canonical L4 alpha EV', requestedDate, 'model_artifact_registry + allocator_ev_feature_snapshots', [evRows.error, serving.error, l4Maturity.error]))
  } else {
    const minSamples = Math.max(1, finite(l4?.fit_min_samples, 500))
    const minDates = Math.max(1, finite(l4?.fit_min_dates, 20))
    const sampleCount = optionalFinite(l4?.sample_count)
    const dateCount = optionalFinite(l4?.date_count)
    const offlineBlockers = l4?.offline_gate_failed_gates ?? ['offline_candidate_missing']
    const servingBlockers = l4Serving?.blockers ?? ['serving_pointer_missing']
    const shadowBlockers = shadowBatchReason ? [shadowBatchReason] : l4ShadowPacket?.failed_gates ?? ['frozen_forward_packet_missing']
    const candidateMetricScope = evidenceAvailability(l4, 'offline_candidate_missing')
    const shadowMetricScope = shadowBatchReason
      ? { availability: shadowRows.length ? 'blocked' as const : 'missing' as const, reason_code: shadowBatchReason }
      : evidenceAvailability(l4ShadowPacket, 'frozen_forward_packet_missing')
    const status = l4 && !l4.identity_valid
      ? 'blocked'
      : candidateStatus(l4Serving?.artifact_state, l4?.offline_gate_decision, dateCount, minDates)
    const blockerGroups: PipelineMaturityBlockerGroup[] = [
      {
        scope: 'offline_candidate',
        title: 'Promotion candidate (not serving)',
        blockers: offlineBlockers,
      },
      {
        scope: 'serving_pointer',
        title: 'Production serving pointer',
        blockers: servingBlockers,
      },
      {
        scope: 'frozen_forward',
        title: 'Frozen-forward monitoring evidence (not serving)',
        blockers: shadowBlockers,
      },
    ]
    stages.push({
      id: 'l4',
      layer: 'L4',
      title: 'Canonical L4 alpha EV',
      version: l4?.version ?? l4Serving?.model_version ?? null,
      status,
      contribution_mode: contributionModeForServing(l4Serving?.artifact_state),
      maturity_kind: 'artifact_quality',
      progress: l4?.identity_valid ? maturityProgress(dateCount, minDates, 'dates') : null,
      decision: l4Serving?.artifact_state === 'serving'
        ? 'Canonical L4 是目前 production expected-return owner。'
        : l4Serving?.artifact_state === 'safe_abstention'
          ? 'Production 目前使用 safe-abstention fallback；L4 alpha 候選尚未 serving。'
        : `候選資料 ${sampleCount ?? 'Missing'}/${minSamples} rows、${dateCount ?? 'Missing'}/${minDates} dates；${String(l4?.offline_gate_decision ?? 'PENDING').toUpperCase()}。`,
      contribution: '把 Active-8、Score V2、基本面、籌碼、技術面與 PIT sector alpha 校準成五日成本後絕對報酬。',
      production_effect: l4Serving?.artifact_state === 'serving'
        ? '提供 L4 expected return，與風險/流動性 gate 一起決定 BUY/HOLD。'
        : l4Serving?.artifact_state === 'safe_abstention'
          ? 'Production pointer 有效，但只提供安全 abstention fallback；不代表 L4 alpha 品質通過或正在貢獻。'
        : '候選只保存 OOF evidence；不改寫 production expected return。',
      blockers: offlineBlockers,
      blocker_groups: blockerGroups,
      metrics: [
        gateMetric('samples', 'Usable OOF samples', sampleCount, minSamples, 'rows', 'gte', { ...candidateMetricScope, scope: 'promotion_gate' }),
        gateMetric('dates', 'Usable OOF dates', dateCount, minDates, 'dates', 'gte', { ...candidateMetricScope, scope: 'promotion_gate' }),
        gateMetric('sector_samples', 'Offline candidate PIT sector-alpha samples', l4?.sector_samples, Math.max(1, finite(l4?.min_sector_samples, 300)), 'rows', 'gte', { ...candidateMetricScope, scope: 'promotion_gate', note: '只計入該 candidate OOF 截止日前已合法存在的 PIT sector features；不以今日 source coverage 回填舊 candidate。' }),
        gateMetric('sector_dates', 'Offline candidate PIT sector-alpha dates', l4?.sector_dates, Math.max(1, finite(l4?.min_sector_dates, 8)), 'dates', 'gte', { ...candidateMetricScope, scope: 'promotion_gate' }),
        gateMetric('corr_lcb90', 'Offline candidate corr LCB90', l4?.l4_corr_lcb90, 0, 'ratio', 'gt', { ...candidateMetricScope, scope: 'promotion_gate' }),
        gateMetric('spread_lcb90', 'Offline candidate spread LCB90', l4?.l4_spread_lcb90, 0, 'return', 'gt', { ...candidateMetricScope, scope: 'promotion_gate' }),
        gateMetric('top_return', 'Offline candidate top-quintile mean', l4?.l4_top_return, 0, 'return', 'gt', { ...candidateMetricScope, scope: 'promotion_gate' }),
        gateMetric('top_lcb90', 'Offline candidate top-quintile LCB90', l4?.l4_top_lcb90, 0, 'return', 'gt', { ...candidateMetricScope, scope: 'promotion_gate' }),
        metric('walk_forward', 'Offline candidate walk-forward', l4?.walk_forward_passed, { target: true, comparator: 'eq', unit: 'status', passed: l4?.walk_forward_passed == null ? null : l4.walk_forward_passed, ...candidateMetricScope, scope: 'promotion_gate' }),
        metric('strict_pit_rows', 'Materialized strict L4 PIT', maturity?.strictL4PitRows ?? null, { unit: 'rows', scope: 'lifecycle' }),
        metric('strict_pit_dates', 'Materialized strict L4 PIT dates', maturity?.strictL4PitDates ?? null, { unit: 'dates', scope: 'lifecycle' }),
        metric('sector_source_signal_dates', '目前可供後續 cohort 使用的 PIT sector signal dates', sectorReadiness?.signal_dates ?? null, { unit: 'dates', scope: 'lifecycle', note: `合法 prior-session source window：${sectorReadiness?.first_signal_date ?? '尚無'} → ${sectorReadiness?.latest_signal_date ?? '尚無'}。這是 source readiness，不是舊 candidate 的 promotion evidence。` }),
        gateMetric('shadow_sector_samples', 'Latest shadow PIT sector-alpha samples', l4Shadow?.sector_samples, Math.max(1, finite(l4?.min_sector_samples, 300)), 'rows', 'gte', { ...shadowMetricScope, scope: 'monitoring' }),
        gateMetric('shadow_sector_dates', 'Latest shadow PIT sector-alpha dates', l4Shadow?.sector_dates, Math.max(1, finite(l4?.min_sector_dates, 8)), 'dates', 'gte', { ...shadowMetricScope, scope: 'monitoring' }),
        gateMetric('shadow_corr_lcb90', 'Latest shadow corr LCB90', l4Shadow?.l4_corr_lcb90, 0, 'ratio', 'gt', { ...shadowMetricScope, scope: 'monitoring' }),
        gateMetric('shadow_spread_lcb90', 'Latest shadow spread LCB90', l4Shadow?.l4_spread_lcb90, 0, 'return', 'gt', { ...shadowMetricScope, scope: 'monitoring' }),
        gateMetric('shadow_top_return', 'Latest shadow top-quintile mean', l4Shadow?.l4_top_return, 0, 'return', 'gt', { ...shadowMetricScope, scope: 'monitoring' }),
        gateMetric('shadow_top_lcb90', 'Latest shadow top-quintile LCB90', l4Shadow?.l4_top_lcb90, 0, 'return', 'gt', { ...shadowMetricScope, scope: 'monitoring' }),
        metric('shadow_walk_forward', 'Latest shadow walk-forward', l4Shadow?.walk_forward_passed, { target: true, comparator: 'eq', unit: 'status', passed: l4Shadow?.walk_forward_passed ?? null, ...shadowMetricScope, scope: 'monitoring' }),
        metric('frozen_forward_quality', 'Active-8 cohort causal shadow quality', l4Shadow?.quality_decision ?? null, { target: 'PASS', comparator: 'eq', unit: 'status', passed: l4Shadow == null ? null : l4Shadow.quality_decision === 'PASS', ...shadowMetricScope, scope: 'monitoring' }),
        metric('frozen_forward_dates', 'Active-8 cohort causal shadow dates', l4Shadow?.oof_date_count ?? null, { unit: 'dates', ...shadowMetricScope, scope: 'monitoring', note: 'Rebuilds causal validation on a fixed Active-8 cohort; it is not the production serving artifact, training evidence, or promotion evidence.' }),
      ],
      lineage: {
        requested_date: requestedDate,
        evidence_date: l4?.source_run_date ?? null,
        oof_max_date: l4?.fusion_oof_max_date ?? null,
        cadence: l4?.cadence ?? 'unknown',
        role: 'candidate',
        date_semantic: 'candidate_cutoff',
        oof_unavailable_reason: l4?.fusion_oof_max_date ? null : !l4 ? 'offline_candidate_missing' : !l4.identity_valid ? l4.identity_blockers[0] ?? 'candidate_identity_invalid' : 'candidate_oof_max_not_published',
        artifact_id: l4?.artifact_id ?? null,
        oof_applicable: true,
        evidence_semantics: 'Purged Active-8 OOF and five-session net-label cutoff.',
        model_version: l4?.version ?? null,
        source: 'offline candidate; production pointer and frozen-forward shadow are separate evidence scopes',
        updated_at: l4?.updated_at ?? null,
        evidence_scopes: {
          offline_candidate: {
            cadence: l4?.cadence ?? 'unknown',
            role: 'candidate',
            date_semantic: 'candidate_cutoff',
            availability: !l4 ? 'missing' : l4.identity_valid ? 'available' : 'blocked',
            reason_code: !l4 ? 'offline_candidate_missing' : l4.identity_valid ? null : l4.identity_blockers[0] ?? 'candidate_identity_invalid',
            identity_assurance: l4?.identity_assurance ?? null,
            identity_schema_version: l4?.identity_schema_version ?? null,
            artifact_id: l4?.artifact_id ?? null,
            artifact_path: l4?.artifact_path ?? null,
            artifact_checksum: l4?.checksum ?? null,
            identity_valid: l4?.identity_valid ?? false,
            identity_blockers: l4?.identity_blockers ?? ['offline_candidate_missing'],
            model_version: l4?.version ?? null,
            artifact_contract_version: l4?.artifact_contract_version ?? null,
            validation_schema_version: l4?.validation_schema_version ?? null,
            source_run_date: l4?.source_run_date ?? null,
            updated_at: l4?.updated_at ?? null,
            oof_max_date: l4?.fusion_oof_max_date ?? null,
          },
          serving_pointer: {
            cadence: 'event-driven',
            role: 'serving',
            date_semantic: 'current_pointer_effective_at',
            availability: servingPointerScope(l4Serving).availability,
            reason_code: servingPointerScope(l4Serving).reason_code,
            artifact_state: l4Serving?.artifact_state ?? null,
            observed_at: servingState?.evaluated_at ?? null,
            artifact_id: l4Serving?.artifact_id ?? null,
            model_version: l4Serving?.model_version ?? null,
            artifact_contract_version: l4Serving?.artifact_contract_version ?? null,
            serving_mode: l4Serving?.serving_mode ?? null,
            updated_at: l4Serving?.pointer_updated_at ?? null,
          },
          frozen_forward: {
            cadence: 'daily',
            role: 'monitoring',
            date_semantic: 'monitoring_business_date',
            availability: shadowMetricScope.availability,
            reason_code: shadowMetricScope.reason_code,
            evaluation_id: l4ShadowPacket?.evaluation_id ?? null,
            cohort_id: l4ShadowPacket?.cohort_id ?? null,
            identity_schema_version: l4ShadowPacket?.identity_schema_version ?? null,
            subject_artifact_checksum: l4ShadowPacket?.subject_artifact_checksum ?? null,
            evaluator_contract_checksum: l4ShadowPacket?.evaluator_contract_checksum ?? null,
            artifact_path: l4ShadowPacket?.artifact_path ?? null,
            artifact_checksum: l4ShadowPacket?.artifact_checksum ?? null,
            identity_blockers: l4ShadowPacket?.identity_blockers ?? ['frozen_forward_packet_missing'],
            identity_valid: l4ShadowPacket?.identity_valid ?? false,
            model_version: l4ShadowPacket?.model_version ?? null,
            validation_schema_version: l4ShadowPacket?.validation_schema_version ?? null,
            business_date: l4ShadowPacket?.business_date ?? null,
            oof_max_date: l4ShadowPacket?.oof_max_date ?? null,
            updated_at: l4ShadowPacket?.updated_at ?? null,
          },
        },
      },
    })
  }

  const fusion = evCandidates.get('allocator_ev_fusion')
  const fusionShadowPacket = evShadow.get('allocator_ev_fusion')
  const fusionShadow = shadowPairComplete && fusionShadowPacket?.identity_valid ? fusionShadowPacket : undefined
  const fusionServing = servingState?.artifacts.allocator_ev_fusion
  if (!fusion && !fusionServing) {
    stages.push(unavailableStage('fusion', 'L4+', 'Fusion final trade EV', requestedDate, 'model_artifact_registry + allocator EV snapshots', [evRows.error, serving.error]))
  } else {
    const minSamples = Math.max(1, finite(fusion?.min_primary_samples, 1500))
    const minDates = Math.max(1, finite(fusion?.min_primary_dates, 20))
    const sampleCount = optionalFinite(fusion?.sample_count)
    const dateCount = optionalFinite(fusion?.date_count)
    const offlineBlockers = (fusion?.offline_gate_failed_gates ?? ['offline_candidate_missing'])
      .filter((blocker) => blocker !== 'residual_champion:residual_adjustment_model_not_validated')
    const servingBlockers = fusionServing?.blockers ?? ['serving_pointer_missing']
    const shadowBlockers = shadowBatchReason ? [shadowBatchReason] : fusionShadowPacket?.failed_gates ?? ['frozen_forward_packet_missing']
    const candidateMetricScope = evidenceAvailability(fusion, 'offline_candidate_missing')
    const shadowMetricScope = shadowBatchReason
      ? { availability: shadowRows.length ? 'blocked' as const : 'missing' as const, reason_code: shadowBatchReason }
      : evidenceAvailability(fusionShadowPacket, 'frozen_forward_packet_missing')
    const runtimeGuardBound = Boolean(
      runtimeGuard
      && runtimeGuard.artifact_id === fusionServing?.artifact_id
      && runtimeGuard.model_fingerprint === fusionServing?.model_fingerprint
    )
    const runtimeGuardMetricScope = !runtimeGuard
      ? { availability: 'not_applicable' as const, reason_code: 'no_serving_residual_guard_required' }
      : runtimeGuardBound
        ? { availability: 'available' as const, reason_code: null }
        : { availability: 'blocked' as const, reason_code: 'runtime_guard_identity_mismatch' }
    const runtimeGuardBlockers = runtimeGuard && !runtimeGuardBound
      ? ['runtime_guard_identity_mismatch']
      : runtimeGuardBound && runtimeGuard?.state === 'residual_bypass'
        ? ['serving_forward_guard_residual_bypass_active'] : []
    const status = fusion && !fusion.identity_valid
      ? 'blocked'
      : candidateStatus(fusionServing?.artifact_state, fusion?.offline_gate_decision, dateCount, minDates)
    const blockerGroups: PipelineMaturityBlockerGroup[] = [
      {
        scope: 'offline_candidate',
        title: 'Promotion candidate (not serving)',
        blockers: offlineBlockers,
      },
      {
        scope: 'serving_pointer',
        title: 'Production serving pointer',
        blockers: servingBlockers,
      },
      {
        scope: 'frozen_forward',
        title: 'Frozen-forward monitoring evidence (not serving)',
        blockers: shadowBlockers,
      },
      {
        scope: 'runtime_guard',
        title: 'Actual serving artifact T+5 guard',
        blockers: runtimeGuardBlockers,
      },
    ]
    stages.push({
      id: 'fusion',
      layer: 'L4+',
      title: 'Fusion final trade EV',
      version: fusion?.version ?? fusionServing?.model_version ?? null,
      status,
      contribution_mode: contributionModeForServing(fusionServing?.artifact_state),
      maturity_kind: 'artifact_quality',
      progress: fusion?.identity_valid ? maturityProgress(dateCount, minDates, 'dates') : null,
      decision: fusionServing?.artifact_state === 'serving'
        ? 'Fusion 是 production primary expected-return owner。'
        : fusionServing?.artifact_state === 'safe_abstention'
          ? 'Production 目前使用 safe-abstention fallback；Fusion residual 候選尚未 serving。'
        : `候選資料 ${sampleCount ?? 'Missing'}/${minSamples} rows、${dateCount ?? 'Missing'}/${minDates} dates；tier ${fusion?.promotion_tier ?? 'shadow'}。`,
      contribution: '以 canonical L4 expected return 為 base，只疊加通過驗證的 v14 residual adjustment；S12 僅保留 shadow diagnostic。',
      production_effect: fusionServing?.artifact_state === 'serving'
        ? '以 L4 base 加上已驗證 residual 作 final trade EV；sparse allocator 仍是選擇與權重 owner。'
        : fusionServing?.artifact_state === 'safe_abstention'
          ? 'Production pointer 有效，但 residual adjustment 固定為 0；sparse allocator 保留，Fusion alpha 尚未貢獻。'
        : 'Residual 未通過時 adjustment 固定為 0，不得抹除或否決合格 canonical L4 base EV。',
      blockers: offlineBlockers,
      blocker_groups: blockerGroups,
      metrics: [
        gateMetric('samples', 'Offline candidate usable samples', sampleCount, minSamples, 'rows', 'gte', { ...candidateMetricScope, scope: 'promotion_gate' }),
        gateMetric('dates', 'Offline candidate usable dates', dateCount, minDates, 'dates', 'gte', { ...candidateMetricScope, scope: 'promotion_gate' }),
        gateMetric('l4_samples', 'Offline candidate L4 PIT samples', fusion?.l4_samples, Math.max(1, finite(fusion?.min_l4_samples, 300)), 'rows', 'gte', { ...candidateMetricScope, scope: 'promotion_gate' }),
        gateMetric('l4_dates', 'Offline candidate L4 PIT dates', fusion?.l4_dates, Math.max(1, finite(fusion?.min_l4_dates, 8)), 'dates', 'gte', { ...candidateMetricScope, scope: 'promotion_gate' }),
        metric('structure_samples', 'S12 shadow diagnostic structure samples', fusion?.structure_samples, { unit: 'rows', scope: 'diagnostic', availability: fusion?.structure_samples == null ? 'not_applicable' : 'available', reason_code: fusion?.structure_samples == null ? 'diagnostic_not_served_by_fusion_v14' : null, note: 'Diagnostic only; not a Fusion v14 serving gate.' }),
        metric('structure_dates', 'S12 shadow diagnostic structure dates', fusion?.structure_dates, { unit: 'dates', scope: 'diagnostic', availability: fusion?.structure_dates == null ? 'not_applicable' : 'available', reason_code: fusion?.structure_dates == null ? 'diagnostic_not_served_by_fusion_v14' : null, note: 'Diagnostic only; not a Fusion v14 serving gate.' }),
        metric('execution_samples', 'S12 shadow diagnostic executed samples', fusion?.execution_samples, { unit: 'rows', scope: 'diagnostic', availability: fusion?.execution_samples == null ? 'not_applicable' : 'available', reason_code: fusion?.execution_samples == null ? 'diagnostic_not_served_by_fusion_v14' : null, note: 'Diagnostic only; not a Fusion v14 serving gate.' }),
        metric('execution_dates', 'S12 shadow diagnostic executed dates', fusion?.execution_dates, { unit: 'dates', scope: 'diagnostic', availability: fusion?.execution_dates == null ? 'not_applicable' : 'available', reason_code: fusion?.execution_dates == null ? 'diagnostic_not_served_by_fusion_v14' : null, note: 'Diagnostic only; not a Fusion v14 serving gate.' }),
        gateMetric('market_samples', 'Offline candidate PIT market-context samples', fusion?.market_samples, Math.max(1, finite(fusion?.min_market_samples, 300)), 'rows', 'gte', { ...candidateMetricScope, scope: 'promotion_gate' }),
        gateMetric('market_dates', 'Offline candidate PIT market-context dates', fusion?.market_dates, Math.max(1, finite(fusion?.min_market_dates, 8)), 'dates', 'gte', { ...candidateMetricScope, scope: 'promotion_gate' }),
        gateMetric('sector_samples', 'Offline candidate PIT sector-alpha samples', fusion?.sector_samples, Math.max(1, finite(fusion?.min_sector_samples, 300)), 'rows', 'gte', { ...candidateMetricScope, scope: 'lifecycle', note: 'Fusion v14 不以此欄作獨立 serving blocker；它顯示 candidate 是否取得 sector feature coverage。' }),
        gateMetric('sector_dates', 'Offline candidate PIT sector-alpha dates', fusion?.sector_dates, Math.max(1, finite(fusion?.min_sector_dates, 8)), 'dates', 'gte', { ...candidateMetricScope, scope: 'lifecycle' }),
        metric('sector_source_signal_dates', '目前可供後續 cohort 使用的 PIT sector signal dates', sectorReadiness?.signal_dates ?? null, { unit: 'dates', scope: 'lifecycle', note: `合法 prior-session source window：${sectorReadiness?.first_signal_date ?? '尚無'} → ${sectorReadiness?.latest_signal_date ?? '尚無'}。這是 source readiness，不是舊 candidate 的 promotion evidence。` }),
        gateMetric('residual_corr_lcb90', 'Residual adjustment corr LCB90', fusion?.residual_corr_lcb90, 0, 'ratio', 'gt', { ...candidateMetricScope, scope: 'promotion_gate' }),
        gateMetric('residual_spread_lcb90', 'Residual adjustment spread LCB90', fusion?.residual_spread_lcb90, 0, 'return', 'gt', { ...candidateMetricScope, scope: 'promotion_gate' }),
        metric('walk_forward', 'Offline candidate residual walk-forward', fusion?.walk_forward_passed, { target: true, comparator: 'eq', unit: 'status', passed: fusion?.walk_forward_passed ?? null, ...candidateMetricScope, scope: 'promotion_gate' }),
        metric('selection_corr_lcb90', 'Selection diagnostic corr LCB90', fusion?.selection_corr_lcb90, { unit: 'ratio', ...candidateMetricScope, scope: 'diagnostic', note: 'Reported for diagnosis only; the v14 serving head is residual_adjustment_model.' }),
        metric('selection_spread_lcb90', 'Selection diagnostic spread LCB90', fusion?.selection_spread_lcb90, { unit: 'return', ...candidateMetricScope, scope: 'diagnostic', note: 'Reported for diagnosis only; the v14 serving head is residual_adjustment_model.' }),
        metric('champion_corr_delta', 'Selection diagnostic corr delta vs canonical L4 LCB90', fusion?.fusion_corr_delta_lcb90, { unit: 'ratio', ...candidateMetricScope, scope: 'diagnostic', note: 'Not a v14 serving gate.' }),
        metric('champion_spread_delta', 'Selection diagnostic spread delta vs canonical L4 LCB90', fusion?.fusion_spread_delta_lcb90, { unit: 'return', ...candidateMetricScope, scope: 'diagnostic', note: 'Not a v14 serving gate.' }),
        gateMetric('top_trade_ev_lcb90', 'Offline candidate final top trade EV LCB90', fusion?.fusion_top_trade_ev_lcb90, 0, 'return', 'gt', { ...candidateMetricScope, scope: 'diagnostic', note: '此為 final trade EV 診斷，不是 Fusion v14 residual serving gate。' }),
        metric('final_champion_comparison', 'Offline candidate final trade EV paired comparison', fusion?.fusion_final_comparison_reason ? null : fusion?.fusion_final_comparison_decision, {
          unit: 'status',
          passed: fusion?.fusion_final_comparison_reason ? null : fusion?.fusion_final_comparison_decision == null ? null : fusion.fusion_final_comparison_decision === 'PASS',
          ...candidateMetricScope,
          scope: 'diagnostic',
          availability: fusion?.fusion_final_comparison_reason ? 'not_applicable' : candidateMetricScope.availability,
          reason_code: fusion?.fusion_final_comparison_reason ?? candidateMetricScope.reason_code,
          note: fusion?.fusion_final_comparison_reason ?? (optionalFinite(fusion?.fusion_final_comparison_samples) != null && optionalFinite(fusion?.fusion_final_comparison_dates) != null ? `${optionalFinite(fusion?.fusion_final_comparison_samples)}/paired rows across ${optionalFinite(fusion?.fusion_final_comparison_dates)} dates.` : 'Paired comparison evidence unavailable.'),
        }),
        metric('execution_expert', 'Shadow diagnostic conditional execution expert', fusion?.execution_decision, { unit: 'status', scope: 'diagnostic', passed: null, availability: fusion?.execution_decision == null ? 'not_applicable' : 'available', reason_code: fusion?.execution_decision == null ? 'diagnostic_not_served_by_fusion_v14' : null, note: 'Diagnostic only; not served by Fusion v14.' }),
        metric('execution_probability', 'Shadow diagnostic execution probability expert', fusion?.execution_probability_decision, { unit: 'status', scope: 'diagnostic', passed: null, availability: fusion?.execution_probability_decision == null ? 'not_applicable' : 'available', reason_code: fusion?.execution_probability_decision == null ? 'diagnostic_not_served_by_fusion_v14' : null, note: 'Diagnostic only; not served by Fusion v14.' }),
        gateMetric('shadow_sector_samples', 'Latest shadow PIT sector-alpha samples', fusionShadow?.sector_samples, Math.max(1, finite(fusion?.min_sector_samples, 300)), 'rows', 'gte', { ...shadowMetricScope, scope: 'monitoring' }),
        gateMetric('shadow_sector_dates', 'Latest shadow PIT sector-alpha dates', fusionShadow?.sector_dates, Math.max(1, finite(fusion?.min_sector_dates, 8)), 'dates', 'gte', { ...shadowMetricScope, scope: 'monitoring' }),
        gateMetric('shadow_residual_corr_lcb90', 'Latest shadow residual corr LCB90', fusionShadow?.residual_corr_lcb90, 0, 'ratio', 'gt', { ...shadowMetricScope, scope: 'monitoring' }),
        gateMetric('shadow_residual_spread_lcb90', 'Latest shadow residual spread LCB90', fusionShadow?.residual_spread_lcb90, 0, 'return', 'gt', { ...shadowMetricScope, scope: 'monitoring' }),
        metric('shadow_walk_forward', 'Latest shadow residual walk-forward', fusionShadow?.walk_forward_passed, { target: true, comparator: 'eq', unit: 'status', passed: fusionShadow?.walk_forward_passed ?? null, ...shadowMetricScope, scope: 'monitoring' }),
        metric('frozen_forward_quality', 'Active-8 cohort causal shadow quality', fusionShadow?.quality_decision ?? null, { target: 'PASS', comparator: 'eq', unit: 'status', passed: fusionShadow == null ? null : fusionShadow.quality_decision === 'PASS', ...shadowMetricScope, scope: 'monitoring' }),
        metric('frozen_forward_dates', 'Active-8 cohort causal shadow dates', fusionShadow?.oof_date_count ?? null, { unit: 'dates', ...shadowMetricScope, scope: 'monitoring', note: 'Rebuilds causal validation on a fixed Active-8 cohort; it is not the production serving artifact.' }),
        metric('serving_forward_guard_state', 'Actual serving artifact T+5 guard', runtimeGuardBound ? runtimeGuard?.state ?? null : runtimeGuard ? 'IDENTITY_MISMATCH' : null, { unit: 'status', passed: runtimeGuardBound ? runtimeGuard?.state !== 'residual_bypass' : null, ...runtimeGuardMetricScope, scope: 'production', note: 'Bound by artifact ID and model fingerprint; it can only bypass the Fusion residual back to canonical L4.' }),
        metric('serving_forward_evaluable_dates', 'Serving-forward evaluable dates', runtimeGuardBound ? runtimeGuard?.evaluable_date_count ?? 0 : null, { unit: 'dates', ...runtimeGuardMetricScope, scope: 'production' }),
        metric('serving_forward_degraded_streak', 'Serving-forward degraded streak', runtimeGuardBound ? runtimeGuard?.degraded_streak ?? 0 : null, { unit: 'dates', target: 3, comparator: 'lt', passed: runtimeGuardBound ? (runtimeGuard?.degraded_streak ?? 0) < 3 : null, ...runtimeGuardMetricScope, scope: 'production' }),
        metric('serving_forward_recovery_streak', 'Serving-forward recovery streak', runtimeGuardBound ? runtimeGuard?.recovery_streak ?? 0 : null, { unit: 'dates', ...runtimeGuardMetricScope, scope: 'production' }),
      ],
      lineage: {
        requested_date: requestedDate,
        evidence_date: fusion?.source_run_date ?? null,
        artifact_id: fusion?.artifact_id ?? null,
        model_version: fusion?.version ?? null,
        cadence: fusion?.cadence ?? 'unknown',
        role: 'candidate',
        date_semantic: 'candidate_cutoff',
        oof_unavailable_reason: fusion?.fusion_oof_max_date ? null : !fusion ? 'offline_candidate_missing' : !fusion.identity_valid ? fusion.identity_blockers[0] ?? 'candidate_identity_invalid' : 'candidate_oof_max_not_published',
        source: 'offline candidate; production pointer and frozen-forward shadow are separate evidence scopes',
        oof_max_date: fusion?.fusion_oof_max_date ?? null,
        oof_applicable: true,
        evidence_semantics: 'Fusion v14 residual-adjustment candidate uses purged OOF evidence; monitoring shadow is never promotion evidence.',
        updated_at: fusion?.updated_at ?? null,
        evidence_scopes: {
          offline_candidate: {
            cadence: fusion?.cadence ?? 'unknown',
            role: 'candidate',
            date_semantic: 'candidate_cutoff',
            availability: !fusion ? 'missing' : fusion.identity_valid ? 'available' : 'blocked',
            reason_code: !fusion ? 'offline_candidate_missing' : fusion.identity_valid ? null : fusion.identity_blockers[0] ?? 'candidate_identity_invalid',
            identity_assurance: fusion?.identity_assurance ?? null,
            identity_schema_version: fusion?.identity_schema_version ?? null,
            artifact_id: fusion?.artifact_id ?? null,
            model_version: fusion?.version ?? null,
            artifact_contract_version: fusion?.artifact_contract_version ?? null,
            artifact_path: fusion?.artifact_path ?? null,
            artifact_checksum: fusion?.checksum ?? null,
            identity_valid: fusion?.identity_valid ?? false,
            identity_blockers: fusion?.identity_blockers ?? ['offline_candidate_missing'],
            validation_schema_version: fusion?.validation_schema_version ?? null,
            source_run_date: fusion?.source_run_date ?? null,
            oof_max_date: fusion?.fusion_oof_max_date ?? null,
            updated_at: fusion?.updated_at ?? null,
          },
          serving_pointer: {
            cadence: 'event-driven',
            role: 'serving',
            date_semantic: 'current_pointer_effective_at',
            availability: servingPointerScope(fusionServing).availability,
            reason_code: servingPointerScope(fusionServing).reason_code,
            artifact_state: fusionServing?.artifact_state ?? null,
            observed_at: servingState?.evaluated_at ?? null,
            artifact_id: fusionServing?.artifact_id ?? null,
            model_version: fusionServing?.model_version ?? null,
            artifact_contract_version: fusionServing?.artifact_contract_version ?? null,
            serving_mode: fusionServing?.serving_mode ?? null,
            updated_at: fusionServing?.pointer_updated_at ?? null,
          },
          ...(runtimeGuard ? {
            runtime_guard: {
              cadence: 'daily',
              role: 'runtime_guard',
              date_semantic: 'latest_prediction_date',
              availability: runtimeGuardBound ? 'available' : 'blocked',
              reason_code: runtimeGuardBound ? null : 'runtime_guard_identity_mismatch',
              artifact_id: runtimeGuard.artifact_id,
              model_fingerprint: runtimeGuard.model_fingerprint,
              model_version: runtimeGuard.model_version,
              state: runtimeGuard.state,
              evaluable_date_count: runtimeGuard.evaluable_date_count,
              degraded_streak: runtimeGuard.degraded_streak,
              recovery_streak: runtimeGuard.recovery_streak,
              last_prediction_date: runtimeGuard.last_prediction_date,
              lineage_bound: runtimeGuardBound,
            },
          } : {}),
          frozen_forward: {
            cadence: 'daily',
            role: 'monitoring',
            date_semantic: 'monitoring_business_date',
            availability: shadowMetricScope.availability,
            reason_code: shadowMetricScope.reason_code,
            evaluation_id: fusionShadowPacket?.evaluation_id ?? null,
            cohort_id: fusionShadowPacket?.cohort_id ?? null,
            model_version: fusionShadowPacket?.model_version ?? null,
            validation_schema_version: fusionShadowPacket?.validation_schema_version ?? null,
            identity_schema_version: fusionShadowPacket?.identity_schema_version ?? null,
            subject_artifact_checksum: fusionShadowPacket?.subject_artifact_checksum ?? null,
            evaluator_contract_checksum: fusionShadowPacket?.evaluator_contract_checksum ?? null,
            artifact_path: fusionShadowPacket?.artifact_path ?? null,
            artifact_checksum: fusionShadowPacket?.artifact_checksum ?? null,
            identity_blockers: fusionShadowPacket?.identity_blockers ?? ['frozen_forward_packet_missing'],
            identity_valid: fusionShadowPacket?.identity_valid ?? false,
            business_date: fusionShadowPacket?.business_date ?? null,
            oof_max_date: fusionShadowPacket?.oof_max_date ?? null,
            updated_at: fusionShadowPacket?.updated_at ?? null,
          },
        },
      },
    })
  }

  const [thresholdHistory, redundancyHistory, routeHistory, l4History, fusionHistory] = await Promise.all([
    safeQuery(() => learningDb.prepare(`
      WITH recent_dates AS (
        SELECT signal_date
          FROM strategy_label_matrix_runs_v4
         WHERE signal_date <= ? AND status = 'ready'
           AND labeler_version IN (?, ?)
         GROUP BY signal_date
         ORDER BY signal_date DESC
         LIMIT 7
      ), ranked_runs AS (
        SELECT producer_run_id, signal_date, labeler_version,
               ROW_NUMBER() OVER (PARTITION BY signal_date ORDER BY updated_at DESC, producer_run_id DESC) ordinal
          FROM strategy_label_matrix_runs_v4 runs
          JOIN recent_dates USING (signal_date)
         WHERE runs.status = 'ready'
           AND runs.labeler_version IN (?, ?)
      )
      SELECT run.signal_date evidence_date,
             SUM(CASE WHEN matrix.evaluable=1 AND matrix.strategy_hit=1
                       AND matrix.affinity_evidence_count>0
                       AND matrix.challenger_affinity_version=? THEN 1 ELSE 0 END) value,
             SUM(CASE WHEN matrix.evaluable=1 AND matrix.strategy_hit=1 THEN 1 ELSE 0 END) target
        FROM ranked_runs run
        JOIN strategy_label_matrix_v4 matrix
          ON matrix.producer_run_id=run.producer_run_id
         AND matrix.labeler_version=run.labeler_version
       WHERE run.ordinal=1
       GROUP BY run.signal_date
       ORDER BY run.signal_date DESC
       LIMIT 7
    `).bind(
      requestedDate,
      STRATEGY_FORMAL_LABELER_VERSION,
      STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
      STRATEGY_FORMAL_LABELER_VERSION,
      STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
      STRATEGY_ROUTE_CHALLENGER_VERSION,
    ).all<{ evidence_date: string; value: number | null; target: number | null }>().then((result) => result.results ?? [])),
    safeQuery(() => learningDb.prepare(`
      WITH ranked AS (
        SELECT as_of_date, paired_date_count, graph_json,
               ROW_NUMBER() OVER (
                 PARTITION BY as_of_date
                 ORDER BY created_at DESC, artifact_id DESC
               ) ordinal
          FROM strategy_redundancy_artifacts_v1
         WHERE as_of_date <= ?
      )
      SELECT as_of_date evidence_date, paired_date_count value,
             json_extract(graph_json, '$.paired_date_requirement') target
        FROM ranked
       WHERE ordinal=1
       ORDER BY as_of_date DESC
       LIMIT 7
    `).bind(requestedDate).all<{ evidence_date: string; value: number | null; target: number | null }>().then((result) => result.results ?? [])),
    safeQuery(() => learningDb.prepare(`
      SELECT as_of_date evidence_date, date_count value, ? target
        FROM strategy_route_calibration_runs_v1
       WHERE as_of_date <= ? AND sample_count>0 AND date_count>0
       ORDER BY as_of_date DESC, created_at DESC
       LIMIT 7
    `).bind(STRATEGY_ROUTE_MIN_TOTAL_DATES, requestedDate).all<{ evidence_date: string; value: number | null; target: number | null }>().then((result) => result.results ?? [])),
    safeQuery(() => learningDb.prepare(`
      WITH ranked AS (
        SELECT model_name, artifact_id, version, candidate_type, training_run_id,
               checksum, artifact_path, state, source_run_date,
               offline_gate_decision, offline_gate_failed_gates,
               live_gate_status, updated_at, offline_evidence_json,
               ROW_NUMBER() OVER (
                 PARTITION BY source_run_date
                 ORDER BY updated_at DESC, artifact_id DESC
               ) ordinal
          FROM model_artifact_registry
         WHERE model_name='l4_alpha_ev'
           AND candidate_type='l4_alpha_ev_refresh'
           AND source_run_date <= ?
      )
      SELECT model_name, artifact_id, version, candidate_type, training_run_id,
             checksum, artifact_path, state, source_run_date,
             offline_gate_decision, offline_gate_failed_gates,
             live_gate_status, updated_at, offline_evidence_json
        FROM ranked
       WHERE ordinal=1
       ORDER BY source_run_date DESC
       LIMIT 7
    `).bind(requestedDate).all<ExpectedReturnCandidateDbRow>().then((result) =>
      (result.results ?? []).map((row) => {
        const evidence = adaptExpectedReturnCandidate(row)
        return {
          evidence_date: evidence.source_run_date ?? '',
          value: evidence.l4_corr_lcb90,
          target: 0,
          artifact_contract_version: evidence.artifact_contract_version,
          identity_valid: evidence.identity_valid,
        }
      }))),
    safeQuery(() => learningDb.prepare(`
      WITH ranked AS (
        SELECT model_name, artifact_id, version, candidate_type, training_run_id,
               checksum, artifact_path, state, source_run_date,
               offline_gate_decision, offline_gate_failed_gates,
               live_gate_status, updated_at, offline_evidence_json,
               ROW_NUMBER() OVER (
                 PARTITION BY source_run_date
                 ORDER BY updated_at DESC, artifact_id DESC
               ) ordinal
          FROM model_artifact_registry
         WHERE model_name='allocator_ev_fusion'
           AND candidate_type='allocator_ev_fusion_refresh'
           AND source_run_date <= ?
      )
      SELECT model_name, artifact_id, version, candidate_type, training_run_id,
             checksum, artifact_path, state, source_run_date,
             offline_gate_decision, offline_gate_failed_gates,
             live_gate_status, updated_at, offline_evidence_json
        FROM ranked
       WHERE ordinal=1
       ORDER BY source_run_date DESC
       LIMIT 7
    `).bind(requestedDate).all<ExpectedReturnCandidateDbRow>().then((result) =>
      (result.results ?? []).map((row) => {
        const evidence = adaptExpectedReturnCandidate(row)
        return {
          evidence_date: evidence.source_run_date ?? '',
          value: evidence.residual_spread_lcb90,
          target: 0,
          artifact_contract_version: evidence.artifact_contract_version,
          identity_valid: evidence.identity_valid,
        }
      }))),
  ])
  const historyByStage = new Map<PipelineMaturityStage['id'], {
    rows: Array<{ evidence_date: string; value: number | null; target: number | null; artifact_contract_version?: string | null; identity_valid?: boolean }>
    unit: PipelineMaturityMetric['unit']
  }>([
    ['threshold_margin_affinity_v2', { rows: thresholdHistory.value ?? [], unit: 'rows' }],
    ['oof_redundancy', { rows: redundancyHistory.value ?? [], unit: 'dates' }],
    ['route_score_v2', { rows: routeHistory.value ?? [], unit: 'dates' }],
    ['l4', { rows: l4History.value ?? [], unit: 'ratio' }],
    ['fusion', { rows: fusionHistory.value ?? [], unit: 'return' }],
  ])
  for (const stage of stages) {
    const history = historyByStage.get(stage.id)
    stage.history = (history?.rows ?? [])
      .filter((row) => validDate(String(row.evidence_date ?? '')))
      .map((row) => ({
        evidence_date: row.evidence_date,
        value: optionalFinite(row.value),
        target: optionalFinite(row.target),
        unit: history?.unit,
        artifact_contract_version: row.artifact_contract_version ?? null,
        identity_valid: row.identity_valid,
      }))
      .reverse()
  }

  const thresholdStage = stages.find((stage) => stage.id === 'threshold_margin_affinity_v2')
  const routeStage = stages.find((stage) => stage.id === 'route_score_v2')
  const currentReferenceRows = finite(referenceRow?.reference_rows)
  const currentRouteRows = finite(referenceRow?.challenger_route_rows)
  const thresholdCoverageReady = thresholdStage?.status === 'ready' || thresholdStage?.status === 'serving'
  const currentRouteCoverageComplete = currentReferenceRows > 0 && currentRouteRows === currentReferenceRows
  const routePromoted = Boolean(promotedRoute?.run_id && promotedRoute.candidate_route_version === STRATEGY_ROUTE_CHALLENGER_VERSION)
  const bundleBlockers = [...new Set([
    ...(thresholdStage?.blockers ?? []),
    ...(!currentRouteCoverageComplete ? ['current_day_challenger_route_incomplete'] : []),
    ...(routeStage?.blockers ?? []),
    ...(route?.status === 'pass' && !routePromoted ? ['joint_promotion_not_committed'] : []),
  ])]
  const strategyRouteBundle: StrategyRouteBundleMaturity = {
    version: STRATEGY_ROUTE_CHALLENGER_VERSION,
    status: routePromoted && thresholdCoverageReady && currentRouteCoverageComplete
      ? 'serving'
      : !thresholdCoverageReady || !currentRouteCoverageComplete
        ? 'blocked'
        : route?.status === 'pending_maturity'
          ? 'collecting'
          : route?.status === 'pass'
            ? 'ready'
            : route?.status === 'fail'
              ? 'failed_quality'
              : 'unavailable',
    contribution_mode: routePromoted && thresholdCoverageReady && currentRouteCoverageComplete ? 'production' : 'shadow',
    threshold_coverage_ready: thresholdCoverageReady,
    current_route_coverage_complete: currentRouteCoverageComplete,
    current_route_rows: currentRouteRows,
    current_reference_rows: currentReferenceRows,
    route_calibration_status: route?.status ?? null,
    route_mature_dates: finite(route?.date_count),
    route_required_dates: STRATEGY_ROUTE_MIN_TOTAL_DATES,
    promoted_run_id: routePromoted ? promotedRoute.run_id : null,
    blockers: bundleBlockers,
  }

  return {
    strategy_route_bundle: strategyRouteBundle,
    schema_version: 'pipeline-decision-maturity-v2',
    requested_date: requestedDate,
    generated_at: new Date().toISOString(),
    current_selection_signal_owner: servingState?.selection_signal_owner ?? 'score_v2_formal_ml',
    current_expected_return_owner: servingState?.expected_return_owner ?? null,
    current_execution_owner: servingState?.execution_owner ?? 'none_fail_closed',
    action_gate: servingState?.action_gate ?? 'canonical_l4_required',
    summary: {
      production: stages.filter((stage) => stage.contribution_mode === 'production').length,
      shadow: stages.filter((stage) => stage.contribution_mode === 'shadow').length,
      ready: stages.filter((stage) => ['serving', 'ready'].includes(stage.status)).length,
      collecting: stages.filter((stage) => stage.status === 'collecting').length,
      failed_or_blocked: stages.filter((stage) => ['failed_quality', 'blocked', 'unavailable'].includes(stage.status)).length,
    },
    stages,
  }
}
