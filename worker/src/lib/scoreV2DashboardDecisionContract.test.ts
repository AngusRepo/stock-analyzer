import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const route = readFileSync('src/routes/dashboardReadRoutes.ts', 'utf8')

assert(
  route.includes("readScoreV2Snapshot, serializeScoreV2Snapshot, type ScoreV2StorageRow"),
  'dashboard decisions route should normalize DB score_components through Score V2 taxonomy helpers',
)

const shapeStart = route.indexOf('function shapeDashboardDecision')
const shapeEnd = route.indexOf('function parseDashboardId', shapeStart)
assert(shapeStart >= 0 && shapeEnd > shapeStart, 'dashboard decision response shaper should be locatable')
const shapeBlock = route.slice(shapeStart, shapeEnd)

assert(shapeBlock.includes('const snapshot = readScoreV2Snapshot(row)'), 'dashboard decision response should read canonical Score V2 snapshot')
assert(shapeBlock.includes('snapshot ? serializeScoreV2Snapshot(snapshot) : null'), 'dashboard decision response should serialize nullable Score V2 snapshot')
assert(shapeBlock.includes('score: scoreV2?.finalScore ?? null'), 'dashboard decision scalar score should come from Score V2 finalScore')
assert(shapeBlock.includes('score_v2: scoreV2'), 'dashboard decision response should expose score_v2')
assert(!shapeBlock.includes('score_components:'), 'dashboard decision response should not expose raw score_components')

const routeStart = route.indexOf("dashboardReadRoutes.get('/api/observability/decisions'")
const routeEnd = route.indexOf("dashboardReadRoutes.get('/api/observability/model-health'", routeStart)
assert(routeStart >= 0 && routeEnd > routeStart, 'dashboard decisions route should be locatable')
const decisionRouteBlock = route.slice(routeStart, routeEnd)

assert(decisionRouteBlock.includes('SELECT date, symbol, action, score_components'), 'dashboard decisions query should select canonical score_components')
assert(decisionRouteBlock.includes("json_extract(score_components, '$.finalScore')"), 'dashboard decisions ordering should use Score V2 finalScore')
assert(!decisionRouteBlock.includes('SELECT * FROM decision_logs'), 'dashboard decisions route must not select wildcard decision log rows')
assert(!decisionRouteBlock.includes('ORDER BY total_score'), 'dashboard decisions route must not order by legacy scalar total_score')

for (const legacyField of ['chip_score', 'tech_score', 'ml_score', 'chip_pct', 'tech_pct', 'ml_pct', 'momentum_score']) {
  assert(!decisionRouteBlock.includes(legacyField), `dashboard decisions route should not read legacy field ${legacyField}`)
}
