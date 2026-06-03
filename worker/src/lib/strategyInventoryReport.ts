import {
  listStrategySpecsForLearning,
} from './strategyLearning'
import {
  normalizeStrategySpecGovernance,
  type StrategyFamilyId,
  type StrategyOwnerType,
  type StrategyPromotionStatus,
  type StrategySpec,
  type StrategySpecStatus,
} from './strategySpec'

export interface StrategyInventoryOptions {
  date: string
  statuses?: StrategySpecStatus[]
  overlapThreshold?: number
  limitPairs?: number
}

export interface StrategyInventoryReward {
  samples: number
  hitRate: number | null
  avgReturnPct: number | null
  maxDrawdownPct: number | null
  coverage: number | null
  updatedAt: string | null
}

export interface StrategyInventoryStrategy {
  strategyId: string
  version: string
  name: string
  status: StrategySpecStatus
  familyId: StrategyFamilyId
  variantId: string
  ownerType: StrategyOwnerType
  promotionStatus: StrategyPromotionStatus
  alphaBucket: string
  matchedCount: number
  uniqueSymbolCount: number
  symbolsPreview: string[]
  reward: StrategyInventoryReward | null
  dominantOverlapToSmaller: number | null
}

export interface StrategyFamilyInventory {
  familyId: StrategyFamilyId
  strategyCount: number
  activeStrategyCount: number
  variantCount: number
  ownerTypes: StrategyOwnerType[]
  promotionStatuses: StrategyPromotionStatus[]
  uniqueSymbolCount: number
  symbolsPreview: string[]
}

export interface StrategyOverlapPair {
  strategyA: string
  strategyB: string
  familyA: StrategyFamilyId
  familyB: StrategyFamilyId
  symbolsA: number
  symbolsB: number
  intersection: number
  union: number
  overlapToSmaller: number
  jaccard: number
  sameFamily: boolean
  duplicateRisk: 'high' | 'medium' | 'low'
  suggestedAction: 'review_retire_weaker_owner' | 'keep_distinct_variant' | 'observe'
}

export interface StrategyRetirementCandidate {
  strategyId: string
  reason: string
  overlappedWith: string
  overlapToSmaller: number
  familyId: StrategyFamilyId
  reward: StrategyInventoryReward | null
}

export interface StrategyInventoryReport {
  version: 'strategy_inventory_report_v1'
  date: string
  specSource: 'registry' | 'default_fallback'
  statusFilter: StrategySpecStatus[]
  totalSpecs: number
  formalStrategyOwners: number
  familySummary: StrategyFamilyInventory[]
  strategies: StrategyInventoryStrategy[]
  overlapPairs: StrategyOverlapPair[]
  retirementCandidates: StrategyRetirementCandidate[]
  notes: string[]
}

interface StrategyDecisionMatchRow {
  strategy_id: string
  strategy_version: string
  strategy_status: StrategySpecStatus
  symbol: string
}

interface StrategyRewardRow {
  strategy_id: string
  samples?: number | string | null
  hit_rate?: number | string | null
  avg_return_pct?: number | string | null
  max_drawdown_pct?: number | string | null
  coverage?: number | string | null
  updated_at?: string | null
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim()
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function roundMetric(value: number, decimals = 6): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function uniqueTexts(values: unknown[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))]
}

function safeStatuses(statuses: StrategySpecStatus[] | undefined): StrategySpecStatus[] {
  const allowed = new Set<StrategySpecStatus>(['research', 'shadow', 'candidate', 'active', 'retired'])
  const clean = uniqueTexts(statuses ?? ['active'])
    .filter((status): status is StrategySpecStatus => allowed.has(status as StrategySpecStatus))
  return clean.length ? clean : ['active']
}

function strategyKey(strategyId: string, version: string): string {
  return `${strategyId}::${version}`
}

