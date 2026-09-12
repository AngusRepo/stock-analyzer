/** Candidate Core construction from the verified canonical source, never live
 * Core rows or another slate's semantic responses. Caller validates the parent
 * checksum, publication/deadline and baseline replay before entering here.
 */
import type { AtomicPostOverlayInputs, OverlayObservation } from './screenerOverlayCapture'
import { decodeScreenerCoreSeedContext, materializeScreenerCoreSeeds, type CoreSeedCandidate } from './screenerCoreSeedMaterializer'
import { computeSectorLeaderBonusFromInputs, type SectorLeaderBonusInputs } from './sectorCorrelation'
import { breeze2AdvisoryCacheKey, buildScreenerBreeze2Requests, mapScreenerBreeze2Candidates,
  extractBreeze2WatchPoint, validReport, type Breeze2FactCheckRequest } from './breeze2Runtime'

class MissingCandidateSource extends Error {}
function entries<T>(raw: unknown, name: string): Map<string, T> {
  const rows = (raw as { entries?: unknown })?.entries
  if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string')
    || new Set(rows.map(row => row[0])).size !== rows.length) throw new Error(`candidate_core_map_invalid:${name}`)
  return new Map(rows as Array<[string, T]>)
}
function covered(packet: AtomicPostOverlayInputs, name: string, symbols?: Set<string>): OverlayObservation[] {
  const rows = (packet.observations[name] ?? []).filter(row => !symbols || row.symbols?.some(symbol => symbols.has(symbol)))
  if (!rows.length) throw new MissingCandidateSource(`${name}:not_captured`)
  if (rows.some(row => row.status !== 'captured')) throw new MissingCandidateSource(`${name}:unverified`)
  if (!symbols && rows.length !== 1) throw new Error(`candidate_core_observation_ambiguous:${name}`)
  if (symbols) {
    const scope = rows.flatMap(row => row.symbols ?? []).filter(symbol => symbols.has(symbol))
    if (new Set(scope).size !== scope.length) throw new Error(`candidate_core_observation_overlap:${name}`)
    if ([...symbols].some(symbol => !scope.includes(symbol))) throw new MissingCandidateSource(`${name}:coverage_missing`)
  }
  return rows
}

