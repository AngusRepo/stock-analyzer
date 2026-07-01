import type { Bindings } from '../types'
import { twNow, twToday } from './dateUtils'

export type DataQualityStatus = 'ok' | 'warn' | 'fail'

export interface DataQualityCheck {
  id: string
  label: string
  status: DataQualityStatus
  summary: string
  metrics?: Record<string, unknown>
}

export interface PredictionCoverageRow {
  model_name: string
  count: number
  stocks: number
}

export interface ModelIcEvidenceRow {
  model_name: string
  count: number
  stocks: number
  latest_date?: string | null
}

interface CountRow {
  count?: number
  total?: number
  latest_date?: string | null
  rows_on_latest?: number
  score_v2_count?: number
  signal_count?: number
  confidence_count?: number
  unclassified?: number
  invalid_scores?: number
  missing_components?: number
  missing_reasons?: number
  missing_industry_tags?: number
  tradable_total?: number
  tradable_missing_industry_tags?: number
  research_total?: number
  research_missing_industry_tags?: number
  current_price_valid?: number
  tradable_count?: number
  emerging_watchlist_count?: number
  eligible_ml_count?: number
  eligible_pending_count?: number
  avg_score?: number
  min_score?: number
  max_score?: number
  high_score_count?: number
  perfect_score_count?: number
  missing_feature_version?: number
  distinct_feature_versions?: number
  run_trade_date?: string | null
  source_reco_date?: string | null
  candidate_count?: number
  active_count?: number
  l4_sparse_final_buy_count?: number
  pending_buy_invalid_allocator_count?: number
  pending_buy_watch_source_count?: number
  pending_buy_missing_recommendation_count?: number
  emerging_recommendations?: number
  pending_buy_emerging_like?: number
  top_concept_symbols?: number
  top_unmapped_symbols?: number
  top_other_symbols?: number
  latest_theme_rows?: number
  latest_theme_date?: string | null
  funnel_run_id?: string | null
  funnel_status?: string | null
  funnel_final_count?: number
  funnel_emerging_count?: number
  funnel_candidate_count?: number
  funnel_universe_count?: number
  funnel_created_at?: string | null
  manifest_total?: number
  price_hot_window_manifest?: number
  technical_indicator_hot_window_manifest?: number
  chip_hot_window_manifest?: number
  backtest_compute_snapshot_manifest?: number
  price_history_compute_snapshot_manifest?: number
  pipeline_report_manifest?: number
  screener_report_manifest?: number
  latest_d1_serving_manifest_at?: string | null
  latest_gcs_compute_manifest_at?: string | null
  latest_r2_report_manifest_at?: string | null
  awaiting_retrain_followup?: number
  stale_retrain_followup?: number
  oldest_retrain_followup_at?: string | null
  latest_retrain_followup_at?: string | null
  theme_signal_total?: number
  theme_signal_sources?: number
  theme_signal_latest_generated_at?: string | null
  stock_theme_feature_total?: number
  stock_theme_feature_symbols?: number
  stock_theme_feature_latest_generated_at?: string | null
  market_breadth_rows?: number
  turnover_rows?: number
  margin_rows?: number
  short_rows?: number
  freshness_status?: string | null
  latest_materialization?: string | null
  root_cause?: string | null
}

interface MarketDashboardMaterializationSource {
  key: string
  label: string
  source: string
  rows?: number | null
  latestDate?: string | null
  warnLagDays: number
  failLagDays: number
  required?: boolean
  scope?: string
  rootCause?: string | null
}

export const EXPECTED_V2_MODELS = [
  'LightGBM',
  'XGBoost',
  'ExtraTrees',
  'TabM',
  'GNN',
  'DLinear',
  'PatchTST',
  'iTransformer',
] as const

export const DATA_QUALITY_EOD_READY_MINUTE_TW = 18 * 60 + 30

const UNCLASSIFIED_LABEL = '\u672a\u5206\u985e'
const UNCLASSIFIED_EN_LABEL = 'Unclassified'

export function summarizeDataQualityChecks(checks: DataQualityCheck[]): DataQualityStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail'
  if (checks.some((check) => check.status === 'warn')) return 'warn'
  return 'ok'
}

