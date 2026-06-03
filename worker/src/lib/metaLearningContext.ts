export const META_LEARNING_CONTEXT_VERSION = 'meta-context-v2'

export const META_LEARNING_CONTEXT_FEATURES = [
  'model_ic',
  'coverage',
  'prediction_dispersion',
  'data_quality',
  'market_breadth',
  'sector_heat',
  'liquidity',
  'fill_quality',
  'regime',
  'volatility',
  'market_risk',
  'bias',
] as const

export type MetaLearningContextFeature = typeof META_LEARNING_CONTEXT_FEATURES[number]

export interface ExpandedMetaLearningContextInput {
  model_ic?: unknown
  coverage?: unknown
  prediction_dispersion?: unknown
  data_quality?: unknown
  market_breadth?: unknown
  sector_heat?: unknown
  liquidity?: unknown
  fill_quality?: unknown
  regime?: unknown
  volatility?: unknown
  market_risk?: unknown
}

export interface ExpandedMetaLearningContext {
  version: typeof META_LEARNING_CONTEXT_VERSION
  features: readonly MetaLearningContextFeature[]
  values: Record<MetaLearningContextFeature, number>
  vector: number[]
  coverage: {
    present: MetaLearningContextFeature[]
    missing: MetaLearningContextFeature[]
  }
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function normalizeSigned(value: unknown, neutral = 0): number | null {
  const n = finiteOrNull(value)
  if (n == null) return null
  return clamp((n + 1) / 2, 0, 1) || neutral
}

function normalize01(value: unknown): number | null {
  const n = finiteOrNull(value)
  if (n == null) return null
  return clamp(n, 0, 1)
}

function normalizePercentValue(value: unknown): number | null {
  const n = finiteOrNull(value)
  if (n == null) return null
  const pct = Math.abs(n) > 1 ? n / 100 : n
  return clamp(pct, 0, 1)
}

function normalizeDispersion(value: unknown): number | null {
  const n = finiteOrNull(value)
  if (n == null) return null
  return clamp(n * 5, 0, 1)
}

function normalizeRegime(value: unknown): number | null {
  const raw = String(value ?? '').toLowerCase()
  if (!raw.trim()) return null
  if (raw.includes('bull')) return 0
  if (raw.includes('bear')) return 1
  if (raw.includes('vol')) return 0.75
  if (raw.includes('side') || raw.includes('range') || raw.includes('chop')) return 0.5
  const n = finiteOrNull(value)
  if (n == null) return 0.5
  return clamp(n, 0, 1)
}

const NEUTRAL_VALUES: Record<MetaLearningContextFeature, number> = {
  model_ic: 0.5,
  coverage: 0.5,
  prediction_dispersion: 0.5,
  data_quality: 0.5,
  market_breadth: 0.5,
  sector_heat: 0.5,
  liquidity: 0.5,
  fill_quality: 0.5,
  regime: 0.5,
  volatility: 0.5,
  market_risk: 0.5,
  bias: 1,
}

export function buildExpandedMetaLearningContext(input: ExpandedMetaLearningContextInput = {}): ExpandedMetaLearningContext {
  const rawValues: Record<MetaLearningContextFeature, number | null> = {
    model_ic: normalizeSigned(input.model_ic),
    coverage: normalize01(input.coverage),
    prediction_dispersion: normalizeDispersion(input.prediction_dispersion),
    data_quality: normalize01(input.data_quality),
    market_breadth: normalize01(input.market_breadth),
    sector_heat: normalizeSigned(input.sector_heat),
    liquidity: normalize01(input.liquidity),
    fill_quality: normalize01(input.fill_quality),
    regime: normalizeRegime(input.regime),
    volatility: normalizePercentValue(input.volatility),
    market_risk: normalize01(input.market_risk),
    bias: 1,
  }
  const missing = META_LEARNING_CONTEXT_FEATURES.filter((feature) => feature !== 'bias' && rawValues[feature] == null)
  const present = META_LEARNING_CONTEXT_FEATURES.filter((feature) => rawValues[feature] != null)
  const values = Object.fromEntries(
    META_LEARNING_CONTEXT_FEATURES.map((feature) => [feature, rawValues[feature] ?? NEUTRAL_VALUES[feature]]),
  ) as Record<MetaLearningContextFeature, number>
  return {
    version: META_LEARNING_CONTEXT_VERSION,
    features: META_LEARNING_CONTEXT_FEATURES,
    values,
    vector: META_LEARNING_CONTEXT_FEATURES.map((feature) => values[feature]),
    coverage: { present, missing },
  }
}

export function hashExpandedMetaLearningContext(context: ExpandedMetaLearningContext): string {
  const quantized = context.vector.map((value) => Math.round(value * 100) / 100).join(',')
  return `${context.version}:${quantized}`
}
