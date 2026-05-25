import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync('src/lib/strategyLearning.ts', 'utf8')
const adminReadRoutes = readFileSync('src/routes/adminReadRoutes.ts', 'utf8')
const strategySpec = readFileSync('src/lib/strategySpec.ts', 'utf8')
const contextStart = source.indexOf('const context = {')
const contextEnd = source.indexOf('rows.push({', contextStart)
assert(contextStart >= 0 && contextEnd > contextStart, 'strategy decision context block should be locatable')
const contextBlock = source.slice(contextStart, contextEnd)
const candidateQueryStart = source.indexOf('export async function listStrategyLearningCandidates')
const candidateQueryEnd = source.indexOf('export async function persistStrategyDecisionRows', candidateQueryStart)
assert(candidateQueryStart >= 0 && candidateQueryEnd > candidateQueryStart, 'strategy learning candidate query block should be locatable')
const candidateQueryBlock = source.slice(candidateQueryStart, candidateQueryEnd)
const adminDryRunStart = adminReadRoutes.indexOf("adminReadRoutes.post('/api/admin/strategy/dry-run'")
const adminDryRunEnd = adminReadRoutes.indexOf("adminReadRoutes.get('/api/admin/research/experiments'", adminDryRunStart)
assert(adminDryRunStart >= 0 && adminDryRunEnd > adminDryRunStart, 'admin strategy dry-run block should be locatable')
const adminDryRunBlock = adminReadRoutes.slice(adminDryRunStart, adminDryRunEnd)

assert(contextBlock.includes('score_v2'), 'strategy decision context should persist a Score V2 object')
assert(contextBlock.includes('finalScore: thresholdScores.seedScore'), 'strategy decision context should name finalScore explicitly')
assert(contextBlock.includes('chipFlow: thresholdScores.chipFlow'), 'strategy decision context should name chipFlow explicitly')
assert(
  contextBlock.includes('technicalStructure: thresholdScores.technicalStructure'),
  'strategy decision context should name technicalStructure explicitly',
)
assert(contextBlock.includes('momentumProxy: thresholdScores.momentumProxy'), 'strategy decision context should name momentumProxy explicitly')
assert(contextBlock.includes('source: thresholdScores.source'), 'strategy decision context should preserve Score V2 source')
assert(!contextBlock.includes('chip_score'), 'strategy decision context must not write legacy chip_score')
assert(!contextBlock.includes('tech_score'), 'strategy decision context must not write legacy tech_score')
assert(!contextBlock.includes('momentum_score'), 'strategy decision context must not write legacy momentum_score')

for (const block of [candidateQueryBlock, adminDryRunBlock]) {
  assert(block.includes('score_components'), 'strategy candidate query should select canonical Score V2 payload')
  assert(
    block.includes("json_extract(score_components, '$.finalScore')"),
    'strategy candidate query should rank ties by canonical Score V2 finalScore',
  )
  assert(
    !block.includes('ORDER BY rank ASC, score DESC'),
    'strategy candidate query must not use legacy scalar score as rank tie-break',
  )
  assert(!block.includes('score, score_components'), 'strategy candidate query must not select scalar score as downstream input')
  assert(!block.includes('industry, score,'), 'strategy candidate query must not expose scalar score in select list')
  for (const legacyField of ['chip_score', 'tech_score', 'ml_score', 'momentum_score']) {
    assert(!block.includes(legacyField), `strategy candidate query must not select legacy ${legacyField}`)
  }
}
assert(
  candidateQueryBlock.includes('score_v2: row.score_v2 ?? score_components'),
  'strategy learning loader should adapt storage score_components into runtime score_v2',
)
assert(
  adminDryRunBlock.includes('score_v2: candidate.score_v2 ?? scoreComponents'),
  'admin dry-run should adapt storage score_components into runtime score_v2',
)

const interfaceStart = strategySpec.indexOf('export interface StrategyCandidateInput')
const interfaceEnd = strategySpec.indexOf('export interface StrategySpecThresholds', interfaceStart)
assert(interfaceStart >= 0 && interfaceEnd > interfaceStart, 'StrategyCandidateInput interface should be locatable')
const interfaceBlock = strategySpec.slice(interfaceStart, interfaceEnd)
assert(!interfaceBlock.includes('score?:'), 'StrategyCandidateInput must not expose scalar score')
assert(interfaceBlock.includes('score_v2?: unknown'), 'StrategyCandidateInput should expose runtime score_v2')
assert(!interfaceBlock.includes('score_components'), 'StrategyCandidateInput must not expose storage score_components')
for (const legacyField of ['chip_score', 'tech_score', 'ml_score', 'momentum_score']) {
  assert(!interfaceBlock.includes(legacyField), `StrategyCandidateInput must not expose legacy ${legacyField}`)
}

const forbiddenSpecStart = strategySpec.indexOf('const FORBIDDEN_SPEC_KEYS')
const forbiddenSpecEnd = strategySpec.indexOf('function finiteNumber', forbiddenSpecStart)
assert(forbiddenSpecStart >= 0 && forbiddenSpecEnd > forbiddenSpecStart, 'strategy forbidden key block should be locatable')
const forbiddenSpecBlock = strategySpec.slice(forbiddenSpecStart, forbiddenSpecEnd)
for (const legacyKey of ["'score'", "'chip_score'", "'tech_score'", "'momentum_score'", "'chipScore'", "'techScore'", "'momentumScore'"]) {
  assert(forbiddenSpecBlock.includes(legacyKey), `strategy specs must forbid legacy score key ${legacyKey}`)
}

assert(strategySpec.includes('record?.seedComponents'), 'strategy thresholds should read Score V2 seedComponents when momentum proxy is needed')
assert(strategySpec.includes("'screenerMomentumSeed20'"), 'strategy thresholds should read the explicit screenerMomentumSeed20 seed key')
assert(!strategySpec.includes('record?.legacyComponents'), 'strategy thresholds must not read legacyComponents from Score V2 payloads')
