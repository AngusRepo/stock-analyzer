import type { MarketRegime } from './dynamicExitPriority'
import type { ExitDecision, ExitPosition } from './paperExitPolicy'
import type { PaperExitCandidate } from './paperExitArbiter'

export type HoldingExitReviewAction =
  | 'hold'
  | 'warn'
  | 'tighten_trail'
  | 'partial_exit'
  | 'full_exit'

export type HoldingExitFeatureGroup =
  | 'brokerFlow'
  | 'institutionalChip'
  | 'moneyFlow'
  | 'structure'
  | 'giveback'
  | 'regime'

export type HoldingExitFeatureSourceKey =
  | HoldingExitFeatureGroup
  | 'priceWindow'

export interface HoldingExitFeatureQualitySource {
  available: boolean
  source: string
  rows: number
  latestDate: string | null
}

export interface HoldingExitFeatureQuality {
  coverage: number
  missing: HoldingExitFeatureGroup[]
  sources: Record<HoldingExitFeatureSourceKey, HoldingExitFeatureQualitySource>
}

export interface HoldingExitFactorScale {
  brokerNetAmount5d?: number | null
  institutionalNetAmount5d?: number | null
  brokerConcentrationDelta5d?: number | null
  moneyFlowWeakThreshold?: number | null
  supportBreakPct?: number | null
  givebackRatio?: number | null
  provenance?: {
    source: string
    method: string
    lookbackRows: number
  }
}

export interface HoldingExitFeatures {
  brokerNetAmount5d?: number | null
  brokerConcentrationDelta5d?: number | null
  institutionalNetAmount5d?: number | null
  obvTemperature60?: number | null
  supportBreakPct?: number | null
  mfePct?: number | null
  givebackPct?: number | null
  regime?: MarketRegime | null
  featureQuality?: HoldingExitFeatureQuality
  factorScale?: HoldingExitFactorScale
}

export interface HoldingExitAdaptiveParams {
  weights: {
    brokerFlow: number
    institutionalChip: number
    moneyFlow: number
    structure: number
    giveback: number
    regime: number
  }
  thresholds: Record<MarketRegime | 'default', {
    warn: number
    tighten: number
    partial: number
    full: number
  }>
  trailAtrMultiplier: Record<MarketRegime | 'default', number>
  movingTarget: {
    activationRatio: number
    maxExitRiskScore: number
    minConfidence: number
    maxExtensionPct: number
    atrMultiplier: Record<MarketRegime | 'default', number>
  }
  sellActions: {
    enabled: boolean
    allowPartialExit: boolean
    allowFullExit: boolean
    minConfidence: number
    partialSellRatio: number
    minPartialShares: number
    roundLotSize: number
  }
  dataQuality: {
    minCoverageForMoveTarget: number
    minFlowCoverageForMoveTarget: number
    minCoverageForSellAction: number
    minFlowCoverageForSellAction: number
  }
  actionGates: {
    fullExitStructureMin: number
    partialExitStructureMin: number
    partialExitGivebackMin: number
  }
  reasonCutoffs: {
    brokerFlow: number
    institutionalChip: number
    moneyFlow: number
    structure: number
    giveback: number
  }
  minScoreConfidence: number
}

export interface HoldingExitReviewInput {
  position: ExitPosition
  currentPrice: number
  atr14: number
  baseline: Pick<ExitDecision, 'action' | 'reason'>
  features?: HoldingExitFeatures
  params?: HoldingExitAdaptiveParams
}

export interface HoldingExitReview {
  action: HoldingExitReviewAction
  score: number
  confidence: number
  reasons: string[]
  suggestedTrailingStop?: number
  factors: {
    brokerFlow: number
    institutionalChip: number
    moneyFlow: number
    structure: number
    giveback: number
    regime: number
  }
  features: HoldingExitFeatures
  baselineCounterfactual: Pick<ExitDecision, 'action' | 'reason'>
}

