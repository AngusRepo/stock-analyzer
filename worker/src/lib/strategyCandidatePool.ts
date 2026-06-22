import {
  assessCandidateAgainstStrategySpecs,
  deriveStrategyRawSignals,
  deriveStrategyThresholdScores,
  normalizeStrategySpecGovernance,
  validateStrategySpec,
  type StrategyCandidateInput,
  type StrategyFamilyId,
  type StrategyOwnerType,
  type StrategyPromotionStatus,
  type StrategySpec,
  type StrategySpecStatus,
} from './strategySpec'
import type { AlphaFrameworkBucket, AlphaFrameworkRegime } from './tradingConfig'
import { assertOwnerCanOwn } from './strategyOwnerFreeze'
import { buildMultiStrategyPleRoutingPlan, type StrategyPortfolioMetrics } from './multiStrategyPleRouter'
import type { StrategySimilarityGraphEvidence } from './strategyPortfolioMetrics'

export const STRATEGY_CANDIDATE_POOL_VERSION = 'strategy-candidate-pool-v1'

export type StrategyBudgetMode = 'base' | 'normal' | 'low_load' | 'hard_cap'
export type StrategyQueueDecision = 'ml_queue' | 'research_only_queue' | 'dropped'

export interface StrategyCandidateRuntimePolicy {
  poolQuota?: number
  costBudget?: number
  evidenceRequirements?: string[]
  maxMlShare?: number
}

export interface StrategyCandidatePoolPolicy {
  version: string
  baseTotalBudget: number
  normalTotalCap: number
  lowLoadTotalCap: number
  hardTotalCap: number
  defaultPoolQuota: number
  minPoolQuota: number
  maxPoolQuota: number
  defaultCostBudget: number
  maxOneStrategyShare: number
  maxIndustryShare: number
}

export interface StrategyCapacityInput {
  requestedMode?: StrategyBudgetMode
  observedPipelineMinutes?: number | null
  requestedTotalCap?: number | null
  manualOverride?: boolean
}

export interface StrategyCapacityDecision {
  mode: StrategyBudgetMode
  totalCap: number
  baseTotalBudget: number
  mlQueueCap: number
  researchQueueBudget: number
  reason: string
}

export interface StrategyCandidatePoolCandidate extends StrategyCandidateInput {
  score?: number | null
  score_components?: unknown
  chip_score?: number | null
  tech_score?: number | null
  momentum_score?: number | null
  industryTheme?: string | null
  subindustry?: string | null
  market_segment?: string | null
  eligible_for_ml?: boolean | number | null
  restricted?: boolean | null
  trading_value?: number | null
  average_turnover?: number | null
  liquidity_value?: number | null
  strategy_runtime_policy?: StrategyCandidateRuntimePolicy
  strategy_pool_score?: number
  strategy_pool_rank?: number
  strategy_pool_ids?: string[]
  strategy_family_ids?: string[]
  strategy_variant_ids?: string[]
  strategy_owner_types?: StrategyOwnerType[]
  research_strategy_ids?: string[]
  strategy_pool_fallback_source?: string
  strategy_pool_decision?: StrategyQueueDecision
  strategy_pool_reason?: string
  strategy_labeler_version?: string
  strategy_affinity_vector?: Record<string, number>
  strategy_weak_label_vector?: Record<string, number>
  strategy_hit_vector?: Record<string, number>
  strategy_position_weight_vector?: Record<string, number>
  strategy_overlap_vector?: Record<string, number>
  strategy_family_affinity?: Record<string, number>
  strategy_portfolio_prior?: unknown
  strategy_router_version?: string
  strategy_router_score?: number
  candidate_route_score?: number
  ml_slate_eligibility?: number
  family_exposure?: Record<string, number>
  diversity_contribution?: number
  risk_adjusted_affinity?: number
  uncertainty?: number
  runtime_teacher_evidence?: Record<string, number>
  runtime_teacher_evidence_source?: string
  ml_teacher_labels?: Record<string, number>
  strategy_router_decision?: 'ml_slate' | 'observe_only' | 'research_only' | 'capacity_overflow'
  strategy_router_reason?: string
  strategy_router_components?: Record<string, number>
  strategy_matches?: Array<{ specId: string; alphaBucket: string; status: string; label: string; reason: string }>
  strategy_tags?: string[]
  strategy_watch_points?: string[]
}

export interface StrategyPoolEntry<T extends StrategyCandidatePoolCandidate = StrategyCandidatePoolCandidate> {
  strategy_id: string
  strategy_name: string
  alpha_bucket: AlphaFrameworkBucket
  strategy_status: StrategySpecStatus
  family_id: StrategyFamilyId
  variant_id: string
  owner_type: StrategyOwnerType
  promotion_status: StrategyPromotionStatus
  quota: number
  cost_budget: number
  evidence_requirements: string[]
  max_ml_share: number | null
  regime_weight: number
  candidate: T
  raw_score: number
  strategy_score: number
  rank: number
  reason: string
  research_strategy_ids?: string[]
}

export interface StrategyPool<T extends StrategyCandidatePoolCandidate = StrategyCandidatePoolCandidate> {
  strategy_id: string
  strategy_name: string
  alpha_bucket: AlphaFrameworkBucket
  strategy_status: StrategySpecStatus
  family_id: StrategyFamilyId
  owner_type: StrategyOwnerType
  promotion_status: StrategyPromotionStatus
  quota: number
  cost_budget: number
  evidence_requirements: string[]
  regime_scope: string[]
  regime_weight: number
  status: 'ready' | 'adaptive_near_match' | 'out_of_regime' | 'invalid_spec'
  daily_match_status: 'strict_match' | 'strict_empty_threshold' | 'strict_empty_feature_ref' | 'shadow_near_match' | 'out_of_regime' | 'invalid_spec'
  strict_match_count: number
  near_match_count: number
  missing_evidence: string[]
  candidates: Array<StrategyPoolEntry<T>>
}

type StrategyPoolAggregate<T extends StrategyCandidatePoolCandidate = StrategyCandidatePoolCandidate> = StrategyPoolEntry<T> & {
  strategy_ids: string[]
  research_strategy_ids: string[]
  active_strategy_refs: StrategyPoolStrategyRef[]
}

type StrategyPoolStrategyRef = {
  strategy_id: string
  family_id: StrategyFamilyId
  variant_id: string
  alpha_bucket: AlphaFrameworkBucket
  strategy_score: number
}

