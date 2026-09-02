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
const learning = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')

const rewardConsumer = learning.slice(
  learning.indexOf('export async function listStrategyRewardSourceRows'),
  learning.indexOf('export async function persistStrategyRewardLedgerRows'),
)
assert.match(rewardConsumer, /STRATEGY_FORMAL_LABELER_VERSIONS\.map\(\(\) => '\?'\)\.join\(','\)/)
assert.match(rewardConsumer, /\.\.\.STRATEGY_FORMAL_LABELER_VERSIONS/)
assert.doesNotMatch(rewardConsumer, /\bSTRATEGY_FORMAL_LABELER_VERSION\b/)
assert.doesNotMatch(rewardConsumer, /\bSTRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION\b/)

const strategySpec = fs.readFileSync('src/lib/strategySpec.ts', 'utf8')
assert.match(strategySpec, /STRATEGY_FORMAL_LABELER_VERSION = 'strategy-labeler-v3-regime-veto-counterfactual-v1'/)
assert.match(strategySpec, /STRATEGY_FORMAL_LABELER_LEGACY_VERSION = 'strategy-labeler-v2-revenue-pit-fuse-v1'/)
assert.match(strategySpec, /STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION =[\s\S]*'strategy-decision-log-pit-reconstruction-v7-revenue-pit-fuse-v1'/)
assert.match(strategySpec, /STRATEGY_FORMAL_LABELER_VERSIONS = \[[\s\S]*STRATEGY_FORMAL_LABELER_VERSION,[\s\S]*STRATEGY_FORMAL_LABELER_LEGACY_VERSION,[\s\S]*STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION/)

for (const [name, source] of Object.entries(sources)) {
  if (name === 'eligibility' || name === 'adminRoute') {
    assert.match(source, /buildStrategyFormalMatureCompatibilitySql/, `${name} must consume paired mature compatibility`)
  } else if (name === 'marginal' || name === 'maturity') {
    assert.match(source, /STRATEGY_FORMAL_LABELER_VERSIONS/, 'Atomic V7 must consume the complete formal labeler allowlist')
  } else {
    assert.match(source, /STRATEGY_FORMAL_LABELER_VERSION/, `${name} must accept the native formal labeler`)
  }
  if (!['publicRoute', 'marginal', 'maturity', 'eligibility', 'adminRoute'].includes(name)) {
    assert.match(source, /STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION/, `${name} must accept the reconstruction formal labeler`)
  }
  assert.doesNotMatch(source, /strategy-labeler-v1/, `${name} must reject the legacy native labeler`)
  assert.doesNotMatch(source, /strategy-decision-log-pit-reconstruction-v6/, `${name} must reject the legacy reconstruction labeler`)
}

const pipelineTrackingMatrixQueries = sources.publicRoute.match(
  /const \{ results: rawMatrixRows \}[\s\S]*?const loadStageStrategyRows/,
)?.[0]
assert.ok(pipelineTrackingMatrixQueries, 'public pipeline tracking route must load canonical matrix evidence')
assert.equal(
  pipelineTrackingMatrixQueries.match(/STRATEGY_FORMAL_LABELER_VERSIONS\.map\(\(\) => '\?'\)\.join\(','\)/g)?.length,
  3,
  'raw matrix, reference count, and matrix run SQL must all use the complete formal labeler allowlist',
)
assert.equal(
  pipelineTrackingMatrixQueries.match(/\.\.\.STRATEGY_FORMAL_LABELER_VERSIONS/g)?.length,
  3,
  'raw matrix, reference count, and matrix run binds must all use the complete formal labeler allowlist',
)
assert.doesNotMatch(
  pipelineTrackingMatrixQueries,
  /IN \(\?, \?\)/,
  'pipeline tracking must not regress to a direct two-labeler allowlist',
)
assert.doesNotMatch(pipelineTrackingMatrixQueries, /\bSTRATEGY_FORMAL_LABELER_VERSION\b/)
assert.doesNotMatch(pipelineTrackingMatrixQueries, /\bSTRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION\b/)

for (const [name, source, anchor] of [
  ['route eligibility', sources.eligibility, 'const canonicalRunIdsJson'],
  ['redundancy backfill', sources.adminRoute, "adminWriteRoutes.post('/api/admin/strategy/redundancy/backfill'"],
] as const) {
  const consumer = source.slice(source.indexOf(anchor))
  assert(
    consumer.includes("buildStrategyFormalMatureCompatibilitySql('mr')"),
    `${name} must derive the exact reference-contract × labeler compatibility pairs`,
  )
  assert(
    consumer.includes('...formalMatureCompatibility.binds'),
    `${name} must bind the paired mature compatibility values`,
  )
  assert(
    consumer.includes('${formalMatureCompatibility.sql}'),
    `${name} SQL must consume paired mature compatibility`,
  )
  assert.doesNotMatch(
    consumer,
    /reference_contract_version=\?/,
    `${name} must not collapse mature evidence back to only the current reference contract`,
  )
}
assert.equal(
  sources.eligibility.match(/m\.reference_contract_version=mr\.reference_contract_version/g)?.length,
  4,
  'route eligibility must bind every matrix count to the same immutable reference contract as its run',
)

const maturityConsumer = sources.maturity.slice(sources.maturity.indexOf('export async function buildPipelineDecisionMaturityPacket'))
assert(
  maturityConsumer.includes("STRATEGY_FORMAL_LABELER_VERSIONS.map(() => '?').join(',')"),
  'L1 maturity must derive SQL placeholders from the complete formal labeler allowlist',
)
assert.equal(
  maturityConsumer.split('formalLabelerPlaceholders').length - 1,
  6,
  'L1 primary reference, primary matrix, fallback matrix, and both history queries must use the same full allowlist',
)
assert.equal(
  maturityConsumer.split('...STRATEGY_FORMAL_LABELER_VERSIONS').length - 1,
  5,
  'L1 maturity binds must spread the complete allowlist for every canonical query',
)
assert(
  maturityConsumer.includes('STRATEGY_FORMAL_LABELER_VERSIONS.includes(String(matrixRow.labeler_version)'),
  'L1 readiness must accept every officially supported formal labeler',
)
assert(!maturityConsumer.includes('IN (?, ?)'), 'L1 maturity must not regress to a two-labeler SQL allowlist')

const atomicV7MatrixLoader = sources.marginal.match(
  /const formalLabelerPlaceholders[\s\S]*?const edges = evaluateStrategyMarginalEdgesV4\(cells\)/,
)?.[0]
assert.ok(atomicV7MatrixLoader, 'Atomic V7 must load canonical strategy matrix evidence')
assert.match(
  atomicV7MatrixLoader,
  /STRATEGY_FORMAL_LABELER_VERSIONS\.map\(\(\) => '\?'\)\.join\(','\)/,
  'Atomic V7 matrix SQL must derive placeholders from the complete formal labeler allowlist',
)
assert.match(
  atomicV7MatrixLoader,
  /mr\.labeler_version IN \(\$\{formalLabelerPlaceholders\}\)/,
  'Atomic V7 matrix SQL must use the dynamic full-allowlist placeholders',
)
assert.match(
  atomicV7MatrixLoader,
  /\.\.\.STRATEGY_FORMAL_LABELER_VERSIONS/,
  'Atomic V7 matrix binds must spread the complete formal labeler allowlist',
)
assert.doesNotMatch(
  atomicV7MatrixLoader,
  /IN \(\?, \?\)/,
  'Atomic V7 must not regress to a direct two-labeler allowlist',
)
assert.doesNotMatch(sources.marginal, /\bSTRATEGY_FORMAL_LABELER_VERSION\b/)
assert.doesNotMatch(sources.marginal, /\bSTRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION\b/)

assert.match(sources.marginal, /m\.labeler_version=mr\.labeler_version/)
assert.match(sources.eligibility, /m\.labeler_version=mr\.labeler_version/)
assert.match(sources.eligibility, /mr\.labeler_version=r\.strategy_labeler_version/)
assert.match(sources.recovery, /mc\.labeler_version=mr\.labeler_version/)
assert.match(sources.recovery, /mr\.labeler_version=r\.strategy_labeler_version/)
assert.match(sources.closure, /mr\.labeler_version=r\.strategy_labeler_version/)
assert.match(sources.closure, /m\.labeler_version=r\.labeler_version/)
assert.match(sources.recovery, /WITH target_heads\(signal_date, producer_run_id\) AS/)
assert.match(sources.recovery, /LEFT JOIN matrix_counts mc/)
assert.doesNotMatch(sources.recovery, /SUM\(CASE WHEN EXISTS \(/)
assert.match(sources.maturity, /mr\.labeler_version=r\.strategy_labeler_version/)
assert.match(sources.maturity, /m\.labeler_version=r\.labeler_version/)
assert.match(sources.maturity, /matrix\.labeler_version=run\.labeler_version/)
assert.match(sources.publicRoute, /mr\.labeler_version=strategy_label_matrix_v4\.labeler_version/)
assert.match(sources.publicRoute, /mr\.labeler_version=selection_reference_snapshots_v1\.strategy_labeler_version/)
assert.match(sources.adminRoute, /m\.labeler_version IS NOT mr\.labeler_version/)
assert.match(sources.adminRoute, /r\.strategy_labeler_version IS NOT mr\.labeler_version/)
