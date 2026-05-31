export interface MlVoteSummary {
  bullish: number
  bearish: number
  flat: number
  reported: number
  missing: number
  total: number
  forecastPct: number | null
  activeWeightCount: number
  zeroWeightModels?: string[]
  contributingModels?: string[]
  reason: string | null
  thresholds?: {
    bullish: number
    bearish: number
    regime: string
    adjustment: number
  }
  coreFamilyVote?: CoreFamilyVoteSummary | null
}

export interface CoreFamilyVoteSummary {
  schema_version?: string
  family_score?: number
  active_family_count?: number
  active_families?: string[]
  inactive_formal_models?: string[]
}

export interface MlDiagnosticsSummary {
  totalAlphaModels: number
  activeWeightCount: number
  zeroWeightModels: string[]
  contributingModels: string[]
  validationBlockedModels: string[]
  icWeightScope: string | null
  rankSignalThresholds: Record<string, unknown> | null
  forecastCalibration: {
    method: string | null
    source: string | null
    sampleCount: number | null
    binSamples: number | null
    bin: string | number | null
  }
  dispersion: {
    rawModelCount: number | null
    rawRankStd: number | null
    mergeCompression: number | null
    weightHhi: number | null
  }
}

export interface PerModelPredictionRow {
  model_name?: string | null
  signal_raw?: string | null
  forecast_data?: unknown
  direction_accuracy?: number | null
}

export function compactRecommendationForCard(rec: Record<string, any>) {
  const {
    prediction_forecast_data: _predictionForecastData,
    screener_funnel_timeline: _screenerFunnelTimeline,
    latest_open: _latestOpen,
    latest_avg_price: _latestAvgPrice,
    ...cardRec
  } = rec
  return cardRec
}

export interface MlVoteThresholdPolicy {
  modelVoteBullishThreshold?: number
  modelVoteBearishThreshold?: number
  modelVoteRegimeAdjustments?: Record<string, number>
}

export const ALPHA_PREDICTION_MODEL_NAMES = [
  'XGBoost',
  'CatBoost',
  'ExtraTrees',
  'LightGBM',
  'TabM',
  'GNN',
  'DLinear',
  'PatchTST',
  'iTransformer',
  'TimesFM',
] as const

const TRACKED_MODEL_NAMES = [...ALPHA_PREDICTION_MODEL_NAMES]
const TRACKED_MODEL_NAME_SET = new Set<string>(TRACKED_MODEL_NAMES)

function isTrackedAlphaModelName(raw: unknown): boolean {
  return TRACKED_MODEL_NAME_SET.has(String(raw ?? ''))
}

const DEFAULT_VOTE_POLICY: Required<MlVoteThresholdPolicy> = {
  modelVoteBullishThreshold: 0.55,
  modelVoteBearishThreshold: 0.45,
  modelVoteRegimeAdjustments: {
    bull: -0.02,
    bear: 0.03,
    volatile: 0.03,
    sideways: 0.02,
  },
}

