import { useEffect, useRef, useState, type ElementType } from 'react'
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
  type Time,
} from 'lightweight-charts'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  BarChart3,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Minus,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { explainExecutionEvent, parseExecutionEvent } from '@/lib/executionEvent'
import { stocksApi } from '@/lib/api'
import { describeAllocatorDecision } from '@/lib/pendingBuyAllocatorUi'
import { buildScoreBreakdownViewModel } from '@/lib/scoreV2ViewModel'
import { buildAtrBandSeries, buildTradingPlanLevels, normalizeOhlcvRows, type TradingPlanLevels } from '@/lib/tradingPlanLevels'
import { buildTradePlanStructureZones } from '@/lib/tradePlanStructureZones'
import { cn } from '@/lib/utils'

type AlphaContext = {
  bucket?: string
  regime?: string
  sizing?: number | null
  scoreAdjustment?: number | null
  volatility?: string
  liquidity?: string
  skip?: boolean
  poc?: string | number | null
  fairValueLow?: string | number | null
  fairValueHigh?: string | number | null
  optimisticValueLow?: string | number | null
  optimisticValueHigh?: string | number | null
  optimisticValueStatus?: string | null
  upsideToOptimisticHighPct?: string | number | null
  location?: string
  window?: string | null
  latestClose?: string | number | null
}

type RecommendationCardContext = 'full' | 'home'

type RecommendationCardCleanProps = {
  rec: any
  rank: number
  context?: RecommendationCardContext
}

type EntryPriceModelV2Ui = {
  anchorSource: string
  entry: string | null
  preferred: string | null
  chaseCeiling: string | null
  premium: string | null
  discount: string | null
  poc: string | null
  fallback: string | null
}

type MlVoteSummary = {
  bullish?: number
  bearish?: number
  flat?: number
  reported?: number
  missing?: number
  total?: number
  forecastPct?: number | null
  forecast_pct?: number | null
  activeWeightCount?: number | null
  zeroWeightModels?: string[]
  contributingModels?: string[]
  thresholds?: {
    bullish?: number
    bearish?: number
    regime?: string
    adjustment?: number
  }
  icWeightScope?: string
  validationBlockedModels?: string[]
  coreFamilyVote?: CoreFamilyVoteSummary | null
}

type CoreFamilyVoteSummary = {
  schema_version?: string
  family_score?: number
  active_family_count?: number
  active_families?: string[]
  inactive_formal_models?: string[]
}

type MlDiagnosticsSummary = {
  totalAlphaModels?: number
  activeWeightCount?: number
  zeroWeightModels?: string[]
  contributingModels?: string[]
  validationBlockedModels?: string[]
  icWeightScope?: string | null
  rankSignalThresholds?: Record<string, unknown> | null
  forecastCalibration?: {
    method?: string | null
    source?: string | null
    sampleCount?: number | null
    binSamples?: number | null
    bin?: string | number | null
  }
  dispersion?: {
    rawModelCount?: number | null
    rawRankStd?: number | null
    mergeCompression?: number | null
    weightHhi?: number | null
  }
  timesfmSidecar?: {
    schemaVersion?: string | null
    layer?: string | null
    role?: string | null
    directAlphaBlocked?: boolean | number | string | null
    eligibleForL2FeatureEnrichment?: boolean | number | string | null
    l2FeatureInputActive?: boolean | number | string | null
    l2FeatureInputBlockedReason?: string | null
    currentAllowedUse?: string[]
    featureKeys?: string[]
    populatedFeatureCount?: number | string | null
    features?: Record<string, unknown>
  } | null
  timesfm_sidecar?: MlDiagnosticsSummary['timesfmSidecar']
}

type SparseAllocationSummary = {
  schema_version?: string
  source?: string
  allocation_method?: string
  input_scope?: string
  selection_policy?: string
  decision_policy?: string
  capacity_policy?: string
  upstream_conflict_policy?: string
  final_decision_scope?: string
  max_capacity_not_target?: boolean
  hard_minimum_fill?: boolean
  allows_empty_portfolio?: boolean
  zero_selection_allowed?: boolean
  legacy_topk_fallback_allowed?: boolean
  legacy_rank_topk_fallback_allowed?: boolean
  is_final_allocation_owner?: boolean
  engine?: string
  controller?: string | null
  selected?: boolean | number | string
  allocation_weight?: number | string | null
  single_name_weight?: number | string | null
  expected_return?: number | string | null
  risk_estimate?: number | string | null
  allocation_rank?: number | string | null
  selection_reason?: string | null
  potential_buy_reason?: string | null
  sparse_weight_state?: string | null
  buy_signal_count?: number | string | null
  return_history_coverage?: number | string | null
  return_history_symbol_count?: number | string | null
  opb_controller?: Record<string, unknown> | null
}

type HardGateSummary = {
  schema_version?: string
  decision_policy?: string
  gate_scope?: string
  board_type?: string | null
  tradability_tier?: string | null
  recommendation_lane?: string | null
  market_segment?: string | null
  board_reason?: string | null
  eligible_for_ml?: boolean | number | string | null
  eligible_for_pending_buy?: boolean | number | string | null
  ml_slate_allowed?: boolean | number | string | null
  pending_buy_blocked?: boolean | number | string | null
  hard_blocked?: boolean | number | string | null
  notes?: string[]
}

type UniverseFeatureSummary = {
  schema_version?: string
  decision_policy?: string
  selection_policy?: string
  universe_decision?: string | null
  universe_reason?: string | null
  universe_passed?: boolean | number | string | null
  base_score?: number | string | null
  source_universe_count?: number | string | null
  feature_group_count?: number | string | null
  feature_groups?: string[]
  has_score_v2_components?: boolean | number | string | null
  has_strategy_raw_signals?: boolean | number | string | null
  has_taxonomy_profile?: boolean | number | string | null
  close?: number | string | null
  avg_volume_20d?: number | string | null
  avg_daily_turnover?: number | string | null
}

type StrategyLabelerSummary = {
  schema_version?: string
  decision_policy?: string
  selection_policy?: string
  label_scope?: string
  next_layer_owner?: string
  strategy_labeler_version?: string | null
  source_universe_count?: number | string | null
  decision?: string | null
  reason_code?: string | null
  strategy_count?: number | string | null
  active_strategy_count?: number | string | null
  research_strategy_count?: number | string | null
  family_count?: number | string | null
  vector_strategy_count?: number | string | null
  strategy_ids?: string[]
  research_strategy_ids?: string[]
  family_ids?: string[]
  vector_strategy_ids?: string[]
  has_strategy_affinity_vector?: boolean | number | string | null
  has_family_affinity_vector?: boolean | number | string | null
  has_weak_label_vector?: boolean | number | string | null
  has_hit_vector?: boolean | number | string | null
  has_position_weight_vector?: boolean | number | string | null
  has_overlap_vector?: boolean | number | string | null
  max_strategy_affinity?: number | string | null
  avg_strategy_affinity?: number | string | null
  strategy_hit_count?: number | string | null
  position_weight_sum?: number | string | null
  max_strategy_overlap?: number | string | null
}

type StrategyPortfolioIntelligenceSummary = {
  schema_version?: string
  method?: string
  decision_policy?: string
  selection_policy?: string
  output_scope?: string
  consumed_by?: string
  finlab_portfolio_intelligence_version?: string | null
  portfolio_metric_source?: string | null
  portfolio_metric_status?: string | null
  portfolio_metric_count?: number | string | null
  backtest_metric_count?: number | string | null
  backtest_result_row_count?: number | string | null
  strategy_count?: number | string | null
  family_count?: number | string | null
  strategy_ids?: string[]
  family_ids?: string[]
  strategy_prior_weight?: number | string | null
  family_prior_weight?: number | string | null
  strategy_reliability?: number | string | null
  strategy_crowding_score?: number | string | null
  strategy_diversification_value?: number | string | null
  max_holding_overlap?: number | string | null
  metric_dimensions?: string[]
  crowding_action?: string | null
  reliability_action?: string | null
}

type Layer2CoarseMlSummary = {
  schema_version?: string
  decision_policy?: string
  capacity_policy?: string
  model_scope?: string | null
  expected_models?: string[]
  expected_model_count?: number | string | null
  formal_l2_queue?: boolean | number | string | null
  formal_l2_pass?: boolean | number | string | null
  worker_seed_only?: boolean | number | string | null
  decision?: string | null
  reason_code?: string | null
  coarse_queue_size?: number | string | null
  core_ml_shortlist_size?: number | string | null
  l3_formal_inference_selected?: boolean | number | string | null
  direct_alpha_blocked?: boolean | number | string | null
  l2_feature_input_active?: boolean | number | string | null
  l2_feature_input_blocked_reason?: string | null
  l2_feature_schema_version?: string | null
  populated_feature_count?: number | string | null
  current_allowed_use?: string[]
}

type Layer3FormalMlSummary = {
  schema_version?: string
  decision_policy?: string
  capacity_policy?: string
  model_scope?: string | null
  expected_models?: string[]
  expected_model_count?: number | string | null
  decision?: string | null
  reason_code?: string | null
  formal_family_score?: number | string | null
  active_family_count?: number | string | null
  active_families?: string[]
  contributing_model_count?: number | string | null
  contributing_models?: string[]
  l2_contributing_models?: string[]
  l3_contributing_models?: string[]
  active_l3_model_count?: number | string | null
}

type StrategyRouterSummary = {
  schema_version?: string
  router_method?: string
  router_scope?: string
  decision_policy?: string
  selection_policy?: string
  capacity_policy?: string
  no_topup_policy_scope?: string | null
  observe_topup_policy?: string | null
  no_minimum_fill?: boolean | number | string | null
  is_topk_ranker?: boolean | number | string | null
  output_scope?: string | null
  teacher_label_scope?: string | null
  expected_teacher_models?: string[]
  expected_teacher_count?: number | string | null
  teacher_models?: string[]
  teacher_label_count?: number | string | null
  formal_l2_queue?: boolean | number | string | null
  observe_only_top_up?: boolean | number | string | null
  strategy_labeler_version?: string | null
  strategy_router_version?: string | null
  strategy_router_decision?: string | null
  strategy_router_reason?: string | null
  route_score?: number | string | null
  ml_slate_eligibility?: number | string | null
  strategy_count?: number | string | null
  family_count?: number | string | null
  research_strategy_count?: number | string | null
  strategy_ids?: string[]
  family_ids?: string[]
  research_strategy_ids?: string[]
  diversity_contribution?: number | string | null
  risk_adjusted_affinity?: number | string | null
  uncertainty?: number | string | null
  strategy_prior_weight?: number | string | null
  family_prior_weight?: number | string | null
  strategy_reliability?: number | string | null
  strategy_crowding_score?: number | string | null
  strategy_diversification_value?: number | string | null
  teacher_alignment?: number | string | null
  portfolio_metric_source?: string | null
  portfolio_metric_status?: string | null
  portfolio_metric_count?: number | string | null
  backtest_metric_count?: number | string | null
}

type Layer35FusionSummary = {
  schema_version?: string
  fusion_method?: string
  input_scope?: string
  decision_policy?: string
  selection_policy?: string
  hard_shrink_allowed?: boolean | number | string | null
  is_final_allocator?: boolean | number | string | null
  final_allocation_owner?: string | null
  output_scope?: string | null
  decision?: string
  conflict_level?: string
  route_evidence_available?: boolean | number | string | null
  formal_ml_evidence_available?: boolean | number | string | null
  active_l3_family_sufficient?: boolean | number | string | null
  layer1_route_score?: number | string | null
  layer1_uncertainty?: number | string | null
  layer3_formal_family_score?: number | string | null
  active_family_count?: number | string | null
  contributing_model_count?: number | string | null
  contributing_models?: string[]
  strategy_ml_score_gap?: number | string | null
  recommended_action?: string | null
}

type EvidenceLink = {
  source?: string
  title?: string
  url?: string
  published_at?: string
}

type InstitutionalRawCardRow = {
  key?: string
  label?: string
  buy_shares?: number | string | null
  sell_shares?: number | string | null
  net_shares?: number | string | null
}

type BrokerFlowRankRow = {
  broker_code?: string | null
  broker_name?: string | null
  buy_lots?: number | string | null
  sell_lots?: number | string | null
  net_lots?: number | string | null
  buy_shares?: number | string | null
  sell_shares?: number | string | null
  net_shares?: number | string | null
}

const DIRECT_ALPHA_VOTE_MODEL_NAMES = [
  'LightGBM',
  'XGBoost',
  'ExtraTrees',
  'TabM',
  'GNN',
  'DLinear',
  'PatchTST',
  'iTransformer',
] as const

const TIMESFM_SIDECAR_MODEL_NAMES = ['TimesFM'] as const

const ALPHA_PREDICTION_MODEL_NAMES = [
  ...DIRECT_ALPHA_VOTE_MODEL_NAMES,
  ...TIMESFM_SIDECAR_MODEL_NAMES,
] as const

const DIRECT_ALPHA_VOTE_MODEL_SET = new Set<string>(DIRECT_ALPHA_VOTE_MODEL_NAMES)
const DIRECT_ALPHA_VOTE_MODEL_LABEL = DIRECT_ALPHA_VOTE_MODEL_NAMES.join(' / ')
const TIMESFM_SIDECAR_LABEL = 'TimesFM L2 sidecar'

function normalizeModelName(raw: unknown): string {
  const value = String(raw ?? '').trim()
  const compact = value.toLowerCase().replace(/[\s_-]+/g, '')
  const aliases: Record<string, string> = {
    lightgbm: 'LightGBM',
    lgbm: 'LightGBM',
    xgboost: 'XGBoost',
    xgb: 'XGBoost',
    extratrees: 'ExtraTrees',
    extratreesregressor: 'ExtraTrees',
    tabm: 'TabM',
    gnn: 'GNN',
    graphnn: 'GNN',
    dlinear: 'DLinear',
    patchtst: 'PatchTST',
    itransformer: 'iTransformer',
    timesfm: 'TimesFM',
  }
  return aliases[compact] ?? value
}

function isAlphaPredictionModelName(raw: unknown): boolean {
  return DIRECT_ALPHA_VOTE_MODEL_SET.has(normalizeModelName(raw))
}

function fmtNumber(value: number | string | null | undefined, decimals = 1): string {
  if (value == null || value === '') return '-'
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return String(value)
  return numeric.toFixed(decimals)
}

function fmtOptionalNumber(value: number | string | null | undefined, decimals = 1): string | null {
  if (value == null || value === '') return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return numeric.toFixed(decimals)
}

function fmtChipAmount(billion: number | null | undefined): string {
  if (billion == null) return '-'
  const abs = Math.abs(billion)
  if (abs < 0.01 && abs > 0) {
    const wan = Math.round(billion * 10000)
    return `${wan > 0 ? '+' : ''}${wan} 萬`
  }
  return `${billion > 0 ? '+' : ''}${billion.toFixed(2)} 億`
}

function fmtInteger(value: number | string | null | undefined): string {
  if (value == null || value === '') return '-'
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return String(value)
  return Math.round(numeric).toLocaleString('en-US')
}

function fmtShares(value: number | string | null | undefined): string {
  const text = fmtInteger(value)
  return text === '-' ? '-' : `${text} 股`
}

function fmtLots(value: number | string | null | undefined): string {
  const text = fmtInteger(value)
  return text === '-' ? '-' : `${text} 張`
}

function institutionalNetShares(institutional: ReturnType<typeof institutionalRawFromRec>): number | null {
  const direct = Number(institutional?.total_net_shares)
  if (Number.isFinite(direct)) return direct
  const rows = institutional?.rows ?? []
  if (!rows.length) return null
  const sum = rows.reduce((acc, row) => {
    const value = Number(row.net_shares)
    return Number.isFinite(value) ? acc + value : acc
  }, 0)
  return Number.isFinite(sum) ? sum : null
}

function flowDirectionText(value: number): string {
  if (value > 0) return '買超'
  if (value < 0) return '賣超'
  return '持平'
}

function fmtAbsLotsFromShares(value: number | string | null | undefined): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '-'
  return fmtLots(Math.abs(numeric) / 1000)
}

function signedFlowClass(value: unknown): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric === 0) return 'text-slate-400'
  return numeric > 0 ? 'text-red-300' : 'text-emerald-300'
}

function institutionalRawFromRec(rec: any): { date?: string; rows: InstitutionalRawCardRow[]; total_net_shares?: number | string | null } | null {
  const payload = parseObject(rec?.institutional_raw_today)
  if (!payload) return null
  const rows = Array.isArray(payload.rows) ? payload.rows as InstitutionalRawCardRow[] : []
  if (!rows.length) return null
  return {
    date: payload.date ? String(payload.date) : undefined,
    rows,
    total_net_shares: payload.total_net_shares ?? null,
  }
}

function brokerTopFlowsFromRec(rec: any): any | null {
  return parseObject(rec?.broker_top_flows_today)
}

function displayForecastPct(summary: MlVoteSummary | null): number | null {
  if (!summary) return null
  if (typeof summary.forecastPct === 'number' && Number.isFinite(summary.forecastPct)) {
    return summary.forecastPct
  }
  const raw = summary.forecast_pct
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  return Math.abs(raw) <= 0.2 ? raw * 100 : raw
}

function coreFamilyVoteBadgeText(summary: MlVoteSummary | null): string | null {
  const vote = parseObject(summary?.coreFamilyVote)
  if (!vote) return null
  const active = Number(vote.active_family_count ?? vote.activeFamilyCount ?? 0)
  const score = Number(vote.family_score ?? vote.familyScore ?? NaN)
  if (!Number.isFinite(active) || active <= 0) return null
  const familyTotal = Math.max(5, Object.keys(parseObject(vote.families) ?? {}).length)
  const scoreText = Number.isFinite(score) ? ` ${Math.round(score * 100)}` : ''
  return `Family ${active}/${familyTotal}${scoreText}`
}

