import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const route = readFileSync('src/routes/other.ts', 'utf8')
const dailyReport = readFileSync('src/lib/dailyReport.ts', 'utf8')
const historyStart = route.indexOf("recommendations.get('/history'")
const historyEnd = route.indexOf("recommendations.get('/sector-flow'")
assert(historyStart >= 0 && historyEnd > historyStart, 'recommendation history route should be locatable')

const historyBlock = route.slice(historyStart, historyEnd)
const historySelectEnd = historyBlock.indexOf('FROM daily_recommendations r')
assert(historySelectEnd > 0, 'recommendation history query select list should be locatable')
const historySelectList = historyBlock.slice(0, historySelectEnd)
assert(
  historySelectList.includes('r.score_components'),
  'recommendation history query should read canonical Score V2 payload',
)
for (const legacyField of ['r.score,', 'r.ml_score', 'r.chip_score', 'r.tech_score', 'r.momentum_score']) {
  assert(
    !historySelectList.includes(legacyField),
    `recommendation history query must not select legacy ${legacyField}`,
  )
}
assert(
  historyBlock.includes('recommendationScoreV2Payload(row)'),
  'recommendation history should normalize DB projection through the Score V2 payload helper',
)
assert(
  historyBlock.includes('score_v2: scoreV2'),
  'recommendation history response should expose canonical score_v2 payload',
)
assert(
  historyBlock.includes('score: scoreV2?.finalScore ?? null'),
  'recommendation history scalar score should be derived from Score V2 finalScore',
)
assert(
  !historyBlock.includes('return c.json(results ?? [])'),
  'recommendation history must not return raw DB rows with legacy projection columns',
)

const responseShapeStart = historyBlock.indexOf('return {')
const responseShape = historyBlock.slice(responseShapeStart)
for (const legacyOutput of [
  'score_components:',
  'ml_score:',
  'chip_score:',
  'tech_score:',
  'momentum_score:',
]) {
  assert(!responseShape.includes(legacyOutput), `recommendation history response should not expose ${legacyOutput}`)
}

assert(
  dailyReport.includes('recommendationReportScoreV2'),
  'daily report should expose a Score V2 payload helper, not only a scalar score helper',
)
assert(
  dailyReport.includes('const snapshot = readScoreV2Snapshot(row)'),
  'daily report Score V2 helper should read a nullable shared taxonomy snapshot',
)
assert(
  dailyReport.includes('snapshot ? serializeScoreV2Snapshot(snapshot) : null'),
  'daily report Score V2 helper should not serialize missing canonical payloads',
)
assert(
  dailyReport.includes('score_v2: scoreV2'),
  'daily report persisted recommendation payload should include score_v2',
)
assert(
  dailyReport.includes('score: scoreV2?.finalScore ?? null'),
  'daily report persisted scalar score should be derived from Score V2 finalScore',
)
const dailyReportRecommendationQueryStart = dailyReport.indexOf('const { results: recs } = await env.DB.prepare')
const dailyReportRecommendationQueryEnd = dailyReport.indexOf(').bind(reportDate)', dailyReportRecommendationQueryStart)
assert(
  dailyReportRecommendationQueryStart >= 0 && dailyReportRecommendationQueryEnd > dailyReportRecommendationQueryStart,
  'daily report recommendation query should be locatable',
)
const dailyReportRecommendationQuery = dailyReport.slice(
  dailyReportRecommendationQueryStart,
  dailyReportRecommendationQueryEnd,
)
const dailyReportRecommendationSelectList = dailyReportRecommendationQuery.slice(
  0,
  dailyReportRecommendationQuery.indexOf('FROM daily_recommendations'),
)
assert(
  dailyReportRecommendationSelectList.includes('score_components'),
  'daily report recommendation query should read canonical Score V2 payload',
)
assert(
  dailyReportRecommendationQuery.includes("json_extract(score_components, '$.finalScore')"),
  'daily report recommendation query should sort by canonical Score V2 finalScore',
)
assert(
  !dailyReportRecommendationQuery.includes('ORDER BY score DESC'),
  'daily report recommendation query must not sort by legacy scalar score',
)
for (const legacyField of ['score,', 'ml_score', 'chip_score', 'tech_score', 'momentum_score']) {
  assert(
    !dailyReportRecommendationSelectList.includes(legacyField),
    `daily report recommendation query must not select legacy ${legacyField}`,
  )
}
const persistedRecommendationStart = dailyReport.indexOf('JSON.stringify((recs ?? []).map((row: any) => {')
const persistedRecommendationEnd = dailyReport.indexOf('snapshot ? JSON.stringify', persistedRecommendationStart)
assert(persistedRecommendationStart >= 0 && persistedRecommendationEnd > persistedRecommendationStart, 'daily report persisted recommendation block should be locatable')
const persistedRecommendationBlock = dailyReport.slice(persistedRecommendationStart, persistedRecommendationEnd)
assert(
  !persistedRecommendationBlock.includes('score_components:'),
  'daily report persisted recommendation payload should not expose raw score_components as downstream contract',
)
