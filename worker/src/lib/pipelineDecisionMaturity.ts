import type { Bindings } from '../types'
import { inspectAllocatorEvMaturityCoverage } from './allocatorEvDailyLifecycle'
import { databaseForDataDomain } from './dataDomainRegistry'
import { inspectExpectedReturnCandidateEvidence } from './expectedReturnCandidateEvidence'
import { readCurrentExpectedReturnServingState } from './expectedReturnServingState'
import { S12_REPLAY_ENGINE_SIGNATURE } from './s12ReplayContract'
import {
  STRATEGY_ROUTE_CHALLENGER_VERSION,
  STRATEGY_ROUTE_MIN_OOS_DATES,
  STRATEGY_ROUTE_MIN_TOTAL_DATES,
  STRATEGY_ROUTE_MIN_TRAIN_DATES,
  STRATEGY_ROUTE_PURGE_DATES,
} from './strategyRouteCalibration'

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
}

export interface PipelineMaturityStage {
  id: 'threshold_margin_affinity_v2' | 'oof_redundancy' | 'route_score_v2' | 's12' | 'l4' | 'fusion'
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
  metrics: PipelineMaturityMetric[]
  history?: Array<{
    evidence_date: string
    value: number | null
    target: number | null
    unit: PipelineMaturityMetric['unit']
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
  }
}

