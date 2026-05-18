import type { ConceptBuzzResult } from './pttBuzz'

export type ThemeEvidenceSourceId =
  | 'ptt'
  | 'news'
  | 'anue'
  | 'finnhub_news'
  | 'official_rss'
  | 'company_ir_rss'
  | 'gdelt_events'
  | 'finlab_taxonomy'

export interface ThemeEvidenceInput {
  source: ThemeEvidenceSourceId | string
  concept: string
  mentionCount: number
  sentimentAvg: number
  topPosts: string[]
  score?: number
  allowedUse?: string
  decisionEffect?: string
}

export interface CombinedThemeEvidence {
  combinedBuzz: ConceptBuzzResult[]
  scoreMap: Map<string, number>
  sourceBreakdown: Map<string, Record<string, number>>
  acceptedSources: Record<string, number>
}

const SOURCE_WEIGHT: Record<string, number> = {
  ptt: 1.0,
  news: 0.9,
  anue: 0.85,
  finnhub_news: 0.8,
  official_rss: 1.15,
  company_ir_rss: 1.05,
  gdelt_events: 0.25,
  finlab_taxonomy: 0.35,
}

function zScore(values: number[]): number[] {
  if (!values.length) return []
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  const std = Math.sqrt(variance) || 1
  return values.map(value => (value - mean) / std)
}

function normalizeSourceInputs(items: ThemeEvidenceInput[]): Map<string, number> {
  const scores = items.map(item => item.score ?? item.mentionCount)
  const normalized = zScore(scores)
  return new Map(items.map((item, index) => [item.concept, normalized[index] ?? 0]))
}

export function combineMultiSourceThemeEvidence(sources: ThemeEvidenceInput[][]): CombinedThemeEvidence {
  const buckets = new Map<string, {
    zSum: number
    rawCount: number
    sentimentSum: number
    topPosts: string[]
    breakdown: Record<string, number>
  }>()
  const acceptedSources: Record<string, number> = {}

  for (const sourceItems of sources) {
    if (!sourceItems.length) continue
    const zMap = normalizeSourceInputs(sourceItems)
    for (const item of sourceItems) {
      const concept = String(item.concept || '').trim()
      if (!concept) continue
      const weight = SOURCE_WEIGHT[item.source] ?? 0.5
      const weighted = (zMap.get(concept) ?? 0) * weight
      const existing = buckets.get(concept)
      acceptedSources[item.source] = (acceptedSources[item.source] ?? 0) + 1
      if (existing) {
        existing.zSum += weighted
        existing.rawCount += item.mentionCount
        existing.sentimentSum += item.sentimentAvg * Math.max(1, item.mentionCount)
        existing.topPosts.push(...item.topPosts.slice(0, 2))
        existing.breakdown[item.source] = (existing.breakdown[item.source] ?? 0) + weighted
      } else {
        buckets.set(concept, {
          zSum: weighted,
          rawCount: item.mentionCount,
          sentimentSum: item.sentimentAvg * Math.max(1, item.mentionCount),
          topPosts: item.topPosts.slice(0, 3),
          breakdown: { [item.source]: weighted },
        })
      }
    }
  }

  const combinedBuzz = [...buckets.entries()].map(([concept, value]) => ({
    concept,
    mentionCount: value.rawCount,
    sentimentAvg: value.rawCount > 0 ? value.sentimentSum / value.rawCount : 0,
    topPosts: value.topPosts.slice(0, 5),
  }))
  const scoreMap = new Map([...buckets.entries()].map(([concept, value]) => [concept, value.zSum]))
  const sourceBreakdown = new Map([...buckets.entries()].map(([concept, value]) => [concept, value.breakdown]))
  combinedBuzz.sort((a, b) => (scoreMap.get(b.concept) ?? 0) - (scoreMap.get(a.concept) ?? 0))

  return { combinedBuzz, scoreMap, sourceBreakdown, acceptedSources }
}

export function buzzResultsToThemeEvidence(
  source: ThemeEvidenceSourceId,
  rows: ConceptBuzzResult[],
): ThemeEvidenceInput[] {
  return rows.map(row => ({
    source,
    concept: row.concept,
    mentionCount: row.mentionCount,
    sentimentAvg: row.sentimentAvg,
    topPosts: row.topPosts,
  }))
}

export async function loadRuntimeThemeSignals(db: D1Database, date: string): Promise<ThemeEvidenceInput[]> {
  try {
    const { results } = await db.prepare(`
      SELECT concept, score, sentiment_avg, source, evidence_count, top_titles, allowed_use, decision_effect
      FROM theme_signals
      WHERE date <= ?
      ORDER BY date DESC, score DESC
      LIMIT 500
    `).bind(date).all<{
      concept: string
      score: number | null
      sentiment_avg: number | null
      source: string
      evidence_count: number | null
      top_titles: string | null
      allowed_use: string | null
      decision_effect: string | null
    }>()
    return (results ?? []).map(row => {
      let topPosts: string[] = []
      try {
        const parsed = JSON.parse(row.top_titles || '[]')
        if (Array.isArray(parsed)) topPosts = parsed.map(String)
      } catch {
        topPosts = []
      }
      return {
        source: row.source,
        concept: row.concept,
        mentionCount: Math.max(1, Number(row.evidence_count ?? 1)),
        sentimentAvg: Number(row.sentiment_avg ?? 0),
        topPosts,
        score: Number(row.score ?? row.evidence_count ?? 1),
        allowedUse: row.allowed_use ?? undefined,
        decisionEffect: row.decision_effect ?? undefined,
      }
    })
  } catch (error) {
    console.warn('[ThemeEvidence] theme_signals unavailable, using live buzz only:', error)
    return []
  }
}
