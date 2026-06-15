import {
  assessCandidateAgainstStrategySpecs,
  deriveStrategyRawSignals,
  normalizeStrategySpecGovernance,
  validateStrategySpec,
  type StrategyFamilyId,
  type StrategyOwnerType,
  type StrategySpec,
} from './strategySpec'
import type { AlphaFrameworkBucket, AlphaFrameworkRegime } from './tradingConfig'
import type { StrategyCandidatePoolCandidate, StrategyQueueDecision } from './strategyCandidatePool'

export const STRATEGY_LABELER_VERSION = 'strategy-labeler-v1'
export const FINLAB_PORTFOLIO_INTELLIGENCE_VERSION = 'finlab-portfolio-intelligence-v1'
export const MULTI_STRATEGY_PLE_ROUTER_VERSION = 'multi-strategy-ple-router-v1'
export const ACTIVE_9_ML_TEACHERS = [
  'LightGBM',
  'XGBoost',
  'ExtraTrees',
  'TabM',
  'GNN',
  'DLinear',
  'PatchTST',
  'iTransformer',
  'TimesFM',
] as const

export type StrategyRouterDecision = 'ml_slate' | 'observe_only' | 'research_only' | 'capacity_overflow'

export interface StrategyPortfolioMetrics {
  rolling_sharpe: number
  max_drawdown: number
  recent_alpha: number
  return_correlation: number
  holding_overlap: number
  turnover: number
  factor_crowding: number
  ic: number
  rank_ic: number
  shapley_contribution: number
  regime_performance: number
  live_backtest_divergence: number
  reliability: number
  crowding_score: number
  diversification_value: number
  prior_weight: number
}

export interface StrategyPortfolioPriorSnapshot {
  version: typeof FINLAB_PORTFOLIO_INTELLIGENCE_VERSION
  strategy_prior_weight: Record<string, number>
  family_prior_weight: Partial<Record<StrategyFamilyId, number>>
  strategy_reliability: Record<string, number>
  strategy_crowding_score: Record<string, number>
  strategy_diversification_value: Record<string, number>
  strategy_metrics: Record<string, StrategyPortfolioMetrics>
  strategy_weights: Record<string, number>
  family_weights: Partial<Record<StrategyFamilyId, number>>
  strategy_crowding: Record<string, number>
  family_crowding: Partial<Record<StrategyFamilyId, number>>
}

export interface MultiStrategyPleRouterComponents {
  [key: string]: number
  active_strategy_support: number
  raw_signal_quality: number
  cross_family_bonus: number
  same_family_crowding_penalty: number
  strategy_prior_weight: number
  family_prior_weight: number
  strategy_reliability: number
  strategy_crowding_score: number
  strategy_diversification_value: number
  diversity_contribution: number
  risk_adjusted_affinity: number
  uncertainty: number
  teacher_alignment: number
  research_signal_count: number
}

export interface MultiStrategyPleAnnotatedCandidate extends StrategyCandidatePoolCandidate {
  strategy_labeler_version?: typeof STRATEGY_LABELER_VERSION
  strategy_affinity_vector?: Record<string, number>
  strategy_weak_label_vector?: Record<string, number>
  strategy_hit_vector?: Record<string, number>
  strategy_position_weight_vector?: Record<string, number>
  strategy_overlap_vector?: Record<string, number>
  strategy_family_affinity?: Partial<Record<StrategyFamilyId, number>>
  strategy_portfolio_prior?: StrategyPortfolioPriorSnapshot
  strategy_router_version?: typeof MULTI_STRATEGY_PLE_ROUTER_VERSION
  strategy_router_score?: number
  candidate_route_score?: number
  ml_slate_eligibility?: number
  family_exposure?: Partial<Record<StrategyFamilyId, number>>
  diversity_contribution?: number
  risk_adjusted_affinity?: number
  uncertainty?: number
  ml_teacher_labels?: Record<string, number>
  strategy_router_decision?: StrategyRouterDecision
  strategy_router_reason?: string
  strategy_router_components?: MultiStrategyPleRouterComponents
}

interface StrategyLabel {
  strategy_id: string
  family_id: StrategyFamilyId
  variant_id: string
  alpha_bucket: AlphaFrameworkBucket
  owner_type: StrategyOwnerType
  status: StrategySpec['status']
  production_owner: boolean
  affinity: number
  weak_label: number
  strategy_hit: number
  position_weight: number
  overlap: number
}

interface CandidateLabelState<T extends StrategyCandidatePoolCandidate> {
  candidate: T
  symbol: string
  raw_quality: number
  labels: StrategyLabel[]
}