function normalizeSpec(spec: StrategySpec): StrategySpec & {
  familyId: StrategyFamilyId
  variantId: string
  ownerType: StrategyOwnerType
  promotionStatus: StrategyPromotionStatus
} {
  const normalized = normalizeStrategySpecGovernance(spec)
  return {
    ...normalized,
    familyId: normalized.familyId!,
    variantId: normalized.variantId!,
    ownerType: normalized.ownerType!,
    promotionStatus: normalized.promotionStatus!,
  }
}

async function listMatchedSymbolsByStrategy(
  db: D1Database,
  date: string,
  specs: StrategySpec[],
): Promise<Map<string, Set<string>>> {
  const ids = uniqueTexts(specs.map((spec) => spec.id))
  const out = new Map<string, Set<string>>()
  for (const spec of specs) out.set(strategyKey(spec.id, spec.version), new Set())
  if (!ids.length) return out
  try {
    const placeholders = ids.map(() => '?').join(',')
    const { results } = await db.prepare(`
      SELECT strategy_id, strategy_version, strategy_status, symbol
        FROM strategy_decision_log
       WHERE date = ?
         AND matched = 1
         AND strategy_id IN (${placeholders})
       ORDER BY strategy_id ASC, symbol ASC
    `).bind(date, ...ids).all<StrategyDecisionMatchRow>()
    for (const row of results ?? []) {
      const symbol = cleanText(row.symbol)
      if (!symbol) continue
      const key = strategyKey(row.strategy_id, row.strategy_version)
      const bucket = out.get(key) ?? new Set<string>()
      bucket.add(symbol)
      out.set(key, bucket)
    }
  } catch {
    return out
  }
  return out
}

async function listLatestRewardsByStrategy(
  db: D1Database,
  specs: StrategySpec[],
): Promise<Map<string, StrategyInventoryReward>> {
  const ids = uniqueTexts(specs.map((spec) => spec.id))
  const out = new Map<string, StrategyInventoryReward>()
  if (!ids.length) return out
  try {
    const placeholders = ids.map(() => '?').join(',')
    const { results } = await db.prepare(`
      SELECT strategy_id, samples, hit_rate, avg_return_pct, max_drawdown_pct, coverage, updated_at
        FROM strategy_reward_ledger
       WHERE strategy_id IN (${placeholders})
       ORDER BY updated_at DESC, samples DESC
    `).bind(...ids).all<StrategyRewardRow>()
    for (const row of results ?? []) {
      const strategyId = cleanText(row.strategy_id)
      if (!strategyId || out.has(strategyId)) continue
      out.set(strategyId, {
        samples: Math.max(0, Math.round(finiteNumber(row.samples) ?? 0)),
        hitRate: finiteNumber(row.hit_rate),
        avgReturnPct: finiteNumber(row.avg_return_pct),
        maxDrawdownPct: finiteNumber(row.max_drawdown_pct),
        coverage: finiteNumber(row.coverage),
        updatedAt: row.updated_at ?? null,
      })
    }
  } catch {
    return out
  }
  return out
}

function rewardScore(reward: StrategyInventoryReward | null): number {
  if (!reward) return Number.NEGATIVE_INFINITY
  const samples = Math.min(1, reward.samples / 100)
  const avgReturn = reward.avgReturnPct ?? -0.01
  const hitRate = reward.hitRate ?? 0.5
  const drawdown = reward.maxDrawdownPct ?? -0.1
  return avgReturn * 2 + hitRate * 0.02 + drawdown * 0.5 + samples * 0.01
}

