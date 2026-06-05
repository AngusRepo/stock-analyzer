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

export interface StrategyRawSignals {
  close?: number | null
  ma20?: number | null
  ma60?: number | null
  closeAboveMa20Pct?: number | null
  closeAboveMa60Pct?: number | null
  volumeExpansion20?: number | null
  return20d?: number | null
  return60d?: number | null
  foreignNet5d?: number | null
  trustNet5d?: number | null
  dealerNet5d?: number | null
  foreignTrustNet5d?: number | null
  brokerNetShares5d?: number | null
  brokerNetAmount5d?: number | null
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
])

const STRATEGY_OWNER_TYPES = new Set<StrategyOwnerType>(['strategy', 'feature', 'observe', 'retired'])
const STRATEGY_PROMOTION_STATUSES = new Set<StrategyPromotionStatus>(['production', 'candidate', 'research', 'retired'])

function finiteNumber(value: unknown): number | null {
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
  const id = cleanText(spec.id)
  if (id === 'finlab_ai_skill_discovery_v1') return 'observe'
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
  const base: StrategyRawSignals = {
    close: finiteNumber(raw.close),
    ma20: finiteNumber(raw.ma20),
    ma60: finiteNumber(raw.ma60),
    closeAboveMa20Pct: finiteNumber(raw.closeAboveMa20Pct),
    closeAboveMa60Pct: finiteNumber(raw.closeAboveMa60Pct),
    volumeExpansion20: finiteNumber(raw.volumeExpansion20),
    return20d: finiteNumber(raw.return20d),
    return60d: finiteNumber(raw.return60d),
    foreignNet5d: finiteNumber(raw.foreignNet5d),
    trustNet5d: finiteNumber(raw.trustNet5d),
    dealerNet5d: finiteNumber(raw.dealerNet5d),
    foreignTrustNet5d: finiteNumber(raw.foreignTrustNet5d),
    brokerNetShares5d: finiteNumber(raw.brokerNetShares5d),
    brokerNetAmount5d: finiteNumber(raw.brokerNetAmount5d),
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
    ...numberMap(raw.technicalIndicators),
    closeAboveMa20Pct: base.closeAboveMa20Pct ?? null,
    closeAboveMa60Pct: base.closeAboveMa60Pct ?? null,
    volumeExpansion20: base.volumeExpansion20 ?? null,
    return20d: base.return20d ?? null,
    return60d: base.return60d ?? null,
  }
  const factorSignals = {
    ...numberMap(raw.factorSignals),
    foreignTrustNet5d: base.foreignTrustNet5d ?? null,
    brokerNetShares5d: base.brokerNetShares5d ?? null,
    brokerNetAmount5d: base.brokerNetAmount5d ?? null,
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

function compareSignal(rawValue: unknown, condition: StrategySignalCondition): boolean {
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
  const all = dsl.all ?? []
  const any = dsl.any ?? []
  const not = dsl.not ?? []
  if (all.some((condition) => !compareSignal(signalValue(raw, condition.signal), condition))) return false
  if (any.length && !any.some((condition) => compareSignal(signalValue(raw, condition.signal), condition))) return false
  if (not.some((condition) => compareSignal(signalValue(raw, condition.signal), condition))) return false
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
    candidatePolicy: { poolQuota: 14, costBudget: 18, evidenceRequirements: ['raw_price_structure', 'raw_volume', 'raw_momentum'] },
    riskNotes: ['Trend continuation can crowd quickly; allocation and execution gates remain the final owners.'],
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
    candidatePolicy: { poolQuota: 12, costBudget: 16, evidenceRequirements: ['raw_price_structure', 'raw_volume', 'raw_breakout'] },
    riskNotes: ['Breakout candidates need slippage and reversal checks at allocation time.'],
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
    candidatePolicy: { poolQuota: 16, costBudget: 20, evidenceRequirements: ['raw_price_structure', 'raw_chip_flow', 'raw_broker_flow'] },
    riskNotes: ['Accumulation can become stale; Kalman, Markov, and portfolio risk overlays decide final sizing.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_quality_trend_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI quality trend',
    status: 'active',
    owner: 'strategy',
    familyId: 'REVENUE_QUALITY_MOMENTUM',
    variantId: 'quality_trend_revenue_profitability_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
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
    candidatePolicy: {
      poolQuota: 18,
      costBudget: 18,
      evidenceRequirements: ['finlab_ai_skill', 'raw_technical', 'raw_revenue', 'raw_profitability'],
      maxMlShare: 0.22,
    },
    riskNotes: ['Temporary production strategy for breadth; future FinLab AI discoveries still enter research/discovery first.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_chip_accumulation_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI chip accumulation',
    status: 'active',
    owner: 'strategy',
    familyId: 'SMART_MONEY_ACCUMULATION',
    variantId: 'institutional_chip_accumulation_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'defensive_accumulation',
    supportedRegimes: ['bull', 'sideways', 'bear', 'volatile'],
    thesis: 'Use FinLab raw institution flow and broker concentration evidence to widen L1 with accumulation candidates that old high-score ranking misses.',
    thresholds: {
      minPrice: 10,
      minForeignTrustNet5d: 0,
    },
    candidatePolicy: {
      poolQuota: 18,
      costBudget: 18,
      evidenceRequirements: ['finlab_ai_skill', 'raw_chip_flow', 'raw_broker_flow'],
      maxMlShare: 0.22,
    },
    riskNotes: ['Active breadth strategy only; final position sizing remains owned by allocation and risk gates.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_volume_breakout_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI volume breakout',
    status: 'active',
    owner: 'strategy',
    familyId: 'VOLATILITY_CONTRACTION_BREAKOUT',
    variantId: 'volume_breakout_bb_squeeze_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'breakout_vol_expansion',
    supportedRegimes: ['bull', 'volatile'],
    thesis: 'Use raw price, moving-average and volume-expansion evidence to add breakout candidates before L2 coarse ML.',
    thresholds: {
      minPrice: 10,
      minCloseAboveMa20Pct: 0.01,
      minCloseAboveMa60Pct: 0,
      minVolumeExpansion20: 1.2,
      minReturn20d: 0,
      dsl: {
        any: [
          { signal: 'technicalIndicators.squeezeRelease', op: '>=', value: 1 },
          { signal: 'technicalIndicators.bbBandwidthPct', op: '<=', value: 0.14 },
          { signal: 'technicalIndicators.volumeMomentumDivergence132710', op: '>=', value: 0 },
        ],
      },
    },
    candidatePolicy: {
      poolQuota: 18,
      costBudget: 18,
      evidenceRequirements: ['finlab_ai_skill', 'raw_price_structure', 'raw_volume'],
      maxMlShare: 0.22,
    },
    riskNotes: ['Breakout false positives are expected; L2/L3 model gates and sparse allocation must reject weak names.'],
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
    candidatePolicy: {
      poolQuota: 18,
      costBudget: 18,
      evidenceRequirements: ['finlab_ai_skill', 'raw_valuation', 'raw_profitability', 'raw_reversion'],
      maxMlShare: 0.22,
    },
    riskNotes: ['Mean-reversion candidates must be capped by regime and downside risk overlays before allocation.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_revenue_revision_breakout_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI revenue revision breakout',
    status: 'active',
    owner: 'strategy',
    familyId: 'REVENUE_QUALITY_MOMENTUM',
    variantId: 'revenue_revision_breakout_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'breakout_vol_expansion',
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    thesis: 'Use FinLab-mined revenue revision factors plus raw price reclaim and volume confirmation to expand L1 beyond old score-ranked candidates.',
    thresholds: {
      minPrice: 10,
      minCloseAboveMa20Pct: 0,
      minVolumeExpansion20: 1.0,
      minRevenueGrowthYoY: 3,
      minRoe: 5,
      minTechnicalIndicators: {
        rsi14: 45,
        volumeExpansion20: 1.05,
        closeAboveMa20Pct: 0,
      },
      maxTechnicalIndicators: {
        rsi14: 72,
      },
      minFactorSignals: {
        monthlyRevenueYoY: 8,
        monthlyRevenueMoM: 0,
        revenueGrowthYoY: 3,
      },
    },
    candidatePolicy: {
      poolQuota: 16,
      costBudget: 18,
      evidenceRequirements: ['finlab_ai_skill', 'raw_factor_mining', 'raw_technical_indicator_mining', 'raw_revenue_revision', 'raw_volume'],
      maxMlShare: 0.2,
    },
    riskNotes: ['Active breadth strategy; future FinLab AI discoveries still enter research/discovery before normal promotion.'],
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
    thesis: 'Use mined broker participation persistence, low concentration and mild technical reclaim to admit accumulation names that broad scores may miss.',
    thresholds: {
      minPrice: 10,
      minVolumeExpansion20: 0.85,
      minBrokerNetAmount5d: 0,
      minBrokerCount: 5,
      maxBrokerConcentration: 0.65,
      minTechnicalIndicators: {
        rsi14: 40,
      },
      maxTechnicalIndicators: {
        rsi14: 68,
      },
      minFactorSignals: {
        brokerNetAmount5d: 0,
        brokerCount: 5,
      },
    },
    candidatePolicy: {
      poolQuota: 16,
      costBudget: 18,
      evidenceRequirements: ['finlab_ai_skill', 'raw_factor_mining', 'raw_technical_indicator_mining', 'raw_broker_flow'],
      maxMlShare: 0.2,
    },
    riskNotes: ['Active breadth strategy; broker-flow candidates still require L2/L3 model and allocation rejection when edge is weak.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_quality_value_reacceleration_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI quality value reacceleration',
    status: 'active',
    owner: 'strategy',
    familyId: 'REVENUE_QUALITY_MOMENTUM',
    variantId: 'quality_value_reacceleration_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'mean_reversion',
    supportedRegimes: ['sideways', 'bear', 'volatile'],
    thesis: 'Use raw valuation, profitability and revenue reacceleration factors to add neglected quality-value candidates into L1 diversity.',
    thresholds: {
      minPrice: 10,
      minEps: 0,
      minRoe: 8,
      maxPe: 32,
      maxPb: 3.2,
      maxReturn20d: 0.12,
      minVolumeExpansion20: 0.75,
      minFactorSignals: {
        eps: 0,
        roe: 8,
        monthlyRevenueYoY: 0,
      },
      minTechnicalIndicators: {
        volumeExpansion20: 0.75,
      },
    },
    candidatePolicy: {
      poolQuota: 16,
      costBudget: 18,
      evidenceRequirements: ['finlab_ai_skill', 'raw_factor_mining', 'raw_technical_indicator_mining', 'raw_profitability', 'raw_valuation'],
      maxMlShare: 0.2,
    },
    riskNotes: ['Mean-reversion active breadth strategy; final sizing remains owned by sparse allocation and risk overlays.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_rsi_volume_reclaim_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI RSI volume reclaim',
    status: 'active',
    owner: 'strategy',
    familyId: 'TREND_RECLAIM_CONTINUATION',
    variantId: 'rsi_macd_adx_volume_reclaim_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'trend_following',
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    thesis: 'Use mined RSI reclaim and volume expansion structure to catch early trend repair before old aggregate scores become high.',
    thresholds: {
      minPrice: 10,
      minCloseAboveMa20Pct: -0.02,
      maxReturn20d: 0.08,
      minTechnicalIndicators: {
        rsi14: 45,
        volumeExpansion20: 1.1,
      },
      maxTechnicalIndicators: {
        rsi14: 65,
      },
      dsl: {
        any: [
          { signal: 'technicalIndicators.macdHist', op: '>=', value: 0 },
          { signal: 'technicalIndicators.adx14', op: '>=', value: 16 },
          { signal: 'technicalIndicators.diTrend', op: '>=', value: 0 },
        ],
      },
    },
    candidatePolicy: {
      poolQuota: 16,
      costBudget: 18,
      evidenceRequirements: ['finlab_ai_skill', 'raw_factor_mining', 'raw_technical_indicator_mining', 'raw_reclaim'],
      maxMlShare: 0.2,
    },
    riskNotes: ['Active breadth strategy; L2/L3 must reject weak repair patterns and avoid direct production mutation from later discoveries.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_smc_structure_reclaim_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI SMC structure reclaim',
    status: 'active',
    owner: 'strategy',
    familyId: 'SMC_STRUCTURE_RECLAIM',
    variantId: 'liquidity_sweep_bos_displacement_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'mean_reversion',
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    thesis: 'Scan raw OHLCV structure for liquidity sweep, BOS/CHOCH and displacement evidence before ML ranking.',
    thresholds: {
      minPrice: 10,
      maxReturn20d: 0.14,
      minTechnicalIndicators: {
        displacementPct: 0.006,
      },
      dsl: {
        any: [
          { signal: 'technicalIndicators.smcBullishScore', op: '>=', value: 0.12 },
          { signal: 'technicalIndicators.smcNetScore', op: '>=', value: 0.08 },
          { signal: 'technicalIndicators.liquiditySweepBullish', op: '>=', value: 1 },
          { signal: 'technicalIndicators.bosBullish', op: '>=', value: 1 },
          { signal: 'technicalIndicators.chochBullish', op: '>=', value: 1 },
          { signal: 'technicalIndicators.bestFvgStrength', op: '>=', value: 0.1 },
          { signal: 'technicalIndicators.bestOrderBlockStrength', op: '>=', value: 0.1 },
        ],
        not: [
          { signal: 'technicalIndicators.smcBiasBearish', op: '==', value: 1 },
        ],
      },
    },
    candidatePolicy: {
      poolQuota: 16,
      costBudget: 18,
      evidenceRequirements: ['finlab_ai_skill', 'raw_factor_mining', 'raw_technical_indicator_mining', 'raw_price_action_structure', 'liquidity_sweep', 'bos_choch', 'displacement'],
      maxMlShare: 0.2,
    },
    riskNotes: ['Active breadth strategy; Order Block and FVG zones still refine entry in L4/L5 instead of directly triggering orders.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_sector_rotation_core_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI sector rotation core',
    status: 'active',
    owner: 'strategy',
    familyId: 'SECTOR_ROTATION_CORE',
    variantId: 'sector_flow_core_rs_rotation_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'trend_following',
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    thesis: 'Use canonical sector_flow stock detail plus RRG-style relative strength to admit leading theme core stocks into L1.',
    thresholds: {
      minPrice: 10,
      minVolumeExpansion20: 0.75,
      minFactorSignals: {
        sectorFlowCore: 1,
      },
      dsl: {
        any: [
          { signal: 'factorSignals.sectorRsRatio', op: '>=', value: 100 },
          { signal: 'factorSignals.sectorRsMomentum', op: '>=', value: 0 },
          { signal: 'factorSignals.sectorTurnoverShareDelta', op: '>=', value: 0 },
        ],
      },
    },
    candidatePolicy: {
      poolQuota: 16,
      costBudget: 18,
      evidenceRequirements: ['finlab_ai_skill', 'sector_flow', 'sector_flow_stocks', 'relative_strength_rotation'],
      maxMlShare: 0.2,
    },
    riskNotes: ['Active breadth strategy; sector rotation widens L1 breadth, but final buy decision still requires L2/L3 edge and allocation risk acceptance.'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'finlab_ai_skill_discovery_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'FinLab AI Skill strategy discovery',
    status: 'research',
    owner: 'strategy',
    alphaBucket: 'mean_reversion',
    supportedRegimes: ['bull', 'sideways', 'bear', 'volatile'],
    thesis: 'FinLab AI Skill actively generates factor, taxonomy and strategy hypotheses. Output is learned and recorded as research evidence until a generated strategy receives its own validated spec and promotion approval.',
    thresholds: { minPrice: 10 },
    candidatePolicy: {
      poolQuota: 12,
      costBudget: 12,
      evidenceRequirements: ['finlab_ai_skill', 'finlab_factor', 'raw_factor_mining', 'raw_technical_indicator_mining', 'finlab_taxonomy', 'strategy_hypothesis', 'research_reward'],
      maxMlShare: 0,
    },
    riskNotes: ['Research discovery lane: generated hypotheses must become validated strategy specs before entering ML queue, debate, pending-buy, or live execution.'],
    createdBy: 'p5_strategy_governance',
  },
]

export const DEFAULT_STRATEGY_SPECS: StrategySpec[] = DEFAULT_STRATEGY_SPEC_DRAFTS.map(normalizeStrategySpecGovernance)
