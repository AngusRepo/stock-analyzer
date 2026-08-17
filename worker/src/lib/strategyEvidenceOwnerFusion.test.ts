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
assert.equal(snapshot.weight_effect, 'mature_ready_only')
assert.equal(snapshot.checksum.length, 64)

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
