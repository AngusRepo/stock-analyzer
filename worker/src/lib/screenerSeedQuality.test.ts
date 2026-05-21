import {
  buildScreenerSeedPruneSql,
  buildScreenerSeedRow,
  buildScreenerSeedUpsertSql,
  normalizeScreenerSeedCandidate,
} from './screenerSeedQuality'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

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
    score_components: '{"version":"score_v2","total":40}',
  })

  assert(normalized.row.symbol === '2330', 'symbol should be trimmed')
  assert(normalized.row.name === '2330', 'missing name should fallback to symbol')
  assert(normalized.row.sector === '未分類', 'missing sector should fallback to 未分類')
  assert(normalized.row.industry === '未分類', 'missing industry should fallback to normalized sector')
  assert(normalized.row.chipScore === 40, 'chip score should be clamped to 0-40')
  assert(normalized.row.techScore === 0, 'tech score should be clamped to 0-30')
  assert(normalized.row.momentumScore === 0, 'non-finite momentum score should fallback to 0')
  assert(normalized.row.seedScore === 40, 'seed score should be finite and component-based')
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
  const sql = buildScreenerSeedUpsertSql()
  assert(!sql.includes('DELETE FROM daily_recommendations'), 'screener seed SQL must not delete recommendation owner rows')
  assert(sql.includes('ON CONFLICT(date, stock_id) DO UPDATE SET'), 'screener seed should upsert missing seed rows')
  assert(sql.includes('daily_recommendations.signal IS NULL'), 'upsert should preserve ML owner fields')
  assert(sql.includes('daily_recommendations.confidence IS NULL'), 'upsert should preserve confidence owner field')
  assert(sql.includes('COALESCE(daily_recommendations.ml_score, 0) = 0'), 'upsert should preserve ML score owner field')
  assert(sql.includes('score_components'), 'upsert should persist Score V2 components')
}

{
  const sql = buildScreenerSeedPruneSql(3)
  assert(sql.includes('DELETE FROM daily_recommendations WHERE date = ?'), 'prune SQL should be date scoped')
  assert(sql.includes('symbol NOT IN (?,?,?)'), 'prune SQL should keep only current seed symbols')
  assert(buildScreenerSeedPruneSql(0) === 'DELETE FROM daily_recommendations WHERE date = ?', 'empty seed should clear the date')
}
