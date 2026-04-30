export interface MlVoteSummary {
  bullish: number
  bearish: number
  flat: number
  reported: number
  missing: number
  total: number
  forecastPct: number | null
  activeWeightCount: number
  reason: string | null
  thresholds?: {
    bullish: number
    bearish: number
    regime: string
    adjustment: number
  }
}

export interface PerModelPredictionRow {
  model_name?: string | null
  signal_raw?: string | null
  forecast_data?: unknown
  direction_accuracy?: number | null
}

export interface MlVoteThresholdPolicy {
  modelVoteBullishThreshold?: number
  modelVoteBearishThreshold?: number
  modelVoteRegimeAdjustments?: Record<string, number>
}

const TRACKED_MODEL_NAMES = [
  'XGBoost',
  'CatBoost',
  'ExtraTrees',
  'LightGBM',
  'FT-Transformer',
  'Chronos',
  'DLinear',
  'PatchTST',
  'KalmanFilter',
  'MarkovSwitching',
]

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
    if (!name || name === 'ensemble' || name.includes('::challenger')) continue
    if (!cleanRowsByModel.has(name)) cleanRowsByModel.set(name, row)
  }
  const cleanRows = [...cleanRowsByModel.values()]
  if (!data && cleanRows.length === 0) return null

  const models = Array.isArray(data?.models)
    ? data.models.filter((model: any) => String(model?.name ?? model?.model_name ?? model ?? '') !== 'StackingRank')
    : []
  const weights = data?.ensemble_v2?.weights && typeof data.ensemble_v2.weights === 'object'
    ? data.ensemble_v2.weights as Record<string, unknown>
    : {}
  const total = Math.max(TRACKED_MODEL_NAMES.length, Object.keys(weights).length, models.length, cleanRows.length)
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
  const activeWeightCount = Object.values(weights).filter((value) => Number(value ?? 0) > 0).length

  return {
    bullish,
    bearish,
    flat,
    reported: cleanRows.length || models.length,
    missing: Math.max(0, total - (cleanRows.length || models.length)),
    total,
    forecastPct,
    activeWeightCount,
    reason: typeof data?.ensemble_v2?.reason === 'string' ? data.ensemble_v2.reason : null,
    thresholds,
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
  const location = structure.price_location ?? 'unknown'
  if (poc == null && low == null && high == null && location === 'unknown') return null
  const windowStart = structure.window_start_date
  const windowEnd = structure.window_end_date
  const latestClose = structure.latest_close
  const windowText = windowStart && windowEnd ? `, window=${windowStart}~${windowEnd}` : ''
  const latestText = latestClose != null ? `, latest_close=${latestClose}` : ''
  return `Market structure: POC=${poc ?? 'n/a'}, fair_value=${low ?? 'n/a'}~${high ?? 'n/a'}, location=${location}${windowText}${latestText}`
}

export function appendUniqueWatchPoint(points: string[], next: string | null): string[] {
  if (!next) return points
  const key = next.split(':', 1)[0]
  if (points.some((point) => point.startsWith(`${key}:`))) return points
  return [...points, next]
}
