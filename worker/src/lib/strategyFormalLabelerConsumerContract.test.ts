import assert from 'node:assert/strict'
import fs from 'node:fs'

const sources = {
  marginal: fs.readFileSync('src/lib/strategyMarginalEdgeV4.ts', 'utf8'),
  eligibility: fs.readFileSync('src/lib/strategyRouteBackfillEligibility.ts', 'utf8'),
  recovery: fs.readFileSync('src/lib/matureSelectionEvidenceRecovery.ts', 'utf8'),
  closure: fs.readFileSync('src/lib/eveningChainEvidenceClosure.ts', 'utf8'),
  maturity: fs.readFileSync('src/lib/pipelineDecisionMaturity.ts', 'utf8'),
  publicRoute: fs.readFileSync('src/routes/other.ts', 'utf8'),
  adminRoute: fs.readFileSync('src/routes/adminWriteRoutes.ts', 'utf8'),
}

const strategySpec = fs.readFileSync('src/lib/strategySpec.ts', 'utf8')
assert.match(strategySpec, /STRATEGY_FORMAL_LABELER_VERSION = 'strategy-labeler-v2-revenue-pit-fuse-v1'/)
assert.match(strategySpec, /STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION =[\s\S]*'strategy-decision-log-pit-reconstruction-v7-revenue-pit-fuse-v1'/)
assert.match(strategySpec, /STRATEGY_FORMAL_LABELER_VERSIONS = \[[\s\S]*STRATEGY_FORMAL_LABELER_VERSION,[\s\S]*STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION/)

for (const [name, source] of Object.entries(sources)) {
  assert.match(source, /STRATEGY_FORMAL_LABELER_VERSION/, `${name} must accept the native formal labeler`)
  assert.match(source, /STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION/, `${name} must accept the reconstruction formal labeler`)
  assert.doesNotMatch(source, /strategy-labeler-v1/, `${name} must reject the legacy native labeler`)
  assert.doesNotMatch(source, /strategy-decision-log-pit-reconstruction-v6/, `${name} must reject the legacy reconstruction labeler`)
}

assert.match(sources.marginal, /m\.labeler_version=mr\.labeler_version/)
assert.match(sources.eligibility, /m\.labeler_version=mr\.labeler_version/)
assert.match(sources.eligibility, /mr\.labeler_version=r\.strategy_labeler_version/)
assert.match(sources.recovery, /m\.labeler_version=mr\.labeler_version/)
assert.match(sources.recovery, /mr\.labeler_version=r\.strategy_labeler_version/)
assert.match(sources.closure, /mr\.labeler_version=r\.strategy_labeler_version/)
assert.match(sources.closure, /m\.labeler_version=r\.labeler_version/)
assert.match(sources.maturity, /mr\.labeler_version=selection_reference_snapshots_v1\.strategy_labeler_version/)
assert.match(sources.maturity, /m\.labeler_version=r\.labeler_version/)
assert.match(sources.maturity, /matrix\.labeler_version=run\.labeler_version/)
assert.match(sources.publicRoute, /mr\.labeler_version=strategy_label_matrix_v4\.labeler_version/)
assert.match(sources.publicRoute, /mr\.labeler_version=selection_reference_snapshots_v1\.strategy_labeler_version/)
assert.match(sources.adminRoute, /m\.labeler_version IS NOT mr\.labeler_version/)
assert.match(sources.adminRoute, /r\.strategy_labeler_version IS NOT mr\.labeler_version/)
