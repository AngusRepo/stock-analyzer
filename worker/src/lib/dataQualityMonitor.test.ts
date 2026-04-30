import {
  buildFreshnessCheck,
  buildFeatureVersionParityCheck,
  buildPredictionCoverageCheck,
  buildRecommendationMlOwnerCheck,
  buildClassificationCoverageCheck,
  buildPendingBuyDateSanityCheck,
  buildScreenerCandidateVolumeCheck,
  buildScreenerScoreDistributionCheck,
  buildSurfaceRoleConsistencyCheck,
  buildScreenerSeedQualityCheck,
  daysBetweenDates,
  EXPECTED_V2_MODELS,
  summarizeDataQualityChecks,
} from './dataQualityMonitor'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  assert(daysBetweenDates('2026-04-28', '2026-04-29') === 1, 'date lag should be calendar-day based')
  assert(daysBetweenDates(null, '2026-04-29') === null, 'missing latest date should return null')
}

{
  const check = buildFreshnessCheck({
    id: 'price_freshness',
    label: 'Price data',
    latestDate: '2026-04-24',
    targetDate: '2026-04-29',
    rowsOnLatest: 100,
    warnLagDays: 1,
    failLagDays: 3,
  })
  assert(check.status === 'fail', 'stale price data should fail the quality gate')
}

{
  const rows = EXPECTED_V2_MODELS
    .filter((model) => model !== 'Chronos')
    .map((model) => ({ model_name: model, count: 20, stocks: 20 }))
  const check = buildPredictionCoverageCheck(rows)
  assert(check.status === 'fail', 'missing one of the 10 V2 models should fail prediction coverage')
  assert((check.metrics?.missing_models as string[]).includes('Chronos'), 'missing model should be reported')
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
