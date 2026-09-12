/** Frozen per-slate replay of the ACTUAL formal post-route mutations.
 * No SQL, HTTP, wall-clock reads, formal result borrowing or promotion rights.
 */
import type { AtomicPostOverlayInputs, OverlayObservation } from './screenerOverlayCapture'
import type { StrategyCandidatePoolCandidate } from './strategyCandidatePool'
import type { StrategySpec, StrategySpecEvaluationOptions } from './strategySpec'
import { applyScreenerNewsSentiment, applyScreenerBuzz, applyScreenerExternalRisk,
  applyScreenerForeignFlow, applyScreenerSelectionHistory, applyScreenerRecentSessionSafety, type OverlayCandidate } from './screenerPostRouteOverlays'
import { applyScreenerTechnicalOverlay, type ScreenerOverlayBar } from './screenerTechnicalOverlay'
import { materializeExternalEvidenceRisk, type ExternalEvidenceRiskRow } from './newsThemeRiskOverlay'
import { materializePostOverlayStrategySeed, dedupeScreenerCandidatesBySymbol, assertCanonicalL15SeedIdentity } from './screenerPostOverlaySeed'
import { annotateCandidatesWithStrategySpecs } from './screenerStrategyConsumer'

class UnavailableOverlay extends Error {}
type ReplayCandidate = StrategyCandidatePoolCandidate & OverlayCandidate

function frozenMap<T>(value: unknown): Map<string, T> {
  const entries = (value as { entries?: unknown } | undefined)?.entries
  if (!Array.isArray(entries) || entries.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string')
    || new Set(entries.map(row => row[0])).size !== entries.length) throw new Error('atomic_overlay_map_invalid')
  return new Map(entries as Array<[string, T]>)
}

/** Caller verifies the enclosing source checksum and observation/publication
 * times before invoking this deterministic engine. Unrelated extra-symbol
 * failures do not invalidate an otherwise covered slate.
 */