export interface MultiStrategyPleRoutingPlan<T extends StrategyCandidatePoolCandidate = StrategyCandidatePoolCandidate> {
  version: typeof MULTI_STRATEGY_PLE_ROUTER_VERSION
  labeler_version: typeof STRATEGY_LABELER_VERSION
  portfolio_intelligence_version: typeof FINLAB_PORTFOLIO_INTELLIGENCE_VERSION
  selection_order: 'l1_full_universe_labeler_l125_finlab_portfolio_l15_ple_router'
  source_universe_count: number
  max_slate_size: number
  mlSlate: Array<T & MultiStrategyPleAnnotatedCandidate>
  observeOnly: Array<T & MultiStrategyPleAnnotatedCandidate>
  telemetry: {
    strategy_count: number
    labeled_candidates: number
    matched_candidates: number
    active_labeled_candidates: number
    strategy_matrix_candidate_count: number
    strategy_matrix_strategy_count: number
    strategy_matrix_cell_count: number
    strategy_matrix_expected_cell_count: number
    strategy_matrix_coverage_ratio: number
    ml_slate_count: number
    observe_only_count: number
    capacity_overflow_count: number
    capacity_policy: 'max_only_no_minimum'
    strategy_usage: Record<string, number>
    family_usage: Partial<Record<StrategyFamilyId, number>>
  }
}

export interface MultiStrategyPleRoutingOptions {
  maxSlateSize: number
  regime?: AlphaFrameworkRegime | string | null
  strategyWeights?: Record<string, number>
  strategyPortfolioMetrics?: Record<string, Partial<StrategyPortfolioMetrics>>
  mlTeacherLabels?: Record<string, Record<string, number>>
  minRouteScore?: number
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim()
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function uniqueTexts(values: unknown[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))]
}

function eligibleForMl(candidate: StrategyCandidatePoolCandidate): boolean {
  if (candidate.restricted === true) return false
  if (candidate.eligible_for_ml === false || candidate.eligible_for_ml === 0) return false
  const segment = cleanText(candidate.market_segment).toUpperCase()
  if (segment === 'EMERGING') return false
  return true
}

function specRegimeWeight(spec: StrategySpec, regime?: string | null): number {
  const current = cleanText(regime).toLowerCase()
  if (!current || current === 'unknown' || current === 'all') return 1
  return spec.supportedRegimes.map(String).map((item) => item.toLowerCase()).includes(current) ? 1 : 0
}

function specCanEnterMlSlate(spec: StrategySpec): boolean {
  const maxMlShare = finiteNumber(spec.candidatePolicy?.maxMlShare)
  return spec.status === 'active' && spec.ownerType === 'strategy' && maxMlShare !== 0
}

function rawSignalQuality(candidate: StrategyCandidatePoolCandidate): number {
  const raw = deriveStrategyRawSignals(candidate)
  const trendScore =
    clamp((finiteNumber(raw.closeAboveMa20Pct) ?? 0) * 180, -12, 18)
    + clamp((finiteNumber(raw.closeAboveMa60Pct) ?? 0) * 120, -10, 14)
    + clamp(((finiteNumber(raw.volumeExpansion20) ?? 1) - 0.8) * 18, -6, 16)
    + clamp((finiteNumber(raw.return20d) ?? 0) * 80, -8, 12)
  const flowScore =
    clamp(Math.sign(finiteNumber(raw.brokerNetAmount5d) ?? 0) * Math.log10(Math.abs(finiteNumber(raw.brokerNetAmount5d) ?? 0) + 1), -10, 14)
    + clamp(Math.sign(finiteNumber(raw.foreignTrustNet5d) ?? 0) * Math.log10(Math.abs(finiteNumber(raw.foreignTrustNet5d) ?? 0) + 1), -8, 12)
    + clamp((finiteNumber(raw.brokerCount) ?? 0) / 3, 0, 8)
    - clamp((finiteNumber(raw.brokerConcentration) ?? 0) * 8, 0, 8)
  const qualityScore =
    clamp((finiteNumber(raw.revenueGrowthYoY) ?? 0) / 4, -8, 12)
    + clamp((finiteNumber(raw.monthlyRevenueYoY) ?? 0) / 4, -8, 12)
    + clamp((finiteNumber(raw.roe) ?? 0) / 2, -4, 12)
    + clamp((finiteNumber(raw.eps) ?? 0) * 2, -6, 12)
  return round3(clamp(45 + trendScore * 0.32 + flowScore * 0.32 + qualityScore * 0.24, 0, 100))
}

