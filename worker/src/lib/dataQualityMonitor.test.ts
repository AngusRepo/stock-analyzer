import {
  buildFreshnessCheck,
  buildFeatureVersionParityCheck,
  buildModelIcEvidenceCheck,
  buildPredictionCoverageCheck,
  buildRecommendationMlOwnerCheck,
  buildClassificationCoverageCheck,
  buildRrgTaxonomyCoverageCheck,
  buildScreenerSourceOfTruthCheck,
  buildPendingBuyDateSanityCheck,
  buildPendingBuyAllocatorOwnerCheck,
  buildBoardLaneContractCheck,
  buildDatasetSnapshotManifestCheck,
  buildRetrainFollowupClosureCheck,
  buildScreenerCandidateVolumeCheck,
  buildScreenerScoreDistributionCheck,
  buildSurfaceRoleConsistencyCheck,
  buildScreenerSeedQualityCheck,
  buildThemeSignalCoverageCheck,
  daysBetweenDates,
  EXPECTED_V2_MODELS,
  resolveExpectedCompletedDataDate,
  resolveExpectedTradingDate,
  summarizeDataQualityChecks,
} from './dataQualityMonitor'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const check = buildThemeSignalCoverageCheck({
    targetDate: '2026-05-15',
    themeSignalTotal: 8,
    themeSignalSources: 4,
    stockThemeFeatureTotal: 24,
    stockThemeFeatureSymbols: 12,
    latestThemeSignalAt: '2026-05-15T18:00:00+08:00',
    latestStockThemeFeatureAt: '2026-05-15T18:01:00+08:00',
  })
  assert(check.status === 'ok', 'theme signal runtime should pass when signals and stock-level features exist')
  assert(check.metrics?.source_of_truth === 'theme_signals + stock_theme_features', 'theme signal runtime must declare source of truth')
}

{
  const check = buildThemeSignalCoverageCheck({
    targetDate: '2026-05-15',
    themeSignalTotal: 0,
    themeSignalSources: 0,
    stockThemeFeatureTotal: 0,
    stockThemeFeatureSymbols: 0,
  })
  assert(check.status === 'fail', 'theme signal runtime must fail when multi-source evidence is missing')
}

{
  assert(daysBetweenDates('2026-04-28', '2026-04-29') === 1, 'date lag should be calendar-day based')
  assert(daysBetweenDates(null, '2026-04-29') === null, 'missing latest date should return null')
}

{
  const check = buildDatasetSnapshotManifestCheck({
    targetDate: '2026-05-05',
    priceHotWindow: 1,
    technicalHotWindow: 1,
    chipHotWindow: 1,
    backtestComputeSnapshot: 1,
    priceHistoryComputeSnapshot: 1,
    pipelineReport: 1,
    screenerReport: 1,
    total: 5,
  })
  assert(check.status === 'ok', 'dataset manifest check should pass when D1/GCS/R2 ownership records are present')
}

{
  const check = buildDatasetSnapshotManifestCheck({
    targetDate: '2026-05-05',
    priceHotWindow: 1,
    technicalHotWindow: 1,
    chipHotWindow: 1,
    backtestComputeSnapshot: 0,
    priceHistoryComputeSnapshot: 0,
    pipelineReport: 0,
    screenerReport: 0,
    total: 3,
  })
  assert(check.status === 'warn', 'missing compute/report artifacts should warn without hiding D1 serving freshness')
  assert(
    check.summary.includes('object-store artifacts pending'),
    'missing GCS/R2 artifacts should be described as pending when D1 serving manifests are ready',
  )
  assert(
    Array.isArray(check.metrics?.pending_object_artifacts) &&
      (check.metrics?.pending_object_artifacts as string[]).includes('backtest_dataset_compute'),
    'snapshot check metrics should expose pending object artifact names',
  )
}

{
  const check = buildDatasetSnapshotManifestCheck({
    targetDate: '2026-05-05',
    priceHotWindow: 0,
    technicalHotWindow: 1,
    chipHotWindow: 1,
    backtestComputeSnapshot: 1,
    priceHistoryComputeSnapshot: 1,
    pipelineReport: 1,
    screenerReport: 1,
    total: 4,
  })
  assert(check.status === 'fail', 'missing D1 hot-window manifests must fail Data Quality')
}

{
  const check = buildRetrainFollowupClosureCheck({
    awaiting: 1,
    stale: 1,
    oldestAt: '2026-05-02T20:09:50.877697Z',
    latestAt: '2026-05-02T20:09:50.877697Z',
  })
  assert(check.status === 'fail', 'stale monthly retrain followup should fail data quality')
  assert(check.summary.includes('orphaned'), 'stale followup summary should name the orphaned callback state')
}

