/** Original formal seed materialization, shared with frozen Atomic replay.
 * A breadth hit alone is not an ML seed: keep router admission and post-overlay
 * survival, then reconcile attribution using the exact strategy specification.
 */
import { reconcileCandidatesStrategyPoolAttribution } from './screenerStrategyConsumer'
import type { StrategyCandidatePoolCandidate } from './strategyCandidatePool'
import type { StrategySpec, StrategySpecEvaluationOptions } from './strategySpec'
import type { SymbolExternalEvidenceRiskOverlay } from './newsThemeRiskOverlay'

/** Fields consumed by the existing Controller OPS/Core merge. The formal
 * funnel adds diagnostics; those must not become another scoring owner.
 */
export function buildScreenerL1MergeItem(candidate: Record<string, any>, route: Record<string, any> | undefined, rank: number) {
  if (!route || route.symbol !== candidate.symbol) throw new Error(`l15_canonical_route_missing:${candidate.symbol}`)
  return { symbol: String(candidate.symbol), name: candidate.name,
    stage: 'l1_candidate_seed_after_overlay', decision: 'selected' as const,
    reasonCode: 'selected_for_l1_breadth_seed', scoreAfter: Number(candidate.score ?? 0), rank,
    evidence: { industry: candidate.industry ?? candidate.sector,
      strategy_pool_reason: candidate.strategy_pool_reason ?? null,
      l15_route_contrast: route.l15_route_contrast ?? null } }
}

/** A known veto only accounts for a stock that was actually in the route. */
export function recordPostRouteExternalVeto(symbol: string,
  overlay: SymbolExternalEvidenceRiskOverlay, route: readonly { symbol: string }[], excluded: Set<string>) {
  if (overlay.action !== 'veto' || overlay.symbol !== symbol) return
  const key = symbol.trim().toUpperCase()
  if (route.some(row => row.symbol.trim().toUpperCase() === key)) excluded.add(key)
}

export function materializePostOverlayStrategySeed<T extends StrategyCandidatePoolCandidate>(
  coarseQueue: readonly StrategyCandidatePoolCandidate[], updatedUniverse: readonly T[], specs: StrategySpec[],
  options: StrategySpecEvaluationOptions & { regime?: string | null },
) {
  const updatedBySymbol = new Map(updatedUniverse.map(candidate => [String(candidate.symbol || '').trim(), candidate]))
  const admitted = coarseQueue.filter(candidate =>
    candidate.strategy_pool_decision === 'ml_queue'
    && candidate.strategy_pool_fallback_source !== 'raw_signal_top_up'
    && (candidate.strategy_pool_ids ?? []).length > 0
    && updatedBySymbol.has(String(candidate.symbol || '').trim()))
  return reconcileCandidatesStrategyPoolAttribution(admitted.map(entry => {
    const updated = updatedBySymbol.get(String(entry.symbol || '').trim())!
    return {
      ...updated,
      strategy_pool_decision: entry.strategy_pool_decision,
      strategy_pool_reason: entry.strategy_pool_reason,
      strategy_pool_rank: entry.strategy_pool_rank,
      strategy_pool_ids: entry.strategy_pool_ids,
      strategy_family_ids: entry.strategy_family_ids,
      strategy_variant_ids: entry.strategy_variant_ids,
      strategy_owner_types: entry.strategy_owner_types,
      research_strategy_ids: entry.research_strategy_ids,
      strategy_pool_fallback_source: entry.strategy_pool_fallback_source,
      strategy_pool_score: entry.strategy_pool_score,
      strategy_watch_points: [...new Set([
        ...(updated.strategy_watch_points ?? []),
        ...(entry.strategy_watch_points ?? []),
      ])],
    }
  }), specs, options)
}

export function dedupeScreenerCandidatesBySymbol<T extends { symbol?: unknown }>(candidates: T[]): T[] {
  const seen = new Set<string>()
  const deduped: T[] = []
  for (const candidate of candidates) {
    const symbol = String(candidate.symbol ?? '').trim().toUpperCase()
    if (!symbol || seen.has(symbol)) continue
    seen.add(symbol)
    deduped.push(candidate)
  }
  return deduped
}

export function assertCanonicalL15SeedIdentity(input: {
  routeSymbols: Iterable<unknown>
  finalSymbols: Iterable<unknown>
  safetyExcludedSymbols?: Iterable<unknown>
}): void {
  const normalize = (values: Iterable<unknown>) => new Set(
    [...values].map((value) => String(value ?? '').trim().toUpperCase()).filter(Boolean),
  )
  const routeSymbols = normalize(input.routeSymbols)
  const finalSymbols = normalize(input.finalSymbols)
  const safetyExcludedSymbols = normalize(input.safetyExcludedSymbols ?? [])
  const missingRoute = [...finalSymbols].filter((symbol) => !routeSymbols.has(symbol))
  const excludedAfterRoute = [...routeSymbols].filter((symbol) => !finalSymbols.has(symbol))
  const unexplainedExclusions = excludedAfterRoute.filter((symbol) => !safetyExcludedSymbols.has(symbol))
  const invalidSafetyReceipts = [...safetyExcludedSymbols].filter(
    (symbol) => !routeSymbols.has(symbol) || finalSymbols.has(symbol),
  )
  if (missingRoute.length > 0 || unexplainedExclusions.length > 0 || invalidSafetyReceipts.length > 0) {
    throw new Error(
      `l15_canonical_seed_identity_mismatch:route=${routeSymbols.size}:final=${finalSymbols.size}:` +
      `missing_route=${missingRoute.join(',') || 'none'}:` +
      `unexplained_exclusion=${unexplainedExclusions.join(',') || 'none'}:` +
      `invalid_safety_receipt=${invalidSafetyReceipts.join(',') || 'none'}`,
    )
  }
}
