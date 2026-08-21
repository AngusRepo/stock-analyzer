import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const ROOT = process.cwd()
const screener = fs.readFileSync(path.join(ROOT, 'src/lib/marketScreener.ts'), 'utf8')
const routes = fs.readFileSync(path.join(ROOT, 'src/routes/adminWriteRoutes.ts'), 'utf8')
const schema = fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8')
const learningSchema = fs.readFileSync(path.join(ROOT, 'domain-schemas/learning.sql'), 'utf8')
const statusMigration = fs.readFileSync(path.join(ROOT, 'migrations/0095_strategy_redundancy_pending_maturity.sql'), 'utf8')

test('strategy redundancy backfill reuses canonical PIT matrix and mature OOF labels', () => {
  assert.match(screener, /prepareStrategyRedundancyBackfill/)
  assert.match(screener, /strategy_label_matrix_runs_v4/)
  assert.match(screener, /strategy_label_matrix_v4/)
  assert.match(screener, /canonical_run_heads/)
  assert.match(screener, /strategy_redundancy_matrix_count_mismatch/)
  assert.match(screener, /strategy_redundancy_registry_checksum_mismatch/)
  assert.match(screener, /strategy_redundancy_matrix_labeler_contract_invalid/)
  assert.match(screener, /strategy_redundancy_reference_contract_invalid/)
  assert.match(screener, /strategy_redundancy_matrix_row_labeler_contract_invalid/)
  assert.match(screener, /strategy_redundancy_matrix_row_reference_contract_invalid/)
  assert.match(screener, /STRATEGY_FORMAL_LABELER_VERSIONS/)
  assert.doesNotMatch(screener, /strategy-decision-log-pit-reconstruction-v6/)
  assert.match(screener, /SELECTION_REFERENCE_CONTRACT_VERSION/)
  assert.match(screener, /loadCanonicalScreenerRunIds\(env, asOfDate\)/)
  assert.match(screener, /SELECT 1 FROM json_each\(\?\) h/)
  assert.match(screener, /mature_oof_residual_returns_with_same_day_overlap_diagnostic/)
  assert.match(screener, /status: pendingMaturity \? 'pending_maturity' : 'unavailable_blocked'/)
  assert.match(screener, /\['modal_python', 'pending_maturity'\]\.includes\(result\.status\)/)
  assert.match(screener, /result\.status === 'modal_python' \? 'ready' : 'pending_maturity'/)
  assert.doesNotMatch(screener.slice(
    screener.indexOf('export async function prepareStrategyRedundancyBackfill'),
    screener.indexOf('function chunkArray'),
  ), /stock_prices|CURRENT_TIMESTAMP|twToday/)
})

test('admin redundancy backfill is bounded and cannot mutate strategy policy', () => {
  const start = routes.indexOf("/api/admin/strategy/redundancy/backfill")
  const end = routes.indexOf("/api/admin/strategy/marginal-edge-v4/refresh", start)
  const route = routes.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.match(route, /X-Confirm-Strategy-Learning/)
  assert.match(route, /spanDays > 31/)
  assert.match(route, /prepareStrategyRedundancyBackfill/)
  assert.match(route, /rebuildStrategyRedundancyArtifactForDate/)
  assert.match(route, /status: 'eligible'/)
  assert.match(route, /status: result\.status/)
  assert.doesNotMatch(route, /refreshStrategyAdaptivePolicyState|promotion|strategy_weights/)
})

test('redundancy artifact schemas accept the explicit pending maturity state', () => {
  const statusContract = /status TEXT NOT NULL CHECK\(status IN \('pending', 'pending_maturity', 'pass', 'fail'\)\)/
  assert.match(schema, statusContract)
  assert.match(learningSchema, statusContract)
  assert.match(statusMigration, statusContract)
  assert.match(statusMigration, /INSERT INTO strategy_redundancy_artifacts_v1/)
  assert.match(statusMigration, /DROP TABLE strategy_redundancy_artifacts_v1_legacy_0095/)
  assert.doesNotMatch(statusMigration, /BEGIN TRANSACTION|COMMIT;/)
})