function buildCandidateLabelStates<T extends StrategyCandidatePoolCandidate>(
  candidates: T[],
  specs: StrategySpec[],
  options: MultiStrategyPleRoutingOptions,
): CandidateLabelState<T>[] {
  const normalizedSpecs = specs
    .filter((spec) => spec.status !== 'retired')
    .map(normalizeStrategySpecGovernance)
    .filter((spec) => validateStrategySpec(spec).ok)

  return candidates.map((candidate) => {
    const labels: StrategyLabel[] = []
    const rawQuality = rawSignalQuality(candidate)
    for (const spec of normalizedSpecs) {
      const regimeWeight = specRegimeWeight(spec, options.regime)
      const assessment = regimeWeight > 0
        ? assessCandidateAgainstStrategySpecs(candidate, [spec])
        : { matches: [] }
      const matched = assessment.matches.length > 0
      const configuredWeight = finiteNumber(options.strategyWeights?.[spec.id]) ?? 1
      const productionOwner = specCanEnterMlSlate(spec)
      const statusMultiplier = productionOwner ? 1 : spec.status === 'candidate' ? 0.75 : spec.status === 'shadow' ? 0.55 : 0.3
      labels.push({
        strategy_id: spec.id,
        family_id: spec.familyId!,
        variant_id: spec.variantId!,
        alpha_bucket: spec.alphaBucket,
        owner_type: spec.ownerType!,
        status: spec.status,
        production_owner: productionOwner,
        affinity: matched ? round3(clamp(rawQuality * configuredWeight * regimeWeight * statusMultiplier, 0, 100)) : 0,
        weak_label: 0,
        strategy_hit: matched ? 1 : 0,
        position_weight: 0,
        overlap: 0,
      })
    }
    const matchedAffinityTotal = labels.reduce((sum, item) => sum + (item.strategy_hit > 0 ? item.affinity : 0), 0)
    for (const label of labels) {
      label.weak_label = round3(label.affinity / 100)
      label.position_weight = label.strategy_hit > 0
        ? round3(label.affinity / Math.max(1, matchedAffinityTotal))
        : 0
    }
    return {
      candidate,
      symbol: cleanText(candidate.symbol).toUpperCase(),
      raw_quality: rawQuality,
      labels,
    }
  })
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  const out = {} as Record<T, number>
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

function average(values: number[], fallback = 0): number {
  const clean = values.filter((value) => Number.isFinite(value))
  if (!clean.length) return fallback
  return clean.reduce((sum, value) => sum + value, 0) / clean.length
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / Math.max(1, a.size + b.size - intersection)
}

function overrideNumber<T extends keyof StrategyPortfolioMetrics>(
  overrides: Partial<StrategyPortfolioMetrics> | undefined,
  key: T,
  fallback: number,
): number {
  const value = finiteNumber(overrides?.[key])
  return value == null ? fallback : value
}

function computeReliability(metrics: Pick<StrategyPortfolioMetrics,
  'rolling_sharpe' | 'max_drawdown' | 'recent_alpha' | 'ic' | 'rank_ic' | 'regime_performance' | 'live_backtest_divergence'
>): number {
  const sharpeScore = clamp((metrics.rolling_sharpe + 1) / 3, 0, 1)
  const drawdownScore = 1 - clamp(metrics.max_drawdown, 0, 1)
  const alphaScore = clamp(0.5 + metrics.recent_alpha * 5, 0, 1)
  const icScore = clamp(0.5 + average([metrics.ic, metrics.rank_ic]) * 3, 0, 1)
  const regimeScore = clamp(0.5 + metrics.regime_performance * 2, 0, 1)
  const divergenceScore = 1 - clamp(metrics.live_backtest_divergence, 0, 1)
  return round3(
    sharpeScore * 0.22
    + drawdownScore * 0.18
    + alphaScore * 0.18
    + icScore * 0.18
    + regimeScore * 0.12
    + divergenceScore * 0.12,
  )
}

function computeCrowdingScore(metrics: Pick<StrategyPortfolioMetrics,
  'return_correlation' | 'holding_overlap' | 'turnover' | 'factor_crowding'
>): number {
  return round3(clamp(
    metrics.holding_overlap * 0.35
    + metrics.return_correlation * 0.25
    + metrics.turnover * 0.15
    + metrics.factor_crowding * 0.25,
    0,
    1,
  ))
}

function computeDiversificationValue(metrics: Pick<StrategyPortfolioMetrics,
  'return_correlation' | 'holding_overlap' | 'factor_crowding'
>): number {
  return round3(clamp(
    1 - (metrics.holding_overlap * 0.4 + metrics.return_correlation * 0.35 + metrics.factor_crowding * 0.25),
    0,
    1,
  ))
}

function computePriorWeight(metrics: Pick<StrategyPortfolioMetrics,
  'reliability' | 'crowding_score' | 'diversification_value' | 'shapley_contribution'
>): number {
  return round3(clamp(
    0.2
    + metrics.reliability * 0.85
    + metrics.diversification_value * 0.5
    - metrics.crowding_score * 0.35
    + Math.max(0, metrics.shapley_contribution) * 0.25,
    0.15,
    1.8,
  ))
}

function parseNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const cleanKey = cleanText(key)
    const n = finiteNumber(rawValue)
    if (cleanKey && n != null) out[cleanKey] = round3(n)
  }
  return out
}