export interface StrategyCandidateSelection<T extends StrategyCandidatePoolCandidate = StrategyCandidatePoolCandidate> {
  version: string
  capacity: StrategyCapacityDecision
  pools: Array<StrategyPool<T>>
  mlQueue: T[]
  researchOnlyQueue: T[]
  dropped: Array<{ symbol: string; reason: string; strategy_ids: string[] }>
  telemetry: {
    strategy_count: number
    pool_entries: number
    deduped_symbols: number
    ml_queue_count: number
    research_only_count: number
    dropped_count: number
    overflow_count: number
    estimated_batch_chunks: number
    strategy_usage: Record<string, number>
    industry_usage: Record<string, number>
  }
}

export interface Layer1StrategyBreadthPlan<T extends StrategyCandidatePoolCandidate = StrategyCandidatePoolCandidate> {
  version: `${typeof STRATEGY_CANDIDATE_POOL_VERSION}:layer1-breadth-v1`
  sourceUniverseCount: number
  breadthPool: T[]
  coarseQueue: T[]
  researchOnlyQueue: T[]
  selection: StrategyCandidateSelection<T>
  telemetry: {
    selection_order: 'full_feature_enriched_universe_strategy_only_with_raw_signal_observe'
    target_size: number
    coarse_ml_queue_size: number
    coarse_ml_target_size: number
    strategy_selected_count: number
    raw_signal_top_up_count: number
    source_universe_count: number
    strategy_labeler_version?: string
    finlab_portfolio_intelligence_version?: string
    l15_router_version?: string
    l15_router_selection_order?: string
    l15_router_slate_selection_policy?: string
    l15_router_ml_slate_count?: number
    l15_router_observe_only_count?: number
    l15_router_capacity_overflow_count?: number
    strategy_matrix_candidate_count?: number
    strategy_matrix_strategy_count?: number
    strategy_matrix_cell_count?: number
    strategy_matrix_expected_cell_count?: number
    strategy_matrix_coverage_ratio?: number
    strategy_matrix_matched_candidate_count?: number
    strategy_matrix_active_labeled_candidate_count?: number
    min_route_score?: number
    min_route_score_source?: string
    route_score_distribution?: Record<string, number | null>
    route_score_above_floor_count?: number
    route_score_below_floor_count?: number
    teacher_label_available_count?: number
    teacher_label_missing_count?: number
    teacher_label_contract?: string
    runtime_teacher_evidence_policy?: string
    runtime_teacher_evidence_available_count?: number
    runtime_teacher_evidence_missing_count?: number
    strategy_metric_status_counts?: Record<string, number>
    strategy_metric_ready_count?: number
    strategy_metric_no_evidence_count?: number
    strategy_similarity_evidence_source?: string
    strategy_similarity_algorithm_owner?: string
    strategy_similarity_medoid_algorithm?: string
    strategy_similarity_blocked_reason?: string
    /** @deprecated Read historical funnel rows only. New runtime writes blocked_reason. */
    strategy_similarity_degraded_reason?: string
    strategy_portfolio_metric_source?: string
    strategy_portfolio_metric_count?: number
  }
}

export const DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY: StrategyCandidatePoolPolicy = {
  version: STRATEGY_CANDIDATE_POOL_VERSION,
  baseTotalBudget: 64,
  normalTotalCap: 96,
  lowLoadTotalCap: 128,
  hardTotalCap: 160,
  defaultPoolQuota: 12,
  minPoolQuota: 8,
  maxPoolQuota: 20,
  defaultCostBudget: 20,
  maxOneStrategyShare: 0.35,
  maxIndustryShare: 0.22,
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim()
}

function uniqueTexts(values: unknown[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))]
}

function policyForSpec(spec: StrategySpec): StrategyCandidateRuntimePolicy {
  const raw = (spec as unknown as { candidatePolicy?: StrategyCandidateRuntimePolicy }).candidatePolicy
    ?? (spec as unknown as { strategyCandidatePolicy?: StrategyCandidateRuntimePolicy }).strategyCandidatePolicy
    ?? {}
  return raw && typeof raw === 'object' ? raw : {}
}

function boundedQuota(value: unknown, policy: StrategyCandidatePoolPolicy): number {
  const n = finiteNumber(value)
  const quota = n == null ? policy.defaultPoolQuota : Math.round(n)
  return clamp(quota, policy.minPoolQuota, policy.maxPoolQuota)
}

function statusWeight(status: string): number {
  if (status === 'active') return 1.15
  if (status === 'candidate') return 1.08
  if (status === 'shadow') return 1
  if (status === 'research') return 0.85
  return 0
}

function regimeWeight(spec: StrategySpec, regime?: string | null): number {
  const current = cleanText(regime).toLowerCase()
  if (!current || current === 'unknown' || current === 'all') return 1
  return spec.supportedRegimes.map(String).map((item) => item.toLowerCase()).includes(current) ? 1 : 0
}

function candidateIndustry(candidate: StrategyCandidatePoolCandidate): string {
  return cleanText(candidate.industryTheme)
    || cleanText(candidate.industry)
    || cleanText(candidate.sector)
    || 'unknown'
}

function candidateLiquidity(candidate: StrategyCandidatePoolCandidate): number | null {
  return finiteNumber(candidate.trading_value)
    ?? finiteNumber(candidate.average_turnover)
    ?? finiteNumber(candidate.liquidity_value)
}

function candidatePoolThresholdScores(candidate: StrategyCandidatePoolCandidate): {
  seedScore: number
  chipFlow: number
  technicalStructure: number
  momentumScore: number
} {
  const canonical = deriveStrategyThresholdScores(strategyInputFromPoolCandidate(candidate))
  return {
    seedScore: canonical.seedScore,
    chipFlow: canonical.chipFlow,
    technicalStructure: canonical.technicalStructure,
    momentumScore: canonical.momentumScore,
  }
}

function usesLegacyScoreThresholds(spec: StrategySpec): boolean {
  const t = spec.thresholds
  return t.minSeedScore != null
    || t.minChipScore != null
    || t.minTechScore != null
    || t.minMomentumScore != null
}

function strategyInputFromPoolCandidate(candidate: StrategyCandidatePoolCandidate): StrategyCandidateInput {
  const { score_components, ...rest } = candidate
  return {
    ...rest,
    score_v2: candidate.score_v2 ?? score_components,
  }
}

function addDynamicNearMissChecks(
  checks: Array<[string, unknown, number | undefined]>,
  prefix: string,
  signals: Record<string, number | null> | undefined,
  thresholds: Record<string, number> | undefined,
): void {
  for (const [key, min] of Object.entries(thresholds ?? {})) {
    checks.push([`${prefix}.${key}`, signals?.[key], min])
  }
}

