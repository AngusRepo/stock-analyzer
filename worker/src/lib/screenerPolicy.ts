import type { AdaptiveParams } from './adaptiveConfig'
import { buildPartialScreenerScoreV2 } from './scoreV2Taxonomy'
import type { TradingConfig } from './tradingConfig'

export interface ScreenerSizingPolicy {
  candidatePoolSize: number
  coarseMlQueueSize: number
  coarseMlKeepRatio: number
  mlShortlistSize: number
  emergingResearchSize: number
}

export interface ScreenerScoreCalibrationPolicy {
  enabled: boolean
  method: 'percentile_zscore'
  minCrossSectionSize: number
  percentileWeight: number
  zScoreWeight: number
}

export interface ScreenerPolicy {
  sizing: ScreenerSizingPolicy
  scoreCalibration: ScreenerScoreCalibrationPolicy
}

export interface ScreenerScoreCandidate {
  score: number
  chip_score: number
  tech_score: number
  momentum_score?: number
  score_components?: string
  market_segment?: string
  reason?: string
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = finiteNumber(value)
  if (n === null) return fallback
  return clamp(Math.round(n), min, max)
}

function applyAdaptiveDelta(base: number, delta: unknown, min: number, max: number): number {
  const n = finiteNumber(delta)
  return positiveInt(n === null ? base : base + n, base, min, max)
}

export function resolveScreenerPolicy(config: TradingConfig, adaptive?: AdaptiveParams | null): ScreenerPolicy {
  const raw = config.screener as Record<string, unknown>
  const adaptiveScreener = adaptive?.screener ?? {}

  const candidatePoolBase = positiveInt(raw.candidatePoolSize, 200, 180, 240)
  const coarseMlQueueBase = positiveInt(raw.coarseMlQueueSize, 80, 30, 160)
  const coarseMlKeepRatio = clamp(finiteNumber(raw.coarseMlKeepRatio) ?? 0.75, 0.25, 1)
  const mlShortlistBase = positiveInt(raw.mlShortlistSize ?? raw.maxCandidates, 35, 15, 80)
  const emergingResearchBase = positiveInt(raw.emergingResearchSize ?? raw.emergingMaxCandidates, 24, 0, 80)

  const candidatePoolSize = applyAdaptiveDelta(
    candidatePoolBase,
    adaptiveScreener.candidate_pool_delta,
    180,
    240,
  )
  const coarseMlQueueSize = Math.min(
    applyAdaptiveDelta(coarseMlQueueBase, adaptiveScreener.coarse_ml_queue_delta, 30, 160),
    candidatePoolSize,
  )
  const mlShortlistSize = Math.min(
    applyAdaptiveDelta(mlShortlistBase, adaptiveScreener.ml_shortlist_delta, 15, 80),
    coarseMlQueueSize,
  )
  const emergingResearchSize = applyAdaptiveDelta(
    emergingResearchBase,
    adaptiveScreener.emerging_research_delta,
    0,
    80,
  )

  return {
    sizing: {
      candidatePoolSize,
      coarseMlQueueSize,
      coarseMlKeepRatio,
      mlShortlistSize,
      emergingResearchSize,
    },
    scoreCalibration: {
      enabled: raw.scoreCalibrationEnabled !== false,
      method: 'percentile_zscore',
      minCrossSectionSize: positiveInt(raw.scoreCalibrationMinSize, 30, 10, 300),
      percentileWeight: clamp(finiteNumber(raw.scoreCalibrationPercentileWeight) ?? 0.65, 0, 1),
      zScoreWeight: clamp(finiteNumber(raw.scoreCalibrationZScoreWeight) ?? 0.35, 0, 1),
    },
  }
}

function percentile(values: number[], value: number): number {
  if (values.length <= 1) return 0.5
  let below = 0
  let equal = 0
  for (const v of values) {
    if (v < value) below++
    else if (v === value) equal++
  }
  return clamp((below + equal * 0.5) / values.length, 0, 1)
}

function zScoreComponent(values: number[], value: number): number {
  if (values.length <= 1) return 0.5
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  const std = Math.sqrt(variance)
  if (std < 1e-9) return 0.5
  return clamp(((value - mean) / std + 2) / 4, 0, 1)
}

function calibrateComponent(
  raw: number,
  values: number[],
  maxScore: number,
  policy: ScreenerScoreCalibrationPolicy,
): number {
  const p = percentile(values, raw)
  const z = zScoreComponent(values, raw)
  const weightSum = Math.max(0.001, policy.percentileWeight + policy.zScoreWeight)
  const normalized = (p * policy.percentileWeight + z * policy.zScoreWeight) / weightSum
  return Math.round(Math.min(raw, normalized * maxScore) * 10) / 10
}

function syncScoreV2Payload(candidate: ScreenerScoreCandidate): number {
  const payload = buildPartialScreenerScoreV2({
    chipScore40: candidate.chip_score,
    techScore30: candidate.tech_score,
    momentumScore20: candidate.momentum_score ?? 0,
    reasons: candidate.reason ? [candidate.reason] : [],
  })
  candidate.score_components = JSON.stringify(payload)
  return payload.finalScore ?? payload.total
}

export function applyScreenerScoreCalibration<T extends ScreenerScoreCandidate>(
  candidates: T[],
  policy: ScreenerScoreCalibrationPolicy,
): T[] {
  if (!policy.enabled || candidates.length < policy.minCrossSectionSize) return candidates

  const groups = new Map<string, T[]>()
  for (const candidate of candidates) {
    const key = candidate.market_segment || 'default'
    const group = groups.get(key)
    if (group) group.push(candidate)
    else groups.set(key, [candidate])
  }

  for (const group of groups.values()) {
    if (group.length < policy.minCrossSectionSize) continue
    calibrateCandidates(group, group, policy)
  }

  return candidates
}

function calibrateCandidates<T extends ScreenerScoreCandidate>(
  targets: T[],
  pool: T[],
  policy: ScreenerScoreCalibrationPolicy,
): void {
  const chipValues = pool.map(c => finiteNumber(c.chip_score) ?? 0)
  const techValues = pool.map(c => finiteNumber(c.tech_score) ?? 0)
  const momentumValues = pool.map(c => finiteNumber(c.momentum_score) ?? 0)

  for (const c of targets) {
    const rawChip = finiteNumber(c.chip_score) ?? 0
    const rawTech = finiteNumber(c.tech_score) ?? 0
    const rawMomentum = finiteNumber(c.momentum_score) ?? 0
    const chip = calibrateComponent(rawChip, chipValues, 40, policy)
    const tech = calibrateComponent(rawTech, techValues, 30, policy)
    const momentum = calibrateComponent(rawMomentum, momentumValues, 20, policy)
    c.chip_score = chip
    c.tech_score = tech
    c.momentum_score = momentum
    const scoreV2Total = syncScoreV2Payload(c)
    const delta = Math.round((scoreV2Total - c.score) * 10) / 10
    c.score = scoreV2Total
    if (delta < -0.5 && c.reason) {
      c.reason = `${c.reason} | cross-section calibration ${delta.toFixed(1)}`
    }
  }
}
