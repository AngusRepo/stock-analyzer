import type { Bindings } from '../types'
import { inspectAllocatorEvMaturityCoverage } from './allocatorEvDailyLifecycle'
import { databaseForDataDomain } from './dataDomainRegistry'
import { inspectExpectedReturnCandidateEvidence } from './expectedReturnCandidateEvidence'
import {
  adaptExpectedReturnCandidate,
  adaptExpectedReturnShadow,
  type ExpectedReturnCandidateDbRow,
  type ExpectedReturnCandidateEvidence,
  type ExpectedReturnShadowDbRow,
  type ExpectedReturnShadowEvidence,
} from './expectedReturnMaturityEvidence'
import { readCurrentExpectedReturnServingState } from './expectedReturnServingState'
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
    evidence_scopes?: {
      offline_candidate?: {
        artifact_id: string | null
        model_version: string | null
        artifact_contract_version: string | null
        validation_schema_version: string | null
        source_run_date: string | null
        updated_at: string | null
        oof_max_date: string | null
      }
      serving_pointer?: {
        artifact_id: string | null
        model_version: string | null
        artifact_contract_version: string | null
        serving_mode: string | null
        updated_at: string | null
      }
      frozen_forward?: {
        evaluation_id: string
        model_version: string
        validation_schema_version: string | null
        business_date: string
        oof_max_date: string
        updated_at: string | null
      }
      runtime_guard?: {
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
  schema_version: 'pipeline-decision-maturity-v1'
  requested_date: string
  generated_at: string
  current_expected_return_owner: 'l4_alpha_ev' | 'allocator_ev_fusion' | null
  action_gate: 'expected_return_owner' | 'fusion_primary_required'
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

  const canonicalHead = await safeQuery(() => env.DB.prepare(`
    SELECT substr(logical_run_key, 10, 10) signal_date, run_id
      FROM canonical_run_heads
     WHERE logical_run_key LIKE 'screener:%:TW:production:market_screener'
       AND substr(logical_run_key, 10, 10) <= ?
     ORDER BY substr(logical_run_key, 10, 10) DESC, updated_at DESC
     LIMIT 1
  `).bind(requestedDate).first<CanonicalHead>())
  const head = canonicalHead.value

  const [reference, matrix, redundancy, routeRun, routeHead, evRows, evShadowRows, serving, candidateReport, l4Maturity] = await Promise.all([
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
                 AND m.affinity_evidence_count>0) raw_threshold_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.evaluable=1 AND m.strategy_hit=1
                 AND m.affinity_evidence_count>0 AND m.challenger_affinity_version=?) projected_threshold_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.challenger_affinity_version=?) challenger_projection_cells,
             r.updated_at
        FROM strategy_label_matrix_runs_v4 r
       WHERE r.signal_date=? AND r.producer_run_id=?
       LIMIT 1
    `).bind(STRATEGY_ROUTE_CHALLENGER_VERSION, STRATEGY_ROUTE_CHALLENGER_VERSION, head.signal_date, head.run_id).first<any>() : Promise.resolve(null)),
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
      WITH ranked AS (
        SELECT model_name, artifact_id, version, state, source_run_date,
               offline_gate_decision, offline_gate_failed_gates,
               live_gate_status, updated_at, offline_evidence_json,
               ROW_NUMBER() OVER (
                 PARTITION BY model_name
                 ORDER BY source_run_date DESC, updated_at DESC, artifact_id DESC
               ) ordinal
          FROM model_artifact_registry
         WHERE model_name IN ('l4_alpha_ev', 'allocator_ev_fusion')
           AND candidate_type IN ('l4_alpha_ev_refresh', 'allocator_ev_fusion_refresh')
           AND COALESCE(source_run_date, '')<=?
      )
      SELECT model_name, artifact_id, version, state, source_run_date,
             offline_gate_decision, offline_gate_failed_gates,
             live_gate_status, updated_at, offline_evidence_json
        FROM ranked WHERE ordinal=1
    `).bind(requestedDate).all<ExpectedReturnCandidateDbRow>().then((result) => result.results ?? [])),
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
             quality_decision, policy_decision, validation_packet_json, updated_at
        FROM ranked WHERE ordinal=1
    `).bind(requestedDate).all<ExpectedReturnShadowDbRow>().then((result) => result.results ?? [])),
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
    const rawCovered = finite(matrixRow.raw_threshold_rows)
    const projected = finite(matrixRow.projected_threshold_rows)
    const projectionCells = finite(matrixRow.challenger_projection_cells)
    const referenceProjectionRows = finite(referenceRow.affinity_v2_rows)
    const rawComplete = matched > 0 && rawCovered === matched
    const projectionComplete = projected === matched && projectionCells === finite(matrixRow.expected_cell_count) && referenceProjectionRows === finite(referenceRow.reference_rows)
    const complete = rawComplete && projectionComplete
    const blockers = [...(rawComplete ? [] : ['threshold_margin_evidence_incomplete']), ...(projectionComplete ? [] : ['challenger_affinity_projection_incomplete'])]
    stages.push({
      id: 'threshold_margin_affinity_v2',
      layer: 'L1',
      title: 'Threshold-margin affinity V2',
      version: STRATEGY_ROUTE_CHALLENGER_VERSION,
      status: complete ? 'ready' : 'blocked',
      contribution_mode: 'shadow',
      maturity_kind: 'daily_coverage',
      progress: maturityProgress(projected, matched, 'rows'),
      decision: complete
        ? `當日 ${projected}/${matched} 筆策略命中均有 threshold margin 與 challenger affinity projection。`
        : rawComplete
          ? `Raw threshold margin 已完整 ${rawCovered}/${matched}；但 challenger projection 只有 ${projected}/${matched}，全矩陣 ${projectionCells}/${finite(matrixRow.expected_cell_count)}。`
          : `Raw threshold margin 只有 ${rawCovered}/${matched}，尚未具備完整 projection 前置證據。`,
      contribution: '用各策略自己的門檻距離與 signal strength 產生 challenger affinity，避免所有策略共用同一份 raw quality。',
      production_effect: '目前只餵給 challenger route；不直接改變 incumbent route、L4 或 BUY/HOLD。',
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
  const candidateState = candidateReport.value?.candidates
  const maturity = l4Maturity.value
  const evShadow = new Map<string, ExpectedReturnShadowEvidence>(
    (evShadowRows.value ?? []).map((row) => [row.model_name, adaptExpectedReturnShadow(row)]),
  )

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
    const offlineBlockers = l4?.offline_gate_failed_gates ?? ['offline_candidate_missing']
    const servingBlockers = l4Serving?.blockers ?? ['serving_pointer_missing']
    const shadowBlockers = l4Shadow?.failed_gates ?? ['frozen_forward_packet_missing']
    const status = l4 && !l4.identity_valid
      ? 'blocked'
      : candidateStatus(l4Serving?.artifact_state, l4?.offline_gate_decision, dateCount, minDates)
    const blockerGroups: PipelineMaturityBlockerGroup[] = [
      {
        scope: 'offline_candidate',
        title: 'Offline candidate',
        blockers: offlineBlockers,
      },
      {
        scope: 'serving_pointer',
        title: 'Production serving pointer',
        blockers: servingBlockers,
      },
      {
        scope: 'frozen_forward',
        title: 'Active-8 cohort causal shadow (not serving artifact)',
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
      progress: maturityProgress(dateCount, minDates, 'dates'),
      decision: l4Serving?.artifact_state === 'serving'
        ? 'Canonical L4 是目前 production expected-return owner。'
        : `候選資料 ${sampleCount}/${minSamples} rows、${dateCount}/${minDates} dates；${String(l4?.offline_gate_decision ?? 'PENDING').toUpperCase()}。`,
      contribution: '把 Active-8、Score V2、基本面、籌碼、技術面與 PIT sector alpha 校準成五日成本後絕對報酬。',
      production_effect: l4Serving?.artifact_state === 'serving'
        ? '提供 L4 expected return，與風險/流動性 gate 一起決定 BUY/HOLD。'
        : '候選只保存 OOF evidence；不改寫 production expected return。',
      blockers: offlineBlockers,
      blocker_groups: blockerGroups,
      metrics: [
        gateMetric('samples', 'Usable OOF samples', sampleCount, minSamples, 'rows'),
        gateMetric('dates', 'Usable OOF dates', dateCount, minDates, 'dates'),
        gateMetric('sector_samples', 'Offline candidate PIT sector-alpha samples', l4?.sector_samples, Math.max(1, finite(l4?.min_sector_samples, 300)), 'rows'),
        gateMetric('sector_dates', 'Offline candidate PIT sector-alpha dates', l4?.sector_dates, Math.max(1, finite(l4?.min_sector_dates, 8)), 'dates'),
        gateMetric('corr_lcb90', 'Offline candidate corr LCB90', l4?.l4_corr_lcb90, 0, 'ratio', 'gt'),
        gateMetric('spread_lcb90', 'Offline candidate spread LCB90', l4?.l4_spread_lcb90, 0, 'return', 'gt'),
        gateMetric('top_return', 'Offline candidate top-quintile mean', l4?.l4_top_return, 0, 'return', 'gt'),
        gateMetric('top_lcb90', 'Offline candidate top-quintile LCB90', l4?.l4_top_lcb90, 0, 'return', 'gt'),
        metric('walk_forward', 'Offline candidate walk-forward', l4?.walk_forward_passed, { target: true, comparator: 'eq', unit: 'status', passed: l4?.walk_forward_passed == null ? null : l4.walk_forward_passed }),
        metric('strict_pit_rows', 'Materialized strict L4 PIT', maturity?.strictL4PitRows ?? null, { unit: 'rows' }),
        metric('strict_pit_dates', 'Materialized strict L4 PIT dates', maturity?.strictL4PitDates ?? null, { unit: 'dates' }),
        gateMetric('shadow_sector_samples', 'Latest shadow PIT sector-alpha samples', l4Shadow?.sector_samples, Math.max(1, finite(l4?.min_sector_samples, 300)), 'rows'),
        gateMetric('shadow_sector_dates', 'Latest shadow PIT sector-alpha dates', l4Shadow?.sector_dates, Math.max(1, finite(l4?.min_sector_dates, 8)), 'dates'),
        gateMetric('shadow_corr_lcb90', 'Latest shadow corr LCB90', l4Shadow?.l4_corr_lcb90, 0, 'ratio', 'gt'),
        gateMetric('shadow_spread_lcb90', 'Latest shadow spread LCB90', l4Shadow?.l4_spread_lcb90, 0, 'return', 'gt'),
        gateMetric('shadow_top_return', 'Latest shadow top-quintile mean', l4Shadow?.l4_top_return, 0, 'return', 'gt'),
        gateMetric('shadow_top_lcb90', 'Latest shadow top-quintile LCB90', l4Shadow?.l4_top_lcb90, 0, 'return', 'gt'),
        metric('shadow_walk_forward', 'Latest shadow walk-forward', l4Shadow?.walk_forward_passed, { target: true, comparator: 'eq', unit: 'status', passed: l4Shadow?.walk_forward_passed ?? null }),
        metric('frozen_forward_quality', 'Active-8 cohort causal shadow quality', l4Shadow?.quality_decision ?? null, { target: 'PASS', comparator: 'eq', unit: 'status', passed: l4Shadow == null ? null : l4Shadow.quality_decision === 'PASS' }),
        metric('frozen_forward_dates', 'Active-8 cohort causal shadow dates', l4Shadow?.oof_date_count ?? null, { unit: 'dates', note: 'Rebuilds causal validation on a fixed Active-8 cohort; it is not the production serving artifact, training evidence, or promotion evidence.' }),
      ],
      lineage: {
        requested_date: requestedDate,
        evidence_date: l4?.source_run_date ?? null,
        oof_max_date: l4?.fusion_oof_max_date ?? null,
        artifact_id: l4?.artifact_id ?? null,
        oof_applicable: true,
        evidence_semantics: 'Purged Active-8 OOF and five-session net-label cutoff.',
        model_version: l4?.version ?? null,
        source: 'offline candidate; production pointer and frozen-forward shadow are separate evidence scopes',
        updated_at: l4?.updated_at ?? null,
        evidence_scopes: {
          offline_candidate: {
            artifact_id: l4?.artifact_id ?? null,
            model_version: l4?.version ?? null,
            artifact_contract_version: l4?.artifact_contract_version ?? null,
            validation_schema_version: l4?.validation_schema_version ?? null,
            source_run_date: l4?.source_run_date ?? null,
            updated_at: l4?.updated_at ?? null,
            oof_max_date: l4?.fusion_oof_max_date ?? null,
          },
          serving_pointer: {
            artifact_id: l4Serving?.artifact_id ?? null,
            model_version: l4Serving?.model_version ?? null,
            artifact_contract_version: l4Serving?.artifact_contract_version ?? null,
            serving_mode: l4Serving?.serving_mode ?? null,
            updated_at: l4Serving?.pointer_updated_at ?? null,
          },
          ...(l4Shadow ? {
            frozen_forward: {
              evaluation_id: l4Shadow.evaluation_id,
              model_version: l4Shadow.model_version,
              validation_schema_version: l4Shadow.validation_schema_version,
              business_date: l4Shadow.business_date,
              oof_max_date: l4Shadow.oof_max_date,
              updated_at: l4Shadow.updated_at,
            },
          } : {}),
        },
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
    const offlineBlockers = fusion?.offline_gate_failed_gates ?? ['offline_candidate_missing']
    const servingBlockers = fusionServing?.blockers ?? ['serving_pointer_missing']
    const shadowBlockers = fusionShadow?.failed_gates ?? ['frozen_forward_packet_missing']
    const runtimeGuardBound = Boolean(
      runtimeGuard
      && runtimeGuard.artifact_id === fusionServing?.artifact_id
      && runtimeGuard.model_fingerprint === fusionServing?.model_fingerprint
    )
    const runtimeGuardBlockers = runtimeGuardBound && runtimeGuard?.state === 'residual_bypass'
      ? ['serving_forward_guard_residual_bypass_active'] : []
    const status = fusion && !fusion.identity_valid
      ? 'blocked'
      : candidateStatus(fusionServing?.artifact_state, fusion?.offline_gate_decision, dateCount, minDates)
    const blockerGroups: PipelineMaturityBlockerGroup[] = [
      {
        scope: 'offline_candidate',
        title: 'Offline candidate',
        blockers: offlineBlockers,
      },
      {
        scope: 'serving_pointer',
        title: 'Production serving pointer',
        blockers: servingBlockers,
      },
      {
        scope: 'frozen_forward',
        title: 'Active-8 cohort causal shadow (not serving artifact)',
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
      progress: maturityProgress(dateCount, minDates, 'dates'),
      decision: fusionServing?.artifact_state === 'serving'
        ? 'Fusion 是 production primary expected-return owner。'
        : `候選資料 ${sampleCount}/${minSamples} rows、${dateCount}/${minDates} dates；tier ${fusion?.promotion_tier ?? 'shadow'}。`,
      contribution: '以 canonical L4 expected return 為 base，只疊加通過驗證的 v14 residual adjustment；S12 僅保留 shadow diagnostic。',
      production_effect: fusionServing?.artifact_state === 'serving'
        ? '以 L4 base 加上已驗證 residual 作 final trade EV；sparse allocator 仍是選擇與權重 owner。'
        : 'Residual 未通過時 adjustment 固定為 0，不得抹除或否決合格 canonical L4 base EV。',
      blockers: offlineBlockers,
      blocker_groups: blockerGroups,
      metrics: [
        gateMetric('samples', 'Offline candidate usable samples', sampleCount, minSamples, 'rows'),
        gateMetric('dates', 'Offline candidate usable dates', dateCount, minDates, 'dates'),
        gateMetric('l4_samples', 'Offline candidate L4 PIT samples', fusion?.l4_samples, Math.max(1, finite(fusion?.min_l4_samples, 300)), 'rows'),
        gateMetric('l4_dates', 'Offline candidate L4 PIT dates', fusion?.l4_dates, Math.max(1, finite(fusion?.min_l4_dates, 8)), 'dates'),
        metric('structure_samples', 'S12 shadow diagnostic structure samples', fusion?.structure_samples, { unit: 'rows', note: 'Diagnostic only; not a Fusion v14 serving gate.' }),
        metric('structure_dates', 'S12 shadow diagnostic structure dates', fusion?.structure_dates, { unit: 'dates', note: 'Diagnostic only; not a Fusion v14 serving gate.' }),
        metric('execution_samples', 'S12 shadow diagnostic executed samples', fusion?.execution_samples, { unit: 'rows', note: 'Diagnostic only; not a Fusion v14 serving gate.' }),
        metric('execution_dates', 'S12 shadow diagnostic executed dates', fusion?.execution_dates, { unit: 'dates', note: 'Diagnostic only; not a Fusion v14 serving gate.' }),
        gateMetric('market_samples', 'Offline candidate PIT market-context samples', fusion?.market_samples, Math.max(1, finite(fusion?.min_market_samples, 300)), 'rows'),
        gateMetric('market_dates', 'Offline candidate PIT market-context dates', fusion?.market_dates, Math.max(1, finite(fusion?.min_market_dates, 8)), 'dates'),
        gateMetric('sector_samples', 'Offline candidate PIT sector-alpha samples', fusion?.sector_samples, Math.max(1, finite(fusion?.min_sector_samples, 300)), 'rows'),
        gateMetric('sector_dates', 'Offline candidate PIT sector-alpha dates', fusion?.sector_dates, Math.max(1, finite(fusion?.min_sector_dates, 8)), 'dates'),
        gateMetric('residual_corr_lcb90', 'Residual adjustment corr LCB90', fusion?.residual_corr_lcb90, 0, 'ratio', 'gt'),
        gateMetric('residual_spread_lcb90', 'Residual adjustment spread LCB90', fusion?.residual_spread_lcb90, 0, 'return', 'gt'),
        metric('selection_corr_lcb90', 'Selection diagnostic corr LCB90', fusion?.selection_corr_lcb90, { unit: 'ratio', note: 'Reported for diagnosis only; the v14 serving head is residual_adjustment_model.' }),
        metric('selection_spread_lcb90', 'Selection diagnostic spread LCB90', fusion?.selection_spread_lcb90, { unit: 'return', note: 'Reported for diagnosis only; the v14 serving head is residual_adjustment_model.' }),
        metric('champion_corr_delta', 'Selection diagnostic corr delta vs canonical L4 LCB90', fusion?.fusion_corr_delta_lcb90, { unit: 'ratio', note: 'Not a v14 serving gate.' }),
        metric('champion_spread_delta', 'Selection diagnostic spread delta vs canonical L4 LCB90', fusion?.fusion_spread_delta_lcb90, { unit: 'return', note: 'Not a v14 serving gate.' }),
        gateMetric('top_trade_ev_lcb90', 'Offline candidate final top trade EV LCB90', fusion?.fusion_top_trade_ev_lcb90, 0, 'return', 'gt'),
        metric('final_champion_comparison', 'Offline candidate final trade EV paired comparison', fusion?.fusion_final_comparison_reason ? 'NOT_EVALUATED' : fusion?.fusion_final_comparison_decision, {
          unit: 'status',
          passed: fusion?.fusion_final_comparison_reason ? null : fusion?.fusion_final_comparison_decision == null ? null : fusion.fusion_final_comparison_decision === 'PASS',
          note: fusion?.fusion_final_comparison_reason ?? (finite(fusion?.fusion_final_comparison_samples) + '/paired rows across ' + finite(fusion?.fusion_final_comparison_dates) + ' dates.'),
        }),
        metric('execution_expert', 'Shadow diagnostic conditional execution expert', fusion?.execution_decision, { unit: 'status', passed: null, note: 'Diagnostic only; not served by Fusion v14.' }),
        metric('execution_probability', 'Shadow diagnostic execution probability expert', fusion?.execution_probability_decision, { unit: 'status', passed: null, note: 'Diagnostic only; not served by Fusion v14.' }),
        gateMetric('shadow_sector_samples', 'Latest shadow PIT sector-alpha samples', fusionShadow?.sector_samples, Math.max(1, finite(fusion?.min_sector_samples, 300)), 'rows'),
        gateMetric('shadow_sector_dates', 'Latest shadow PIT sector-alpha dates', fusionShadow?.sector_dates, Math.max(1, finite(fusion?.min_sector_dates, 8)), 'dates'),
        gateMetric('shadow_residual_corr_lcb90', 'Latest shadow residual corr LCB90', fusionShadow?.residual_corr_lcb90, 0, 'ratio', 'gt'),
        gateMetric('shadow_residual_spread_lcb90', 'Latest shadow residual spread LCB90', fusionShadow?.residual_spread_lcb90, 0, 'return', 'gt'),
        metric('shadow_walk_forward', 'Latest shadow residual walk-forward', fusionShadow?.walk_forward_passed, { target: true, comparator: 'eq', unit: 'status', passed: fusionShadow?.walk_forward_passed ?? null }),
        metric('frozen_forward_quality', 'Active-8 cohort causal shadow quality', fusionShadow?.quality_decision ?? null, { target: 'PASS', comparator: 'eq', unit: 'status', passed: fusionShadow == null ? null : fusionShadow.quality_decision === 'PASS' }),
        metric('frozen_forward_dates', 'Active-8 cohort causal shadow dates', fusionShadow?.oof_date_count ?? null, { unit: 'dates', note: 'Rebuilds causal validation on a fixed Active-8 cohort; it is not the production serving artifact.' }),
        metric('serving_forward_guard_state', 'Actual serving artifact T+5 guard', runtimeGuardBound ? runtimeGuard?.state ?? null : runtimeGuard ? 'IDENTITY_MISMATCH' : null, { unit: 'status', passed: runtimeGuardBound ? runtimeGuard?.state !== 'residual_bypass' : null, note: 'Bound by artifact ID and model fingerprint; it can only bypass the Fusion residual back to canonical L4.' }),
        metric('serving_forward_evaluable_dates', 'Serving-forward evaluable dates', runtimeGuardBound ? runtimeGuard?.evaluable_date_count ?? 0 : null, { unit: 'dates' }),
        metric('serving_forward_degraded_streak', 'Serving-forward degraded streak', runtimeGuardBound ? runtimeGuard?.degraded_streak ?? 0 : null, { unit: 'dates', target: 3, comparator: 'lt', passed: runtimeGuardBound ? (runtimeGuard?.degraded_streak ?? 0) < 3 : null }),
        metric('serving_forward_recovery_streak', 'Serving-forward recovery streak', runtimeGuardBound ? runtimeGuard?.recovery_streak ?? 0 : null, { unit: 'dates' }),
      ],
      lineage: {
        requested_date: requestedDate,
        evidence_date: fusion?.source_run_date ?? null,
        artifact_id: fusion?.artifact_id ?? null,
        model_version: fusion?.version ?? null,
        source: 'offline candidate; production pointer and frozen-forward shadow are separate evidence scopes',
        oof_max_date: fusion?.fusion_oof_max_date ?? null,
        oof_applicable: true,
        evidence_semantics: 'Fusion v14 residual-adjustment candidate uses purged OOF evidence; monitoring shadow is never promotion evidence.',
        updated_at: fusion?.updated_at ?? null,
        evidence_scopes: {
          offline_candidate: {
            artifact_id: fusion?.artifact_id ?? null,
            model_version: fusion?.version ?? null,
            artifact_contract_version: fusion?.artifact_contract_version ?? null,
            validation_schema_version: fusion?.validation_schema_version ?? null,
            source_run_date: fusion?.source_run_date ?? null,
            oof_max_date: fusion?.fusion_oof_max_date ?? null,
            updated_at: fusion?.updated_at ?? null,
          },
          serving_pointer: {
            artifact_id: fusionServing?.artifact_id ?? null,
            model_version: fusionServing?.model_version ?? null,
            artifact_contract_version: fusionServing?.artifact_contract_version ?? null,
            serving_mode: fusionServing?.serving_mode ?? null,
            updated_at: fusionServing?.pointer_updated_at ?? null,
          },
          ...(runtimeGuard ? {
            runtime_guard: {
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
          ...(fusionShadow ? {
            frozen_forward: {
              evaluation_id: fusionShadow.evaluation_id,
              model_version: fusionShadow.model_version,
              validation_schema_version: fusionShadow.validation_schema_version,
              business_date: fusionShadow.business_date,
              oof_max_date: fusionShadow.oof_max_date,
              updated_at: fusionShadow.updated_at,
            },
          } : {}),
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
        SELECT model_name, artifact_id, version, state, source_run_date,
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
      SELECT model_name, artifact_id, version, state, source_run_date,
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
        }
      }))),
    safeQuery(() => learningDb.prepare(`
      WITH ranked AS (
        SELECT model_name, artifact_id, version, state, source_run_date,
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
      SELECT model_name, artifact_id, version, state, source_run_date,
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
        }
      }))),
  ])
  const historyByStage = new Map<PipelineMaturityStage['id'], {
    rows: Array<{ evidence_date: string; value: number | null; target: number | null }>
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
