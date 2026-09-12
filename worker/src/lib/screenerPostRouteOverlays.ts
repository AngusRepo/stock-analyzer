/** Original formal post-route mutations, shared with frozen per-slate replay.
 * Pure: no live reads, persistence, model fitting or changed economic gates.
 */
import { buildScoreV2Components, readScoreV2Snapshot, type ScoreV2StorageRow } from './scoreV2Taxonomy'
import { recordPostRouteExternalVeto } from './screenerPostOverlaySeed'
import type { SymbolExternalEvidenceRiskOverlay } from './newsThemeRiskOverlay'

export interface OverlayCandidate { symbol: string; name?: string | null; score: number; reason: string; score_components?: string | null }
export interface OverlayEvent {
  symbol: string; name?: string | null; stage: string; decision: 'observe' | 'drop'; reasonCode: string;
  scoreBefore?: number | null; scoreAfter?: number | null; evidence?: Record<string, unknown>
}
export interface OverlayThemeContext {
  hotConcepts: Set<string>; symbolConceptTags: Map<string, string[]>; conceptBuzzScore: Map<string, number>;
  conceptCrowding: Map<string, number>; conceptEvidenceBreakdown: Map<string, Record<string, number>>
}
function round1(value: number): number { return Math.round(value * 10) / 10 }

function clampScore(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min))
}

export function applyScoreV2NewsThemeAdjustment(
  candidate: { score: number; score_components?: string | null },
  requestedDelta: number,
  reason: string,
  riskFlags: string[] = [],
): number {
  const snapshot = readScoreV2Snapshot({ score_components: candidate.score_components } as ScoreV2StorageRow)
  if (!snapshot) return 0
  const riskAdjustment = requestedDelta < 0 ? requestedDelta : 0
  if (riskAdjustment === 0) return 0
  const alphaAdjustment = round1((snapshot.alphaAdjustment ?? 0) + riskAdjustment)
  const payload = buildScoreV2Components({
    ...snapshot.components,
    newsTheme: snapshot.components.newsTheme,
    technicalBreakdown: snapshot.technicalBreakdown,
    riskFlags: [...snapshot.riskFlags, ...riskFlags],
    reasons: [...snapshot.reasons, reason],
  })
  const finalScore = clampScore(round1(payload.total + alphaAdjustment), 0, 100)
  candidate.score_components = JSON.stringify({
    ...payload,
    alphaAdjustment,
    finalScore,
  })
  const appliedRankingDelta = round1(riskAdjustment)
  candidate.score = round1(candidate.score + appliedRankingDelta)
  return appliedRankingDelta
}

export function applyScreenerNewsSentiment(scored: OverlayCandidate[], overlayEligibleSymbols: Set<string>,
  newsAgg: Array<{ symbol: string; sentiment: string; cnt: number }>) {
      const sentimentMap = new Map<string, { pos: number; neg: number; total: number }>()
      for (const r of (newsAgg ?? [])) {
        if (!sentimentMap.has(r.symbol)) sentimentMap.set(r.symbol, { pos: 0, neg: 0, total: 0 })
        const s = sentimentMap.get(r.symbol)!
        s.total += r.cnt
        if (r.sentiment === 'positive') s.pos += r.cnt
        if (r.sentiment === 'negative') s.neg += r.cnt
      }

      for (const c of scored) {
        if (!overlayEligibleSymbols.has(c.symbol)) continue
        const s = sentimentMap.get(c.symbol)
        if (!s || s.total === 0) continue
        const posRatio = s.pos / s.total
        const negRatio = s.neg / s.total
        if (posRatio > 0.6) applyScoreV2NewsThemeAdjustment(c, 5, 'positive_news_sentiment')
        else if (posRatio > 0.4) applyScoreV2NewsThemeAdjustment(c, 3, 'positive_news_sentiment')
        else if (negRatio > 0.4) applyScoreV2NewsThemeAdjustment(c, -3, 'negative_news_sentiment', ['negative_news_sentiment'])
      }
}

export function applyScreenerBuzz(scored: OverlayCandidate[], overlayEligibleSymbols: Set<string>, context: OverlayThemeContext) {
  const { hotConcepts, symbolConceptTags, conceptBuzzScore, conceptCrowding, conceptEvidenceBreakdown } = context
  const events: OverlayEvent[] = []
  for (const c of scored) {
    if (!overlayEligibleSymbols.has(c.symbol)) continue
    const tags = symbolConceptTags.get(c.symbol) ?? []
    const matchedHot = tags.filter(t => hotConcepts.has(t))
    if (matchedHot.length > 0) {
      const bestTag = matchedHot
        .map(tag => ({ tag, score: conceptBuzzScore.get(tag) ?? 0, crowding: conceptCrowding.get(tag) ?? 1 }))
        .sort((a, b) => b.score - a.score)[0]
      const sourceStrength = Math.max(0, bestTag?.score ?? 0)
      const crowdingPenalty = Math.min(2, Math.log10(Math.max(1, bestTag?.crowding ?? 1)))
      const buzzBonus = Math.max(0, Math.min(4, sourceStrength * 1.5 + matchedHot.length - crowdingPenalty))
      const before = c.score
      const appliedBuzzBonus = applyScoreV2NewsThemeAdjustment(c, buzzBonus, `buzz_evidence:${bestTag.tag}`)
      if (appliedBuzzBonus <= 0) continue
      c.reason += ` | buzz_evidence:${bestTag.tag}+${appliedBuzzBonus.toFixed(1)}`
      events.push({
        symbol: c.symbol,
        name: c.name,
        stage: 'buzz_evidence',
        decision: 'observe',
        reasonCode: 'weighted_keyword_evidence',
        scoreBefore: before,
        scoreAfter: c.score,
        evidence: {
          concept: bestTag.tag,
          matchedHot,
          sourceStrength,
          sourceBreakdown: conceptEvidenceBreakdown.get(bestTag.tag) ?? {},
          crowding: bestTag.crowding,
          crowdingPenalty,
          buzzBonus,
          appliedBuzzBonus,
        },
      })
    }
  }
  return events
}