function normalizeForecastPctForUi(raw: unknown): number | null {
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  return Math.abs(value) <= 0.2 ? value * 100 : value
}

function normalizePersistedForecastPctForUi(summary: any): number | null {
  // Contract: `forecast_pct` is raw return fraction; legacy `forecastPct`
  // rows were also written as fraction before the 2026-05-13 contract fix.
  return normalizeForecastPctForUi(summary?.forecast_pct ?? summary?.forecastPct)
}

function finiteMetric(raw: unknown): number | null {
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function boolFromValue(raw: unknown): boolean {
  if (raw === true || raw === 1) return true
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase()
    return value === 'true' || value === '1' || value === 'yes'
  }
  return false
}

function sparseAllocationFromRec(rec: any): SparseAllocationSummary | null {
  const funnelEvidence = parseObject(rec?.screener_funnel_evidence)
  const forecastData = parseForecastData(rec?.prediction_forecast_data)
  const allocation = parseObject(rec?.l4_sparse_allocation)
    ?? parseObject(funnelEvidence?.layer4_sparse_allocation)
    ?? parseObject(rec?.alpha_allocation)
    ?? parseObject(forecastData?.alpha_allocation)
  if (!allocation) return null
  if (String(allocation.engine ?? '').trim() !== 'sparse_tangent_inverse_risk') return null
  return allocation
}

function hardGateFromRec(rec: any): HardGateSummary | null {
  const funnelEvidence = parseObject(rec?.screener_funnel_evidence)
  const gate = parseObject(rec?.l05_hard_gate)
    ?? parseObject(funnelEvidence?.layer05_hard_gate)
  if (gate?.schema_version === 'l05_hard_gate_summary_v1') return gate
  const hasGovernanceFields = rec?.board_type || rec?.tradability_tier || rec?.recommendation_lane || rec?.board_reason
  if (!hasGovernanceFields) return null
  return {
    schema_version: 'l05_hard_gate_summary_v1',
    decision_policy: 'exclude_untradable_or_untrusted_only_not_alpha_ranker',
    gate_scope: 'tradeability_data_trust_pending_buy',
    board_type: rec?.board_type ?? null,
    tradability_tier: rec?.tradability_tier ?? null,
    recommendation_lane: rec?.recommendation_lane ?? null,
    market_segment: rec?.market_segment ?? null,
    board_reason: rec?.board_reason ?? null,
    eligible_for_ml: rec?.eligible_for_ml ?? null,
    eligible_for_pending_buy: rec?.eligible_for_pending_buy ?? null,
    ml_slate_allowed: rec?.eligible_for_ml ?? null,
    pending_buy_blocked: rec?.eligible_for_pending_buy === false || rec?.eligible_for_pending_buy === 0,
    hard_blocked: rec?.tradability_tier === 'blocked',
  }
}

function universeFeaturesFromRec(rec: any): UniverseFeatureSummary | null {
  const funnelEvidence = parseObject(rec?.screener_funnel_evidence)
  const layer0 = parseObject(funnelEvidence?.layer0_universe_features)
  if (layer0?.schema_version === 'layer0_universe_features_summary_v1') return layer0
  return null
}

function strategyLabelerEvidenceFromRec(rec: any): StrategyLabelerSummary | null {
  const funnelEvidence = parseObject(rec?.screener_funnel_evidence)
  const labeler = parseObject(funnelEvidence?.layer1_strategy_labeler)
  if (labeler?.schema_version === 'layer1_strategy_labeler_summary_v1') return labeler
  return null
}

function strategyPortfolioIntelligenceFromRec(rec: any): StrategyPortfolioIntelligenceSummary | null {
  const funnelEvidence = parseObject(rec?.screener_funnel_evidence)
  const portfolio = parseObject(funnelEvidence?.layer125_finlab_portfolio_intelligence)
  if (portfolio?.schema_version === 'layer125_finlab_portfolio_intelligence_summary_v1') return portfolio
  return null
}

function mlStackEvidenceFromRec(rec: any): { coarse: Layer2CoarseMlSummary | null; formal: Layer3FormalMlSummary | null } | null {
  const funnelEvidence = parseObject(rec?.screener_funnel_evidence)
  if (!funnelEvidence) return null
  const coarse = parseObject(funnelEvidence.layer2_timesfm_enrichment)
    ?? parseObject(funnelEvidence.layer2_3ml_coarse)
    ?? parseObject(funnelEvidence.layer2_coarse_ml)
    ?? parseObject(funnelEvidence.layer2_queue_seed)
  const formal = parseObject(funnelEvidence.layer3_8ml_formal)
    ?? parseObject(funnelEvidence.layer3_6ml_formal)
    ?? parseObject(funnelEvidence.layer3_formal_ml)
  if (!coarse && !formal) return null
  return {
    coarse: coarse
      ? {
          schema_version: coarse.schema_version ?? 'layer2_timesfm_enrichment_summary_v1',
          decision_policy: coarse.decision_policy ?? 'timesfm_sequence_sidecar_feature_enrichment_not_selector',
          capacity_policy: coarse.capacity_policy ?? 'max_only_no_minimum_no_topup',
          expected_models: Array.isArray(coarse.expected_models) ? coarse.expected_models.map(String) : ['TimesFM'],
          expected_model_count: coarse.expected_model_count ?? 1,
          formal_l2_pass: coarse.formal_l2_pass ?? (coarse.worker_seed_only === true ? false : coarse.decision === 'pass'),
          worker_seed_only: coarse.worker_seed_only ?? false,
          decision: coarse.decision ?? null,
          reason_code: coarse.reason_code ?? null,
          coarse_queue_size: coarse.coarse_queue_size ?? coarse.coarse_ml_queue_size ?? null,
          core_ml_shortlist_size: coarse.core_ml_shortlist_size ?? null,
          l3_formal_inference_selected: coarse.l3_formal_inference_selected ?? null,
          direct_alpha_blocked: coarse.direct_alpha_blocked ?? null,
          l2_feature_input_active: coarse.l2_feature_input_active ?? null,
          l2_feature_input_blocked_reason: coarse.l2_feature_input_blocked_reason ?? null,
          l2_feature_schema_version: coarse.l2_feature_schema_version ?? null,
          populated_feature_count: coarse.populated_feature_count ?? null,
          current_allowed_use: Array.isArray(coarse.current_allowed_use) ? coarse.current_allowed_use.map(String) : [],
        }
      : null,
    formal: formal
      ? {
          schema_version: formal.schema_version ?? 'layer3_8ml_formal_summary_v1',
          decision_policy: formal.decision_policy ?? 'eight_ml_formal_family_evidence_not_topk',
          capacity_policy: formal.capacity_policy ?? 'evidence_only_no_minimum_fill',
          expected_models: Array.isArray(formal.expected_models) ? formal.expected_models.map(String) : ['LightGBM', 'XGBoost', 'ExtraTrees', 'TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer'],
          expected_model_count: formal.expected_model_count ?? 8,
          decision: formal.decision ?? null,
          reason_code: formal.reason_code ?? null,
          formal_family_score: formal.formal_family_score ?? formal.score_after ?? formal.family_score ?? null,
          active_family_count: formal.active_family_count ?? null,
          active_families: Array.isArray(formal.active_families) ? formal.active_families.map(String) : [],
          contributing_model_count: formal.contributing_model_count ?? (Array.isArray(formal.contributing_models) ? formal.contributing_models.length : null),
          contributing_models: Array.isArray(formal.contributing_models) ? formal.contributing_models.map(String) : [],
          l2_contributing_models: Array.isArray(formal.l2_contributing_models) ? formal.l2_contributing_models.map(String) : [],
          l3_contributing_models: Array.isArray(formal.l3_contributing_models) ? formal.l3_contributing_models.map(String) : [],
          active_l3_model_count: formal.active_l3_model_count ?? null,
        }
      : null,
  }
}

function strategyRouterEvidenceFromRec(rec: any): StrategyRouterSummary | null {
  const funnelEvidence = parseObject(rec?.screener_funnel_evidence)
  const router = parseObject(funnelEvidence?.layer15_multi_strategy_router)
    ?? parseObject(funnelEvidence?.layer1_breadth)
  if (!router) return null
  const hasRouterEvidence = router.schema_version === 'layer15_multi_strategy_router_summary_v1'
    || router.strategy_router_version
    || router.candidate_route_score != null
    || router.route_score != null
  if (!hasRouterEvidence) return null
  return {
    ...router,
    route_score: router.route_score ?? router.candidate_route_score ?? router.strategy_router_score ?? null,
  }
}

function layer35EvidenceFromRec(rec: any): Layer35FusionSummary | null {
  const funnelEvidence = parseObject(rec?.screener_funnel_evidence)
  const fusion = parseObject(funnelEvidence?.layer35_evidence_fusion)
  if (!fusion) return null
  if (fusion.schema_version !== 'layer35_evidence_fusion_v1' && !fusion.conflict_level && !fusion.decision) return null
  return fusion
}

function allocationWeightText(raw: unknown): string {
  const value = finiteMetric(raw)
  if (value == null) return '-'
  const pct = Math.abs(value) <= 1 ? value * 100 : value
  return `${fmtNumber(pct, 1)}%`
}

function percentText(raw: unknown, decimals = 0): string {
  const value = finiteMetric(raw)
  if (value == null) return '-'
  const pct = Math.abs(value) <= 1 ? value * 100 : value
  return `${fmtNumber(pct, decimals)}%`
}

function countText(raw: unknown): string {
  const value = finiteMetric(raw)
  return value == null ? '-' : fmtNumber(value, 0)
}

function allocationSlotText(raw: unknown): string {
  const value = finiteMetric(raw)
  return value == null ? 'capacity unknown' : `max ${fmtNumber(value, 0)} slots`
}

const SIGNAL_CONFIG: Record<string, { label: string; color: string; icon: ElementType }> = {
  STRONG_BUY: { label: '強買', color: 'border-red-300/55 bg-red-500/90 text-white shadow-[0_0_18px_rgba(239,68,68,0.20)]', icon: Zap },
  BUY: { label: '買進', color: 'border-red-300/45 bg-red-500/80 text-white shadow-[0_0_16px_rgba(239,68,68,0.16)]', icon: TrendingUp },
  POTENTIAL_BUY: { label: '潛在買進', color: 'border-yellow-200/70 bg-yellow-300/28 text-yellow-50 shadow-[0_0_18px_rgba(250,204,21,0.18)]', icon: TrendingUp },
  HOLD: { label: '觀望', color: 'border-sky-200/45 bg-sky-500/28 text-sky-50 shadow-[0_0_14px_rgba(56,189,248,0.12)]', icon: Minus },
  SELL: { label: '賣出', color: 'bg-blue-500 text-white', icon: TrendingDown },
  STRONG_SELL: { label: '強賣', color: 'bg-purple-600 text-white', icon: TrendingDown },
}

function recommendationSignalKey(rec: any): string {
  return String(rec?.signal ?? rec?.trade_signal ?? rec?.tradeSignal ?? rec?.signal_raw ?? '').trim().toUpperCase()
}

const ALPHA_BUCKET_TEXT: Record<string, { label: string; help: string }> = {
  trend_following: {
    label: '順勢追蹤',
    help: '代表系統認為主要優勢來自「趨勢延續」。重點是價格已經有方向，進場不是撿便宜，而是順著強勢走。',
  },
  mean_reversion: {
    label: '均值回歸',
    help: '代表系統認為價格短線偏離合理區，可能有修復空間。重點是避免接刀，要看支撐、量能與大盤是否穩住。',
  },
  breakout_vol_expansion: {
    label: '突破 / 波動擴張',
    help: '代表系統偵測到突破或波動放大。這種機會可能跑很快，但也最容易追高，所以 sizing 和停損要更嚴格。',
  },
  defensive_accumulation: {
    label: '防守型累積',
    help: '代表訊號不是強攻型，而是偏防守、慢慢累積。適合小部位或觀察，不應解讀成無腦追價。',
  },
}

const REGIME_TEXT: Record<string, string> = {
  bull: '多頭環境：系統會較願意給順勢與突破策略權重，但仍需注意是否過熱。',
  bear: '空頭環境：系統會提高防守與風險控管權重，買進訊號要更保守。',
  sideways: '盤整環境：追突破容易假突破，均值回歸與區間交易通常更重要。',
  volatile: '高波動環境：價格容易大幅跳動，重點是降倉、避開滑價與避免追高。',
}

const VOL_TEXT: Record<string, string> = {
  normal: '波動正常：價格變動沒有明顯失控，風控可用標準參數。',
  high: '波動偏高：容易震盪掃停損，進場價、部位大小與停損距離都要更保守。',
  extreme: '波動極端：容易出現跳空與急殺，通常不適合自動追價。',
  unknown: '波動資料不足：不要過度解讀，需要等更多價格資料。',
}

const LIQUIDITY_TEXT: Record<string, string> = {
  normal: '流動性正常：成交量足夠，理論上較不容易因買賣造成明顯滑價。',
  thin: '流動性偏薄：掛單可能比較難成交，或成交價偏離預期。',
  low: '流動性低：滑價與流動性風險高，通常應跳過或大幅降倉。',
  unknown: '流動性資料不足：無法可靠估計成交與滑價風險。',
}

const LOCATION_TEXT: Record<string, string> = {
  below_fair_value: '低於日線價值代理區：可能偏折價，但要確認不是弱勢破位。',
  in_fair_value: '位於日線價值代理區：價格在日線 proxy 附近，不代表真實公平價。',
  above_fair_value: '高於日線價值代理區：偏追高，若同時高波動或量薄就要特別小心。',
  unknown: '公平價位置不足：資料不夠完整，不能過度解讀。',
}

function labelFor(value: unknown, table?: Record<string, string>): string {
  if (typeof value !== 'string' || !value) return 'unknown'
  return ALPHA_BUCKET_TEXT[value]?.label ?? table?.[value] ?? value.replace(/_/g, ' ')
}

function shortLabelFor(value: unknown, table?: Record<string, string>): string {
  const label = labelFor(value, table)
  return label.split('：')[0]
}

function normalizeWatchPoints(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
  } catch {
    return [raw]
  }
}

function extractValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`${key}=([^,]+)`))
  return match?.[1]?.trim() ?? null
}

function extractTokenValue(text: string, key: string): string | null {
  const match = text.match(new RegExp(`${key}=([^\\s;]+)`))
  return match?.[1]?.trim() ?? null
}

const STALE_ENTRY_MODEL_TOKENS = new Set([
  'missing_' + 'intraday_tick_anchor',
  'missing_' + 'entry_model_v2_anchor',
])

function cleanEntryModelToken(value: string | null): string | null {
  if (!value) return null
  const clean = value.trim()
  const normalized = clean.toLowerCase()
  return clean && normalized !== 'na' && !STALE_ENTRY_MODEL_TOKENS.has(normalized) ? clean : null
}

function entryModelV2FromWatchPoints(points: string[]): EntryPriceModelV2Ui | null {
  const point = points.find((item) => item.startsWith('entry_price_model_v2:'))
  if (!point) return null
  const anchorSource = cleanEntryModelToken(extractTokenValue(point, 'source')) ?? 'daily_proxy_fallback'
  return {
    anchorSource,
    entry: cleanEntryModelToken(extractTokenValue(point, 'entry')),
    preferred: cleanEntryModelToken(extractTokenValue(point, 'preferred')),
    chaseCeiling: cleanEntryModelToken(extractTokenValue(point, 'chase_ceiling')),
    premium: cleanEntryModelToken(extractTokenValue(point, 'premium')),
    discount: cleanEntryModelToken(extractTokenValue(point, 'discount')),
    poc: cleanEntryModelToken(extractTokenValue(point, 'poc')),
    fallback: cleanEntryModelToken(extractTokenValue(point, 'fallback'))
      ?? (anchorSource === 'daily_proxy_fallback' ? 'ohlcv_trade_plan_proxy' : null),
  }
}

function extractSizing(text: string): number | null {
  const match = text.match(/sizing\s*x\s*([0-9.]+)/i)
  const value = Number(match?.[1] ?? NaN)
  return Number.isFinite(value) ? value : null
}

function contextFromWatchPoints(points: string[]): AlphaContext | null {
  const alphaPoint = points.find((point) => point.startsWith('Alpha bucket:') || point.startsWith('Alpha overlay:'))
  const structurePoint = points.find((point) => point.startsWith('Market structure:'))
  if (!alphaPoint && !structurePoint) return null

  const risk = extractValue(alphaPoint ?? '', 'risk')
  const [volatility, liquidity] = risk ? risk.split('/') : []
  const fairValue = extractValue(structurePoint ?? '', 'fair_value')
  const [fairValueLow, fairValueHigh] = fairValue ? fairValue.split('~') : []
  const optimisticValue = extractValue(structurePoint ?? '', 'optimistic_value')
  const [optimisticValueLow, optimisticValueHigh] = optimisticValue ? optimisticValue.split('~') : []

  const legacyAlpha = alphaPoint?.match(/^Alpha (?:bucket|overlay):\s*([^,/]+)(?:\s*\/\s*([^,]+))?/)

  return {
    bucket: legacyAlpha?.[1]?.trim(),
    regime: extractValue(alphaPoint ?? '', 'regime') ?? legacyAlpha?.[2]?.trim() ?? undefined,
    sizing: extractSizing(alphaPoint ?? '') ?? undefined,
    volatility,
    liquidity,
    poc: extractValue(structurePoint ?? '', 'POC'),
    fairValueLow,
    fairValueHigh,
    optimisticValueLow,
    optimisticValueHigh,
    optimisticValueStatus: extractValue(structurePoint ?? '', 'optimistic_status') ?? undefined,
    upsideToOptimisticHighPct: extractValue(structurePoint ?? '', 'upside_to_optimistic_high_pct') ?? undefined,
    location: extractValue(structurePoint ?? '', 'location') ?? undefined,
    window: extractValue(structurePoint ?? '', 'window'),
    latestClose: extractValue(structurePoint ?? '', 'latest_close'),
  }
}

