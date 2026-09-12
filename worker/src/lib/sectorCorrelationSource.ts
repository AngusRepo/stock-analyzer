/** Read-only, date-bounded source for the EXISTING sector leader bonus kernel.
 * Cold/future/obsolete cache reconstructs from the explicitly supplied full
 * FinLab industry universe; no current cache overwrite or candidate-only ranking.
 */
import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { loadCoreStockIdentitiesBySymbols, loadMarketPriceHistoryBySymbols } from './stockIdentityMarketBridge'
import { computeSectorLeaderBonusFromInputs, deriveSectorLeaders } from './sectorCorrelation'
import { screenerOverlayCutoff } from './screenerOverlayReads'

type Member = { symbol: string; sector: string | null }
type CachedLeader = { sector: string; symbol: string; rank: number; computed_at: string }

function cacheTime(value: string): number {
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value
  return /(Z|[+-]\d{2}:\d{2})$/.test(utc) ? Date.parse(utc) : NaN
}

export async function readSectorLeaderBonusSnapshot(env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  input: { signalDate: string; observedAt: string; candidates: Member[]; fullIndustryUniverse: Member[];
    corrThreshold: number; bonusPoints: number }) {
  const { cutoff } = screenerOverlayCutoff(input.signalDate, input.observedAt)
  if (!Number.isFinite(input.corrThreshold) || input.corrThreshold < -1 || input.corrThreshold > 1
    || !Number.isFinite(input.bonusPoints) || input.bonusPoints < 0) throw new Error('sector_bonus_policy_invalid')
  const universe = new Map(input.fullIndustryUniverse.map(row => [row.symbol, row.sector]))
  if (universe.size !== input.fullIndustryUniverse.length
    || new Set(input.candidates.map(row => row.symbol)).size !== input.candidates.length
    || [...universe.keys()].some(symbol => !symbol || symbol !== symbol.trim())) throw new Error('sector_bonus_universe_invalid')
  const issues: string[] = []
  for (const row of input.candidates) {
    if (!universe.has(row.symbol) || !row.sector || universe.get(row.symbol) !== row.sector) {
      issues.push(`taxonomy_missing_or_mismatched:${row.symbol}`)
    }
  }
  const sectors = [...new Set(input.candidates.map(row => row.sector).filter((sector): sector is string => Boolean(sector)))].sort()
  const cached: CachedLeader[] = []
  let cacheStatus: 'read' | 'unavailable' = 'read'
  try {
    // Reserve binds for future date predicates; no huge IN list.
    for (let offset = 0; offset < sectors.length; offset += 36) {
      const part = sectors.slice(offset, offset + 36)
      const result = await databaseForDataDomain(env, 'market').prepare(`
        SELECT sector, symbol, rank, computed_at FROM sector_leaders
         WHERE sector IN (${part.map(() => '?').join(',')}) ORDER BY sector, rank, symbol
      `).bind(...part).all<CachedLeader>()
      if (!result.success || !Array.isArray(result.results)) throw new Error('sector_leader_cache_query_failed')
      cached.push(...result.results)
    }
  } catch {
    // Cache is an optimization, not the raw data authority. Discard all partial
    // cache results and reconstruct from the same original turnover kernel.
    cached.length = 0
    cacheStatus = 'unavailable'
  }
  const rebuiltSectors: string[] = []
  const leaders: Array<{ sector: string; symbol: string }> = []
  for (const sector of sectors) {
    const rows = cached.filter(row => row.sector === sector)
    const valid = rows.length > 0 && rows.length <= 3
      && new Set(rows.map(row => row.symbol)).size === rows.length
      && rows.every((row, i) => Number(row.rank) === i + 1 && universe.get(row.symbol) === sector
        && Number.isFinite(cacheTime(row.computed_at))
        && cacheTime(row.computed_at) < Date.parse(cutoff))
    if (valid) leaders.push(...rows.map(({ sector, symbol }) => ({ sector, symbol })))
    else rebuiltSectors.push(sector)
  }
  const rebuilding = new Set(rebuiltSectors)
  const fallbackMembers = input.fullIndustryUniverse.filter(row => row.sector && rebuilding.has(row.sector))
  for (const sector of rebuiltSectors) {
    if (!fallbackMembers.some(row => row.sector === sector)) issues.push(`industry_universe_missing:${sector}`)
  }
  const symbols = [...new Set([...input.candidates.map(row => row.symbol), ...leaders.map(row => row.symbol),
    ...fallbackMembers.map(row => row.symbol)])].sort()
  const identities = await loadCoreStockIdentitiesBySymbols(env, symbols, { requireQuerySuccess: true })
  for (const symbol of symbols) if (!identities.has(symbol)) issues.push(`identity_missing:${symbol}`)
  const prices = (await loadMarketPriceHistoryBySymbols(env, symbols,
    { onOrBeforeDate: input.signalDate, rowsPerSymbol: 120, requireQuerySuccess: true }))
    .map(({ symbol, date, close, volume }) => ({ symbol, date, close, volume }))
  const members = fallbackMembers.filter(row => identities.has(row.symbol))
    .map(row => ({ ...row, id: identities.get(row.symbol)!.id }))
  const reconstructed = deriveSectorLeaders(members, prices)
  leaders.push(...reconstructed.map(({ sector, symbol }) => ({ sector, symbol })))
  const priced = new Set(prices.map(row => row.symbol))
  // Missing peers can change the leader population/correlation just as missing
  // candidate prices can. Do not silently certify a partial sector source.
  for (const symbol of symbols) if (!priced.has(symbol)) issues.push(`price_history_missing:${symbol}`)
  const frozenInputs = { candidates: structuredClone(input.candidates), leaderRows: leaders, prices }
  const output = computeSectorLeaderBonusFromInputs(frozenInputs, input.corrThreshold, input.bonusPoints)
  return { schema_version: 'sector-bonus-frozen-inputs-v1' as const, signal_date: input.signalDate,
    observed_at: input.observedAt, cutoff, corr_threshold: input.corrThreshold, bonus_points: input.bonusPoints,
    rows_per_symbol: 120, cache_status: cacheStatus, cache_rows: cached,
    reconstructed_sectors: rebuiltSectors, reconstructed_leaders: reconstructed,
    full_industry_universe: structuredClone(input.fullIndustryUniverse), inputs: frozenInputs,
    output, issues, source_status: issues.length ? 'incomplete' as const : 'captured' as const }
}