export function applyScreenerExternalRisk(scored: OverlayCandidate[], overlayEligibleSymbols: Set<string>,
  evidenceRisk: Map<string, SymbolExternalEvidenceRiskOverlay>, layer2CoarseQueueSeed: readonly { symbol: string }[],
  postL15SafetyExcludedSymbols: Set<string>) {
  const events: OverlayEvent[] = []
    let vetoed = 0
    let penalized = 0
    for (let i = scored.length - 1; i >= 0; i--) {
      const c = scored[i]
      if (!overlayEligibleSymbols.has(c.symbol)) continue
      const overlay = evidenceRisk.get(c.symbol)
      if (!overlay) continue
      if (overlay.action === 'veto') {
        vetoed++
        recordPostRouteExternalVeto(c.symbol, overlay, layer2CoarseQueueSeed, postL15SafetyExcludedSymbols)
        events.push({
          symbol: c.symbol,
          name: c.name,
          stage: 'external_evidence_risk',
          decision: 'drop',
          reasonCode: overlay.flags[0] ?? 'major_negative_event',
          scoreBefore: c.score,
          scoreAfter: null,
          evidence: { ...overlay },
        })
        scored.splice(i, 1)
        continue
      }
      const before = c.score
      const appliedPenalty = applyScoreV2NewsThemeAdjustment(c, overlay.penalty, overlay.flags[0] ?? 'external_evidence_risk', overlay.flags)
      if (appliedPenalty < 0) {
        penalized++
        c.reason += ` | risk_overlay:${overlay.flags[0] ?? 'external_evidence'}`
        events.push({
          symbol: c.symbol,
          name: c.name,
          stage: 'external_evidence_risk',
          decision: 'observe',
          reasonCode: overlay.flags[0] ?? 'external_evidence_risk',
          scoreBefore: before,
          scoreAfter: c.score,
          evidence: { ...overlay },
        })
      }
    }
  return { vetoed, penalized, events }
}

export function applyScreenerSelectionHistory(scored: OverlayCandidate[],
  selectionFlagMap: Map<string, { highFreq: boolean; newMoney: boolean; freq20d: number }>,
  highFreqPenalty: number, newMoneyBonus: number) {
  const events: OverlayEvent[] = []
    let highFreqAdjusted = 0
    let newMoneyAdjusted = 0
    for (const c of scored) {
      const flag = selectionFlagMap.get(c.symbol)
      if (!flag) continue
      if (flag.highFreq && highFreqPenalty > 0) {
        const before = c.score
        c.score -= highFreqPenalty
        c.reason += ` | high_freq_penalty -${highFreqPenalty}`
        highFreqAdjusted++
        events.push({
          symbol: c.symbol,
          name: c.name,
          stage: 'diversity_cooldown',
          decision: 'observe',
          reasonCode: 'high_frequency_cooldown',
          scoreBefore: before,
          scoreAfter: c.score,
          evidence: { freq20d: flag.freq20d, highFreqPenalty },
        })
      }
      if (flag.newMoney && newMoneyBonus > 0) {
        const before = c.score
        c.score += newMoneyBonus
        c.reason += ` | new_money +${newMoneyBonus}`
        newMoneyAdjusted++
        events.push({
          symbol: c.symbol,
          name: c.name,
          stage: 'diversity_cooldown',
          decision: 'observe',
          reasonCode: 'new_money_boost',
          scoreBefore: before,
          scoreAfter: c.score,
          evidence: { freq20d: flag.freq20d, newMoneyBonus },
        })
      }
    }
  return { highFreqAdjusted, newMoneyAdjusted, events }
}

export function applyScreenerForeignFlow(scored: OverlayCandidate[], foreignRows: Array<{ total_foreign_net: number }>): number | null {
  if (!foreignRows || foreignRows.length < 10) return null
  const buyDays = foreignRows.filter(r => r.total_foreign_net > 0).length
  const foreignBuyRatio = buyDays / foreignRows.length
  if (foreignBuyRatio < 0.35) for (const c of scored) c.score -= 3
  return foreignBuyRatio
}

export function applyScreenerRecentSessionSafety<T extends OverlayCandidate>(finalCandidates: T[],
  recentRows: Array<{ symbol: string; days_count: number }>, postL15SafetyExcludedSymbols: Set<string>) {
  const delistRisk = new Set<string>()
  for (const r of recentRows) if (r.days_count <= 2) delistRisk.add(r.symbol)
  const removed = finalCandidates.filter(c => delistRisk.has(c.symbol))
  const events: OverlayEvent[] = []
  for (const candidate of removed) {
    const symbol = String(candidate.symbol || '').trim().toUpperCase()
    if (!symbol) continue
    postL15SafetyExcludedSymbols.add(symbol)
    events.push({ symbol, name: candidate.name, stage: 'l1_post_route_safety_gate', decision: 'drop',
      reasonCode: 'delisting_monitor_insufficient_recent_sessions', scoreBefore: Number(candidate.score ?? 0), scoreAfter: null,
      evidence: { canonical_l15_route_present: true, recent_market_sessions_max: 2 } })
  }
  for (let i = finalCandidates.length - 1; i >= 0; i--) {
    if (delistRisk.has(finalCandidates[i].symbol)) finalCandidates.splice(i, 1)
  }
  return { removed, events }
}
