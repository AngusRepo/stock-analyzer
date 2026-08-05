import type { AlphaFrameworkBucket, AlphaFrameworkRegime } from './tradingConfig'
import { readScoreV2Snapshot, type ScoreV2StorageRow } from './scoreV2Taxonomy'

export const STRATEGY_SPEC_VERSION = 'strategy-spec-v1'

export type StrategySpecStatus = 'research' | 'shadow' | 'candidate' | 'active' | 'retired'
export type StrategyFamilyId =
  | 'VOLATILITY_CONTRACTION_BREAKOUT'
  | 'TREND_RECLAIM_CONTINUATION'
  | 'SMART_MONEY_ACCUMULATION'
  | 'SMC_STRUCTURE_RECLAIM'
  | 'REVENUE_QUALITY_MOMENTUM'
  | 'SECTOR_ROTATION_CORE'
  | 'TREND_QUALITY_BREAKOUT_FUSED'
  | 'ALPHA223_BREAKOUT_CASH_FLOW'
  | 'ALPHA223_QUALITY_TURNOVER'
  | 'ALPHA223_EXPENSE_PROFIT_THRUST'
  | 'ALPHA223_CASHFLOW_ASSET_TURNOVER'
  | 'ALPHA223_CASH_GAP_BROKER_FLOW'
export type StrategyOwnerType = 'strategy' | 'feature' | 'observe' | 'retired'
export type StrategyPromotionStatus = 'production' | 'candidate' | 'research' | 'retired'

export interface StrategyCandidateInput {
  symbol: string
  name?: string
  sector?: string
  industry?: string
  score_v2?: unknown
  current_price?: number | null
  raw_signals?: StrategyRawSignals | string | null
}

export interface StrategySpecThresholds {
  minSeedScore?: number
  minChipScore?: number
  minTechScore?: number
  minMomentumScore?: number
  minPrice?: number
  maxPrice?: number
  minCloseAboveMa20Pct?: number
  maxCloseAboveMa20Pct?: number
  minCloseAboveMa60Pct?: number
  maxCloseAboveMa60Pct?: number
  minVolumeExpansion20?: number
  minReturn20d?: number
  maxReturn20d?: number
  minForeignTrustNet5d?: number
  minDealerNet5d?: number
  minBrokerNetShares5d?: number
  minBrokerNetAmount5d?: number
  minBrokerCount?: number
  maxBrokerConcentration?: number
  minRevenueGrowthYoY?: number
  minMonthlyRevenueYoY?: number
  minMonthlyRevenueMoM?: number
  minGrossMargin?: number
  minOperatingMargin?: number
  minRoe?: number
  minEps?: number
  maxPe?: number
  maxPb?: number
  minTechnicalIndicators?: Record<string, number>
  maxTechnicalIndicators?: Record<string, number>
  minFactorSignals?: Record<string, number>
  maxFactorSignals?: Record<string, number>
  dsl?: StrategySignalDsl
  featureRefs?: StrategyFeatureRefDsl
  includeIndustries?: string[]
  excludeIndustries?: string[]
}

export type StrategySignalOperator = '>=' | '>' | '<=' | '<' | '==' | '!='

export interface StrategySignalCondition {
  signal: string
  op: StrategySignalOperator
  value: number | string | boolean
}

export interface StrategySignalDsl {
  all?: StrategySignalCondition[]
  any?: StrategySignalCondition[]
  not?: StrategySignalCondition[]
}

export interface StrategyFeatureRefTerm {
  featureRef: string
  signal?: string
  weight?: number
}

export interface StrategyFeatureRefWeightedScore {
  min: number
  terms: StrategyFeatureRefTerm[]
  calibration?: StrategyFeatureRefWeightedScoreCalibration
  adaptivePolicy?: StrategyFeatureRefWeightedScoreAdaptivePolicy
}

export interface StrategyFeatureRefWeightedScoreAdaptivePolicy {
  policyId: string
  policyVersion: string
  knowledgeCutoffDate: string
  baselineMin: number
  effectiveMin: number
}

export interface StrategyFeatureRefWeightedScoreCalibration {
  schemaVersion: 'strategy-feature-ref-weighted-score-calibration-v1'
  calibrationId: string
  status: 'shadow' | 'candidate' | 'active'
  method: 'validation_fold_top_after_base_gates' | 'threshold_sensitivity_backtest' | 'auto_threshold_guardrail'
  originalMin: number
  calibratedMin: number
  validationFold: {
    startDate: string
    endDate: string
    excludedDates?: string[]
  }
  targetDailyMatches: number
  observed: {
    validationRows: number
    validationCompleteFeatureRows: number
    validationMatchesAtOriginalMin: number
    validationMatchesAtCalibratedMin: number
    holdoutDate?: string
    holdoutMatchesAtCalibratedMin?: number
  }
  sourceRefs: string[]
  frozenAt: string
}

export interface StrategyFeatureRefCondition extends StrategyFeatureRefTerm {
  op: StrategySignalOperator
  value: number | string | boolean
}

export interface StrategyFeatureRefDsl {
  weightedScore?: StrategyFeatureRefWeightedScore
  all?: StrategyFeatureRefCondition[]
  any?: StrategyFeatureRefCondition[]
  not?: StrategyFeatureRefCondition[]
}

export interface StrategyRawSignals {
  close?: number | null
  ma20?: number | null
  ma60?: number | null
  ma10Bias?: number | null
  closeAboveMa20Pct?: number | null
  closeAboveMa60Pct?: number | null
  return5d?: number | null
  volumeExpansion20?: number | null
  return20d?: number | null
  return60d?: number | null
  vwapBias?: number | null
  vwap5d?: number | null
  vwapBias5d?: number | null
  bestOrderBlockStrength?: number | null
  foreignNet5d?: number | null
  trustNet5d?: number | null
  dealerNet5d?: number | null
  foreignTrustNet5d?: number | null
  brokerNetShares5d?: number | null
  brokerNetAmount5d?: number | null
  marginBalance?: number | null
  shortBalance?: number | null
  brokerCount?: number | null
  brokerConcentration?: number | null
  revenueGrowthYoY?: number | null
  monthlyRevenueYoY?: number | null
  monthlyRevenueMoM?: number | null
  grossMargin?: number | null
  operatingMargin?: number | null
  roe?: number | null
  eps?: number | null
  pe?: number | null
  pb?: number | null
  dividendYield?: number | null
  nonCurrentAssets?: number | null
  cashAndCashEquivalentsIncreaseDecrease?: number | null
  otherPayables?: number | null
  technicalIndicators?: Record<string, number | null>
  factorSignals?: Record<string, number | null>
  source?: string | null
}

export interface StrategySpecCandidatePolicy {
  poolQuota?: number
  costBudget?: number
  evidenceRequirements?: string[]
  maxMlShare?: number
}

export interface StrategySpec {
  id: string
  version: string
  name: string
  status: StrategySpecStatus
  owner: 'strategy'
  familyId?: StrategyFamilyId
  variantId?: string
  ownerType?: StrategyOwnerType
  promotionStatus?: StrategyPromotionStatus
  alphaBucket: AlphaFrameworkBucket
  supportedRegimes: AlphaFrameworkRegime[]
  thesis: string
  thresholds: StrategySpecThresholds
  candidatePolicy?: StrategySpecCandidatePolicy
  riskNotes: string[]
  createdBy: 'p5_strategy_governance'
}

export interface StrategySpecValidation {
  ok: boolean
  errors: string[]
}

export interface StrategySpecMatch {
  specId: string
  alphaBucket: AlphaFrameworkBucket
  status: StrategySpecStatus
  label: string
  reason: string
}

export interface StrategySpecAssessment {
  matches: StrategySpecMatch[]
  tags: string[]
  watchPoints: string[]
}

export interface StrategyThresholdScores {
  seedScore: number
  chipFlow: number
  technicalStructure: number
  momentumScore: number
  source: 'score_v2' | 'missing_score_v2'
}

