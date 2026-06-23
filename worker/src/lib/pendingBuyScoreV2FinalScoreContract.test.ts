import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const pendingBuyOrchestrator = readFileSync('src/lib/pendingBuyOrchestrator.ts', 'utf8')
const postExit = readFileSync('src/lib/postExit.ts', 'utf8')
const paperEntryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const pendingBuyStore = readFileSync('src/lib/pendingBuyStore.ts', 'utf8')
const paperRoute = readFileSync('src/routes/paper.ts', 'utf8')

{
  assert(
    paperRoute.includes('pending_buy_execution_policy_v1') &&
      paperRoute.includes("execution_pool_policy: 'l4_sparse_final_buy_only'") &&
      paperRoute.includes("allocator_owner: 'layer4_sparse_allocation'") &&
      paperRoute.includes("allocation_engine: 'sparse_tangent_inverse_risk'"),
    '/paper/pending-buys must expose stable L4 sparse execution policy provenance',
  )
  assert(
    paperRoute.includes('execution_policy: executionPolicy') &&
      paperRoute.includes('buildPendingBuyExecutionPolicy(snapshot.meta'),
    '/paper/pending-buys response must include the execution policy beside state and pendingBuys',
  )
  assert(
    paperRoute.includes('loadPendingBuySnapshot(c.env, twToday, { allowFallbackRecent: false })'),
    '/paper/pending-buys must read exact-date pending snapshots instead of stale recent fallback',
  )
  assert(
    paperRoute.includes('watch_fallback_allowed: false') &&
      paperRoute.includes('ml_watch_rows_executable: false') &&
      paperRoute.includes('raw_recommendation_rows_executable: false') &&
      paperRoute.includes('legacy_topk_fallback_allowed: false'),
    '/paper/pending-buys policy must keep watch/raw/top-k fallback out of executable pending buys',
  )
  assert(
    paperRoute.includes("'has_buy_signal=1'") &&
      paperRoute.includes("'alpha_allocation.selected=1'") &&
      paperRoute.includes("'alpha_allocation.engine=sparse_tangent_inverse_risk'"),
    '/paper/pending-buys policy must document the required L4 daily_recommendations evidence',
  )
}

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
  assert(
    morningSetupQuery.includes("json_extract(dr.score_components, '$.finalScore')"),
    'morning setup pending buys should rank by canonical Score V2 finalScore',
  )
  assert(
    morningSetupQuery.includes('COALESCE(dr.has_buy_signal, 0) = 1') &&
      morningSetupQuery.includes("json_extract(dr.alpha_allocation, '$.selected') = 1") &&
      morningSetupQuery.includes("json_extract(dr.alpha_allocation, '$.engine') = 'sparse_tangent_inverse_risk'"),
    'morning setup execution pool must only consume L4 sparse final BUY rows',
  )
  assert(
    !morningSetupQuery.includes('WHERE dr.date = ?\n         AND dr.confidence >= ?\n         AND COALESCE(dr.eligible_for_pending_buy, 1) = 1'),
    'morning setup must not let adaptive buyConfThreshold block final allocator has_buy_signal rows',
  )
  assert(
    !morningSetupQuery.includes('OR (\n             dr.confidence >= ?') &&
      !morningSetupQuery.includes("json_extract(dr.score_components, '$.components.mlEdge') >= ?"),
    'morning setup must not reintroduce ML-qualified watch fallback after L4 sparse allocation',
  )
  assert(
    pendingBuyOrchestrator.includes("execution_pool_policy: 'l4_sparse_final_buy_only'") &&
      pendingBuyOrchestrator.includes("const executionRole = 'l4_sparse_final_buy'"),
    'morning setup must label the executable pool as L4 sparse final BUY only',
  )
  assert(
    !pendingBuyOrchestrator.includes('ml_qualified_watch') &&
      !pendingBuyOrchestrator.includes('morning_setup_ml_watch') &&
      !pendingBuyOrchestrator.includes('WATCH_BUY') &&
      !pendingBuyOrchestrator.includes('EXECUTION_WATCH_POOL_SIZE'),
    'morning setup must keep ML watch evidence out of executable pending buys',
  )
  assert(
    pendingBuyOrchestrator.includes('debate_retry_pending') &&
      pendingBuyOrchestrator.includes('debate_retry:debate_missing') &&
      pendingBuyOrchestrator.includes("debateStatus: failedCount > 0 ? 'pending' : 'completed'") &&
      !pendingBuyOrchestrator.includes('debate_failed_closed'),
    'debate outages must keep the execution watch pool active for retry instead of terminal-skipping candidates',
  )
  assert(
    !morningSetupQuery.includes('ORDER BY dr.score DESC'),
    'morning setup pending buys must not rank by legacy daily_recommendations.score',
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
  assert(
    pendingBuyOrchestrator.includes('buildSparseAllocationSummary(rec.alpha_allocation)') &&
      pendingBuyOrchestrator.includes('buildL4SparseAllocationWatchPoint(sparseAllocation)'),
    'morning setup pending buys should persist L4 sparse allocation weight evidence for execution sizing',
  )
  assert(
    pendingBuyOrchestrator.includes('pending_buy_filter_audit') &&
      pendingBuyOrchestrator.includes('filter_audit: filterAudit') &&
      pendingBuyOrchestrator.includes('empty_reason: emptyReason'),
    'morning setup should persist filter audit evidence for empty-after-filter diagnosis',
  )
  assert(
    pendingBuyOrchestrator.includes("reason_code: 'RRG_LAGGING_SOFT_RISK'") &&
      pendingBuyOrchestrator.includes("action: 'SOFT_DOWNGRADE_DEBATE_REQUIRED'") &&
      pendingBuyOrchestrator.includes('rrg_lagging_soft_downgrade') &&
      pendingBuyOrchestrator.includes('debate_required=true') &&
      !pendingBuyOrchestrator.includes("action: 'REJECT'"),
    'RRG Lagging must be a soft risk/debate overlay, not a hard reject in morning setup',
  )
  assert(
    pendingBuyOrchestrator.includes('formatEntryPriceModelV2WatchPoint(buildEntryPriceModelV2FromOhlcvPlan(ohlcvEntryPlan))'),
    'morning setup pending buys should persist Entry Model V2 daily proxy evidence beside the OHLCV trade plan',
  )
  assert(
    !morningSetupQuery.includes('dr.signal_source'),
    'morning setup must not read nonexistent daily_recommendations.signal_source schema column',
  )
  assert(
    morningSetupQuery.includes("json_extract(dr.alpha_allocation, '$.engine')") &&
      morningSetupQuery.includes("json_extract(dr.alpha_allocation, '$.controller')") &&
      morningSetupQuery.includes('AS signal_source'),
    'morning setup must derive final allocator signal_source from alpha_allocation provenance',
  )
  assert(
    pendingBuyOrchestrator.includes('Signal Provenance (sparse tangent)'),
    'pending-buy provenance must identify sparse tangent allocation instead of old ranking promotion',
  )
  assert(
    paperEntryTasks.includes('l4SparseSizingFromWatchPoints(pending.watch_points)') &&
      paperEntryTasks.includes('resolveL4SparseBudgetFloor') &&
      paperEntryTasks.includes("let sizingMode: 'kelly' | 'risk_parity' | 'l4_sparse_weight'"),
    'paper entry sizing should consume L4 sparse allocation weight as a budget floor before daily/cash/slot caps',
  )
  assert(
    paperEntryTasks.includes('avgVolume20dMap') &&
      paperEntryTasks.includes('partial_fill_liquidity_base_source') &&
      paperEntryTasks.includes("'avg_volume_20d'"),
    'paper entry partial-fill realism should use 20d average volume as the liquidity base when available',
  )
  assert(
    !pendingBuyOrchestrator.includes('Signal Provenance (ranking promoted)'),
    'pending-buy provenance must not label sparse tangent BUYs as ranking promotion',
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
  assert(
    postExitRecommendationQuery.includes('COALESCE(dr.has_buy_signal, 0) = 1') &&
      postExitRecommendationQuery.includes("json_extract(dr.alpha_allocation, '$.selected') = 1") &&
      postExitRecommendationQuery.includes("json_extract(dr.alpha_allocation, '$.engine') = 'sparse_tangent_inverse_risk'") &&
      !postExitRecommendationQuery.includes("json_extract(dr.score_components, '$.components.mlEdge') >= ?"),
    'post-exit rerank must only use L4 sparse final BUY rows',
  )
  assert(
    postExit.includes('post_exit_l4_sparse_rerank') &&
      postExit.includes('position_cap(') &&
      !postExit.includes('post_exit_ml_watch_rerank') &&
      !postExit.includes('WATCH_BUY') &&
      !postExit.includes('at_topK('),
    'post-exit rerank should only enqueue L4 sparse final BUY replacements and avoid old top-k/watch terminology',
  )
  assert(
    postExitRecommendationQuery.includes("json_extract(dr.score_components, '$.finalScore')"),
    'post-exit rerank should rank by canonical Score V2 finalScore',
  )
  assert(
    !postExitRecommendationQuery.includes('ORDER BY dr.score DESC'),
    'post-exit rerank must not rank by legacy daily_recommendations.score',
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
  const projectionStart = pendingBuyStore.indexOf('export function normalizePendingBuyScoreProjection')
  const projectionEnd = pendingBuyStore.indexOf('function normalizePendingBuyScoreProjections', projectionStart)
  assert(projectionStart >= 0 && projectionEnd > projectionStart, 'pending-buy storage projection block should be locatable')
  const projectionBlock = pendingBuyStore.slice(projectionStart, projectionEnd)
  for (const staleFirstProjection of [
    'item.chip_score ?? scoreV2?.components.chipFlow',
    'item.tech_score ?? scoreV2?.components.technicalStructure',
    'item.ml_score ?? scoreV2?.components.mlEdge',
    'item.score ?? scoreV2?.finalScore',
  ]) {
    assert(
      !projectionBlock.includes(staleFirstProjection),
      `pending-buy storage projection must prefer canonical score_v2 over stale legacy field ${staleFirstProjection}`,
    )
  }
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