export interface PipelineDecisionMaturityPacket {
  schema_version: 'pipeline-decision-maturity-v1'
  requested_date: string
  generated_at: string
  current_expected_return_owner: 'l4_alpha_ev' | 'allocator_ev_fusion' | null
  action_gate: 'expected_return_owner' | 'fusion_primary_required'
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

type EvCandidateRow = {
  model_name: 'l4_alpha_ev' | 'allocator_ev_fusion'
  artifact_id: string | null
  version: string | null
  state: string | null
  source_run_date: string | null
  offline_gate_decision: string | null
  offline_gate_failed_gates: string | null
  live_gate_status: string | null
  updated_at: string | null
  sample_count: number | string | null
  date_count: number | string | null
  fit_min_samples: number | string | null
  fit_min_dates: number | string | null
  sector_samples: number | string | null
  sector_dates: number | string | null
  min_sector_samples: number | string | null
  min_sector_dates: number | string | null
  l4_samples: number | string | null
  l4_dates: number | string | null
  structure_samples: number | string | null
  structure_dates: number | string | null
  execution_samples: number | string | null
  execution_dates: number | string | null
  market_samples: number | string | null
  market_dates: number | string | null
  min_primary_samples: number | string | null
  min_primary_dates: number | string | null
  min_l4_samples: number | string | null
  min_l4_dates: number | string | null
  min_structure_samples: number | string | null
  min_structure_dates: number | string | null
  min_execution_samples: number | string | null
  min_execution_dates: number | string | null
  min_market_samples: number | string | null
  min_market_dates: number | string | null
  l4_corr_lcb90: number | string | null
  l4_spread_lcb90: number | string | null
  l4_top_return: number | string | null
  l4_top_lcb90: number | string | null
  selection_corr_lcb90: number | string | null
  selection_spread_lcb90: number | string | null
  fusion_corr_delta_lcb90: number | string | null
  fusion_spread_delta_lcb90: number | string | null
  fusion_top_trade_ev_lcb90: number | string | null
  fusion_oof_max_date: string | null
  fusion_final_comparison_decision: string | null
  fusion_final_comparison_samples: number | string | null
  fusion_final_comparison_dates: number | string | null
  walk_forward_passed: number | boolean | null
  execution_decision: string | null
  execution_probability_decision: string | null
  promotion_tier: string | null
}

type EvShadowEvaluationRow = {
  model_name: 'l4_alpha_ev' | 'allocator_ev_fusion'
  evaluation_id: string
  business_date: string
  model_version: string
  oof_max_date: string
  oof_date_count: number | string
  oof_row_count: number | string
  quality_decision: string
  policy_decision: string
  updated_at: string | null
  l4_corr_lcb90: number | string | null
  fusion_spread_delta_lcb90: number | string | null
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
  const required = finite(requiredInput)
  if (required <= 0) return null
  const current = Math.max(0, finite(currentInput))
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
): PipelineMaturityMetric {
  const current = optionalFinite(value)
  return metric(key, label, current, {
    target,
    comparator,
    unit,
    passed: current == null ? null : comparator === 'gte' ? current >= target : current > target,
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
  dateCount: number,
  minDates: number,
): PipelineMaturityStatus {
  if (servingState === 'serving') return 'serving'
  if (String(decision ?? '').toUpperCase() === 'FAIL' && dateCount >= minDates) return 'failed_quality'
  if (dateCount < minDates) return 'collecting'
  return 'blocked'
}

function contributionModeForServing(state: string | undefined): PipelineContributionMode {
  if (state === 'serving') return 'production'
  return 'shadow'
}

export async function buildPipelineDecisionMaturityPacket(
  env: Bindings,
  requestedDate: string,
): Promise<PipelineDecisionMaturityPacket> {
  if (!validDate(requestedDate)) throw new Error(`invalid_pipeline_maturity_date:${requestedDate}`)
  const learningDb = databaseForDataDomain(env, 'learning')
  const replayStart = new Date(`${requestedDate}T00:00:00.000Z`)
  replayStart.setUTCDate(replayStart.getUTCDate() - 90)
  const replayStartDate = replayStart.toISOString().slice(0, 10)

  const canonicalHead = await safeQuery(() => env.DB.prepare(`
    SELECT substr(logical_run_key, 10, 10) signal_date, run_id
      FROM canonical_run_heads
     WHERE logical_run_key LIKE 'screener:%:TW:production:market_screener'
       AND substr(logical_run_key, 10, 10) <= ?
     ORDER BY substr(logical_run_key, 10, 10) DESC, updated_at DESC
     LIMIT 1
  `).bind(requestedDate).first<CanonicalHead>())
  const head = canonicalHead.value

  const [reference, matrix, redundancy, routeRun, routeHead, s12Run, s12Artifact, s12Approved, s12Evidence, s12Structure, evRows, evShadowRows, serving, candidateReport, l4Maturity] = await Promise.all([
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
    `).bind(STRATEGY_ROUTE_CHALLENGER_VERSION, STRATEGY_ROUTE_CHALLENGER_VERSION, head.signal_date, head.run_id).first<any>() : Promise.resolve(null)),
    safeQuery(() => head ? learningDb.prepare(`
      SELECT r.status, r.reference_candidate_count, r.strategy_count,
             r.expected_cell_count, r.persisted_cell_count,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.evaluable=1 AND m.strategy_hit=1) matched_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.evaluable=1 AND m.strategy_hit=1
                 AND m.affinity_evidence_count>0 AND m.challenger_affinity_version=?) threshold_rows,
             r.updated_at
        FROM strategy_label_matrix_runs_v4 r
       WHERE r.signal_date=? AND r.producer_run_id=?
       LIMIT 1
    `).bind(STRATEGY_ROUTE_CHALLENGER_VERSION, head.signal_date, head.run_id).first<any>() : Promise.resolve(null)),
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
       WHERE as_of_date<=?
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
      SELECT run_id, run_date, cadence, status, scopes_seen,
             artifacts_written, summary_json, created_at
        FROM s12_tw_calibration_runs
       WHERE run_date<=?
       ORDER BY run_date DESC, created_at DESC
       LIMIT 1
    `).bind(requestedDate).first<any>()),
    safeQuery(() => learningDb.prepare(`
      SELECT artifact_id, run_id, status, cadence, market_segment, entry_cohort,
             alpha_bucket, entry_time_bucket, validation_start, validation_end,
             sample_count, date_count, metrics_json, approved_at, created_at
        FROM s12_tw_calibration_artifacts
       WHERE validation_end<=? AND superseded_at IS NULL
       ORDER BY validation_end DESC, sample_count DESC, created_at DESC
       LIMIT 1
    `).bind(requestedDate).first<any>()),
    safeQuery(() => learningDb.prepare(`
      SELECT COUNT(*) artifact_count, MAX(validation_end) validation_end,
             MAX(sample_count) sample_count, MAX(date_count) date_count,
             MAX(approved_at) approved_at
        FROM s12_tw_calibration_artifacts
       WHERE status='approved' AND superseded_at IS NULL AND validation_end<?
         AND json_extract(metrics_json, '$.return_basis')='net_after_roundtrip_cost'
         AND json_extract(metrics_json, '$.return_unit')='r_multiple'
         AND CAST(json_extract(metrics_json, '$.roundtrip_cost_bps') AS REAL)=18
    `).bind(requestedDate).first<any>()),
    safeQuery(() => learningDb.prepare(`
      SELECT assessment_state, COALESCE(NULLIF(TRIM(market), ''), 'UNKNOWN') market_segment,
             COUNT(*) sample_count, COUNT(DISTINCT trade_date) date_count,
             MAX(trade_date) max_date
        FROM s12_replay_trade_outcomes
       WHERE trade_date BETWEEN ? AND ?
         AND sample_eligible=1 AND trade_pnl_r IS NOT NULL
         AND assessment_state IN ('reaction_ready', 'limited_takeover_ready')
         AND json_extract(detail_json, '$.replay_diagnostics.replay_engine_signature')=?
         AND json_extract(detail_json, '$.replay_diagnostics.replay_cohort_signature') IS NOT NULL
       GROUP BY assessment_state, COALESCE(NULLIF(TRIM(market), ''), 'UNKNOWN')
       ORDER BY date_count DESC, sample_count DESC
       LIMIT 1
    `).bind(replayStartDate, requestedDate, S12_REPLAY_ENGINE_SIGNATURE).first<any>()),
    safeQuery(() => learningDb.prepare(`
      WITH latest AS (
        SELECT symbol, state, ready, invalidated, detail,
               ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY updated_at DESC, source ASC) ordinal
          FROM s12_structure_snapshots
         WHERE trade_date=? AND source LIKE 's12_candidate_snapshot%'
      )
      SELECT COUNT(*) total_rows,
             SUM(CASE WHEN ready=1 THEN 1 ELSE 0 END) ready_rows,
             SUM(CASE WHEN ready=0 AND invalidated=0 AND state NOT LIKE 'unavailable%' THEN 1 ELSE 0 END) setup_rows,
             SUM(CASE WHEN invalidated=1 THEN 1 ELSE 0 END) invalidated_rows,
             SUM(CASE WHEN state LIKE 'unavailable%' THEN 1 ELSE 0 END) unavailable_rows
        FROM latest WHERE ordinal=1
    `).bind(requestedDate).first<any>()),
    safeQuery(() => learningDb.prepare(`
      WITH ranked AS (
        SELECT model_name, artifact_id, version, state, source_run_date,
               offline_gate_decision, offline_gate_failed_gates,
               live_gate_status, updated_at, offline_evidence_json,
               ROW_NUMBER() OVER (PARTITION BY model_name ORDER BY updated_at DESC, artifact_id DESC) ordinal
          FROM model_artifact_registry
         WHERE model_name IN ('l4_alpha_ev', 'allocator_ev_fusion')
           AND candidate_type IN ('l4_alpha_ev_refresh', 'allocator_ev_fusion_refresh')
           AND COALESCE(source_run_date, '')<=?
      )
      SELECT model_name, artifact_id, version, state, source_run_date,
             offline_gate_decision, offline_gate_failed_gates, live_gate_status, updated_at,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.sample_count') sample_count,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.date_count') date_count,
             json_extract(offline_evidence_json, '$.validation_packet.validation_scope.fit_min_samples') fit_min_samples,
             json_extract(offline_evidence_json, '$.validation_packet.validation_scope.fit_min_dates') fit_min_dates,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.sector_alpha_available_count') sector_samples,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.sector_alpha_available_date_count') sector_dates,
             json_extract(offline_evidence_json, '$.validation_packet.validation_scope.min_sector_alpha_samples') min_sector_samples,
             json_extract(offline_evidence_json, '$.validation_packet.validation_scope.min_sector_alpha_dates') min_sector_dates,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.l4_available_count') l4_samples,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.l4_available_date_count') l4_dates,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.s12_structure_available_count') structure_samples,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.s12_structure_available_date_count') structure_dates,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.execution_sample_count') execution_samples,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.execution_date_count') execution_dates,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.market_context_available_count') market_samples,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.market_context_available_date_count') market_dates,
             json_extract(offline_evidence_json, '$.validation_packet.promotion.primary_requirements.min_samples') min_primary_samples,
             json_extract(offline_evidence_json, '$.validation_packet.promotion.primary_requirements.min_dates') min_primary_dates,
             json_extract(offline_evidence_json, '$.validation_packet.promotion.primary_requirements.min_l4_point_in_time_samples') min_l4_samples,
             json_extract(offline_evidence_json, '$.validation_packet.promotion.primary_requirements.min_l4_point_in_time_dates') min_l4_dates,
             json_extract(offline_evidence_json, '$.validation_packet.promotion.primary_requirements.min_s12_structure_samples') min_structure_samples,
             json_extract(offline_evidence_json, '$.validation_packet.promotion.primary_requirements.min_s12_structure_dates') min_structure_dates,
             json_extract(offline_evidence_json, '$.validation_packet.promotion.primary_requirements.min_execution_samples') min_execution_samples,
             json_extract(offline_evidence_json, '$.validation_packet.promotion.primary_requirements.min_execution_dates') min_execution_dates,
             json_extract(offline_evidence_json, '$.validation_packet.promotion.primary_requirements.min_market_context_samples') min_market_samples,
             json_extract(offline_evidence_json, '$.validation_packet.promotion.primary_requirements.min_market_context_dates') min_market_dates,
             json_extract(offline_evidence_json, '$.validation_packet.oos_metrics.date_mean_cross_section_corr_lcb90') l4_corr_lcb90,
             json_extract(offline_evidence_json, '$.validation_packet.oos_metrics.date_mean_top_bottom_spread_lcb90') l4_spread_lcb90,
             json_extract(offline_evidence_json, '$.validation_packet.oos_metrics.top_quintile_mean_return') l4_top_return,
             json_extract(offline_evidence_json, '$.validation_packet.oos_metrics.date_mean_top_quintile_return_lcb90') l4_top_lcb90,
             json_extract(offline_evidence_json, '$.validation_packet.oos_metrics.prediction_target_corr_lcb90') selection_corr_lcb90,
             json_extract(offline_evidence_json, '$.validation_packet.oos_metrics.top_bottom_spread_lcb90') selection_spread_lcb90,
             json_extract(offline_evidence_json, '$.validation_packet.selection_champion_comparison.corr_delta_lcb90') fusion_corr_delta_lcb90,
             json_extract(offline_evidence_json, '$.validation_packet.selection_champion_comparison.spread_delta_lcb90') fusion_spread_delta_lcb90,
             json_extract(offline_evidence_json, '$.validation_packet.champion_comparison.top_trade_ev_lcb90') fusion_top_trade_ev_lcb90,
             json_extract(offline_evidence_json, '$.validation_packet.sample_audit.oof_max_date') fusion_oof_max_date,
             json_extract(offline_evidence_json, '$.validation_packet.champion_comparison.decision') fusion_final_comparison_decision,
             json_extract(offline_evidence_json, '$.validation_packet.champion_comparison.sample_count') fusion_final_comparison_samples,
             json_extract(offline_evidence_json, '$.validation_packet.champion_comparison.oos_date_count') fusion_final_comparison_dates,
             json_extract(offline_evidence_json, '$.validation_packet.walk_forward.passed') walk_forward_passed,
             json_extract(offline_evidence_json, '$.validation_packet.execution_model.decision') execution_decision,
             json_extract(offline_evidence_json, '$.validation_packet.execution_probability_model.decision') execution_probability_decision,
             json_extract(offline_evidence_json, '$.validation_packet.promotion.tier') promotion_tier
        FROM ranked WHERE ordinal=1
    `).bind(requestedDate).all<EvCandidateRow>().then((result) => result.results ?? [])),
    safeQuery(() => learningDb.prepare(`
      WITH ranked AS (
        SELECT evaluation_id, business_date, model_name, model_version,
               oof_max_date, oof_date_count, oof_row_count,
               quality_decision, policy_decision, validation_packet_json, updated_at,
               ROW_NUMBER() OVER (
                 PARTITION BY model_name
                 ORDER BY business_date DESC, oof_max_date DESC, updated_at DESC, evaluation_id DESC
               ) ordinal
          FROM expected_return_shadow_evaluation_packets
         WHERE business_date <= ?
           AND policy_decision = 'shadow_only'
      )
      SELECT evaluation_id, business_date, model_name, model_version,
             oof_max_date, oof_date_count, oof_row_count,
             quality_decision, policy_decision, updated_at,
             json_extract(validation_packet_json, '$.oos_metrics.date_mean_cross_section_corr_lcb90') l4_corr_lcb90,
             json_extract(validation_packet_json, '$.selection_champion_comparison.spread_delta_lcb90') fusion_spread_delta_lcb90
        FROM ranked WHERE ordinal=1
    `).bind(requestedDate).all<EvShadowEvaluationRow>().then((result) => result.results ?? [])),
    safeQuery(() => readCurrentExpectedReturnServingState({ ...env, DB: learningDb }, requestedDate)),
    safeQuery(() => inspectExpectedReturnCandidateEvidence(learningDb)),
    safeQuery(() => inspectAllocatorEvMaturityCoverage(learningDb, requestedDate)),
  ])

  const stages: PipelineMaturityStage[] = []
  const referenceRow = reference.value
  const matrixRow = matrix.value
  if (!head || !referenceRow || !matrixRow) {
    stages.push(unavailableStage(
      'threshold_margin_affinity_v2', 'L1', 'Threshold-margin affinity V2', requestedDate,
      'selection_reference_snapshots_v1 + strategy_label_matrix_v4',
      [canonicalHead.error, reference.error, matrix.error, !head ? 'canonical_run_head_missing' : null],
    ))
  } else {
    const matched = finite(matrixRow.matched_rows)
    const covered = finite(matrixRow.threshold_rows)
    const complete = matched > 0 && covered === matched
    stages.push({
      id: 'threshold_margin_affinity_v2',
      layer: 'L1',
      title: 'Threshold-margin affinity V2',
      version: STRATEGY_ROUTE_CHALLENGER_VERSION,
      status: complete ? 'ready' : 'blocked',
      contribution_mode: 'shadow',
      maturity_kind: 'daily_coverage',
      progress: maturityProgress(covered, matched, 'rows'),
      decision: complete
        ? `當日 ${covered}/${matched} 筆策略命中都有自己的 threshold margin evidence。`
        : `當日只有 ${covered}/${matched} 筆策略命中具備 threshold margin evidence。`,
      contribution: '用各策略自己的門檻距離與 signal strength 產生 challenger affinity，避免所有策略共用同一份 raw quality。',
      production_effect: '目前只餵給 challenger route；不直接改變 incumbent route、L4 或 BUY/HOLD。',
      blockers: complete ? [] : ['threshold_margin_evidence_incomplete'],
      metrics: [
        gateMetric('threshold_rows', 'Threshold evidence', covered, matched, 'rows'),
        gateMetric('reference_rows', 'Reference universe', referenceRow.reference_rows, referenceRow.reference_rows, 'rows'),
        metric('strategy_count', 'Strategy count', matrixRow.strategy_count, { unit: 'count' }),
        metric('matrix_cells', 'PIT matrix cells', matrixRow.persisted_cell_count, { target: matrixRow.expected_cell_count, comparator: 'eq', unit: 'rows', passed: finite(matrixRow.persisted_cell_count) === finite(matrixRow.expected_cell_count) }),
        metric('challenger_route_rows', 'Challenger scored symbols', referenceRow.challenger_route_rows, { target: referenceRow.reference_rows, comparator: 'eq', unit: 'rows', passed: finite(referenceRow.challenger_route_rows) === finite(referenceRow.reference_rows) }),
      ],
      lineage: {
        requested_date: requestedDate,
        evidence_date: head.signal_date,
        oof_applicable: false,
        evidence_semantics: 'Daily canonical decision-universe coverage; this is not cumulative and not OOF.',
        artifact_id: head.run_id,
        source: 'canonical selection reference + strategy matrix',
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
      blockers: promoted ? [] : Object.entries(gates).filter(([, passed]) => passed !== true).map(([gate]) => gate),
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

  const s12LatestRun = s12Run.value
  const s12Candidate = s12Artifact.value
  const s12Active = s12Approved.value
  const s12Raw = s12Evidence.value
  if (!s12LatestRun && !s12Candidate && !s12Raw) {
    stages.push(unavailableStage('s12', 'L3.5', 'S12 execution edge', requestedDate, 's12_replay_trade_outcomes + s12_tw_calibration_artifacts', [s12Run.error, s12Artifact.error, s12Evidence.error]))
  } else {
    const runSummary = jsonRecord(s12LatestRun?.summary_json)
    const candidateMetrics = jsonRecord(s12Candidate?.metrics_json)
    const activeCount = finite(s12Active?.artifact_count)
    const sampleCount = Math.max(finite(s12Candidate?.sample_count), finite(s12Raw?.sample_count))
    const dateCount = Math.max(finite(s12Candidate?.date_count), finite(s12Raw?.date_count))
    const approved = activeCount > 0
    const qualityFailed = !approved && (s12LatestRun?.status === 'frozen' || s12Candidate?.status === 'rejected')
    const status: PipelineMaturityStatus = approved ? 'serving' : qualityFailed ? 'failed_quality' : 'collecting'
    const failedGates = Array.isArray(candidateMetrics.failed_gates)
      ? candidateMetrics.failed_gates.map(String)
      : Object.keys(jsonRecord(runSummary.failed_gate_distribution))
    stages.push({
      id: 's12',
      layer: 'L3.5',
      title: 'S12 execution edge',
      version: 's12-tw-v3-calibration',
      status,
      contribution_mode: approved ? 'production' : 'shadow',
      maturity_kind: 'calibration',
      progress: maturityProgress(dateCount, 10, 'dates'),
      decision: approved
        ? `${activeCount} 個正式 calibration scope 可依結構判斷 execution readiness、停損與 TP。`
        : `樣本 ${sampleCount}/40、日期 ${dateCount}/10 已${sampleCount >= 40 && dateCount >= 10 ? '達資料門檻，但 OOS 品質未過' : '仍在累積'}。`,
      contribution: 'S12 不負責橫截面選股；它估計結構可執行性、P(execution) 與成交後條件式 net PnL。',
      production_effect: approved
        ? '正式 calibration artifact 可調整 S12 entry/stop/TP policy；每檔仍需當日 structure gate。'
        : 'S12 structure 仍可用 base policy 產生 ready/wait/invalidated evidence，但 calibration 不接手 production policy。',
      blockers: approved ? [] : failedGates.length ? failedGates : ['s12_calibration_not_approved'],
      metrics: [
        gateMetric('samples', 'Best scoped replay samples', sampleCount, 40, 'rows'),
        gateMetric('dates', 'Best scoped replay dates', dateCount, 10, 'dates'),
        gateMetric('validation_samples', 'Validation samples', candidateMetrics.validation_samples, 12, 'rows'),
        gateMetric('selected_validation_samples', 'Selected validation samples', candidateMetrics.selected_validation_samples, 10, 'rows'),
        gateMetric('validation_coverage', 'Validation coverage', candidateMetrics.validation_coverage, 0.35, 'ratio'),
        gateMetric('validation_mean_r', candidateMetrics.return_basis === 'net_after_roundtrip_cost' ? 'Selected validation mean net R' : 'Selected validation mean legacy gross R', candidateMetrics.selected_validation_mean_r, 0, 'r_multiple'),
        gateMetric('validation_hit_rate', 'Selected validation hit rate', candidateMetrics.selected_validation_hit_rate, 0.45, 'ratio'),
        metric('structure_ready', 'Today execution-ready', s12Structure.value?.ready_rows ?? null, { unit: 'count' }),
        metric('structure_setup', 'Today setup/wait', s12Structure.value?.setup_rows ?? null, { unit: 'count' }),
        metric('structure_invalidated', 'Today invalidated', s12Structure.value?.invalidated_rows ?? null, { unit: 'count' }),
        metric('structure_unavailable', 'Today unavailable', s12Structure.value?.unavailable_rows ?? null, { unit: 'count' }),
      ],
      lineage: {
        requested_date: requestedDate,
        evidence_date: s12Candidate?.validation_end ?? s12Raw?.max_date ?? s12LatestRun?.run_date ?? null,
        artifact_id: approved ? null : s12Candidate?.artifact_id ?? s12LatestRun?.run_id ?? null,
        source: 'strict S12 V3 replay + walk-forward Taiwan-equity calibration',
        oof_applicable: false,
        evidence_semantics: 'Latest completed cost-net Taiwan-equity calibration; it is not a daily OOF cutoff.',
        updated_at: s12Candidate?.created_at ?? s12LatestRun?.created_at ?? null,
      },
    })
  }

  const evCandidates = new Map((evRows.value ?? []).map((row) => [row.model_name, row]))
  const servingState = serving.value
  const candidateState = candidateReport.value?.candidates
  const maturity = l4Maturity.value
  const evShadow = new Map((evShadowRows.value ?? []).map((row) => [row.model_name, row]))

  const l4 = evCandidates.get('l4_alpha_ev')
  const l4Shadow = evShadow.get('l4_alpha_ev')
  const l4Serving = servingState?.artifacts.l4_alpha_ev
  if (!l4 && !l4Serving) {
    stages.push(unavailableStage('l4', 'L4', 'Canonical L4 alpha EV', requestedDate, 'model_artifact_registry + allocator_ev_feature_snapshots', [evRows.error, serving.error, candidateReport.error, l4Maturity.error]))
  } else {
    const minSamples = Math.max(1, finite(l4?.fit_min_samples, 500))
    const minDates = Math.max(1, finite(l4?.fit_min_dates, 20))
    const sampleCount = finite(l4?.sample_count)
    const dateCount = finite(l4?.date_count)
    const status = candidateStatus(l4Serving?.artifact_state, l4?.offline_gate_decision, dateCount, minDates)
    const blockers = [...new Set([
      ...stringArray(l4?.offline_gate_failed_gates),
      ...(l4Serving?.blockers ?? []),
    ])]
    stages.push({
      id: 'l4',
      layer: 'L4',
      title: 'Canonical L4 alpha EV',
      version: l4?.version ?? l4Serving?.model_version ?? null,
      status,
      contribution_mode: contributionModeForServing(l4Serving?.artifact_state),
      maturity_kind: 'artifact_quality',
      progress: maturityProgress(dateCount, minDates, 'dates'),
      decision: l4Serving?.artifact_state === 'serving'
        ? 'Canonical L4 是目前 production expected-return owner。'
        : `候選資料 ${sampleCount}/${minSamples} rows、${dateCount}/${minDates} dates；${String(l4?.offline_gate_decision ?? 'PENDING').toUpperCase()}。`,
      contribution: '把 Active-8、Score V2、基本面、籌碼、技術面與 PIT sector alpha 校準成五日成本後絕對報酬。',
      production_effect: l4Serving?.artifact_state === 'serving'
        ? '提供 L4 expected return，與風險/流動性 gate 一起決定 BUY/HOLD。'
        : '候選只保存 OOF evidence；不改寫 production expected return。',
      blockers,
      metrics: [
        gateMetric('samples', 'Usable OOF samples', sampleCount, minSamples, 'rows'),
        gateMetric('dates', 'Usable OOF dates', dateCount, minDates, 'dates'),
        gateMetric('sector_samples', 'PIT sector alpha samples', l4?.sector_samples, Math.max(1, finite(l4?.min_sector_samples, 300)), 'rows'),
        gateMetric('sector_dates', 'PIT sector alpha dates', l4?.sector_dates, Math.max(1, finite(l4?.min_sector_dates, 8)), 'dates'),
        gateMetric('corr_lcb90', 'Date-clustered corr LCB90', l4?.l4_corr_lcb90, 0, 'ratio', 'gt'),
        gateMetric('spread_lcb90', 'Top-bottom spread LCB90', l4?.l4_spread_lcb90, 0, 'return', 'gt'),
        gateMetric('top_return', 'Top quintile mean net return', l4?.l4_top_return, 0, 'return', 'gt'),
        gateMetric('top_lcb90', 'Top quintile return LCB90', l4?.l4_top_lcb90, 0, 'return', 'gt'),
        metric('walk_forward', 'Walk-forward stable', l4?.walk_forward_passed, { target: true, comparator: 'eq', unit: 'status', passed: l4?.walk_forward_passed == null ? null : Boolean(l4.walk_forward_passed) }),
        metric('strict_pit_rows', 'Materialized strict L4 PIT', maturity?.strictL4PitRows ?? null, { unit: 'rows' }),
        metric('strict_pit_dates', 'Materialized strict L4 PIT dates', maturity?.strictL4PitDates ?? null, { unit: 'dates' }),
        metric('frozen_forward_quality', 'Latest frozen-forward shadow quality', l4Shadow?.quality_decision ?? null, { target: 'PASS', comparator: 'eq', unit: 'status', passed: l4Shadow == null ? null : l4Shadow.quality_decision === 'PASS' }),
        metric('frozen_forward_dates', 'Latest frozen-forward shadow dates', l4Shadow?.oof_date_count ?? null, { unit: 'dates', note: 'Monitoring-only; never training or promotion evidence.' }),
      ],
      lineage: {
        requested_date: requestedDate,
        evidence_date: l4Shadow?.business_date ?? l4?.source_run_date ?? candidateState?.l4_alpha_ev.candidate_end_date ?? null,
        oof_max_date: l4Shadow?.oof_max_date ?? maturity?.indexedL4PitMaxDate ?? null,
        artifact_id: l4?.artifact_id ?? candidateState?.l4_alpha_ev.artifact_id ?? null,
        oof_applicable: true,
        evidence_semantics: 'Purged Active-8 OOF and five-session net-label cutoff.',
        model_version: l4?.version ?? l4Serving?.model_version ?? null,
        source: l4Shadow ? 'purged Active-8 OOF candidate + frozen-forward shadow evaluation packet' : 'purged Active-8 OOF + canonical five-session net labels',
        updated_at: l4Shadow?.updated_at ?? l4?.updated_at ?? candidateState?.l4_alpha_ev.updated_at ?? null,
      },
    })
  }

  const fusion = evCandidates.get('allocator_ev_fusion')
  const fusionShadow = evShadow.get('allocator_ev_fusion')
  const fusionServing = servingState?.artifacts.allocator_ev_fusion
  if (!fusion && !fusionServing) {
    stages.push(unavailableStage('fusion', 'L4+', 'Fusion final trade EV', requestedDate, 'model_artifact_registry + allocator EV snapshots', [evRows.error, serving.error, candidateReport.error]))
  } else {
    const minSamples = Math.max(1, finite(fusion?.min_primary_samples, 1500))
    const minDates = Math.max(1, finite(fusion?.min_primary_dates, 20))
    const sampleCount = finite(fusion?.sample_count)
    const dateCount = finite(fusion?.date_count)
    const status = candidateStatus(fusionServing?.artifact_state, fusion?.offline_gate_decision, dateCount, minDates)
    const blockers = [...new Set([
      ...stringArray(fusion?.offline_gate_failed_gates),
      ...(fusionServing?.blockers ?? []),
    ])]
    stages.push({
      id: 'fusion',
      layer: 'L4+',
      title: 'Fusion final trade EV',
      version: fusion?.version ?? fusionServing?.model_version ?? null,
      status,
      contribution_mode: contributionModeForServing(fusionServing?.artifact_state),
      maturity_kind: 'artifact_quality',
      progress: maturityProgress(dateCount, minDates, 'dates'),
      decision: fusionServing?.artifact_state === 'serving'
        ? 'Fusion 是 production primary expected-return owner。'
        : `候選資料 ${sampleCount}/${minSamples} rows、${dateCount}/${minDates} dates；tier ${fusion?.promotion_tier ?? 'shadow'}。`,
      contribution: '把 L4 selection alpha 與 S12 execution probability/conditional PnL 結合為 P(execution) × E(net PnL | execution)。',
      production_effect: fusionServing?.artifact_state === 'serving'
        ? '取代單獨 L4 作 final trade EV owner，再交給 allocator/OBP 做風險與部位決策。'
        : '未通過 paired champion、execution expert 與品質 gate 前維持 shadow，不能壓過 canonical L4。',
      blockers,
      metrics: [
        gateMetric('samples', 'Fusion usable samples', sampleCount, minSamples, 'rows'),
        gateMetric('dates', 'Fusion usable dates', dateCount, minDates, 'dates'),
        gateMetric('l4_samples', 'L4 PIT samples', fusion?.l4_samples, Math.max(1, finite(fusion?.min_l4_samples, 300)), 'rows'),
        gateMetric('l4_dates', 'L4 PIT dates', fusion?.l4_dates, Math.max(1, finite(fusion?.min_l4_dates, 8)), 'dates'),
        gateMetric('structure_samples', 'S12 structure samples', fusion?.structure_samples, Math.max(1, finite(fusion?.min_structure_samples, 300)), 'rows'),
        gateMetric('structure_dates', 'S12 structure dates', fusion?.structure_dates, Math.max(1, finite(fusion?.min_structure_dates, 8)), 'dates'),
        gateMetric('execution_samples', 'S12 executed samples', fusion?.execution_samples, Math.max(1, finite(fusion?.min_execution_samples, 300)), 'rows'),
        gateMetric('execution_dates', 'S12 executed dates', fusion?.execution_dates, Math.max(1, finite(fusion?.min_execution_dates, 8)), 'dates'),
        gateMetric('market_samples', 'PIT market-context samples', fusion?.market_samples, Math.max(1, finite(fusion?.min_market_samples, 300)), 'rows'),
        gateMetric('market_dates', 'PIT market-context dates', fusion?.market_dates, Math.max(1, finite(fusion?.min_market_dates, 8)), 'dates'),
        gateMetric('sector_samples', 'PIT sector-alpha samples', fusion?.sector_samples, Math.max(1, finite(fusion?.min_sector_samples, 300)), 'rows'),
        gateMetric('sector_dates', 'PIT sector-alpha dates', fusion?.sector_dates, Math.max(1, finite(fusion?.min_sector_dates, 8)), 'dates'),
        gateMetric('selection_corr_lcb90', 'Selection corr LCB90', fusion?.selection_corr_lcb90, 0, 'ratio', 'gt'),
        gateMetric('selection_spread_lcb90', 'Selection spread LCB90', fusion?.selection_spread_lcb90, 0, 'return', 'gt'),
        gateMetric('champion_corr_delta', 'Selection corr delta vs canonical L4 LCB90', fusion?.fusion_corr_delta_lcb90, 0, 'ratio', 'gte'),
        gateMetric('champion_spread_delta', 'Selection spread delta vs canonical L4 LCB90', fusion?.fusion_spread_delta_lcb90, 0, 'return', 'gte'),
        gateMetric('top_trade_ev_lcb90', 'Final top trade EV LCB90', fusion?.fusion_top_trade_ev_lcb90, 0, 'return', 'gt'),
        metric('final_champion_comparison', 'Final trade EV paired comparison', fusion?.fusion_final_comparison_decision, { unit: 'status', note: `${finite(fusion?.fusion_final_comparison_samples)}/paired rows across ${finite(fusion?.fusion_final_comparison_dates)} dates; selection comparison is reported separately.` }),
        metric('execution_expert', 'Conditional execution expert', fusion?.execution_decision, { target: 'PASS', comparator: 'eq', unit: 'status', passed: fusion?.execution_decision == null ? null : fusion.execution_decision === 'PASS' }),
        metric('execution_probability', 'Execution probability expert', fusion?.execution_probability_decision, { target: 'PASS', comparator: 'eq', unit: 'status', passed: fusion?.execution_probability_decision == null ? null : fusion.execution_probability_decision === 'PASS' }),
        metric('frozen_forward_quality', 'Latest frozen-forward shadow quality', fusionShadow?.quality_decision ?? null, { target: 'PASS', comparator: 'eq', unit: 'status', passed: fusionShadow == null ? null : fusionShadow.quality_decision === 'PASS' }),
        metric('frozen_forward_dates', 'Latest frozen-forward shadow dates', fusionShadow?.oof_date_count ?? null, { unit: 'dates', note: 'Monitoring-only; never training or promotion evidence.' }),
      ],
      lineage: {
        requested_date: requestedDate,
        evidence_date: fusionShadow?.business_date ?? fusion?.source_run_date ?? candidateState?.allocator_ev_fusion.candidate_end_date ?? null,
        artifact_id: fusion?.artifact_id ?? candidateState?.allocator_ev_fusion.artifact_id ?? null,
        model_version: fusion?.version ?? fusionServing?.model_version ?? null,
        source: fusionShadow ? 'Fusion candidate + frozen-forward shadow evaluation packet' : 'canonical L4 + strict S12 V3 replay + market/sector PIT context',
        oof_max_date: fusionShadow?.oof_max_date ?? fusion?.fusion_oof_max_date ?? null,
        oof_applicable: true,
        evidence_semantics: 'Purged OOF sample cutoff; final execution comparison can remain pending after selection comparison is available.',
        updated_at: fusionShadow?.updated_at ?? fusion?.updated_at ?? candidateState?.allocator_ev_fusion.updated_at ?? null,
      },
    })
  }

  const [thresholdHistory, redundancyHistory, routeHistory, s12History, l4History, fusionHistory] = await Promise.all([
    safeQuery(() => learningDb.prepare(`
      WITH recent_dates AS (
        SELECT signal_date
          FROM strategy_label_matrix_runs_v4
         WHERE signal_date <= ? AND status = 'ready'
         GROUP BY signal_date
         ORDER BY signal_date DESC
         LIMIT 7
      ), ranked_runs AS (
        SELECT producer_run_id, signal_date,
               ROW_NUMBER() OVER (PARTITION BY signal_date ORDER BY updated_at DESC, producer_run_id DESC) ordinal
          FROM strategy_label_matrix_runs_v4 runs
          JOIN recent_dates USING (signal_date)
         WHERE runs.status = 'ready'
      )
      SELECT run.signal_date evidence_date,
             SUM(CASE WHEN matrix.evaluable=1 AND matrix.strategy_hit=1
                       AND matrix.affinity_evidence_count>0
                       AND matrix.challenger_affinity_version=? THEN 1 ELSE 0 END) value,
             SUM(CASE WHEN matrix.evaluable=1 AND matrix.strategy_hit=1 THEN 1 ELSE 0 END) target
        FROM ranked_runs run
        JOIN strategy_label_matrix_v4 matrix ON matrix.producer_run_id=run.producer_run_id
       WHERE run.ordinal=1
       GROUP BY run.signal_date
       ORDER BY run.signal_date DESC
       LIMIT 7
    `).bind(requestedDate, STRATEGY_ROUTE_CHALLENGER_VERSION).all<{ evidence_date: string; value: number | null; target: number | null }>().then((result) => result.results ?? [])),
    safeQuery(() => learningDb.prepare(`
      SELECT as_of_date evidence_date, paired_date_count value,
             json_extract(graph_json, '$.paired_date_requirement') target
        FROM strategy_redundancy_artifacts_v1
       WHERE as_of_date <= ?
       ORDER BY as_of_date DESC, created_at DESC
       LIMIT 7
    `).bind(requestedDate).all<{ evidence_date: string; value: number | null; target: number | null }>().then((result) => result.results ?? [])),
    safeQuery(() => learningDb.prepare(`
      SELECT as_of_date evidence_date, date_count value, ? target
        FROM strategy_route_calibration_runs_v1
       WHERE as_of_date <= ?
       ORDER BY as_of_date DESC, created_at DESC
       LIMIT 7
    `).bind(STRATEGY_ROUTE_MIN_TOTAL_DATES, requestedDate).all<{ evidence_date: string; value: number | null; target: number | null }>().then((result) => result.results ?? [])),
    safeQuery(() => learningDb.prepare(`
      WITH ranked AS (
        SELECT validation_end evidence_date,
               json_extract(metrics_json, '$.selected_validation_mean_r') value,
               ROW_NUMBER() OVER (PARTITION BY validation_end ORDER BY sample_count DESC, created_at DESC) ordinal
          FROM s12_tw_calibration_artifacts
         WHERE validation_end <= ? AND superseded_at IS NULL
      )
      SELECT evidence_date, value, 0 target
        FROM ranked
       WHERE ordinal=1
       ORDER BY evidence_date DESC
       LIMIT 7
    `).bind(requestedDate).all<{ evidence_date: string; value: number | null; target: number | null }>().then((result) => result.results ?? [])),
    safeQuery(() => learningDb.prepare(`
      WITH evidence AS (
        SELECT source_run_date evidence_date,
               json_extract(offline_evidence_json, '$.validation_packet.oos_metrics.date_mean_cross_section_corr_lcb90') value,
               updated_at, artifact_id evidence_id
          FROM model_artifact_registry
         WHERE model_name='l4_alpha_ev' AND candidate_type='l4_alpha_ev_refresh' AND source_run_date <= ?
        UNION ALL
        SELECT business_date,
               json_extract(validation_packet_json, '$.oos_metrics.date_mean_cross_section_corr_lcb90'),
               updated_at, evaluation_id
          FROM expected_return_shadow_evaluation_packets
         WHERE model_name='l4_alpha_ev' AND business_date <= ?
      ), ranked AS (
        SELECT evidence_date, value, updated_at, evidence_id,
               ROW_NUMBER() OVER (PARTITION BY evidence_date ORDER BY updated_at DESC, evidence_id DESC) ordinal FROM evidence
      )
      SELECT evidence_date, value, 0 target
        FROM ranked
       WHERE ordinal=1 AND evidence_date IS NOT NULL
       ORDER BY evidence_date DESC
       LIMIT 7
    `).bind(requestedDate, requestedDate).all<{ evidence_date: string; value: number | null; target: number | null }>().then((result) => result.results ?? [])),
    safeQuery(() => learningDb.prepare(`
      WITH evidence AS (
        SELECT source_run_date evidence_date,
               json_extract(offline_evidence_json, '$.validation_packet.selection_champion_comparison.spread_delta_lcb90') value,
               updated_at, artifact_id evidence_id
          FROM model_artifact_registry
         WHERE model_name='allocator_ev_fusion' AND candidate_type='allocator_ev_fusion_refresh' AND source_run_date <= ?
        UNION ALL
        SELECT business_date,
               json_extract(validation_packet_json, '$.selection_champion_comparison.spread_delta_lcb90'),
               updated_at, evaluation_id
          FROM expected_return_shadow_evaluation_packets
         WHERE model_name='allocator_ev_fusion' AND business_date <= ?
      ), ranked AS (
        SELECT evidence_date, value, updated_at, evidence_id,
               ROW_NUMBER() OVER (PARTITION BY evidence_date ORDER BY updated_at DESC, evidence_id DESC) ordinal FROM evidence
      )
      SELECT evidence_date, value, 0 target
        FROM ranked
       WHERE ordinal=1 AND evidence_date IS NOT NULL
       ORDER BY evidence_date DESC
       LIMIT 7
    `).bind(requestedDate, requestedDate).all<{ evidence_date: string; value: number | null; target: number | null }>().then((result) => result.results ?? [])),
  ])
  const historyByStage = new Map<PipelineMaturityStage['id'], {
    rows: Array<{ evidence_date: string; value: number | null; target: number | null }>
    unit: PipelineMaturityMetric['unit']
  }>([
    ['threshold_margin_affinity_v2', { rows: thresholdHistory.value ?? [], unit: 'rows' }],
    ['oof_redundancy', { rows: redundancyHistory.value ?? [], unit: 'dates' }],
    ['route_score_v2', { rows: routeHistory.value ?? [], unit: 'dates' }],
    ['s12', { rows: s12History.value ?? [], unit: 'r_multiple' }],
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
      }))
      .reverse()
  }

  return {
    schema_version: 'pipeline-decision-maturity-v1',
    requested_date: requestedDate,
    generated_at: new Date().toISOString(),
    current_expected_return_owner: servingState?.expected_return_owner ?? null,
    action_gate: servingState?.action_gate ?? 'fusion_primary_required',
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