export async function replayFrozenCandidateCoreSeeds(packet: AtomicPostOverlayInputs, candidates: CoreSeedCandidate[],
  replacement: { candidateId: string; incumbentId: string }) {
  // Own copies are essential: alternate numeric allocation must never mutate
  // the sealed source or alter the next replacement's baseline.
  packet = structuredClone(packet)
  candidates = structuredClone(candidates)
  const symbols = new Set(candidates.map(row => row.symbol))
  if (symbols.size !== candidates.length || [...symbols].some(symbol => !packet.universeSymbols.includes(symbol))) {
    throw new Error('candidate_core_slate_scope_invalid')
  }
  const pendingRequests: Breeze2FactCheckRequest[] = []
  try {
    const captured = covered(packet, 'core_seed_context')[0].value as any
    const context = decodeScreenerCoreSeedContext(captured?.context)
    const { candidateId, incumbentId } = replacement
    if (candidateId === incumbentId || !Object.hasOwn(context.allocationWeights, candidateId)
      || !Object.hasOwn(context.allocationWeights, incumbentId) || context.allocationWeights[candidateId] !== 0) {
      throw new MissingCandidateSource('allocation_weights:replacement_not_covered')
    }
    context.allocationWeights[candidateId] = context.allocationWeights[incumbentId]
    context.allocationWeights[incumbentId] = 0
    context.selectionFlags.clear()
    context.sectorBonus.clear()
    context.breezeWatchPoints.clear()
    for (const symbol of symbols) {
      for (const name of ['prices', 'chipMetadata', 'taxonomyPoints'] as const) {
        if (!context[name].has(symbol)) throw new MissingCandidateSource(`${name}:coverage_missing:${symbol}`)
      }
    }
    if (symbols.size) {
      for (const record of covered(packet, 'selection_history', symbols)) {
        for (const [symbol, flags] of entries<any>(record.value, 'selection_history')) {
          if (!record.symbols?.includes(symbol)) throw new Error('candidate_core_selection_scope_invalid')
          if (!symbols.has(symbol)) continue
          if (!flags || typeof flags.highFreq !== 'boolean' || typeof flags.newMoney !== 'boolean'
            || !Number.isInteger(flags.freq20d) || flags.freq20d < 0) throw new Error('candidate_core_selection_invalid')
          context.selectionFlags.set(symbol, flags)
        }
      }
      if ([...symbols].some(symbol => !context.selectionFlags.has(symbol))) throw new MissingCandidateSource('selection_history:values_missing')
      for (const record of covered(packet, 'sector_bonus', symbols)) {
        const source = record.value as any
        const raw = source?.inputs as SectorLeaderBonusInputs
        if (source?.schema_version !== 'sector-bonus-frozen-inputs-v1' || source.signal_date !== packet.signalDate
          || !Array.isArray(raw?.candidates) || !Array.isArray(raw.leaderRows) || !Array.isArray(raw.prices)
          || typeof source.corr_threshold !== 'number' || !Number.isFinite(source.corr_threshold) || Math.abs(source.corr_threshold) > 1
          || typeof source.bonus_points !== 'number' || !Number.isFinite(source.bonus_points) || source.bonus_points < 0
          || !Array.isArray(source.full_industry_universe) || !Array.isArray(source.issues)) {
          throw new Error('candidate_core_sector_source_invalid')
        }
        const members = raw.candidates.filter(row => symbols.has(row.symbol))
        const required = record.symbols!.filter(symbol => symbols.has(symbol))
        if (new Set(raw.candidates.map(row => row.symbol)).size !== raw.candidates.length
          || required.some(symbol => !members.some(row => row.symbol === symbol))) throw new MissingCandidateSource('sector_bonus:members_missing')
        const sectors = new Set(members.map(row => row.sector).filter(Boolean))
        const peers = new Set<string>(source.full_industry_universe.filter((row: any) => sectors.has(row.sector)).map((row: any) => row.symbol))
        const taxonomy = new Map<string, string | null>(source.full_industry_universe.map((row: any) => [row.symbol, row.sector]))
        if (taxonomy.size !== source.full_industry_universe.length || members.some(row => !row.sector || taxonomy.get(row.symbol) !== row.sector)
          || raw.leaderRows.some(row => sectors.has(row.sector) && taxonomy.get(row.symbol) !== row.sector)) {
          throw new MissingCandidateSource('sector_bonus:taxonomy_missing_or_mismatched')
        }
        const relevant = new Set([...required, ...peers])
        const issues = source.issues.filter((issue: string) => {
          const separator = issue.indexOf(':')
          const knownScoped = /^(taxonomy_missing_or_mismatched|identity_missing|price_history_missing|industry_universe_missing):/.test(issue)
          return !knownScoped || separator < 0 || relevant.has(issue.slice(separator + 1)) || sectors.has(issue.slice(separator + 1))
        })
        if (issues.length) throw new MissingCandidateSource(`sector_bonus:${issues.join(',')}`)
        if (source.source_status !== 'captured' && source.source_status !== 'incomplete'
          || source.source_status === 'incomplete' && !source.issues.length) throw new MissingCandidateSource('sector_bonus:unverified')
        const priceKeys = new Set<string>()
        for (const row of raw.prices) {
          if (!relevant.has(row.symbol)) continue
          const key = `${row.symbol}|${row.date}`
          if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date > packet.signalDate || priceKeys.has(key)
            || row.close !== null && (typeof row.close !== 'number' || !Number.isFinite(row.close))) {
            throw new Error('candidate_core_sector_price_invalid')
          }
          priceKeys.add(key)
        }
        const bonuses = computeSectorLeaderBonusFromInputs({ ...raw, candidates: members }, source.corr_threshold, source.bonus_points)
        for (const [symbol, value] of bonuses) context.sectorBonus.set(symbol, value)
      }
    }
    const options = { runDate: packet.signalDate, maxCandidates: 5, executeModal: true }
    const requests = buildScreenerBreeze2Requests(mapScreenerBreeze2Candidates(candidates), options)
    if (requests.length) {
      if (!Array.isArray(packet.finalSeed) || !Array.isArray(captured.breeze2Scope)) throw new MissingCandidateSource('breeze2:formal_scope_missing')
      const formalCandidates = packet.finalSeed as CoreSeedCandidate[]
      if (formalCandidates.length !== captured.breeze2Scope.length
        || formalCandidates.some((row, i) => row.symbol !== captured.breeze2Scope[i])) throw new Error('candidate_core_breeze_scope_mismatch')
      const formalRequests = buildScreenerBreeze2Requests(mapScreenerBreeze2Candidates(formalCandidates), options)
      const formalKeys = new Map(await Promise.all(formalRequests.map(async request => [await breeze2AdvisoryCacheKey(request), request.symbol] as const)))
      const reports = entries<any>(captured.breeze2ScreenerContext, 'breeze2ScreenerContext')
      for (const request of requests) {
        const key = await breeze2AdvisoryCacheKey(request)
        const report = formalKeys.get(key) === request.symbol ? reports.get(request.symbol) : undefined
        if (!report || !validReport(report)) pendingRequests.push(request)
        else context.breezeWatchPoints.set(request.symbol, extractBreeze2WatchPoint(report))
      }
      if (pendingRequests.length) throw new MissingCandidateSource('breeze2:candidate_request_not_observed')
    }
    return { status: 'materialized' as const, scope: 'candidate_pre_ml_seed' as const,
      rows: materializeScreenerCoreSeeds(candidates, context), allocation_weights: context.allocationWeights,
      semantic_requests: requests, production_effect: false as const, promotion_allowed: false as const, nav_maturity_credit: 0 as const }
  } catch (error) {
    if (error instanceof MissingCandidateSource) return { status: 'unavailable' as const, reason: error.message,
      pending_semantic_requests: pendingRequests }
    throw error
  }
}
