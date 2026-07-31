import assert from 'node:assert/strict'
import fs from 'node:fs'

const learning = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
const eligibility = fs.readFileSync('src/lib/strategyRouteBackfillEligibility.ts', 'utf8')
const closure = fs.readFileSync('src/lib/eveningChainEvidenceClosure.ts', 'utf8')

assert.match(learning, /strategy-decision-log-pit-reconstruction-v6/)
assert.match(learning, /match_strength: match\?\.matchStrength \?\? 0/)
assert.match(learning, /threshold_margin: match\?\.thresholdMargin \?\? 0/)
assert.match(learning, /affinity_evidence_count: match\?\.evidenceCount \?\? 0/)
assert.match(eligibility, /m\.evaluable=1 AND m\.strategy_hit=1 AND m\.affinity_evidence_count>0/)
assert.match(eligibility, /thresholdMarginRows !== matchedMatrixRows/)
assert.match(closure, /evening_chain_threshold_margin_evidence_incomplete/)
assert.match(learning, /threshold_margin_evidence_incomplete/)