export const DEFAULT_HOLDING_EXIT_PARAMS: HoldingExitAdaptiveParams = {
  weights: {
    brokerFlow: 0.25,
    institutionalChip: 0.20,
    moneyFlow: 0.20,
    structure: 0.15,
    giveback: 0.15,
    regime: 0.05,
  },
  thresholds: {
    default: { warn: 0.38, tighten: 0.58, partial: 0.74, full: 0.88 },
    bull: { warn: 0.44, tighten: 0.65, partial: 0.80, full: 0.92 },
    sideways: { warn: 0.35, tighten: 0.55, partial: 0.70, full: 0.84 },
    bear: { warn: 0.32, tighten: 0.50, partial: 0.66, full: 0.80 },
    volatile: { warn: 0.30, tighten: 0.48, partial: 0.64, full: 0.78 },
  },
  trailAtrMultiplier: {
    default: 1.35,
    bull: 1.55,
    sideways: 1.20,
    bear: 1.05,
    volatile: 0.95,
  },
  movingTarget: {
    activationRatio: 0.985,
    maxExitRiskScore: 0.34,
    minConfidence: 0.50,
    maxExtensionPct: 0.12,
    atrMultiplier: {
      default: 1.20,
      bull: 1.80,
      sideways: 1.00,
      bear: 0.70,
      volatile: 0.80,
    },
  },
  sellActions: {
    enabled: true,
    allowPartialExit: true,
    allowFullExit: true,
    minConfidence: 0.70,
    partialSellRatio: 0.50,
    minPartialShares: 1000,
    roundLotSize: 1000,
  },
  dataQuality: {
    minCoverageForMoveTarget: 0.67,
    minFlowCoverageForMoveTarget: 0.67,
    minCoverageForSellAction: 0.67,
    minFlowCoverageForSellAction: 0.67,
  },
  actionGates: {
    fullExitStructureMin: 0.60,
    partialExitStructureMin: 0.40,
    partialExitGivebackMin: 0.45,
  },
  reasonCutoffs: {
    brokerFlow: 0.35,
    institutionalChip: 0.35,
    moneyFlow: 0.35,
    structure: 0.35,
    giveback: 0.30,
  },
  minScoreConfidence: 0.45,
}

