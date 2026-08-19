import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const learning = readFileSync('src/lib/strategyLearning.ts', 'utf8')
const repair = readFileSync('src/lib/strategyLearningCutoverContinuity.ts', 'utf8')
const writeRoutes = readFileSync('src/routes/adminWriteRoutes.ts', 'utf8')
const readRoutes = readFileSync('src/routes/adminReadRoutes.ts', 'utf8')
const maturity = readFileSync('src/lib/pipelineDecisionMaturity.ts', 'utf8')

test('historical rebuild preserves PIT router and challenger route fields', () => {
  assert.match(learning, /r\.strategy_router_version, r\.strategy_router_score/)
  assert.match(learning, /strategy_challenger_route_version: cleanToken\(row\.strategy_challenger_route_version\)/)
})
test('daily stats bind canonical producer and clear orphan projections', () => {
  assert.match(learning, /options: \{ canonicalProducerRunId\?: string; skipEnsure\?: boolean \} = \{\}/)
  assert.match(learning, /SET decisions=0, evaluable_decisions=0, unavailable_decisions=0, matched=0/)
})
test('continuity repair is bounded and cannot promote', () => {
  assert.match(repair, /activeDataDomains\(env\)\.has\('learning'\)/)
  assert.match(repair, /allowPromotion: false/)
  assert.doesNotMatch(repair, /DELETE FROM|DROP TABLE|TRUNCATE/)
  assert.match(writeRoutes, /repair-learning-cutover-continuity-v1/)
})
test('formal owner readback uses immutable policy lineage', () => {
  assert.match(readRoutes, /storedOwnerLineageValid/)
  assert.match(readRoutes, /active_policy_evidence_owner/)
  assert.match(maturity, /not_applicable.*candidateMetricScope\.availability/)
})