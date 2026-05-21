import {
  buildBreeze2FactCheckRequest,
  extractBreeze2WatchPoint,
  selectBreeze2ScreenerCandidates,
  shouldRequestBreeze2,
} from './breeze2Runtime'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const selected = selectBreeze2ScreenerCandidates([
    { symbol: '1111', name: 'A', score: 93, theme: { theme_score: 0.88, fact_support: 0.30, hype_risk: 0.74 } },
    { symbol: '2222', name: 'B', score: 91, theme: { theme_score: 0.80, fact_support: 0.70, hype_risk: 0.20 } },
    { symbol: '3333', name: 'C', score: 86, theme: { theme_score: 0.45, fact_support: 0.80, hype_risk: 0.82 } },
    { symbol: '4444', name: 'D', score: 45, theme: { theme_score: 0.90, fact_support: 0.20, hype_risk: 0.85 } },
  ], 2)

  assert(selected.map((item) => item.symbol).join(',') === '1111,3333', 'screener Breeze2 planner should select bounded semantic-risk shortlist')
}

{
  assert(shouldRequestBreeze2({ score: 90, theme: { theme_score: 0.80, fact_support: 0.30 } }), 'low fact support high theme should request Breeze2')
  assert(shouldRequestBreeze2({ score: 90, theme: { hype_risk: 0.75 } }), 'high hype risk should request Breeze2')
  assert(!shouldRequestBreeze2({ score: 45, theme: { theme_score: 0.90, fact_support: 0.20, hype_risk: 0.90 } }), 'low score candidate should not spend Breeze2 budget')
}

{
  const score_components = JSON.stringify({
    version: 'score_v2',
    total: 58,
    finalScore: 90,
    components: {
      mlEdge: 20,
      chipFlow: 20,
      technicalStructure: 18,
      fundamentalQuality: 0,
      newsTheme: 0,
    },
  })
  assert(
    shouldRequestBreeze2({ score: 35, score_components, theme: { hype_risk: 0.75 } }),
    'Breeze2 candidate selection should prefer canonical Score V2 finalScore over stale scalar score',
  )
}

{
  const request = buildBreeze2FactCheckRequest(
    {
      symbol: '2330',
      name: '台積電',
      score: 92,
      reason: 'AI server theme',
      watch_points: ['rrg_overlay:Leading', 'buzz_evidence:AI server'],
      theme: { theme_score: 0.88, fact_support: 0.31, hype_risk: 0.76 },
    },
    'morning_debate',
    { executeModal: true, runDate: '2026-05-17' },
  )

  assert(request.execute_modal === true, 'request should support Modal execution')
  assert(request.trigger === 'morning_debate', 'request should carry morning debate trigger')
  assert(request.mutation_allowed === false, 'request must stay non-mutating')
  assert(request.real_trading_allowed === false, 'request must never request real trading')
  assert(request.metadata?.run_date === '2026-05-17', 'request should preserve run date metadata')
}

{
  const request = buildBreeze2FactCheckRequest(
    {
      symbol: '2317',
      name: 'Hon Hai',
      score: 35,
      score_components: JSON.stringify({
        version: 'score_v2',
        total: 58,
        finalScore: 88,
        components: {
          mlEdge: 20,
          chipFlow: 20,
          technicalStructure: 18,
          fundamentalQuality: 0,
          newsTheme: 0,
        },
      }),
    },
    'screener_enrichment',
  )

  assert(request.metadata.screener_score === 88, 'Breeze2 metadata should expose Score V2 finalScore')
  assert(request.metadata.score_source === 'score_v2', 'Breeze2 metadata should record canonical score source')
}

{
  const watchPoint = extractBreeze2WatchPoint({
    recommended_decision_context: 'human_review',
    scores: { fact_support: 0.31, hype_risk: 0.76, source_quality: 0.2 },
    risk_flags: ['fact_support_low', 'hype_risk_high'],
  })

  assert(
    watchPoint === 'breeze2:human_review fact=0.31 hype=0.76 quality=0.2 flags=fact_support_low,hype_risk_high',
    'watch point should summarize Breeze2 context compactly',
  )
}
