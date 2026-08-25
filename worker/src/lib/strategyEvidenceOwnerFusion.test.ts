import assert from 'node:assert/strict'
import { buildStrategyEvidenceOwnerSnapshot, strategyEvidenceOwnerLineageMatches } from './strategyEvidenceOwnerFusion'
import { DEFAULT_STRATEGY_SPECS } from './strategySpec'

async function main(): Promise<void> {
const active = DEFAULT_STRATEGY_SPECS.find((strategy) => strategy.status === 'active')!
const requiredMetrics = [
  'residual_return_lcb90',
  'rank_ic',
  'max_drawdown',
  'turnover_after_cost',
  'regime_consistency',
]
const profileRows = requiredMetrics.map((metric_name) => ({
  strategy_id: active.id,
  strategy_version: active.version,
  primary_horizon_days: 10,
  metric_name,
  metric_value: 0.1,
  metric_status: metric_name === 'regime_consistency' ? 'insufficient_samples' : 'ready',
  sample_count: 100,
  mature_dates: 8,
  outcome_as_of_date: '2026-08-16',
  definition_version: 'strategy-evidence-metrics-v3',
}))

const snapshot = await buildStrategyEvidenceOwnerSnapshot({
  strategies: [active],
  rows: profileRows,
  knowledgeCutoffDate: '2026-08-17',
})
assert.equal(snapshot.integration_ready, true)
assert.equal(snapshot.active_materialized_profile_count, 1)
assert.equal(strategyEvidenceOwnerLineageMatches(snapshot, `adaptive|${snapshot.version}:${snapshot.checksum}`), true)
assert.equal(strategyEvidenceOwnerLineageMatches(snapshot, `adaptive|${snapshot.version}:wrong`), false)
assert.equal(strategyEvidenceOwnerLineageMatches(snapshot, null), false)

assert.equal(snapshot.active_ready_profile_count, 0)
assert.equal(snapshot.profiles[0]?.integration_status, 'materialized_learning')
assert.equal(snapshot.weight_effect, 'neutral_until_immutable_calibration')
assert.equal(snapshot.profiles[0]?.weight_multiplier, 1, 'not-fully-ready evidence must remain neutral')
assert.equal(snapshot.profiles[0]?.multi_horizon_score, null)
assert.equal(snapshot.checksum.length, 64)

const fullyReady = await buildStrategyEvidenceOwnerSnapshot({
  strategies: [active],
  rows: profileRows.map((row) => ({ ...row, metric_status: 'ready' })),
  knowledgeCutoffDate: '2026-08-17',
})
assert.equal(fullyReady.active_ready_profile_count, 1)
assert.equal(fullyReady.profiles[0]?.weight_effect, 'neutral_unvalidated_calibration')
assert.equal(fullyReady.profiles[0]?.weight_multiplier, 1, 'ready raw evidence cannot change weights without immutable calibration')
assert.equal(fullyReady.profiles[0]?.multi_horizon_score, null)
const materializedButUnavailable = await buildStrategyEvidenceOwnerSnapshot({
  strategies: [active],
  rows: profileRows.map((row, index) => index === 0
    ? { ...row, metric_value: null, metric_status: 'not_available' }
    : row),
  knowledgeCutoffDate: '2026-08-17',
})
assert.equal(materializedButUnavailable.integration_ready, true)
assert.equal(materializedButUnavailable.active_materialized_profile_count, 1)
assert.equal(materializedButUnavailable.active_ready_profile_count, 0)
assert.equal(materializedButUnavailable.profiles[0]?.integration_status, 'materialized_learning')
assert.equal(materializedButUnavailable.profiles[0]?.weight_multiplier, 1, 'unavailable estimator stays neutral without becoming missing evidence')


const futureOnly = await buildStrategyEvidenceOwnerSnapshot({
  strategies: [active],
  rows: profileRows.map((row) => ({ ...row, outcome_as_of_date: '2026-08-17' })),
  knowledgeCutoffDate: '2026-08-17',
})
assert.equal(futureOnly.integration_ready, false, 'same-day evidence must not leak into the production policy cutoff')
assert.equal(futureOnly.outcome_as_of_date, null)

const missing = await buildStrategyEvidenceOwnerSnapshot({
  strategies: [active],
  rows: profileRows.slice(0, 4),
  knowledgeCutoffDate: '2026-08-17',
})
assert.equal(missing.integration_ready, false)
assert.equal(missing.profiles[0]?.integration_status, 'missing')

console.log('strategy evidence owner fusion tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