const FORBIDDEN_SPEC_KEYS = [
  'score',
  'chip_score',
  'tech_score',
  'momentum_score',
  'chipScore',
  'techScore',
  'momentumScore',
  'scoreBonus',
  'scoreBoost',
  'slateBoost',
  'ml_score',
  'mlScore',
  'has_buy_signal',
  'pendingBuy',
  'order',
  'fill',
  'promote',
]

const STRATEGY_FAMILY_IDS = new Set<StrategyFamilyId>([
  'VOLATILITY_CONTRACTION_BREAKOUT',
  'TREND_RECLAIM_CONTINUATION',
  'SMART_MONEY_ACCUMULATION',
  'SMC_STRUCTURE_RECLAIM',
  'REVENUE_QUALITY_MOMENTUM',
  'SECTOR_ROTATION_CORE',
  'TREND_QUALITY_BREAKOUT_FUSED',
  'ALPHA223_BREAKOUT_CASH_FLOW',
  'ALPHA223_QUALITY_TURNOVER',
  'ALPHA223_EXPENSE_PROFIT_THRUST',
  'ALPHA223_CASHFLOW_ASSET_TURNOVER',
  'ALPHA223_CASH_GAP_BROKER_FLOW',
])

const STRATEGY_OWNER_TYPES = new Set<StrategyOwnerType>(['strategy', 'feature', 'observe', 'retired'])
const STRATEGY_PROMOTION_STATUSES = new Set<StrategyPromotionStatus>(['production', 'candidate', 'research', 'retired'])

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function inferStrategyFamilyId(spec: Pick<StrategySpec, 'id' | 'alphaBucket'>): StrategyFamilyId {
  const id = cleanText(spec.id).toLowerCase()
  const tokens = new Set(id.split(/[^a-z0-9]+/).filter(Boolean))
  const hasToken = (...items: string[]) => items.some((item) => tokens.has(item))
  if (hasToken('sector', 'rotation', 'industry')) return 'SECTOR_ROTATION_CORE'
  if (hasToken('revenue', 'quality', 'value', 'fundamental')) {
    return 'REVENUE_QUALITY_MOMENTUM'
  }
  if (hasToken('broker', 'chip', 'accumulation', 'defensive')) {
    return 'SMART_MONEY_ACCUMULATION'
  }
  if (hasToken('smc', 'liquidity', 'choch', 'bos', 'sweep')) {
    return 'SMC_STRUCTURE_RECLAIM'
  }
  if (hasToken('breakout', 'squeeze', 'vcp', 'volume')) {
    return 'VOLATILITY_CONTRACTION_BREAKOUT'
  }
  if (hasToken('trend', 'reclaim', 'rsi', 'macd')) {
    return 'TREND_RECLAIM_CONTINUATION'
  }
  if (spec.alphaBucket === 'breakout_vol_expansion') return 'VOLATILITY_CONTRACTION_BREAKOUT'
  if (spec.alphaBucket === 'defensive_accumulation') return 'SMART_MONEY_ACCUMULATION'
  if (spec.alphaBucket === 'trend_following') return 'TREND_RECLAIM_CONTINUATION'
  return 'REVENUE_QUALITY_MOMENTUM'
}

export function inferStrategyOwnerType(spec: Pick<StrategySpec, 'id' | 'status'>): StrategyOwnerType {
  if (spec.status === 'retired') return 'retired'
  if (spec.status === 'research' || spec.status === 'shadow') return 'observe'
  return 'strategy'
}

export function inferStrategyPromotionStatus(spec: Pick<StrategySpec, 'status'>): StrategyPromotionStatus {
  if (spec.status === 'active') return 'production'
  if (spec.status === 'candidate' || spec.status === 'shadow') return 'candidate'
  if (spec.status === 'retired') return 'retired'
  return 'research'
}

export function normalizeStrategySpecGovernance(spec: StrategySpec): StrategySpec {
  const familyId = spec.familyId ?? inferStrategyFamilyId(spec)
  return {
    ...spec,
    familyId,
    variantId: cleanText(spec.variantId) || spec.id,
    ownerType: spec.ownerType ?? inferStrategyOwnerType(spec),
    promotionStatus: spec.promotionStatus ?? inferStrategyPromotionStatus(spec),
  }
}

function numberMap(value: unknown): Record<string, number | null> {
  const record = parseRecord(value)
  if (!record) return {}
  const out: Record<string, number | null> = {}
  for (const [key, rawValue] of Object.entries(record)) {
    const cleanKey = cleanText(key)
    if (!cleanKey) continue
    out[cleanKey] = finiteNumber(rawValue)
  }
  return out
}

function walkKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return []
  const out: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    out.push(path)
    out.push(...walkKeys(child, path))
  }
  return out
}

export function validateStrategySpec(spec: StrategySpec): StrategySpecValidation {
  const errors: string[] = []
  if (spec.version !== STRATEGY_SPEC_VERSION) errors.push('version_mismatch')
  if (spec.owner !== 'strategy') errors.push('owner_must_be_strategy')
  if (!cleanText(spec.id)) errors.push('id_missing')
  if (!cleanText(spec.name)) errors.push('name_missing')
  if (!cleanText(spec.thesis)) errors.push('thesis_missing')
  if (!spec.supportedRegimes?.length) errors.push('supported_regimes_missing')
  if (!spec.alphaBucket) errors.push('alpha_bucket_missing')
  if (spec.familyId != null && !STRATEGY_FAMILY_IDS.has(spec.familyId)) errors.push('family_id_invalid')
  if (spec.ownerType != null && !STRATEGY_OWNER_TYPES.has(spec.ownerType)) errors.push('owner_type_invalid')
  if (spec.promotionStatus != null && !STRATEGY_PROMOTION_STATUSES.has(spec.promotionStatus)) errors.push('promotion_status_invalid')
  for (const keyPath of walkKeys(spec)) {
    const leaf = keyPath.split('.').pop() ?? keyPath
    if (FORBIDDEN_SPEC_KEYS.includes(leaf)) errors.push(`forbidden_key:${keyPath}`)
  }
  return { ok: errors.length === 0, errors }
}

function industryAllowed(candidate: StrategyCandidateInput, thresholds: StrategySpecThresholds): boolean {
  const industry = cleanText(candidate.industry ?? candidate.sector)
  const includes = thresholds.includeIndustries?.map(cleanText).filter(Boolean) ?? []
  const excludes = thresholds.excludeIndustries?.map(cleanText).filter(Boolean) ?? []
  if (includes.length && !includes.includes(industry)) return false
  if (excludes.length && excludes.includes(industry)) return false
  return true
}

function meetsMinimum(value: unknown, min: number | undefined): boolean {
  if (min == null) return true
  const n = finiteNumber(value)
  return n != null && n >= min
}

function meetsPrice(candidate: StrategyCandidateInput, thresholds: StrategySpecThresholds): boolean {
  const price = finiteNumber(candidate.current_price) ?? deriveStrategyRawSignals(candidate).close ?? null
  if (thresholds.minPrice == null && thresholds.maxPrice == null) return true
  if (price == null) return false
  if (thresholds.minPrice != null && price < thresholds.minPrice) return false
  if (thresholds.maxPrice != null && price > thresholds.maxPrice) return false
  return true
}

function seedComponentNumber(record: Record<string, unknown> | null, key: string): number | null {
  const seeds = record?.seedComponents
  return seeds && typeof seeds === 'object' && !Array.isArray(seeds)
    ? finiteNumber((seeds as Record<string, unknown>)[key])
    : null
}

function scoreV2StorageRow(candidate: StrategyCandidateInput): ScoreV2StorageRow {
  return { score_components: candidate.score_v2 }
}

