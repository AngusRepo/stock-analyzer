import { recommendationReportScore, recommendationReportScoreV2 } from './dailyReport'
import { actionableSignalDisplayScore, actionableSignalScoreSummary, buildTripartiteDailyEmbed } from './notify'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

{
  const score_components = JSON.stringify({
    version: 'score_v2',
    total: 59,
    alphaAdjustment: 2.5,
    finalScore: 61.5,
    components: {
      mlEdge: 20,
      chipFlow: 16,
      technicalStructure: 12,
      fundamentalQuality: 8,
      newsTheme: 3,
    },
  })
  const score = recommendationReportScore({
    score_components,
  })
  assert(score === 61.5, 'daily report should use canonical Score V2 finalScore')

  const scoreV2 = recommendationReportScoreV2({
    score_components,
  })
  assert(scoreV2?.source === 'score_v2', 'daily report should expose canonical Score V2 payload source')
  assert(scoreV2?.finalScore === 61.5, 'daily report Score V2 payload should expose finalScore')
  assert(scoreV2?.components.mlEdge === 20, 'daily report Score V2 payload should expose ML Edge component')
}

{
  const score = recommendationReportScore({
    score_components: null,
  })
  assert(score === null, 'daily report must not use a missing-payload fallback')

  const scoreV2 = recommendationReportScoreV2({
    score_components: null,
  })
  assert(scoreV2 === null, 'daily report must not synthesize Score V2 without canonical payload')
}

{
  const signal = {
    symbol: '2330',
    name: 'TSMC',
    signal: 'BUY',
    score_v2: {
      version: 'score_v2',
      total: 59,
      finalScore: 62,
      components: {
        mlEdge: 20,
        chipFlow: 16,
        technicalStructure: 12,
        fundamentalQuality: 8,
        newsTheme: 3,
      },
    },
    confidence: 0.8,
    reason: 'test',
  }
  const score = actionableSignalDisplayScore(signal)
  assert(score === 62, 'tripartite notification should render canonical Score V2 finalScore')
  const summary = actionableSignalScoreSummary(signal)
  assert(summary.includes('Score V2 62'), 'tripartite notification should label canonical Score V2 score')
  assert(summary.includes('ML 20'), 'tripartite notification should include ML Edge component')
  assert(summary.includes('籌 16'), 'tripartite notification should include chipFlow component')
  assert(summary.includes('技 12'), 'tripartite notification should include technicalStructure component')
}

{
  const embed = buildTripartiteDailyEmbed({
    date: '2026-05-22',
    actionable: [{
      symbol: '2330',
      name: 'TSMC',
      signal: 'BUY',
      score_v2: {
        version: 'score_v2',
        total: 59,
        finalScore: 62,
        components: {
          mlEdge: 20,
          chipFlow: 16,
          technicalStructure: 12,
          fundamentalQuality: 8,
          newsTheme: 3,
        },
      },
      confidence: 0.8,
      reason: 'test reason',
    }],
    holdings: [],
    summary: {
      total_value: 1_000_000,
      cash: 100_000,
      daily_pnl_pct: 0.01,
      cumulative_pnl_pct: 0.02,
      trades_today: 1,
      max_drawdown: 0.03,
      sharpe: 1.2,
      momentum_zone: 'GREEN',
    },
  })
  const actionableField = embed.fields.find((field) => field.name.includes('Actionable'))
  assert(actionableField?.value.includes('Score V2 62'), 'daily embed actionable field should expose Score V2 score label')
  assert(!actionableField?.value.includes(' 分 62'), 'daily embed actionable field must not use ambiguous legacy score label')
}