export function replayFrozenPostRoute(input: {
  packet: AtomicPostOverlayInputs; universe: StrategyCandidatePoolCandidate[];
  plan: { breadthPool: StrategyCandidatePoolCandidate[]; coarseQueue: StrategyCandidatePoolCandidate[] };
  specs: StrategySpec[];
}) {
  const { packet, plan, specs } = structuredClone(input)
  const eligible = new Set(plan.breadthPool.map(row => row.symbol))
  // Explicitly sealed zero-admission slate has no post-route effect to replay.
  // An unrelated extra-symbol source failure must not turn that into missing.
  if (!eligible.size && !plan.coarseQueue.length) return { status: 'replayed' as const, finalSeed: [] as ReplayCandidate[],
    safetyExcludedSymbols: [] as string[], effect_scope: 'post_route_through_pre_core' as const,
    production_effect: false as const, promotion_allowed: false as const, nav_maturity_credit: 0 as const }
  function records(name: string, symbols?: Set<string>): OverlayObservation[] {
    const all = packet.observations[name] ?? []
    if (!all.length) throw new UnavailableOverlay(`${name}:not_captured`)
    const rows = symbols ? all.filter(row => row.symbols?.some(symbol => symbols.has(symbol)) || row.symbols?.length === 0 && symbols.size === 0) : all
    if (rows.some(row => row.status !== 'captured')) throw new UnavailableOverlay(`${name}:unverified`)
    if (!symbols && rows.length !== 1) throw new Error(`atomic_overlay_global_observation_ambiguous:${name}`)
    if (symbols) {
      const covered = rows.flatMap(row => row.symbols ?? []).filter(symbol => symbols.has(symbol))
      if (new Set(covered).size !== covered.length) throw new Error(`atomic_overlay_observation_overlap:${name}`)
      if ([...symbols].some(symbol => !covered.includes(symbol))) throw new UnavailableOverlay(`${name}:coverage_missing`)
      if (rows.some(row => ((row.value as any)?.missing_identity_symbols ?? []).some((symbol: string) => symbols.has(symbol)))) {
        throw new UnavailableOverlay(`${name}:identity_missing`)
      }
    }
    return rows
  }
  function rowArray(name: string, symbols: Set<string>, nested = true): any[] {
    return records(name, symbols).flatMap(record => {
      const rows = nested ? (record.value as any)?.rows : record.value
      if (!Array.isArray(rows)) throw new Error(`atomic_overlay_rows_invalid:${name}`)
      if (rows.some(row => !record.symbols?.includes(row.symbol))) throw new Error(`atomic_overlay_row_scope_invalid:${name}`)
      return rows.filter(row => symbols.has(row.symbol))
    })
  }
  try {
    // Validate presence before interpreting legacy incomplete snapshots.
    const news = rowArray('news_sentiment', eligible)
    const theme = records('theme_context')[0].value as any
    const risk = records('external_risk', eligible)
    const foreign = (records('foreign_flow')[0].value as any)?.rows
    const history = rowArray('technical_history', eligible, false) as ScreenerOverlayBar[]
    const flags = new Map<string, { highFreq: boolean; newMoney: boolean; freq20d: number }>()
    for (const row of records('selection_history', eligible)) for (const [symbol, value] of frozenMap<any>(row.value)) {
      if (!row.symbols?.includes(symbol)) throw new Error('atomic_overlay_selection_scope_invalid')
      if (eligible.has(symbol)) flags.set(symbol, value)
    }
    if ([...eligible].some(symbol => !flags.has(symbol)) || [...flags.values()].some(value => !value
      || typeof value.highFreq !== 'boolean' || typeof value.newMoney !== 'boolean'
      || !Number.isInteger(value.freq20d) || value.freq20d < 0)) throw new Error('atomic_overlay_selection_source_invalid')
    const policy = packet.policy as Record<string, unknown>
    if (!policy || !['highFreqPenalty', 'newMoneyBonus'].every(key => typeof policy[key] === 'number' && Number.isFinite(policy[key]))
      || policy.technicalRowsPerSymbol !== 65 || policy.recentSessionsMaxExcluded !== 2) throw new Error('atomic_overlay_policy_invalid')
    if (!Array.isArray(foreign) || !Array.isArray(theme?.combinedBuzz)) throw new Error('atomic_overlay_context_invalid')
    const scored = structuredClone(input.universe) as ReplayCandidate[]
    if (scored.some(row => typeof row.score !== 'number' || !Number.isFinite(row.score) || typeof row.reason !== 'string')) {
      throw new Error('atomic_overlay_base_score_invalid')
    }
    if (news.some(row => !Number.isFinite(row.cnt) || row.cnt < 0 || typeof row.sentiment !== 'string')
      || foreign.some(row => !Number.isFinite(row.total_foreign_net))
      || history.some(row => typeof row.date !== 'string' || row.date > packet.signalDate
        || ![row.close, row.high, row.low, row.volume].every(Number.isFinite))) throw new Error('atomic_overlay_raw_value_invalid')
    const excluded = new Set<string>()
    applyScreenerNewsSentiment(scored, eligible, news)
    applyScreenerBuzz(scored, eligible, {
      hotConcepts: new Set(theme.combinedBuzz.slice(0, 10).map((row: any) => row.concept)),
      symbolConceptTags: frozenMap(theme.symbolConceptTags), conceptBuzzScore: frozenMap(theme.conceptBuzzScore),
      conceptCrowding: frozenMap(theme.conceptCrowding), conceptEvidenceBreakdown: frozenMap(theme.conceptEvidenceBreakdown),
    })
    const riskObservations: Array<{ symbols: string[]; rows: ExternalEvidenceRiskRow[] }> = []
    for (const record of risk) {
      const raw = (record.value as any)?.observations
      if (!Array.isArray(raw) || raw.some(part => !Array.isArray(part.symbols) || !Array.isArray(part.rows)
        || part.symbols.some((symbol: string) => !record.symbols?.includes(symbol)))) throw new Error('atomic_overlay_risk_source_invalid')
      const covered = raw.flatMap(part => part.symbols)
      if (new Set(covered).size !== covered.length || record.symbols?.some(symbol => !covered.includes(symbol))) {
        throw new Error('atomic_overlay_risk_source_coverage_invalid')
      }
      riskObservations.push(...raw.map(part => ({ symbols: part.symbols.filter((symbol: string) => eligible.has(symbol)), rows: part.rows })))
    }
    applyScreenerExternalRisk(scored, eligible, materializeExternalEvidenceRisk(riskObservations), plan.coarseQueue, excluded)
    scored.sort((a, b) => b.score - a.score)
    applyScreenerForeignFlow(scored, foreign)
    applyScreenerTechnicalOverlay(scored, history, eligible)
    applyScreenerSelectionHistory(scored, flags, policy.highFreqPenalty as number, policy.newMoneyBonus as number)
    const evaluation = { regime: policy.regime, evidenceMode: policy.evidenceMode } as StrategySpecEvaluationOptions & { regime?: string | null }
    const selected = plan.breadthPool.length
      ? materializePostOverlayStrategySeed(plan.coarseQueue, scored, specs, evaluation) : []
    const annotated = annotateCandidatesWithStrategySpecs(selected, specs, { evidenceMode: evaluation.evidenceMode })
    const finalSeed = dedupeScreenerCandidatesBySymbol(annotated)
    const finalSymbols = new Set(finalSeed.map(row => row.symbol))
    const recent = rowArray('recent_sessions', finalSymbols)
    if (recent.some(row => !Number.isInteger(row.days_count) || row.days_count < 0)
      || new Set(recent.map(row => row.symbol)).size !== recent.length
      || [...finalSymbols].some(symbol => !recent.some(row => row.symbol === symbol))) throw new Error('atomic_overlay_recent_source_invalid')
    applyScreenerRecentSessionSafety(finalSeed, recent, excluded)
    assertCanonicalL15SeedIdentity({ routeSymbols: plan.coarseQueue.map(row => row.symbol),
      finalSymbols: finalSeed.map(row => row.symbol), safetyExcludedSymbols: excluded })
    return { status: 'replayed' as const, finalSeed,
      safetyExcludedSymbols: [...excluded], effect_scope: 'post_route_through_pre_core' as const,
      production_effect: false as const, promotion_allowed: false as const, nav_maturity_credit: 0 as const }
  } catch (error) {
    if (error instanceof UnavailableOverlay) return { status: 'unavailable' as const, reason: error.message }
    throw error
  }
}
