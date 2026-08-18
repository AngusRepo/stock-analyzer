import assert from 'node:assert/strict'
import { listLinUcbRewardSourceRowsAcrossDomains } from './metaLearningRewardLedger'

function fakeDb(handler: (sql: string) => any[]) {
  return {
    prepare(sql: string) {
      const query = {
        bind() { return query },
        async all() { return { results: handler(sql) } },
      }
      return query
    },
  } as unknown as D1Database
}

void (async () => {
  const predictionSql: string[] = []
  const recommendationSql: string[] = []
  const predictionDb = fakeDb((sql) => {
    predictionSql.push(sql)
    return [{
      date: '2026-08-18',
      stock_id: '2330',
      model_name: 'LightGBM',
      direction_correct: 1,
      rank_score: 0.9,
      market_risk_score: 0.2,
      actual_return_pct: 3,
      trade_pnl_pct: null,
    }]
  })
  const recommendationDb = fakeDb((sql) => {
    recommendationSql.push(sql)
    return [{
      date: '2026-08-18',
      stock_id: '2330',
      market_segment: 'TWSE',
      recommendation_lane: 'eligible',
      has_buy_signal: 1,
      ml_vote_summary: JSON.stringify({ model_ic: 0.12, coverage: 0.9 }),
      score_components: JSON.stringify({ data_quality: 0.8 }),
      alpha_context: JSON.stringify({ regime: 'bull', liquidity: 0.7 }),
      alpha_allocation: JSON.stringify({ market_breadth: 0.6 }),
    }]
  })

  const rows = await listLinUcbRewardSourceRowsAcrossDomains(
    predictionDb,
    recommendationDb,
    { startDate: '2026-08-01', endDate: '2026-08-18', limit: 100 },
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].model_name, 'LightGBM')
  assert.equal(rows[0].recommendation_lane, 'eligible')
  assert.equal(rows[0].model_ic, 0.12)
  assert.equal(rows[0].regime, 'bull')
  assert(predictionSql.every((sql) => sql.includes('FROM predictions') && !sql.includes('daily_recommendations')))
  assert(recommendationSql.every((sql) => sql.includes('FROM daily_recommendations') && !sql.includes('predictions')))
  console.log('meta-learning reward ledger split-D1 tests passed')
})()