export function parsePredictionForecastData(raw: unknown): Record<string, any> | null {
  if (!raw) return null
  if (typeof raw === 'object') return raw as Record<string, any>
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function normalizeForecastPct(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const pct = Math.abs(raw) <= 1 ? raw * 100 : raw
  return Math.round(pct * 10) / 10
}

function coreFamilyVoteFromForecastData(data: Record<string, any> | null): CoreFamilyVoteSummary | null {
  const raw = data?.core_family_vote ?? data?.coreFamilyVote ?? data?.ensemble_v2?.family_vote ?? null
  const vote = parsePredictionForecastData(raw)
  if (!vote) return null
  return {
    schema_version: typeof vote.schema_version === 'string' ? vote.schema_version : undefined,
    family_score: finiteOrNull(vote.family_score) ?? undefined,
    active_family_count: finiteOrNull(vote.active_family_count) ?? undefined,
    active_families: Array.isArray(vote.active_families) ? vote.active_families.map(String) : undefined,
    inactive_formal_models: Array.isArray(vote.inactive_formal_models) ? vote.inactive_formal_models.map(String) : undefined,
  }
}

function rowRankScore(row: PerModelPredictionRow): number | null {
  const parsed = parsePredictionForecastData(row.forecast_data)
  const raw = row.direction_accuracy ?? parsed?.rank_score
  const score = Number(raw)
  return Number.isFinite(score) ? score : null
}

function normalizeRegime(raw: unknown): string {
  const regime = String(raw ?? '').toLowerCase()
  if (regime.includes('bull')) return 'bull'
  if (regime.includes('bear')) return 'bear'
  if (regime.includes('vol')) return 'volatile'
  if (regime.includes('side') || regime.includes('range') || regime.includes('chop')) return 'sideways'
  return 'unknown'
}

function finiteOrDefault(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function finiteOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function resolveVoteThresholds(
  forecastData: Record<string, any> | null,
  policy?: MlVoteThresholdPolicy,
): { bullish: number; bearish: number; regime: string; adjustment: number } {
  const regime = normalizeRegime(forecastData?.alpha_context?.regime)
  const mergedPolicy = {
    ...DEFAULT_VOTE_POLICY,
    ...(policy ?? {}),
    modelVoteRegimeAdjustments: {
      ...DEFAULT_VOTE_POLICY.modelVoteRegimeAdjustments,
      ...(policy?.modelVoteRegimeAdjustments ?? {}),
    },
  }
  const adjustment = finiteOrDefault(mergedPolicy.modelVoteRegimeAdjustments[regime], 0)
  const bullish = clamp01(finiteOrDefault(mergedPolicy.modelVoteBullishThreshold, DEFAULT_VOTE_POLICY.modelVoteBullishThreshold) + adjustment)
  const bearish = clamp01(finiteOrDefault(mergedPolicy.modelVoteBearishThreshold, DEFAULT_VOTE_POLICY.modelVoteBearishThreshold) - adjustment)
  return {
    bullish: Math.max(bullish, bearish),
    bearish: Math.min(bullish, bearish),
    regime,
    adjustment,
  }
}

function voteFromSignal(
  signal: string,
  score: number | null | undefined,
  thresholds: { bullish: number; bearish: number },
): 'bullish' | 'bearish' | 'flat' {
  if (signal.includes('BUY') || signal.includes('UP') || signal.includes('BULL')) return 'bullish'
  if (signal.includes('SELL') || signal.includes('DOWN') || signal.includes('BEAR')) return 'bearish'
  if (typeof score === 'number' && Number.isFinite(score)) {
    if (score >= thresholds.bullish) return 'bullish'
    if (score <= thresholds.bearish) return 'bearish'
  }
  return 'flat'
}

export function buildMlVoteSummary(
  forecastData: unknown,
  perModelRows: PerModelPredictionRow[] = [],
  policy?: MlVoteThresholdPolicy,
): MlVoteSummary | null {
  const data = parsePredictionForecastData(forecastData)
  const thresholds = resolveVoteThresholds(data, policy)
  const cleanRowsByModel = new Map<string, PerModelPredictionRow>()
  for (const row of perModelRows) {
    const name = String(row.model_name ?? '')
    if (!isTrackedAlphaModelName(name)) continue
    if (!cleanRowsByModel.has(name)) cleanRowsByModel.set(name, row)
  }
  const cleanRows = [...cleanRowsByModel.values()]
  if (!data && cleanRows.length === 0) return null

  const models = Array.isArray(data?.models)
    ? data.models.filter((model: any) => isTrackedAlphaModelName(model?.name ?? model?.model_name ?? model))
    : []
  const weights = data?.ensemble_v2?.weights && typeof data.ensemble_v2.weights === 'object'
    ? data.ensemble_v2.weights as Record<string, unknown>
    : {}
  const trackedWeightKeys = Object.keys(weights).filter(isTrackedAlphaModelName)
  const total = Math.max(TRACKED_MODEL_NAMES.length, trackedWeightKeys.length, models.length, cleanRows.length)
  if (total <= 0) return null

  let bullish = 0
  let bearish = 0
  let flat = 0
  if (cleanRows.length > 0) {
    for (const row of cleanRows) {
      // Per-model rows inherit the ensemble trade signal for execution audit.
      // Model voting must use each model's own rank score, not that shared signal.
      const vote = voteFromSignal('', rowRankScore(row), thresholds)
      if (vote === 'bullish') bullish += 1
      else if (vote === 'bearish') bearish += 1
      else flat += 1
    }
  } else {
    for (const model of models) {
      const direction = typeof model === 'string'
        ? ''
        : String(model?.direction ?? model?.signal ?? '').toLowerCase()
      const score = typeof model === 'string' ? null : finiteOrDefault(model?.rank_score ?? model?.confidence, NaN)
      const vote = voteFromSignal(direction, score, thresholds)
      if (vote === 'bullish') bullish += 1
      else if (vote === 'bearish') bearish += 1
      else flat += 1
    }
  }

  const forecastPct = normalizeForecastPct(data?.ensemble_v2?.forecast_pct ?? data?.forecast_pct ?? null)
  const activeWeightCount = trackedWeightKeys.filter((name) => Number(weights[name] ?? 0) > 0).length
  const zeroWeightModels = TRACKED_MODEL_NAMES.filter((name) => Object.prototype.hasOwnProperty.call(weights, name) && Number(weights[name] ?? 0) <= 0)

  return {
    bullish,
    bearish,
    flat,
    reported: cleanRows.length || models.length,
    missing: Math.max(0, total - (cleanRows.length || models.length)),
    total,
    forecastPct,
    activeWeightCount,
    zeroWeightModels,
    contributingModels: Array.isArray(data?.ensemble_v2?.contributing_models) ? data.ensemble_v2.contributing_models : [],
    reason: typeof data?.ensemble_v2?.reason === 'string' ? data.ensemble_v2.reason : null,
    thresholds,
    coreFamilyVote: coreFamilyVoteFromForecastData(data),
  }
}

export function buildMlDiagnostics(forecastData: unknown): MlDiagnosticsSummary | null {
  const data = parsePredictionForecastData(forecastData)
  if (!data) return null

  const ev2 = data.ensemble_v2 && typeof data.ensemble_v2 === 'object'
    ? data.ensemble_v2 as Record<string, any>
    : {}
  const weights = ev2.weights && typeof ev2.weights === 'object'
    ? ev2.weights as Record<string, unknown>
    : {}
  const diagnostics = ev2.ic_weight_diagnostics && typeof ev2.ic_weight_diagnostics === 'object'
    ? ev2.ic_weight_diagnostics as Record<string, any>
    : {}
  const dispersion = data.dispersion_diagnostics && typeof data.dispersion_diagnostics === 'object'
    ? data.dispersion_diagnostics as Record<string, any>
    : {}

  const trackedWeightKeys = Object.keys(weights).filter(isTrackedAlphaModelName)
  const zeroWeightModels = Array.isArray(dispersion.zero_weight_models)
    ? dispersion.zero_weight_models.filter(isTrackedAlphaModelName)
    : TRACKED_MODEL_NAMES.filter((name) => Object.prototype.hasOwnProperty.call(weights, name) && Number(weights[name] ?? 0) <= 0)
  const contributingModels = Array.isArray(ev2.contributing_models)
    ? ev2.contributing_models.filter(isTrackedAlphaModelName)
    : []
  const validationBlockedModels = Object.entries(diagnostics)
    .filter(([, detail]) => String((detail as any)?.validation_status ?? '').toUpperCase() === 'FAIL')
    .map(([name]) => name)
    .filter(isTrackedAlphaModelName)

  return {
    totalAlphaModels: TRACKED_MODEL_NAMES.length,
    activeWeightCount: trackedWeightKeys.filter((name) => Number(weights[name] ?? 0) > 0).length,
    zeroWeightModels,
    contributingModels,
    validationBlockedModels,
    icWeightScope: typeof ev2.ic_weight_scope === 'string' ? ev2.ic_weight_scope : null,
    rankSignalThresholds: ev2.rank_signal_thresholds && typeof ev2.rank_signal_thresholds === 'object'
      ? ev2.rank_signal_thresholds
      : null,
    forecastCalibration: {
      method: typeof ev2.forecast_calibration_method === 'string' ? ev2.forecast_calibration_method : null,
      source: typeof ev2.forecast_pct_source === 'string' ? ev2.forecast_pct_source : null,
      sampleCount: finiteOrNull(ev2.forecast_calibration_sample_count),
      binSamples: finiteOrNull(ev2.forecast_calibration_bin_samples),
      bin: typeof ev2.forecast_calibration_bin === 'string' || typeof ev2.forecast_calibration_bin === 'number'
        ? ev2.forecast_calibration_bin
        : null,
    },
    dispersion: {
      rawModelCount: finiteOrNull(dispersion.raw_model_count),
      rawRankStd: finiteOrNull(dispersion.raw_rank_std),
      mergeCompression: finiteOrNull(dispersion.merge_compression),
      weightHhi: finiteOrNull(dispersion.weight_hhi),
    },
  }
}

export function buildMlVoteWatchPoint(summary: MlVoteSummary | null): string | null {
  if (!summary) return null
  const forecast = summary.forecastPct == null ? 'n/a' : summary.forecastPct.toFixed(1)
  const thresholds = summary.thresholds
    ? `, bullish_threshold=${summary.thresholds.bullish.toFixed(3)}, bearish_threshold=${summary.thresholds.bearish.toFixed(3)}, regime=${summary.thresholds.regime}`
    : ''
  return `ML ensemble: bullish=${summary.bullish}/${summary.total}, bearish=${summary.bearish}/${summary.total}, flat=${summary.flat}/${summary.total}, missing=${summary.missing}/${summary.total}, forecast=${forecast}%${thresholds}`
}

export function buildMarketStructureWatchPoint(alphaContext: any): string | null {
  const structure = alphaContext?.risk_overlay?.structure_detail
  if (!structure || typeof structure !== 'object') return null
  const poc = structure.poc_price
  const low = structure.fair_value_low
  const high = structure.fair_value_high
  const optimisticLow = structure.optimistic_value_low
  const optimisticHigh = structure.optimistic_value_high
  const optimisticStatus = structure.optimistic_value_status
  const upsideToOptimisticHighPct = structure.upside_to_optimistic_high_pct
  const location = structure.price_location ?? 'unknown'
  if (poc == null && low == null && high == null && location === 'unknown') return null
  const windowStart = structure.window_start_date
  const windowEnd = structure.window_end_date
  const latestClose = structure.latest_close
  const formatPrice = (value: unknown): string | null => {
    const n = Number(value)
    if (!Number.isFinite(n)) return null
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')
  }
  const latestText = formatPrice(latestClose)
  const fairLowText = formatPrice(low ?? poc)
  const fairHighText = formatPrice(high ?? poc)
  const optimisticHighText = formatPrice(optimisticHigh ?? high)
  const optimisticLowText = formatPrice(optimisticLow ?? high)
  const plan: string[] = []

  if (latestText) plan.push(`現價 ${latestText}`)
  if (fairLowText && fairHighText) {
    plan.push(`內部合理區 ${fairLowText}~${fairHighText}`)
  }
  if (optimisticLowText && optimisticHighText && optimisticLowText !== optimisticHighText) {
    plan.push(`內部順風區 ${optimisticLowText}~${optimisticHighText}`)
  } else if (optimisticHighText) {
    plan.push(`內部順風上緣 ${optimisticHighText}`)
  }
  if (location === 'above_fair_value') {
    plan.push('價格高於內部合理區')
  } else if (location === 'below_fair_value') {
    plan.push('價格低於內部合理區')
  } else if (location === 'in_fair_value') {
    plan.push('價格位於內部合理區')
  }
  const upside = Number(upsideToOptimisticHighPct)
  if (Number.isFinite(upside) && optimisticHighText) {
    const pct = Math.abs(upside * 100).toFixed(1).replace(/\.0$/, '')
    plan.push(upside < 0 ? `已高於內部順風上緣 ${pct}%` : `距內部順風上緣 ${pct}%`)
  }
  if (optimisticStatus === 'exceeded') {
    plan.push('內部估值提醒偏追高')
  }
  if (windowStart && windowEnd) plan.push(`觀察區間 ${windowStart}~${windowEnd}`)

  return plan.length ? `Alpha 結構: ${plan.join('；')}` : null
}

export function appendUniqueWatchPoint(points: string[], next: string | null): string[] {
  if (!next) return points
  const key = next.split(':', 1)[0]
  if (points.some((point) => point.startsWith(`${key}:`))) return points
  return [...points, next]
}
