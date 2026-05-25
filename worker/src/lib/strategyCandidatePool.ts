import {
  assessCandidateAgainstStrategySpecs,
  deriveStrategyThresholdScores,
  validateStrategySpec,
  type StrategyCandidateInput,
  type StrategySpec,
  type StrategySpecStatus,
} from './strategySpec'
import type { AlphaFrameworkBucket, AlphaFrameworkRegime } from './tradingConfig'
import { assertOwnerCanOwn } from './strategyOwnerFreeze'

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
  score_components?: unknown
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
  strategy_pool_decision?: StrategyQueueDecision
  strategy_pool_reason?: string
  strategy_matches?: Array<{ specId: string; alphaBucket: string; status: string; label: string; reason: string }>
  strategy_tags?: string[]
  strategy_watch_points?: string[]
}

export interface StrategyPoolEntry<T extends StrategyCandidatePoolCandidate = StrategyCandidatePoolCandidate> {
  strategy_id: string
  strategy_name: string
  alpha_bucket: AlphaFrameworkBucket
  strategy_status: StrategySpecStatus
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
}

export interface StrategyPool<T extends StrategyCandidatePoolCandidate = StrategyCandidatePoolCandidate> {
  strategy_id: string
  strategy_name: string
  alpha_bucket: AlphaFrameworkBucket
  strategy_status: StrategySpecStatus
  quota: number
  cost_budget: number
  evidence_requirements: string[]
  regime_scope: string[]
  regime_weight: number
  status: 'ready' | 'adaptive_near_match' | 'out_of_regime' | 'invalid_spec'
  missing_evidence: string[]
  candidates: Array<StrategyPoolEntry<T>>
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
  momentumProxy: number
} {
  const canonical = deriveStrategyThresholdScores(strategyInputFromPoolCandidate(candidate))
  return {
    seedScore: canonical.seedScore,
    chipFlow: canonical.chipFlow,
    technicalStructure: canonical.technicalStructure,
    momentumProxy: canonical.momentumProxy,
  }
}

function strategyInputFromPoolCandidate(candidate: StrategyCandidatePoolCandidate): StrategyCandidateInput {
  const { score_components, ...rest } = candidate
  return {
    ...rest,
    score_v2: candidate.score_v2 ?? score_components,
  }
}