function buildOverlapPairs(
  strategies: StrategyInventoryStrategy[],
  symbolsByKey: Map<string, Set<string>>,
  threshold: number,
  limitPairs: number,
): StrategyOverlapPair[] {
  const pairs: StrategyOverlapPair[] = []
  for (let i = 0; i < strategies.length; i += 1) {
    for (let j = i + 1; j < strategies.length; j += 1) {
      const a = strategies[i]
      const b = strategies[j]
      const symbolsA = symbolsByKey.get(strategyKey(a.strategyId, a.version)) ?? new Set<string>()
      const symbolsB = symbolsByKey.get(strategyKey(b.strategyId, b.version)) ?? new Set<string>()
      const smaller = Math.min(symbolsA.size, symbolsB.size)
      if (smaller === 0) continue
      let intersection = 0
      for (const symbol of symbolsA) {
        if (symbolsB.has(symbol)) intersection += 1
      }
      if (intersection === 0) continue
      const union = symbolsA.size + symbolsB.size - intersection
      const overlapToSmaller = roundMetric(intersection / smaller)
      const jaccard = roundMetric(intersection / union)
      const sameFamily = a.familyId === b.familyId
      const duplicateRisk: StrategyOverlapPair['duplicateRisk'] =
        overlapToSmaller >= threshold ? 'high' : overlapToSmaller >= 0.7 ? 'medium' : 'low'
      pairs.push({
        strategyA: a.strategyId,
        strategyB: b.strategyId,
        familyA: a.familyId,
        familyB: b.familyId,
        symbolsA: symbolsA.size,
        symbolsB: symbolsB.size,
        intersection,
        union,
        overlapToSmaller,
        jaccard,
        sameFamily,
        duplicateRisk,
        suggestedAction: duplicateRisk === 'high' && sameFamily
          ? 'review_retire_weaker_owner'
          : sameFamily
            ? 'observe'
            : 'keep_distinct_variant',
      })
    }
  }
  return pairs
    .sort((a, b) => b.overlapToSmaller - a.overlapToSmaller || b.jaccard - a.jaccard)
    .slice(0, Math.max(1, limitPairs))
}

function buildFamilySummary(
  strategies: StrategyInventoryStrategy[],
  symbolsByKey: Map<string, Set<string>>,
): StrategyFamilyInventory[] {
  const buckets = new Map<StrategyFamilyId, {
    strategies: StrategyInventoryStrategy[]
    symbols: Set<string>
  }>()
  for (const strategy of strategies) {
    const bucket = buckets.get(strategy.familyId) ?? { strategies: [], symbols: new Set<string>() }
    bucket.strategies.push(strategy)
    const symbols = symbolsByKey.get(strategyKey(strategy.strategyId, strategy.version)) ?? new Set<string>()
    for (const symbol of symbols) bucket.symbols.add(symbol)
    buckets.set(strategy.familyId, bucket)
  }
  return [...buckets.entries()]
    .map(([familyId, bucket]) => ({
      familyId,
      strategyCount: bucket.strategies.length,
      activeStrategyCount: bucket.strategies.filter((strategy) => strategy.status === 'active' && strategy.ownerType === 'strategy').length,
      variantCount: uniqueTexts(bucket.strategies.map((strategy) => strategy.variantId)).length,
      ownerTypes: uniqueTexts(bucket.strategies.map((strategy) => strategy.ownerType)) as StrategyOwnerType[],
      promotionStatuses: uniqueTexts(bucket.strategies.map((strategy) => strategy.promotionStatus)) as StrategyPromotionStatus[],
      uniqueSymbolCount: bucket.symbols.size,
      symbolsPreview: [...bucket.symbols].sort().slice(0, 20),
    }))
    .sort((a, b) => a.familyId.localeCompare(b.familyId))
}

