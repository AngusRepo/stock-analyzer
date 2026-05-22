import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const pendingBuyOrchestrator = readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const postExit = readFileSync('src/lib/postExit.ts', 'utf8')
const paperEntryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const pendingBuyStore = readFileSync('src/lib/pendingBuyStore.ts', 'utf8')

{
  const morningSetupQueryStart = pendingBuyOrchestrator.indexOf('const { results } = await env.DB.prepare')
  const morningSetupQueryEnd = pendingBuyOrchestrator.indexOf(').bind(sourceRecoDate', morningSetupQueryStart)
  assert(
    morningSetupQueryStart >= 0 && morningSetupQueryEnd > morningSetupQueryStart,
    'morning setup daily recommendation query should be locatable',
  )
  const morningSetupQuery = pendingBuyOrchestrator.slice(morningSetupQueryStart, morningSetupQueryEnd)
  assert(
    pendingBuyOrchestrator.includes('score_v2: serializeScoreV2Snapshot(scoreV2)'),
    'morning setup pending buys should persist canonical score_v2 payload',
  )
  assert(
    morningSetupQuery.includes('dr.score_components'),
    'morning setup pending buys should read canonical Score V2 payload from daily_recommendations',
  )
  for (const legacyField of ['dr.score,', 'dr.chip_score', 'dr.tech_score', 'dr.ml_score', 'dr.momentum_score']) {
    assert(
      !morningSetupQuery.includes(legacyField),
      `morning setup pending buys must not read legacy ${legacyField} from daily_recommendations`,
    )
  }
  assert(
    pendingBuyOrchestrator.includes('serializeScoreV2Snapshot(scoreV2)'),
    'morning setup pending buys should keep canonical Score V2 payload on the pending-buy item',
  )
  for (const legacyProjection of [
    'chip_score: scoreV2.components.chipFlow',
    'tech_score: scoreV2.components.technicalStructure',
    'ml_score: scoreV2.components.mlEdge',
    'score: scoreV2.finalScore',
  ]) {
    assert(
      !pendingBuyOrchestrator.includes(legacyProjection),
      `morning setup should not hand-write pending-buy storage projection ${legacyProjection}`,
    )
  }
  assert(
    !pendingBuyOrchestrator.includes('item.score ?? item.ml_score'),
    'morning debate candidate scores must not fall back to legacy pending-buy ml_score projection',
  )
  assert(
    !pendingBuyOrchestrator.includes('score: scoreV2.total'),
    'morning setup pending buys must not drop alpha adjustment by using Score V2 total',
  )
}

{
  const postExitRecommendationQueryStart = postExit.indexOf('const { results: recs } = await ctx.db.prepare')
  const postExitRecommendationQueryEnd = postExit.indexOf(').bind(ctx.today)', postExitRecommendationQueryStart)
  assert(
    postExitRecommendationQueryStart >= 0 && postExitRecommendationQueryEnd > postExitRecommendationQueryStart,
    'post-exit daily recommendation query should be locatable',
  )
  const postExitRecommendationQuery = postExit.slice(postExitRecommendationQueryStart, postExitRecommendationQueryEnd)
  assert(
    postExit.includes('score_v2: serializeScoreV2Snapshot(scoreV2)'),
    'post-exit rerank pending buys should persist canonical score_v2 payload',
  )
  for (const legacyProjection of [
    'chip_score: scoreV2.components.chipFlow',
    'tech_score: scoreV2.components.technicalStructure',
    'ml_score: scoreV2.components.mlEdge',
    'score: scoreV2.finalScore',
  ]) {
    assert(
      !postExit.includes(legacyProjection),
      `post-exit rerank should not hand-write pending-buy storage projection ${legacyProjection}`,
    )
  }
  assert(
    postExitRecommendationQuery.includes('dr.score_components'),
    'post-exit rerank should read canonical Score V2 payload from daily_recommendations',
  )
  for (const legacyField of ['dr.score,', 'dr.chip_score', 'dr.tech_score', 'dr.ml_score', 'dr.momentum_score']) {
    assert(
      !postExitRecommendationQuery.includes(legacyField),
      `post-exit rerank must not read legacy ${legacyField} from daily_recommendations`,
    )
  }
  assert(
    postExit.includes('score=${scoreV2.finalScore}'),
    'post-exit rerank logs should report Score V2 finalScore',
  )
  assert(
    !postExit.includes('score: scoreV2.total') && !postExit.includes('score=${scoreV2.total}'),
    'post-exit rerank must not use Score V2 total where scalar score is expected',
  )
}

{
  assert(
    pendingBuyStore.includes('export function normalizePendingBuyScoreProjection'),
    'pending-buy store should own storage projection compatibility',
  )
  assert(
    pendingBuyStore.includes('scoreV2?.components.chipFlow') &&
      pendingBuyStore.includes('scoreV2?.components.technicalStructure') &&
      pendingBuyStore.includes('scoreV2?.components.mlEdge') &&
      pendingBuyStore.includes('scoreV2?.finalScore'),
    'pending-buy store should derive legacy D1 columns from canonical score_v2',
  )
}

{
  const decisionLogQueryStart = paperEntryTasks.indexOf('const recRow = await env.DB.prepare')
  const decisionLogQueryEnd = paperEntryTasks.indexOf(').bind(today, pending.symbol)', decisionLogQueryStart)
  assert(
    decisionLogQueryStart >= 0 && decisionLogQueryEnd > decisionLogQueryStart,
    'paper entry daily recommendation query should be locatable',
  )
  const decisionLogQuery = paperEntryTasks.slice(decisionLogQueryStart, decisionLogQueryEnd)
  assert(
    decisionLogQuery.includes('SELECT score_components'),
    'paper entry decision log should read only canonical Score V2 payload from daily_recommendations',
  )
  for (const legacyField of ['chip_score', 'tech_score', 'ml_score', 'momentum_score']) {
    assert(
      !decisionLogQuery.includes(legacyField),
      `paper entry decision log must not read legacy ${legacyField} from daily_recommendations`,
    )
  }
  const decisionLogInsertStart = paperEntryTasks.indexOf('INSERT OR REPLACE INTO decision_logs', decisionLogQueryEnd)
  const decisionLogInsertEnd = paperEntryTasks.indexOf(').bind(', decisionLogInsertStart)
  assert(
    decisionLogInsertStart >= 0 && decisionLogInsertEnd > decisionLogInsertStart,
    'paper entry decision log insert should be locatable',
  )
  const decisionLogInsert = paperEntryTasks.slice(decisionLogInsertStart, decisionLogInsertEnd)
  assert(
    decisionLogInsert.includes('score_components') &&
      paperEntryTasks.includes('decisionScoreComponents') &&
      paperEntryTasks.includes('finalScore: scoreV2.finalScore'),
    'paper entry decision log should persist canonical Score V2 payload into decision_logs.score_components',
  )
  for (const legacyProjection of ['chip_score', 'tech_score', 'ml_score', 'total_score', 'chip_pct', 'tech_pct', 'ml_pct']) {
    assert(
      !decisionLogInsert.includes(legacyProjection),
      `paper entry decision log insert must not write legacy projection ${legacyProjection}`,
    )
  }
  assert(
    !paperEntryTasks.includes('          scoreV2.total,'),
    'paper entry decision log must not write unadjusted Score V2 total into total_score',
  )
}
