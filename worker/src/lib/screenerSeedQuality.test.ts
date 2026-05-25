import {
  buildScreenerSeedPruneSql,
  buildScreenerSeedRow,
  buildScreenerSeedUpsertSql,
  normalizeScreenerSeedCandidate,
} from './screenerSeedQuality'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const screenerScoreV2 = JSON.stringify({
  version: 'score_v2',
  weights: { mlEdge: 25, chipFlow: 25, technicalStructure: 25, fundamentalQuality: 20, newsTheme: 5 },
  components: { mlEdge: 0, chipFlow: 12.5, technicalStructure: 19, fundamentalQuality: 0, newsTheme: 0 },
  total: 31.5,
  finalScore: 31.5,
  riskFlags: [],
  reasons: [],
})

{
  const normalized = normalizeScreenerSeedCandidate({
    symbol: ' 2330 ',
    name: '',
    sector: '',
    industry: '',
    score: Number.NaN,
    reason: '',
    chip_score: 99,
    tech_score: -2,
    momentum_score: Number.POSITIVE_INFINITY,
    score_components: screenerScoreV2,
  })

  assert(normalized.row.symbol === '2330', 'symbol should be trimmed')
  assert(normalized.row.name === '2330', 'missing name should fallback to symbol')
  assert(normalized.row.sector === '未分類', 'missing sector should fallback to 未分類')
  assert(normalized.row.industry === '未分類', 'missing industry should fallback to normalized sector')
  assert(normalized.row.chipScore === 40, 'chip score should be clamped to 0-40')
  assert(normalized.row.techScore === 0, 'tech score should be clamped to 0-30')
  assert(normalized.row.momentumScore === 0, 'non-finite momentum score should fallback to 0')
  assert(normalized.row.seedScore === 31.5, 'seed score should prefer canonical Score V2 finalScore')
  assert(normalized.row.scoreComponents?.includes('"score_v2"'), 'score components should be preserved for V2 audit')
  assert(normalized.issues.includes('name_missing'), 'missing name should be auditable')
  assert(normalized.issues.includes('sector_missing'), 'missing sector should be auditable')
  assert(normalized.issues.includes('momentum_score_non_finite'), 'non-finite momentum should be auditable')
}

{
  const built = buildScreenerSeedRow({
    candidate: {
      symbol: '2454',
      name: '聯發科',
      sector: '半導體',
      score: 120,
      reason: '強勢族群',
      chip_score: 36,
      tech_score: 30,
      momentum_score: 20,
      industry: '半導體',
    },
    rank: 1,
    currentPrice: Number.NaN,
    sectorBonus: 30,
    tags: ['族群連動'],
  })

  assert(built.row.seedScore === 100, 'seed score should be capped to 100 including bonus')
  assert(built.row.currentPrice === null, 'invalid current price should be stored as null')
  assert(built.watchPoints.includes('screener_quality:current_price_invalid'), 'invalid price should be auditable')
  assert(built.row.reason.startsWith('族群連動'), 'tags should prefix reason')
}

{
  const scoreWithNewsTheme = JSON.stringify({
    version: 'score_v2',
    weights: { mlEdge: 25, chipFlow: 25, technicalStructure: 25, fundamentalQuality: 20, newsTheme: 5 },
    components: { mlEdge: 0, chipFlow: 12.5, technicalStructure: 19, fundamentalQuality: 0, newsTheme: 3 },
    total: 34.5,
    finalScore: 34.5,
    riskFlags: [],
    reasons: ['buzz_evidence:ai_server'],
  })
  const built = buildScreenerSeedRow({
    candidate: {
      symbol: '1560',
      name: 'seed-news-theme',
      sector: 'semiconductor',
      industry: 'semiconductor',
      score: 34.5,
      reason: 'buzz evidence applied',
      chip_score: 20,
      tech_score: 20,
      momentum_score: 10,
      score_components: scoreWithNewsTheme,
    },
    rank: 2,
    currentPrice: 100,
  })
  const persisted = JSON.parse(built.row.scoreComponents ?? '{}')
  assert(persisted.components.newsTheme === 3, 'seed row must preserve canonical Score V2 newsTheme')
  assert(persisted.reasons.includes('buzz_evidence:ai_server'), 'seed row must preserve news/theme reasons')
  assert(built.row.seedScore === 34.5, 'seed score should prefer news-adjusted Score V2 finalScore')
}

{
  const sql = buildScreenerSeedUpsertSql()
  assert(!sql.includes('DELETE FROM daily_recommendations'), 'screener seed SQL must not delete recommendation owner rows')
  assert(sql.includes('ON CONFLICT(date, stock_id) DO UPDATE SET'), 'screener seed should upsert missing seed rows')
  assert(sql.includes('daily_recommendations.signal IS NULL'), 'upsert should preserve ML owner fields')
  assert(sql.includes('daily_recommendations.confidence IS NULL'), 'upsert should preserve confidence owner field')
  assert(sql.includes('daily_recommendations.score_components IS NOT NULL'), 'upsert owner guard should require canonical Score V2 payload')
  assert(sql.includes('json_valid(daily_recommendations.score_components)'), 'upsert owner guard should require valid Score V2 JSON')
  assert(sql.includes("json_extract(daily_recommendations.score_components, '$.components.mlEdge')"), 'upsert should detect ML owner from canonical Score V2 payload')
  assert(!sql.includes('daily_recommendations.ml_score'), 'upsert owner guard must not fallback to legacy ml_score')
  assert(sql.includes('score_components'), 'upsert should persist Score V2 components')
  assert(sql.includes('score_components = COALESCE(excluded.score_components, daily_recommendations.score_components)'), 'screener should refresh canonical Score V2 base without wiping existing canonical payloads')
}

{
  const sql = buildScreenerSeedPruneSql(3)
  assert(sql.includes('DELETE FROM daily_recommendations WHERE date = ?'), 'prune SQL should be date scoped')
  assert(sql.includes('symbol NOT IN (?,?,?)'), 'prune SQL should keep only current seed symbols')
  assert(buildScreenerSeedPruneSql(0) === 'DELETE FROM daily_recommendations WHERE date = ?', 'empty seed should clear the date')
}