function buildRetirementCandidates(
  strategies: StrategyInventoryStrategy[],
  pairs: StrategyOverlapPair[],
  threshold: number,
): StrategyRetirementCandidate[] {
  const byId = new Map(strategies.map((strategy) => [strategy.strategyId, strategy]))
  const out: StrategyRetirementCandidate[] = []
  for (const pair of pairs) {
    if (pair.overlapToSmaller < threshold || !pair.sameFamily) continue
    const a = byId.get(pair.strategyA)
    const b = byId.get(pair.strategyB)
    if (!a || !b) continue
    const weaker = rewardScore(a.reward) <= rewardScore(b.reward) ? a : b
    const stronger = weaker.strategyId === a.strategyId ? b : a
    out.push({
      strategyId: weaker.strategyId,
      reason: 'high_overlap_same_family_weaker_reward',
      overlappedWith: stronger.strategyId,
      overlapToSmaller: pair.overlapToSmaller,
      familyId: weaker.familyId,
      reward: weaker.reward,
    })
  }
  const seen = new Set<string>()
  return out.filter((candidate) => {
    if (seen.has(candidate.strategyId)) return false
    seen.add(candidate.strategyId)
    return true
  })
}

export async function buildStrategyInventoryReport(
  db: D1Database,
  options: StrategyInventoryOptions,
): Promise<StrategyInventoryReport> {
  const statuses = safeStatuses(options.statuses)
  const overlapThreshold = Math.max(0.5, Math.min(1, options.overlapThreshold ?? 0.85))
  const limitPairs = Math.max(1, Math.min(500, Math.round(options.limitPairs ?? 100)))
  const { specs, source } = await listStrategySpecsForLearning(db)
  const normalizedSpecs = specs.map(normalizeSpec)
  const formalSpecs = normalizedSpecs.filter((spec) => statuses.includes(spec.status) && spec.ownerType === 'strategy')
  const [symbolsByKey, rewardsByStrategy] = await Promise.all([
    listMatchedSymbolsByStrategy(db, options.date, formalSpecs),
    listLatestRewardsByStrategy(db, formalSpecs),
  ])
  const strategies: StrategyInventoryStrategy[] = formalSpecs
    .map((spec) => {
      const symbols = symbolsByKey.get(strategyKey(spec.id, spec.version)) ?? new Set<string>()
      return {
        strategyId: spec.id,
        version: spec.version,
        name: spec.name,
        status: spec.status,
        familyId: spec.familyId,
        variantId: spec.variantId,
        ownerType: spec.ownerType,
        promotionStatus: spec.promotionStatus,
        alphaBucket: spec.alphaBucket,
        matchedCount: symbols.size,
        uniqueSymbolCount: symbols.size,
        symbolsPreview: [...symbols].sort().slice(0, 20),
        reward: rewardsByStrategy.get(spec.id) ?? null,
        dominantOverlapToSmaller: null,
      }
    })
    .sort((a, b) => b.uniqueSymbolCount - a.uniqueSymbolCount || a.strategyId.localeCompare(b.strategyId))
  const overlapPairs = buildOverlapPairs(strategies, symbolsByKey, overlapThreshold, limitPairs)
  const dominant = new Map<string, number>()
  for (const pair of overlapPairs) {
    dominant.set(pair.strategyA, Math.max(dominant.get(pair.strategyA) ?? 0, pair.overlapToSmaller))
    dominant.set(pair.strategyB, Math.max(dominant.get(pair.strategyB) ?? 0, pair.overlapToSmaller))
  }
  for (const strategy of strategies) {
    strategy.dominantOverlapToSmaller = dominant.get(strategy.strategyId) ?? null
  }
  return {
    version: 'strategy_inventory_report_v1',
    date: options.date,
    specSource: source,
    statusFilter: statuses,
    totalSpecs: normalizedSpecs.length,
    formalStrategyOwners: strategies.length,
    familySummary: buildFamilySummary(strategies, symbolsByKey),
    strategies,
    overlapPairs,
    retirementCandidates: buildRetirementCandidates(strategies, overlapPairs, overlapThreshold),
    notes: [
      'strategy_decision_log_matched_rows_are_overlap_source_of_truth',
      'raw_top_up_observe_rows_are_not_counted_as_formal_strategy_owner_overlap',
      'retirement_candidates_require_wei_approval_before_status_change',
    ],
  }
}