function thresholdNearMisses(candidate: StrategyCandidatePoolCandidate, spec: StrategySpec): string[] | null {
  const thresholds = spec.thresholds
  const industry = cleanText(candidate.industry ?? candidate.sector)
  const includes = thresholds.includeIndustries?.map(cleanText).filter(Boolean) ?? []
  const excludes = thresholds.excludeIndustries?.map(cleanText).filter(Boolean) ?? []
  if (includes.length && !includes.includes(industry)) return null
  if (excludes.length && excludes.includes(industry)) return null

  const raw = deriveStrategyRawSignals(strategyInputFromPoolCandidate(candidate))
  const price = finiteNumber(candidate.current_price) ?? raw.close ?? null
  if (thresholds.minPrice != null && (price == null || price < thresholds.minPrice)) return null
  if (thresholds.maxPrice != null && (price == null || price > thresholds.maxPrice)) return null

  const scores = candidatePoolThresholdScores(candidate)
  const checks: Array<[string, unknown, number | undefined]> = [
    ['score', scores.seedScore, thresholds.minSeedScore],
    ['chip', scores.chipFlow, thresholds.minChipScore],
    ['technical', scores.technicalStructure, thresholds.minTechScore],
    ['momentum', scores.momentumScore, thresholds.minMomentumScore],
    ['closeAboveMa20Pct', raw.closeAboveMa20Pct, thresholds.minCloseAboveMa20Pct],
    ['closeAboveMa60Pct', raw.closeAboveMa60Pct, thresholds.minCloseAboveMa60Pct],
    ['volumeExpansion20', raw.volumeExpansion20, thresholds.minVolumeExpansion20],
    ['return20d', raw.return20d, thresholds.minReturn20d],
    ['foreignTrustNet5d', raw.foreignTrustNet5d, thresholds.minForeignTrustNet5d],
    ['brokerNetAmount5d', raw.brokerNetAmount5d, thresholds.minBrokerNetAmount5d],
    ['brokerCount', raw.brokerCount, thresholds.minBrokerCount],
    ['revenueGrowthYoY', raw.revenueGrowthYoY, thresholds.minRevenueGrowthYoY],
    ['monthlyRevenueYoY', raw.monthlyRevenueYoY, thresholds.minMonthlyRevenueYoY],
    ['roe', raw.roe, thresholds.minRoe],
    ['eps', raw.eps, thresholds.minEps],
  ]
  addDynamicNearMissChecks(checks, 'technicalIndicators', raw.technicalIndicators, thresholds.minTechnicalIndicators)
  addDynamicNearMissChecks(checks, 'factorSignals', raw.factorSignals, thresholds.minFactorSignals)
  const misses: string[] = []
  for (const [label, rawValue, minValue] of checks) {
    if (minValue == null) continue
    const value = finiteNumber(rawValue)
    if (value == null) return null
    if (value < minValue) {
      if (value < minValue * 0.75) return null
      misses.push(`${label}:${value.toFixed(1)}/${minValue}`)
    }
  }
  return misses.length > 0 && misses.length <= 2 ? misses : null
}

function hasFeatureRefThresholdContract(spec: StrategySpec): boolean {
  const featureRefs = spec.thresholds.featureRefs
  if (!featureRefs) return false
  return Boolean(
    (featureRefs.weightedScore?.terms?.length ?? 0) > 0
    || (featureRefs.all?.length ?? 0) > 0
    || (featureRefs.any?.length ?? 0) > 0
    || (featureRefs.not?.length ?? 0) > 0,
  )
}

function mustFailClosedOnStrictFeatureRefs(spec: StrategySpec, evidenceRequirements: string[]): boolean {
  if (!hasFeatureRefThresholdContract(spec)) return false
  return spec.status === 'active'
    || spec.promotionStatus === 'production'
    || evidenceRequirements.includes('formal137')
}

function eligibleForMl(candidate: StrategyCandidatePoolCandidate): boolean {
  if (candidate.restricted === true) return false
  if (candidate.eligible_for_ml === false || candidate.eligible_for_ml === 0) return false
  const segment = cleanText(candidate.market_segment).toUpperCase()
  if (segment === 'EMERGING') return false
  return true
}

function strategyCanEnterMlQueue(entry: StrategyPoolEntry): boolean {
  return entry.strategy_status === 'active' && entry.owner_type === 'strategy' && finiteNumber(entry.max_ml_share) !== 0
}

function mergeActiveStrategyRefs(
  prevRefs: StrategyPoolStrategyRef[],
  entry: StrategyPoolEntry,
): StrategyPoolStrategyRef[] {
  const refs = [...prevRefs]
  if (!strategyCanEnterMlQueue(entry)) return refs

  const next: StrategyPoolStrategyRef = {
    strategy_id: entry.strategy_id,
    family_id: entry.family_id,
    variant_id: entry.variant_id,
    alpha_bucket: entry.alpha_bucket,
    strategy_score: entry.strategy_score,
  }
  const index = refs.findIndex((ref) => ref.strategy_id === next.strategy_id)
  if (index < 0) {
    refs.push(next)
  } else {
    const prev = refs[index]
    if (next.strategy_score > prev.strategy_score) {
      refs[index] = next
    }
  }
  return refs.sort((a, b) => {
    const familyOrder = String(a.family_id).localeCompare(String(b.family_id))
    if (familyOrder !== 0) return familyOrder
    return a.strategy_id.localeCompare(b.strategy_id)
  })
}

function aggregateStrategyIds<T extends StrategyCandidatePoolCandidate>(
  prev: StrategyPoolAggregate<T> | undefined,
  entry: StrategyPoolEntry<T>,
): Pick<StrategyPoolAggregate<T>, 'strategy_ids' | 'research_strategy_ids' | 'active_strategy_refs'> {
  const activeRefs = mergeActiveStrategyRefs(prev?.active_strategy_refs ?? [], entry)
  const researchIds = [...(prev?.research_strategy_ids ?? [])]
  if (!strategyCanEnterMlQueue(entry)) {
    researchIds.push(entry.strategy_id)
  }
  return {
    active_strategy_refs: activeRefs,
    strategy_ids: uniqueTexts(activeRefs.map((ref) => ref.strategy_id)),
    research_strategy_ids: uniqueTexts(researchIds),
  }
}

function strategyScore(candidate: StrategyCandidatePoolCandidate, spec: StrategySpec, weight: number): number {
  const scores = candidatePoolThresholdScores(candidate)
  const raw = deriveStrategyRawSignals(strategyInputFromPoolCandidate(candidate))
  const score = scores.seedScore
  const chip = scores.chipFlow
  const tech = scores.technicalStructure
  const momentum = scores.momentumScore
  const liquidity = candidateLiquidity(candidate)
  const liquidityBonus = liquidity == null ? 0 : clamp(Math.log10(Math.max(liquidity, 1)) - 7, 0, 3)
  if (!usesLegacyScoreThresholds(spec)) {
    return Math.round(rawSignalSuitabilityScore(raw, liquidityBonus) * statusWeight(spec.status) * weight * 1000) / 1000
  }
  const scoreV2Suitability = score * 0.52 + chip * 0.2 + tech * 0.16 + momentum * 0.1 + liquidityBonus
  return Math.round(scoreV2Suitability * statusWeight(spec.status) * weight * 1000) / 1000
}