{
  const check = buildRetrainFollowupClosureCheck({
    awaiting: 1,
    stale: 0,
    oldestAt: '2026-05-08T02:00:00.000Z',
    latestAt: '2026-05-08T02:00:00.000Z',
  })
  assert(check.status === 'warn', 'fresh in-flight monthly retrain followup should warn, not fail')
}

void (async () => {
  const holidaySet = new Set(['2026-05-01'])
  const kv = {
    get: async (key: string) => holidaySet.has(key.replace('holiday:', '')) ? '1' : null,
  } as unknown as KVNamespace
  const expected = await resolveExpectedTradingDate(kv, '2026-05-03')
  assert(expected === '2026-04-30', `holiday/weekend data-quality target should be previous trading day, got ${expected}`)

  const beforeEodReady = await resolveExpectedCompletedDataDate(
    kv,
    '2026-05-05',
    new Date('2026-05-05T16:44:00.000Z'),
  )
  assert(beforeEodReady === '2026-05-04', `intraday data-quality target should use last completed trading day, got ${beforeEodReady}`)

  const afterEodReady = await resolveExpectedCompletedDataDate(
    kv,
    '2026-05-05',
    new Date('2026-05-05T18:45:00.000Z'),
  )
  assert(afterEodReady === '2026-05-05', `post-EOD data-quality target should use current trading day, got ${afterEodReady}`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})

{
  const check = buildFreshnessCheck({
    id: 'price_freshness',
    label: 'Price data',
    latestDate: '2026-04-29',
    targetDate: '2026-04-30',
    rowsOnLatest: 2283,
    warnLagDays: 0,
    failLagDays: 0,
  })
  assert(check.status === 'fail', 'EOD price data must match the target date')
}

{
  const check = buildFreshnessCheck({
    id: 'chip_freshness',
    label: 'Chip data',
    latestDate: '2026-04-27',
    targetDate: '2026-04-30',
    rowsOnLatest: 5100,
    warnLagDays: 0,
    failLagDays: 0,
  })
  assert(check.status === 'fail', 'EOD chip data must match the target date')
}

{
  const check = buildFreshnessCheck({
    id: 'technical_indicator_freshness',
    label: 'Technical indicators',
    latestDate: '2026-04-30',
    targetDate: '2026-04-30',
    rowsOnLatest: 32,
    warnLagDays: 0,
    failLagDays: 0,
    minRows: 1000,
  })
  assert(check.status === 'fail', 'technical indicators must be full-market, not watchlist-only')
  assert(check.summary.includes('rows=32/1000'), 'technical indicator row floor must be explicit')
}

{
  const rows = EXPECTED_V2_MODELS
    .filter((model) => model !== 'TimesFM')
    .map((model) => ({ model_name: model, count: 20, stocks: 20 }))
  const check = buildPredictionCoverageCheck(rows)
  assert(check.status === 'fail', 'missing one of the V2 production models should fail prediction coverage')
  assert((check.metrics?.missing_models as string[]).includes('TimesFM'), 'missing model should be reported')
}

{
  const rows = EXPECTED_V2_MODELS.map((model) => ({
    model_name: model,
    count: 60,
    stocks: 60,
    latest_date: '2026-04-30',
  }))
  const check = buildModelIcEvidenceCheck(rows)
  assert(check.status === 'ok', 'all V2 models with enough verified IC samples should pass')
  assert(check.metrics?.source_of_truth === 'predictions.verified_at + model_pool.compute_weekly_ic', 'IC evidence must point to V2 source of truth')
}

{
  const rows = EXPECTED_V2_MODELS
    .filter((model) => model !== 'TabM')
    .map((model) => ({
      model_name: model,
      count: 60,
      stocks: 60,
      latest_date: '2026-04-30',
    }))
  const check = buildModelIcEvidenceCheck(rows)
  assert(check.status === 'fail', 'missing V2 model IC evidence should fail')
  assert((check.metrics?.missing_models as string[]).includes('TabM'), 'missing IC model should be explicit')
}

{
  const check = buildClassificationCoverageCheck({ total: 20, missingIndustryTags: 8 })
  assert(check.status === 'warn', 'high missing industry tag coverage should warn')
}

{
  const check = buildClassificationCoverageCheck({
    total: 64,
    missingIndustryTags: 24,
    tradableTotal: 40,
    tradableMissingIndustryTags: 0,
    researchTotal: 24,
    researchMissingIndustryTags: 24,
  })
  assert(check.status === 'ok', 'research-only emerging taxonomy gaps should not block the tradable lane')
  assert(check.summary.includes('tradable_industry_tags=40/40'), 'classification summary should expose tradable coverage')
  assert(check.summary.includes('research_missing=24/24'), 'classification summary should expose research lane backlog')
  assert(check.metrics?.status_scope === 'tradable_lane', 'classification severity should be scoped to tradable lane when available')
}

{
  const check = buildRrgTaxonomyCoverageCheck({
    latestThemeDate: '2026-04-30',
    targetDate: '2026-04-30',
    latestThemeRows: 47,
    topConceptSymbols: 494,
    topUnmappedSymbols: 0,
    topOtherSymbols: 0,
  })
  assert(check.status === 'ok', 'aligned concept taxonomy and RRG theme universe should pass')
  assert(check.metrics?.source_of_truth === 'stock_tags.tag_type=concept + latest sector_flow.classification=theme', 'RRG taxonomy gate must declare its source of truth')
}

{
  const check = buildRrgTaxonomyCoverageCheck({
    latestThemeDate: '2026-04-07',
    targetDate: '2026-04-30',
    latestThemeRows: 47,
    topConceptSymbols: 494,
    topUnmappedSymbols: 0,
    topOtherSymbols: 0,
  })
  assert(check.status === 'fail', 'stale RRG theme snapshot must fail data quality')
}

{
  const check = buildRrgTaxonomyCoverageCheck({
    latestThemeDate: '2026-04-30',
    targetDate: '2026-04-30',
    latestThemeRows: 47,
    topConceptSymbols: 100,
    topUnmappedSymbols: 7,
    topOtherSymbols: 2,
  })
  assert(check.status === 'warn', 'unmapped top concepts should warn instead of silently polluting RRG gates')
  assert(check.summary.includes('unmapped=7/100'), 'RRG taxonomy summary must expose unmapped ratio')
}

{
  const check = buildScreenerSourceOfTruthCheck({
    targetDate: '2026-04-30',
    funnelRunId: 'screener-2026-04-30-1',
    funnelStatus: 'success',
    funnelFinalCount: 40,
    funnelEmergingCount: 6,
    dailyTotal: 46,
    tradableCount: 40,
    emergingCount: 6,
    eligibleMlCount: 46,
    eligiblePendingCount: 40,
  })
  assert(check.status === 'ok', 'daily recommendation seeds should align to the latest screener funnel run')
  assert(check.metrics?.source_of_truth === 'screener_funnel_runs -> daily_recommendations seed rows', 'screener gate must declare source of truth')
}

{
  const check = buildScreenerSourceOfTruthCheck({
    targetDate: '2026-04-30',
    funnelRunId: null,
    funnelStatus: null,
    funnelFinalCount: 0,
    funnelEmergingCount: 0,
    dailyTotal: 46,
    tradableCount: 40,
    emergingCount: 6,
    eligibleMlCount: 46,
    eligiblePendingCount: 40,
  })
  assert(check.status === 'fail', 'seed rows without same-day screener funnel evidence must fail')
}

{
  const check = buildScreenerSourceOfTruthCheck({
    targetDate: '2026-04-30',
    funnelRunId: 'screener-2026-04-30-1',
    funnelStatus: 'success',
    funnelFinalCount: 40,
    funnelEmergingCount: 6,
    dailyTotal: 45,
    tradableCount: 39,
    emergingCount: 6,
    eligibleMlCount: 45,
    eligiblePendingCount: 39,
  })
  assert(check.status === 'fail', 'daily seed count must not drift from screener funnel final/emerging counts')
  assert(check.summary.includes('daily=45 funnel=46'), 'source-of-truth summary must expose count mismatch')
}

{
  const check = buildScreenerSourceOfTruthCheck({
    targetDate: '2026-04-30',
    funnelRunId: 'screener-2026-04-30-1',
    funnelStatus: 'success',
    funnelFinalCount: 40,
    funnelEmergingCount: 6,
    dailyTotal: 46,
    tradableCount: 40,
    emergingCount: 6,
    eligibleMlCount: 46,
    eligiblePendingCount: 46,
  })
  assert(check.status === 'fail', 'emerging research lane must not become pending-buy eligible')
}

{
  const check = buildScreenerSeedQualityCheck({
    total: 20,
    unclassified: 3,
    invalidScores: 1,
    missingComponents: 2,
    missingReasons: 0,
  })
  assert(check.status === 'fail', 'invalid screener seed rows should fail data quality')
  assert(check.summary.includes('invalid=1'), 'invalid score count should be explicit')
}

{
  const check = buildScreenerSeedQualityCheck({
    total: 20,
    unclassified: 12,
    invalidScores: 0,
    missingComponents: 0,
    missingReasons: 0,
  })
  assert(check.status === 'fail', 'mostly unclassified screener seed rows should fail data quality')
}

{
  const check = buildScreenerCandidateVolumeCheck({ total: 5, minCandidates: 10 })
  assert(check.status === 'fail', 'too few screener candidates should fail data quality')
}

{
  const check = buildScreenerScoreDistributionCheck({
    total: 20,
    avgScore: 92,
    minScore: 88,
    maxScore: 100,
    highScoreCount: 19,
    perfectScoreCount: 4,
  })
  assert(check.status === 'warn', 'over-compressed high scores should warn data quality')
}

{
  const check = buildPendingBuyDateSanityCheck({
    targetDate: '2026-04-30',
    runTradeDate: '2026-04-30',
    sourceRecoDate: '2026-04-29',
    candidateCount: 3,
    activeCount: 1,
  })
  assert(check.status === 'ok', 'pending buys should use previous recommendation date for next trade date')
}

{
  const check = buildPendingBuyDateSanityCheck({
    targetDate: '2026-04-30',
    runTradeDate: '2026-04-30',
    sourceRecoDate: '2026-04-30',
    candidateCount: 3,
    activeCount: 1,
  })
  assert(check.status === 'fail', 'pending buys must not use same-date recommendation as execution pool')
}

{
  const check = buildSurfaceRoleConsistencyCheck({
    recommendationRole: 'recommendation_candidate',
    pendingBuyRole: 'execution_pool',
  })
  assert(check.status === 'ok', 'dashboard and bot should expose distinct source roles')
}

{
  const check = buildBoardLaneContractCheck({
    emergingRecommendations: 4,
    pendingBuyEmergingLike: 0,
  })
  assert(check.status === 'ok', 'emerging recommendations are allowed only as watchlist lane')
}

{
  const check = buildBoardLaneContractCheck({
    emergingRecommendations: 4,
    pendingBuyEmergingLike: 1,
  })
  assert(check.status === 'fail', 'emerging-style pending buys must fail the quality gate')
}

{
  const check = buildPendingBuyAllocatorOwnerCheck({
    activeCount: 2,
    l4SparseFinalBuyCount: 2,
    invalidAllocatorCount: 0,
    watchSourceCount: 0,
    missingRecommendationCount: 0,
  })
  assert(check.status === 'ok', 'pending buys should pass when every active row is L4 sparse final BUY')
  assert(check.summary.includes('no executable watch fallback'), 'pending-buy allocator owner check should state watch fallback is disabled')
}

{
  const check = buildPendingBuyAllocatorOwnerCheck({
    activeCount: 2,
    l4SparseFinalBuyCount: 1,
    invalidAllocatorCount: 1,
    watchSourceCount: 0,
    missingRecommendationCount: 0,
  })
  assert(check.status === 'fail', 'pending buys must fail when any active row lacks L4 sparse selected evidence')
}

{
  const check = buildPendingBuyAllocatorOwnerCheck({
    activeCount: 1,
    l4SparseFinalBuyCount: 0,
    invalidAllocatorCount: 1,
    watchSourceCount: 1,
    missingRecommendationCount: 1,
  })
  assert(check.status === 'fail', 'pending buys must fail when WATCH_BUY or missing recommendation rows enter execution pool')
  assert(check.summary.includes('watch=1'), 'pending-buy allocator owner check should expose watch leakage count')
}

{
  const check = buildRecommendationMlOwnerCheck({
    total: 20,
    scoreV2Count: 0,
    signalCount: 0,
    confidenceCount: 0,
    predictionRows: 200,
  })
  assert(check.status === 'fail', 'recommendations with predictions but no Score V2 payloads should fail')
}

{
  const check = buildFeatureVersionParityCheck({
    total: 100,
    missingFeatureVersion: 20,
    distinctFeatureVersions: 1,
  })
  assert(check.status === 'warn', 'partial missing feature_version should warn train/serve parity')
}

{
  const check = buildFeatureVersionParityCheck({
    total: 100,
    missingFeatureVersion: 100,
    distinctFeatureVersions: 0,
  })
  assert(check.status === 'fail', 'all missing feature_version should fail train/serve parity')
}

{
  const status = summarizeDataQualityChecks([
    { id: 'a', label: 'A', status: 'ok', summary: 'ok' },
    { id: 'b', label: 'B', status: 'warn', summary: 'warn' },
  ])
  assert(status === 'warn', 'summary should preserve warning severity')
}
