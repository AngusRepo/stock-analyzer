import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const route = readFileSync('src/routes/stocks.ts', 'utf8')

assert(
  route.includes("readScoreV2Snapshot, serializeScoreV2Snapshot, type ScoreV2StorageRow"),
  'stock AI summary route should normalize recommendation score through Score V2 taxonomy helpers',
)

const shaperStart = route.indexOf('function shapeStockAiRecommendation')
const shaperEnd = route.indexOf("//", shaperStart)
assert(shaperStart >= 0 && shaperEnd > shaperStart, 'stock AI recommendation shaper should be locatable')
const shaperBlock = route.slice(shaperStart, shaperEnd)

assert(shaperBlock.includes('const snapshot = readScoreV2Snapshot(row)'), 'stock AI summary should read canonical Score V2 snapshot')
assert(shaperBlock.includes('snapshot ? serializeScoreV2Snapshot(snapshot) : null'), 'stock AI summary should serialize nullable Score V2 snapshot')
assert(shaperBlock.includes('score: scoreV2?.finalScore ?? null'), 'stock AI summary scalar score should come from Score V2 finalScore')
assert(shaperBlock.includes('score_v2: scoreV2'), 'stock AI summary should expose canonical score_v2')
assert(!shaperBlock.includes('score_components:'), 'stock AI summary response should not expose raw score_components')

const routeStart = route.indexOf("stocks.get('/:id/ai-summary'")
const routeEnd = route.indexOf('export { stocks }', routeStart)
assert(routeStart >= 0 && routeEnd > routeStart, 'stock AI summary route should be locatable')
const aiSummaryBlock = route.slice(routeStart, routeEnd)

assert(aiSummaryBlock.includes('SELECT date, symbol, name, sector, rank, signal, confidence, reason'), 'stock AI summary query should explicitly select recommendation fields')
assert(aiSummaryBlock.includes('ml_vote_summary, score_components'), 'stock AI summary query should load canonical score_components')
assert(!aiSummaryBlock.includes('SELECT * FROM daily_recommendations'), 'stock AI summary route must not wildcard daily_recommendations')
assert(!aiSummaryBlock.includes('...recRow'), 'stock AI summary route must not spread raw recommendation storage rows')

for (const legacyField of ['chip_score', 'tech_score', 'ml_score', 'momentum_score']) {
  assert(!aiSummaryBlock.includes(legacyField), `stock AI summary route should not read legacy field ${legacyField}`)
}
