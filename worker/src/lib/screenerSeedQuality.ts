export interface ScreenerSeedCandidateInput {
  symbol: unknown
  name?: unknown
  sector?: unknown
  industry?: unknown
  score?: unknown
  reason?: unknown
  chip_score?: unknown
  tech_score?: unknown
  momentum_score?: unknown
  score_components?: unknown
}

export interface ScreenerSeedRow {
  symbol: string
  name: string
  sector: string
  industry: string
  chipScore: number
  techScore: number
  momentumScore: number
  seedScore: number
  reason: string
  currentPrice: number | null
  scoreComponents: string | null
}

export interface ScreenerSeedBuildResult {
  row: ScreenerSeedRow
  watchPoints: string[]
  issues: string[]
}

const DEFAULT_CLASSIFICATION = '\u672a\u5206\u985e'
const DEFAULT_REASON = '\u7b26\u5408\u7be9\u9078\u689d\u4ef6'

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(upper, value))
}

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

function cleanSymbol(value: unknown): string {
  return cleanText(value).toUpperCase()
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeScoreComponents(value: unknown, issues: string[]): string | null {
  if (value == null || value === '') return null
  if (typeof value === 'string') {
    try {
      JSON.parse(value)
      return value
    } catch {
      issues.push('score_components_invalid')
      return null
    }
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      issues.push('score_components_invalid')
      return null
    }
  }
  issues.push('score_components_invalid')
  return null
}

function scoreComponent(value: unknown, lower: number, upper: number, issueName: string, issues: string[]): number {
  const n = finiteNumber(value)
  if (n == null) {
    issues.push(issueName)
    return lower
  }
  return Math.round(clamp(n, lower, upper) * 10) / 10
}

export function normalizeScreenerSeedCandidate(candidate: ScreenerSeedCandidateInput): ScreenerSeedBuildResult {
  const issues: string[] = []
  const symbol = cleanSymbol(candidate.symbol)
  if (!symbol) issues.push('symbol_missing')
  if (symbol && !/^[0-9A-Z]{4,8}$/.test(symbol)) issues.push('symbol_unexpected_format')

  const rawName = cleanText(candidate.name)
  const name = rawName || symbol
  if (!rawName) issues.push('name_missing')

  const rawSector = cleanText(candidate.sector)
  const sector = rawSector || DEFAULT_CLASSIFICATION
  if (!rawSector) issues.push('sector_missing')

  const rawIndustry = cleanText(candidate.industry)
  const industry = rawIndustry || sector || DEFAULT_CLASSIFICATION
  if (!rawIndustry) issues.push('industry_missing')

  const chipScore = scoreComponent(candidate.chip_score, 0, 40, 'chip_score_non_finite', issues)
  const techScore = scoreComponent(candidate.tech_score, 0, 30, 'tech_score_non_finite', issues)
  const momentumScore = scoreComponent(candidate.momentum_score, 0, 20, 'momentum_score_non_finite', issues)
  const seedScore = Math.round(clamp(chipScore + techScore + momentumScore, 0, 100) * 10) / 10
  const reason = cleanText(candidate.reason) || DEFAULT_REASON
  const scoreComponents = normalizeScoreComponents(candidate.score_components, issues)

  return {
    row: {
      symbol,
      name,
      sector,
      industry,
      chipScore,
      techScore,
      momentumScore,
      seedScore,
      reason,
      currentPrice: null,
      scoreComponents,
    },
    watchPoints: issues.map((issue) => `screener_quality:${issue}`),
    issues,
  }
}