function dynamicSignalScore(signals: Record<string, number | null> | undefined): number {
  const values = Object.values(signals ?? {}).map(finiteNumber).filter((value): value is number => value != null)
  if (!values.length) return 0
  const bounded = values.slice(0, 8).reduce((sum, value) => sum + clamp(value, -20, 20), 0)
  return clamp(bounded / Math.min(values.length, 8), -10, 10)
}

function rawSignalSuitabilityScore(raw: ReturnType<typeof deriveStrategyRawSignals>, liquidityBonus = 0): number {
  const trendScore =
    clamp((finiteNumber(raw.closeAboveMa20Pct) ?? 0) * 180, -12, 18)
    + clamp((finiteNumber(raw.closeAboveMa60Pct) ?? 0) * 120, -10, 14)
    + clamp(((finiteNumber(raw.volumeExpansion20) ?? 1) - 0.8) * 18, -6, 16)
    + clamp((finiteNumber(raw.return20d) ?? 0) * 80, -8, 12)
  const flowAmount = finiteNumber(raw.brokerNetAmount5d) ?? 0
  const flowShares = finiteNumber(raw.foreignTrustNet5d) ?? 0
  const flowScore =
    clamp(Math.sign(flowAmount) * Math.log10(Math.abs(flowAmount) + 1), -10, 14)
    + clamp(Math.sign(flowShares) * Math.log10(Math.abs(flowShares) + 1), -8, 12)
    + clamp((finiteNumber(raw.brokerCount) ?? 0) / 3, 0, 8)
    - clamp((finiteNumber(raw.brokerConcentration) ?? 0) * 8, 0, 8)
  const qualityScore =
    clamp((finiteNumber(raw.revenueGrowthYoY) ?? 0) / 4, -8, 12)
    + clamp((finiteNumber(raw.monthlyRevenueYoY) ?? 0) / 4, -8, 12)
    + clamp((finiteNumber(raw.roe) ?? 0) / 2, -4, 12)
    + clamp((finiteNumber(raw.eps) ?? 0) * 2, -6, 12)
  const valuationScore =
    clamp(10 - ((finiteNumber(raw.pe) ?? 35) - 12) / 3, -8, 12)
    + clamp(6 - ((finiteNumber(raw.pb) ?? 3) - 1) * 2, -6, 8)
  const dynamicScore = dynamicSignalScore(raw.factorSignals) * 0.4 + dynamicSignalScore(raw.technicalIndicators) * 0.25
  return clamp(45 + trendScore * 0.28 + flowScore * 0.28 + qualityScore * 0.3 + valuationScore * 0.14 + dynamicScore + liquidityBonus, 0, 100)
}

export function passesLayer1TopUpQualityGuard(candidate: StrategyCandidatePoolCandidate): boolean {
  const raw = deriveStrategyRawSignals(strategyInputFromPoolCandidate(candidate))
  const scores = candidatePoolThresholdScores(candidate)
  const chip = finiteNumber(candidate.chip_score) ?? scores.chipFlow
  const tech = finiteNumber(candidate.tech_score) ?? scores.technicalStructure
  const closeAboveMa20Pct = finiteNumber(raw.closeAboveMa20Pct)
  const closeAboveMa60Pct = finiteNumber(raw.closeAboveMa60Pct)
  const volumeExpansion20 = finiteNumber(raw.volumeExpansion20)
  const rsi14 = finiteNumber(raw.technicalIndicators?.rsi14) ?? finiteNumber(raw.factorSignals?.rsi14)
  const foreignTrustNet5d = finiteNumber(raw.foreignTrustNet5d)
  const brokerNetAmount5d = finiteNumber(raw.brokerNetAmount5d)
  const brokerCount = finiteNumber(raw.brokerCount)
  const monthlyRevenueYoY = finiteNumber(raw.monthlyRevenueYoY)
  const roe = finiteNumber(raw.roe)
  const eps = finiteNumber(raw.eps)

  const brokenTrend =
    tech < 12
    || (closeAboveMa20Pct != null && closeAboveMa20Pct <= -0.08)
    || (closeAboveMa60Pct != null && closeAboveMa60Pct <= -0.08)
    || (rsi14 != null && rsi14 < 40)
  const unsupportedChip =
    chip <= 0
    || (
      (foreignTrustNet5d != null && foreignTrustNet5d < 0)
      && (brokerNetAmount5d == null || brokerNetAmount5d <= 0)
      && (brokerCount == null || brokerCount < 3)
    )
  if (brokenTrend && unsupportedChip) return false

  const constructiveTechnical =
    (closeAboveMa20Pct != null && closeAboveMa20Pct >= -0.02 && (volumeExpansion20 ?? 1) >= 1.1 && (rsi14 == null || rsi14 >= 45))
    || (tech >= 16 && (volumeExpansion20 ?? 1) >= 0.9)
  const constructiveChip =
    (foreignTrustNet5d != null && foreignTrustNet5d > 0)
    || (brokerNetAmount5d != null && brokerNetAmount5d > 0)
    || (brokerCount != null && brokerCount >= 3 && chip > 0)
  const constructiveQuality =
    (monthlyRevenueYoY != null && monthlyRevenueYoY >= 8)
    && (eps != null && eps > 0)
    && (roe != null && roe >= 5)
    && (closeAboveMa20Pct == null || closeAboveMa20Pct >= -0.04)

  return constructiveTechnical || constructiveChip || constructiveQuality
}

function rawScoreForEntry(candidate: StrategyCandidatePoolCandidate, spec: StrategySpec): number {
  if (usesLegacyScoreThresholds(spec)) return candidatePoolThresholdScores(candidate).seedScore
  const raw = deriveStrategyRawSignals(strategyInputFromPoolCandidate(candidate))
  const liquidity = candidateLiquidity(candidate)
  const liquidityBonus = liquidity == null ? 0 : clamp(Math.log10(Math.max(liquidity, 1)) - 7, 0, 3)
  return Math.round(rawSignalSuitabilityScore(raw, liquidityBonus) * 1000) / 1000
}

function cloneCandidate<T extends StrategyCandidatePoolCandidate>(candidate: T): T {
  return {
    ...candidate,
    strategy_tags: [...(candidate.strategy_tags ?? [])],
    strategy_watch_points: [...(candidate.strategy_watch_points ?? [])],
    strategy_matches: [...(candidate.strategy_matches ?? [])],
  }
}

