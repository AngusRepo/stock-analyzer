import type { AlphaFrameworkBucket, AlphaFrameworkRegime } from './tradingConfig'
import { readScoreV2Snapshot } from './scoreV2Taxonomy'

export const STRATEGY_SPEC_VERSION = 'strategy-spec-v1'

export type StrategySpecStatus = 'research' | 'shadow' | 'candidate' | 'active' | 'retired'

export interface StrategyCandidateInput {
  symbol: string
  name?: string
  sector?: string
  industry?: string
  score?: number
  ml_score?: number
  chip_score?: number
  tech_score?: number
  momentum_score?: number
  score_components?: unknown
  current_price?: number | null
}

export interface StrategySpecThresholds {
  minSeedScore?: number
  minChipScore?: number
  minTechScore?: number
  minMomentumScore?: number
  minPrice?: number
  maxPrice?: number
  includeIndustries?: string[]
  excludeIndustries?: string[]
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
  momentumProxy: number
  source: 'score_v2' | 'storage_projection'
}

const FORBIDDEN_SPEC_KEYS = [
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
  const price = finiteNumber(candidate.current_price)
  if (thresholds.minPrice == null && thresholds.maxPrice == null) return true
  if (price == null) return false
  if (thresholds.minPrice != null && price < thresholds.minPrice) return false
  if (thresholds.maxPrice != null && price > thresholds.maxPrice) return false
  return true
}

function legacyComponentNumber(record: Record<string, unknown> | null, key: string): number | null {
  const legacy = record?.legacyComponents
  return legacy && typeof legacy === 'object' && !Array.isArray(legacy)
    ? finiteNumber((legacy as Record<string, unknown>)[key])
    : null
}

export function deriveStrategyThresholdScores(candidate: StrategyCandidateInput): StrategyThresholdScores {
  const snapshot = readScoreV2Snapshot(candidate)
  const record = parseRecord(candidate.score_components)
  const storageSeed = finiteNumber(candidate.score)

  if (snapshot.source === 'score_v2') {
    const canonicalFinal = finiteNumber(record?.finalScore)
    return {
      seedScore: canonicalFinal ?? storageSeed ?? snapshot.finalScore,
      chipFlow: snapshot.components.chipFlow,
      technicalStructure: snapshot.components.technicalStructure,
      momentumProxy: legacyComponentNumber(record, 'screenerMomentum')
        ?? finiteNumber(candidate.momentum_score)
        ?? snapshot.technicalBreakdown?.volumeConfirmation
        ?? 0,
      source: 'score_v2',
    }
  }

  return {
    seedScore: finiteNumber(candidate.score) ?? snapshot.total,
    chipFlow: finiteNumber(candidate.chip_score) ?? snapshot.components.chipFlow,
    technicalStructure: finiteNumber(candidate.tech_score) ?? snapshot.components.technicalStructure,
    momentumProxy: finiteNumber(candidate.momentum_score)
      ?? snapshot.technicalBreakdown?.volumeConfirmation
      ?? 0,
    source: 'storage_projection',
  }
}

export function assessCandidateAgainstStrategySpecs(
  candidate: StrategyCandidateInput,
  specs: StrategySpec[],
): StrategySpecAssessment {
  const matches: StrategySpecMatch[] = []
  const watchPoints: string[] = []
  const scores = deriveStrategyThresholdScores(candidate)

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
    if (!meetsMinimum(scores.momentumProxy, t.minMomentumScore)) continue

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

export const DEFAULT_STRATEGY_SPECS: StrategySpec[] = [
  {
    id: 'trend_following_seed_v1',
    version: STRATEGY_SPEC_VERSION,
    name: '順勢延續種子',
    status: 'shadow',
    owner: 'strategy',
    alphaBucket: 'trend_following',
    supportedRegimes: ['bull', 'sideways'],
    thesis: '技術與動能同時達標，適合交給 ML 與 debate 做下一層確認。',
    thresholds: { minSeedScore: 58, minTechScore: 18, minMomentumScore: 6, minPrice: 10 },
    candidatePolicy: { poolQuota: 14, costBudget: 18, evidenceRequirements: ['price', 'technical', 'momentum'] },
    riskNotes: ['避免在高位急拉後直接追價；實際入場仍交由 execution gate 判斷。'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'breakout_vol_expansion_seed_v1',
    version: STRATEGY_SPEC_VERSION,
    name: '突破/波動擴張種子',
    status: 'shadow',
    owner: 'strategy',
    alphaBucket: 'breakout_vol_expansion',
    supportedRegimes: ['bull', 'volatile'],
    thesis: '技術分與短線動能較強，適合作為突破候選，但必須保留波動與流動性風控。',
    thresholds: { minSeedScore: 62, minTechScore: 20, minMomentumScore: 8, minPrice: 10 },
    candidatePolicy: { poolQuota: 12, costBudget: 16, evidenceRequirements: ['price', 'volume', 'technical'] },
    riskNotes: ['突破策略的失敗成本較高，不能把 spec match 直接當買進訊號。'],
    createdBy: 'p5_strategy_governance',
  },
  {
    id: 'defensive_accumulation_seed_v1',
    version: STRATEGY_SPEC_VERSION,
    name: '防守型累積種子',
    status: 'shadow',
    owner: 'strategy',
    alphaBucket: 'defensive_accumulation',
    supportedRegimes: ['bull', 'sideways', 'bear'],
    thesis: '籌碼分穩定且基本技術條件不差，偏向低追價壓力的候選。',
    thresholds: { minSeedScore: 54, minChipScore: 20, minTechScore: 12, minPrice: 10 },
    candidatePolicy: { poolQuota: 16, costBudget: 20, evidenceRequirements: ['price', 'chip_or_flow', 'risk'] },
    riskNotes: ['防守型種子仍需確認沒有資料 stale、流動性過薄或大盤風險。'],
    createdBy: 'p5_strategy_governance',
  },
]
