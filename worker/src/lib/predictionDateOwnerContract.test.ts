const fs = require('fs')
const path = require('path')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const repoRoot = path.resolve(process.cwd(), '..')

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

const predictionServingOwners = [
  'worker/src/routes/other.ts',
  'worker/src/routes/paper.ts',
  'worker/src/routes/stocks.ts',
  'worker/src/lib/dailyReport.ts',
  'worker/src/lib/dataQualityMonitor.ts',
  'worker/src/lib/pendingBuyOrchestrator.ts',
  'ml-controller/services/recommendation_service.py',
  'ml-controller/graphs/daily_pipeline_v2.py',
  'ml-controller/routers/model_pool.py',
  'ml-controller/services/shadow_ab_service.py',
  'ml-controller/services/backtest_engine.py',
]

const forbiddenFallbacks = [
  /date\s*\(\s*generated_at\s*,\s*['"]\+8 hours['"]\s*\)/i,
  /prediction_date\s+IS\s+NULL/i,
  /COALESCE\s*\([^)]*prediction_date/i,
]

for (const file of predictionServingOwners) {
  const source = readRepoFile(file)
  for (const pattern of forbiddenFallbacks) {
    assert(!pattern.test(source), `${file} must not reintroduce generated_at/prediction_date legacy fallback`)
  }
}

const recommendationService = readRepoFile('ml-controller/services/recommendation_service.py')
assert(
  recommendationService.includes('def prune_predictions_outside_universe('),
  'pipeline writer must prune stale same-date prediction rows outside the current screener universe',
)
assert(
  !recommendationService.includes('build_screener_seed_recommendations(') && !recommendationService.includes('controller_seed'),
  'ml-controller must not recreate recommendation seeds when screener source-of-truth is missing',
)

const workerTriggerTasks = readRepoFile('worker/src/lib/adminTriggerWorkerDomainTasks.ts')
assert(
  workerTriggerTasks.includes('recommendation: () => deps.runDailyRecommendation(requestedRunDate())'),
  'manual recommendation trigger must pass requested date into the V2 pipeline owner',
)

const pendingBuyOrchestrator = readRepoFile('worker/src/lib/pendingBuyOrchestrator.ts')
assert(
  pendingBuyOrchestrator.includes('const sourceRecoDate = prevDay'),
  'morning setup must name the previous trading day as sourceRecoDate to separate source recommendations from pending date',
)
assert(
  /WHERE dr\.date = \?[\s\S]*\.bind\(\s*sourceRecoDate,\s*sourceRecoDate,\s*cb\.buyConfThreshold,\s*candidateLimit\s*\)/.test(pendingBuyOrchestrator),
  'morning setup must bind sourceRecoDate for daily_recommendations.date instead of pendingDate',
)
assert(
  !/\.bind\(\s*prevDay,\s*pendingDate,\s*cb\.buyConfThreshold,\s*candidateLimit\s*\)/.test(pendingBuyOrchestrator),
  'morning setup must not bind pendingDate as the daily recommendation source date',
)

const recommendationRoutes = readRepoFile('worker/src/routes/other.ts')
assert(
  recommendationRoutes.includes('const FINAL_RECOMMENDATION_WHERE ='),
  'recommendations API must define a final recommendation predicate so screener-only seeds cannot become AI Top Picks',
)
assert(
  recommendationRoutes.includes('SELECT COUNT(*) as cnt FROM daily_recommendations WHERE date = ? AND ${FINAL_RECOMMENDATION_WHERE}'),
  'recommendations API must count only final recommendations when resolving today',
)
assert(
  recommendationRoutes.includes('SELECT date FROM daily_recommendations WHERE date < ? AND ${FINAL_RECOMMENDATION_WHERE} ORDER BY date DESC LIMIT 1'),
  'recommendations API fallback must search only final recommendation dates',
)
