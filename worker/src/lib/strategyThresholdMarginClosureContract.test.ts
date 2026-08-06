import assert from 'node:assert/strict'
import fs from 'node:fs'

const learning = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
const eligibility = fs.readFileSync('src/lib/strategyRouteBackfillEligibility.ts', 'utf8')
const closure = fs.readFileSync('src/lib/eveningChainEvidenceClosure.ts', 'utf8')
const router = fs.readFileSync('src/lib/multiStrategyPleRouter.ts', 'utf8')

assert.match(learning, /strategy-decision-log-pit-reconstruction-v6/)
assert.match(router, /export function assessStrategyThresholdMarginAffinity/)
assert.match(learning, /assessStrategyThresholdMarginAffinity\(candidate, spec, \{ regime, strategyWeights \}\)/)
assert.match(learning, /challenger_affinity: thresholdAffinity\.challengerAffinity/)
assert.match(learning, /challenger_affinity_version: STRATEGY_AFFINITY_CHALLENGER_VERSION/)
assert.match(learning, /challenger_affinity_projection_incomplete/)
assert.match(eligibility, /m\.evaluable=1 AND m\.strategy_hit=1 AND m\.affinity_evidence_count>0/)
assert.match(eligibility, /thresholdMarginRows !== matchedMatrixRows/)
assert.match(closure, /evening_chain_threshold_margin_evidence_incomplete/)
assert.match(closure, /evening_chain_challenger_affinity_projection_incomplete/)
assert.match(learning, /threshold_margin_evidence_incomplete/)