export function resolveStrategyCapacityBudget(
  input: StrategyCapacityInput = {},
  policy: StrategyCandidatePoolPolicy = DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY,
): StrategyCapacityDecision {
  const requested = input.requestedMode ?? 'base'
  const observed = finiteNumber(input.observedPipelineMinutes)
  let mode: StrategyBudgetMode = 'base'
  let totalCap = policy.baseTotalBudget
  let reason = 'default_base_budget'

  if (requested === 'normal' && observed != null && observed <= 10) {
    mode = 'normal'
    totalCap = policy.normalTotalCap
    reason = 'pipeline_runtime_within_normal_budget'
  } else if (requested === 'low_load' && observed != null && observed <= 8) {
    mode = 'low_load'
    totalCap = policy.lowLoadTotalCap
    reason = 'pipeline_runtime_within_low_load_budget'
  } else if (requested === 'hard_cap' && input.manualOverride === true) {
    mode = 'hard_cap'
    totalCap = policy.hardTotalCap
    reason = 'manual_hard_cap_override'
  } else if (requested !== 'base') {
    reason = 'telemetry_not_enough_keep_base_budget'
  }

  const requestedTotalCap = finiteNumber(input.requestedTotalCap)
  if (requestedTotalCap != null) {
    totalCap = clamp(Math.round(requestedTotalCap), policy.baseTotalBudget, policy.hardTotalCap)
    if (totalCap > policy.baseTotalBudget && mode === 'base') reason = 'requested_cap_bounded_without_mode_upgrade'
  }

  return {
    mode,
    totalCap,
    baseTotalBudget: policy.baseTotalBudget,
    mlQueueCap: totalCap,
    researchQueueBudget: Math.max(0, policy.hardTotalCap - totalCap),
    reason,
  }
}

export function buildStrategyCandidatePools<T extends StrategyCandidatePoolCandidate>(
  candidates: T[],
  specs: StrategySpec[],
  options: {
    regime?: AlphaFrameworkRegime | string | null
    policy?: StrategyCandidatePoolPolicy
    strategyWeights?: Record<string, number>
  } = {},
): Array<StrategyPool<T>> {
  assertOwnerCanOwn('screener', 'candidate_discovery')
  assertOwnerCanOwn('strategy', 'strategy_spec')
  const policy = options.policy ?? DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY

  return specs
    .filter((spec) => spec.status !== 'retired')
    .map((rawSpec) => {
      const spec = normalizeStrategySpecGovernance(rawSpec)
      const validation = validateStrategySpec(spec)
      const runtimePolicy = policyForSpec(spec)
      const quota = boundedQuota(runtimePolicy.poolQuota, policy)
      const costBudget = Math.max(1, Math.round(finiteNumber(runtimePolicy.costBudget) ?? policy.defaultCostBudget))
      const maxMlShare = finiteNumber(runtimePolicy.maxMlShare)
      const evidenceRequirements = runtimePolicy.evidenceRequirements?.map(cleanText).filter(Boolean)
        ?? ['price', 'chip_or_flow', 'technical']
      const rWeight = regimeWeight(spec, options.regime) * (finiteNumber(options.strategyWeights?.[spec.id]) ?? 1)
      const missingEvidence = validation.ok ? [] : validation.errors

      if (!validation.ok) {
        return {
          strategy_id: spec.id,
          strategy_name: spec.name,
          alpha_bucket: spec.alphaBucket,
          strategy_status: spec.status,
          family_id: spec.familyId!,
          owner_type: spec.ownerType!,
          promotion_status: spec.promotionStatus!,
          quota,
          cost_budget: costBudget,
          evidence_requirements: evidenceRequirements,
          regime_scope: spec.supportedRegimes.map(String),
          regime_weight: 0,
          status: 'invalid_spec',
          daily_match_status: 'invalid_spec',
          strict_match_count: 0,
          near_match_count: 0,
          missing_evidence: missingEvidence,
          candidates: [],
        }
      }

      if (rWeight <= 0) {
        return {
          strategy_id: spec.id,
          strategy_name: spec.name,
          alpha_bucket: spec.alphaBucket,
          strategy_status: spec.status,
          family_id: spec.familyId!,
          owner_type: spec.ownerType!,
          promotion_status: spec.promotionStatus!,
          quota,
          cost_budget: costBudget,
          evidence_requirements: evidenceRequirements,
          regime_scope: spec.supportedRegimes.map(String),
          regime_weight: 0,
          status: 'out_of_regime',
          daily_match_status: 'out_of_regime',
          strict_match_count: 0,
          near_match_count: 0,
          missing_evidence: ['regime_scope_mismatch'],
          candidates: [],
        }
      }

      let usedAdaptiveNearMatch = false
      let strictEmptyMissingEvidence: string[] = []
      const blockAdaptiveNearMatch = mustFailClosedOnStrictFeatureRefs(spec, evidenceRequirements)
      let entries = candidates
        .map((candidate) => {
          const assessment = assessCandidateAgainstStrategySpecs(strategyInputFromPoolCandidate(candidate), [spec])
          if (!assessment.matches.length) return null
          const scored = strategyScore(candidate, spec, rWeight)
          return {
            strategy_id: spec.id,
            strategy_name: spec.name,
            alpha_bucket: spec.alphaBucket,
            strategy_status: spec.status,
            family_id: spec.familyId!,
            variant_id: spec.variantId!,
            owner_type: spec.ownerType!,
            promotion_status: spec.promotionStatus!,
            quota,
            cost_budget: costBudget,
            evidence_requirements: evidenceRequirements,
            max_ml_share: maxMlShare,
            regime_weight: rWeight,
            candidate: cloneCandidate(candidate),
            raw_score: rawScoreForEntry(candidate, spec),
            strategy_score: scored,
            rank: 0,
            reason: assessment.matches[0]?.reason ?? spec.thesis,
          } satisfies StrategyPoolEntry<T>
        })
        .filter((entry): entry is StrategyPoolEntry<T> => entry != null)
        .sort((a, b) => b.strategy_score - a.strategy_score)
        .slice(0, Math.min(quota, costBudget))
        .map((entry, index) => ({ ...entry, rank: index + 1 }))
      const strictMatchCount = entries.length

      if (!entries.length && blockAdaptiveNearMatch) {
        strictEmptyMissingEvidence = ['strict_feature_ref_match_empty']
      }

      if (!entries.length && !blockAdaptiveNearMatch && !spec.thresholds.dsl) {
        usedAdaptiveNearMatch = true
        entries = candidates
          .map((candidate) => {
            const misses = thresholdNearMisses(candidate, spec)
            if (!misses) return null
            const scored = Math.round((strategyScore(candidate, spec, rWeight) * 0.92 - misses.length * 1.5) * 1000) / 1000
            return {
              strategy_id: spec.id,
              strategy_name: spec.name,
              alpha_bucket: spec.alphaBucket,
              strategy_status: spec.status,
              family_id: spec.familyId!,
              variant_id: spec.variantId!,
              owner_type: spec.ownerType!,
              promotion_status: spec.promotionStatus!,
              quota,
              cost_budget: costBudget,
              evidence_requirements: evidenceRequirements,
              max_ml_share: maxMlShare,
              regime_weight: rWeight,
              candidate: cloneCandidate(candidate),
              raw_score: rawScoreForEntry(candidate, spec),
              strategy_score: scored,
              rank: 0,
              reason: `adaptive_near_match:${misses.join('|')}`,
            } satisfies StrategyPoolEntry<T>
          })
          .filter((entry): entry is StrategyPoolEntry<T> => entry != null)
          .sort((a, b) => b.strategy_score - a.strategy_score)
          .slice(0, Math.min(quota, costBudget))
          .map((entry, index) => ({ ...entry, rank: index + 1 }))
      }
      if (!entries.length && !blockAdaptiveNearMatch && spec.status !== 'active') {
        usedAdaptiveNearMatch = true
        entries = candidates
          .map((candidate) => {
            const scored = Math.round((strategyScore(candidate, spec, rWeight) * 0.86) * 1000) / 1000
            return {
              strategy_id: spec.id,
              strategy_name: spec.name,
              alpha_bucket: spec.alphaBucket,
              strategy_status: spec.status,
              family_id: spec.familyId!,
              variant_id: spec.variantId!,
              owner_type: spec.ownerType!,
              promotion_status: spec.promotionStatus!,
              quota,
              cost_budget: costBudget,
              evidence_requirements: evidenceRequirements,
              max_ml_share: maxMlShare,
              regime_weight: rWeight,
              candidate: cloneCandidate(candidate),
              raw_score: rawScoreForEntry(candidate, spec),
              strategy_score: scored,
              rank: 0,
              reason: 'adaptive_empty_pool_ranked_near_match',
            } satisfies StrategyPoolEntry<T>
          })
          .sort((a, b) => b.strategy_score - a.strategy_score)
          .slice(0, Math.min(quota, costBudget))
          .map((entry, index) => ({ ...entry, rank: index + 1 }))
      }
      const nearMatchCount = usedAdaptiveNearMatch ? entries.length : 0
      const dailyMatchStatus: StrategyPool['daily_match_status'] = strictMatchCount > 0
        ? 'strict_match'
        : usedAdaptiveNearMatch && entries.length
          ? 'shadow_near_match'
          : blockAdaptiveNearMatch
            ? 'strict_empty_feature_ref'
            : 'strict_empty_threshold'

      return {
        strategy_id: spec.id,
        strategy_name: spec.name,
        alpha_bucket: spec.alphaBucket,
        strategy_status: spec.status,
        family_id: spec.familyId!,
        owner_type: spec.ownerType!,
        promotion_status: spec.promotionStatus!,
        quota,
        cost_budget: costBudget,
        evidence_requirements: evidenceRequirements,
        regime_scope: spec.supportedRegimes.map(String),
        regime_weight: rWeight,
        status: usedAdaptiveNearMatch && entries.length ? 'adaptive_near_match' : 'ready',
        daily_match_status: dailyMatchStatus,
        strict_match_count: strictMatchCount,
        near_match_count: nearMatchCount,
        missing_evidence: usedAdaptiveNearMatch && entries.length ? ['strict_threshold_match_empty'] : strictEmptyMissingEvidence,
        candidates: entries,
      }
    })
}