function teacherLabelsForCandidate(
  candidate: StrategyCandidatePoolCandidate,
  options: MultiStrategyPleRoutingOptions,
): Record<string, number> {
  const symbol = cleanText(candidate.symbol).toUpperCase()
  const direct = options.mlTeacherLabels?.[symbol]
    ?? (candidate as unknown as { ml_teacher_labels?: unknown }).ml_teacher_labels
    ?? (candidate as unknown as { model_teacher_labels?: unknown }).model_teacher_labels
  const parsed = parseNumberRecord(direct)
  if (Object.keys(parsed).length) return parsed
  return {}
}

function portfolioPriorForLabels(
  states: CandidateLabelState<StrategyCandidatePoolCandidate>[],
  specs: StrategySpec[],
  overrides: Record<string, Partial<StrategyPortfolioMetrics>> = {},
): StrategyPortfolioPriorSnapshot {
  const validSpecs = specs
    .filter((spec) => spec.status !== 'retired')
    .map(normalizeStrategySpecGovernance)
    .filter((spec) => validateStrategySpec(spec).ok)
  const hitLabels = states.flatMap((state) => state.labels.filter((label) => label.strategy_hit > 0 && label.affinity > 0))
  const strategyCounts = countBy(hitLabels.map((label) => label.strategy_id))
  const familyCounts = countBy(hitLabels.map((label) => label.family_id))
  const strategySymbols = new Map<string, Set<string>>()
  const labelsByStrategy = new Map<string, StrategyLabel[]>()
  const specById = new Map(validSpecs.map((spec) => [spec.id, spec]))
  for (const state of states) {
    for (const label of state.labels) {
      if (label.strategy_hit > 0 && label.affinity > 0) {
        if (!strategySymbols.has(label.strategy_id)) strategySymbols.set(label.strategy_id, new Set())
        strategySymbols.get(label.strategy_id)!.add(state.symbol)
      }
      const labels = labelsByStrategy.get(label.strategy_id) ?? []
      labels.push(label)
      labelsByStrategy.set(label.strategy_id, labels)
    }
  }

  const strategy_prior_weight: Record<string, number> = {}
  const family_prior_weight: Partial<Record<StrategyFamilyId, number>> = {}
  const strategy_reliability: Record<string, number> = {}
  const strategy_crowding_score: Record<string, number> = {}
  const strategy_diversification_value: Record<string, number> = {}
  const strategy_metrics: Record<string, StrategyPortfolioMetrics> = {}
  const strategy_weights: Record<string, number> = {}
  const family_weights: Partial<Record<StrategyFamilyId, number>> = {}
  const strategy_crowding: Record<string, number> = {}
  const family_crowding: Partial<Record<StrategyFamilyId, number>> = {}

  for (const spec of validSpecs) {
    const strategyId = spec.id
    const count = strategyCounts[strategyId] ?? 0
    const labels = labelsByStrategy.get(strategyId) ?? []
    const positiveLabels = labels.filter((label) => label.strategy_hit > 0 && label.affinity > 0)
    const ownSymbols = strategySymbols.get(strategyId) ?? new Set()
    let maxOverlap = 0
    for (const [otherId, otherSymbols] of strategySymbols.entries()) {
      if (otherId === strategyId) continue
      maxOverlap = Math.max(maxOverlap, jaccard(ownSymbols, otherSymbols))
    }
    const familyId = labels[0]?.family_id ?? spec?.familyId
    const familyCount = familyId ? (familyCounts[familyId] ?? count) : count
    const universeCount = Math.max(1, states.length)
    const supportRatio = count / universeCount
    const familySupportRatio = familyCount / universeCount
    const avgAffinity = average(positiveLabels.map((label) => label.affinity), 0) / 100
    const poolQuota = finiteNumber(spec?.candidatePolicy?.poolQuota) ?? 12
    const rawTurnover = clamp(0.12 + supportRatio * 0.52 + (poolQuota / 20) * 0.18, 0, 1)
    const derived = {
      rolling_sharpe: round3(clamp((avgAffinity - 0.5) * 4, -1.2, 2.2)),
      max_drawdown: round3(clamp(0.08 + supportRatio * 0.38 + maxOverlap * 0.2, 0.03, 0.75)),
      recent_alpha: round3(clamp((avgAffinity - 0.5) * 0.18, -0.12, 0.18)),
      return_correlation: round3(clamp(maxOverlap * 0.72 + familySupportRatio * 0.28, 0, 1)),
      holding_overlap: round3(clamp(maxOverlap, 0, 1)),
      turnover: round3(rawTurnover),
      factor_crowding: round3(clamp(familySupportRatio * 0.75 + supportRatio * 0.25, 0, 1)),
      ic: round3(clamp((avgAffinity - 0.5) * 0.42, -0.25, 0.3)),
      rank_ic: round3(clamp((avgAffinity - 0.5) * 0.48, -0.28, 0.35)),
      shapley_contribution: round3(clamp(avgAffinity / Math.sqrt(Math.max(1, familyCount)), 0, 1)),
      regime_performance: round3(clamp((avgAffinity - 0.5) * 0.24, -0.2, 0.24)),
      live_backtest_divergence: round3(clamp(maxOverlap * 0.22 + supportRatio * 0.18, 0, 0.85)),
    }
    const rawOverride = overrides[strategyId]
    const baseMetrics = {
      rolling_sharpe: overrideNumber(rawOverride, 'rolling_sharpe', derived.rolling_sharpe),
      max_drawdown: overrideNumber(rawOverride, 'max_drawdown', derived.max_drawdown),
      recent_alpha: overrideNumber(rawOverride, 'recent_alpha', derived.recent_alpha),
      return_correlation: overrideNumber(rawOverride, 'return_correlation', derived.return_correlation),
      holding_overlap: overrideNumber(rawOverride, 'holding_overlap', derived.holding_overlap),
      turnover: overrideNumber(rawOverride, 'turnover', derived.turnover),
      factor_crowding: overrideNumber(rawOverride, 'factor_crowding', derived.factor_crowding),
      ic: overrideNumber(rawOverride, 'ic', derived.ic),
      rank_ic: overrideNumber(rawOverride, 'rank_ic', derived.rank_ic),
      shapley_contribution: overrideNumber(rawOverride, 'shapley_contribution', derived.shapley_contribution),
      regime_performance: overrideNumber(rawOverride, 'regime_performance', derived.regime_performance),
      live_backtest_divergence: overrideNumber(rawOverride, 'live_backtest_divergence', derived.live_backtest_divergence),
    }
    const reliability = overrideNumber(rawOverride, 'reliability', computeReliability(baseMetrics))
    const crowdingScore = overrideNumber(rawOverride, 'crowding_score', computeCrowdingScore(baseMetrics))
    const diversificationValue = overrideNumber(rawOverride, 'diversification_value', computeDiversificationValue(baseMetrics))
    const priorWeight = overrideNumber(rawOverride, 'prior_weight', computePriorWeight({
      ...baseMetrics,
      reliability,
      crowding_score: crowdingScore,
      diversification_value: diversificationValue,
    }))
    const metrics: StrategyPortfolioMetrics = {
      ...baseMetrics,
      reliability: round3(clamp(reliability, 0, 1)),
      crowding_score: round3(clamp(crowdingScore, 0, 1)),
      diversification_value: round3(clamp(diversificationValue, 0, 1)),
      prior_weight: round3(clamp(priorWeight, 0.15, 1.8)),
    }
    strategy_metrics[strategyId] = metrics
    strategy_prior_weight[strategyId] = metrics.prior_weight
    strategy_reliability[strategyId] = metrics.reliability
    strategy_crowding_score[strategyId] = metrics.crowding_score
    strategy_diversification_value[strategyId] = metrics.diversification_value
    strategy_weights[strategyId] = metrics.prior_weight
    strategy_crowding[strategyId] = metrics.crowding_score
  }
  const familyIds = uniqueTexts(validSpecs.map((spec) => spec.familyId)) as StrategyFamilyId[]
  for (const familyId of familyIds) {
    const count = familyCounts[familyId] ?? 0
    const familyStrategyMetrics = Object.entries(strategy_metrics)
      .filter(([strategyId]) => specById.get(strategyId)?.familyId === familyId)
      .map(([, metrics]) => metrics)
    const crowding = round3(clamp(average(familyStrategyMetrics.map((metrics) => metrics.crowding_score), count / Math.max(1, states.length)), 0, 1))
    const prior = round3(clamp(average(familyStrategyMetrics.map((metrics) => metrics.prior_weight), 1) - crowding * 0.18, 0.15, 1.8))
    family_crowding[familyId] = crowding
    family_prior_weight[familyId] = prior
    family_weights[familyId] = prior
  }

  return {
    version: FINLAB_PORTFOLIO_INTELLIGENCE_VERSION,
    strategy_prior_weight,
    family_prior_weight,
    strategy_reliability,
    strategy_crowding_score,
    strategy_diversification_value,
    strategy_metrics,
    strategy_weights,
    family_weights,
    strategy_crowding,
    family_crowding,
  }
}

