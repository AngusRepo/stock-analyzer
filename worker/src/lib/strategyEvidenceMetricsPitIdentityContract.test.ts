import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('src/lib/strategyEvidenceMetrics.ts', 'utf8')
const migration = fs.readFileSync('domain-migrations/learning/0018_strategy_evidence_metrics_pit_identity.sql', 'utf8')
const fusion = fs.readFileSync('src/lib/strategyEvidenceOwnerFusion.ts', 'utf8')

assert.match(
  source,
  /ON CONFLICT\(strategy_id, strategy_version, primary_horizon_days, metric_name, outcome_as_of_date\)/,
  'daily evidence snapshots must not overwrite another outcome cutoff',
)
assert.match(
  migration,
  /PRIMARY KEY\(strategy_id, strategy_version, primary_horizon_days, metric_name, outcome_as_of_date\)/,
  'Learning D1 evidence identity must preserve immutable point-in-time snapshots',
)
assert.match(migration, /INSERT INTO strategy_evidence_metrics_v1[\s\S]*FROM strategy_evidence_metrics_v1_legacy_identity/)
assert.match(
  fusion,
  /WHERE outcome_as_of_date < \?/,
  'production policy must keep strict prior-date cutoff and reject look-ahead evidence',
)

console.log('strategy evidence PIT identity contract tests passed')