function annotateSelection<T extends StrategyCandidatePoolCandidate>(
  entry: StrategyPoolAggregate<T>,
  decision: StrategyQueueDecision,
  reason: string,
  rank: number,
  strategyIds: string[],
): T {
  const candidate = cloneCandidate(entry.candidate)
  candidate.strategy_pool_score = entry.strategy_score
  candidate.strategy_pool_rank = rank
  candidate.strategy_pool_ids = strategyIds
  candidate.strategy_family_ids = uniqueTexts(entry.active_strategy_refs.map((ref) => ref.family_id))
  candidate.strategy_variant_ids = uniqueTexts(entry.active_strategy_refs.map((ref) => ref.variant_id))
  candidate.strategy_owner_types = uniqueTexts([entry.owner_type]) as StrategyOwnerType[]
  candidate.research_strategy_ids = entry.research_strategy_ids
  candidate.strategy_pool_decision = decision
  candidate.strategy_pool_reason = reason
  candidate.strategy_tags = uniqueTexts([
    ...(candidate.strategy_tags ?? []),
    `strategy_pool:${STRATEGY_CANDIDATE_POOL_VERSION}`,
    ...strategyIds.map((id) => `strategy:${id}`),
    ...candidate.strategy_family_ids.map((id) => `strategy_family:${id}`),
  ])
  candidate.strategy_watch_points = uniqueTexts([
    ...(candidate.strategy_watch_points ?? []),
    `strategy_pool:${decision}`,
    `strategy_pool_rank:${rank}`,
    `strategy_pool_score:${entry.strategy_score.toFixed(2)}`,
    `strategy_pool_reason:${reason}`,
  ])
  return candidate
}

