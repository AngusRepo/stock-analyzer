type RecommendationLike = Record<string, any>

export interface RecommendationLaneSplit<T extends RecommendationLike = RecommendationLike> {
  tradable: T[]
  emerging: T[]
  researchOnly: T[]
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

function boolFromFlag(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  return null
}

function hasTag(rec: RecommendationLike, token: string): boolean {
  const tags = [
    ...asArray<string>(rec.tags),
    ...asArray<string>(rec.strategy_tags),
    ...asArray<string>(rec.watch_points),
  ]
  if (typeof rec.watch_points === 'string') tags.push(rec.watch_points)
  return tags.some((tag) => normalizeText(tag).includes(token))
}

export function isEmergingRecommendation(rec: RecommendationLike): boolean {
  const lane = normalizeText(rec.recommendation_lane)
  if (lane === 'emerging_watchlist') return true

  const marketSegment = normalizeText(rec.market_segment)
  const boardType = normalizeText(rec.board_type)
  const market = normalizeText(rec.market)
  const tier = normalizeText(rec.tradability_tier)
  return marketSegment === 'emerging'
    || boardType === 'emerging'
    || market === 'emerging'
    || market === 'esb'
    || market.includes('興櫃')
    || tier === 'research_only'
    || hasTag(rec, 'research_only:emerging_not_for_auto_trade')
    || hasTag(rec, 'board_lane:emerging_watchlist')
}

export function splitRecommendationLanes<T extends RecommendationLike>(payload: any): RecommendationLaneSplit<T> {
  const explicitAll = asArray<T>(payload?.all_recommendations)
  const source = explicitAll.length > 0
    ? explicitAll
    : [
        ...asArray<T>(payload?.tradable_recommendations ?? payload?.recommendations ?? payload?.data),
        ...asArray<T>(payload?.research_only_recommendations),
      ]

  const seen = new Set<string>()
  const unique = source.filter((rec, index) => {
    const key = String(rec.stock_id ?? rec.symbol ?? index)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const tradable: T[] = []
  const emerging: T[] = []
  const researchOnly: T[] = []

  for (const rec of unique) {
    const lane = normalizeText(rec.recommendation_lane)
    const pendingEligible = boolFromFlag(rec.eligible_for_pending_buy)

    if (isEmergingRecommendation(rec)) {
      continue
    } else if (lane === 'research_only' || pendingEligible === false) {
      researchOnly.push(rec)
    } else {
      tradable.push(rec)
    }
  }

  return { tradable, emerging, researchOnly }
}
