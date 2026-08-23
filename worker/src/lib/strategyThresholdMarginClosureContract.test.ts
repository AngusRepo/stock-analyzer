import assert from 'node:assert/strict'
import fs from 'node:fs'

const learning = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
const eligibility = fs.readFileSync('src/lib/strategyRouteBackfillEligibility.ts', 'utf8')
const closure = fs.readFileSync('src/lib/eveningChainEvidenceClosure.ts', 'utf8')
const router = fs.readFileSync('src/lib/multiStrategyPleRouter.ts', 'utf8')
const spec = fs.readFileSync('src/lib/strategySpec.ts', 'utf8')

assert.match(spec, /STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION/)
assert.match(learning, /STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION/)
assert.match(learning, /immutableV1CarrierRetry/)
assert.match(learning, /artifactBackedV1Carrier/)
assert.match(learning, /artifactEvidence\?\.source_labeler_version === 'strategy-labeler-v1'/)
assert.doesNotMatch(learning, /labeler_version:\s*'strategy-decision-log-pit-reconstruction-v6'/)
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
assert.match(
  learning,
  /WITH decision_dates AS \([\s\S]*GROUP BY date[\s\S]*valid_runs AS \(/,
  'historical candidate discovery must validate each date once instead of once per decision row',
)
assert.match(
  learning,
  /m\.signal_date=mr\.signal_date[\s\S]*sr\.signal_date=mr\.signal_date/,
  'historical completeness checks must constrain matrix and reference scans by their leading date indexes',
)
assert.match(
  router,
  /export function resolveStrategyThresholdMarginAffinityPolicy/,
  'daily routing and historical projection must share one policy owner',
)
assert.match(
  learning,
  /decisionContractComplete[\s\S]*projectionSourceReady[\s\S]*resolveStrategyThresholdMarginAffinityPolicy/,
  'historical projection fast path must require complete v2 decisions and a complete raw matrix',
)
assert.match(
  learning,
  /COALESCE\(match_strength, 0\) \* \?[\s\S]*challenger_affinity_version=\?/,
  'fast path must project stored native match strength into the versioned challenger affinity column',
)
assert.match(
  learning,
  /const rebuilt = projectedExistingMatrix \? \[\] : decisions\.map/,
  'complete projection must skip per-cell JSON reconstruction',
)
assert.match(
  learning,
  /const contextResult = projectedExistingMatrix \? null : await db\.prepare/,
  'complete projection must skip loading large PIT contexts',
)