export function daysBetweenDates(fromDate: string | null | undefined, toDate: string): number | null {
  if (!fromDate) return null
  const from = Date.parse(`${fromDate.slice(0, 10)}T00:00:00.000Z`)
  const to = Date.parse(`${toDate.slice(0, 10)}T00:00:00.000Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  return Math.floor((to - from) / 86_400_000)
}

export async function resolveExpectedTradingDate(kv: KVNamespace, startDate: string = twToday()): Promise<string> {
  let cursor = new Date(`${startDate.slice(0, 10)}T00:00:00.000Z`)
  for (let i = 0; i < 14; i += 1) {
    const date = cursor.toISOString().slice(0, 10)
    const dow = cursor.getUTCDay()
    const isWeekend = dow === 0 || dow === 6
    const isHoliday = Boolean(await kv.get(`holiday:${date}`))
    if (!isWeekend && !isHoliday) return date
    cursor = new Date(cursor.getTime() - 86_400_000)
  }
  return startDate.slice(0, 10)
}

export async function resolveExpectedCompletedDataDate(
  kv: KVNamespace,
  startDate: string = twToday(),
  nowTw: Date = twNow(),
  eodReadyMinuteTw: number = DATA_QUALITY_EOD_READY_MINUTE_TW,
): Promise<string> {
  const expectedTradingDate = await resolveExpectedTradingDate(kv, startDate)
  const currentTwDate = nowTw.toISOString().slice(0, 10)
  const currentTwMinute = nowTw.getUTCHours() * 60 + nowTw.getUTCMinutes()

  if (expectedTradingDate === currentTwDate && currentTwMinute < eodReadyMinuteTw) {
    const prev = new Date(`${expectedTradingDate}T00:00:00.000Z`)
    prev.setUTCDate(prev.getUTCDate() - 1)
    return resolveExpectedTradingDate(kv, prev.toISOString().slice(0, 10))
  }

  return expectedTradingDate
}

export function buildFreshnessCheck(input: {
  id: string
  label: string
  latestDate: string | null | undefined
  targetDate: string
  rowsOnLatest?: number | null
  warnLagDays: number
  failLagDays: number
  minRows?: number
}): DataQualityCheck {
  const lagDays = daysBetweenDates(input.latestDate, input.targetDate)
  const rows = Number(input.rowsOnLatest ?? 0)
  if (lagDays == null) {
    return {
      id: input.id,
      label: input.label,
      status: 'fail',
      summary: `${input.label} has no dated rows`,
      metrics: { latest_date: input.latestDate ?? null, rows_on_latest: rows },
    }
  }
  const rowFloor = input.minRows ?? 1
  if (rows < rowFloor) {
    return {
      id: input.id,
      label: input.label,
      status: 'fail',
      summary: `${input.label} latest date has too few rows rows=${rows}/${rowFloor}`,
      metrics: { latest_date: input.latestDate, lag_days: lagDays, rows_on_latest: rows, min_rows: rowFloor },
    }
  }
  const status: DataQualityStatus = lagDays > input.failLagDays
    ? 'fail'
    : lagDays > input.warnLagDays
      ? 'warn'
      : 'ok'
  return {
    id: input.id,
    label: input.label,
    status,
    summary: `${input.label} latest=${input.latestDate} lag=${lagDays}d rows=${rows}`,
    metrics: { latest_date: input.latestDate, lag_days: lagDays, rows_on_latest: rows, min_rows: rowFloor },
  }
}

export function buildThemeSignalCoverageCheck(input: {
  targetDate: string
  themeSignalTotal: number
  themeSignalSources: number
  stockThemeFeatureTotal: number
  stockThemeFeatureSymbols: number
  latestThemeSignalAt?: string | null
  latestStockThemeFeatureAt?: string | null
}): DataQualityCheck {
  const hasThemeSignals = input.themeSignalTotal > 0 && input.themeSignalSources > 0
  const hasStockFeatures = input.stockThemeFeatureTotal > 0 && input.stockThemeFeatureSymbols > 0
  const status: DataQualityStatus = hasThemeSignals && hasStockFeatures ? 'ok' : hasThemeSignals ? 'warn' : 'fail'
  return {
    id: 'theme_signal_runtime',
    label: 'Theme signal runtime',
    status,
    summary: hasThemeSignals
      ? `theme_signals=${input.themeSignalTotal}, stock_theme_features=${input.stockThemeFeatureTotal}`
      : 'theme_signals missing; screener falls back to live PTT/news/Anue only',
    metrics: {
      target_date: input.targetDate,
      theme_signal_total: input.themeSignalTotal,
      theme_signal_sources: input.themeSignalSources,
      stock_theme_feature_total: input.stockThemeFeatureTotal,
      stock_theme_feature_symbols: input.stockThemeFeatureSymbols,
      latest_theme_signal_at: input.latestThemeSignalAt ?? null,
      latest_stock_theme_feature_at: input.latestStockThemeFeatureAt ?? null,
      source_of_truth: 'theme_signals + stock_theme_features',
    },
  }
}

export function buildPredictionCoverageCheck(
  rows: PredictionCoverageRow[],
  expectedModels: readonly string[] = EXPECTED_V2_MODELS,
  minRowsPerModel = 1,
): DataQualityCheck {
  const byModel = new Map(rows.map((row) => [row.model_name, row]))
  const missing = expectedModels.filter((model) => !byModel.has(model))
  const underfilled = expectedModels.filter((model) => {
    const row = byModel.get(model)
    return row != null && Number(row.count ?? 0) < minRowsPerModel
  })
  const status: DataQualityStatus = missing.length > 0
    ? 'fail'
    : underfilled.length > 0
      ? 'warn'
      : 'ok'
  return {
    id: 'prediction_coverage',
    label: 'Prediction coverage',
    status,
    summary: `${expectedModels.length - missing.length}/${expectedModels.length} models present`,
    metrics: {
      expected_models: expectedModels,
      missing_models: missing,
      underfilled_models: underfilled,
      rows_by_model: rows,
      min_rows_per_model: minRowsPerModel,
    },
  }
}

export function buildModelIcEvidenceCheck(
  rows: ModelIcEvidenceRow[],
  expectedModels: readonly string[] = EXPECTED_V2_MODELS,
  minSamplesPerModel = 30,
): DataQualityCheck {
  const byModel = new Map(rows.map((row) => [row.model_name, row]))
  const missing = expectedModels.filter((model) => !byModel.has(model))
  const underfilled = expectedModels.filter((model) => {
    const row = byModel.get(model)
    return row != null && Number(row.count ?? 0) < minSamplesPerModel
  })
  const totalSamples = rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0)
  const latestVerifiedDate = rows
    .map((row) => row.latest_date)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort()
    .at(-1) ?? null
  const status: DataQualityStatus = missing.length > 0
    ? 'fail'
    : underfilled.length > 0
      ? 'warn'
      : 'ok'

  return {
    id: 'model_ic_evidence',
    label: 'Model IC evidence',
    status,
    summary: `${expectedModels.length - missing.length}/${expectedModels.length} V2 models have verified IC evidence; samples=${totalSamples}`,
    metrics: {
      expected_models: expectedModels,
      missing_models: missing,
      underfilled_models: underfilled,
      rows_by_model: rows,
      min_samples_per_model: minSamplesPerModel,
      latest_verified_date: latestVerifiedDate,
      source_of_truth: 'predictions.verified_at + model_pool.compute_weekly_ic',
    },
  }
}

export function buildRecommendationMlOwnerCheck(input: {
  total: number
  scoreV2Count: number
  signalCount: number
  confidenceCount: number
  predictionRows: number
}): DataQualityCheck {
  const total = Number(input.total ?? 0)
  const scoreV2Count = Number(input.scoreV2Count ?? 0)
  if (total <= 0) {
    return {
      id: 'recommendation_ml_enrichment',
      label: 'Recommendation ML enrichment',
      status: 'fail',
      summary: 'daily_recommendations has no rows for target date',
      metrics: { total },
    }
  }
  const ratio = scoreV2Count / total
  const status: DataQualityStatus = input.predictionRows > 0 && scoreV2Count === 0
    ? 'fail'
    : ratio < 0.5
      ? 'warn'
      : 'ok'
  return {
    id: 'recommendation_ml_enrichment',
    label: 'Recommendation Score V2 enrichment',
    status,
    summary: `${scoreV2Count}/${total} recommendations have canonical Score V2 payloads`,
    metrics: {
      total,
      enriched: scoreV2Count,
      ratio,
      score_v2_count: scoreV2Count,
      signal_count: input.signalCount,
      confidence_count: input.confidenceCount,
      prediction_rows: input.predictionRows,
    },
  }
}

export function buildFeatureVersionParityCheck(input: {
  total: number
  missingFeatureVersion: number
  distinctFeatureVersions: number
}): DataQualityCheck {
  const total = Number(input.total ?? 0)
  const missing = Number(input.missingFeatureVersion ?? 0)
  const distinct = Number(input.distinctFeatureVersions ?? 0)
  if (total <= 0) {
    return {
      id: 'feature_version_parity',
      label: 'Train/serve feature version parity',
      status: 'warn',
      summary: 'no prediction rows to validate feature_version parity',
      metrics: { total },
    }
  }

  const missingRatio = missing / total
  const status: DataQualityStatus = missingRatio >= 1
    ? 'fail'
    : missingRatio > 0 || distinct > 3
      ? 'warn'
      : 'ok'

  return {
    id: 'feature_version_parity',
    label: 'Train/serve feature version parity',
    status,
    summary: `feature_version present=${total - missing}/${total} distinct=${distinct}`,
    metrics: {
      total,
      missing_feature_version: missing,
      missing_ratio: missingRatio,
      distinct_feature_versions: distinct,
    },
  }
}

export function buildScreenerSeedQualityCheck(input: {
  total: number
  unclassified: number
  invalidScores: number
  missingComponents: number
  missingReasons: number
  currentPriceValid?: number
}): DataQualityCheck {
  const total = Number(input.total ?? 0)
  if (total <= 0) {
    return {
      id: 'screener_seed_quality',
      label: 'Screener seed quality',
      status: 'fail',
      summary: 'no daily recommendation seed rows for target date',
      metrics: { total },
    }
  }

  const invalid = Number(input.invalidScores ?? 0)
  const missingComponents = Number(input.missingComponents ?? 0)
  const unclassified = Number(input.unclassified ?? 0)
  const missingReasons = Number(input.missingReasons ?? 0)
  const currentPriceValid = Number(input.currentPriceValid ?? total)
  const unclassifiedRatio = unclassified / total
  const missingReasonRatio = missingReasons / total
  const currentPriceRatio = currentPriceValid / total
  const status: DataQualityStatus = invalid > 0 || missingComponents > 0 || unclassifiedRatio > 0.5 || missingReasonRatio > 0.5 || currentPriceRatio < 0.5
    ? 'fail'
    : unclassifiedRatio > 0.25 || missingReasonRatio > 0.25 || currentPriceRatio < 0.8
      ? 'warn'
      : 'ok'

  return {
    id: 'screener_seed_quality',
    label: 'Screener seed quality',
    status,
    summary: `rows=${total} invalid=${invalid} missing_score_v2_components=${missingComponents} unclassified=${unclassified} price_valid=${currentPriceValid}`,
    metrics: {
      total,
      invalid_scores: invalid,
      missing_score_v2_components: missingComponents,
      unclassified,
      missing_reasons: missingReasons,
      current_price_valid: currentPriceValid,
      current_price_ratio: currentPriceRatio,
      unclassified_ratio: unclassifiedRatio,
      missing_reason_ratio: missingReasonRatio,
    },
  }
}

export function buildScreenerCandidateVolumeCheck(input: {
  total: number
  minCandidates?: number
  warnCandidates?: number
}): DataQualityCheck {
  const total = Number(input.total ?? 0)
  const minCandidates = Number(input.minCandidates ?? 10)
  const warnCandidates = Number(input.warnCandidates ?? Math.max(minCandidates, 20))
  const status: DataQualityStatus = total < minCandidates ? 'fail' : total < warnCandidates ? 'warn' : 'ok'
  return {
    id: 'screener_candidate_volume',
    label: 'Screener candidate volume',
    status,
    summary: `candidates=${total} min=${minCandidates} warn=${warnCandidates}`,
    metrics: { total, min_candidates: minCandidates, warn_candidates: warnCandidates },
  }
}

export function buildScreenerScoreDistributionCheck(input: {
  total: number
  avgScore?: number | null
  minScore?: number | null
  maxScore?: number | null
  highScoreCount?: number | null
  perfectScoreCount?: number | null
}): DataQualityCheck {
  const total = Number(input.total ?? 0)
  if (total <= 0) {
    return {
      id: 'screener_score_distribution',
      label: 'Screener score distribution',
      status: 'fail',
      summary: 'no screener scores to validate distribution',
      metrics: { total },
    }
  }

  const avgScore = Number(input.avgScore ?? 0)
  const minScore = Number(input.minScore ?? 0)
  const maxScore = Number(input.maxScore ?? 0)
  const highScoreCount = Number(input.highScoreCount ?? 0)
  const perfectScoreCount = Number(input.perfectScoreCount ?? 0)
  const highScoreRatio = highScoreCount / total
  const perfectScoreRatio = perfectScoreCount / total
  const scoreRange = maxScore - minScore
  const compressed = highScoreRatio > 0.85 || perfectScoreRatio > 0.1 || (avgScore >= 90 && scoreRange < 15)
  return {
    id: 'screener_score_distribution',
    label: 'Screener score distribution',
    status: compressed ? 'warn' : 'ok',
    summary: `avg=${avgScore.toFixed(1)} range=${minScore.toFixed(1)}~${maxScore.toFixed(1)} high=${highScoreCount}/${total} perfect=${perfectScoreCount}`,
    metrics: {
      total,
      avg_score: avgScore,
      min_score: minScore,
      max_score: maxScore,
      high_score_count: highScoreCount,
      perfect_score_count: perfectScoreCount,
      high_score_ratio: highScoreRatio,
      perfect_score_ratio: perfectScoreRatio,
      score_range: scoreRange,
    },
  }
}

export function buildScreenerSourceOfTruthCheck(input: {
  targetDate: string
  funnelRunId?: string | null
  funnelStatus?: string | null
  funnelFinalCount: number
  funnelEmergingCount: number
  dailyTotal: number
  tradableCount: number
  emergingCount: number
  eligibleMlCount: number
  eligiblePendingCount: number
}): DataQualityCheck {
  const dailyTotal = Number(input.dailyTotal ?? 0)
  const funnelFinalCount = Number(input.funnelFinalCount ?? 0)
  const funnelEmergingCount = Number(input.funnelEmergingCount ?? 0)
  const funnelTotal = funnelFinalCount + funnelEmergingCount
  const tradableCount = Number(input.tradableCount ?? 0)
  const emergingCount = Number(input.emergingCount ?? 0)
  const eligibleMlCount = Number(input.eligibleMlCount ?? 0)
  const eligiblePendingCount = Number(input.eligiblePendingCount ?? 0)
  const funnelStatus = input.funnelStatus ?? null
  const funnelRunId = input.funnelRunId ?? null
  const baseMetrics = {
    target_date: input.targetDate,
    funnel_run_id: funnelRunId,
    funnel_status: funnelStatus,
    funnel_final_count: funnelFinalCount,
    funnel_emerging_count: funnelEmergingCount,
    funnel_total: funnelTotal,
    daily_total: dailyTotal,
    tradable_count: tradableCount,
    emerging_count: emergingCount,
    eligible_ml_count: eligibleMlCount,
    eligible_pending_count: eligiblePendingCount,
    source_of_truth: 'screener_funnel_runs -> daily_recommendations seed rows',
  }

  if (!funnelRunId) {
    return {
      id: 'screener_source_of_truth',
      label: 'Screener source of truth',
      status: 'fail',
      summary: `no screener funnel run for ${input.targetDate}; daily=${dailyTotal}`,
      metrics: baseMetrics,
    }
  }

  if (funnelStatus !== 'success') {
    return {
      id: 'screener_source_of_truth',
      label: 'Screener source of truth',
      status: 'fail',
      summary: `latest screener funnel status=${funnelStatus ?? 'missing'} for ${input.targetDate}`,
      metrics: baseMetrics,
    }
  }

  const aligned =
    dailyTotal === funnelTotal &&
    tradableCount === funnelFinalCount &&
    emergingCount === funnelEmergingCount &&
    eligibleMlCount === dailyTotal &&
    eligiblePendingCount === tradableCount

  return {
    id: 'screener_source_of_truth',
    label: 'Screener source of truth',
    status: aligned ? 'ok' : 'fail',
    summary: aligned
      ? `daily=${dailyTotal} funnel=${funnelTotal} tradable=${tradableCount} emerging=${emergingCount}`
      : `daily=${dailyTotal} funnel=${funnelTotal} tradable=${tradableCount}/${funnelFinalCount} emerging=${emergingCount}/${funnelEmergingCount} eligible_ml=${eligibleMlCount}/${dailyTotal} pending=${eligiblePendingCount}/${tradableCount}`,
    metrics: baseMetrics,
  }
}

export function buildClassificationCoverageCheck(input: {
  total: number
  missingIndustryTags: number
  tradableTotal?: number
  tradableMissingIndustryTags?: number
  researchTotal?: number
  researchMissingIndustryTags?: number
}): DataQualityCheck {
  const total = Number(input.total ?? 0)
  const missing = Number(input.missingIndustryTags ?? 0)
  const tradableTotal = Number(input.tradableTotal ?? total)
  const tradableMissing = Number(input.tradableMissingIndustryTags ?? missing)
  const researchTotal = Number(input.researchTotal ?? Math.max(0, total - tradableTotal))
  const researchMissing = Number(input.researchMissingIndustryTags ?? Math.max(0, missing - tradableMissing))
  if (total <= 0) {
    return {
      id: 'classification_coverage',
      label: 'Classification coverage',
      status: 'fail',
      summary: 'no recommendation rows to validate classification coverage',
      metrics: { total },
    }
  }

  const statusTotal = tradableTotal > 0 ? tradableTotal : total
  const statusMissing = tradableTotal > 0 ? tradableMissing : missing
  const ratio = statusMissing / Math.max(1, statusTotal)
  const status: DataQualityStatus = ratio > 0.5
    ? 'fail'
    : ratio > 0.25
      ? 'warn'
      : 'ok'

  return {
    id: 'classification_coverage',
    label: 'Classification coverage',
    status,
    summary: `tradable_industry_tags=${tradableTotal - tradableMissing}/${tradableTotal} missing=${tradableMissing}; research_missing=${researchMissing}/${researchTotal}`,
    metrics: {
      total,
      missing_industry_tags: missing,
      missing_ratio: ratio,
      tradable_total: tradableTotal,
      tradable_missing_industry_tags: tradableMissing,
      research_total: researchTotal,
      research_missing_industry_tags: researchMissing,
      status_scope: tradableTotal > 0 ? 'tradable_lane' : 'all_recommendations',
    },
  }
}

export function buildRrgTaxonomyCoverageCheck(input: {
  latestThemeDate?: string | null
  targetDate: string
  latestThemeRows: number
  topConceptSymbols: number
  topUnmappedSymbols: number
  topOtherSymbols: number
  warnUnmappedRatio?: number
}): DataQualityCheck {
  const latestThemeRows = Number(input.latestThemeRows ?? 0)
  const topConceptSymbols = Number(input.topConceptSymbols ?? 0)
  const topUnmappedSymbols = Number(input.topUnmappedSymbols ?? 0)
  const topOtherSymbols = Number(input.topOtherSymbols ?? 0)
  const lagDays = daysBetweenDates(input.latestThemeDate, input.targetDate)
  const unmappedRatio = topConceptSymbols > 0 ? topUnmappedSymbols / topConceptSymbols : 0
  const warnUnmappedRatio = Number(input.warnUnmappedRatio ?? 0.02)
  const status: DataQualityStatus = latestThemeRows <= 0 || lagDays == null || lagDays > 0
    ? 'fail'
    : topUnmappedSymbols > 0 || topOtherSymbols > 0 || unmappedRatio > warnUnmappedRatio
      ? 'warn'
      : 'ok'
  return {
    id: 'rrg_taxonomy_coverage',
    label: 'RRG taxonomy coverage',
    status,
    summary: `theme_date=${input.latestThemeDate ?? 'none'} lag=${lagDays ?? 'n/a'}d themes=${latestThemeRows} unmapped=${topUnmappedSymbols}/${topConceptSymbols} other=${topOtherSymbols}`,
    metrics: {
      latest_theme_date: input.latestThemeDate ?? null,
      target_date: input.targetDate,
      lag_days: lagDays,
      latest_theme_rows: latestThemeRows,
      top_concept_symbols: topConceptSymbols,
      top_unmapped_symbols: topUnmappedSymbols,
      top_other_symbols: topOtherSymbols,
      unmapped_ratio: unmappedRatio,
      warn_unmapped_ratio: warnUnmappedRatio,
      source_of_truth: 'stock_tags.tag_type=concept + latest sector_flow.classification=theme',
    },
  }
}

export function buildPendingBuyDateSanityCheck(input: {
  targetDate: string
  runTradeDate?: string | null
  sourceRecoDate?: string | null
  candidateCount?: number | null
  activeCount?: number | null
}): DataQualityCheck {
  const runTradeDate = input.runTradeDate ?? null
  const sourceRecoDate = input.sourceRecoDate ?? null
  const candidateCount = Number(input.candidateCount ?? 0)
  const activeCount = Number(input.activeCount ?? 0)
  const baseMetrics = {
    target_date: input.targetDate,
    run_trade_date: runTradeDate,
    source_reco_date: sourceRecoDate,
    candidate_count: candidateCount,
    active_count: activeCount,
  }

  if (!runTradeDate) {
    return {
      id: 'pending_buy_date_sanity',
      label: 'Pending-buy date sanity',
      status: 'warn',
      summary: `no pending-buy run for ${input.targetDate}`,
      metrics: baseMetrics,
    }
  }

  if (runTradeDate !== input.targetDate) {
    return {
      id: 'pending_buy_date_sanity',
      label: 'Pending-buy date sanity',
      status: 'fail',
      summary: `pending-buy run trade_date=${runTradeDate} does not match target=${input.targetDate}`,
      metrics: baseMetrics,
    }
  }

  const lagDays = daysBetweenDates(sourceRecoDate, runTradeDate)
  if (lagDays == null) {
    return {
      id: 'pending_buy_date_sanity',
      label: 'Pending-buy date sanity',
      status: 'warn',
      summary: `pending-buy run ${runTradeDate} is missing source_reco_date`,
      metrics: baseMetrics,
    }
  }

  if (lagDays <= 0) {
    return {
      id: 'pending_buy_date_sanity',
      label: 'Pending-buy date sanity',
      status: 'fail',
      summary: `pending buys must use prior recommendations; source=${sourceRecoDate} trade=${runTradeDate}`,
      metrics: { ...baseMetrics, lag_days: lagDays },
    }
  }

  if (lagDays > 7) {
    return {
      id: 'pending_buy_date_sanity',
      label: 'Pending-buy date sanity',
      status: 'warn',
      summary: `pending-buy source recommendations are stale by ${lagDays}d`,
      metrics: { ...baseMetrics, lag_days: lagDays },
    }
  }

  return {
    id: 'pending_buy_date_sanity',
    label: 'Pending-buy date sanity',
    status: 'ok',
    summary: `trade_date=${runTradeDate} source_reco_date=${sourceRecoDate} lag=${lagDays}d candidates=${candidateCount} active=${activeCount}`,
    metrics: { ...baseMetrics, lag_days: lagDays },
  }
}

export function buildSurfaceRoleConsistencyCheck(input: {
  recommendationRole?: string | null
  pendingBuyRole?: string | null
}): DataQualityCheck {
  const recommendationRole = input.recommendationRole ?? null
  const pendingBuyRole = input.pendingBuyRole ?? null
  const ok = recommendationRole === 'recommendation_candidate' && pendingBuyRole === 'execution_pool'
  return {
    id: 'surface_role_consistency',
    label: 'Dashboard/Bot source roles',
    status: ok ? 'ok' : 'fail',
    summary: ok
      ? 'recommendation cards and pending-buy cards use distinct source roles'
      : `invalid source roles recommendation=${recommendationRole ?? 'missing'} pending_buy=${pendingBuyRole ?? 'missing'}`,
    metrics: {
      recommendation_role: recommendationRole,
      pending_buy_role: pendingBuyRole,
    },
  }
}

export function buildBoardLaneContractCheck(input: {
  emergingRecommendations: number
  pendingBuyEmergingLike: number
}): DataQualityCheck {
  const emergingRecommendations = Number(input.emergingRecommendations ?? 0)
  const pendingBuyEmergingLike = Number(input.pendingBuyEmergingLike ?? 0)
  return {
    id: 'board_lane_contract',
    label: 'Board lane contract',
    status: pendingBuyEmergingLike > 0 ? 'fail' : 'ok',
    summary: pendingBuyEmergingLike > 0
      ? `${pendingBuyEmergingLike} emerging-style pending buys detected`
      : `emerging watchlist=${emergingRecommendations}; pending buys contain no emerging-style rows`,
    metrics: {
      emerging_recommendations: emergingRecommendations,
      pending_buy_emerging_like: pendingBuyEmergingLike,
    },
  }
}

export function buildPendingBuyAllocatorOwnerCheck(input: {
  activeCount: number
  l4SparseFinalBuyCount: number
  invalidAllocatorCount: number
  watchSourceCount: number
  missingRecommendationCount: number
}): DataQualityCheck {
  const activeCount = Number(input.activeCount ?? 0)
  const l4SparseFinalBuyCount = Number(input.l4SparseFinalBuyCount ?? 0)
  const invalidAllocatorCount = Number(input.invalidAllocatorCount ?? 0)
  const watchSourceCount = Number(input.watchSourceCount ?? 0)
  const missingRecommendationCount = Number(input.missingRecommendationCount ?? 0)
  const failed = invalidAllocatorCount > 0 || watchSourceCount > 0 || missingRecommendationCount > 0
  return {
    id: 'pending_buy_l4_allocator_owner',
    label: 'Pending-buy L4 allocator owner',
    status: failed ? 'fail' : 'ok',
    summary: failed
      ? `pending buys must be L4 sparse final BUY only; invalid=${invalidAllocatorCount} watch=${watchSourceCount} missing_reco=${missingRecommendationCount}`
      : `active=${activeCount}; l4_sparse_final_buy=${l4SparseFinalBuyCount}; no executable watch fallback`,
    metrics: {
      active_count: activeCount,
      l4_sparse_final_buy_count: l4SparseFinalBuyCount,
      pending_buy_invalid_allocator_count: invalidAllocatorCount,
      pending_buy_watch_source_count: watchSourceCount,
      pending_buy_missing_recommendation_count: missingRecommendationCount,
    },
  }
}

function normalizedDate(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim()
  return raw ? raw.slice(0, 10) : null
}

export function buildMarketDashboardMaterializationCheck(input: {
  targetDate: string
  sources: MarketDashboardMaterializationSource[]
}): DataQualityCheck {
  const items = input.sources.map((source) => {
    const rows = Math.max(0, Math.trunc(Number(source.rows ?? 0)))
    const latestDate = normalizedDate(source.latestDate)
    const lagDays = daysBetweenDates(latestDate, input.targetDate)
    const required = source.required !== false
    let status: DataQualityStatus = 'ok'
    let rootCause = source.rootCause ?? null

    if (rows <= 0 || !latestDate) {
      status = required ? 'fail' : 'warn'
      rootCause = rootCause ?? 'not_materialized'
    } else if (lagDays == null || lagDays > source.failLagDays) {
      status = required ? 'fail' : 'warn'
      rootCause = rootCause ?? 'stale_materialization'
    } else if (lagDays > source.warnLagDays) {
      status = 'warn'
      rootCause = rootCause ?? 'freshness_lag'
    } else if (!required && rootCause && !['ok', 'ready', 'fresh'].includes(String(rootCause).toLowerCase())) {
      status = 'warn'
    }

    return {
      key: source.key,
      label: source.label,
      status,
      rows,
      latest_date: latestDate,
      lag_days: lagDays,
      warn_lag_days: source.warnLagDays,
      fail_lag_days: source.failLagDays,
      required,
      source: source.source,
      scope: source.scope ?? 'market_dashboard',
      root_cause: rootCause,
    }
  })

  const failItems = items.filter((item) => item.status === 'fail')
  const warnItems = items.filter((item) => item.status === 'warn')
  const status: DataQualityStatus = failItems.length ? 'fail' : warnItems.length ? 'warn' : 'ok'

  return {
    id: 'market_dashboard_materialization',
    label: 'Market dashboard materialization',
    status,
    summary: status === 'ok'
      ? 'homepage market dashboard sources are materialized'
      : `market dashboard gaps fail=${failItems.length} warn=${warnItems.length}`,
    metrics: {
      target_date: input.targetDate,
      materialization_checks: items,
      missing_required: failItems.map((item) => item.key),
      stale_or_optional_gaps: warnItems.map((item) => item.key),
      source_of_truth: [
        'canonical_market_daily',
        'canonical_market_index_daily',
        'canonical_futures_daily',
        'canonical_market_summary_daily',
        'canonical_institutional_amount_daily',
        'canonical_regime_context_daily',
        'external_evidence_items',
      ],
    },
  }
}

function buildSchemaCheck(columns: string[]): DataQualityCheck {
  const required = [
    'date',
    'stock_id',
    'symbol',
    'rank',
    'score',
    'signal',
    'confidence',
    'chip_score',
    'tech_score',
    'momentum_score',
    'ml_score',
    'alpha_context',
    'alpha_allocation',
    'ml_vote_summary',
    'score_components',
  ]
  const missing = required.filter((column) => !columns.includes(column))
  return {
    id: 'daily_recommendations_schema',
    label: 'Recommendation schema',
    status: missing.length ? 'fail' : 'ok',
    summary: missing.length ? `missing columns: ${missing.join(', ')}` : 'daily_recommendations schema ok',
    metrics: { required_columns: required, missing_columns: missing },
  }
}

export function buildDatasetSnapshotManifestCheck(input: {
  targetDate: string
  priceHotWindow: number
  technicalHotWindow: number
  chipHotWindow: number
  backtestComputeSnapshot: number
  priceHistoryComputeSnapshot: number
  pipelineReport: number
  screenerReport: number
  total: number
  latestD1ServingManifestAt?: string | null
  latestGcsComputeManifestAt?: string | null
  latestR2ReportManifestAt?: string | null
}): DataQualityCheck {
  const missingServing = [
    input.priceHotWindow > 0 ? null : 'price_hot_window',
    input.technicalHotWindow > 0 ? null : 'technical_indicator_hot_window',
    input.chipHotWindow > 0 ? null : 'chip_hot_window',
  ].filter(Boolean)
  const missingArtifacts = [
    input.backtestComputeSnapshot > 0 ? null : 'backtest_dataset_compute',
    input.priceHistoryComputeSnapshot > 0 ? null : 'price_history_compute',
    input.pipelineReport > 0 ? null : 'pipeline_run_report_r2',
    input.screenerReport > 0 ? null : 'screener_run_report_r2',
  ].filter(Boolean)
  const status: DataQualityStatus = missingServing.length ? 'fail' : missingArtifacts.length ? 'warn' : 'ok'
  const summary = status === 'ok'
    ? `D1 serving manifests and object-store artifacts ready for ${input.targetDate}`
    : missingServing.length
      ? `source-of-truth D1 serving manifests missing: ${missingServing.join(', ')}`
      : `D1 serving manifests ready; object-store artifacts pending: ${missingArtifacts.join(', ')}`

  return {
    id: 'dataset_snapshot_manifest',
    label: 'Dataset snapshot manifest',
    status,
    summary,
    metrics: {
      target_date: input.targetDate,
      manifest_total: input.total,
      missing_serving_manifests: missingServing,
      pending_object_artifacts: missingArtifacts,
      source_snapshot_frequency: {
        d1_serving: 'after indicator queue finalize',
        r2_report: 'after screener/pipeline callback',
        gcs_compute: 'after daily_pipeline_v2 write_d1',
      },
      latest_manifest_at: {
        d1_serving: input.latestD1ServingManifestAt ?? null,
        gcs_compute: input.latestGcsComputeManifestAt ?? null,
        r2_report: input.latestR2ReportManifestAt ?? null,
      },
      price_hot_window_manifest: input.priceHotWindow,
      technical_indicator_hot_window_manifest: input.technicalHotWindow,
      chip_hot_window_manifest: input.chipHotWindow,
      backtest_compute_snapshot_manifest: input.backtestComputeSnapshot,
      price_history_compute_snapshot_manifest: input.priceHistoryComputeSnapshot,
      pipeline_report_manifest: input.pipelineReport,
      screener_report_manifest: input.screenerReport,
    },
  }
}

export function buildRetrainFollowupClosureCheck(input: {
  awaiting: number
  stale: number
  oldestAt?: string | null
  latestAt?: string | null
}): DataQualityCheck {
  const awaiting = Number(input.awaiting ?? 0)
  const stale = Number(input.stale ?? 0)
  const status: DataQualityStatus = stale > 0 ? 'fail' : awaiting > 0 ? 'warn' : 'ok'
  return {
    id: 'retrain_followup_closure',
    label: 'Monthly retrain followup closure',
    status,
    summary: status === 'ok'
      ? 'No monthly retrain run is waiting for Modal followup.'
      : stale > 0
        ? `monthly retrain followup appears orphaned stale=${stale}/${awaiting}`
        : `monthly retrain followup still in flight awaiting=${awaiting}`,
    metrics: {
      awaiting_modal_followup: awaiting,
      stale_4h: stale,
      oldest_awaiting_at: input.oldestAt ?? null,
      latest_awaiting_at: input.latestAt ?? null,
      stale_rule: 'status=orchestrator_dispatched + downstream_notes=await_modal_followup + age>4h',
    },
  }
}

async function firstCount(db: D1Database, sql: string, ...binds: unknown[]): Promise<CountRow> {
  return await db.prepare(sql).bind(...binds).first<CountRow>() ?? {}
}

async function latestTableStats(db: D1Database, table: string, dateColumn = 'date'): Promise<CountRow> {
  const latest = await firstCount(db, `SELECT MAX(${dateColumn}) AS latest_date FROM ${table}`)
  if (!latest.latest_date) return { latest_date: null, rows_on_latest: 0 }
  const count = await firstCount(db, `SELECT COUNT(*) AS count FROM ${table} WHERE ${dateColumn} = ?`, latest.latest_date)
  return { latest_date: latest.latest_date, rows_on_latest: Number(count.count ?? 0) }
}

export async function buildDataQualityReport(env: Bindings, options: { date?: string } = {}) {
  const targetDate = options.date ?? await resolveExpectedCompletedDataDate(env.KV, twToday())
  const expectedModelPlaceholders = EXPECTED_V2_MODELS.map(() => '?').join(',')

  const [
    priceStats,
    chipStats,
    tiStats,
    recommendationStats,
    screenerSeedStats,
    classificationStats,
    rrgTaxonomyStats,
    screenerFunnelStats,
    pendingBuyStats,
    boardLaneStats,
    predictionGroups,
    featureVersionStats,
    modelIcEvidence,
    schemaRows,
    datasetManifestStats,
    themeSignalStats,
    stockThemeFeatureStats,
    retrainFollowupStats,
    marketIndexTwiiStats,
    marketIndexTwoiiStats,
    futuresDayStats,
    canonicalMarketDailyOverviewStats,
    marketSummaryStats,
    institutionalAmountStats,
    pcrStats,
    largeTraderStats,
    businessSignalStats,
    gdeltStats,
    gdeltQualityStats,
  ] = await Promise.all([
    latestTableStats(env.DB, 'stock_prices'),
    latestTableStats(env.DB, 'chip_data'),
    latestTableStats(env.DB, 'technical_indicators'),
    firstCount(
      env.DB,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN score_components LIKE '%score_v2%' THEN 1 ELSE 0 END) AS score_v2_count,
              SUM(CASE WHEN signal IS NOT NULL AND signal <> '' THEN 1 ELSE 0 END) AS signal_count,
              SUM(CASE WHEN confidence IS NOT NULL THEN 1 ELSE 0 END) AS confidence_count
       FROM daily_recommendations WHERE date = ?`,
      targetDate,
    ),
    firstCount(
      env.DB,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN sector IS NULL OR TRIM(sector) = '' OR sector IN (?, ?) OR industry IS NULL OR TRIM(industry) = '' OR industry IN (?, ?) THEN 1 ELSE 0 END) AS unclassified,
              SUM(CASE WHEN score IS NULL OR score < 0 OR score > 100 THEN 1 ELSE 0 END) AS invalid_scores,
              SUM(CASE WHEN score_components IS NULL OR score_components NOT LIKE '%score_v2%' THEN 1 ELSE 0 END) AS missing_components,
              SUM(CASE WHEN reason IS NULL OR reason = '' THEN 1 ELSE 0 END) AS missing_reasons,
              SUM(CASE WHEN current_price IS NOT NULL AND current_price > 0 THEN 1 ELSE 0 END) AS current_price_valid,
              SUM(CASE WHEN recommendation_lane = 'tradable' THEN 1 ELSE 0 END) AS tradable_count,
              SUM(CASE WHEN recommendation_lane = 'emerging_watchlist' THEN 1 ELSE 0 END) AS emerging_watchlist_count,
              SUM(CASE WHEN COALESCE(eligible_for_ml, 0) = 1 THEN 1 ELSE 0 END) AS eligible_ml_count,
              SUM(CASE WHEN COALESCE(eligible_for_pending_buy, 0) = 1 THEN 1 ELSE 0 END) AS eligible_pending_count,
              AVG(score) AS avg_score,
              MIN(score) AS min_score,
              MAX(score) AS max_score,
              SUM(CASE WHEN score >= 90 THEN 1 ELSE 0 END) AS high_score_count,
              SUM(CASE WHEN score >= 100 THEN 1 ELSE 0 END) AS perfect_score_count
       FROM daily_recommendations WHERE date = ?`,
      UNCLASSIFIED_LABEL,
      UNCLASSIFIED_EN_LABEL,
      UNCLASSIFIED_LABEL,
      UNCLASSIFIED_EN_LABEL,
      targetDate,
    ),
    firstCount(
      env.DB,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN st.symbol IS NULL THEN 1 ELSE 0 END) AS missing_industry_tags,
              SUM(CASE WHEN dr.recommendation_lane = 'tradable' THEN 1 ELSE 0 END) AS tradable_total,
              SUM(CASE WHEN dr.recommendation_lane = 'tradable' AND st.symbol IS NULL THEN 1 ELSE 0 END) AS tradable_missing_industry_tags,
              SUM(CASE WHEN dr.recommendation_lane <> 'tradable' THEN 1 ELSE 0 END) AS research_total,
              SUM(CASE WHEN dr.recommendation_lane <> 'tradable' AND st.symbol IS NULL THEN 1 ELSE 0 END) AS research_missing_industry_tags
       FROM daily_recommendations dr
       LEFT JOIN stock_tags st
         ON st.symbol = dr.symbol AND st.tag_type = 'industry'
       WHERE dr.date = ?`,
      targetDate,
    ),
    firstCount(
      env.DB,
      `WITH latest_theme_date AS (
         SELECT MAX(date) AS latest_theme_date
           FROM sector_flow
          WHERE classification = 'theme'
            AND quadrant IS NOT NULL
       ),
       latest_theme AS (
         SELECT sector
           FROM sector_flow
          WHERE classification = 'theme'
            AND quadrant IS NOT NULL
            AND date = (SELECT latest_theme_date FROM latest_theme_date)
       ),
       ranked_concepts AS (
         SELECT st.symbol,
                st.tag,
                lt.sector AS matched_theme,
                ROW_NUMBER() OVER (
                  PARTITION BY st.symbol
                  ORDER BY CASE WHEN lt.sector IS NOT NULL THEN 0 ELSE 1 END,
                           st.weight DESC,
                           st.tag ASC
                ) AS rn
           FROM stock_tags st
           LEFT JOIN latest_theme lt ON lt.sector = st.tag
          WHERE st.tag_type = 'concept'
       )
       SELECT
         (SELECT latest_theme_date FROM latest_theme_date) AS latest_theme_date,
         (SELECT COUNT(*) FROM latest_theme) AS latest_theme_rows,
         COUNT(*) AS top_concept_symbols,
         SUM(CASE WHEN rc.matched_theme IS NULL THEN 1 ELSE 0 END) AS top_unmapped_symbols,
         SUM(CASE WHEN rc.tag = '其他' THEN 1 ELSE 0 END) AS top_other_symbols
        FROM ranked_concepts rc
       WHERE rc.rn = 1`,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `SELECT run_id AS funnel_run_id,
              status AS funnel_status,
              final_count AS funnel_final_count,
              emerging_count AS funnel_emerging_count,
              candidate_count AS funnel_candidate_count,
              universe_count AS funnel_universe_count,
              created_at AS funnel_created_at
         FROM screener_funnel_runs
        WHERE date = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      targetDate,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `WITH latest_run AS (
         SELECT *
           FROM pending_buy_runs
          WHERE trade_date = ? AND COALESCE(status, '') <> 'superseded'
          ORDER BY id DESC
          LIMIT 1
       )
       SELECT r.trade_date AS run_trade_date,
              r.source_reco_date AS source_reco_date,
              r.candidate_count AS candidate_count,
              SUM(CASE WHEN i.id IS NOT NULL AND COALESCE(i.execution_status, 'pending') NOT IN ('filled', 'skipped', 'cancelled', 'expired') THEN 1 ELSE 0 END) AS active_count,
              SUM(CASE WHEN i.id IS NOT NULL
                         AND COALESCE(i.execution_status, 'pending') NOT IN ('filled', 'skipped', 'cancelled', 'expired')
                         AND COALESCE(dr.has_buy_signal, 0) = 1
                         AND json_valid(dr.alpha_allocation)
                         AND COALESCE(CASE WHEN json_valid(dr.alpha_allocation) THEN json_extract(dr.alpha_allocation, '$.selected') ELSE 0 END, 0) = 1
                         AND COALESCE(CASE WHEN json_valid(dr.alpha_allocation) THEN json_extract(dr.alpha_allocation, '$.engine') ELSE '' END, '') = 'sparse_tangent_inverse_risk'
                       THEN 1 ELSE 0 END) AS l4_sparse_final_buy_count,
              SUM(CASE WHEN i.id IS NOT NULL
                         AND COALESCE(i.execution_status, 'pending') NOT IN ('filled', 'skipped', 'cancelled', 'expired')
                         AND (
                           dr.symbol IS NULL
                           OR COALESCE(dr.has_buy_signal, 0) <> 1
                           OR NOT json_valid(dr.alpha_allocation)
                           OR COALESCE(CASE WHEN json_valid(dr.alpha_allocation) THEN json_extract(dr.alpha_allocation, '$.selected') ELSE 0 END, 0) <> 1
                           OR COALESCE(CASE WHEN json_valid(dr.alpha_allocation) THEN json_extract(dr.alpha_allocation, '$.engine') ELSE '' END, '') <> 'sparse_tangent_inverse_risk'
                         )
                       THEN 1 ELSE 0 END) AS pending_buy_invalid_allocator_count,
              SUM(CASE WHEN i.id IS NOT NULL
                         AND COALESCE(i.execution_status, 'pending') NOT IN ('filled', 'skipped', 'cancelled', 'expired')
                         AND (
                           UPPER(COALESCE(i.signal, '')) = 'WATCH_BUY'
                           OR LOWER(COALESCE(i.source, '')) LIKE '%watch%'
                         )
                       THEN 1 ELSE 0 END) AS pending_buy_watch_source_count,
              SUM(CASE WHEN i.id IS NOT NULL
                         AND COALESCE(i.execution_status, 'pending') NOT IN ('filled', 'skipped', 'cancelled', 'expired')
                         AND dr.symbol IS NULL
                       THEN 1 ELSE 0 END) AS pending_buy_missing_recommendation_count
       FROM latest_run r
       LEFT JOIN pending_buy_items i ON i.run_id = r.id
       LEFT JOIN daily_recommendations dr
         ON dr.date = COALESCE(r.source_reco_date, r.trade_date)
        AND dr.symbol = i.symbol
       GROUP BY r.id
       LIMIT 1`,
      targetDate,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `SELECT
          (
            SELECT COUNT(*)
              FROM daily_recommendations dr
              LEFT JOIN stocks s ON s.id = dr.stock_id
             WHERE dr.date = ?
               AND (
                 COALESCE(UPPER(s.market), '') IN ('EMERGING', 'ESB')
                 OR (
                   (
                     SELECT sp.open
                       FROM stock_prices sp
                      WHERE sp.stock_id = dr.stock_id
                        AND sp.date <= dr.date
                      ORDER BY sp.date DESC
                      LIMIT 1
                   ) IS NULL
                   AND (
                     SELECT sp.avg_price
                       FROM stock_prices sp
                      WHERE sp.stock_id = dr.stock_id
                        AND sp.date <= dr.date
                      ORDER BY sp.date DESC
                      LIMIT 1
                   ) IS NOT NULL
                 )
               )
          ) AS emerging_recommendations,
          (
            SELECT COUNT(*)
              FROM pending_buy_runs r
              JOIN pending_buy_items i ON i.run_id = r.id
              LEFT JOIN stocks s ON s.symbol = i.symbol
             WHERE r.trade_date = ?
               AND COALESCE(r.status, '') <> 'superseded'
               AND (
                 COALESCE(UPPER(s.market), '') IN ('EMERGING', 'ESB')
                 OR (
                   (
                     SELECT sp.open
                       FROM stock_prices sp
                      WHERE sp.stock_id = s.id
                        AND sp.date <= COALESCE(r.source_reco_date, r.trade_date)
                      ORDER BY sp.date DESC
                      LIMIT 1
                   ) IS NULL
                   AND (
                     SELECT sp.avg_price
                       FROM stock_prices sp
                      WHERE sp.stock_id = s.id
                        AND sp.date <= COALESCE(r.source_reco_date, r.trade_date)
                      ORDER BY sp.date DESC
                      LIMIT 1
                   ) IS NOT NULL
                 )
               )
          ) AS pending_buy_emerging_like`,
      targetDate,
      targetDate,
    ).catch((): CountRow => ({})),
    env.DB.prepare(
      `SELECT model_name, COUNT(*) AS count, COUNT(DISTINCT stock_id) AS stocks
       FROM predictions
       WHERE prediction_date = ?
       GROUP BY model_name ORDER BY model_name`,
    ).bind(targetDate).all<PredictionCoverageRow>(),
    firstCount(
      env.DB,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN feature_version IS NULL OR TRIM(feature_version) = '' THEN 1 ELSE 0 END) AS missing_feature_version,
              COUNT(DISTINCT CASE WHEN feature_version IS NOT NULL AND TRIM(feature_version) <> '' THEN feature_version END) AS distinct_feature_versions
       FROM predictions
       WHERE prediction_date = ?`,
      targetDate,
    ).catch((): CountRow => ({})),
    env.DB.prepare(
      `SELECT model_name,
              COUNT(*) AS count,
              COUNT(DISTINCT stock_id) AS stocks,
              MAX(date(verified_at)) AS latest_date
       FROM predictions
       WHERE model_name IN (${expectedModelPlaceholders})
         AND actual_return_pct IS NOT NULL
         AND verified_at IS NOT NULL
         AND date(prediction_date) >= date('now', '-7 days')
       GROUP BY model_name
       ORDER BY model_name`,
    ).bind(...EXPECTED_V2_MODELS).all<ModelIcEvidenceRow>(),
    env.DB.prepare('PRAGMA table_info(daily_recommendations)').all<{ name: string }>(),
    firstCount(
      env.DB,
      `SELECT COUNT(*) AS manifest_total,
              SUM(CASE WHEN kind = 'price_hot_window' AND access_tier = 'serving' AND status = 'ready' THEN 1 ELSE 0 END) AS price_hot_window_manifest,
              SUM(CASE WHEN kind = 'technical_indicator_hot_window' AND access_tier = 'serving' AND status = 'ready' THEN 1 ELSE 0 END) AS technical_indicator_hot_window_manifest,
              SUM(CASE WHEN kind = 'chip_hot_window' AND access_tier = 'serving' AND status = 'ready' THEN 1 ELSE 0 END) AS chip_hot_window_manifest,
              SUM(CASE WHEN kind = 'backtest_dataset' AND access_tier = 'compute' AND status = 'ready' THEN 1 ELSE 0 END) AS backtest_compute_snapshot_manifest,
              SUM(CASE WHEN kind = 'price_history' AND access_tier = 'compute' AND status = 'ready' THEN 1 ELSE 0 END) AS price_history_compute_snapshot_manifest,
              SUM(CASE WHEN kind = 'pipeline_run_report' AND access_tier = 'report' AND status = 'ready' THEN 1 ELSE 0 END) AS pipeline_report_manifest,
              SUM(CASE WHEN kind = 'screener_run_report' AND access_tier = 'report' AND status = 'ready' THEN 1 ELSE 0 END) AS screener_report_manifest,
              MAX(CASE WHEN access_tier = 'serving' AND status = 'ready' THEN created_at ELSE NULL END) AS latest_d1_serving_manifest_at,
              MAX(CASE WHEN access_tier = 'compute' AND status = 'ready' THEN created_at ELSE NULL END) AS latest_gcs_compute_manifest_at,
              MAX(CASE WHEN access_tier = 'report' AND status = 'ready' THEN created_at ELSE NULL END) AS latest_r2_report_manifest_at
         FROM dataset_snapshots
        WHERE business_date = ?`,
      targetDate,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `SELECT COUNT(*) AS theme_signal_total,
              COUNT(DISTINCT source) AS theme_signal_sources,
              MAX(generated_at) AS theme_signal_latest_generated_at
         FROM theme_signals
        WHERE date = ?`,
      targetDate,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `SELECT COUNT(*) AS stock_theme_feature_total,
              COUNT(DISTINCT symbol) AS stock_theme_feature_symbols,
              MAX(generated_at) AS stock_theme_feature_latest_generated_at
         FROM stock_theme_features
        WHERE date = ?`,
      targetDate,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `SELECT COUNT(*) AS awaiting_retrain_followup,
              SUM(CASE WHEN julianday(received_at) < julianday('now') - (4.0 / 24.0) THEN 1 ELSE 0 END) AS stale_retrain_followup,
              MIN(received_at) AS oldest_retrain_followup_at,
              MAX(received_at) AS latest_retrain_followup_at
         FROM webhook_log
        WHERE action = 'retrain_followup'
          AND status = 'orchestrator_dispatched'
          AND downstream_notes = 'await_modal_followup'`,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `WITH latest AS (
         SELECT MAX(date) AS latest_date
           FROM canonical_market_index_daily
          WHERE symbol IN ('TWII', 'TAIEX')
       )
       SELECT (SELECT latest_date FROM latest) AS latest_date,
              COUNT(*) AS rows_on_latest
         FROM canonical_market_index_daily
        WHERE symbol IN ('TWII', 'TAIEX')
          AND date = (SELECT latest_date FROM latest)`,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `WITH latest AS (
         SELECT MAX(date) AS latest_date
           FROM canonical_market_index_daily
          WHERE symbol IN ('TWOII', 'OTC', 'TPEX')
       )
       SELECT (SELECT latest_date FROM latest) AS latest_date,
              COUNT(*) AS rows_on_latest
         FROM canonical_market_index_daily
        WHERE symbol IN ('TWOII', 'OTC', 'TPEX')
          AND date = (SELECT latest_date FROM latest)`,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `WITH latest AS (
         SELECT MAX(date) AS latest_date
           FROM canonical_futures_daily
          WHERE symbol IN ('TXF', 'TX')
            AND session = 'day'
       )
       SELECT (SELECT latest_date FROM latest) AS latest_date,
              COUNT(*) AS rows_on_latest
         FROM canonical_futures_daily
        WHERE symbol IN ('TXF', 'TX')
          AND session = 'day'
          AND date = (SELECT latest_date FROM latest)`,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `WITH ordered_dates AS (
         SELECT date
           FROM canonical_market_daily
          WHERE market_segment = 'LISTED_OTC'
          GROUP BY date
          ORDER BY date DESC
          LIMIT 2
       ),
       latest_date AS (
         SELECT MAX(date) AS date FROM ordered_dates
       ),
       previous_date AS (
         SELECT MIN(date) AS date FROM ordered_dates
       ),
       joined_rows AS (
         SELECT cur.date,
                cur.stock_id,
                cur.close,
                prev.close AS prev_close,
                cur.volume,
                cur.value
           FROM canonical_market_daily cur
           JOIN latest_date ld ON cur.date = ld.date
           LEFT JOIN canonical_market_daily prev
             ON prev.stock_id = cur.stock_id
            AND prev.date = (SELECT date FROM previous_date)
            AND prev.market_segment = cur.market_segment
          WHERE cur.close IS NOT NULL
            AND cur.market_segment = 'LISTED_OTC'
       )
       SELECT (SELECT date FROM latest_date) AS latest_date,
              COUNT(CASE WHEN prev_close IS NOT NULL THEN 1 END) AS market_breadth_rows,
              COUNT(CASE WHEN volume IS NOT NULL OR value IS NOT NULL THEN 1 END) AS turnover_rows,
              COUNT(*) AS rows_on_latest
         FROM joined_rows`,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `WITH latest AS (
         SELECT MAX(date) AS latest_date
           FROM canonical_market_summary_daily
       )
       SELECT (SELECT latest_date FROM latest) AS latest_date,
              COUNT(*) AS rows_on_latest,
              SUM(CASE WHEN advance_count IS NOT NULL AND decline_count IS NOT NULL THEN 1 ELSE 0 END) AS market_breadth_rows,
              SUM(CASE WHEN total_volume IS NOT NULL AND total_value IS NOT NULL THEN 1 ELSE 0 END) AS turnover_rows,
              SUM(CASE WHEN margin_balance_value IS NOT NULL OR margin_balance_units IS NOT NULL THEN 1 ELSE 0 END) AS margin_rows,
              SUM(CASE WHEN short_balance_units IS NOT NULL THEN 1 ELSE 0 END) AS short_rows
         FROM canonical_market_summary_daily
        WHERE date = (SELECT latest_date FROM latest)`,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `WITH latest AS (
         SELECT MAX(date) AS latest_date
           FROM canonical_institutional_amount_daily
       )
       SELECT (SELECT latest_date FROM latest) AS latest_date,
              COUNT(*) AS rows_on_latest
         FROM canonical_institutional_amount_daily
        WHERE date = (SELECT latest_date FROM latest)`,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `WITH latest AS (
         SELECT MAX(date) AS latest_date
           FROM canonical_regime_context_daily
          WHERE dataset = 'tw_option_put_call_ratio'
       )
       SELECT (SELECT latest_date FROM latest) AS latest_date,
              COUNT(*) AS rows_on_latest
         FROM canonical_regime_context_daily
        WHERE dataset = 'tw_option_put_call_ratio'
          AND date = (SELECT latest_date FROM latest)`,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `WITH latest AS (
         SELECT MAX(date) AS latest_date
           FROM canonical_regime_context_daily
          WHERE dataset = 'tw_taifex_futures_large_trader'
       )
       SELECT (SELECT latest_date FROM latest) AS latest_date,
              COUNT(*) AS rows_on_latest
         FROM canonical_regime_context_daily
        WHERE dataset = 'tw_taifex_futures_large_trader'
          AND date = (SELECT latest_date FROM latest)`,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `WITH latest AS (
         SELECT MAX(date) AS latest_date
           FROM canonical_regime_context_daily
          WHERE dataset = 'tw_business_indicators'
       )
       SELECT (SELECT latest_date FROM latest) AS latest_date,
              COUNT(*) AS rows_on_latest
         FROM canonical_regime_context_daily
        WHERE dataset = 'tw_business_indicators'
          AND date = (SELECT latest_date FROM latest)`,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `SELECT SUM(CASE WHEN date(published_at) >= date(?, '-14 days') THEN 1 ELSE 0 END) AS rows_on_latest,
              MAX(published_at) AS latest_date
         FROM external_evidence_items
        WHERE source_id = 'gdelt_events'
          AND accepted = 1`,
      targetDate,
    ).catch((): CountRow => ({})),
    firstCount(
      env.DB,
      `SELECT freshness_status,
              latest_materialization,
              CASE WHEN json_valid(metrics_json) THEN json_extract(metrics_json, '$.root_cause') ELSE NULL END AS root_cause
         FROM source_quality_metrics
        WHERE source = 'gdelt_events'
        ORDER BY as_of_date DESC
        LIMIT 1`,
    ).catch((): CountRow => ({})),
  ])

  const predictionRows = (predictionGroups.results ?? []).reduce((sum, row) => sum + Number(row.count ?? 0), 0)
  const checks: DataQualityCheck[] = [
    buildFreshnessCheck({
      id: 'price_freshness',
      label: 'Price data',
      latestDate: priceStats.latest_date,
      targetDate,
      rowsOnLatest: priceStats.rows_on_latest,
      warnLagDays: 0,
      failLagDays: 0,
      minRows: 1000,
    }),
    buildFreshnessCheck({
      id: 'chip_freshness',
      label: 'Chip data',
      latestDate: chipStats.latest_date,
      targetDate,
      rowsOnLatest: chipStats.rows_on_latest,
      warnLagDays: 0,
      failLagDays: 0,
      minRows: 1000,
    }),
    buildFreshnessCheck({
      id: 'technical_indicator_freshness',
      label: 'Technical indicators',
      latestDate: tiStats.latest_date,
      targetDate,
      rowsOnLatest: tiStats.rows_on_latest,
      warnLagDays: 0,
      failLagDays: 0,
      minRows: 1000,
    }),
    buildMarketDashboardMaterializationCheck({
      targetDate,
      sources: [
        {
          key: 'twii_index',
          label: '加權指數',
          source: 'canonical_market_index_daily symbol=TWII/TAIEX',
          rows: marketIndexTwiiStats.rows_on_latest,
          latestDate: marketIndexTwiiStats.latest_date,
          warnLagDays: 0,
          failLagDays: 1,
          scope: '首頁第一列指數',
        },
        {
          key: 'twoii_index',
          label: '櫃買指數',
          source: 'canonical_market_index_daily symbol=TWOII/OTC/TPEX',
          rows: marketIndexTwoiiStats.rows_on_latest,
          latestDate: marketIndexTwoiiStats.latest_date,
          warnLagDays: 0,
          failLagDays: 1,
          scope: '首頁第一列指數',
        },
        {
          key: 'txf_day_futures',
          label: '台指期貨日盤',
          source: 'canonical_futures_daily symbol=TXF/TX session=day',
          rows: futuresDayStats.rows_on_latest,
          latestDate: futuresDayStats.latest_date,
          warnLagDays: 0,
          failLagDays: 1,
          scope: '首頁第一列指數',
        },
        {
          key: 'market_breadth',
          label: '漲跌家數',
          source: 'canonical_market_daily LISTED_OTC close vs previous close',
          rows: canonicalMarketDailyOverviewStats.market_breadth_rows,
          latestDate: canonicalMarketDailyOverviewStats.latest_date,
          warnLagDays: 0,
          failLagDays: 1,
          scope: '首頁第二列市場概況',
        },
        {
          key: 'market_turnover',
          label: '成交量與成交金額',
          source: 'canonical_market_daily LISTED_OTC volume/value',
          rows: canonicalMarketDailyOverviewStats.turnover_rows,
          latestDate: canonicalMarketDailyOverviewStats.latest_date,
          warnLagDays: 0,
          failLagDays: 1,
          scope: '首頁第二列市場概況',
        },
        {
          key: 'margin_short_balance',
          label: '融資融券',
          source: 'canonical_market_summary_daily margin_balance/short_balance',
          rows: Math.min(Number(marketSummaryStats.margin_rows ?? 0), Number(marketSummaryStats.short_rows ?? 0)),
          latestDate: marketSummaryStats.latest_date,
          warnLagDays: 0,
          failLagDays: 1,
          scope: '首頁第二列市場概況',
        },
        {
          key: 'institutional_amount',
          label: '主要法人資金動向',
          source: 'canonical_institutional_amount_daily',
          rows: institutionalAmountStats.rows_on_latest,
          latestDate: institutionalAmountStats.latest_date,
          warnLagDays: 0,
          failLagDays: 1,
          scope: '首頁資金流',
        },
        {
          key: 'put_call_ratio',
          label: '買賣權量比',
          source: 'canonical_regime_context_daily dataset=tw_option_put_call_ratio',
          rows: pcrStats.rows_on_latest,
          latestDate: pcrStats.latest_date,
          warnLagDays: 2,
          failLagDays: 5,
          scope: '市場避險情緒',
        },
        {
          key: 'large_trader_net',
          label: '期貨大戶淨部位',
          source: 'canonical_regime_context_daily dataset=tw_taifex_futures_large_trader',
          rows: largeTraderStats.rows_on_latest,
          latestDate: largeTraderStats.latest_date,
          warnLagDays: 2,
          failLagDays: 5,
          scope: '市場避險情緒',
        },
        {
          key: 'business_signal',
          label: '景氣對策信號',
          source: 'canonical_regime_context_daily dataset=tw_business_indicators',
          rows: businessSignalStats.rows_on_latest,
          latestDate: businessSignalStats.latest_date,
          warnLagDays: 45,
          failLagDays: 60,
          scope: '景氣月頻資料',
        },
        {
          key: 'gdelt_global_news',
          label: 'GDELT 全球新聞脈絡',
          source: 'external_evidence_items source_id=gdelt_events',
          rows: gdeltStats.rows_on_latest,
          latestDate: gdeltStats.latest_date ?? gdeltQualityStats.latest_materialization,
          warnLagDays: 7,
          failLagDays: 14,
          required: false,
          scope: '最新消息下方全球脈絡',
          rootCause: gdeltQualityStats.root_cause ?? gdeltQualityStats.freshness_status ?? null,
        },
      ],
    }),
    buildPredictionCoverageCheck(predictionGroups.results ?? []),
    buildRecommendationMlOwnerCheck({
      total: Number(recommendationStats.total ?? 0),
      scoreV2Count: Number(recommendationStats.score_v2_count ?? 0),
      signalCount: Number(recommendationStats.signal_count ?? 0),
      confidenceCount: Number(recommendationStats.confidence_count ?? 0),
      predictionRows,
    }),
    buildFeatureVersionParityCheck({
      total: Number(featureVersionStats.total ?? 0),
      missingFeatureVersion: Number(featureVersionStats.missing_feature_version ?? 0),
      distinctFeatureVersions: Number(featureVersionStats.distinct_feature_versions ?? 0),
    }),
    buildScreenerSeedQualityCheck({
      total: Number(screenerSeedStats.total ?? 0),
      unclassified: Number(screenerSeedStats.unclassified ?? 0),
      invalidScores: Number(screenerSeedStats.invalid_scores ?? 0),
      missingComponents: Number(screenerSeedStats.missing_components ?? 0),
      missingReasons: Number(screenerSeedStats.missing_reasons ?? 0),
      currentPriceValid: Number(screenerSeedStats.current_price_valid ?? 0),
    }),
    buildScreenerCandidateVolumeCheck({
      total: Number(screenerSeedStats.total ?? 0),
      minCandidates: 10,
      warnCandidates: 20,
    }),
    buildScreenerScoreDistributionCheck({
      total: Number(screenerSeedStats.total ?? 0),
      avgScore: screenerSeedStats.avg_score,
      minScore: screenerSeedStats.min_score,
      maxScore: screenerSeedStats.max_score,
      highScoreCount: screenerSeedStats.high_score_count,
      perfectScoreCount: screenerSeedStats.perfect_score_count,
    }),
    buildScreenerSourceOfTruthCheck({
      targetDate,
      funnelRunId: screenerFunnelStats.funnel_run_id,
      funnelStatus: screenerFunnelStats.funnel_status,
      funnelFinalCount: Number(screenerFunnelStats.funnel_final_count ?? 0),
      funnelEmergingCount: Number(screenerFunnelStats.funnel_emerging_count ?? 0),
      dailyTotal: Number(screenerSeedStats.total ?? 0),
      tradableCount: Number(screenerSeedStats.tradable_count ?? 0),
      emergingCount: Number(screenerSeedStats.emerging_watchlist_count ?? 0),
      eligibleMlCount: Number(screenerSeedStats.eligible_ml_count ?? 0),
      eligiblePendingCount: Number(screenerSeedStats.eligible_pending_count ?? 0),
    }),
    buildClassificationCoverageCheck({
      total: Number(classificationStats.total ?? 0),
      missingIndustryTags: Number(classificationStats.missing_industry_tags ?? 0),
      tradableTotal: Number(classificationStats.tradable_total ?? 0),
      tradableMissingIndustryTags: Number(classificationStats.tradable_missing_industry_tags ?? 0),
      researchTotal: Number(classificationStats.research_total ?? 0),
      researchMissingIndustryTags: Number(classificationStats.research_missing_industry_tags ?? 0),
    }),
    buildRrgTaxonomyCoverageCheck({
      latestThemeDate: rrgTaxonomyStats.latest_theme_date,
      targetDate,
      latestThemeRows: Number(rrgTaxonomyStats.latest_theme_rows ?? 0),
      topConceptSymbols: Number(rrgTaxonomyStats.top_concept_symbols ?? 0),
      topUnmappedSymbols: Number(rrgTaxonomyStats.top_unmapped_symbols ?? 0),
      topOtherSymbols: Number(rrgTaxonomyStats.top_other_symbols ?? 0),
    }),
    buildThemeSignalCoverageCheck({
      targetDate,
      themeSignalTotal: Number(themeSignalStats.theme_signal_total ?? 0),
      themeSignalSources: Number(themeSignalStats.theme_signal_sources ?? 0),
      stockThemeFeatureTotal: Number(stockThemeFeatureStats.stock_theme_feature_total ?? 0),
      stockThemeFeatureSymbols: Number(stockThemeFeatureStats.stock_theme_feature_symbols ?? 0),
      latestThemeSignalAt: themeSignalStats.theme_signal_latest_generated_at ?? null,
      latestStockThemeFeatureAt: stockThemeFeatureStats.stock_theme_feature_latest_generated_at ?? null,
    }),
    buildPendingBuyDateSanityCheck({
      targetDate,
      runTradeDate: pendingBuyStats.run_trade_date,
      sourceRecoDate: pendingBuyStats.source_reco_date,
      candidateCount: Number(pendingBuyStats.candidate_count ?? 0),
      activeCount: Number(pendingBuyStats.active_count ?? 0),
    }),
    buildPendingBuyAllocatorOwnerCheck({
      activeCount: Number(pendingBuyStats.active_count ?? 0),
      l4SparseFinalBuyCount: Number(pendingBuyStats.l4_sparse_final_buy_count ?? 0),
      invalidAllocatorCount: Number(pendingBuyStats.pending_buy_invalid_allocator_count ?? 0),
      watchSourceCount: Number(pendingBuyStats.pending_buy_watch_source_count ?? 0),
      missingRecommendationCount: Number(pendingBuyStats.pending_buy_missing_recommendation_count ?? 0),
    }),
    buildSurfaceRoleConsistencyCheck({
      recommendationRole: 'recommendation_candidate',
      pendingBuyRole: 'execution_pool',
    }),
    buildBoardLaneContractCheck({
      emergingRecommendations: Number(boardLaneStats.emerging_recommendations ?? 0),
      pendingBuyEmergingLike: Number(boardLaneStats.pending_buy_emerging_like ?? 0),
    }),
    buildModelIcEvidenceCheck(modelIcEvidence.results ?? []),
    buildSchemaCheck((schemaRows.results ?? []).map((row) => row.name)),
    buildDatasetSnapshotManifestCheck({
      targetDate,
      total: Number(datasetManifestStats.manifest_total ?? 0),
      priceHotWindow: Number(datasetManifestStats.price_hot_window_manifest ?? 0),
      technicalHotWindow: Number(datasetManifestStats.technical_indicator_hot_window_manifest ?? 0),
      chipHotWindow: Number(datasetManifestStats.chip_hot_window_manifest ?? 0),
      backtestComputeSnapshot: Number(datasetManifestStats.backtest_compute_snapshot_manifest ?? 0),
      priceHistoryComputeSnapshot: Number(datasetManifestStats.price_history_compute_snapshot_manifest ?? 0),
      pipelineReport: Number(datasetManifestStats.pipeline_report_manifest ?? 0),
      screenerReport: Number(datasetManifestStats.screener_report_manifest ?? 0),
      latestD1ServingManifestAt: datasetManifestStats.latest_d1_serving_manifest_at ?? null,
      latestGcsComputeManifestAt: datasetManifestStats.latest_gcs_compute_manifest_at ?? null,
      latestR2ReportManifestAt: datasetManifestStats.latest_r2_report_manifest_at ?? null,
    }),
    buildRetrainFollowupClosureCheck({
      awaiting: Number(retrainFollowupStats.awaiting_retrain_followup ?? 0),
      stale: Number(retrainFollowupStats.stale_retrain_followup ?? 0),
      oldestAt: retrainFollowupStats.oldest_retrain_followup_at ?? null,
      latestAt: retrainFollowupStats.latest_retrain_followup_at ?? null,
    }),
  ]

  return {
    date: targetDate,
    generated_at: new Date().toISOString(),
    overall: summarizeDataQualityChecks(checks),
    checks,
  }
}
