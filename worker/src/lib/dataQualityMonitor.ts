import type { Bindings } from '../types'
import { twToday } from './dateUtils'

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
  ml_score_positive?: number
  signal_count?: number
  confidence_count?: number
  unclassified?: number
  invalid_scores?: number
  missing_components?: number
  missing_reasons?: number
  missing_industry_tags?: number
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
}

export const EXPECTED_V2_MODELS = [
  'XGBoost',
  'LightGBM',
  'CatBoost',
  'ExtraTrees',
  'FT-Transformer',
  'Chronos',
  'DLinear',
  'PatchTST',
] as const

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
  mlScorePositive: number
  signalCount: number
  confidenceCount: number
  predictionRows: number
}): DataQualityCheck {
  const total = Number(input.total ?? 0)
  const enriched = Math.max(
    Number(input.mlScorePositive ?? 0),
    Number(input.signalCount ?? 0),
    Number(input.confidenceCount ?? 0),
  )
  if (total <= 0) {
    return {
      id: 'recommendation_ml_enrichment',
      label: 'Recommendation ML enrichment',
      status: 'fail',
      summary: 'daily_recommendations has no rows for target date',
      metrics: { total },
    }
  }
  const ratio = enriched / total
  const status: DataQualityStatus = input.predictionRows > 0 && enriched === 0
    ? 'fail'
    : ratio < 0.5
      ? 'warn'
      : 'ok'
  return {
    id: 'recommendation_ml_enrichment',
    label: 'Recommendation ML enrichment',
    status,
    summary: `${enriched}/${total} recommendations have ML owner fields`,
    metrics: {
      total,
      enriched,
      ratio,
      ml_score_positive: input.mlScorePositive,
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
    summary: `rows=${total} invalid=${invalid} missing_components=${missingComponents} unclassified=${unclassified} price_valid=${currentPriceValid}`,
    metrics: {
      total,
      invalid_scores: invalid,
      missing_components: missingComponents,
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
}): DataQualityCheck {
  const total = Number(input.total ?? 0)
  const missing = Number(input.missingIndustryTags ?? 0)
  if (total <= 0) {
    return {
      id: 'classification_coverage',
      label: 'Classification coverage',
      status: 'fail',
      summary: 'no recommendation rows to validate classification coverage',
      metrics: { total },
    }
  }

  const ratio = missing / total
  const status: DataQualityStatus = ratio > 0.5
    ? 'fail'
    : ratio > 0.25
      ? 'warn'
      : 'ok'

  return {
    id: 'classification_coverage',
    label: 'Classification coverage',
    status,
    summary: `industry_tags=${total - missing}/${total} missing=${missing}`,
    metrics: {
      total,
      missing_industry_tags: missing,
      missing_ratio: ratio,
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
  const targetDate = options.date ?? await resolveExpectedTradingDate(env.KV, twToday())
  const expectedModelPlaceholders = EXPECTED_V2_MODELS.map(() => '?').join(',')

  const [priceStats, chipStats, tiStats, recommendationStats, screenerSeedStats, classificationStats, rrgTaxonomyStats, screenerFunnelStats, pendingBuyStats, boardLaneStats, predictionGroups, featureVersionStats, modelIcEvidence, schemaRows] = await Promise.all([
    latestTableStats(env.DB, 'stock_prices'),
    latestTableStats(env.DB, 'chip_data'),
    latestTableStats(env.DB, 'technical_indicators'),
    firstCount(
      env.DB,
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN COALESCE(ml_score, 0) > 0 THEN 1 ELSE 0 END) AS ml_score_positive,
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
              SUM(CASE WHEN chip_score IS NULL OR tech_score IS NULL THEN 1 ELSE 0 END) AS missing_components,
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
              SUM(CASE WHEN st.symbol IS NULL THEN 1 ELSE 0 END) AS missing_industry_tags
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
      `SELECT r.trade_date AS run_trade_date,
              r.source_reco_date AS source_reco_date,
              r.candidate_count AS candidate_count,
              SUM(CASE WHEN COALESCE(i.execution_status, 'pending') NOT IN ('filled', 'skipped', 'cancelled', 'expired') THEN 1 ELSE 0 END) AS active_count
       FROM pending_buy_runs r
       LEFT JOIN pending_buy_items i ON i.run_id = r.id
      WHERE r.trade_date = ? AND COALESCE(r.status, '') <> 'superseded'
       GROUP BY r.id
       ORDER BY r.id DESC
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
    buildPredictionCoverageCheck(predictionGroups.results ?? []),
    buildRecommendationMlOwnerCheck({
      total: Number(recommendationStats.total ?? 0),
      mlScorePositive: Number(recommendationStats.ml_score_positive ?? 0),
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
    }),
    buildRrgTaxonomyCoverageCheck({
      latestThemeDate: rrgTaxonomyStats.latest_theme_date,
      targetDate,
      latestThemeRows: Number(rrgTaxonomyStats.latest_theme_rows ?? 0),
      topConceptSymbols: Number(rrgTaxonomyStats.top_concept_symbols ?? 0),
      topUnmappedSymbols: Number(rrgTaxonomyStats.top_unmapped_symbols ?? 0),
      topOtherSymbols: Number(rrgTaxonomyStats.top_other_symbols ?? 0),
    }),
    buildPendingBuyDateSanityCheck({
      targetDate,
      runTradeDate: pendingBuyStats.run_trade_date,
      sourceRecoDate: pendingBuyStats.source_reco_date,
      candidateCount: Number(pendingBuyStats.candidate_count ?? 0),
      activeCount: Number(pendingBuyStats.active_count ?? 0),
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
  ]

  return {
    date: targetDate,
    generated_at: new Date().toISOString(),
    overall: summarizeDataQualityChecks(checks),
    checks,
  }
}
