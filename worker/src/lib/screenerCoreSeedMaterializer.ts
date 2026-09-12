/** Actual formal Core seed materializer, also used for frozen candidate replay.
 * Pure: no reads, writes, new ranking policy or promotion authority.
 */
import { buildScreenerSeedRow, type ScreenerSeedCandidateInput } from './screenerSeedQuality'
import { hasPositiveStrategyAllocation } from './strategyProductionPolicyStore'

export interface CoreSeedCandidate extends ScreenerSeedCandidateInput {
  symbol: string
  strategy_tags?: string[]
  strategy_watch_points?: string[]
  strategy_pool_ids?: string[]
}

export interface ScreenerCoreSeedContext {
  prices: Map<string, number | null>
  selectionFlags: Map<string, { highFreq: boolean; newMoney: boolean; freq20d: number }>
  sectorBonus: Map<string, { bonus: number; avgCorr: number | null }>
  breezeWatchPoints: Map<string, string | null>
  chipMetadata: Map<string, string | null>
  taxonomyPoints: Map<string, string | null>
  tpexSymbols: Set<string>
  allocationWeights: Record<string, number>
}

export function materializeScreenerCoreSeeds(candidates: CoreSeedCandidate[], context: ScreenerCoreSeedContext) {
  return candidates.map((c, i) => {
      const currentPrice = context.prices.get(c.symbol) ?? null
      const flag = context.selectionFlags.get(c.symbol)
      const sectorB = context.sectorBonus.get(c.symbol)
      const breeze2WatchPoint = context.breezeWatchPoints.get(c.symbol)
      const chipMeta = context.chipMetadata.get(c.symbol)
      const taxPoint = context.taxonomyPoints.get(c.symbol)
      const tagParts: string[] = []
      if (flag?.highFreq) tagParts.push(`?? 擃 (20d ?仿 ${flag.freq20d} 甈?`)
      if (flag?.newMoney) tagParts.push('?? ?啗???(30d 擐?)')
      if (sectorB && sectorB.bonus > 0 && sectorB.avgCorr !== null) {
        tagParts.push(`?? ?黎??? (corr=${sectorB.avgCorr.toFixed(2)}, +${sectorB.bonus})`)
      }
      for (const tag of c.strategy_tags ?? []) tagParts.push(tag)
      const seed = buildScreenerSeedRow({
        candidate: c,
        rank: i + 1,
        currentPrice,
        sectorBonus: sectorB?.bonus ?? 0,
        tags: tagParts,
      })
      const watchPoints = Array.from(new Set([
        ...seed.watchPoints,
        `screener_funnel:rank=${i + 1},freq20d=${flag?.freq20d ?? 0},high_freq=${flag?.highFreq ? 'yes' : 'no'},new_money=${flag?.newMoney ? 'yes' : 'no'}`,
        ...(chipMeta ? [chipMeta] : ['chip_source:missing']),
        ...(taxPoint ? [taxPoint] : ['taxonomy:missing']),
        ...(breeze2WatchPoint ? [breeze2WatchPoint] : []),
        ...(c.strategy_watch_points ?? []),
      ]))
      const eligibleForPendingBuy = hasPositiveStrategyAllocation(
        c.strategy_pool_ids ?? [],
        context.allocationWeights,
      )
      return { seed, watchPoints, eligibleForPendingBuy,
        marketSegment: context.tpexSymbols.has(c.symbol) ? 'OTC' : 'LISTED' }
  })
}

/** Exact bindings of the existing formal upsert, shared with isolated replay. */
export function screenerCoreSeedUpsertBindings(runDate: string,
  row: ReturnType<typeof materializeScreenerCoreSeeds>[number]) {
  const { seed, watchPoints, eligibleForPendingBuy, marketSegment } = row
  return [runDate, seed.row.symbol, seed.row.symbol, seed.row.name, seed.row.sector,
    seed.rank, seed.row.seedScore, seed.row.chipScore, seed.row.techScore, seed.row.momentumScore,
    seed.row.currentPrice, seed.row.reason, JSON.stringify(watchPoints), seed.row.scoreComponents,
    seed.row.industry, marketSegment, 'tradable', 1, eligibleForPendingBuy ? 1 : 0]
}

/** Decode the existing JSON Map/Set representation, not live fallback reads. */
export function decodeScreenerCoreSeedContext(raw: unknown): ScreenerCoreSeedContext {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('core_seed_context_missing')
  const value = raw as Record<string, unknown>
  function map<T>(name: string, valid: (item: any) => boolean): Map<string, T> {
    const entries = (value[name] as { entries?: unknown } | undefined)?.entries
    if (!Array.isArray(entries) || entries.some(row => !Array.isArray(row) || row.length !== 2
      || typeof row[0] !== 'string' || !row[0] || row[0].trim() !== row[0] || !valid(row[1]))
      || new Set(entries.map(row => row[0])).size !== entries.length) throw new Error(`core_seed_context_map_invalid:${name}`)
    return new Map(entries as Array<[string, T]>)
  }
  if (!Array.isArray(value.tpexSymbols) || value.tpexSymbols.some(symbol => typeof symbol !== 'string')
    || !value.allocationWeights || typeof value.allocationWeights !== 'object' || Array.isArray(value.allocationWeights)
    || Object.values(value.allocationWeights).some(weight => typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0)) {
    throw new Error('core_seed_context_policy_invalid')
  }
  const finite = (item: unknown): item is number => typeof item === 'number' && Number.isFinite(item)
  const text = (item: unknown) => item === null || typeof item === 'string'
  return { prices: map('prices', item => item === null || finite(item)),
    selectionFlags: map('selectionFlags', item => item && typeof item.highFreq === 'boolean'
      && typeof item.newMoney === 'boolean' && Number.isInteger(item.freq20d) && item.freq20d >= 0),
    sectorBonus: map('sectorBonus', item => item && finite(item.bonus) && item.bonus >= 0
      && (item.avgCorr === null || finite(item.avgCorr) && Math.abs(item.avgCorr) <= 1)),
    breezeWatchPoints: map('breezeWatchPoints', text), chipMetadata: map('chipMetadata', text), taxonomyPoints: map('taxonomyPoints', text),
    tpexSymbols: new Set(value.tpexSymbols), allocationWeights: { ...value.allocationWeights } as Record<string, number> }
}
