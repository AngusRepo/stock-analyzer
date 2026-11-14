import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { buildMatureStrategyOofReturnsSql } from './marketScreener'
import { buildStrategyFormalMatureCompatibilitySql } from './selectionReferenceEvidence'

// M2 index slimming (learning 0066): strategy_label_matrix_v4 keeps 5 indexes.
// strategy_decision_log stays at 8 until runtimes that no longer re-create
// _symbol/_status are live everywhere (follow-up 0067). A full EXPLAIN QUERY PLAN sweep of every
// statement on both tables (audits/matrix-split-plan-20261112) found the dropped
// ones unused, or used only as a tie for a signal_date=? lookup that another
// index serves with the same columns. These plans lock the kept access paths.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const MATRIX_INDEXES = [
  'idx_strategy_label_matrix_challenger_v2',
  'idx_strategy_label_matrix_v4_evaluable',
  'idx_strategy_label_matrix_v4_profile_evidence',
  'idx_strategy_label_matrix_v4_symbol',
  'sqlite_autoindex_strategy_label_matrix_v4_1',
]
const DECISION_INDEXES = [
  'idx_strategy_decision_evaluability_status',
  'idx_strategy_decision_log_context',
  'idx_strategy_decision_log_date',
  'idx_strategy_decision_log_evaluability',
  'idx_strategy_decision_log_status',
  'idx_strategy_decision_log_symbol',
  'sqlite_autoindex_strategy_decision_log_1',
  'sqlite_autoindex_strategy_decision_log_2',
]
const DROPPED = [
  'idx_strategy_label_matrix_v4_regime_veto',
  'idx_strategy_label_matrix_challenger_v1',
  'idx_strategy_matrix_evaluability_status',
]

function replayed(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../../domain-migrations/learning/', import.meta.url)
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, dir), 'utf8'))
  }
  return db
}

const indexes = (db: DatabaseSync, table: string) => (db.prepare(
  `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? ORDER BY name`,
).all(table) as Array<{ name: string }>).map((row) => row.name)

const plan = (db: DatabaseSync, sql: string, ...binds: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
  .all(...binds as never[]) as Array<{ detail: string }>).map((row) => row.detail).join('\n')

test('migrations and the domain schema leave matrix 5 and decision_log 8 indexes', () => {
  const db = replayed()
  assert.deepEqual(indexes(db, 'strategy_label_matrix_v4'), MATRIX_INDEXES)
  assert.deepEqual(indexes(db, 'strategy_decision_log'), DECISION_INDEXES)
  const snapshot = new DatabaseSync(':memory:')
  snapshot.exec(read('../../domain-schemas/learning.sql'))
  assert.deepEqual(indexes(snapshot, 'strategy_label_matrix_v4'), MATRIX_INDEXES)
  // learning.sql never picked up 0008's evaluability_status index (pre-existing gap).
  assert.deepEqual(indexes(snapshot, 'strategy_decision_log'),
    DECISION_INDEXES.filter((name) => name !== 'idx_strategy_decision_evaluability_status'))
  // Runtime DDL must not re-create a dropped index on the next learning run.
  for (const name of DROPPED) {
    assert.ok(!read('./strategyLearning.ts').includes(name), name)
    assert.ok(!read('./strategyEvidenceMetrics.ts').includes(name), name)
    assert.ok(!read('./strategyEvidenceOwnerCalibration.ts').includes(name), name)
  }
})

test('matrix lookups keep their seeks without the dropped indexes', () => {
  const db = replayed()
  const runCells = plan(db, `SELECT strategy_id, strategy_version, symbol FROM strategy_label_matrix_v4
    WHERE signal_date=? AND producer_run_id=? ORDER BY strategy_id, symbol`, '2026-11-12', 'run')
  assert.match(runCells, /^SEARCH strategy_label_matrix_v4 USING (COVERING )?INDEX \S+ \(signal_date=\?\)/m, runCells)
  const challenger = plan(db, `SELECT COUNT(*) FROM strategy_label_matrix_v4 m
    WHERE m.signal_date=? AND m.challenger_affinity_version=?`, '2026-11-12', 'v2')
  assert.match(challenger, /USING COVERING INDEX idx_strategy_label_matrix_challenger_v2 \(signal_date=\? AND challenger_affinity_version=\?\)/, challenger)
  const profile = plan(db, `SELECT m.rowid FROM strategy_label_matrix_v4 m INDEXED BY idx_strategy_label_matrix_v4_profile_evidence
    WHERE m.strategy_id=? AND m.strategy_version=? AND m.strategy_hit=1 AND m.evaluable=1`, 's', 'v')
  assert.match(profile, /USING (COVERING )?INDEX idx_strategy_label_matrix_v4_profile_evidence/, profile)
  // The screener's mature OOF returns: one equality seek per (date, strategy) hit set.
  const oof = plan(db, buildMatureStrategyOofReturnsSql(buildStrategyFormalMatureCompatibilitySql('mr')),
    '2026-11-12', '2026-11-12', '2026-11-12', '{}', 'adj',
    ...buildStrategyFormalMatureCompatibilitySql('mr').binds)
  assert.match(oof, /SEARCH m USING INDEX idx_strategy_label_matrix_v4_evaluable \(signal_date=\? AND strategy_id=\? AND evaluable=\? AND strategy_hit=\?\)/, oof)
  for (const detail of [runCells, challenger, oof]) {
    assert.doesNotMatch(detail, /SCAN (m|strategy_label_matrix_v4)\b/, detail)
  }
})

test('decision_log lookups keep their seeks', () => {
  const db = replayed()
  const byDate = plan(db, `SELECT symbol, strategy_id, strategy_version, matched FROM strategy_decision_log
    WHERE date=? ORDER BY symbol, strategy_id, strategy_version`, '2026-11-12')
  assert.match(byDate, /^SEARCH strategy_decision_log USING (COVERING )?INDEX \S+ \(date=\?\)/m, byDate)
  const byContext = plan(db, `SELECT decision_id FROM strategy_decision_log WHERE context_id IS NULL LIMIT 10`)
  assert.match(byContext, /USING (COVERING )?INDEX idx_strategy_decision_log_context \(context_id=\?\)/, byContext)
  const exact = plan(db, `SELECT decision_id FROM strategy_decision_log
    WHERE date=? AND symbol=? AND strategy_id=? AND strategy_version=?`, 'd', 's', 'i', 'v')
  assert.match(exact, /sqlite_autoindex_strategy_decision_log_2 \(date=\? AND symbol=\? AND strategy_id=\? AND strategy_version=\?\)/, exact)
  for (const detail of [byDate, byContext, exact]) assert.doesNotMatch(detail, /SCAN strategy_decision_log\b/, detail)
})