function extractMlSummary(reason: unknown): string | null {
  if (typeof reason !== 'string') return null
  const bracket = reason.match(/【ML】\s*([^｜\n]+)/)
  if (bracket?.[1]) return bracket[1].trim()
  const plain = reason.match(/\[ML\]\s*([^|\n]+)/)
  return plain?.[1]?.trim() ?? null
}

function parseForecastData(raw: unknown): any | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function parseObject(raw: unknown): any | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function timesFmSidecarFromForecast(forecast: any): MlDiagnosticsSummary['timesfmSidecar'] | null {
  const sidecar = parseObject(forecast?.timesfm_sidecar ?? forecast?.timesfmSidecar)
  if (!sidecar) return null
  const features = parseObject(sidecar.features) ?? {}
  const featureKeys = Array.isArray(sidecar.featureKeys)
    ? sidecar.featureKeys.map(String)
    : Object.keys(features).sort()
  const populatedFeatureCount = Number.isFinite(Number(sidecar.populatedFeatureCount))
    ? Number(sidecar.populatedFeatureCount)
    : featureKeys.filter((key) => features[key] !== null && features[key] !== undefined && features[key] !== '').length
  return {
    schemaVersion: sidecar.schemaVersion ?? sidecar.schema_version ?? null,
    layer: sidecar.layer ?? null,
    role: sidecar.role ?? null,
    directAlphaBlocked: sidecar.directAlphaBlocked ?? sidecar.direct_alpha_blocked ?? null,
    eligibleForL2FeatureEnrichment: sidecar.eligibleForL2FeatureEnrichment ?? sidecar.eligible_for_l2_feature_enrichment ?? null,
    l2FeatureInputActive: sidecar.l2FeatureInputActive ?? sidecar.l2_feature_input_active ?? null,
    l2FeatureInputBlockedReason: sidecar.l2FeatureInputBlockedReason ?? sidecar.l2_feature_input_blocked_reason ?? null,
    currentAllowedUse: Array.isArray(sidecar.currentAllowedUse)
      ? sidecar.currentAllowedUse.map(String)
      : Array.isArray(sidecar.current_allowed_use)
        ? sidecar.current_allowed_use.map(String)
        : [],
    featureKeys,
    populatedFeatureCount,
    features,
  }
}

function timesFmSidecarFromDiagnostics(diagnostics: MlDiagnosticsSummary | null): MlDiagnosticsSummary['timesfmSidecar'] | null {
  return parseObject(diagnostics?.timesfmSidecar ?? diagnostics?.timesfm_sidecar) ?? null
}

type TradePlanContext = {
  source: 'ohlcv' | 'alpha_fallback'
  entryModelV2?: EntryPriceModelV2Ui | null
  latest: number | null
  resistance: number | null
  confirmation: number | null
  support: number | null
  atrDefense: number | null
  volumeNode: number | null
  buyReferenceLow?: number | null
  buyReferenceHigh?: number | null
  optimisticLow?: number | null
  optimisticHigh?: number | null
  ma20: number | null
  ma60: number | null
  levels: TradingPlanLevels | null
}

const STRONG_BREAKOUT_CHASE_PCT = 0.018

function scoreV2PayloadFromRec(rec: any): any | null {
  const raw = parseObject(rec?.score_components) ?? parseObject(rec?.score_v2)
  const nested = parseObject(raw?.payload)
  const payload = nested?.version === 'score_v2' || nested?.source === 'score_v2' ? nested : raw
  if (!payload) return null
  const hasScoreV2Marker = payload.version === 'score_v2' || payload.source === 'score_v2'
  const hasScoreV2Score = Number.isFinite(Number(payload.finalScore ?? payload.total))
  const hasScoreV2Components = parseObject(payload.components) != null
  return hasScoreV2Marker && (hasScoreV2Score || hasScoreV2Components)
    ? { ...payload, version: 'score_v2', source: payload.source ?? 'score_v2' }
    : null
}

function scoreComponentValue(rec: any, key: string): number {
  const row = buildScoreBreakdownViewModel(rec ?? {}).rows.find((item) => item.key === key)
  return Number.isFinite(row?.value) ? Number(row?.value) : 0
}

function expectsFormalMlVote(rec: any): boolean {
  const lane = String(rec?.recommendation_lane ?? '').toLowerCase()
  if (lane === 'emerging_watchlist' || lane === 'research_only') return false
  const signal = String(rec?.signal ?? '').trim()
  if (!signal) return false
  const hardGate = parseObject(rec?.l05_hard_gate)
  if (hardGate?.ml_slate_allowed === false) return false
  return true
}

function mlVoteSummaryFromRec(rec: any): MlVoteSummary | null {
  if (!expectsFormalMlVote(rec)) return null
  const persisted = parseObject(rec.ml_vote_summary)
  if (persisted && Number(persisted.total ?? 0) <= DIRECT_ALPHA_VOTE_MODEL_NAMES.length) {
    const persistedCoreFamilyVote = parseObject(persisted.coreFamilyVote ?? persisted.core_family_vote)
    const reported = Number(persisted.reported ?? 0)
    const evidence = Number(persisted.bullish ?? 0) + Number(persisted.bearish ?? 0) + Number(persisted.flat ?? 0)
    if (persistedCoreFamilyVote || reported > 0 || evidence > 0 || scoreComponentValue(rec, 'mlEdge') <= 0) {
      return {
        ...persisted,
        coreFamilyVote: persistedCoreFamilyVote ?? persisted.coreFamilyVote ?? null,
        forecastPct: normalizePersistedForecastPctForUi(persisted),
      }
    }
  }
  const forecast = parseForecastData(rec.prediction_forecast_data)
  const models = Array.isArray(forecast?.models)
    ? forecast.models.filter((model: any) => isAlphaPredictionModelName(model?.name ?? model?.model_name ?? model))
    : []
  const weights = forecast?.ensemble_v2?.weights && typeof forecast.ensemble_v2.weights === 'object'
    ? forecast.ensemble_v2.weights
    : {}
  const diagnostics = forecast?.ensemble_v2?.ic_weight_diagnostics && typeof forecast.ensemble_v2.ic_weight_diagnostics === 'object'
    ? forecast.ensemble_v2.ic_weight_diagnostics
    : {}
  const thresholds = forecast?.ensemble_v2?.rank_signal_thresholds && typeof forecast.ensemble_v2.rank_signal_thresholds === 'object'
    ? forecast.ensemble_v2.rank_signal_thresholds
    : null
  const coreFamilyVote = parseObject(forecast?.core_family_vote ?? forecast?.coreFamilyVote ?? forecast?.ensemble_v2?.family_vote)
  const trackedWeightKeys = Object.keys(weights).filter(isAlphaPredictionModelName)
  const total = Math.max(DIRECT_ALPHA_VOTE_MODEL_NAMES.length, trackedWeightKeys.length, models.length)
  if (!forecast || total <= 0) return null
  const bullish = models.filter((model: any) => String(model?.direction ?? '').toLowerCase().includes('up')).length
  const bearish = models.filter((model: any) => String(model?.direction ?? '').toLowerCase().includes('down')).length
  return {
    bullish,
    bearish,
    flat: Math.max(0, models.length - bullish - bearish),
    reported: models.length,
    missing: Math.max(0, total - models.length),
    total,
    forecastPct: normalizeForecastPctForUi(forecast.ensemble_v2?.forecast_pct),
    icWeightScope: forecast.ensemble_v2?.ic_weight_scope ?? forecast.stock_meta?.market_segment ?? null,
    thresholds: thresholds
      ? {
          bullish: Number(thresholds.buyThreshold ?? thresholds.strongBuyThreshold),
          bearish: Number(thresholds.sellThreshold ?? thresholds.strongSellThreshold),
          adjustment: Number(thresholds.confidence_delta ?? 0),
        }
      : undefined,
    zeroWeightModels: Object.entries(weights)
      .filter(([name, value]) => isAlphaPredictionModelName(name) && Number(value) <= 0)
      .map(([name]) => name),
    validationBlockedModels: Object.entries(diagnostics)
      .filter(([, detail]: [string, any]) => String(detail?.validation_status ?? '').toUpperCase() === 'FAIL')
      .map(([name]) => name),
    coreFamilyVote,
  }
}

function mlDiagnosticsFromRec(rec: any): MlDiagnosticsSummary | null {
  if (!expectsFormalMlVote(rec)) return null
  const persisted = parseObject(rec.ml_diagnostics)
  const forecast = parseForecastData(rec.prediction_forecast_data)
  if (persisted) {
    return {
      ...persisted,
      timesfmSidecar: timesFmSidecarFromDiagnostics(persisted) ?? timesFmSidecarFromForecast(forecast),
    }
  }
  if (!forecast) return null
  const ev2 = forecast?.ensemble_v2 && typeof forecast.ensemble_v2 === 'object'
    ? forecast.ensemble_v2
    : {}
  const weights = ev2?.weights && typeof ev2.weights === 'object'
    ? ev2.weights
    : {}
  const diagnostics = ev2?.ic_weight_diagnostics && typeof ev2.ic_weight_diagnostics === 'object'
    ? ev2.ic_weight_diagnostics
    : {}
  const dispersion = forecast?.dispersion_diagnostics && typeof forecast.dispersion_diagnostics === 'object'
    ? forecast.dispersion_diagnostics
    : {}
  const zeroWeightModels = Array.isArray(dispersion.zero_weight_models)
    ? dispersion.zero_weight_models.filter(isAlphaPredictionModelName)
    : Object.entries(weights)
      .filter(([name, value]) => isAlphaPredictionModelName(name) && Number(value) <= 0)
      .map(([name]) => name)

  return {
    totalAlphaModels: DIRECT_ALPHA_VOTE_MODEL_NAMES.length,
    activeWeightCount: Object.entries(weights).filter(([name, value]) => isAlphaPredictionModelName(name) && Number(value) > 0).length,
    zeroWeightModels,
    contributingModels: Array.isArray(ev2.contributing_models) ? ev2.contributing_models.filter(isAlphaPredictionModelName) : [],
    validationBlockedModels: Object.entries(diagnostics)
      .filter(([, detail]: [string, any]) => String(detail?.validation_status ?? '').toUpperCase() === 'FAIL')
      .map(([name]) => name)
      .filter(isAlphaPredictionModelName),
    icWeightScope: ev2.ic_weight_scope ?? forecast.stock_meta?.market_segment ?? null,
    forecastCalibration: {
      method: ev2.forecast_calibration_method ?? null,
      source: ev2.forecast_pct_source ?? null,
      sampleCount: Number.isFinite(Number(ev2.forecast_calibration_sample_count)) ? Number(ev2.forecast_calibration_sample_count) : null,
      binSamples: Number.isFinite(Number(ev2.forecast_calibration_bin_samples)) ? Number(ev2.forecast_calibration_bin_samples) : null,
      bin: ev2.forecast_calibration_bin ?? null,
    },
    dispersion: {
      rawModelCount: Number.isFinite(Number(dispersion.raw_model_count)) ? Number(dispersion.raw_model_count) : null,
      rawRankStd: Number.isFinite(Number(dispersion.raw_rank_std)) ? Number(dispersion.raw_rank_std) : null,
      mergeCompression: Number.isFinite(Number(dispersion.merge_compression)) ? Number(dispersion.merge_compression) : null,
      weightHhi: Number.isFinite(Number(dispersion.weight_hhi)) ? Number(dispersion.weight_hhi) : null,
    },
    timesfmSidecar: timesFmSidecarFromForecast(forecast),
  }
}

function mlMetadataGapText(rec: any, summary: MlVoteSummary | null): string | null {
  if (!expectsFormalMlVote(rec)) return null
  const mlScore = scoreComponentValue(rec, 'mlEdge')
  if (!Number.isFinite(mlScore) || mlScore <= 0) return null
  const reported = Number(summary?.reported ?? 0)
  const votes = Number(summary?.bullish ?? 0) + Number(summary?.bearish ?? 0) + Number(summary?.flat ?? 0)
  if (summary && (reported > 0 || votes > 0)) return null
  return `ML 分數 ${fmtNumber(mlScore, 1)} 來自後端 scalar score，但投票明細尚未對齊 business date，暫不顯示 0/N 這種誤導訊息。`
}

function formatMlVoteSummary(summary: MlVoteSummary | null): string | null {
  if (!summary) return null
  const total = Number(summary.total ?? 0)
  if (!Number.isFinite(total) || total <= 0) return null
  const familyText = coreFamilyVoteBadgeText(summary)
  if (familyText) return familyText
  const bullish = Number(summary.bullish ?? 0)
  const bearish = Number(summary.bearish ?? 0)
  const missing = Number(summary.missing ?? Math.max(0, total - bullish - bearish - Number(summary.flat ?? 0)))
  const reported = Number(summary.reported ?? total - missing)
  if (reported <= 0 || bullish + bearish + Number(summary.flat ?? 0) <= 0) {
    return `L3 ML 投票資料不足（${Math.max(0, reported)}/${total} 回報）`
  }
  const forecastPct = displayForecastPct(summary)
  const forecast = typeof forecastPct === 'number' && Number.isFinite(forecastPct)
    ? `，校準預期${forecastPct >= 0 ? '+' : ''}${forecastPct.toFixed(1)}%`
    : ''
  const missingText = missing > 0 ? `，${missing}/${total}未回傳` : ''
  const flat = Number(summary.flat ?? Math.max(0, total - bullish - bearish - missing))
  const flatText = flat > 0 ? `、${flat}/${total}觀望` : ''
  return `${bullish}/${total}看漲、${bearish}/${total}看跌${flatText}${missingText}${forecast}`
}

function formatMlVoteSummaryReadable(summary: MlVoteSummary | null): string | null {
  if (!summary) return null
  const total = Number(summary.total ?? 0)
  if (!Number.isFinite(total) || total <= 0) return null
  const bullish = Number(summary.bullish ?? 0)
  const bearish = Number(summary.bearish ?? 0)
  const flat = Number(summary.flat ?? 0)
  const reported = Number(summary.reported ?? bullish + bearish + flat)
  const missing = Number(summary.missing ?? Math.max(0, total - reported))
  if (reported <= 0 || bullish + bearish + flat <= 0) {
    return `L3 ML 投票資料不足（${Math.max(0, reported)}/${total} 回報）`
  }
  const forecastPct = displayForecastPct(summary)
  const forecast = typeof forecastPct === 'number' && Number.isFinite(forecastPct)
    ? `，校準預期${forecastPct >= 0 ? '+' : ''}${forecastPct.toFixed(1)}%`
    : ''
  const flatText = flat > 0 ? `，${flat}/${total}中性` : ''
  const missingText = missing > 0 ? `，${missing}/${total}未回報` : ''
  const activeWeight = Number(summary.activeWeightCount ?? total - (summary.zeroWeightModels?.length ?? 0))
  const weightText = Number.isFinite(activeWeight)
    ? `；採信權重 ${Math.max(0, activeWeight)}/${total}`
    : ''
  const zeroWeightText = Array.isArray(summary.zeroWeightModels) && summary.zeroWeightModels.length > 0
    ? `（0 權重：${summary.zeroWeightModels.join('/')}，IC/lifecycle gate）`
    : ''
  return `${bullish}/${total}原始看漲、${bearish}/${total}原始看跌${flatText}${missingText}${forecast}${weightText}${zeroWeightText}`
}

function formatMlVoteSummaryForBadge(summary: MlVoteSummary | null): string | null {
  if (!summary) return null
  const total = Number(summary.total ?? 0)
  if (!Number.isFinite(total) || total <= 0) return null
  const familyText = coreFamilyVoteBadgeText(summary)
  if (familyText) return familyText
  const bullish = Number(summary.bullish ?? 0)
  const bearish = Number(summary.bearish ?? 0)
  const flat = Number(summary.flat ?? Math.max(0, total - bullish - bearish))
  const reported = Number(summary.reported ?? bullish + bearish + flat)
  const missing = Number(summary.missing ?? Math.max(0, total - reported))
  const forecastPct = displayForecastPct(summary)
  const forecast = typeof forecastPct === 'number' && Number.isFinite(forecastPct)
    ? `，校準預期${forecastPct >= 0 ? '+' : ''}${forecastPct.toFixed(1)}%`
    : ''
  const flatText = flat > 0 ? `、${flat}/${total}中性` : ''
  const missingText = missing > 0 ? `、${missing}/${total}缺資料` : ''
  const activeWeight = Number(summary.activeWeightCount ?? total - (summary.zeroWeightModels?.length ?? 0))
  const weightText = Number.isFinite(activeWeight)
    ? `；採信權重${Math.max(0, activeWeight)}/${total}`
    : ''
  const zeroWeightText = Array.isArray(summary.zeroWeightModels) && summary.zeroWeightModels.length > 0
    ? `（${summary.zeroWeightModels.length}模型0權重）`
    : ''
  return `${bullish}/${total}原始看漲、${bearish}/${total}原始看跌${flatText}${missingText}${forecast}${weightText}${zeroWeightText}`
}

