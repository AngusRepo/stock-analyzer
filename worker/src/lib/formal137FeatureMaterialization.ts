type NullableNumber = number | null | undefined

interface Formal137RawSignals {
  return5d?: NullableNumber
  return20d?: NullableNumber
  volumeExpansion20?: NullableNumber
  ma10Bias?: NullableNumber
  advanceRatio?: NullableNumber
  advance_ratio?: NullableNumber
  marginBalance?: NullableNumber
  margin_balance?: NullableNumber
  technicalIndicators?: Record<string, NullableNumber>
  factorSignals?: Record<string, NullableNumber>
}

export interface Formal137MaterializationCandidate {
  raw_signals?: Formal137RawSignals | null
}

export interface Formal137UsSentimentMaterializationTelemetry {
  method: 'formal137_us_sentiment_cross_sectional_exposure_rank_v1'
  universeCount: number
  sentimentCoverage: number
  exposureEligibleCount: number
  materializedCount: number
  skippedNeutralCount: number
  skippedConstantExposureCount: number
  componentCoverage: Record<string, number>
}

export interface Formal137FeatureAliasMaterializationTelemetry {
  method: 'formal137_feature_alias_materialization_v1'
  universeCount: number
  materializedCount: number
  aliasCoverage: Record<string, number>
}

const US_SENTIMENT_ALIASES = ['us_sentiment_score', 'usSentimentScore'] as const
const US_SENTIMENT_RANK_ALIASES = [
  'formal137UsSentimentScoreRank',
  'us_sentiment_score_rank',
  'usSentimentScoreRank',
  'us_sentiment_score_normalized',
] as const

const EXPOSURE_COMPONENTS = [
  'return5d',
  'return20d',
  'volumeExpansion20',
  'ma10Bias',
  'sector_rs_ratio',
  'sector_turnover_share_delta',
  'KLOW2',
] as const