function annotateCandidate<T extends StrategyCandidatePoolCandidate>(
  state: CandidateLabelState<T>,
  prior: StrategyPortfolioPriorSnapshot,
  maxSlateSize: number,
  minRouteScore: number,
  options: MultiStrategyPleRoutingOptions,
): T & MultiStrategyPleAnnotatedCandidate {
  const activeLabels = state.labels.filter((label) => label.production_owner && label.strategy_hit > 0 && label.affinity > 0)
  const researchLabels = state.labels.filter((label) => !label.production_owner && label.strategy_hit > 0 && label.affinity > 0)
  const familyIds = uniqueTexts(activeLabels.map((label) => label.family_id)) as StrategyFamilyId[]
  const activeStrategyIds = uniqueTexts(activeLabels.map((label) => label.strategy_id))
  const strategyAffinity = Object.fromEntries(state.labels.map((label) => [label.strategy_id, label.affinity]))
  const strategyWeakLabels = Object.fromEntries(state.labels.map((label) => [label.strategy_id, label.weak_label]))
  const strategyHitVector = Object.fromEntries(state.labels.map((label) => [label.strategy_id, label.strategy_hit]))
  const strategyOverlapVector = Object.fromEntries(state.labels.map((label) => [
    label.strategy_id,
    prior.strategy_metrics[label.strategy_id]?.holding_overlap ?? label.overlap,
  ]))
  const rawPositionWeights = Object.fromEntries(state.labels.map((label) => {
    const metrics = prior.strategy_metrics[label.strategy_id]
    const weight = label.affinity
      * (metrics?.prior_weight ?? 1)
      * (metrics?.reliability ?? 0.5)
      * (0.6 + (metrics?.diversification_value ?? 0.5) * 0.4)
      * (1 - (metrics?.crowding_score ?? 0) * 0.35)
    return [label.strategy_id, Math.max(0, weight)]
  }))
  const positionTotal = Math.max(1e-9, Object.values(rawPositionWeights).reduce((sum, value) => sum + value, 0))
  const strategyPositionWeights = Object.fromEntries(
    Object.entries(rawPositionWeights).map(([strategyId, value]) => [strategyId, round3(value / positionTotal)]),
  )
  const weightedSupportByFamily = activeLabels.reduce<Partial<Record<StrategyFamilyId, number>>>((out, label) => {
    const metrics = prior.strategy_metrics[label.strategy_id]
    const strategyPrior = metrics?.prior_weight ?? prior.strategy_prior_weight[label.strategy_id] ?? 1
    const familyPrior = prior.family_prior_weight[label.family_id] ?? 1
    const reliability = metrics?.reliability ?? 0.5
    const diversification = metrics?.diversification_value ?? 0.5
    const crowding = metrics?.crowding_score ?? 0
    const weighted = label.affinity
      * strategyPrior
      * familyPrior
      * reliability
      * (0.65 + diversification * 0.35)
      * (1 - crowding * 0.3)
    out[label.family_id] = round3(Math.max(out[label.family_id] ?? 0, weighted))
    return out
  }, {})
  const activeStrategySupport = Object.values(weightedSupportByFamily).reduce((sum, value) => sum + (value ?? 0), 0)
  const scaledActiveSupport = familyIds.length
    ? activeStrategySupport / Math.sqrt(familyIds.length)
    : 0
  const familyExposureTotal = Math.max(1e-9, Object.values(weightedSupportByFamily).reduce((sum, value) => sum + (value ?? 0), 0))
  const familyExposure = Object.fromEntries(
    Object.entries(weightedSupportByFamily).map(([familyId, value]) => [familyId, round3((value ?? 0) / familyExposureTotal)]),
  ) as Partial<Record<StrategyFamilyId, number>>
  const familyAffinity = Object.fromEntries(
    Object.entries(weightedSupportByFamily).map(([familyId, value]) => [familyId, round3(value ?? 0)]),
  ) as Partial<Record<StrategyFamilyId, number>>
  const activeMetrics = activeLabels
    .map((label) => prior.strategy_metrics[label.strategy_id])
    .filter((metrics): metrics is StrategyPortfolioMetrics => Boolean(metrics))
  const avgPrior = average(activeMetrics.map((metrics) => metrics.prior_weight), activeLabels.length ? 1 : 0)
  const avgFamilyPrior = average(activeLabels.map((label) => prior.family_prior_weight[label.family_id] ?? 1), activeLabels.length ? 1 : 0)
  const avgReliability = average(activeMetrics.map((metrics) => metrics.reliability), activeLabels.length ? 0.5 : 0)
  const avgCrowding = average(activeMetrics.map((metrics) => metrics.crowding_score), activeLabels.length ? 0 : 0)
  const avgDiversification = average(activeMetrics.map((metrics) => metrics.diversification_value), activeLabels.length ? 0.5 : 0)
  const crossFamilyBonus = Math.max(0, familyIds.length - 1) * 3
  const sameFamilyCrowdingPenalty = Math.max(0, activeLabels.length - familyIds.length) * 2
  const teacherLabels = teacherLabelsForCandidate(state.candidate, options)
  const teacherValues = Object.values(teacherLabels).filter((value) => Number.isFinite(value))
  const teacherAlignment = teacherValues.length
    ? round3(clamp(average(teacherValues.map((value) => clamp(value, 0, 1))), 0, 1))
    : 0.5
  const diversityContribution = round3(clamp(avgDiversification + Math.min(0.18, crossFamilyBonus / 40), 0, 1))
  const riskAdjustedAffinity = round3(clamp(
    scaledActiveSupport * (0.72 + avgReliability * 0.28) * (1 - avgCrowding * 0.22),
    0,
    100,
  ))
  const uncertainty = round3(clamp(
    0.58
    - Math.min(0.28, activeLabels.length * 0.07)
    - avgReliability * 0.18
    + avgCrowding * 0.22
    + (teacherValues.length ? -0.05 : 0.08),
    0,
    1,
  ))
  const routeScore = round3(clamp(
    riskAdjustedAffinity * 0.62
    + state.raw_quality * 0.2
    + diversityContribution * 8
    + teacherAlignment * 5
    - uncertainty * 5
    - sameFamilyCrowdingPenalty,
    0,
    100,
  ))
  const mlSlateEligibility = round3(clamp(routeScore / 100, 0, 1))
  let routerDecision: StrategyRouterDecision = 'observe_only'
  let routerReason = 'no_active_strategy_label'
  let queueDecision: StrategyQueueDecision = 'research_only_queue'
  if (!eligibleForMl(state.candidate)) {
    routerDecision = 'research_only'
    routerReason = state.candidate.restricted === true ? 'restricted_or_attention' : 'not_ml_eligible_segment'
  } else if (activeLabels.length > 0 && routeScore >= minRouteScore && maxSlateSize > 0) {
    routerDecision = 'ml_slate'
    routerReason = 'l15_ple_router_selected_by_strategy_portfolio_evidence'
    queueDecision = 'ml_queue'
  } else if (activeLabels.length > 0) {
    routerReason = 'l15_route_score_below_quality_floor'
  }

  const out: T & MultiStrategyPleAnnotatedCandidate = {
    ...state.candidate,
    strategy_labeler_version: STRATEGY_LABELER_VERSION,
    strategy_affinity_vector: strategyAffinity,
    strategy_weak_label_vector: strategyWeakLabels,
    strategy_hit_vector: strategyHitVector,
    strategy_position_weight_vector: strategyPositionWeights,
    strategy_overlap_vector: strategyOverlapVector,
    strategy_family_affinity: familyAffinity,
    strategy_portfolio_prior: prior,
    strategy_router_version: MULTI_STRATEGY_PLE_ROUTER_VERSION,
    strategy_router_score: routeScore,
    candidate_route_score: routeScore,
    ml_slate_eligibility: mlSlateEligibility,
    family_exposure: familyExposure,
    diversity_contribution: diversityContribution,
    risk_adjusted_affinity: riskAdjustedAffinity,
    uncertainty,
    ml_teacher_labels: teacherLabels,
    strategy_router_decision: routerDecision,
    strategy_router_reason: routerReason,
    strategy_router_components: {
      active_strategy_support: round3(scaledActiveSupport),
      raw_signal_quality: state.raw_quality,
      cross_family_bonus: round3(crossFamilyBonus),
      same_family_crowding_penalty: round3(sameFamilyCrowdingPenalty),
      strategy_prior_weight: round3(avgPrior),
      family_prior_weight: round3(avgFamilyPrior),
      strategy_reliability: round3(avgReliability),
      strategy_crowding_score: round3(avgCrowding),
      strategy_diversification_value: round3(avgDiversification),
      diversity_contribution: diversityContribution,
      risk_adjusted_affinity: riskAdjustedAffinity,
      uncertainty,
      teacher_alignment: teacherAlignment,
      research_signal_count: researchLabels.length,
    },
    strategy_pool_score: routeScore,
    strategy_pool_ids: activeStrategyIds,
    strategy_family_ids: familyIds,
    strategy_variant_ids: uniqueTexts(activeLabels.map((label) => label.variant_id)),
    strategy_owner_types: uniqueTexts(activeLabels.map((label) => label.owner_type)) as StrategyOwnerType[],
    research_strategy_ids: uniqueTexts(researchLabels.map((label) => label.strategy_id)),
    strategy_pool_decision: queueDecision,
    strategy_pool_reason: routerReason,
    strategy_tags: uniqueTexts([
      ...(state.candidate.strategy_tags ?? []),
      `strategy_labeler:${STRATEGY_LABELER_VERSION}`,
      `strategy_router:${MULTI_STRATEGY_PLE_ROUTER_VERSION}`,
      ...activeStrategyIds.map((id) => `strategy:${id}`),
      ...familyIds.map((id) => `strategy_family:${id}`),
    ]),
    strategy_watch_points: uniqueTexts([
      ...(state.candidate.strategy_watch_points ?? []),
      `strategy_router_decision:${routerDecision}`,
      `strategy_router_score:${routeScore.toFixed(2)}`,
      `strategy_router_reason:${routerReason}`,
    ]),
  }
  return out
}