function MlDiagnosticsStrip({ diagnostics }: { diagnostics: MlDiagnosticsSummary | null }) {
  if (!diagnostics) return null
  const total = Number(diagnostics.totalAlphaModels ?? DIRECT_ALPHA_VOTE_MODEL_NAMES.length)
  const active = Number(diagnostics.activeWeightCount ?? 0)
  const zeroWeightModels = diagnostics.zeroWeightModels ?? []
  const blockedModels = diagnostics.validationBlockedModels ?? []
  const calibration = diagnostics.forecastCalibration
  const dispersion = diagnostics.dispersion
  const thresholds = diagnostics.rankSignalThresholds ?? {}
  const buyThreshold = finiteMetric((thresholds as any).buyThreshold ?? (thresholds as any).bullish)
  const sellThreshold = finiteMetric((thresholds as any).sellThreshold ?? (thresholds as any).bearish)
  const timesFmSidecar = timesFmSidecarFromDiagnostics(diagnostics)
  const chips: string[] = []

  chips.push(`權重 ${Number.isFinite(active) ? active : 0}/${Number.isFinite(total) ? total : DIRECT_ALPHA_VOTE_MODEL_NAMES.length}`)
  if (timesFmSidecar) {
    const featureCount = Number(timesFmSidecar.populatedFeatureCount ?? timesFmSidecar.featureKeys?.length ?? 0)
    const l2Eligible = boolFromValue(timesFmSidecar.eligibleForL2FeatureEnrichment)
    const l2Active = boolFromValue(timesFmSidecar.l2FeatureInputActive)
    const l2BlockedReason = String(timesFmSidecar.l2FeatureInputBlockedReason ?? '')
    const directBlocked = boolFromValue(timesFmSidecar.directAlphaBlocked)
    chips.push(`${timesFmSidecar.layer ?? 'L2'} TimesFM sidecar`)
    chips.push(`TimesFM features ${Number.isFinite(featureCount) ? featureCount : 0}`)
    chips.push(`L2 input ${l2Active ? 'ACTIVE' : 'PENDING'}`)
    if (!l2Active && l2BlockedReason.includes('formal137')) chips.push('L2 block formal137/retrain/release')
    else if (l2Eligible) chips.push('L2 enrich eligible only')
    if (directBlocked) chips.push('TimesFM direct alpha blocked')
  }
  if (diagnostics.icWeightScope) chips.push(`IC scope ${diagnostics.icWeightScope}`)
  if (buyThreshold != null && sellThreshold != null) chips.push(`動態門檻 BUY ${fmtNumber(buyThreshold, 3)} / SELL ${fmtNumber(sellThreshold, 3)}`)
  if (dispersion?.rawRankStd != null) chips.push(`模型分歧 σ ${fmtNumber(dispersion.rawRankStd, 3)}`)
  if (dispersion?.mergeCompression != null) chips.push(`合併壓縮 ${fmtNumber(dispersion.mergeCompression, 2)}`)
  if (calibration?.method || calibration?.source) {
    const samples = calibration.sampleCount != null ? ` / 樣本 ${fmtNumber(calibration.sampleCount, 0)}` : ''
    chips.push(`預期值校準 ${calibration.method ?? calibration.source}${samples}`)
  }

  const warnings = [
    zeroWeightModels.length > 0 ? `0 權重：${zeroWeightModels.join('、')}` : null,
    blockedModels.length > 0 ? `驗證擋下：${blockedModels.join('、')}` : null,
  ].filter(Boolean)

  return (
    <div className="mt-2 rounded-xl border border-indigo-300/18 bg-indigo-400/[0.06] p-2">
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <Badge key={chip} variant="outline" className="border-indigo-300/25 bg-indigo-400/[0.10] px-2 py-0.5 text-[11px] text-indigo-100">
            {chip}
          </Badge>
        ))}
      </div>
      {warnings.length > 0 && (
        <p className="text-[11px] leading-relaxed text-amber-200">
          {warnings.join('；')}。
        </p>
      )}
    </div>
  )
}

function translateRecommendationReason(reason: unknown): string {
  if (typeof reason !== 'string') return ''
  return reason.trim()
}

function alphaContextFromRec(rec: any, points: string[]): AlphaContext | null {
  const alpha = rec.alpha_context
  if (!alpha) return contextFromWatchPoints(points)

  const risk = alpha.risk_overlay ?? {}
  const structure = risk.structure_detail ?? {}
  return {
    bucket: alpha.edge_bucket,
    regime: alpha.regime,
    sizing: alpha.sizing_multiplier,
    scoreAdjustment: alpha.score_adjustment,
    volatility: risk.volatility_level,
    liquidity: risk.liquidity_level,
    skip: risk.skip,
    poc: structure.poc_price,
    fairValueLow: structure.fair_value_low,
    fairValueHigh: structure.fair_value_high,
    optimisticValueLow: structure.optimistic_value_low,
    optimisticValueHigh: structure.optimistic_value_high,
    optimisticValueStatus: structure.optimistic_value_status,
    upsideToOptimisticHighPct: structure.upside_to_optimistic_high_pct,
    location: structure.price_location,
    window: structure.window_start_date && structure.window_end_date
      ? `${structure.window_start_date}~${structure.window_end_date}`
      : undefined,
    latestClose: structure.latest_close,
  }
}

function ScoreBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const safeValue = Number.isFinite(value) ? value : 0
  const safeMax = Number.isFinite(max) ? max : 0
  const pct = safeMax > 0 ? Math.max(0, Math.min(100, Math.round((safeValue / safeMax) * 100))) : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="min-w-16 shrink-0 font-medium text-slate-400">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.09]">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-14 text-right sv-num font-medium text-slate-300">
        {fmtNumber(safeValue, 1)}/{fmtNumber(safeMax, 0)}
      </span>
    </div>
  )
}