export function mergeStrategyCandidatePools<T extends StrategyCandidatePoolCandidate>(
  pools: Array<StrategyPool<T>>,
  capacity: StrategyCapacityDecision,
  policy: StrategyCandidatePoolPolicy = DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY,
): StrategyCandidateSelection<T> {
  const bestBySymbol = new Map<string, StrategyPoolAggregate<T>>()
  for (const pool of pools) {
    for (const entry of pool.candidates) {
      const symbol = cleanText(entry.candidate.symbol).toUpperCase()
      if (!symbol) continue
      const prev = bestBySymbol.get(symbol)
      const strategyIds = aggregateStrategyIds(prev, entry)
      const prevHasProductionOwner = (prev?.active_strategy_refs?.length ?? 0) > 0
      const entryHasProductionOwner = strategyCanEnterMlQueue(entry)
      const shouldReplace = !prev ||
        (entryHasProductionOwner && !prevHasProductionOwner) ||
        (entryHasProductionOwner === prevHasProductionOwner && entry.strategy_score > prev.strategy_score)
      if (shouldReplace) {
        bestBySymbol.set(symbol, { ...entry, ...strategyIds })
      } else {
        prev.strategy_ids = strategyIds.strategy_ids
        prev.research_strategy_ids = strategyIds.research_strategy_ids
        prev.active_strategy_refs = strategyIds.active_strategy_refs
      }
    }
  }

  const ordered = [...bestBySymbol.values()].sort((a, b) => b.strategy_score - a.strategy_score)
  const strategyCap = Math.max(1, Math.floor(capacity.mlQueueCap * policy.maxOneStrategyShare))
  const industryCap = Math.max(2, Math.floor(capacity.mlQueueCap * policy.maxIndustryShare))
  const strategyUsage = new Map<string, number>()
  const industryUsage = new Map<string, number>()
  const mlQueue: T[] = []
  const researchOnlyQueue: T[] = []
  const dropped: StrategyCandidateSelection<T>['dropped'] = []

  for (const entry of ordered) {
    const symbol = cleanText(entry.candidate.symbol).toUpperCase()
    if (!symbol) continue
    const primaryStrategy = entry.strategy_id
    const industry = candidateIndustry(entry.candidate)
    const nextStrategyCount = (strategyUsage.get(primaryStrategy) ?? 0) + 1
    const nextIndustryCount = (industryUsage.get(industry) ?? 0) + 1
    const entryMaxMlShare = finiteNumber(entry.max_ml_share)
    const entryStrategyCap = entryMaxMlShare == null
      ? strategyCap
      : Math.max(1, Math.floor(capacity.mlQueueCap * clamp(entryMaxMlShare, 0, 1)))
    let reason = cleanText(entry.reason) || 'selected_by_strategy_pool'
    let decision: StrategyQueueDecision = 'ml_queue'

    if (!eligibleForMl(entry.candidate)) {
      decision = 'research_only_queue'
      reason = entry.candidate.restricted === true ? 'restricted_or_attention' : 'not_ml_eligible_segment'
    } else if (entryMaxMlShare === 0) {
      decision = 'research_only_queue'
      reason = 'strategy_research_discovery_lane_only'
    } else if (nextStrategyCount > entryStrategyCap) {
      decision = 'research_only_queue'
      reason = 'strategy_share_cap'
    } else if (nextIndustryCount > industryCap) {
      decision = 'research_only_queue'
      reason = 'industry_diversity_cap'
    } else if (mlQueue.length >= capacity.mlQueueCap) {
      decision = 'research_only_queue'
      reason = 'ml_capacity_overflow'
    }

    if (decision === 'ml_queue') {
      strategyUsage.set(primaryStrategy, nextStrategyCount)
      industryUsage.set(industry, nextIndustryCount)
      mlQueue.push(annotateSelection(entry, decision, reason, mlQueue.length + 1, entry.strategy_ids))
    } else if (researchOnlyQueue.length < capacity.researchQueueBudget) {
      const researchStrategyIds = uniqueTexts([...entry.strategy_ids, ...entry.research_strategy_ids])
      researchOnlyQueue.push(annotateSelection(entry, decision, reason, researchOnlyQueue.length + 1, researchStrategyIds))
    } else {
      dropped.push({ symbol, reason, strategy_ids: uniqueTexts([...entry.strategy_ids, ...entry.research_strategy_ids]) })
    }
  }

  return {
    version: STRATEGY_CANDIDATE_POOL_VERSION,
    capacity,
    pools,
    mlQueue,
    researchOnlyQueue,
    dropped,
    telemetry: {
      strategy_count: pools.length,
      pool_entries: pools.reduce((sum, pool) => sum + pool.candidates.length, 0),
      deduped_symbols: ordered.length,
      ml_queue_count: mlQueue.length,
      research_only_count: researchOnlyQueue.length,
      dropped_count: dropped.length,
      overflow_count: researchOnlyQueue.length + dropped.length,
      estimated_batch_chunks: Math.ceil(mlQueue.length / 40),
      strategy_usage: Object.fromEntries([...strategyUsage.entries()].sort()),
      industry_usage: Object.fromEntries([...industryUsage.entries()].sort()),
    },
  }
}

export function planStrategyFirstCandidateSelection<T extends StrategyCandidatePoolCandidate>(
  candidates: T[],
  specs: StrategySpec[],
  options: {
    regime?: AlphaFrameworkRegime | string | null
    capacity?: StrategyCapacityInput
    policy?: StrategyCandidatePoolPolicy
    strategyWeights?: Record<string, number>
    mlQueueCapOverride?: number
  } = {},
): StrategyCandidateSelection<T> {
  const policy = options.policy ?? DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY
  const capacity = resolveStrategyCapacityBudget(options.capacity, policy)
  if (options.mlQueueCapOverride != null) {
    capacity.mlQueueCap = clamp(Math.round(options.mlQueueCapOverride), 1, capacity.totalCap)
    capacity.researchQueueBudget = Math.max(0, policy.hardTotalCap - capacity.mlQueueCap)
  }
  const pools = buildStrategyCandidatePools(candidates, specs, {
    regime: options.regime,
    policy,
    strategyWeights: options.strategyWeights,
  })
  return mergeStrategyCandidatePools(pools, capacity, policy)
}

function rawSignalFallbackValue(candidate: StrategyCandidatePoolCandidate): number {
  const raw = deriveStrategyRawSignals(strategyInputFromPoolCandidate(candidate))
  const liquidity = candidateLiquidity(candidate)
  const liquidityBonus = liquidity == null ? 0 : clamp(Math.log10(Math.max(liquidity, 1)) - 7, 0, 3)
  return Math.round(rawSignalSuitabilityScore(raw, liquidityBonus) * 1000) / 1000
}

function annotateLayer1TopUp<T extends StrategyCandidatePoolCandidate>(
  candidate: T,
  rank: number,
): T {
  const cloned = cloneCandidate(candidate)
  cloned.strategy_pool_decision = 'research_only_queue'
  cloned.strategy_pool_reason = 'raw_signal_top_up_observe_after_l15_adaptive_slate'
  cloned.strategy_pool_rank = rank
  cloned.strategy_pool_ids = []
  cloned.strategy_family_ids = []
  cloned.strategy_variant_ids = []
  cloned.strategy_owner_types = ['observe']
  cloned.research_strategy_ids = []
  cloned.strategy_pool_fallback_source = 'raw_signal_top_up'
  cloned.strategy_pool_score = rawSignalFallbackValue(candidate)
  cloned.strategy_tags = uniqueTexts([...(cloned.strategy_tags ?? []), 'strategy_pool:raw_signal_top_up_observe'])
  cloned.strategy_watch_points = uniqueTexts([
    ...(cloned.strategy_watch_points ?? []),
    'strategy_pool:raw_signal_top_up_observe_after_l15_adaptive_slate',
    'strategy_pool:not_formal_l2_queue',
  ])
  return cloned
}

