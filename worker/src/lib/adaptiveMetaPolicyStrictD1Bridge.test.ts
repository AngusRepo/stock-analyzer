import { listAdaptiveMetaPolicyReplayRowsAcrossDomains } from './adaptiveMetaPolicyReplayRunner'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function fakeDb(handler: (sql: string) => any[]) {
  return {
    prepare(sql: string) {
      const query = {
        async all() {
          return { results: handler(sql) }
        },
        bind() {
          return query
        },
      }
      return query
    },
  } as unknown as D1Database
}

void (async () => {
  const learningSql: string[] = []
  const coreSql: string[] = []
  const learningDb = fakeDb((sql) => {
    learningSql.push(sql)
    return [{
      date: '2026-08-14',
      stock_id: 'stock-2330',
      model_name: 'LightGBM',
      actual_return_pct: 0.03,
      market_risk_score: 0.2,
    }]
  })
  const coreDb = fakeDb((sql) => {
    coreSql.push(sql)
    if (sql.includes('FROM stocks')) return [{ stock_id: 'stock-2330', symbol: '2330' }]
    if (sql.includes('FROM daily_recommendations')) {
      return [{
        date: '2026-08-14',
        stock_id: 'stock-2330',
        market_segment: 'large_cap',
        recommendation_lane: 'eligible',
        has_buy_signal: 1,
        ml_vote_summary: JSON.stringify({ model_ic: 0.12, coverage: 0.9 }),
        score_components: JSON.stringify({ data_quality: 0.8 }),
        alpha_context: JSON.stringify({ regime: 'bull', liquidity: 0.7 }),
        alpha_allocation: '{}',
      }]
    }
    return []
  })

  const rows = await listAdaptiveMetaPolicyReplayRowsAcrossDomains(learningDb, coreDb, {
    startDate: '2026-08-01',
    endDate: '2026-08-16',
    limit: 100,
  })
  assert(rows.length === 1 && rows[0].symbol === '2330', 'strict replay must merge Core symbol identity')
  assert(rows[0].model_ic === 0.12 && rows[0].regime === 'bull', 'strict replay must merge scalar recommendation context')
  assert(learningSql.every((sql) => !sql.includes('FROM stocks') && !sql.includes('daily_recommendations')),
    'Learning DB must only read prediction-owned tables')
  assert(coreSql.some((sql) => sql.includes('FROM stocks')) && coreSql.some((sql) => sql.includes('FROM daily_recommendations')),
    'Core DB must own identity and recommendation context queries')
  console.log('adaptive meta-policy strict D1 bridge tests passed')
})()