function signedText(value: number | null | undefined, decimals = 1): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return '-'
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}`
}

function ScoreFormulaSummary({ viewModel }: { viewModel: ReturnType<typeof buildScoreBreakdownViewModel> }) {
  return (
    <div className="rounded-[18px] border border-white/[0.08] bg-[linear-gradient(135deg,rgba(22,26,35,0.88),rgba(12,14,20,0.96))] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-200">基礎分數與 Alpha 調整</p>
        <span className="sv-num text-xs font-medium text-slate-400">
          {fmtNumber(viewModel.finalScore, 1)} = {fmtNumber(viewModel.baseScore, 1)} {viewModel.alphaAdjustment >= 0 ? '+' : '-'} {fmtNumber(Math.abs(viewModel.alphaAdjustment), 1)}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-cyan-400/18 bg-cyan-400/[0.055] p-2">
          <p className="text-[10px] font-medium text-cyan-200/80">基礎分數</p>
          <p className="mt-0.5 sv-num text-lg font-semibold text-cyan-100">{fmtNumber(viewModel.baseScore, 1)}</p>
        </div>
        <div className="rounded-xl border border-amber-400/18 bg-amber-400/[0.07] p-2">
          <p className="text-[10px] font-medium text-amber-200/80">Alpha 調整</p>
          <p className="mt-0.5 sv-num text-lg font-semibold text-amber-100">{signedText(viewModel.alphaAdjustment)}</p>
        </div>
        <div className="rounded-xl border border-emerald-400/18 bg-emerald-400/[0.06] p-2">
          <p className="text-[10px] font-medium text-emerald-200/80">最終分數</p>
          <p className="mt-0.5 sv-num text-lg font-semibold text-emerald-100">{fmtNumber(viewModel.finalScore, 1)}</p>
        </div>
      </div>
      {Math.abs(viewModel.residual) >= 0.1 && (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          資料校準差 {signedText(viewModel.residual)}，代表後端總分與目前可拆解欄位仍有不同步。
        </p>
      )}
    </div>
  )
}

function alphaDetailsFromRec(rec: any): any[] {
  const payload = scoreV2PayloadFromRec(rec)
  const alphaReason = parseObject(payload?.alphaReason)
  const details = Array.isArray(alphaReason?.details) ? alphaReason.details : []
  return details.filter((item: any) => item && item.value != null)
}

function hasInformativeBreakdownRow(row: { value?: unknown; explanation?: unknown }): boolean {
  const value = Number(row.value)
  if (Number.isFinite(value) && value > 0) return true
  const explanation = String(row.explanation ?? '').trim().toLowerCase()
  if (!explanation) return false
  return !(
    explanation.includes('missing') ||
    explanation.includes('unavailable') ||
    explanation.includes('缺少') ||
    explanation.includes('缺資料') ||
    explanation.includes('資料不足')
  )
}

function ScoreBreakdownV2({ rec }: { rec: any }) {
  const viewModel = buildScoreBreakdownViewModel(rec)
  const alphaDetails = alphaDetailsFromRec(rec)
  const technicalRows = viewModel.technicalRows.filter(hasInformativeBreakdownRow)
  const showAlpha = viewModel.hasBackendPayload && alphaDetails.length > 0

  if (technicalRows.length === 0 && !showAlpha) return null

  return (
    <div className="rounded-[18px] border border-white/[0.08] bg-[linear-gradient(135deg,rgba(20,23,31,0.9),rgba(11,13,19,0.96))] p-3 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-semibold text-slate-200">Score V2 分解</span>
        <span className="sv-num text-[11px] font-medium text-slate-500">技術結構 + Alpha 明細</span>
      </div>
      {technicalRows.length > 0 && (
        <div className="mt-2 space-y-2 rounded-xl border border-violet-400/20 bg-violet-400/[0.06] p-2">
          <p className="font-semibold text-violet-100">技術結構細項</p>
          {technicalRows.map((item) => (
            <div key={item.key} className="space-y-1">
              <ScoreBar label={item.label} value={item.value} max={item.max} color={item.color} />
              {item.explanation && (
                <p className="pl-[72px] text-[11px] leading-relaxed text-slate-400 sm:pl-[74px]">
                  {item.explanation}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
      {showAlpha && (
        <div className="mt-2 space-y-1 rounded-xl border border-amber-400/18 bg-amber-400/[0.055] p-2 text-[11px] leading-relaxed text-slate-300">
          <p className="font-semibold text-amber-100">Alpha 調整明細</p>
          {alphaDetails.map((item, index) => (
            <p key={`${item.key ?? item.label}-${index}`}>
              {item.label ?? item.key}: {Number(item.value) >= 0 ? '+' : ''}{fmtNumber(item.value, 1)}
              {item.explain ? `, ${item.explain}` : ''}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

function fmtPercentValue(value: unknown, decimals = 1): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '-'
  const pct = Math.abs(numeric) <= 1 ? numeric * 100 : numeric
  return `${fmtNumber(pct, decimals)}%`
}

function FundamentalSnapshotBlock({ rec }: { rec: any }) {
  const stockId = Number(rec.stock_id ?? rec.stockId ?? rec.id)
  const score = scoreComponentValue(rec, 'fundamentalQuality')
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['recommendation-card-financials', stockId],
    queryFn: () => stocksApi.financials(stockId, 1),
    enabled: Number.isFinite(stockId) && stockId > 0,
    staleTime: 6 * 60 * 60_000,
  })
  const latest = Array.isArray(rows) ? rows[0] as any : null
  if (!latest && !isLoading && score <= 0) return null
  const metrics = [
    { label: 'EPS', value: latest?.eps == null ? '-' : fmtNumber(latest.eps, 2), note: latest?.period ?? 'latest' },
    { label: 'ROE', value: latest?.roe == null ? '-' : fmtPercentValue(latest.roe), note: '獲利效率' },
    { label: 'P/E', value: latest?.pe == null ? '-' : fmtNumber(latest.pe, 1), note: '估值' },
    { label: 'P/B', value: latest?.pb == null ? '-' : fmtNumber(latest.pb, 1), note: '淨值評價' },
    { label: '殖利率', value: latest?.dividend_yield == null ? '-' : fmtPercentValue(latest.dividend_yield), note: '股利' },
    { label: '營收 YoY', value: latest?.revenue_growth_yoy == null ? '-' : fmtPercentValue(latest.revenue_growth_yoy), note: '成長' },
  ]

  return (
    <div className="rounded-[18px] border border-amber-300/18 bg-amber-300/[0.055] p-3 text-xs shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="font-semibold text-amber-100">基本面摘要</p>
        <span className="sv-num rounded-full border border-amber-200/20 bg-amber-300/10 px-2 py-0.5 text-[11px] text-amber-100">
          Score V2 基本面 {fmtNumber(score, 1)}/20
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {metrics.map((item) => (
          <div key={item.label} className="rounded-xl border border-white/[0.06] bg-black/15 p-2">
            <p className="text-[11px] font-medium text-slate-400">{item.label}</p>
            <p className="mt-1 sv-num text-sm font-bold text-slate-100">{isLoading ? '讀取中' : item.value}</p>
            <p className="mt-0.5 text-[10px] text-slate-500">{item.note}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function StrategyRouterEvidenceBlock({ router }: { router: StrategyRouterSummary | null }) {
  if (!router) return null
  const routerDecision = String(router?.strategy_router_decision ?? 'observe').replace(/_/g, ' ')
  const formalL2Queue = boolFromValue(router?.formal_l2_queue)
  const observeOnlyTopUp = boolFromValue(router?.observe_only_top_up)
  const strategyCount = countText(router?.strategy_count ?? router?.strategy_ids?.length)
  const familyCount = countText(router?.family_count ?? router?.family_ids?.length)
  const researchCount = countText(router?.research_strategy_count ?? router?.research_strategy_ids?.length)
  const teacherModelList = (router.expected_teacher_models?.length ? router.expected_teacher_models : [...DIRECT_ALPHA_VOTE_MODEL_NAMES])
    .filter((model) => normalizeModelName(model) !== 'TimesFM')
  const teacherModels = teacherModelList.length ? teacherModelList.join(' / ') : DIRECT_ALPHA_VOTE_MODEL_LABEL

  return (
    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.05] p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-emerald-700 dark:text-emerald-300">L1.5 PLE/Listwise Router</span>
        <span className="sv-num text-[11px] text-muted-foreground">diversified ML slate, no forced fill</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <MetricPill label="route score" value={percentText(router.route_score)} />
        <MetricPill label="decision" value={routerDecision} />
        <MetricPill label="formal L2" value={formalL2Queue ? 'YES' : observeOnlyTopUp ? 'NO / observe' : 'NO'} />
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-4">
        <MetricPill label="support" value={`${strategyCount} strategies / ${familyCount} families`} />
        <MetricPill label="diversity" value={percentText(router.diversity_contribution)} />
        <MetricPill label="risk affinity" value={percentText(router.risk_adjusted_affinity)} />
        <MetricPill label="uncertainty" value={percentText(router.uncertainty)} />
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <MetricPill label="teacher labels" value={`${countText(router.teacher_label_count)} / ${countText(router.expected_teacher_count ?? 9)}`} />
        <MetricPill label="teacher align" value={percentText(router.teacher_alignment)} />
        <MetricPill label="top-up scope" value={router.no_topup_policy_scope ?? 'formal_ml_slate_no_minimum_fill'} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{router.router_method ?? 'multi_strategy_ple_listwise_distillation_router'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{router.router_scope ?? 'full_candidate_slate_to_diversified_ml_slate'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{router.decision_policy ?? 'diversified_ml_slate_not_topk'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{router.selection_policy ?? 'quality_floor_max_capacity_no_forced_fill'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{router.capacity_policy ?? 'max_only_no_minimum_no_topup'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{router.output_scope ?? 'candidate_route_score_ml_slate_eligibility_family_exposure_diversity_risk_uncertainty'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{router.teacher_label_scope ?? 'strategy_priors_future_reward_risk_diversity_9ml_teacher_labels'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{router.observe_topup_policy ?? 'research_observe_only_never_formal_l2'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">research attribution {researchCount}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">teachers {teacherModels}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{TIMESFM_SIDECAR_LABEL}</span>
      </div>
    </div>
  )
}

function EvidenceFusionBlock({ fusion }: { fusion: Layer35FusionSummary | null }) {
  if (!fusion) return null
  const conflict = String(fusion?.conflict_level ?? '').toLowerCase()
  const conflictTone = conflict === 'high'
    ? 'text-rose-600 dark:text-rose-300'
    : conflict === 'medium'
      ? 'text-amber-600 dark:text-amber-300'
      : 'text-emerald-600 dark:text-emerald-300'
  const fusionGap = (fusion as Record<string, unknown>)[['strategy_ml', 'score_gap'].join('_')]
  const hardShrinkAllowed = boolFromValue(fusion.hard_shrink_allowed)
  const finalAllocator = boolFromValue(fusion.is_final_allocator)

  return (
    <div className="rounded-lg border border-lime-500/20 bg-lime-500/[0.05] p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-lime-700 dark:text-lime-300">L3.5 Evidence Fusion</span>
        <span className={cn('sv-num text-[11px] font-semibold normal-case', conflictTone)}>
          {fusion.conflict_level ?? fusion.decision ?? 'unknown'}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <MetricPill label="L1.5 route" value={percentText(fusion.layer1_route_score)} />
        <MetricPill label="L3 family" value={percentText(fusion.layer3_formal_family_score)} />
        <MetricPill label="score gap" value={percentText(fusionGap)} />
        <MetricPill label="models" value={countText(fusion.contributing_model_count)} />
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <MetricPill label="hard shrink" value={hardShrinkAllowed ? 'enabled' : 'disabled'} />
        <MetricPill label="final allocator" value={finalAllocator ? 'YES' : 'NO'} />
        <MetricPill label="action" value={String(fusion.recommended_action ?? '-').replace(/_/g, ' ')} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{fusion.fusion_method ?? 'strategy_router_vs_8ml_formal_family_evidence_calibration'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{fusion.input_scope ?? 'layer15_route_score_layer3_formal_family_score_uncertainty_active_family_count'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{fusion.decision_policy ?? 'observe_only_no_hard_shrink'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{fusion.selection_policy ?? 'no_candidate_drop_no_topk_no_minimum_fill'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{fusion.output_scope ?? ['conflict_level_strategy', 'ml', 'score_gap_supportive_or_conflicted_evidence'].join('_')}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">final {fusion.final_allocation_owner ?? 'layer4_sparse_allocation'}</span>
      </div>
    </div>
  )
}

function HardGateEvidenceBlock({ gate }: { gate: HardGateSummary | null }) {
  if (!gate) return null
  const hardBlocked = boolFromValue(gate.hard_blocked)
  const pendingBlocked = boolFromValue(gate.pending_buy_blocked)
  const mlAllowed = boolFromValue(gate.ml_slate_allowed ?? gate.eligible_for_ml)
  const tone = hardBlocked
    ? 'border-rose-500/25 bg-rose-500/[0.06] text-rose-700 dark:text-rose-300'
    : pendingBlocked
      ? 'border-amber-500/25 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300'
      : 'border-sky-500/25 bg-sky-500/[0.06] text-sky-700 dark:text-sky-300'

  return (
    <div className={cn('rounded-lg border p-3 text-xs', tone)}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium">L0.5 Hard Gate</span>
        <span className="sv-num text-[11px] text-muted-foreground">tradeability / data trust, not alpha ranker</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <MetricPill label="lane" value={String(gate.recommendation_lane ?? '-')} />
        <MetricPill label="board" value={String(gate.board_type ?? gate.market_segment ?? '-')} />
        <MetricPill label="ML slate" value={mlAllowed ? 'allowed' : 'blocked'} />
        <MetricPill label="pending buy" value={pendingBlocked ? 'blocked' : 'allowed'} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{gate.decision_policy ?? 'exclude_untradable_or_untrusted_only_not_alpha_ranker'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{gate.gate_scope ?? 'tradeability_data_trust_pending_buy'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{gate.tradability_tier ?? 'tradability unknown'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{gate.board_reason ?? 'board reason unknown'}</span>
      </div>
    </div>
  )
}

function UniverseFeatureEvidenceBlock({ universe }: { universe: UniverseFeatureSummary | null }) {
  if (!universe) return null
  const passed = boolFromValue(universe.universe_passed)
  const featureGroups = universe.feature_groups?.length
    ? universe.feature_groups.join(' / ')
    : 'feature groups unavailable'
  const liquidity = finiteMetric(universe.avg_daily_turnover)

  return (
    <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.05] p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-cyan-700 dark:text-cyan-300">L0 Universe / Features</span>
        <span className="sv-num text-[11px] text-muted-foreground">feature coverage, not top-k</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <MetricPill label="universe" value={passed ? 'PASS' : String(universe.universe_decision ?? 'unknown')} />
        <MetricPill label="source count" value={countText(universe.source_universe_count)} />
        <MetricPill label="base score" value={fmtNumber(universe.base_score, 1)} />
        <MetricPill label="feature groups" value={countText(universe.feature_group_count ?? universe.feature_groups?.length)} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{universe.decision_policy ?? 'feature_materialization_only_not_selector'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{universe.selection_policy ?? 'no_topk_no_shrink'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{featureGroups}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">liquidity {liquidity == null ? '-' : fmtNumber(liquidity, 0)}</span>
      </div>
    </div>
  )
}

function StrategyLabelerEvidenceBlock({ labeler }: { labeler: StrategyLabelerSummary | null }) {
  if (!labeler) return null
  const vectors = [
    boolFromValue(labeler.has_strategy_affinity_vector) ? 'affinity' : null,
    boolFromValue(labeler.has_family_affinity_vector) ? 'family affinity' : null,
    boolFromValue(labeler.has_weak_label_vector) ? 'weak labels' : null,
    boolFromValue(labeler.has_hit_vector) ? 'hits' : null,
    boolFromValue(labeler.has_position_weight_vector) ? 'position weights' : null,
    boolFromValue(labeler.has_overlap_vector) ? 'overlap' : null,
  ].filter(Boolean).join(' / ') || 'vectors unavailable'
  const familyIds = labeler.family_ids?.length ? labeler.family_ids.join(' / ') : 'families unavailable'

  return (
    <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/[0.05] p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-indigo-700 dark:text-indigo-300">L1 Strategy Labeler</span>
        <span className="sv-num text-[11px] text-muted-foreground">labels strategy views, not stock selector</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <MetricPill label="strategies" value={countText(labeler.strategy_count)} />
        <MetricPill label="families" value={countText(labeler.family_count)} />
        <MetricPill label="vector ids" value={countText(labeler.vector_strategy_count)} />
        <MetricPill label="hits" value={countText(labeler.strategy_hit_count)} />
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <MetricPill label="max affinity" value={fmtNumber(labeler.max_strategy_affinity, 1)} />
        <MetricPill label="avg affinity" value={fmtNumber(labeler.avg_strategy_affinity, 1)} />
        <MetricPill label="max overlap" value={fmtNumber(labeler.max_strategy_overlap, 2)} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{labeler.decision_policy ?? 'label_all_candidates_not_selector'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{labeler.selection_policy ?? 'no_topk_no_shrink_no_minimum_fill'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{labeler.label_scope ?? 'strategy_affinity_family_affinity_weak_labels'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">vectors {vectors}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{familyIds}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">next {labeler.next_layer_owner ?? 'layer15_multi_strategy_ple_router'}</span>
      </div>
    </div>
  )
}

function StrategyPortfolioIntelligenceBlock({ portfolio }: { portfolio: StrategyPortfolioIntelligenceSummary | null }) {
  if (!portfolio) return null
  const dimensions = portfolio.metric_dimensions?.length
    ? portfolio.metric_dimensions.slice(0, 5).join(' / ')
    : 'portfolio dimensions unavailable'
  const moreDimensions = Math.max(0, (portfolio.metric_dimensions?.length ?? 0) - 5)
  const familyIds = portfolio.family_ids?.length ? portfolio.family_ids.join(' / ') : 'families unavailable'

  return (
    <div className="rounded-lg border border-teal-500/20 bg-teal-500/[0.05] p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-teal-700 dark:text-teal-300">L1.25 FinLab Portfolio Intelligence</span>
        <span className="sv-num text-[11px] text-muted-foreground">strategy-as-asset weights, not stock selector</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <MetricPill label="strategy prior" value={fmtNumber(portfolio.strategy_prior_weight, 2)} />
        <MetricPill label="family prior" value={fmtNumber(portfolio.family_prior_weight, 2)} />
        <MetricPill label="reliability" value={percentText(portfolio.strategy_reliability)} />
        <MetricPill label="crowding" value={percentText(portfolio.strategy_crowding_score)} />
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-4">
        <MetricPill label="diversity value" value={percentText(portfolio.strategy_diversification_value)} />
        <MetricPill label="holding overlap" value={fmtNumber(portfolio.max_holding_overlap, 2)} />
        <MetricPill label="metrics" value={countText(portfolio.portfolio_metric_count)} />
        <MetricPill label="backtests" value={countText(portfolio.backtest_metric_count)} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{portfolio.decision_policy ?? 'strategy_asset_weighting_not_stock_selector'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{portfolio.selection_policy ?? 'no_stock_shrink_no_topk_no_minimum_fill'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{portfolio.output_scope ?? 'strategy_prior_family_prior_reliability_crowding_diversification'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{portfolio.method ?? 'finlab_style_strategy_as_asset_portfolio_metrics'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">source {portfolio.portfolio_metric_status ?? 'unknown'} / {portfolio.portfolio_metric_source ?? 'metric source unavailable'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">dims {dimensions}{moreDimensions ? ` +${moreDimensions}` : ''}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{familyIds}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">next {portfolio.consumed_by ?? 'layer15_multi_strategy_ple_router'}</span>
      </div>
    </div>
  )
}

function MlStackEvidenceBlock({
  coarse,
  formal,
}: {
  coarse: Layer2CoarseMlSummary | null
  formal: Layer3FormalMlSummary | null
}) {
  if (!coarse && !formal) return null
  const l2FeatureActive = boolFromValue(coarse?.l2_feature_input_active)
  const workerSeedOnly = boolFromValue(coarse?.worker_seed_only)
  const l2Models = coarse?.expected_models?.length ? coarse.expected_models.join(' / ') : 'TimesFM'
  const formalModelList = (formal?.expected_models?.length ? formal.expected_models : ['LightGBM', 'XGBoost', 'ExtraTrees', 'TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer'])
    .filter((model) => normalizeModelName(model) !== 'TimesFM')
  const l3Models = formalModelList.length ? formalModelList.join(' / ') : 'LightGBM / XGBoost / ExtraTrees / TabM / GNN / DLinear / PatchTST / iTransformer'
  const l3ContributorList = (formal?.contributing_models ?? []).filter((model) => normalizeModelName(model) !== 'TimesFM')
  const l3Contributors = l3ContributorList.length ? l3ContributorList.join(' / ') : 'no formal contributors reported'

  return (
    <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.05] p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-violet-700 dark:text-violet-300">L2 TimesFM + L3 Direct ML</span>
        <span className="sv-num text-[11px] text-muted-foreground">L2 feature sidecar; L3 8ML formal direct alpha</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <MetricPill label="L2 expected" value={countText(coarse?.expected_model_count ?? 1)} />
        <MetricPill label="L2 feature input" value={l2FeatureActive ? 'ACTIVE' : workerSeedOnly ? 'seed only' : 'PENDING'} />
        <MetricPill label="L3 direct expected" value={countText(formalModelList.length || 8)} />
        <MetricPill label="L3 active" value={countText(formal?.active_l3_model_count ?? formal?.contributing_model_count)} />
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <MetricPill label="L3 family score" value={percentText(formal?.formal_family_score)} />
        <MetricPill label="active families" value={countText(formal?.active_family_count)} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{coarse?.decision_policy ?? 'timesfm_sequence_sidecar_feature_enrichment_not_selector'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{formal?.decision_policy ?? 'eight_ml_formal_family_evidence_not_topk'}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">L2 {l2Models}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">L3 {l3Models}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{TIMESFM_SIDECAR_LABEL}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">contributors {l3Contributors}</span>
      </div>
    </div>
  )
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-background/50 p-2">
      <p className="text-[10px] normal-case text-muted-foreground">{label}</p>
      <p className="mt-0.5 break-words sv-num text-sm font-semibold text-foreground">{value}</p>
    </div>
  )
}

function SparseAllocationBlock({ allocation }: { allocation: SparseAllocationSummary | null }) {
  if (!allocation) return null
  const selected = boolFromValue(allocation.selected)
  const controller = String(allocation.controller ?? '').trim() || 'controller unavailable'
  const opb = parseObject(allocation.opb_controller)
  const opbEnabled = boolFromValue(opb?.enabled)
  const coverage = finiteMetric(allocation.return_history_coverage)
  const coverageSymbols = finiteMetric(allocation.return_history_symbol_count)
  const policyText = allocation.decision_policy === 'final_owner_no_topk_fallback'
    ? 'final owner, no top-k fallback'
    : 'sparse final owner'
  const capacityText = allocation.capacity_policy === 'maximum_capacity_not_minimum_fill'
    ? 'maximum capacity, no forced fill'
    : 'capacity is advisory'
  const methodText = allocation.allocation_method ?? 'sparse_tangent_inverse_risk_final_allocation'
  const inputScope = allocation.input_scope ?? 'post_l3_5_evidence_fusion_candidates'
  const selectionPolicy = allocation.selection_policy ?? 'positive_expected_edge_sparse_weights_no_forced_fill'
  const upstreamPolicy = allocation.upstream_conflict_policy ?? 'l3_5_flags_conflict_l4_decides_weight_not_drop'
  const allocationWeight = allocation.allocation_weight ?? allocation.single_name_weight
  const selectionReason = allocation.selection_reason ?? allocation.potential_buy_reason ?? allocation.sparse_weight_state ?? 'reason unavailable'

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-medium text-amber-700 dark:text-amber-300">L4 Sparse Allocation</span>
        <span className="sv-num text-[11px] text-muted-foreground">{policyText}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border border-border/40 bg-background/50 p-2">
          <p className="text-[10px] normal-case text-muted-foreground">decision</p>
          <p className={cn('mt-0.5 sv-num text-sm font-semibold', selected ? 'text-emerald-600 dark:text-emerald-300' : 'text-muted-foreground')}>
            {selected ? `BUY weight ${allocationWeightText(allocationWeight)}` : 'not selected / potential'}
          </p>
        </div>
        <div className="rounded-md border border-border/40 bg-background/50 p-2">
          <p className="text-[10px] normal-case text-muted-foreground">capacity</p>
          <p className="mt-0.5 sv-num text-sm font-semibold text-foreground">{allocationSlotText(allocation.buy_signal_count)}</p>
        </div>
        <div className="rounded-md border border-border/40 bg-background/50 p-2">
          <p className="text-[10px] normal-case text-muted-foreground">method</p>
          <p className="mt-0.5 break-words sv-num text-[11px] font-semibold text-foreground">{methodText}</p>
        </div>
        <div className="rounded-md border border-border/40 bg-background/50 p-2">
          <p className="text-[10px] normal-case text-muted-foreground">scope</p>
          <p className="mt-0.5 break-words sv-num text-[11px] font-semibold text-foreground">{inputScope}</p>
        </div>
        <div className="rounded-md border border-border/40 bg-background/50 p-2">
          <p className="text-[10px] normal-case text-muted-foreground">engine</p>
          <p className="mt-0.5 break-words sv-num text-[11px] font-semibold text-foreground">{allocation.engine}</p>
        </div>
        <div className="rounded-md border border-border/40 bg-background/50 p-2">
          <p className="text-[10px] normal-case text-muted-foreground">controller</p>
          <p className="mt-0.5 break-words sv-num text-[11px] font-semibold text-foreground">{controller}</p>
        </div>
        <div className="rounded-md border border-border/40 bg-background/50 p-2">
          <p className="text-[10px] normal-case text-muted-foreground">expected return</p>
          <p className="mt-0.5 sv-num text-sm font-semibold text-foreground">{percentText(allocation.expected_return, 2)}</p>
        </div>
        <div className="rounded-md border border-border/40 bg-background/50 p-2">
          <p className="text-[10px] normal-case text-muted-foreground">risk estimate</p>
          <p className="mt-0.5 sv-num text-sm font-semibold text-foreground">{percentText(allocation.risk_estimate, 2)}</p>
        </div>
        <div className="rounded-md border border-border/40 bg-background/50 p-2">
          <p className="text-[10px] normal-case text-muted-foreground">allocator rank</p>
          <p className="mt-0.5 sv-num text-sm font-semibold text-foreground">{countText(allocation.allocation_rank)}</p>
        </div>
        <div className="rounded-md border border-border/40 bg-background/50 p-2">
          <p className="text-[10px] normal-case text-muted-foreground">selection reason</p>
          <p className="mt-0.5 break-words text-[11px] font-semibold text-foreground">{selectionReason}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{selectionPolicy}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{capacityText}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">max capacity not target</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">no hard minimum fill</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">empty portfolio allowed</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">zero selection allowed</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">legacy top-k fallback off</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">{upstreamPolicy}</span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">
          return history {coverage == null ? '-' : fmtNumber(coverage, 0)}{coverageSymbols == null ? '' : `/${fmtNumber(coverageSymbols, 0)}`}
        </span>
        <span className="rounded-full border border-border/40 bg-background/50 px-2 py-0.5">
          OPB {opbEnabled ? 'enabled' : 'fallback/none'}
        </span>
      </div>
    </div>
  )
}

function InstitutionalBrokerFlowBlock({
  institutional,
  brokerFlow,
}: {
  institutional: ReturnType<typeof institutionalRawFromRec>
  brokerFlow: any | null
}) {
  if (!institutional && !brokerFlow) return null
  const aggregate = parseObject(brokerFlow?.aggregate)
  const topBuy = Array.isArray(brokerFlow?.top_buy) ? brokerFlow.top_buy as BrokerFlowRankRow[] : []
  const topSell = Array.isArray(brokerFlow?.top_sell) ? brokerFlow.top_sell as BrokerFlowRankRow[] : []
  const hasBrokerRanks = topBuy.length > 0 || topSell.length > 0

  const renderBrokerRankRows = (rows: BrokerFlowRankRow[], emptyText: string) => {
    if (!rows.length) return <p className="text-[11px] text-muted-foreground">{emptyText}</p>
    return (
      <div className="space-y-1">
        {rows.slice(0, 3).map((row, index) => {
          const name = String(row.broker_name ?? row.broker_code ?? '-')
          const netLots = row.net_lots ?? row.net_shares ?? null
          return (
            <div key={`${name}-${index}`} className="grid grid-cols-[1.25rem_minmax(0,1fr)_5.5rem] items-center gap-2 text-[11px]">
              <span className="sv-num text-muted-foreground">{index + 1}</span>
              <span className="truncate text-foreground/85" title={name}>{name}</span>
              <span className={cn('text-right sv-num tabular-nums', signedFlowClass(netLots))}>{fmtLots(netLots)}</span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.045] p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1 font-medium text-cyan-700 dark:text-cyan-300">
          <Users className="h-3.5 w-3.5" />
          籌碼原始資料
        </span>
        <span className="sv-num text-[11px] text-muted-foreground">
          {institutional?.date ?? brokerFlow?.date ?? 'today'}
        </span>
      </div>
      <div className="grid gap-3 2xl:grid-cols-2">
        <div className="rounded-md border border-border/40 bg-background/55 p-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="font-medium text-foreground/85">法人原始資料（今日）</p>
            <span className={cn('sv-num text-[11px]', signedFlowClass(institutional?.total_net_shares))}>
              淨 {fmtShares(institutional?.total_net_shares)}
            </span>
          </div>
          {institutional?.rows?.length ? (
            <div className="space-y-1">
              <div className="grid grid-cols-[3.5rem_1fr_1fr_1fr] gap-1 text-[10px] text-muted-foreground">
                <span>法人</span>
                <span className="text-right">買</span>
                <span className="text-right">賣</span>
                <span className="text-right">淨</span>
              </div>
              {institutional.rows.map((row) => (
                <div key={row.key ?? row.label} className="grid grid-cols-[3.5rem_1fr_1fr_1fr] items-center gap-1 text-[11px]">
                  <span className="truncate text-foreground/85">{row.label ?? row.key ?? '-'}</span>
                  <span className="text-right sv-num tabular-nums text-red-500 dark:text-red-300">{fmtShares(row.buy_shares)}</span>
                  <span className="text-right sv-num tabular-nums text-emerald-500 dark:text-emerald-300">{fmtShares(row.sell_shares)}</span>
                  <span className={cn('text-right sv-num tabular-nums', signedFlowClass(row.net_shares))}>{fmtShares(row.net_shares)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">今日法人 raw 尚未入庫。</p>
          )}
        </div>

        <div className="rounded-md border border-border/40 bg-background/55 p-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="font-medium text-foreground/85">當日券商分點前三大</p>
            {aggregate?.broker_count != null && (
              <span className="sv-num text-[11px] text-muted-foreground">{fmtInteger(aggregate.broker_count)} 家</span>
            )}
          </div>
          {hasBrokerRanks ? (
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-1">
              <div>
                <p className="mb-1 text-[11px] font-medium text-red-500 dark:text-red-300">買超前三大</p>
                {renderBrokerRankRows(topBuy, '買超前三大尚無資料')}
              </div>
              <div>
                <p className="mb-1 text-[11px] font-medium text-emerald-500 dark:text-emerald-300">賣超前三大</p>
                {renderBrokerRankRows(topSell, '賣超前三大尚無資料')}
              </div>
            </div>
          ) : (
            <div className="space-y-1.5 text-[11px] text-muted-foreground">
              <p className="text-amber-600 dark:text-amber-300">分券商前三大尚未入庫；目前顯示 canonical 聚合分點。</p>
              {aggregate ? (
                <div className="grid grid-cols-3 gap-1">
                  <MetricPill label="買" value={fmtLots(aggregate.buy_lots)} />
                  <MetricPill label="賣" value={fmtLots(aggregate.sell_lots)} />
                  <MetricPill label="淨" value={fmtLots(aggregate.net_lots ?? aggregate.dominant_net_lots)} />
                </div>
              ) : (
                <p>當日券商聚合資料尚未入庫。</p>
              )}
              <p className="break-words sv-num text-[10px] text-muted-foreground/80">
                {brokerFlow?.missing_reason ?? 'broker_level_detail_table_missing'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function planPrice(value: unknown): string | null {
  return fmtOptionalNumber(value as any, 2)
}

function buildOhlcvTradePlanContext(rec: any, context: AlphaContext | null, priceRows: any[]): TradePlanContext {
  const entryModelV2 = entryModelV2FromWatchPoints(normalizeWatchPoints(rec.watch_points))
  const levels = buildTradingPlanLevels(normalizeOhlcvRows(priceRows))
  if (levels) {
    return {
      source: 'ohlcv',
      entryModelV2,
      latest: levels.latestClose,
      resistance: levels.resistance,
      confirmation: levels.confirmation,
      support: levels.support,
      atrDefense: levels.atrLower,
      volumeNode: levels.volumeNode,
      buyReferenceLow: levels.buyReferenceLow,
      buyReferenceHigh: levels.buyReferenceHigh,
      optimisticLow: levels.optimisticLow,
      optimisticHigh: levels.optimisticHigh,
      ma20: levels.ma20,
      ma60: levels.ma60,
      levels,
    }
  }

  const latest = numericPrice(context?.latestClose ?? rec.current_price ?? rec.close ?? rec.latest_close)
  const fairLow = numericPrice(context?.fairValueLow)
  const fairHigh = numericPrice(context?.fairValueHigh)
  const poc = numericPrice(context?.poc)
  const optimisticHigh = numericPrice(context?.optimisticValueHigh ?? rec.target_price ?? rec.targetPrice)
  return {
    source: 'alpha_fallback',
    entryModelV2,
    latest,
    resistance: optimisticHigh ?? fairHigh,
    confirmation: fairHigh ?? optimisticHigh,
    support: fairLow ?? poc,
    atrDefense: fairLow ?? poc,
    volumeNode: poc,
    buyReferenceLow: null,
    buyReferenceHigh: null,
    optimisticLow: null,
    optimisticHigh: null,
    ma20: null,
    ma60: null,
    levels: null,
  }
}

function compactLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function PlanBlock({ title, accent, lines }: { title: string; accent: string; lines: string[] }) {
  return (
    <div className="flex overflow-hidden rounded-md border border-border/50 bg-background/55">
      <div className={cn('w-1 shrink-0', accent)} />
      <div className="min-w-0 flex-1 p-3">
        <p className="text-xs font-medium text-foreground">{title}</p>
        <div className="mt-1.5 space-y-1 text-xs leading-relaxed text-muted-foreground">
          {lines.filter(Boolean).map((line, index) => (
            <p key={`${title}-${index}`}>{line}</p>
          ))}
        </div>
      </div>
    </div>
  )
}

type TradePlanReadRow = {
  label: string
  value: string
  note: string
  tone?: 'good' | 'warn' | 'neutral'
}

function tradePlanToneClass(tone: TradePlanReadRow['tone']) {
  if (tone === 'good') return 'text-emerald-600 dark:text-emerald-300'
  if (tone === 'warn') return 'text-amber-600 dark:text-amber-300'
  return 'text-sky-700 dark:text-sky-300'
}

function tradePlanValueClass(row: TradePlanReadRow): string {
  if (row.label.includes('籌碼')) {
    if (row.value.includes('買超')) return 'text-red-500 dark:text-red-300'
    if (row.value.includes('賣超')) return 'text-emerald-500 dark:text-emerald-300'
  }
  return tradePlanToneClass(row.tone)
}

function TradePlanRow({ row }: { row: TradePlanReadRow }) {
  return (
    <div className="grid gap-1 border-b border-border/30 py-2 last:border-b-0 sm:grid-cols-[6.5rem_8.5rem_1fr] sm:items-start">
      <span className="text-[11px] font-semibold text-foreground/85">{row.label}</span>
      <span className={cn('w-fit rounded-sm border border-current/20 bg-background/70 px-1.5 py-0.5 sv-num text-xs font-semibold tabular-nums', tradePlanValueClass(row))}>
        {row.value}
      </span>
      <span className="text-xs leading-relaxed text-muted-foreground">{row.note}</span>
    </div>
  )
}

function numericPrice(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function klineChartOptions(width: number): DeepPartial<ChartOptions> {
  return {
    width,
    height: 260,
    layout: {
      background: { type: ColorType.Solid, color: '#0a0b0f' },
      textColor: '#8992a3',
      fontFamily: 'Manrope, Noto Sans TC, system-ui, sans-serif',
    },
    grid: {
      vertLines: { color: 'rgba(255, 255, 255, 0.045)' },
      horzLines: { color: 'rgba(255, 255, 255, 0.055)' },
    },
    rightPriceScale: {
      borderColor: 'rgba(255, 255, 255, 0.035)',
      scaleMargins: { top: 0.12, bottom: 0.24 },
    },
    timeScale: {
      borderColor: 'rgba(255, 255, 255, 0.035)',
      timeVisible: false,
      secondsVisible: false,
      rightOffset: 8,
      barSpacing: 8,
      minBarSpacing: 5,
    },
    crosshair: {
      mode: CrosshairMode.MagnetOHLC,
      horzLine: { color: 'rgba(214, 168, 95, 0.42)' },
      vertLine: { color: 'rgba(214, 168, 95, 0.42)' },
    },
  }
}

type KlineCandle = {
  time: Time
  open: number
  high: number
  low: number
  close: number
}

function priceRowTime(row: any): Time {
  return String(row?.date ?? '').slice(0, 10) as Time
}

function positivePrice(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function addCalendarDays(time: Time | undefined, days: number): Time | null {
  if (!time || typeof time !== 'string') return null
  const date = new Date(`${time}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return null
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10) as Time
}