export function buildMultiStrategyPleRoutingPlan<T extends StrategyCandidatePoolCandidate>(
  candidates: T[],
  specs: StrategySpec[],
  options: MultiStrategyPleRoutingOptions,
): MultiStrategyPleRoutingPlan<T> {
  const maxSlateSize = Math.max(0, Math.round(options.maxSlateSize))
  const minRouteScore = finiteNumber(options.minRouteScore) ?? 20
  const states = buildCandidateLabelStates(candidates, specs, options)
  const strategyMatrixStrategyCount = states[0]?.labels.length
    ?? specs
      .filter((spec) => spec.status !== 'retired')
      .map(normalizeStrategySpecGovernance)
      .filter((spec) => validateStrategySpec(spec).ok).length
  const strategyMatrixCandidateCount = states.length
  const strategyMatrixExpectedCellCount = strategyMatrixCandidateCount * strategyMatrixStrategyCount
  const strategyMatrixCellCount = states.reduce((sum, state) => sum + state.labels.length, 0)
  const prior = portfolioPriorForLabels(states, specs, options.strategyPortfolioMetrics)
  const annotated = states.map((state) => annotateCandidate(state, prior, maxSlateSize, minRouteScore, options))
  const routed = annotated
    .filter((candidate) => candidate.strategy_router_decision === 'ml_slate')
    .sort((a, b) => (b.strategy_router_score ?? 0) - (a.strategy_router_score ?? 0))
  const selectedSymbols = new Set(routed.slice(0, maxSlateSize).map((candidate) => cleanText(candidate.symbol).toUpperCase()))
  const mlSlate = annotated
    .filter((candidate) => selectedSymbols.has(cleanText(candidate.symbol).toUpperCase()))
    .sort((a, b) => (b.strategy_router_score ?? 0) - (a.strategy_router_score ?? 0))
    .map((candidate, index) => ({
      ...candidate,
      strategy_pool_rank: index + 1,
      strategy_router_decision: 'ml_slate' as const,
      strategy_pool_decision: 'ml_queue' as const,
    }))
  const observeOnly = annotated
    .filter((candidate) => {
      const symbol = cleanText(candidate.symbol).toUpperCase()
      return !selectedSymbols.has(symbol)
    })
    .map((candidate) => {
      if (candidate.strategy_router_decision === 'ml_slate') {
        return {
          ...candidate,
          strategy_router_decision: 'capacity_overflow' as const,
          strategy_router_reason: 'l15_capacity_cap_not_minimum',
          strategy_pool_decision: 'research_only_queue' as const,
          strategy_pool_reason: 'l15_capacity_cap_not_minimum',
        }
      }
      return candidate
    })
  const strategyUsage = countBy(mlSlate.flatMap((candidate) => candidate.strategy_pool_ids ?? []))
  const familyUsage = countBy(mlSlate.flatMap((candidate) => candidate.strategy_family_ids ?? []) as StrategyFamilyId[])

  return {
    version: MULTI_STRATEGY_PLE_ROUTER_VERSION,
    labeler_version: STRATEGY_LABELER_VERSION,
    portfolio_intelligence_version: FINLAB_PORTFOLIO_INTELLIGENCE_VERSION,
    selection_order: 'l1_full_universe_labeler_l125_finlab_portfolio_l15_ple_router',
    source_universe_count: candidates.length,
    max_slate_size: maxSlateSize,
    mlSlate,
    observeOnly,
    telemetry: {
      strategy_count: strategyMatrixStrategyCount,
      labeled_candidates: states.length,
      matched_candidates: states.filter((state) => state.labels.some((label) => label.strategy_hit > 0 && label.affinity > 0)).length,
      active_labeled_candidates: states.filter((state) => state.labels.some((label) => label.production_owner && label.strategy_hit > 0 && label.affinity > 0)).length,
      strategy_matrix_candidate_count: strategyMatrixCandidateCount,
      strategy_matrix_strategy_count: strategyMatrixStrategyCount,
      strategy_matrix_cell_count: strategyMatrixCellCount,
      strategy_matrix_expected_cell_count: strategyMatrixExpectedCellCount,
      strategy_matrix_coverage_ratio: strategyMatrixExpectedCellCount > 0 ? round3(strategyMatrixCellCount / strategyMatrixExpectedCellCount) : 1,
      ml_slate_count: mlSlate.length,
      observe_only_count: observeOnly.length,
      capacity_overflow_count: observeOnly.filter((candidate) => candidate.strategy_router_decision === 'capacity_overflow').length,
      capacity_policy: 'max_only_no_minimum',
      strategy_usage: Object.fromEntries(Object.entries(strategyUsage).sort()),
      family_usage: Object.fromEntries(Object.entries(familyUsage).sort()) as Partial<Record<StrategyFamilyId, number>>,
    },
  }
}