export function buildScreenerSeedRow(input: {
  candidate: ScreenerSeedCandidateInput
  rank: number
  currentPrice?: unknown
  sectorBonus?: number | null
  tags?: string[]
}): ScreenerSeedBuildResult & { rank: number } {
  const normalized = normalizeScreenerSeedCandidate(input.candidate)
  const price = finiteNumber(input.currentPrice)
  if (price == null || price <= 0) {
    normalized.issues.push('current_price_invalid')
    normalized.watchPoints.push('screener_quality:current_price_invalid')
    normalized.row.currentPrice = null
  } else {
    normalized.row.currentPrice = Math.round(price * 100) / 100
  }

  const bonus = finiteNumber(input.sectorBonus) ?? 0
  normalized.row.seedScore = Math.round(clamp(normalized.row.seedScore + bonus, 0, 100) * 10) / 10

  const tags = (input.tags ?? []).map(cleanText).filter(Boolean)
  if (tags.length) normalized.row.reason = `${tags.join(' | ')}\n${normalized.row.reason}`

  return {
    ...normalized,
    rank: Math.max(1, Math.floor(finiteNumber(input.rank) ?? 1)),
  }
}

export function buildScreenerSeedUpsertSql(): string {
  return `
    INSERT INTO daily_recommendations
      (date, stock_id, symbol, name, sector, rank, score,
       chip_score, tech_score, momentum_score, ml_score, current_price,
       reason, watch_points, score_components, has_buy_signal, industry,
       market_segment, recommendation_lane, eligible_for_ml, eligible_for_pending_buy)
    VALUES (?, (SELECT id FROM stocks WHERE symbol=?), ?, ?, ?, ?, ?,
            ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    ON CONFLICT(date, stock_id) DO UPDATE SET
      symbol = excluded.symbol,
      name = excluded.name,
      sector = excluded.sector,
      chip_score = excluded.chip_score,
      tech_score = excluded.tech_score,
      momentum_score = excluded.momentum_score,
      current_price = excluded.current_price,
      industry = excluded.industry,
      rank = CASE
        WHEN daily_recommendations.signal IS NULL
         AND daily_recommendations.confidence IS NULL
         AND COALESCE(daily_recommendations.ml_score, 0) = 0
        THEN excluded.rank ELSE daily_recommendations.rank END,
      score = CASE
        WHEN daily_recommendations.signal IS NULL
         AND daily_recommendations.confidence IS NULL
         AND COALESCE(daily_recommendations.ml_score, 0) = 0
        THEN excluded.score ELSE daily_recommendations.score END,
      reason = CASE
        WHEN daily_recommendations.signal IS NULL
         AND daily_recommendations.confidence IS NULL
         AND COALESCE(daily_recommendations.ml_score, 0) = 0
        THEN excluded.reason ELSE daily_recommendations.reason END,
      watch_points = CASE
        WHEN daily_recommendations.signal IS NULL
         AND daily_recommendations.confidence IS NULL
         AND COALESCE(daily_recommendations.ml_score, 0) = 0
        THEN excluded.watch_points ELSE daily_recommendations.watch_points END,
      score_components = CASE
        WHEN daily_recommendations.signal IS NULL
         AND daily_recommendations.confidence IS NULL
         AND COALESCE(daily_recommendations.ml_score, 0) = 0
        THEN excluded.score_components ELSE daily_recommendations.score_components END,
      has_buy_signal = CASE
        WHEN daily_recommendations.signal IS NULL
         AND daily_recommendations.confidence IS NULL
         AND COALESCE(daily_recommendations.ml_score, 0) = 0
        THEN excluded.has_buy_signal ELSE daily_recommendations.has_buy_signal END,
      market_segment = excluded.market_segment,
      recommendation_lane = excluded.recommendation_lane,
      eligible_for_ml = excluded.eligible_for_ml,
      eligible_for_pending_buy = excluded.eligible_for_pending_buy
  `
}

export function buildScreenerSeedPruneSql(symbolCount: number): string {
  const count = Math.max(0, Math.floor(Number(symbolCount) || 0))
  if (count <= 0) {
    return 'DELETE FROM daily_recommendations WHERE date = ?'
  }
  const placeholders = Array.from({ length: count }, () => '?').join(',')
  return `DELETE FROM daily_recommendations WHERE date = ? AND symbol NOT IN (${placeholders})`
}
