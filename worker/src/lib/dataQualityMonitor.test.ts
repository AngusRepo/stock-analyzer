import {
  buildFreshnessCheck,
  buildFeatureVersionParityCheck,
  buildModelIcEvidenceCheck,
  buildPredictionCoverageCheck,
  buildRecommendationMlOwnerCheck,
  buildClassificationCoverageCheck,
  buildPendingBuyDateSanityCheck,
  buildBoardLaneContractCheck,
  buildScreenerCandidateVolumeCheck,
  buildScreenerScoreDistributionCheck,
  buildSurfaceRoleConsistencyCheck,
  buildScreenerSeedQualityCheck,
  daysBetweenDates,
  EXPECTED_V2_MODELS,
  resolveExpectedTradingDate,
  summarizeDataQualityChecks,
} from './dataQualityMonitor'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  assert(daysBetweenDates('2026-04-28', '2026-04-29') === 1, 'date lag should be calendar-day based')
  assert(daysBetweenDates(null, '2026-04-29') === null, 'missing latest date should return null')
}

void (async () => {
  const holidaySet = new Set(['2026-05-01'])
  const kv = {
    get: async (key: string) => holidaySet.has(key.replace('holiday:', '')) ? '1' : null,
  } as unknown as KVNamespace
  const expected = await resolveExpectedTradingDate(kv, '2026-05-03')
  assert(expected === '2026-04-30', `holiday/weekend data-quality target should be previous trading day, got ${expected}`)
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
  const rows = EXPECTED_V2_MODELS
    .filter((model) => model !== 'Chronos')
    .map((model) => ({ model_name: model, count: 20, stocks: 20 }))
  const check = buildPredictionCoverageCheck(rows)
  assert(check.status === 'fail', 'missing one of the V2 production models should fail prediction coverage')
  assert((check.metrics?.missing_models as string[]).includes('Chronos'), 'missing model should be reported')
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
    .filter((model) => model !== 'FT-Transformer')
    .map((model) => ({
      model_name: model,
      count: 60,
      stocks: 60,
      latest_date: '2026-04-30',
    }))
  const check = buildModelIcEvidenceCheck(rows)
  assert(check.status === 'fail', 'missing V2 model IC evidence should fail')
  assert((check.metrics?.missing_models as string[]).includes('FT-Transformer'), 'missing IC model should be explicit')
}

{
  const check = buildClassificationCoverageCheck({ total: 20, missingIndustryTags: 8 })
  assert(check.status === 'warn', 'high missing industry tag coverage should warn')
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
  const check = buildRecommendationMlOwnerCheck({
    total: 20,
    mlScorePositive: 0,
    signalCount: 0,
    confidenceCount: 0,
    predictionRows: 200,
  })
  assert(check.status === 'fail', 'recommendations with predictions but no ML owner fields should fail')
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