function finiteNumber(value: unknown): number | null {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function avg(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function percentileRank(value: number, sortedAsc: number[]): number | null {
  if (!Number.isFinite(value) || sortedAsc.length < 2) return null
  let lower = 0
  while (lower < sortedAsc.length && sortedAsc[lower] < value) lower++
  let upper = lower
  while (upper < sortedAsc.length && sortedAsc[upper] <= value) upper++
  const midpointIndex = (lower + Math.max(lower, upper - 1)) / 2
  return clamp(midpointIndex / (sortedAsc.length - 1), 0, 1)
}

function rawSentimentScore(raw: Formal137RawSignals): number | null {
  for (const key of US_SENTIMENT_ALIASES) {
    const value = finiteNumber(raw.factorSignals?.[key])
    if (value != null) return value
  }
  return null
}

const FORMAL137_ALIAS_SOURCES: Record<string, Array<(raw: Formal137RawSignals) => unknown>> = {
  KLOW2: [
    (raw) => raw.factorSignals?.KLOW2,
    (raw) => raw.technicalIndicators?.KLOW2,
  ],
  KSFT: [
    (raw) => raw.factorSignals?.KSFT,
    (raw) => raw.technicalIndicators?.KSFT,
  ],
  KSFT2: [
    (raw) => raw.factorSignals?.KSFT2,
    (raw) => raw.technicalIndicators?.KSFT2,
  ],
  CNTD_20: [
    (raw) => raw.factorSignals?.CNTD_20,
    (raw) => raw.technicalIndicators?.CNTD_20,
  ],
  CNTN_20: [
    (raw) => raw.factorSignals?.CNTN_20,
    (raw) => raw.technicalIndicators?.CNTN_20,
  ],
  advance_ratio: [
    (raw) => raw.factorSignals?.advance_ratio,
    (raw) => raw.factorSignals?.advanceRatio,
    (raw) => raw.advance_ratio,
    (raw) => raw.advanceRatio,
  ],
  advanceRatio: [
    (raw) => raw.factorSignals?.advanceRatio,
    (raw) => raw.factorSignals?.advance_ratio,
    (raw) => raw.advanceRatio,
    (raw) => raw.advance_ratio,
  ],
  ma10_bias: [
    (raw) => raw.factorSignals?.ma10_bias,
    (raw) => raw.factorSignals?.ma10Bias,
    (raw) => raw.technicalIndicators?.ma10Bias,
    (raw) => raw.ma10Bias,
  ],
  return_5d: [
    (raw) => raw.factorSignals?.return_5d,
    (raw) => raw.factorSignals?.return5d,
    (raw) => raw.technicalIndicators?.return5d,
    (raw) => raw.return5d,
  ],
  margin_balance: [
    (raw) => raw.factorSignals?.margin_balance,
    (raw) => raw.factorSignals?.marginBalance,
    (raw) => raw.margin_balance,
    (raw) => raw.marginBalance,
  ],
  marginBalance: [
    (raw) => raw.factorSignals?.marginBalance,
    (raw) => raw.factorSignals?.margin_balance,
    (raw) => raw.marginBalance,
    (raw) => raw.margin_balance,
  ],
  formal137MarginBalanceRank: [
    (raw) => raw.factorSignals?.formal137MarginBalanceRank,
    (raw) => raw.factorSignals?.margin_balance_rank,
    (raw) => raw.factorSignals?.marginBalanceRank,
    (raw) => raw.factorSignals?.margin_balance_normalized,
    (raw) => raw.factorSignals?.finlabCsMarginBalanceRank,
  ],
  margin_balance_rank: [
    (raw) => raw.factorSignals?.margin_balance_rank,
    (raw) => raw.factorSignals?.formal137MarginBalanceRank,
    (raw) => raw.factorSignals?.marginBalanceRank,
    (raw) => raw.factorSignals?.margin_balance_normalized,
    (raw) => raw.factorSignals?.finlabCsMarginBalanceRank,
  ],
  marginBalanceRank: [
    (raw) => raw.factorSignals?.marginBalanceRank,
    (raw) => raw.factorSignals?.formal137MarginBalanceRank,
    (raw) => raw.factorSignals?.margin_balance_rank,
    (raw) => raw.factorSignals?.margin_balance_normalized,
    (raw) => raw.factorSignals?.finlabCsMarginBalanceRank,
  ],
  margin_balance_normalized: [
    (raw) => raw.factorSignals?.margin_balance_normalized,
    (raw) => raw.factorSignals?.formal137MarginBalanceRank,
    (raw) => raw.factorSignals?.margin_balance_rank,
    (raw) => raw.factorSignals?.marginBalanceRank,
    (raw) => raw.factorSignals?.finlabCsMarginBalanceRank,
  ],
}

function firstFiniteSource(raw: Formal137RawSignals, sources: Array<(raw: Formal137RawSignals) => unknown>): number | null {
  for (const source of sources) {
    const value = finiteNumber(source(raw))
    if (value != null) return value
  }
  return null
}

export function materializeFormal137FeatureAliases<T extends Formal137MaterializationCandidate>(
  candidates: T[],
): Formal137FeatureAliasMaterializationTelemetry {
  const telemetry: Formal137FeatureAliasMaterializationTelemetry = {
    method: 'formal137_feature_alias_materialization_v1',
    universeCount: candidates.length,
    materializedCount: 0,
    aliasCoverage: {},
  }

  for (const candidate of candidates) {
    const raw = candidate.raw_signals
    if (!raw) continue
    let touched = false
    raw.factorSignals = { ...(raw.factorSignals ?? {}) }
    for (const [alias, sources] of Object.entries(FORMAL137_ALIAS_SOURCES)) {
      const existing = finiteNumber(raw.factorSignals[alias])
      if (existing != null) {
        telemetry.aliasCoverage[alias] = (telemetry.aliasCoverage[alias] ?? 0) + 1
        continue
      }
      const value = firstFiniteSource(raw, sources)
      if (value == null) continue
      raw.factorSignals[alias] = value
      telemetry.aliasCoverage[alias] = (telemetry.aliasCoverage[alias] ?? 0) + 1
      touched = true
    }
    if (touched) telemetry.materializedCount += 1
  }
  return telemetry
}

function sentimentDirection(score: number): 1 | -1 | 0 {
  if (score > 0.55) return 1
  if (score < 0.45) return -1
  return 0
}

function exposureValue(raw: Formal137RawSignals, component: typeof EXPOSURE_COMPONENTS[number]): number | null {
  if (component === 'sector_rs_ratio' || component === 'sector_turnover_share_delta') {
    return finiteNumber(raw.factorSignals?.[component])
  }
  if (component === 'KLOW2') {
    return finiteNumber(raw.technicalIndicators?.KLOW2 ?? raw.factorSignals?.KLOW2)
  }
  return finiteNumber(raw[component])
}

export function materializeFormal137UsSentimentScoreRank<T extends Formal137MaterializationCandidate>(
  candidates: T[],
): Formal137UsSentimentMaterializationTelemetry {
  const telemetry: Formal137UsSentimentMaterializationTelemetry = {
    method: 'formal137_us_sentiment_cross_sectional_exposure_rank_v1',
    universeCount: candidates.length,
    sentimentCoverage: 0,
    exposureEligibleCount: 0,
    materializedCount: 0,
    skippedNeutralCount: 0,
    skippedConstantExposureCount: 0,
    componentCoverage: {},
  }

  const sortedByComponent = new Map<typeof EXPOSURE_COMPONENTS[number], number[]>()
  for (const component of EXPOSURE_COMPONENTS) {
    const values = candidates
      .map((candidate) => candidate.raw_signals ? exposureValue(candidate.raw_signals, component) : null)
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b)
    sortedByComponent.set(component, values)
    telemetry.componentCoverage[component] = values.length
  }

  const pending: Array<{ raw: Formal137RawSignals; rank: number }> = []
  for (const candidate of candidates) {
    const raw = candidate.raw_signals
    if (!raw) continue
    const sentiment = rawSentimentScore(raw)
    if (sentiment == null) continue
    telemetry.sentimentCoverage += 1
    const direction = sentimentDirection(sentiment)
    if (direction === 0) {
      telemetry.skippedNeutralCount += 1
      continue
    }

    const exposureRanks: number[] = []
    for (const component of EXPOSURE_COMPONENTS) {
      const value = exposureValue(raw, component)
      if (value == null) continue
      const rank = percentileRank(value, sortedByComponent.get(component) ?? [])
      if (rank != null) exposureRanks.push(rank)
    }
    const riskOnRank = avg(exposureRanks)
    if (riskOnRank == null) continue
    telemetry.exposureEligibleCount += 1
    pending.push({
      raw,
      rank: round4(direction > 0 ? riskOnRank : 1 - riskOnRank),
    })
  }

  const uniqueRanks = new Set(pending.map((entry) => entry.rank))
  if (uniqueRanks.size < 2) {
    telemetry.skippedConstantExposureCount = pending.length
    return telemetry
  }

  for (const entry of pending) {
    entry.raw.factorSignals = { ...(entry.raw.factorSignals ?? {}) }
    for (const alias of US_SENTIMENT_RANK_ALIASES) {
      entry.raw.factorSignals[alias] = entry.rank
    }
    telemetry.materializedCount += 1
  }
  return telemetry
}