export function buildLayer1StrategyBreadthPlan<T extends StrategyCandidatePoolCandidate>(
  featureEnrichedUniverse: T[],
  specs: StrategySpec[],
  options: {
    targetSize: number
    coarseMlQueueSize: number
    regime?: AlphaFrameworkRegime | string | null
    strategyWeights?: Record<string, number>
    strategyPortfolioMetrics?: Record<string, Partial<StrategyPortfolioMetrics>>
    strategyPortfolioMetricSource?: string
    strategySimilarityGraphEvidence?: StrategySimilarityGraphEvidence | null
    runtimeTeacherEvidence?: Record<string, Record<string, number>>
    policy?: StrategyCandidatePoolPolicy
  },
): Layer1StrategyBreadthPlan<T> {
  const targetSize = Math.max(1, Math.round(options.targetSize))
  const coarseMlQueueSize = Math.max(1, Math.min(Math.round(options.coarseMlQueueSize), targetSize))
  const basePolicy = options.policy ?? DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY
  const policy: StrategyCandidatePoolPolicy = {
    ...basePolicy,
    baseTotalBudget: Math.min(basePolicy.baseTotalBudget, targetSize),
    normalTotalCap: Math.max(basePolicy.normalTotalCap, targetSize),
    lowLoadTotalCap: Math.max(basePolicy.lowLoadTotalCap, targetSize),
    hardTotalCap: Math.max(basePolicy.hardTotalCap, targetSize),
  }
  const selection = planStrategyFirstCandidateSelection(featureEnrichedUniverse, specs, {
    regime: options.regime,
    strategyWeights: options.strategyWeights,
    policy,
    capacity: { requestedTotalCap: targetSize },
    mlQueueCapOverride: targetSize,
  })
  const routerPlan = buildMultiStrategyPleRoutingPlan(featureEnrichedUniverse, specs, {
    maxSlateSize: targetSize,
    regime: options.regime,
    strategyWeights: options.strategyWeights,
    strategyPortfolioMetrics: options.strategyPortfolioMetrics,
    strategySimilarityGraphEvidence: options.strategySimilarityGraphEvidence,
    runtimeTeacherEvidence: options.runtimeTeacherEvidence,
  })

  const selectedSymbols = new Set(routerPlan.mlSlate.map((candidate) => cleanText(candidate.symbol).toUpperCase()))
  const strategySelected = routerPlan.mlSlate.slice(0, targetSize)
  const topUp = featureEnrichedUniverse
    .filter((candidate) => {
      const symbol = cleanText(candidate.symbol).toUpperCase()
      if (!symbol || selectedSymbols.has(symbol)) return false
      if (!eligibleForMl(candidate)) return false
      if (!passesLayer1TopUpQualityGuard(candidate)) return false
      return true
    })
    .sort((a, b) => rawSignalFallbackValue(b) - rawSignalFallbackValue(a))
    .slice(0, Math.max(0, targetSize - strategySelected.length))
    .map((candidate, index) => annotateLayer1TopUp(candidate, strategySelected.length + index + 1))

  const breadthPool = [...strategySelected, ...topUp].slice(0, targetSize)
  const formalCoarseQueue = strategySelected

  return {
    version: `${STRATEGY_CANDIDATE_POOL_VERSION}:layer1-breadth-v1`,
    sourceUniverseCount: featureEnrichedUniverse.length,
    breadthPool,
    coarseQueue: formalCoarseQueue,
    researchOnlyQueue: selection.researchOnlyQueue,
    selection,
    telemetry: {
      selection_order: 'full_feature_enriched_universe_strategy_only_with_raw_signal_observe',
      target_size: targetSize,
      coarse_ml_queue_size: formalCoarseQueue.length,
      coarse_ml_target_size: coarseMlQueueSize,
      strategy_selected_count: strategySelected.length,
      raw_signal_top_up_count: topUp.length,
      source_universe_count: featureEnrichedUniverse.length,
      strategy_labeler_version: routerPlan.labeler_version,
      finlab_portfolio_intelligence_version: routerPlan.portfolio_intelligence_version,
      l15_router_version: routerPlan.version,
      l15_router_selection_order: routerPlan.selection_order,
      l15_router_slate_selection_policy: routerPlan.telemetry.slate_selection_policy,
      l15_router_ml_slate_count: routerPlan.telemetry.ml_slate_count,
      l15_router_observe_only_count: routerPlan.telemetry.observe_only_count,
      l15_router_capacity_overflow_count: routerPlan.telemetry.capacity_overflow_count,
      strategy_matrix_candidate_count: routerPlan.telemetry.strategy_matrix_candidate_count,
      strategy_matrix_strategy_count: routerPlan.telemetry.strategy_matrix_strategy_count,
      strategy_matrix_cell_count: routerPlan.telemetry.strategy_matrix_cell_count,
      strategy_matrix_expected_cell_count: routerPlan.telemetry.strategy_matrix_expected_cell_count,
      strategy_matrix_coverage_ratio: routerPlan.telemetry.strategy_matrix_coverage_ratio,
      strategy_matrix_matched_candidate_count: routerPlan.telemetry.matched_candidates,
      strategy_matrix_active_labeled_candidate_count: routerPlan.telemetry.active_labeled_candidates,
      min_route_score: routerPlan.telemetry.min_route_score,
      min_route_score_source: routerPlan.telemetry.min_route_score_source,
      route_score_distribution: routerPlan.telemetry.route_score_distribution,
      route_score_above_floor_count: routerPlan.telemetry.route_score_above_floor_count,
      route_score_below_floor_count: routerPlan.telemetry.route_score_below_floor_count,
      teacher_label_available_count: routerPlan.telemetry.teacher_label_available_count,
      teacher_label_missing_count: routerPlan.telemetry.teacher_label_missing_count,
      teacher_label_contract: routerPlan.telemetry.teacher_label_contract,
      runtime_teacher_evidence_policy: routerPlan.telemetry.runtime_teacher_evidence_policy,
      runtime_teacher_evidence_available_count: routerPlan.telemetry.runtime_teacher_evidence_available_count,
      runtime_teacher_evidence_missing_count: routerPlan.telemetry.runtime_teacher_evidence_missing_count,
      strategy_metric_status_counts: routerPlan.telemetry.strategy_metric_status_counts,
      strategy_metric_ready_count: routerPlan.telemetry.strategy_metric_ready_count,
      strategy_metric_no_evidence_count: routerPlan.telemetry.strategy_metric_no_evidence_count,
      strategy_similarity_evidence_source: routerPlan.telemetry.strategy_similarity_evidence_source,
      strategy_similarity_algorithm_owner: routerPlan.telemetry.strategy_similarity_algorithm_owner,
      strategy_similarity_medoid_algorithm: routerPlan.telemetry.strategy_similarity_medoid_algorithm,
      strategy_similarity_blocked_reason: routerPlan.telemetry.strategy_similarity_blocked_reason,
      strategy_portfolio_metric_source: options.strategyPortfolioMetricSource,
      strategy_portfolio_metric_count: Object.keys(options.strategyPortfolioMetrics ?? {}).length,
    },
  }
}