function priceRowsToCandles(rows: any[], limit = 42): KlineCandle[] {
  const candles: KlineCandle[] = []
  let prevClose: number | null = null
  for (const item of rows.slice(-limit)) {
    const time = priceRowTime(item)
    const close = positivePrice(item.close ?? item.avg_price)
    if (!time || close == null) continue
    const avg = positivePrice(item.avg_price)
    const rawHigh = positivePrice(item.high)
    const rawLow = positivePrice(item.low)
    const rawOpen = positivePrice(item.open)
    const open = rawOpen ?? prevClose ?? avg ?? close
    const high = Math.max(rawHigh ?? close, open, close)
    const low = Math.min(rawLow ?? close, open, close)
    candles.push({ time, open, high, low, close })
    prevClose = close
  }
  return candles
}

function priceRowsToVolume(rows: any[], candles: KlineCandle[], limit = 42) {
  const candleByTime = new Map(candles.map((candle) => [String(candle.time), candle]))
  return rows
    .slice(-limit)
    .map((item) => {
      const time = priceRowTime(item)
      const candle = candleByTime.get(String(time))
      const value = Number(item.volume ?? item.Trading_Volume ?? item.trading_volume)
      return {
        time,
        value: Number.isFinite(value) ? value : 0,
        color: candle && candle.close >= candle.open ? 'rgba(239, 68, 68, 0.24)' : 'rgba(0, 192, 118, 0.24)',
      }
    })
    .filter((item) => Boolean(item.time))
}

function movingAverageSeries(candles: KlineCandle[], period: number) {
  if (candles.length < period) return []
  const out: Array<{ time: Time; value: number }> = []
  for (let index = period - 1; index < candles.length; index += 1) {
    const window = candles.slice(index - period + 1, index + 1)
    const avg = window.reduce((sum, candle) => sum + candle.close, 0) / period
    out.push({ time: candles[index].time, value: Math.round(avg * 100) / 100 })
  }
  return out
}

function rsiSeries(candles: KlineCandle[], period = 14) {
  if (candles.length < period + 1) return []
  const out: Array<{ time: Time; value: number }> = []
  for (let index = period; index < candles.length; index += 1) {
    const window = candles.slice(index - period, index + 1)
    let gains = 0
    let losses = 0
    for (let i = 1; i < window.length; i += 1) {
      const change = window[i].close - window[i - 1].close
      if (change >= 0) gains += change
      else losses += Math.abs(change)
    }
    const avgGain = gains / period
    const avgLoss = losses / period
    const value = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss))
    out.push({ time: candles[index].time, value: Math.round(value * 10) / 10 })
  }
  return out
}