export function deriveStrategyRawSignals(candidate: StrategyCandidateInput): StrategyRawSignals {
  const raw = parseRecord(candidate.raw_signals)
  if (!raw) return {}
  const rawTechnicalIndicators = parseRecord(raw.technicalIndicators)
  const rawFactorSignals = parseRecord(raw.factorSignals)
  const base: StrategyRawSignals = {
    close: finiteNumber(raw.close),
    ma20: finiteNumber(raw.ma20),
    ma60: finiteNumber(raw.ma60),
    ma10Bias: finiteNumber(raw.ma10Bias ?? raw.ma10_bias),
    closeAboveMa20Pct: finiteNumber(raw.closeAboveMa20Pct),
    closeAboveMa60Pct: finiteNumber(raw.closeAboveMa60Pct),
    return5d: finiteNumber(raw.return5d ?? raw.return_5d),
    volumeExpansion20: finiteNumber(raw.volumeExpansion20),
    return20d: finiteNumber(raw.return20d),
    return60d: finiteNumber(raw.return60d),
    vwapBias: finiteNumber(raw.vwapBias ?? raw.vwap_bias ?? rawFactorSignals?.vwap_bias ?? rawTechnicalIndicators?.vwap_bias),
    vwap5d: finiteNumber(raw.vwap5d ?? raw.vwap_5d ?? rawFactorSignals?.vwap_5d ?? rawTechnicalIndicators?.vwap_5d),
    vwapBias5d: finiteNumber(raw.vwapBias5d ?? raw.vwap_bias_5d ?? rawFactorSignals?.vwap_bias_5d ?? rawTechnicalIndicators?.vwap_bias_5d),
    foreignNet5d: finiteNumber(raw.foreignNet5d),
    trustNet5d: finiteNumber(raw.trustNet5d),
    dealerNet5d: finiteNumber(raw.dealerNet5d),
    foreignTrustNet5d: finiteNumber(raw.foreignTrustNet5d),
    brokerNetShares5d: finiteNumber(raw.brokerNetShares5d),
    brokerNetAmount5d: finiteNumber(raw.brokerNetAmount5d),
    marginBalance: finiteNumber(raw.marginBalance ?? raw.margin_balance),
    shortBalance: finiteNumber(raw.shortBalance ?? raw.short_balance),
    brokerCount: finiteNumber(raw.brokerCount),
    brokerConcentration: finiteNumber(raw.brokerConcentration),
    revenueGrowthYoY: finiteNumber(raw.revenueGrowthYoY),
    monthlyRevenueYoY: finiteNumber(raw.monthlyRevenueYoY),
    monthlyRevenueMoM: finiteNumber(raw.monthlyRevenueMoM),
    grossMargin: finiteNumber(raw.grossMargin),
    operatingMargin: finiteNumber(raw.operatingMargin),
    roe: finiteNumber(raw.roe),
    eps: finiteNumber(raw.eps),
    pe: finiteNumber(raw.pe),
    pb: finiteNumber(raw.pb),
    dividendYield: finiteNumber(raw.dividendYield),
    source: cleanText(raw.source) || null,
  }
  const technicalIndicators = {
    ...numberMap(rawTechnicalIndicators),
    closeAboveMa20Pct: base.closeAboveMa20Pct ?? null,
    closeAboveMa60Pct: base.closeAboveMa60Pct ?? null,
    volumeExpansion20: base.volumeExpansion20 ?? null,
    ma10Bias: base.ma10Bias ?? null,
    return5d: base.return5d ?? null,
    return20d: base.return20d ?? null,
    return60d: base.return60d ?? null,
    vwapBias: base.vwapBias ?? null,
    vwap_5d: base.vwap5d ?? null,
    vwapBias5d: base.vwapBias5d ?? null,
    vwap_bias: base.vwapBias ?? null,
    vwap_bias_5d: base.vwapBias5d ?? null,
  }
  const factorSignals = {
    ...numberMap(rawFactorSignals),
    foreignTrustNet5d: base.foreignTrustNet5d ?? null,
    brokerNetShares5d: base.brokerNetShares5d ?? null,
    brokerNetAmount5d: base.brokerNetAmount5d ?? null,
    ma10_bias: base.ma10Bias ?? null,
    ma10Bias: base.ma10Bias ?? null,
    return_5d: base.return5d ?? null,
    return5d: base.return5d ?? null,
    vwap_bias: base.vwapBias ?? null,
    vwap_5d: base.vwap5d ?? null,
    vwap_bias_5d: base.vwapBias5d ?? null,
    vwapBias: base.vwapBias ?? null,
    vwap5d: base.vwap5d ?? null,
    vwapBias5d: base.vwapBias5d ?? null,
    margin_balance: base.marginBalance ?? null,
    marginBalance: base.marginBalance ?? null,
    short_balance: base.shortBalance ?? null,
    shortBalance: base.shortBalance ?? null,
    brokerCount: base.brokerCount ?? null,
    brokerConcentration: base.brokerConcentration ?? null,
    revenueGrowthYoY: base.revenueGrowthYoY ?? null,
    monthlyRevenueYoY: base.monthlyRevenueYoY ?? null,
    monthlyRevenueMoM: base.monthlyRevenueMoM ?? null,
    grossMargin: base.grossMargin ?? null,
    operatingMargin: base.operatingMargin ?? null,
    roe: base.roe ?? null,
    eps: base.eps ?? null,
    pe: base.pe ?? null,
    pb: base.pb ?? null,
    dividendYield: base.dividendYield ?? null,
  }
  return {
    ...base,
    technicalIndicators,
    factorSignals,
  }
}

export function deriveStrategyThresholdScores(candidate: StrategyCandidateInput): StrategyThresholdScores {
  const snapshot = readScoreV2Snapshot(scoreV2StorageRow(candidate))
  const record = parseRecord(candidate.score_v2)

  if (snapshot) {
    const canonicalFinal = finiteNumber(record?.finalScore)
    return {
      seedScore: canonicalFinal ?? snapshot.finalScore,
      chipFlow: snapshot.components.chipFlow,
      technicalStructure: snapshot.components.technicalStructure,
      momentumScore: seedComponentNumber(record, 'screenerMomentumSeed20')
        ?? snapshot.technicalBreakdown?.volumeConfirmation
        ?? 0,
      source: 'score_v2',
    }
  }

  return {
    seedScore: 0,
    chipFlow: 0,
    technicalStructure: 0,
    momentumScore: 0,
    source: 'missing_score_v2',
  }
}

function meetsMaximum(value: unknown, max: number | undefined): boolean {
  if (max == null) return true
  const n = finiteNumber(value)
  return n != null && n <= max
}

function meetsSignalMap(
  signals: Record<string, number | null> | undefined,
  minThresholds?: Record<string, number>,
  maxThresholds?: Record<string, number>,
): boolean {
  for (const [key, min] of Object.entries(minThresholds ?? {})) {
    if (!meetsMinimum(signals?.[key], min)) return false
  }
  for (const [key, max] of Object.entries(maxThresholds ?? {})) {
    if (!meetsMaximum(signals?.[key], max)) return false
  }
  return true
}