function thresholdNearMisses(candidate: StrategyCandidatePoolCandidate, spec: StrategySpec): string[] | null {
  const thresholds = spec.thresholds
  const industry = cleanText(candidate.industry ?? candidate.sector)
  const includes = thresholds.includeIndustries?.map(cleanText).filter(Boolean) ?? []
  const excludes = thresholds.excludeIndustries?.map(cleanText).filter(Boolean) ?? []
  if (includes.length && !includes.includes(industry)) return null
  if (excludes.length && excludes.includes(industry)) return null

  const price = finiteNumber(candidate.current_price)
  if (thresholds.minPrice != null && (price == null || price < thresholds.minPrice)) return null
  if (thresholds.maxPrice != null && (price == null || price > thresholds.maxPrice)) return null

  const scores = candidatePoolThresholdScores(candidate)
  const checks: Array<[string, unknown, number | undefined]> = [
    ['score', scores.seedScore, thresholds.minSeedScore],
    ['chip', scores.chipFlow, thresholds.minChipScore],
    ['technical', scores.technicalStructure, thresholds.minTechScore],
    ['momentum', scores.momentumProxy, thresholds.minMomentumScore],
  ]
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

function eligibleForMl(candidate: StrategyCandidatePoolCandidate): boolean {
  if (candidate.restricted === true) return false
  if (candidate.eligible_for_ml === false || candidate.eligible_for_ml === 0) return false
  const segment = cleanText(candidate.market_segment).toUpperCase()
  if (segment === 'EMERGING') return false
  return true
}

function strategyScore(candidate: StrategyCandidatePoolCandidate, spec: StrategySpec, weight: number): number {
  const scores = candidatePoolThresholdScores(candidate)
  const score = scores.seedScore
  const chip = scores.chipFlow
  const tech = scores.technicalStructure
  const momentum = scores.momentumProxy
  const liquidity = candidateLiquidity(candidate)
  const liquidityBonus = liquidity == null ? 0 : clamp(Math.log10(Math.max(liquidity, 1)) - 7, 0, 3)
  const raw = score * 0.52 + chip * 0.2 + tech * 0.16 + momentum * 0.1 + liquidityBonus
  return Math.round(raw * statusWeight(spec.status) * weight * 1000) / 1000
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
    .map((spec) => {
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
          quota,
          cost_budget: costBudget,
          evidence_requirements: evidenceRequirements,
          regime_scope: spec.supportedRegimes.map(String),
          regime_weight: 0,
          status: 'invalid_spec',
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
          quota,
          cost_budget: costBudget,
          evidence_requirements: evidenceRequirements,
          regime_scope: spec.supportedRegimes.map(String),
          regime_weight: 0,
          status: 'out_of_regime',
          missing_evidence: ['regime_scope_mismatch'],
          candidates: [],
        }
      }

      let usedAdaptiveNearMatch = false
      let entries = candidates
        .map((candidate) => {
          const assessment = assessCandidateAgainstStrategySpecs(strategyInputFromPoolCandidate(candidate), [spec])
          if (!assessment.matches.length) return null
          const thresholdScores = candidatePoolThresholdScores(candidate)
          const scored = strategyScore(candidate, spec, rWeight)
          return {
            strategy_id: spec.id,
            strategy_name: spec.name,
            alpha_bucket: spec.alphaBucket,
            strategy_status: spec.status,
            quota,
            cost_budget: costBudget,
            evidence_requirements: evidenceRequirements,
            max_ml_share: maxMlShare,
            regime_weight: rWeight,
            candidate: cloneCandidate(candidate),
            raw_score: thresholdScores.seedScore,
            strategy_score: scored,
            rank: 0,
            reason: assessment.matches[0]?.reason ?? spec.thesis,
          } satisfies StrategyPoolEntry<T>
        })
        .filter((entry): entry is StrategyPoolEntry<T> => entry != null)
        .sort((a, b) => b.strategy_score - a.strategy_score)
        .slice(0, Math.min(quota, costBudget))
        .map((entry, index) => ({ ...entry, rank: index + 1 }))

      if (!entries.length) {
        usedAdaptiveNearMatch = true
        entries = candidates
          .map((candidate) => {
            const misses = thresholdNearMisses(candidate, spec)
            if (!misses) return null
            const thresholdScores = candidatePoolThresholdScores(candidate)
            const scored = Math.round((strategyScore(candidate, spec, rWeight) * 0.92 - misses.length * 1.5) * 1000) / 1000
            return {
              strategy_id: spec.id,
              strategy_name: spec.name,
              alpha_bucket: spec.alphaBucket,
              strategy_status: spec.status,
              quota,
              cost_budget: costBudget,
              evidence_requirements: evidenceRequirements,
              max_ml_share: maxMlShare,
              regime_weight: rWeight,
              candidate: cloneCandidate(candidate),
              raw_score: thresholdScores.seedScore,
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
      if (!entries.length) {
        usedAdaptiveNearMatch = true
        entries = candidates
          .map((candidate) => {
            const thresholdScores = candidatePoolThresholdScores(candidate)
            const scored = Math.round((strategyScore(candidate, spec, rWeight) * 0.86) * 1000) / 1000
            return {
              strategy_id: spec.id,
              strategy_name: spec.name,
              alpha_bucket: spec.alphaBucket,
              strategy_status: spec.status,
              quota,
              cost_budget: costBudget,
              evidence_requirements: evidenceRequirements,
              max_ml_share: maxMlShare,
              regime_weight: rWeight,
              candidate: cloneCandidate(candidate),
              raw_score: thresholdScores.seedScore,
              strategy_score: scored,
              rank: 0,
              reason: 'adaptive_empty_pool_ranked_proxy',
            } satisfies StrategyPoolEntry<T>
          })
          .sort((a, b) => b.strategy_score - a.strategy_score)
          .slice(0, Math.min(quota, costBudget))
          .map((entry, index) => ({ ...entry, rank: index + 1 }))
      }

      return {
        strategy_id: spec.id,
        strategy_name: spec.name,
        alpha_bucket: spec.alphaBucket,
        strategy_status: spec.status,
        quota,
        cost_budget: costBudget,
        evidence_requirements: evidenceRequirements,
        regime_scope: spec.supportedRegimes.map(String),
        regime_weight: rWeight,
        status: usedAdaptiveNearMatch && entries.length ? 'adaptive_near_match' : 'ready',
        missing_evidence: usedAdaptiveNearMatch && entries.length ? ['strict_threshold_match_empty'] : [],
        candidates: entries,
      }
    })
}

function annotateSelection<T extends StrategyCandidatePoolCandidate>(
  entry: StrategyPoolEntry<T>,
  decision: StrategyQueueDecision,
  reason: string,
  rank: number,
  strategyIds: string[],
): T {
  const candidate = cloneCandidate(entry.candidate)
  candidate.strategy_pool_score = entry.strategy_score
  candidate.strategy_pool_rank = rank
  candidate.strategy_pool_ids = strategyIds
  candidate.strategy_pool_decision = decision
  candidate.strategy_pool_reason = reason
  candidate.strategy_tags = uniqueTexts([
    ...(candidate.strategy_tags ?? []),
    `strategy_pool:${STRATEGY_CANDIDATE_POOL_VERSION}`,
    ...strategyIds.map((id) => `strategy:${id}`),
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
  const bestBySymbol = new Map<string, StrategyPoolEntry<T> & { strategy_ids: string[] }>()
  for (const pool of pools) {
    for (const entry of pool.candidates) {
      const symbol = cleanText(entry.candidate.symbol).toUpperCase()
      if (!symbol) continue
      const prev = bestBySymbol.get(symbol)
      if (!prev || entry.strategy_score > prev.strategy_score) {
        bestBySymbol.set(symbol, { ...entry, strategy_ids: uniqueTexts([...(prev?.strategy_ids ?? []), entry.strategy_id]) })
      } else {
        prev.strategy_ids = uniqueTexts([...prev.strategy_ids, entry.strategy_id])
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
      reason = 'strategy_shadow_lane_only'
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
      researchOnlyQueue.push(annotateSelection(entry, decision, reason, researchOnlyQueue.length + 1, entry.strategy_ids))
    } else {
      dropped.push({ symbol, reason, strategy_ids: entry.strategy_ids })
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