function KLinePlanSketch({
  rec,
  priceRows,
  isLoading,
  plan,
}: {
  rec: any
  priceRows: any[]
  isLoading: boolean
  plan: TradePlanContext
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const latest = plan.latest
  const support = plan.support ?? plan.volumeNode ?? latest
  const confirmation = plan.confirmation ?? plan.resistance
  const resistance = plan.resistance ?? confirmation
  const optimisticHigh = plan.optimisticHigh ?? resistance
  const atrDefense = plan.atrDefense
  const volumeNode = plan.volumeNode
  const buyReferenceLow = plan.buyReferenceLow
  const buyReferenceHigh = plan.buyReferenceHigh
  const optimisticLow = plan.optimisticLow
  const ma20 = plan.ma20
  const ma60 = plan.ma60
  const prices = [latest, support, confirmation, resistance, atrDefense, volumeNode].filter((value): value is number => value != null)
  const candles = priceRowsToCandles(priceRows)
  const volume = priceRowsToVolume(priceRows, candles)
  const ma20Series = movingAverageSeries(candles, 20)
  const ma60Series = movingAverageSeries(candles, 60)
  const atrBands = buildAtrBandSeries(normalizeOhlcvRows(priceRows)).slice(-candles.length)
  const atrUpperSeries = atrBands.map((point) => ({ time: point.time as Time, value: point.upper }))
  const atrLowerSeries = atrBands.map((point) => ({ time: point.time as Time, value: point.lower }))
  const rsi = rsiSeries(candles)
  const latestRsi = rsi[rsi.length - 1]?.value ?? null
  const lastTime = candles[candles.length - 1]?.time
  const nextTime = addCalendarDays(lastTime, 1)
  const targetTime = addCalendarDays(lastTime, 3)
  const projection = latest && optimisticHigh && lastTime && nextTime && targetTime
    ? [
      { time: lastTime, value: latest },
      { time: nextTime, value: confirmation ?? latest },
      { time: targetTime, value: optimisticHigh },
    ]
    : []
  const chartKey = JSON.stringify({
    symbol: rec.symbol,
    latest,
    support,
    confirmation,
    resistance,
    optimisticHigh,
    atrDefense,
    volumeNode,
    buyReferenceLow,
    buyReferenceHigh,
    optimisticLow,
    ma20,
    ma60,
    rows: candles.map((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close]),
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container || candles.length === 0) return

    const chart = createChart(container, klineChartOptions(container.clientWidth || 420))
    chartRef.current = chart

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#ff3b45',
      downColor: '#00c076',
      borderUpColor: '#ff3b45',
      borderDownColor: '#00c076',
      wickUpColor: '#ff6b72',
      wickDownColor: '#28d190',
      priceLineVisible: false,
    })
    candleSeries.setData(candles)

    if (volume.length) {
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        priceLineVisible: false,
        lastValueVisible: false,
      }, 1)
      volumeSeries.setData(volume)
    }

    if (projection.length) {
      const projectionSeries = chart.addSeries(LineSeries, {
        color: '#38bdf8',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      projectionSeries.setData(projection)
    }

    if (ma20Series.length) {
      const ma20Line = chart.addSeries(LineSeries, {
        color: '#f59e0b',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      ma20Line.setData(ma20Series)
    }

    if (ma60Series.length) {
      const ma60Line = chart.addSeries(LineSeries, {
        color: '#a78bfa',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      ma60Line.setData(ma60Series)
    }

    if (atrUpperSeries.length && atrLowerSeries.length) {
      const atrUpperLine = chart.addSeries(LineSeries, {
        color: 'rgba(244, 63, 94, 0.55)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      const atrLowerLine = chart.addSeries(LineSeries, {
        color: 'rgba(34, 197, 94, 0.55)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      atrUpperLine.setData(atrUpperSeries)
      atrLowerLine.setData(atrLowerSeries)
    }

    if (resistance) {
      candleSeries.createPriceLine({
        price: resistance,
        color: '#f87171',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '前高壓力',
      })
    }
    if (confirmation) {
      candleSeries.createPriceLine({
        price: confirmation,
        color: '#38bdf8',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: '轉強確認',
      })
    }
    if (support) {
      candleSeries.createPriceLine({
        price: support,
        color: '#22c55e',
        lineWidth: 1,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: '關鍵支撐',
      })
    }

    if (volumeNode) {
      candleSeries.createPriceLine({
        price: volumeNode,
        color: '#a78bfa',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: '量能節點',
      })
    }

    if (atrDefense) {
      candleSeries.createPriceLine({
        price: atrDefense,
        color: '#f43f5e',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'ATR 防守',
      })
    }

    if (buyReferenceLow) {
      candleSeries.createPriceLine({
        price: buyReferenceLow,
        color: '#34d399',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: '買區下緣',
      })
    }

    if (buyReferenceHigh) {
      candleSeries.createPriceLine({
        price: buyReferenceHigh,
        color: '#22c55e',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: '買區上緣',
      })
    }

    if (optimisticLow && optimisticHigh && optimisticHigh !== optimisticLow) {
      candleSeries.createPriceLine({
        price: optimisticHigh,
        color: '#fb7185',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '樂觀目標',
      })
    }

    if (rsi.length) {
      const rsiPaneIndex = volume.length ? 2 : 1
      const rsiLine = chart.addSeries(LineSeries, {
        color: '#c084fc',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      }, rsiPaneIndex)
      rsiLine.setData(rsi)
      rsiLine.createPriceLine({
        price: 70,
        color: 'rgba(248, 113, 113, 0.5)',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: 'RSI 70',
      })
      rsiLine.createPriceLine({
        price: 30,
        color: 'rgba(52, 211, 153, 0.5)',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: 'RSI 30',
      })
      chart.panes()[rsiPaneIndex]?.setHeight(54)
    }

    chart.panes()[1]?.setHeight(64)
    chart.timeScale().fitContent()
    if (candles.length > 32) {
      chart.timeScale().setVisibleLogicalRange({
        from: Math.max(0, candles.length - 32),
        to: candles.length + 5,
      })
    }

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (!entry) return
        chart.applyOptions({ width: Math.max(280, Math.floor(entry.contentRect.width)), height: 260 })
      })
      resizeObserver.observe(container)
    }

    return () => {
      resizeObserver?.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [chartKey])

  if (isLoading && candles.length === 0) {
    return <div className="h-[300px] animate-pulse rounded-[20px] border border-white/[0.08] bg-[#0a0b0f]" />
  }

  if (prices.length === 0 || candles.length === 0) {
    return (
      <div className="rounded-[20px] border border-white/[0.08] bg-[#0a0b0f] p-3 text-xs text-muted-foreground">
        K線策略圖：價格資料不足，暫時只能保留文字交易計劃。
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-[20px] border border-white/[0.09] bg-[linear-gradient(180deg,rgba(22,23,30,0.96),rgba(10,11,15,0.985))] shadow-[inset_0_1px_0_rgba(255,255,255,0.045),0_18px_46px_rgba(0,0,0,0.28)]">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-3 py-2">
        <span className="text-xs font-semibold text-slate-100">K線交易計劃圖</span>
        <span className="sv-num text-[11px] text-slate-500">Lightweight Charts</span>
      </div>
      <div ref={containerRef} className="h-[260px] min-h-[260px] max-h-[260px] w-full overflow-hidden bg-[#0a0b0f]" role="img" aria-label="Lightweight Charts K線交易計劃圖" />
      <div className="grid gap-1 border-t border-white/[0.07] px-3 py-2 text-[11px] sm:grid-cols-4 lg:grid-cols-8">
        <span className="sv-num text-rose-500">壓力 {resistance ? fmtNumber(resistance, 2) : '-'}</span>
        <span className="sv-num text-sky-500">轉強 {confirmation ? fmtNumber(confirmation, 2) : '-'}</span>
        <span className="sv-num text-emerald-500">支撐 {support ? fmtNumber(support, 2) : '-'}</span>
        <span className="sv-num text-violet-500">量能 {volumeNode ? fmtNumber(volumeNode, 2) : '-'}</span>
        <span className="sv-num text-rose-500">ATR {atrDefense ? fmtNumber(atrDefense, 2) : '-'}</span>
        <span className="sv-num text-amber-500">MA20 {ma20 ? fmtNumber(ma20, 2) : '-'}</span>
        <span className="sv-num text-violet-500">MA60 {ma60 ? fmtNumber(ma60, 2) : '-'}</span>
        <span className="sv-num text-fuchsia-500">RSI {latestRsi != null ? fmtNumber(latestRsi, 1) : '-'}</span>
      </div>
    </div>
  )
}

function scoreTone(value: number, high: number, low: number): TradePlanReadRow['tone'] {
  if (value >= high) return 'good'
  if (value <= low) return 'warn'
  return 'neutral'
}

function technicalPlanNote(rec: any): string {
  const vm = buildScoreBreakdownViewModel(rec)
  const rows = vm.technicalRows
  const trend = rows.find((row) => row.key === 'trendStructure')?.explanation
  const volume = rows.find((row) => row.key === 'volumeConfirmation')?.explanation
  const execution = rows.find((row) => row.key === 'executionRisk')?.explanation
  return [trend, volume, execution].filter(Boolean).slice(0, 2).join(' ')
    || '技術資料不足，先以盤中量價確認。'
}

function chipPlanNote(rec: any): string {
  const institutional = institutionalRawFromRec(rec)
  const todayNetShares = institutionalNetShares(institutional)
  if (todayNetShares != null) {
    return `法人今日${flowDirectionText(todayNetShares)}${fmtAbsLotsFromShares(todayNetShares)}，來源為 chip_data 法人原始買賣超。`
  }
  const scoreV2 = scoreV2PayloadFromRec(rec)
  const evidence = parseObject(scoreV2?.chipEvidence) ?? parseObject(rec.chip_evidence)
  if (evidence?.broker_net_amount_5d_billion != null) {
    const amount = Number(evidence.broker_net_amount_5d_billion)
    const direction = amount >= 0 ? '買超' : '賣超'
    const brokerCount = evidence.broker_count_latest ?? evidence.broker_count ?? null
    return `券商分點近5日${direction}${fmtChipAmount(amount)}${brokerCount ? `，參與券商 ${brokerCount} 家` : ''}，只作籌碼輔助判讀。`
  }
  const net = Number(rec.chip_cash_total_5d ?? rec.foreign_net_5d)
  if (Number.isFinite(net)) {
    const direction = net >= 0 ? '買超' : '賣超'
    return `法人5日估算${direction}${fmtChipAmount(net)}，這是股數乘收盤價的 proxy，不等於官方成交金額。`
  }
  return '籌碼來源不足，不能把法人流向當主要理由。'
}

function buildTradePlanRows(rec: any, context: AlphaContext | null): TradePlanReadRow[] {
  const vm = buildScoreBreakdownViewModel(rec)
  const ml = vm.rows.find((row) => row.key === 'mlEdge')?.value ?? 0
  const chip = vm.rows.find((row) => row.key === 'chipFlow')?.value ?? 0
  const technical = vm.rows.find((row) => row.key === 'technicalStructure')?.value ?? 0
  const latest = planPrice(context?.latestClose ?? rec.current_price)
  const support = planPrice(context?.fairValueLow ?? context?.poc)
  const confirmation = planPrice(context?.fairValueHigh ?? context?.optimisticValueHigh)
  const resistance = planPrice(context?.optimisticValueHigh ?? context?.fairValueHigh)
  const volumeNode = planPrice(context?.poc)
  const regime = shortLabelFor(context?.regime, REGIME_TEXT)
  const bucket = shortLabelFor(context?.bucket)
  const location = shortLabelFor(context?.location, LOCATION_TEXT)
  const mlSummary = formatMlVoteSummaryForBadge(mlVoteSummaryFromRec(rec)) ?? '模型共識尚未明確'
  return [
    {
      label: '模型共識',
      value: `${fmtNumber(ml, 1)}/25`,
      note: mlSummary,
      tone: scoreTone(ml, 18, 10),
    },
    {
      label: '籌碼流',
      value: `${fmtNumber(chip, 1)}/25`,
      note: chipPlanNote(rec),
      tone: scoreTone(chip, 18, 10),
    },
    {
      label: '技術結構',
      value: `${fmtNumber(technical, 1)}/25`,
      note: technicalPlanNote(rec),
      tone: scoreTone(technical, 18, 10),
    },
    {
      label: 'Alpha 結構',
      value: `${bucket} / ${regime}`,
      note: `現價 ${latest ?? '-'}，價格位置 ${location}；Alpha 只作部位與風控輔助，不直接當目標價。`,
      tone: context?.skip ? 'warn' : 'neutral',
    },
    {
      label: '交易線位',
      value: `壓力 ${resistance ?? '-'} / 支撐 ${support ?? '-'}`,
      note: `轉強確認 ${confirmation ?? '-'}；量能節點 ${volumeNode ?? '-'}。`,
      tone: 'neutral',
    },
  ]
}

function chipPlanValue(rec: any): string {
  const institutional = institutionalRawFromRec(rec)
  const todayNetShares = institutionalNetShares(institutional)
  if (todayNetShares != null) {
    return `${flowDirectionText(todayNetShares)} ${fmtAbsLotsFromShares(todayNetShares)}`
  }
  const evidence = parseObject(scoreV2PayloadFromRec(rec)?.chipEvidence) ?? parseObject(rec.chip_evidence)
  const brokerAmount = Number(evidence?.broker_net_amount_5d_billion)
  if (Number.isFinite(brokerAmount)) {
    return `${brokerAmount >= 0 ? '買超' : '賣超'} ${Math.abs(brokerAmount).toFixed(2)} 億`
  }
  const net = Number(rec.chip_cash_total_5d ?? rec.foreign_net_5d)
  return Number.isFinite(net)
    ? `${net >= 0 ? '買超' : '賣超'} ${Math.abs(net).toFixed(2)} 億`
    : '資料不足'
}

function alphaStructureValue(context: AlphaContext | null): string {
  const parts = [
    context?.bucket ? `策略 ${shortLabelFor(context.bucket)}` : null,
    context?.regime ? `大盤 ${shortLabelFor(context.regime, REGIME_TEXT)}` : null,
    context?.location ? `位置 ${shortLabelFor(context.location, LOCATION_TEXT)}` : null,
    context?.scoreAdjustment != null ? `Alpha ${signedText(Number(context.scoreAdjustment))}` : null,
    context?.sizing != null ? `部位 x${fmtNumber(context.sizing, 2)}` : null,
    context?.skip ? '風控暫停' : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' / ') : 'Alpha 結構資料不足'
}

function buildFocusedTradePlanRows(rec: any, context: AlphaContext | null, plan: TradePlanContext): TradePlanReadRow[] {
  const zones = buildTradePlanStructureZones(plan, context, STRONG_BREAKOUT_CHASE_PCT)
  const modelEntry = planPrice(rec.ml_entry_price ?? rec.entry_price ?? rec.entryPrice)
  const entryModel: EntryPriceModelV2Ui = plan.entryModelV2 ?? {
    anchorSource: 'daily_proxy_fallback',
    entry: null,
    preferred: null,
    chaseCeiling: null,
    premium: null,
    discount: null,
    poc: null,
    fallback: 'ohlcv_trade_plan_proxy',
  }
  const isTrueVolumeAnchor = entryModel.anchorSource === 'intraday_volume_profile' || entryModel.anchorSource === 'tick_volume_profile'
  const sourceText = `Entry Model V2 / ${entryModel.anchorSource}`
  const entryZone = entryModel.entry ?? zones.buyReferenceZone
  const preferredEntry = entryModel.preferred ?? modelEntry ?? '-'
  const chaseCeiling = entryModel.chaseCeiling ?? zones.chaseCeilingZone
  const optimisticTarget = planPrice(plan.optimisticHigh ?? context?.optimisticValueHigh)
  const pocSource = `${entryModel.poc ?? '-'} / ${entryModel.anchorSource}`
  const sourceNote = entryModel.fallback ?? ''
  return [
    { label: '現價', value: zones.latest ?? '-', note: '', tone: 'neutral' },
    { label: '偏好買入價', value: preferredEntry, note: '', tone: 'neutral' },
    { label: '建議買入區間', value: entryZone, note: '', tone: 'good' },
    { label: '可追價上限', value: chaseCeiling, note: '', tone: 'warn' },
    { label: '樂觀目標價', value: optimisticTarget ?? '-', note: '', tone: 'warn' },
    { label: '前高壓力', value: zones.resistance ?? '-', note: '', tone: 'warn' },
    { label: '轉強確認', value: zones.confirmation ?? '-', note: '', tone: 'good' },
    { label: '關鍵支撐', value: zones.support ?? '-', note: '', tone: 'good' },
    { label: 'ATR 防守', value: zones.atrDefense ?? '-', note: '', tone: 'warn' },
    { label: 'POC / 量能節點來源', value: pocSource, note: '', tone: isTrueVolumeAnchor ? 'good' : 'warn' },
    { label: '線位來源', value: sourceText, note: sourceNote, tone: isTrueVolumeAnchor ? 'good' : 'warn' },
    { label: '籌碼', value: chipPlanValue(rec), note: '', tone: String(chipPlanValue(rec)).includes('買超') ? 'good' : 'warn' },
    { label: 'Alpha 結構', value: alphaStructureValue(context), note: '', tone: context?.skip ? 'warn' : 'neutral' },
  ]
}

function FocusedTradePlanRow({ row }: { row: TradePlanReadRow }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-3 border-b border-border/30 py-2 last:border-b-0">
      <span className="text-[11px] font-semibold text-foreground/80">{row.label}</span>
      <span className={cn('min-w-0 break-words sv-num text-xs font-semibold tabular-nums', tradePlanValueClass(row))}>
        {row.value}
      </span>
    </div>
  )
}

function TradingPlanNarrative({ rec, context, reason }: { rec: any; context: AlphaContext | null; reason: string }) {
  const stockId = Number(rec.stock_id ?? rec.stockId ?? rec.id)
  const inlineRows = Array.isArray(rec.price_candles)
    ? rec.price_candles
    : Array.isArray(rec.prices)
      ? rec.prices
      : []
  const { data: fetchedRows = [], isLoading } = useQuery({
    queryKey: ['recommendation-card-kline', stockId],
    queryFn: () => stocksApi.prices(stockId, 120),
    enabled: Number.isFinite(stockId) && stockId > 0 && inlineRows.length === 0,
    staleTime: 5 * 60_000,
  })
  const priceRows = inlineRows.length > 0 ? inlineRows : (fetchedRows as any[])
  const plan = buildOhlcvTradePlanContext(rec, context, priceRows)
  const zones = buildTradePlanStructureZones(plan, context, STRONG_BREAKOUT_CHASE_PCT)
  const latestClose = zones.latest
  const resistance = zones.resistance
  const support = zones.support
  const atrDefense = zones.atrDefense
  const stop = atrDefense ?? support ?? '近端支撐'
  const alphaAdj = context?.scoreAdjustment == null ? 'Alpha 調整資料不足' : `Alpha 調整 ${signedText(Number(context.scoreAdjustment))}`
  const sizing = context?.sizing == null ? '部位倍率待定' : `部位倍率 x${fmtNumber(context.sizing, 2)}`
  const marketLine = [
    latestClose ? `現價 ${latestClose}` : null,
    resistance ? `前高壓力 ${resistance}` : null,
    support ? `關鍵支撐 ${support}` : null,
    atrDefense ? `ATR 防守 ${atrDefense}` : null,
  ].filter(Boolean).join('，')
  const tradePlanRows = buildFocusedTradePlanRows(rec, context, plan)

  return (
    <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.05] p-3">
      <p className="mb-2 flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-300">
        <ShieldCheck className="h-3 w-3" />
        推薦理由 / Alpha 交易計劃
      </p>
      <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground/85">
        StockVision Alpha 規則引擎依 Score V2、alpha context 與 K 線價位結構產生交易計劃。
      </p>
      <div className="grid gap-2">
        <KLinePlanSketch rec={rec} priceRows={priceRows} isLoading={isLoading} plan={plan} />
        <div className="flex overflow-hidden rounded-md border border-border/50 bg-background/55">
          <div className="w-1 shrink-0 bg-sky-400" />
          <div className="min-w-0 flex-1 p-3">
            <p className="text-xs font-medium text-foreground">盤勢判讀</p>
            <p className="hidden">
              {marketLine || '市場結構資料不足，先以盤中價量與風控為主。'}
            </p>
            <div className="mt-2">
              {tradePlanRows.map((row) => (
                <FocusedTradePlanRow key={row.label} row={row} />
              ))}
            </div>
          </div>
        </div>
        <PlanBlock
          title="風控規則"
          accent="bg-amber-400"
          lines={[
            `${alphaAdj}；${sizing}；${context?.skip ? '風控層標記 skip，暫不自動進場。' : '未被風控層標記 skip。'}`,
            `跌破 ${stop} 或量縮後失守支撐，先降倉，不用硬凹。`,
            '這是系統交易計劃，不是個別投資建議。',
          ]}
        />
      </div>
    </div>
  )
}
function AlphaContextBlock({ context }: { context: AlphaContext | null }) {
  if (!context) return null
  const bucket = context.bucket ?? 'unknown'
  const regime = context.regime ?? 'unknown'
  const volatility = context.volatility ?? 'unknown'
  const liquidity = context.liquidity ?? 'unknown'
  const location = context.location ?? 'unknown'
  const support = fmtOptionalNumber(context.fairValueLow ?? context.poc, 2) ?? '-'
  const confirmation = fmtOptionalNumber(context.fairValueHigh ?? context.optimisticValueHigh, 2) ?? '-'
  const resistance = fmtOptionalNumber(context.optimisticValueHigh ?? context.fairValueHigh, 2) ?? '-'
  const volumeNode = fmtOptionalNumber(context.poc, 2) ?? '-'
  const optimisticExceeded = context.optimisticValueStatus === 'exceeded'
    || (Number(context.latestClose) > 0
      && Number(context.optimisticValueHigh) > 0
      && Number(context.latestClose) > Number(context.optimisticValueHigh))
  const optimisticHelp = optimisticExceeded
    ? '目前價格已高於內部順風上緣估計，前台視為追高提醒，不當成目標價。'
    : '內部量價估計只作線位輔助，前台以可交易線位做判讀。'
  const sizingText = fmtOptionalNumber(context.sizing, 2)
  const scoreAdjText = fmtOptionalNumber(context.scoreAdjustment, 1)
  return (
    <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.06] p-3">
      <p className="mb-2 flex items-center gap-1 text-xs font-medium text-sky-700 dark:text-sky-300">
        <ShieldCheck className="h-3 w-3" />
        Alpha / 市場結構解讀
      </p>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        <span>Alpha bucket：{labelFor(bucket)}</span>
        <span>大盤狀態：{shortLabelFor(regime, REGIME_TEXT)}</span>
        <span>部位倍率：{sizingText ? `x${sizingText}` : '資料不足'}</span>
        <span>Alpha 調整：{scoreAdjText == null ? '資料不足' : `${Number(context.scoreAdjustment) >= 0 ? '+' : ''}${scoreAdjText}`}</span>
        <span>波動：{shortLabelFor(volatility, VOL_TEXT)}</span>
        <span>流動性：{shortLabelFor(liquidity, LIQUIDITY_TEXT)}</span>
        <span>內部量能 proxy：{volumeNode}</span>
        <span>內部合理區下緣：{support}</span>
        <span>內部合理區上緣：{confirmation}</span>
        <span>內部順風區上緣：{resistance}</span>
        {context.window && <span>計算區間：{context.window}</span>}
        {context.latestClose != null && <span>區間最後收盤價：{fmtNumber(context.latestClose, 2)}</span>}
        <span className="sm:col-span-2">價格位置：{shortLabelFor(location, LOCATION_TEXT)}</span>
      </div>
      <div className="mt-3 space-y-1.5 text-xs leading-relaxed text-muted-foreground/85">
        <p>{ALPHA_BUCKET_TEXT[bucket]?.help ?? 'Alpha bucket 是系統判斷這檔股票目前主要 edge 來源的分類。'}</p>
        <p>{REGIME_TEXT[regime] ?? 'Regime 是目前大盤狀態，用來調整不同策略類型的權重。'}</p>
        <p>{VOL_TEXT[volatility] ?? VOL_TEXT.unknown} {LIQUIDITY_TEXT[liquidity] ?? LIQUIDITY_TEXT.unknown}</p>
        <p>
          Market structure：{LOCATION_TEXT[location] ?? LOCATION_TEXT.unknown} {optimisticHelp} 實際交易線位以 OHLCV 動態線位為準。
        </p>
      </div>
      {context.skip && (
        <p className="mt-2 text-xs font-medium text-amber-600">
          風控層已標記 skip：代表目前不建議自動進場。
        </p>
      )}
    </div>
  )
}

function normalizeWatchPoint(point: string): string {
  if (point.startsWith('allocator:')) {
    const summary = describeAllocatorDecision([point])
    if (summary) {
      return `5-slot 資金配置：${summary.title}。${summary.detail}。這只代表槽位與資金允許，仍需通過盤中報價、price_above_entry、range_position_low、量能與限價成交檢核。`
    }
  }
  if (point.startsWith('Alpha bucket:') || point.startsWith('Alpha overlay:')) {
    const ctx = contextFromWatchPoints([point])
    const bucket = ctx?.bucket ?? 'unknown'
    const regime = ctx?.regime ?? 'unknown'
    const volatility = ctx?.volatility ?? 'unknown'
    const liquidity = ctx?.liquidity ?? 'unknown'
    const sizing = ctx?.sizing == null || Number.isNaN(ctx.sizing) ? '-' : `x${fmtNumber(ctx.sizing, 2)}`
    return `Alpha bucket：${shortLabelFor(bucket)}；大盤狀態：${shortLabelFor(regime, REGIME_TEXT)}；部位倍率：${sizing}；風險：${shortLabelFor(volatility, VOL_TEXT)} / ${shortLabelFor(liquidity, LIQUIDITY_TEXT)}。白話：這是在說目前適合哪一種交易邏輯，會影響 allocation、sizing 與風控。`
  }
  if (point.startsWith('Market structure:')) {
    const ctx = contextFromWatchPoints([point])
    const support = fmtOptionalNumber(ctx?.fairValueLow ?? ctx?.poc, 2) ?? '-'
    const confirmation = fmtOptionalNumber(ctx?.fairValueHigh ?? ctx?.optimisticValueHigh, 2) ?? '-'
    const resistance = fmtOptionalNumber(ctx?.optimisticValueHigh ?? ctx?.fairValueHigh, 2) ?? '-'
    const volumeNode = fmtOptionalNumber(ctx?.poc, 2) ?? '-'
    const optimisticExceeded = ctx?.optimisticValueStatus === 'exceeded'
      || (Number(ctx?.latestClose) > 0 && Number(ctx?.optimisticValueHigh) > 0 && Number(ctx?.latestClose) > Number(ctx?.optimisticValueHigh))
    const optimisticHelp = optimisticExceeded
      ? '內部上緣已低於現價，前台視為追高風險。'
      : '內部量價估計只作 Alpha 輔助，不當成交易線位。'
    return `Market structure：Alpha 日線價值代理=${support}~${confirmation}；內部可追價上限=${confirmation}~${resistance}；日線量能代理節點=${volumeNode}；價格位置=${shortLabelFor(ctx?.location, LOCATION_TEXT)}。白話：${optimisticHelp} 實際買入參考區與可追價上限以 OHLCV 動態線位為準。`
  }
  if (point.startsWith('ohlcv_trade_plan:')) {
    const mode = extractTokenValue(point, 'mode') ?? '-'
    const entry = extractTokenValue(point, 'entry') ?? '-'
    const buyReference = extractTokenValue(point, 'buy_reference') ?? '-'
    const optimisticRange = extractTokenValue(point, 'optimistic_range') ?? '-'
    const confirmation = extractTokenValue(point, 'confirmation') ?? '-'
    const resistance = extractTokenValue(point, 'resistance') ?? '-'
    const support = extractTokenValue(point, 'support') ?? '-'
    const atrDefense = extractTokenValue(point, 'atr_defense') ?? '-'
    const volumeNode = extractTokenValue(point, 'volume_node') ?? '-'
    return `OHLCV 交易線位：模式=${mode}；預計入場=${entry}；買入參考區=${buyReference}；可追價上限區=${optimisticRange}；轉強確認=${confirmation}；前高壓力=${resistance}；關鍵支撐=${support}；ATR 防守=${atrDefense}；量能節點=${volumeNode}。`
  }
  if (point.startsWith('ML ensemble:')) {
    const bullish = point.match(/bullish=([^,]+)/)?.[1] ?? '-'
    const bearish = point.match(/bearish=([^,]+)/)?.[1] ?? '-'
    const flat = point.match(/flat=([^,]+)/)?.[1] ?? '0'
    const missing = point.match(/missing=([^,]+)/)?.[1] ?? '0'
    const forecast = point.match(/forecast=([^,%]+)%/)?.[1] ?? 'n/a'
    return `ML ensemble：${bullish} 看漲、${bearish} 看跌、${flat} 觀望、${missing} 未回傳，校準預期報酬 ${forecast}%。白話：投票是門檻判斷，校準預期是由 rank/verified outcomes 映射出的連續報酬估計，兩者不一定同方向。`
  }
  const executionExplanation = explainExecutionEvent(point)
  if (executionExplanation) return executionExplanation
  return point
}

function isContextWatchPoint(point: string): boolean {
  const normalized = point.trim()
  return normalized.startsWith('Alpha bucket:')
    || normalized.startsWith('Alpha overlay:')
    || normalized.startsWith('Market structure:')
    || normalized.startsWith('ohlcv_trade_plan:')
    || normalized.startsWith('entry_price_model_v2:')
    || normalized.startsWith('Alpha 結構:')
    || normalized.startsWith('ML ensemble:')
    || normalized.startsWith('screener_funnel:')
    || normalized.startsWith('Alpha bucket：')
    || normalized.startsWith('Alpha overlay：')
    || normalized.startsWith('Market structure：')
    || normalized.startsWith('OHLCV 交易線位：')
    || normalized.startsWith('Alpha 結構：')
    || normalized.startsWith('ML ensemble：')
}

function isRawDebugWatchPoint(point: string): boolean {
  const normalized = point.trim()
  return normalized.startsWith('breeze2:')
    || /^market_segment:/i.test(normalized)
    || /^chip_source=/i.test(normalized)
    || /(?:^|,)source_date=/i.test(normalized)
    || /broker_net_(?:amount|shares)_5d=/i.test(normalized)
    || /broker_count=|concentration=/i.test(normalized)
    || /^quality=/i.test(normalized)
}

function executionWatchPointKey(point: string): string {
  const event = parseExecutionEvent(point)
  if (!event) return point.trim()
  if (event.kind === 'execution' && event.status === 'stale_quote') return 'execution:stale_quote'
  if (event.kind === 'execution' && (event.status === 'deferred' || event.status === 'pending')) {
    if (event.reason.startsWith('range_position_low')) return 'execution:waiting:range_position_low'
    if (event.reason.startsWith('volume_ratio_low')) return 'execution:waiting:volume_ratio_low'
    if (event.reason.startsWith('momentum_unavailable')) return 'execution:waiting:momentum_unavailable'
    if (event.reason.startsWith('price_above_entry')) return 'execution:waiting:price_above_entry'
    if (event.reason.startsWith('waiting_for_ohlcv_confirmation')) return 'execution:waiting:ohlcv_confirmation'
    if (event.reason.startsWith('price_above_ohlcv_optimistic_range')) return 'execution:waiting:ohlcv_optimistic_range'
    if (event.reason.startsWith('ohlcv_support_lost')) return 'execution:waiting:ohlcv_support_lost'
    if (event.reason.startsWith('between_buy_reference_and_confirmation')) return 'execution:waiting:ohlcv_mid_range'
    if (event.reason.startsWith('falling_5min')) return 'execution:waiting:falling_5min'
  }
  return `${event.kind}:${event.status}:${event.reason}`
}

function displayWatchPoints(points: string[]): string[] {
  const latestByKey = new Map<string, string>()
  for (const point of points) {
    if (isContextWatchPoint(point) || isRawDebugWatchPoint(point)) continue
    const key = executionWatchPointKey(point)
    if (latestByKey.has(key)) latestByKey.delete(key)
    latestByKey.set(key, point)
  }
  return [...latestByKey.values()]
}

function normalizeEvidenceLinks(raw: unknown): EvidenceLink[] {
  if (!Array.isArray(raw)) return []
  const links: EvidenceLink[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as EvidenceLink
    if (typeof row.url !== 'string' || !/^https?:\/\//i.test(row.url)) continue
    links.push({
      source: String(row.source ?? 'news'),
      title: String(row.title ?? row.url).slice(0, 90),
      url: row.url,
      published_at: row.published_at ? String(row.published_at) : '',
    })
    if (links.length >= 3) break
  }
  return links
}

export function RecommendationCardClean({ rec, rank, context = 'full' }: RecommendationCardCleanProps) {
  const [expanded, setExpanded] = useState(false)
  const sig = SIGNAL_CONFIG[recommendationSignalKey(rec)] ?? SIGNAL_CONFIG.HOLD
  const SigIcon = sig.icon
  const isHomeContext = context === 'home'
  const showFullDecisionDetail = !isHomeContext
  const watchPoints = normalizeWatchPoints(rec.watch_points)
  const noticePoints = displayWatchPoints(watchPoints)
  const alphaContext = alphaContextFromRec(rec, watchPoints)
  const displayReason = translateRecommendationReason(rec.reason)
  const mlVoteSummary = mlVoteSummaryFromRec(rec)
  const mlDiagnostics = mlDiagnosticsFromRec(rec)
  const mlSummary = formatMlVoteSummaryForBadge(mlVoteSummary) ?? formatMlVoteSummaryReadable(mlVoteSummary) ?? formatMlVoteSummary(mlVoteSummary) ?? extractMlSummary(displayReason)
  const mlMetadataGap = mlMetadataGapText(rec, mlVoteSummary)
  const chip5dRaw = rec.chip_cash_total_5d ?? (
    (rec.chip_cash_foreign_5d ?? rec.foreign_net_5d ?? 0)
    + (rec.chip_cash_trust_5d ?? rec.trust_net_5d ?? 0)
    + (rec.dealer_net_5d ?? 0)
  )
  const evidenceLinks = normalizeEvidenceLinks(rec.evidence_links)
  const isEmerging = String(rec.market_segment ?? '').toUpperCase() === 'EMERGING'
    || String(rec.recommendation_lane ?? '').toLowerCase() === 'emerging_watchlist'
  const scoreViewModel = buildScoreBreakdownViewModel(rec)
  const institutionalRaw = institutionalRawFromRec(rec)
  const brokerTopFlows = brokerTopFlowsFromRec(rec)
  const todayInstitutionalNetShares = institutionalNetShares(institutionalRaw)
  const chipBadge = todayInstitutionalNetShares != null
    ? {
        label: '法人今日',
        text: `${flowDirectionText(todayInstitutionalNetShares)} ${fmtAbsLotsFromShares(todayInstitutionalNetShares)}`,
        signedValue: todayInstitutionalNetShares,
      }
    : {
        label: isEmerging ? '券商' : '籌碼5日',
        text: fmtChipAmount(chip5dRaw),
        signedValue: Number(chip5dRaw),
      }

  return (
    <div className={cn(
      'sv-recommendation-card-detail sv-stockintelli-rec-card overflow-hidden rounded-[20px] border transition-all duration-200',
      rank === 1
        ? 'border-amber-300/30 bg-[radial-gradient(circle_at_92%_8%,rgba(245,158,11,0.13),transparent_34%),linear-gradient(135deg,rgba(28,28,24,0.96),rgba(14,16,22,0.99))] shadow-[inset_0_1px_0_rgba(255,255,255,0.055),0_18px_48px_rgba(0,0,0,0.22)]'
        : 'border-white/[0.08] bg-[linear-gradient(135deg,rgba(21,24,33,0.96),rgba(12,14,20,0.99))] shadow-[inset_0_1px_0_rgba(255,255,255,0.045)] hover:border-sky-300/20 hover:bg-[#151923]',
    )}>
      <div
        className="flex cursor-pointer select-none items-center gap-3 p-3 sm:p-4"
        onClick={() => setExpanded((value) => !value)}
      >
        <div className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-sm font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]',
          rank === 1 ? 'border-amber-300/40 bg-amber-400/20 text-amber-100' :
          rank === 2 ? 'border-slate-300/30 bg-slate-300/12 text-slate-100' :
          rank === 3 ? 'border-orange-300/35 bg-orange-400/16 text-orange-100' :
          'border-white/[0.08] bg-white/[0.06] text-slate-300',
        )}>
          {rank}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="sv-num text-base font-bold text-slate-50">{rec.symbol}</span>
            <span className="truncate text-sm font-semibold text-slate-300">{rec.name}</span>
            {rec.sector && (
              <Badge variant="outline" className="shrink-0 border-sky-300/18 bg-sky-400/[0.08] px-2 py-0.5 text-[11px] text-sky-200">{rec.sector}</Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <Badge className={cn('border px-2 py-0.5 text-[11px] leading-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]', sig.color)}>
              <SigIcon className="mr-1 h-3 w-3" />
              {sig.label}
            </Badge>
            <span className={cn('flex items-center gap-1 text-xs font-semibold', signedFlowClass(chipBadge.signedValue))}>
              <Users className="h-3 w-3" />
              {chipBadge.label} {chipBadge.text}
            </span>
            {rec.rsi14 != null && (
              <span className="flex items-center gap-1 text-xs font-medium text-slate-400">
                <BarChart3 className="h-3 w-3" />
                RSI {fmtNumber(rec.rsi14, 1)}
              </span>
            )}
            {(mlSummary || mlMetadataGap) && (
              <Badge variant="outline" className="h-auto max-w-full shrink whitespace-normal break-words overflow-visible border-indigo-300/25 bg-indigo-400/[0.10] px-2 py-1 text-left text-[11px] leading-5 text-indigo-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
                ML {mlSummary ?? `分數 ${fmtNumber(scoreComponentValue(rec, 'mlEdge'), 1)}，投票明細待同步`}
              </Badge>
            )}
            {alphaContext?.bucket && (
              <Badge variant="outline" className="gap-1 border-sky-300/25 bg-sky-400/[0.09] px-2 py-0.5 text-[11px] text-sky-200">
                <ShieldCheck className="h-3 w-3" />
                {labelFor(alphaContext.bucket)}
              </Badge>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div className="sv-num text-xl font-bold text-amber-200">{Math.round(scoreViewModel.finalScore)}</div>
          <div className="text-[10px] font-medium text-slate-500">最終分</div>
        </div>

        {expanded ? (
          <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        )}
      </div>

      {evidenceLinks.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-white/[0.07] bg-black/10 px-4 py-2">
          {evidenceLinks.map((link) => (
            <a
              key={`${link.source}:${link.url}`}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-sky-300/20 bg-sky-400/[0.075] px-2 py-1 text-[11px] leading-tight text-sky-200 hover:border-sky-300/40"
            >
              <ExternalLink className="h-3 w-3 shrink-0" />
              <span className="shrink-0 sv-num normal-case">{link.source}</span>
              <span className="truncate">{link.title}</span>
            </a>
          ))}
        </div>
      )}

      {expanded && (
        <div className="sv-card-expanded-content space-y-4 border-t border-white/[0.08] bg-[linear-gradient(180deg,rgba(17,20,28,0.92),rgba(9,11,16,0.98))] px-4 pb-4 pt-3">
          <ScoreFormulaSummary viewModel={scoreViewModel} />

          <div className="space-y-1.5">
            <p className="mb-2 text-xs font-semibold text-slate-200">五構面基礎分數</p>
            {scoreViewModel.rows.map((item) => (
              <div key={item.key} className="space-y-1">
                <ScoreBar label={item.label} value={item.value} max={item.max} color={item.color} />
                {item.explanation && (
                  <p className="pl-[72px] text-[11px] leading-relaxed text-slate-400 sm:pl-[74px]">
                    {item.explanation}
                  </p>
                )}
              </div>
            ))}
          </div>

          <ScoreBreakdownV2 rec={rec} />

          <FundamentalSnapshotBlock rec={rec} />

          <InstitutionalBrokerFlowBlock institutional={institutionalRaw} brokerFlow={brokerTopFlows} />

          <TradingPlanNarrative rec={rec} context={alphaContext} reason={displayReason} />

          {showFullDecisionDetail && (mlSummary || mlMetadataGap || mlDiagnostics) && (
            <div className="rounded-[18px] border border-indigo-300/20 bg-indigo-400/[0.07] p-3 text-xs leading-relaxed text-slate-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]">
              <p className="mb-1 font-semibold text-indigo-100">ML 解讀</p>
              <p className="text-slate-300">{mlSummary ?? mlMetadataGap}</p>
              <MlDiagnosticsStrip diagnostics={mlDiagnostics} />
            </div>
          )}

          {showFullDecisionDetail && noticePoints.length > 0 && (
            <div>
              <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-slate-300">
                <AlertCircle className="h-3 w-3" />
                注意事項
              </p>
              <ul className="space-y-1">
                {noticePoints.map((point, index) => (
                  <li key={`${point}-${index}`} className="flex items-start gap-1.5 text-xs leading-relaxed text-slate-300">
                    <span className="mt-0.5 shrink-0 text-amber-500">!</span>
                    {normalizeWatchPoint(point)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {showFullDecisionDetail && rec.confidence != null && (
            <p className="text-[11px] text-slate-400">
              ML 信心度 {(Number(rec.confidence) * 100).toFixed(0)}%
              {rec.current_price != null && (
                <span className="ml-3">{'\u53c3\u8003\u6536\u76e4\u50f9'} ${fmtNumber(rec.current_price, 2)}{'\uff08\u975e\u6700\u7d42\u639b\u50f9\uff09'}</span>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