function signalValue(raw: StrategyRawSignals, signalPath: string): unknown {
  const path = cleanText(signalPath)
  if (!path) return null
  const aliases: Record<string, string> = {
    'technical.': 'technicalIndicators.',
    'factor.': 'factorSignals.',
    'factors.': 'factorSignals.',
  }
  const normalized = Object.entries(aliases).reduce(
    (current, [from, to]) => current.startsWith(from) ? `${to}${current.slice(from.length)}` : current,
    path,
  )
  const parts = normalized.split('.').filter(Boolean)
  let cursor: unknown = raw as Record<string, unknown>
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

function marginBalanceFeatureRefValue(raw: StrategyRawSignals): unknown {
  for (const signal of [
    'factorSignals.formal137MarginBalanceRank',
    'factorSignals.margin_balance_rank',
    'factorSignals.marginBalanceRank',
    'factorSignals.margin_balance_normalized',
    'factorSignals.finlabCsMarginBalanceRank',
  ]) {
    const value = signalValue(raw, signal)
    if (finiteNumber(value) != null) return value
  }
  return null
}

function usSentimentScoreFeatureRefValue(raw: StrategyRawSignals): unknown {
  for (const signal of [
    'factorSignals.formal137UsSentimentScoreRank',
    'factorSignals.us_sentiment_score_rank',
    'factorSignals.usSentimentScoreRank',
    'factorSignals.us_sentiment_score_normalized',
  ]) {
    const value = signalValue(raw, signal)
    if (finiteNumber(value) != null) return value
  }
  return null
}

function featureRefValue(raw: StrategyRawSignals, term: StrategyFeatureRefTerm): unknown {
  const featureRef = cleanText(term.featureRef)
  if (featureRef === 'margin_balance') return marginBalanceFeatureRefValue(raw)
  if (featureRef === 'us_sentiment_score') return usSentimentScoreFeatureRefValue(raw)

  const explicitSignal = cleanText(term.signal)
  if (explicitSignal) return signalValue(raw, explicitSignal)

  if (!featureRef) return null
  const direct = signalValue(raw, featureRef)
  if (finiteNumber(direct) != null) return direct
  const factorDirect = raw.factorSignals?.[featureRef]
  if (finiteNumber(factorDirect) != null) return factorDirect
  const technicalDirect = raw.technicalIndicators?.[featureRef]
  if (finiteNumber(technicalDirect) != null) return technicalDirect

  const aliases: Record<string, string[]> = {
    l1_closeAboveMa60Pct: ['factorSignals.finlabCsCloseAboveMa60PctRank', 'closeAboveMa60Pct', 'technicalIndicators.closeAboveMa60Pct', 'factorSignals.closeAboveMa60Pct'],
    l1_volumeExpansion20: ['factorSignals.finlabCsVolumeExpansion20Rank', 'volumeExpansion20', 'technicalIndicators.volumeExpansion20', 'factorSignals.volumeExpansion20'],
    l1_return20d: ['factorSignals.finlabCsReturn20dRank', 'return20d', 'technicalIndicators.return20d', 'factorSignals.return20d'],
    l1_return5d: ['return5d', 'technicalIndicators.return5d', 'factorSignals.return5d', 'factorSignals.return_5d'],
    l1_monthlyRevenueMoM: ['factorSignals.finlabCsMonthlyRevenueMoMRank', 'monthlyRevenueMoM', 'factorSignals.monthlyRevenueMoM'],
    l1_monthlyRevenueYoY: ['factorSignals.finlabCsMonthlyRevenueYoYRank', 'monthlyRevenueYoY', 'factorSignals.monthlyRevenueYoY'],
    l1_revenueGrowthYoY: ['revenueGrowthYoY', 'factorSignals.revenueGrowthYoY'],
    l1_roe: ['roe', 'factorSignals.roe'],
    l1_eps: ['eps', 'factorSignals.eps'],
    l1_brokerNetAmount5d: ['factorSignals.finlabCsBrokerNetAmount5dRank', 'factorSignals.l1_brokerNetAmount5d', 'brokerNetAmount5d', 'factorSignals.brokerNetAmount5d'],
    l1_brokerCount: ['brokerCount', 'factorSignals.brokerCount'],
    l1_brokerConcentration: ['brokerConcentration', 'factorSignals.brokerConcentration'],
    tech_sma_20_pos: ['closeAboveMa20Pct', 'technicalIndicators.closeAboveMa20Pct', 'factorSignals.closeAboveMa20Pct'],
    tech_adx_14: ['technicalIndicators.adx14'],
    tech_emv_14: ['factorSignals.finlabCsTechEmv14Rank', 'technicalIndicators.tech_emv_14', 'factorSignals.tech_emv_14'],
    tech_roc_10: ['factorSignals.finlabCsTechRoc10Rank', 'technicalIndicators.tech_roc_10', 'factorSignals.tech_roc_10'],
    tech_gap_down: ['factorSignals.finlabCsTechGapDownRank', 'technicalIndicators.tech_gap_down', 'factorSignals.tech_gap_down'],
    vola_cv_90d: ['factorSignals.finlabCsVolaCv90dLowRank', 'technicalIndicators.vola_cv_90d', 'factorSignals.vola_cv_90d'],
    mom_rsi_14: ['technicalIndicators.rsi14', 'factorSignals.rsi14'],
    VSTD_10: ['factorSignals.finlabCsVstd10Rank', 'technicalIndicators.VSTD_10', 'factorSignals.VSTD_10'],
    l1_macdHist: ['technicalIndicators.macdHist'],
    l1_diTrend: ['technicalIndicators.diTrend'],
    l1_squeezeRelease: ['technicalIndicators.squeezeRelease'],
    l1_squeezeMomentum: ['technicalIndicators.squeezeMomentum'],
    l1_bbBandwidthPct: ['factorSignals.finlabCsBbBandwidthPctRank', 'technicalIndicators.bbBandwidthPct'],
    l1_bestOrderBlockStrength: ['factorSignals.finlabCsBestOrderBlockStrengthRank', 'technicalIndicators.bestOrderBlockStrength'],
    l1_smcBullishScore: ['factorSignals.finlabCsSmcBullishScoreRank', 'technicalIndicators.smcBullishScore', 'factorSignals.smcBullishScore'],
    l1_smcNetScore: ['factorSignals.finlabCsSmcNetScoreRank', 'technicalIndicators.smcNetScore', 'factorSignals.smcNetScore'],
    vwap_bias: ['factorSignals.finlabCsVwapBiasRank', 'factorSignals.vwap_bias', 'technicalIndicators.vwap_bias', 'vwapBias'],
    vwap_5d: ['factorSignals.vwap_5d', 'technicalIndicators.vwap_5d', 'vwap5d'],
    vwap_bias_5d: ['factorSignals.finlabCsVwapBias5dRank', 'factorSignals.vwap_bias_5d', 'technicalIndicators.vwap_bias_5d', 'vwapBias5d'],
    vol_share_turnover_21d: ['factorSignals.finlabCsVolShareTurnover21dRank', 'factorSignals.vol_share_turnover_21d', 'factorSignals.volShareTurnover21d'],
    val_ep: ['pe', 'factorSignals.pe'],
    val_bp: ['pb', 'factorSignals.pb'],
    val_dp: ['dividendYield', 'factorSignals.dividendYield'],
    finlab701_fundamental_features_EBITDA: ['factorSignals.finlabCsEbitdaRank', 'factorSignals.ebitda'],
    finlab701_financial_statement_流動負債: ['factorSignals.finlabCsCurrentLiabilitiesRank', 'factorSignals.currentLiabilities'],
    finlab701_fundamental_features_每股現金流量: ['factorSignals.finlabCsCashFlowPerShareRank', 'factorSignals.cashFlowPerShare'],
    finlab701_financial_statement_不動產廠房及設備: ['factorSignals.finlabCsPropertyPlantEquipmentRank', 'factorSignals.propertyPlantEquipment'],
    finlab701_financial_statement_營業費用: ['factorSignals.finlabCsOperatingExpensesRank', 'factorSignals.operatingExpenses'],
    finlab701_fundamental_features_每股稅前淨利: ['factorSignals.finlabCsPretaxIncomePerShareRank', 'factorSignals.pretaxIncomePerShare'],
    finlab701_financial_statement_營業活動之淨現金流入_流出: ['factorSignals.finlabCsOperatingCashFlowStatementRank', 'factorSignals.operatingCashFlowStatement'],
    finlab701_fundamental_features_營運資金: ['factorSignals.finlabCsWorkingCapitalRank', 'factorSignals.workingCapital'],
    finlab701_fundamental_features_自由現金流量: ['factorSignals.finlabCsFreeCashFlowRank', 'factorSignals.freeCashFlow'],
    finlab701_financial_statement_財務成本: ['factorSignals.finlabCsFinancialCostRank', 'factorSignals.financialCost'],
    finlab701_financial_statement_非流動資產: ['factorSignals.finlabCsNonCurrentAssetsRank', 'factorSignals.nonCurrentAssets'],
    finlab701_financial_statement_本期現金及約當現金增加_減少_數: ['factorSignals.finlabCsCashAndCashEquivalentsIncreaseDecreaseRank', 'factorSignals.cashAndCashEquivalentsIncreaseDecrease'],
    finlab701_financial_statement_其他應付款: ['factorSignals.finlabCsOtherPayablesRank', 'factorSignals.otherPayables'],
    KLOW2: ['factorSignals.finlabCsKlow2LowRank', 'factorSignals.KLOW2', 'technicalIndicators.KLOW2'],
    KSFT: ['factorSignals.finlabCsKsftLowRank', 'factorSignals.KSFT', 'technicalIndicators.KSFT'],
    KSFT2: ['factorSignals.KSFT2', 'technicalIndicators.KSFT2'],
    CNTD_20: ['factorSignals.CNTD_20', 'technicalIndicators.CNTD_20'],
    CNTN_20: ['factorSignals.CNTN_20', 'technicalIndicators.CNTN_20'],
    ma10_bias: ['ma10Bias', 'factorSignals.ma10_bias', 'factorSignals.ma10Bias', 'technicalIndicators.ma10Bias'],
    return_5d: ['return5d', 'factorSignals.return_5d', 'factorSignals.return5d', 'technicalIndicators.return5d'],
    advance_ratio: ['factorSignals.advance_ratio', 'factorSignals.advanceRatio'],
  }
  for (const alias of aliases[featureRef] ?? []) {
    const value = signalValue(raw, alias)
    if (finiteNumber(value) != null) return value
  }
  return null
}

function featureRefLabel(term: StrategyFeatureRefTerm): string {
  return cleanText(term.featureRef) || cleanText(term.signal) || 'unknown'
}

function missingRequiredFeatureRefs(raw: StrategyRawSignals, dsl?: StrategyFeatureRefDsl): string[] {
  if (!dsl) return []
  const missing: string[] = []
  for (const term of dsl.all ?? []) {
    if (finiteNumber(featureRefValue(raw, term)) == null) missing.push(featureRefLabel(term))
  }
  for (const term of dsl.weightedScore?.terms ?? []) {
    const weight = finiteNumber(term.weight) ?? 1
    if (weight <= 0) continue
    if (finiteNumber(featureRefValue(raw, term)) == null) missing.push(featureRefLabel(term))
  }
  return [...new Set(missing)]
}

function signalPresent(value: unknown): boolean {
  if (value == null || value === '') return false
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  return cleanText(value).length > 0
}

function missingRequiredSignalRefs(raw: StrategyRawSignals, dsl?: StrategySignalDsl): string[] {
  if (!dsl) return []
  const missing = new Set<string>()
  for (const condition of [...(dsl.all ?? []), ...(dsl.not ?? [])]) {
    if (!signalPresent(signalValue(raw, condition.signal))) missing.add(cleanText(condition.signal) || 'unknown')
  }
  const any = dsl.any ?? []
  if (any.length && !any.some((condition) => signalPresent(signalValue(raw, condition.signal)))) {
    for (const condition of any) missing.add(cleanText(condition.signal) || 'unknown')
  }
  return [...missing]
}

export function explainSignalDsl(raw: StrategyRawSignals, dsl?: StrategySignalDsl): Record<string, unknown> | null {
  if (!dsl) return null
  const missing = missingRequiredSignalRefs(raw, dsl)
  return {
    evaluable: missing.length === 0,
    missing_required_signal_refs: missing,
  }
}
export interface StrategyEvaluabilityDiagnostics {
  evaluable: boolean
  unavailable_reason: string | null
  invalid_spec_errors: string[]
  missing_required_threshold_refs: string[]
  missing_required_signal_refs: string[]
  missing_required_feature_refs: string[]
}

function missingRequiredThresholdRefs(
  candidate: StrategyCandidateInput,
  raw: StrategyRawSignals,
  thresholds: StrategySpecThresholds,
): string[] {
  const missing = new Set<string>()
  const requireSignal = (enabled: boolean, path: string, value: unknown) => {
    if (enabled && !signalPresent(value)) missing.add(path)
  }
  const enabled = (value: unknown) => value != null
  const scores = deriveStrategyThresholdScores(candidate)
  requireSignal(enabled(thresholds.minSeedScore), 'score_v2.seedScore', scores.source === 'score_v2' ? scores.seedScore : null)
  requireSignal(enabled(thresholds.minChipScore), 'score_v2.chipFlow', scores.source === 'score_v2' ? scores.chipFlow : null)
  requireSignal(enabled(thresholds.minTechScore), 'score_v2.technicalStructure', scores.source === 'score_v2' ? scores.technicalStructure : null)
  requireSignal(enabled(thresholds.minMomentumScore), 'score_v2.momentumScore', scores.source === 'score_v2' ? scores.momentumScore : null)

  const price = finiteNumber(candidate.current_price) ?? finiteNumber(raw.close)
  requireSignal(enabled(thresholds.minPrice) || enabled(thresholds.maxPrice), 'close', price)
  const scalarSignals: Array<[unknown, string, unknown]> = [
    [thresholds.minCloseAboveMa20Pct ?? thresholds.maxCloseAboveMa20Pct, 'closeAboveMa20Pct', raw.closeAboveMa20Pct],
    [thresholds.minCloseAboveMa60Pct ?? thresholds.maxCloseAboveMa60Pct, 'closeAboveMa60Pct', raw.closeAboveMa60Pct],
    [thresholds.minVolumeExpansion20, 'volumeExpansion20', raw.volumeExpansion20],
    [thresholds.minReturn20d ?? thresholds.maxReturn20d, 'return20d', raw.return20d],
    [thresholds.minForeignTrustNet5d, 'foreignTrustNet5d', raw.foreignTrustNet5d],
    [thresholds.minDealerNet5d, 'dealerNet5d', raw.dealerNet5d],
    [thresholds.minBrokerNetShares5d, 'brokerNetShares5d', raw.brokerNetShares5d],
    [thresholds.minBrokerNetAmount5d, 'brokerNetAmount5d', raw.brokerNetAmount5d],
    [thresholds.minBrokerCount, 'brokerCount', raw.brokerCount],
    [thresholds.maxBrokerConcentration, 'brokerConcentration', raw.brokerConcentration],
    [thresholds.minRevenueGrowthYoY, 'revenueGrowthYoY', raw.revenueGrowthYoY],
    [thresholds.minMonthlyRevenueYoY, 'monthlyRevenueYoY', raw.monthlyRevenueYoY],
    [thresholds.minMonthlyRevenueMoM, 'monthlyRevenueMoM', raw.monthlyRevenueMoM],
    [thresholds.minGrossMargin, 'grossMargin', raw.grossMargin],
    [thresholds.minOperatingMargin, 'operatingMargin', raw.operatingMargin],
    [thresholds.minRoe, 'roe', raw.roe],
    [thresholds.minEps, 'eps', raw.eps],
    [thresholds.maxPe, 'pe', raw.pe],
    [thresholds.maxPb, 'pb', raw.pb],
  ]
  for (const [threshold, path, value] of scalarSignals) requireSignal(enabled(threshold), path, value)

  const technicalKeys = new Set([
    ...Object.keys(thresholds.minTechnicalIndicators ?? {}),
    ...Object.keys(thresholds.maxTechnicalIndicators ?? {}),
  ])
  for (const key of technicalKeys) {
    requireSignal(true, `technicalIndicators.${key}`, raw.technicalIndicators?.[key])
  }
  const factorKeys = new Set([
    ...Object.keys(thresholds.minFactorSignals ?? {}),
    ...Object.keys(thresholds.maxFactorSignals ?? {}),
  ])
  for (const key of factorKeys) {
    requireSignal(true, `factorSignals.${key}`, raw.factorSignals?.[key])
  }
  if ((thresholds.includeIndustries?.length || thresholds.excludeIndustries?.length) && !cleanText(candidate.industry ?? candidate.sector)) {
    missing.add('industry')
  }
  return [...missing]
}

export function explainStrategyEvaluability(
  candidate: StrategyCandidateInput,
  spec: StrategySpec,
): StrategyEvaluabilityDiagnostics {
  const validation = validateStrategySpec(spec)
  const raw = deriveStrategyRawSignals(candidate)
  const signalDiagnostics = explainSignalDsl(raw, spec.thresholds.dsl)
  const featureDiagnostics = explainFeatureRefDsl(raw, spec.thresholds.featureRefs)
  const missingThresholds = missingRequiredThresholdRefs(candidate, raw, spec.thresholds)
  const missingSignals = Array.isArray(signalDiagnostics?.missing_required_signal_refs)
    ? signalDiagnostics.missing_required_signal_refs.map(String)
    : []
  const missingFeatures = Array.isArray(featureDiagnostics?.missing_required_feature_refs)
    ? featureDiagnostics.missing_required_feature_refs.map(String)
    : []
  const evaluable = validation.ok
    && missingThresholds.length === 0
    && missingSignals.length === 0
    && missingFeatures.length === 0
  const unavailableReason = !validation.ok
    ? `strategy_spec_invalid:${validation.errors.join('|')}`
    : missingThresholds.length
      ? `missing_required_thresholds:${missingThresholds.join('|')}`
      : missingSignals.length
        ? `missing_required_signals:${missingSignals.join('|')}`
        : missingFeatures.length
          ? `missing_required_features:${missingFeatures.join('|')}`
          : null
  return {
    evaluable,
    unavailable_reason: unavailableReason,
    invalid_spec_errors: validation.errors,
    missing_required_threshold_refs: missingThresholds,
    missing_required_signal_refs: missingSignals,
    missing_required_feature_refs: missingFeatures,
  }
}

function activeWeightedScoreCalibration(
  weighted: StrategyFeatureRefWeightedScore,
): StrategyFeatureRefWeightedScoreCalibration | null {
  const calibration = weighted.calibration
  if (!calibration || calibration.status !== 'active') return null
  if (calibration.schemaVersion !== 'strategy-feature-ref-weighted-score-calibration-v1') return null
  const calibratedMin = finiteNumber(calibration.calibratedMin)
  if (calibratedMin == null || calibratedMin < 0 || calibratedMin > 1) return null
  return calibration
}

function effectiveWeightedScoreMin(weighted: StrategyFeatureRefWeightedScore): {
  min: number
  source: 'spec_min' | 'active_calibration' | 'adaptive_strategy_policy'
  calibration: StrategyFeatureRefWeightedScoreCalibration | null
} {
  const calibration = activeWeightedScoreCalibration(weighted)
  const adaptivePolicy = weighted.adaptivePolicy
  const adaptiveMin = finiteNumber(adaptivePolicy?.effectiveMin)
  if (
    adaptivePolicy
    && cleanText(adaptivePolicy.policyId)
    && cleanText(adaptivePolicy.knowledgeCutoffDate)
    && adaptiveMin != null
    && adaptiveMin >= 0
    && adaptiveMin <= 1
  ) {
    return { min: adaptiveMin, source: 'adaptive_strategy_policy', calibration }
  }
  if (calibration) {
    return {
      min: calibration.calibratedMin,
      source: 'active_calibration',
      calibration,
    }
  }
  return {
    min: weighted.min,
    source: 'spec_min',
    calibration: null,
  }
}

export function explainFeatureRefDsl(raw: StrategyRawSignals, dsl?: StrategyFeatureRefDsl): Record<string, unknown> | null {
  if (!dsl) return null
  const weighted = dsl.weightedScore
  if (!weighted) {
    return {
      missing_required_feature_refs: missingRequiredFeatureRefs(raw, dsl),
    }
  }
  let score = 0
  let weightSum = 0
  const terms: Array<Record<string, unknown>> = []
  for (const term of weighted.terms ?? []) {
    const value = finiteNumber(featureRefValue(raw, term))
    const weight = finiteNumber(term.weight) ?? 1
    if (weight <= 0) continue
    if (value != null) {
      score += value * weight
      weightSum += weight
    }
    terms.push({
      feature_ref: featureRefLabel(term),
      signal: cleanText(term.signal) || null,
      weight,
      value,
      present: value != null,
    })
  }
  const effective = effectiveWeightedScoreMin(weighted)
  const weightedScore = weightSum > 0 ? score / weightSum : null
  return {
    weighted_score: weightedScore == null ? null : Math.round(weightedScore * 1_000_000) / 1_000_000,
    spec_min: weighted.min,
    effective_min: effective.min,
    threshold_source: effective.source,
    adaptive_policy_id: weighted.adaptivePolicy?.policyId ?? null,
    adaptive_policy_version: weighted.adaptivePolicy?.policyVersion ?? null,
    adaptive_knowledge_cutoff_date: weighted.adaptivePolicy?.knowledgeCutoffDate ?? null,
    adaptive_baseline_min: weighted.adaptivePolicy?.baselineMin ?? null,
    calibration_id: effective.calibration?.calibrationId ?? null,
    calibration_status: effective.calibration?.status ?? null,
    passes_weighted_score: weightedScore == null ? false : weightedScore >= effective.min,
    terms,
    missing_required_feature_refs: missingRequiredFeatureRefs(raw, dsl),
  }
}

type StrategyComparisonCondition = Pick<StrategySignalCondition, 'op' | 'value'>

function compareSignal(rawValue: unknown, condition: StrategyComparisonCondition): boolean {
  if (rawValue == null || rawValue === '') return false
  const op = condition.op
  const expected = condition.value
  if (typeof expected === 'number') {
    const actual = finiteNumber(rawValue)
    if (actual == null) return false
    if (op === '>=') return actual >= expected
    if (op === '>') return actual > expected
    if (op === '<=') return actual <= expected
    if (op === '<') return actual < expected
    if (op === '==') return actual === expected
    if (op === '!=') return actual !== expected
    return false
  }
  if (typeof expected === 'boolean') {
    const actual = Boolean(finiteNumber(rawValue) ?? rawValue)
    if (op === '==') return actual === expected
    if (op === '!=') return actual !== expected
    return false
  }
  const actualText = cleanText(rawValue)
  const expectedText = cleanText(expected)
  if (op === '==') return actualText === expectedText
  if (op === '!=') return actualText !== expectedText
  return false
}

function meetsSignalDsl(raw: StrategyRawSignals, dsl?: StrategySignalDsl): boolean {
  if (!dsl) return true
  if (missingRequiredSignalRefs(raw, dsl).length) return false
  const all = dsl.all ?? []
  const any = dsl.any ?? []
  const not = dsl.not ?? []
  if (all.some((condition) => !compareSignal(signalValue(raw, condition.signal), condition))) return false
  if (any.length && !any.some((condition) => compareSignal(signalValue(raw, condition.signal), condition))) return false
  if (not.some((condition) => compareSignal(signalValue(raw, condition.signal), condition))) return false
  return true
}

function meetsFeatureRefDsl(raw: StrategyRawSignals, dsl?: StrategyFeatureRefDsl): boolean {
  if (!dsl) return true
  const all = dsl.all ?? []
  const any = dsl.any ?? []
  const not = dsl.not ?? []
  if (all.some((condition) => !compareSignal(featureRefValue(raw, condition), condition))) return false
  if (any.length && !any.some((condition) => compareSignal(featureRefValue(raw, condition), condition))) return false
  if (not.some((condition) => compareSignal(featureRefValue(raw, condition), condition))) return false

  const weighted = dsl.weightedScore
  if (weighted) {
    let score = 0
    let weightSum = 0
    for (const term of weighted.terms ?? []) {
      const value = finiteNumber(featureRefValue(raw, term))
      const weight = finiteNumber(term.weight) ?? 1
      if (weight <= 0) continue
      if (value == null) return false
      score += value * weight
      weightSum += weight
    }
    if (weightSum <= 0) return false
    if ((score / weightSum) < effectiveWeightedScoreMin(weighted).min) return false
  }
  return true
}

function meetsRawSignalThresholds(raw: StrategyRawSignals, thresholds: StrategySpecThresholds): boolean {
  const minChecks: Array<[unknown, number | undefined]> = [
    [raw.closeAboveMa20Pct, thresholds.minCloseAboveMa20Pct],
    [raw.closeAboveMa60Pct, thresholds.minCloseAboveMa60Pct],
    [raw.volumeExpansion20, thresholds.minVolumeExpansion20],
    [raw.return20d, thresholds.minReturn20d],
    [raw.foreignTrustNet5d, thresholds.minForeignTrustNet5d],
    [raw.dealerNet5d, thresholds.minDealerNet5d],
    [raw.brokerNetShares5d, thresholds.minBrokerNetShares5d],
    [raw.brokerNetAmount5d, thresholds.minBrokerNetAmount5d],
    [raw.brokerCount, thresholds.minBrokerCount],
    [raw.revenueGrowthYoY, thresholds.minRevenueGrowthYoY],
    [raw.monthlyRevenueYoY, thresholds.minMonthlyRevenueYoY],
    [raw.monthlyRevenueMoM, thresholds.minMonthlyRevenueMoM],
    [raw.grossMargin, thresholds.minGrossMargin],
    [raw.operatingMargin, thresholds.minOperatingMargin],
    [raw.roe, thresholds.minRoe],
    [raw.eps, thresholds.minEps],
  ]
  const maxChecks: Array<[unknown, number | undefined]> = [
    [raw.closeAboveMa20Pct, thresholds.maxCloseAboveMa20Pct],
    [raw.closeAboveMa60Pct, thresholds.maxCloseAboveMa60Pct],
    [raw.return20d, thresholds.maxReturn20d],
    [raw.brokerConcentration, thresholds.maxBrokerConcentration],
    [raw.pe, thresholds.maxPe],
    [raw.pb, thresholds.maxPb],
  ]
  return minChecks.every(([value, min]) => meetsMinimum(value, min))
    && maxChecks.every(([value, max]) => meetsMaximum(value, max))
    && meetsSignalMap(raw.technicalIndicators, thresholds.minTechnicalIndicators, thresholds.maxTechnicalIndicators)
    && meetsSignalMap(raw.factorSignals, thresholds.minFactorSignals, thresholds.maxFactorSignals)
    && meetsSignalDsl(raw, thresholds.dsl)
    && meetsFeatureRefDsl(raw, thresholds.featureRefs)
}

export function assessCandidateAgainstStrategySpecs(
  candidate: StrategyCandidateInput,
  specs: StrategySpec[],
): StrategySpecAssessment {
  const matches: StrategySpecMatch[] = []
  const watchPoints: string[] = []
  const scores = deriveStrategyThresholdScores(candidate)
  const raw = deriveStrategyRawSignals(candidate)

  for (const spec of specs) {
    const validation = validateStrategySpec(spec)
    if (!validation.ok) {
      watchPoints.push(`strategy_spec_invalid:${spec.id || 'unknown'}:${validation.errors.join(',')}`)
      continue
    }
    const t = spec.thresholds
    if (!industryAllowed(candidate, t)) continue
    if (!meetsPrice(candidate, t)) continue
    if (!meetsMinimum(scores.seedScore, t.minSeedScore)) continue
    if (!meetsMinimum(scores.chipFlow, t.minChipScore)) continue
    if (!meetsMinimum(scores.technicalStructure, t.minTechScore)) continue
    if (!meetsMinimum(scores.momentumScore, t.minMomentumScore)) continue
    const missingSignalRefs = missingRequiredSignalRefs(raw, t.dsl)
    if (missingSignalRefs.length) {
      watchPoints.push('strategy_spec_missing_required_signal_refs:' + spec.id + ':' + missingSignalRefs.join('|'))
      continue
    }
    const missingFeatureRefs = missingRequiredFeatureRefs(raw, t.featureRefs)
    if (missingFeatureRefs.length) {
      watchPoints.push(`strategy_spec_missing_required_feature_refs:${spec.id}:${missingFeatureRefs.join('|')}`)
      continue
    }
    if (!meetsRawSignalThresholds(raw, t)) continue

    matches.push({
      specId: spec.id,
      alphaBucket: spec.alphaBucket,
      status: spec.status,
      label: spec.name,
      reason: spec.thesis,
    })
  }

  const tags = [...new Set(matches.map((m) => `strategy:${m.alphaBucket}`))]
  if (!matches.length) watchPoints.push('strategy_spec:no_match')
  return { matches, tags, watchPoints }
}

const DEFAULT_STRATEGY_SPEC_DRAFTS: StrategySpec[] = [
  {
    id: 'trend_following_seed_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Trend following seed',
    status: 'active',
    owner: 'strategy',
    familyId: 'TREND_RECLAIM_CONTINUATION',
    variantId: 'ma_macd_adx_reclaim_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'trend_following',
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    thesis: 'Select stocks with durable price structure and trend continuation evidence before ML ranking.',
    thresholds: {
      minPrice: 10,
      minCloseAboveMa20Pct: 0,
      minCloseAboveMa60Pct: -0.02,
      minVolumeExpansion20: 0.9,
      minReturn20d: 0,
      dsl: {
        any: [
          { signal: 'technicalIndicators.macdHist', op: '>=', value: 0 },
          { signal: 'technicalIndicators.adx14', op: '>=', value: 18 },
          { signal: 'technicalIndicators.diTrend', op: '>=', value: 0 },
        ],
      },
    },
    candidatePolicy: { poolQuota: 14, costBudget: 18, evidenceRequirements: ['raw_price_structure', 'raw_volume', 'raw_momentum'], maxMlShare: 0.24 },
    riskNotes: ['Production seed retained because realized overlap stayed below the production merge threshold.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'breakout_vol_expansion_seed_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Breakout volume expansion seed',
    status: 'active',
    owner: 'strategy',
    familyId: 'VOLATILITY_CONTRACTION_BREAKOUT',
    variantId: 'bb_vcp_squeeze_release_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'breakout_vol_expansion',
    supportedRegimes: ['bull', 'volatile'],
    thesis: 'Select price bases that show volume-confirmed breakout pressure before heavy ML ranking.',
    thresholds: {
      minPrice: 10,
      minCloseAboveMa20Pct: 0.01,
      minCloseAboveMa60Pct: 0,
      minVolumeExpansion20: 1.2,
      minReturn20d: 0,
      dsl: {
        any: [
          { signal: 'technicalIndicators.squeezeRelease', op: '>=', value: 1 },
          { signal: 'technicalIndicators.squeezeMomentum', op: '>=', value: 0.2 },
          { signal: 'technicalIndicators.bbBandwidthPct', op: '<=', value: 0.12 },
        ],
      },
    },
    candidatePolicy: { poolQuota: 12, costBudget: 16, evidenceRequirements: ['raw_price_structure', 'raw_volume', 'raw_breakout'], maxMlShare: 0.22 },
    riskNotes: ['Retained as the low-overlap breakout owner; L2/L3 and sparse allocation reject false breakouts.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'alpha_miner_pymoo_nsga3_novelty_0081',
    version: STRATEGY_SPEC_VERSION,
    name: 'Pymoo NSGA-III novelty 0081 breadth trend impulse',
    status: 'active',
    owner: 'strategy',
    familyId: 'TREND_RECLAIM_CONTINUATION',
    variantId: 'pymoo_nsga3_novelty_0081_formal137_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'trend_following',
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    thesis: 'Combine breadth, trend and price-impulse formal137 signals discovered by Pymoo NSGA-III while preserving full-universe L0 labeling.',
    thresholds: {
      minPrice: 10,
      minVolumeExpansion20: 0.7,
      featureRefs: {
        weightedScore: {
          min: 0.62,
          terms: [
            { featureRef: 'KLOW2', signal: 'factorSignals.KLOW2', weight: 0.415128 },
            { featureRef: 'advance_ratio', signal: 'factorSignals.advance_ratio', weight: 0.117772 },
            { featureRef: 'CNTD_20', signal: 'factorSignals.CNTD_20', weight: 0.20684 },
            { featureRef: 'KSFT', signal: 'factorSignals.KSFT', weight: 0.260259 },
          ],
          calibration: {
            schemaVersion: 'strategy-feature-ref-weighted-score-calibration-v1',
            calibrationId: 'alpha_miner_pymoo_nsga3_novelty_0081:formal137-scale:v20260622',
            status: 'active',
            method: 'validation_fold_top_after_base_gates',
            originalMin: 0.62,
            calibratedMin: 0.382732,
            validationFold: { startDate: '2026-06-22', endDate: '2026-06-22', excludedDates: ['2026-06-23'] },
            targetDailyMatches: 16,
            observed: {
              validationRows: 820,
              validationCompleteFeatureRows: 820,
              validationMatchesAtOriginalMin: 0,
              validationMatchesAtCalibratedMin: 16,
              holdoutDate: '2026-06-23',
              holdoutMatchesAtCalibratedMin: 11,
            },
            sourceRefs: ['strategy_decision_log:2026-06-22', 'holdout:2026-06-23'],
            frozenAt: '2026-06-24T00:00:00Z',
          },
        },
      },
    },
    candidatePolicy: { poolQuota: 16, costBudget: 18, evidenceRequirements: ['formal137_feature_refs', 'raw_breadth', 'raw_trend', 'raw_impulse'], maxMlShare: 0.22 },
    riskNotes: [
      'Promoted in the 2026-08-05 equal-count rotation from S04 based on reconstructed reward-ledger evidence; historical 2026-06-25 FinLab replay was negative and remains contrary evidence.',
      'Adaptive policy may only adjust the effective weighted-score threshold within bounded PIT rules; the original calibration lineage remains immutable.',
    ],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'defensive_accumulation_seed_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Defensive accumulation seed',
    status: 'active',
    owner: 'strategy',
    familyId: 'SMART_MONEY_ACCUMULATION',
    variantId: 'institutional_accumulation_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'defensive_accumulation',
    supportedRegimes: ['bull', 'sideways', 'bear', 'volatile'],
    thesis: 'Select stocks with constructive chip flow and tolerable technical structure for defensive accumulation.',
    thresholds: {
      minPrice: 10,
      minCloseAboveMa20Pct: -0.08,
      minVolumeExpansion20: 0.75,
      minForeignTrustNet5d: 0,
    },
    candidatePolicy: { poolQuota: 16, costBudget: 20, evidenceRequirements: ['raw_price_structure', 'raw_chip_flow', 'raw_broker_flow'], maxMlShare: 0.24 },
    riskNotes: ['Retained as the defensive chip-flow owner; L1.25 down-weights stale or crowded accumulation.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_quality_trend_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI quality trend',
    status: 'candidate',
    owner: 'strategy',
    familyId: 'REVENUE_QUALITY_MOMENTUM',
    variantId: 'quality_trend_revenue_profitability_v1',
    ownerType: 'strategy',
    promotionStatus: 'candidate',
    alphaBucket: 'trend_following',
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    thesis: 'Use FinLab raw fundamentals, revenue growth, price trend and volume evidence to admit quality-trend candidates into L1.',
    thresholds: {
      minPrice: 10,
      minCloseAboveMa20Pct: 0,
      minVolumeExpansion20: 0.9,
      minRevenueGrowthYoY: 0,
      minEps: 0,
      minRoe: 3,
      maxPe: 45,
    },
    candidatePolicy: { poolQuota: 16, costBudget: 18, evidenceRequirements: ['finlab_canonical_fundamental', 'raw_technical', 'raw_revenue', 'raw_profitability'], maxMlShare: 0.22 },
    riskNotes: ['Moved to candidate strategy pool after 2026-06-25 active-owner consolidation; monthly backtest can re-promote if evidence beats active owners.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_reversion_value_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI reversion value',
    status: 'active',
    owner: 'strategy',
    familyId: 'REVENUE_QUALITY_MOMENTUM',
    variantId: 'quality_value_reversion_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'mean_reversion',
    supportedRegimes: ['sideways', 'bear', 'volatile'],
    thesis: 'Use raw valuation, profitability and mild reversion evidence to admit neglected value-reversion candidates that improve L1 diversity.',
    thresholds: {
      minPrice: 10,
      minEps: 0,
      maxPe: 28,
      maxPb: 3,
      maxReturn20d: 0.08,
      minVolumeExpansion20: 0.75,
    },
    candidatePolicy: { poolQuota: 16, costBudget: 18, evidenceRequirements: ['finlab_canonical_fundamental', 'raw_valuation', 'raw_profitability', 'raw_reversion'], maxMlShare: 0.22 },
    riskNotes: [
      'Promoted in the 2026-08-05 equal-count rotation from S01 after positive reconstructed reward-ledger evidence.',
      'Value and reversion inputs remain PIT constrained; missing valuation evidence fails closed.',
    ],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_revenue_revision_breakout_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI revenue revision breakout',
    status: 'candidate',
    owner: 'strategy',
    familyId: 'REVENUE_QUALITY_MOMENTUM',
    variantId: 'revenue_revision_breakout_v1',
    ownerType: 'strategy',
    promotionStatus: 'candidate',
    alphaBucket: 'breakout_vol_expansion',
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    thesis: 'Use revenue revision factors plus raw price reclaim and volume confirmation to expand L1 beyond price-only candidates.',
    thresholds: {
      minPrice: 10,
      minCloseAboveMa20Pct: 0,
      minVolumeExpansion20: 1.0,
      minRevenueGrowthYoY: 3,
      minRoe: 5,
      minTechnicalIndicators: { rsi14: 45, volumeExpansion20: 1.05, closeAboveMa20Pct: 0 },
      maxTechnicalIndicators: { rsi14: 72 },
      minFactorSignals: { monthlyRevenueYoY: 8, monthlyRevenueMoM: 0, revenueGrowthYoY: 3 },
    },
    candidatePolicy: { poolQuota: 16, costBudget: 18, evidenceRequirements: ['raw_revenue_revision', 'raw_technical_indicator_mining', 'raw_volume'], maxMlShare: 0.2 },
    riskNotes: ['Moved to candidate strategy pool after 2026-06-25 active-owner consolidation; monthly backtest can re-promote if evidence beats active owners.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_broker_accumulation_reclaim_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI broker accumulation reclaim',
    status: 'active',
    owner: 'strategy',
    familyId: 'SMART_MONEY_ACCUMULATION',
    variantId: 'broker_accumulation_reclaim_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'defensive_accumulation',
    supportedRegimes: ['bull', 'sideways', 'bear', 'volatile'],
    thesis: 'Use broker participation persistence, low concentration and mild technical reclaim to admit accumulation names that broad scores may miss.',
    thresholds: {
      minPrice: 10,
      minVolumeExpansion20: 0.85,
      minBrokerNetAmount5d: 0,
      maxBrokerConcentration: 0.65,
      minTechnicalIndicators: { rsi14: 40 },
      maxTechnicalIndicators: { rsi14: 68 },
      minFactorSignals: { brokerNetAmount5d: 0 },
    },
    candidatePolicy: { poolQuota: 16, costBudget: 18, evidenceRequirements: ['raw_broker_flow', 'raw_technical_indicator_mining'], maxMlShare: 0.2 },
    riskNotes: ['Retained as the broker-flow variant; overlap is governed by L1.25 crowding and graph evidence.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'alphabuilders_multifactor_revenue_quality_momentum_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'AlphaBuilders multifactor revenue quality momentum',
    status: 'active',
    owner: 'strategy',
    familyId: 'REVENUE_QUALITY_MOMENTUM',
    variantId: 'monthly_revenue_price_confirmation_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'trend_following',
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    thesis: 'Use monthly revenue acceleration with price or volume confirmation as the retained AlphaBuilders fundamental momentum label.',
    thresholds: {
      minPrice: 10,
      minVolumeExpansion20: 0.7,
      minFactorSignals: { monthlyRevenueYoY: 0 },
      dsl: {
        any: [
          { signal: 'factorSignals.monthlyRevenueMoM', op: '>=', value: 0 },
          { signal: 'closeAboveMa20Pct', op: '>=', value: -0.02 },
          { signal: 'technicalIndicators.macdHist', op: '>=', value: 0 },
        ],
      },
    },
    candidatePolicy: { poolQuota: 18, costBudget: 20, evidenceRequirements: ['alphabuilderstw', 'raw_revenue_revision', 'raw_price_structure', 'raw_volume'], maxMlShare: 0.28 },
    riskNotes: ['Production AlphaBuilders label retained because adjacent AlphaBuilders labels overlapped current owners.'],
    createdBy: 'p5_strategy_governance',
  },
]

// Bootstrap seed only. Production runtime strategy source-of-truth is D1
// strategy_spec_registry via listStrategySpecsForLearning().
export const DEFAULT_STRATEGY_SPECS: StrategySpec[] = DEFAULT_STRATEGY_SPEC_DRAFTS.map(normalizeStrategySpecGovernance)
