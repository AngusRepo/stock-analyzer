import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

const calibration = readFileSync('src/lib/strategyRouteCalibration.ts', 'utf8')
const continuity = readFileSync('src/lib/strategyLearningCutoverContinuity.ts', 'utf8')
const maturity = readFileSync('src/lib/pipelineDecisionMaturity.ts', 'utf8')
const schema = readFileSync('domain-schemas/learning.sql', 'utf8')
const migration = readFileSync('domain-migrations/learning/0023_strategy_route_paired_incumbent_evidence.sql', 'utf8')

test('route promotion requires paired incumbent evidence and same-capacity improvement', () => {
  assert.match(calibration, /incumbent_route_lineage_complete/)
  assert.match(calibration, /absolute_spread_lcb90_positive/)
  assert.match(calibration, /challenger_beats_incumbent_same_capacity_lcb90_positive/)
  assert.match(calibration, /\.slice\(0, challengerPaired\.length\)/)
  assert.match(calibration, /current_day_incumbent_route_complete/)
})

test('continuity repair is exact-key null-only and conflicts fail closed', () => {
  assert.match(continuity, /strategy_router_version=COALESCE\(strategy_router_version, \?\)/)
  assert.match(continuity, /strategy_router_score=COALESCE\(strategy_router_score, \?\)/)
  assert.match(continuity, /strategy_learning_cutover_continuity_route_conflict/)
  assert.match(continuity, /assertLegacyTargetParity\(legacyRouteRows, targetRowsAfter, true\)/)
  assert.doesNotMatch(continuity, /DELETE FROM|DROP TABLE|TRUNCATE/)
})

test('paired metrics are durable and observable', () => {
  for (const source of [schema, migration, calibration, maturity]) {
    assert.match(source, /challenger_incumbent_delta_lcb90/)
    assert.match(source, /paired_date_count/)
  }
})

test('paired migration applies to an existing calibration table', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE strategy_route_calibration_runs_v1 (
      run_id TEXT PRIMARY KEY,
      gate_json TEXT NOT NULL
    );
  `)
  db.exec(migration)
  const columns = db.prepare('PRAGMA table_info(strategy_route_calibration_runs_v1)').all()
    .map((row) => String(row.name))
  assert(columns.includes('absolute_spread_lcb90'))
  assert(columns.includes('incumbent_sample_count'))
  assert(columns.includes('paired_date_count'))
  assert(columns.includes('challenger_incumbent_delta_lcb90'))
  db.close()
})