function finite(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function inferredSource(source: string, available: boolean): HoldingExitFeatureQualitySource {
  return {
    available,
    source,
    rows: available ? 1 : 0,
    latestDate: null,
  }
}

export function buildHoldingExitFeatureQuality(features: HoldingExitFeatures): HoldingExitFeatureQuality {
  const brokerFlowAvailable = features.brokerNetAmount5d != null || features.brokerConcentrationDelta5d != null
  const institutionalChipAvailable = features.institutionalNetAmount5d != null
  const moneyFlowAvailable = features.obvTemperature60 != null
  const structureAvailable = features.supportBreakPct != null
  const givebackAvailable = features.mfePct != null && features.givebackPct != null
  const regimeAvailable = features.regime != null

  const availability: Record<HoldingExitFeatureGroup, boolean> = {
    brokerFlow: brokerFlowAvailable,
    institutionalChip: institutionalChipAvailable,
    moneyFlow: moneyFlowAvailable,
    structure: structureAvailable,
    giveback: givebackAvailable,
    regime: regimeAvailable,
  }
  const missing = (Object.keys(availability) as HoldingExitFeatureGroup[])
    .filter((key) => !availability[key])
  const existingSources = features.featureQuality?.sources

  return {
    coverage: round4(1 - missing.length / Object.keys(availability).length),
    missing,
    sources: {
      brokerFlow: existingSources?.brokerFlow ?? inferredSource('canonical_broker_flow_daily', brokerFlowAvailable),
      institutionalChip: existingSources?.institutionalChip ?? inferredSource('canonical_chip_daily', institutionalChipAvailable),
      moneyFlow: existingSources?.moneyFlow ?? inferredSource('technical_indicators.obv_temperature_60', moneyFlowAvailable),
      structure: existingSources?.structure ?? inferredSource('stock_prices.entry_window', structureAvailable),
      giveback: existingSources?.giveback ?? inferredSource('stock_prices.entry_window', givebackAvailable),
      regime: existingSources?.regime ?? inferredSource('market_regime_state', regimeAvailable),
      priceWindow: existingSources?.priceWindow ?? inferredSource('stock_prices.entry_window', structureAvailable || givebackAvailable),
    },
  }
}

function normalizeSellAmount(value: unknown, scale = 20_000_000): number {
  const n = finite(value)
  if (n == null || n >= 0) return 0
  return clamp01(Math.abs(n) / scale)
}

function positiveFinite(value: unknown): number | null {
  const n = finite(value)
  return n != null && n > 0 ? n : null
}

function scoreBrokerFlow(features: HoldingExitFeatures, reasons: string[], cutoff: number): number {
  const netScale = positiveFinite(features.factorScale?.brokerNetAmount5d) ?? 20_000_000
  const concentrationScale = positiveFinite(features.factorScale?.brokerConcentrationDelta5d) ?? 0.3
  const net = normalizeSellAmount(features.brokerNetAmount5d, netScale)
  const concentrationDelta = finite(features.brokerConcentrationDelta5d)
  const concentration = concentrationDelta != null && concentrationDelta < 0
    ? clamp01(Math.abs(concentrationDelta) / concentrationScale)
    : 0
  const score = Math.max(net, concentration)
  if (score >= cutoff) reasons.push('broker_flow_distribution')
  return score
}

function scoreInstitutionalChip(features: HoldingExitFeatures, reasons: string[], cutoff: number): number {
  const scale = positiveFinite(features.factorScale?.institutionalNetAmount5d) ?? 20_000_000
  const score = normalizeSellAmount(features.institutionalNetAmount5d, scale)
  if (score >= cutoff) reasons.push('institutional_chip_distribution')
  return score
}

function scoreMoneyFlow(features: HoldingExitFeatures, reasons: string[], cutoff: number): number {
  const obv = finite(features.obvTemperature60)
  if (obv == null) return 0
  const threshold = positiveFinite(features.factorScale?.moneyFlowWeakThreshold) ?? 45
  const score = obv < threshold ? clamp01((threshold - obv) / threshold) : 0
  if (score >= cutoff) reasons.push('money_flow_weakness')
  return score
}

function scoreStructure(features: HoldingExitFeatures, reasons: string[], cutoff: number): number {
  const supportBreak = finite(features.supportBreakPct)
  const scale = positiveFinite(features.factorScale?.supportBreakPct) ?? 0.05
  const score = supportBreak != null && supportBreak > 0 ? clamp01(supportBreak / scale) : 0
  if (score >= cutoff) reasons.push('structure_break')
  return score
}

function scoreGiveback(features: HoldingExitFeatures, reasons: string[], cutoff: number): number {
  const mfe = finite(features.mfePct)
  const giveback = finite(features.givebackPct)
  if (mfe == null || giveback == null || mfe <= 0 || giveback <= 0) return 0
  const ratio = giveback / mfe
  const ratioScale = positiveFinite(features.factorScale?.givebackRatio)
  const score = ratioScale != null ? clamp01(ratio / ratioScale) : clamp01(ratio)
  if (score >= cutoff) reasons.push('giveback_risk')
  return score
}

function scoreRegime(regime: MarketRegime | null | undefined): number {
  if (regime === 'volatile') return 0.75
  if (regime === 'bear') return 0.65
  if (regime === 'sideways') return 0.35
  if (regime === 'bull') return 0.15
  return 0.25
}

function weightedScore(
  factors: HoldingExitReview['factors'],
  params: HoldingExitAdaptiveParams,
): number {
  const w = params.weights
  const totalWeight = w.brokerFlow + w.institutionalChip + w.moneyFlow + w.structure + w.giveback + w.regime
  if (totalWeight <= 0) return 0
  return (
    factors.brokerFlow * w.brokerFlow
    + factors.institutionalChip * w.institutionalChip
    + factors.moneyFlow * w.moneyFlow
    + factors.structure * w.structure
    + factors.giveback * w.giveback
    + factors.regime * w.regime
  ) / totalWeight
}

function resolveThresholds(params: HoldingExitAdaptiveParams, regime: MarketRegime | null | undefined) {
  return (regime && params.thresholds[regime]) || params.thresholds.default
}

function resolveTrailMultiplier(params: HoldingExitAdaptiveParams, regime: MarketRegime | null | undefined): number {
  return (regime && params.trailAtrMultiplier[regime]) || params.trailAtrMultiplier.default
}

function featureConfidence(features: HoldingExitFeatures): number {
  const qualityCoverage = finite(features.featureQuality?.coverage)
  if (qualityCoverage != null) return round4(clamp01(qualityCoverage))
  const keys: Array<keyof HoldingExitFeatures> = [
    'brokerNetAmount5d',
    'brokerConcentrationDelta5d',
    'institutionalNetAmount5d',
    'obvTemperature60',
    'supportBreakPct',
    'mfePct',
    'givebackPct',
    'regime',
  ]
  const present = keys.filter((key) => features[key] != null).length
  return round4(present / keys.length)
}

function flowEvidenceCoverage(features: HoldingExitFeatures): number {
  const missing = new Set(features.featureQuality?.missing ?? [])
  const groups: HoldingExitFeatureGroup[] = ['brokerFlow', 'institutionalChip', 'moneyFlow']
  const present = groups.filter((group) => !missing.has(group)).length
  return round4(present / groups.length)
}

export function holdingExitDataQualityGuardReason(
  features: HoldingExitFeatures,
  policy: HoldingExitAdaptiveParams['dataQuality'],
  context: 'move_target' | 'sell_action',
): string | null {
  const coverage = featureConfidence(features)
  const flowCoverage = flowEvidenceCoverage(features)
  const minCoverage = context === 'move_target'
    ? policy.minCoverageForMoveTarget
    : policy.minCoverageForSellAction
  const minFlowCoverage = context === 'move_target'
    ? policy.minFlowCoverageForMoveTarget
    : policy.minFlowCoverageForSellAction

  if (coverage < minCoverage) return `feature_quality_low_for_${context}`
  if (flowCoverage < minFlowCoverage) return `feature_quality_flow_low_for_${context}`
  return null
}

function suggestTrailingStop(input: HoldingExitReviewInput, params: HoldingExitAdaptiveParams): number {
  const entry = input.position.entry_price ?? input.position.avg_cost
  const atr = input.atr14 > 0 ? input.atr14 : input.currentPrice * 0.02
  const multiplier = resolveTrailMultiplier(params, input.features?.regime)
  const raw = input.currentPrice - atr * multiplier
  return Math.round(Math.max(entry, raw) * 100) / 100
}

export function buildHoldingExitReview(input: HoldingExitReviewInput): HoldingExitReview {
  const params = input.params ?? DEFAULT_HOLDING_EXIT_PARAMS
  const features: HoldingExitFeatures = {
    ...(input.features ?? {}),
  }
  features.featureQuality = buildHoldingExitFeatureQuality(features)
  const reasons: string[] = []
  const reasonCutoffs = params.reasonCutoffs
  const factors = {
    brokerFlow: scoreBrokerFlow(features, reasons, reasonCutoffs.brokerFlow),
    institutionalChip: scoreInstitutionalChip(features, reasons, reasonCutoffs.institutionalChip),
    moneyFlow: scoreMoneyFlow(features, reasons, reasonCutoffs.moneyFlow),
    structure: scoreStructure(features, reasons, reasonCutoffs.structure),
    giveback: scoreGiveback(features, reasons, reasonCutoffs.giveback),
    regime: scoreRegime(features.regime),
  }
  const score = round4(weightedScore(factors, params))
  const confidence = featureConfidence(features)
  const thresholds = resolveThresholds(params, features.regime)
  const currentTrail = finite(input.position.trailing_stop) ?? 0
  const suggestedTrailingStop = suggestTrailingStop(input, params)
  if (features.featureQuality.missing.length > 0) {
    reasons.push(`feature_quality_missing:${features.featureQuality.missing.join('|')}`)
  }
  if (confidence < params.minScoreConfidence) reasons.push('feature_quality_low')

  let action: HoldingExitReviewAction = 'hold'
  if (confidence >= params.minScoreConfidence) {
    if (score >= thresholds.full && factors.structure >= params.actionGates.fullExitStructureMin) action = 'full_exit'
    else if (score >= thresholds.partial && (
      factors.structure >= params.actionGates.partialExitStructureMin
      || factors.giveback >= params.actionGates.partialExitGivebackMin
    )) action = 'partial_exit'
    else if (score >= thresholds.tighten && suggestedTrailingStop > currentTrail) action = 'tighten_trail'
    else if (score >= thresholds.warn) action = 'warn'
  }

  if (action === 'hold' && reasons.length === 0) reasons.push('no_holding_exit_trigger')
  if (action === 'hold' && score >= thresholds.tighten && suggestedTrailingStop <= currentTrail) {
    reasons.push('tighten_not_above_current_trail')
  }

  return {
    action,
    score,
    confidence,
    reasons,
    suggestedTrailingStop: action === 'tighten_trail' ? suggestedTrailingStop : undefined,
    factors,
    features,
    baselineCounterfactual: input.baseline,
  }
}

export function buildHoldingExitReviewCandidate(
  review: HoldingExitReview,
  options: {
    allowSellActions?: boolean
    position?: ExitPosition
    sellActions?: HoldingExitAdaptiveParams['sellActions']
    dataQuality?: HoldingExitAdaptiveParams['dataQuality']
  } = {},
): PaperExitCandidate {
  const sellGuard = resolveSellActionGuard(review, options.position, {
    ...DEFAULT_HOLDING_EXIT_PARAMS.sellActions,
    ...(options.sellActions ?? {}),
    enabled: Boolean(options.allowSellActions && (options.sellActions?.enabled ?? DEFAULT_HOLDING_EXIT_PARAMS.sellActions.enabled)),
  }, options.dataQuality ?? DEFAULT_HOLDING_EXIT_PARAMS.dataQuality)
  const detail = {
    score: review.score,
    confidence: review.confidence,
    reasons: review.reasons,
    factors: review.factors,
    features: review.features,
    baseline_counterfactual: review.baselineCounterfactual,
    sell_action_guard: sellGuard,
  }

  if (review.action === 'tighten_trail' && review.suggestedTrailingStop != null) {
    return {
      source: 'holding_review',
      action: 'tighten_trail',
      priority: 'HOLDING_REVIEW_TIGHTEN',
      reason: review.reasons.join(',') || 'holding_review_tighten',
      newTrailingStop: review.suggestedTrailingStop,
      detail,
    }
  }

  if (review.action === 'partial_exit' && sellGuard.allowed && sellGuard.action === 'partial_sell') {
    return {
      source: 'holding_review',
      action: 'partial_sell',
      priority: 'HOLDING_REVIEW_PARTIAL',
      reason: review.reasons.join(',') || 'holding_review_partial',
      sellShares: sellGuard.sellShares,
      detail,
    }
  }

  if (review.action === 'full_exit' && sellGuard.allowed && sellGuard.action === 'full_sell') {
    return {
      source: 'holding_review',
      action: 'full_sell',
      priority: 'HOLDING_REVIEW_FULL',
      reason: review.reasons.join(',') || 'holding_review_full',
      detail,
    }
  }

  return {
    source: 'holding_review',
    action: 'hold',
    priority: 'HOLD',
    reason: review.reasons.join(',') || 'holding_review_hold',
    detail,
  }
}

type SellActionGuard =
  | { allowed: true; action: 'partial_sell'; sellShares: number; reason: string }
  | { allowed: true; action: 'full_sell'; sellShares: null; reason: string }
  | { allowed: false; action: 'hold'; sellShares: null; reason: string }

function roundDownShares(shares: number, lotSize: number): number {
  const cleanLot = Math.max(1, Math.floor(lotSize))
  return Math.floor(Math.max(0, shares) / cleanLot) * cleanLot
}

function computePartialSellShares(
  position: ExitPosition,
  sellActions: HoldingExitAdaptiveParams['sellActions'],
): number {
  const ratio = Math.max(0, Math.min(1, sellActions.partialSellRatio))
  const raw = Math.floor(position.shares * ratio)
  const rounded = roundDownShares(raw, sellActions.roundLotSize)
  if (rounded >= position.shares) {
    return roundDownShares(position.shares - sellActions.roundLotSize, sellActions.roundLotSize)
  }
  return rounded
}

function resolveSellActionGuard(
  review: HoldingExitReview,
  position: ExitPosition | undefined,
  sellActions: HoldingExitAdaptiveParams['sellActions'],
  dataQuality: HoldingExitAdaptiveParams['dataQuality'],
): SellActionGuard {
  if (!sellActions.enabled) return { allowed: false, action: 'hold', sellShares: null, reason: 'sell_actions_disabled' }
  const qualityReason = holdingExitDataQualityGuardReason(review.features, dataQuality, 'sell_action')
  if (qualityReason) return { allowed: false, action: 'hold', sellShares: null, reason: qualityReason }
  if (review.confidence < sellActions.minConfidence) return { allowed: false, action: 'hold', sellShares: null, reason: 'low_confidence' }

  if (review.action === 'full_exit') {
    if (!sellActions.allowFullExit) return { allowed: false, action: 'hold', sellShares: null, reason: 'full_exit_disabled' }
    return { allowed: true, action: 'full_sell', sellShares: null, reason: 'full_exit_guard_passed' }
  }

  if (review.action === 'partial_exit') {
    if (!sellActions.allowPartialExit) return { allowed: false, action: 'hold', sellShares: null, reason: 'partial_exit_disabled' }
    if (!position) return { allowed: false, action: 'hold', sellShares: null, reason: 'missing_position_for_partial_exit' }
    const sellShares = computePartialSellShares(position, sellActions)
    if (sellShares < sellActions.minPartialShares || sellShares <= 0 || sellShares >= position.shares) {
      return { allowed: false, action: 'hold', sellShares: null, reason: 'partial_sell_size_invalid' }
    }
    return { allowed: true, action: 'partial_sell', sellShares, reason: 'partial_exit_guard_passed' }
  }

  return { allowed: false, action: 'hold', sellShares: null, reason: 'review_action_not_sell' }
}
