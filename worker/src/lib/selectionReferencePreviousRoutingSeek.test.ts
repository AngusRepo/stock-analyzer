import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { SELECTION_REFERENCE_PREVIOUS_ROUTING_SQL } from './selectionReferenceEvidence'

// persistSelectionEvidenceV4 reads a producer's earlier routing rows by producer_run_id alone, so a
// legacy row of the same producer on another signal_date is still found and refused
// (selectionEvidenceWriterCas.test.ts, foreign-date). Without an index led by producer_run_id that
// read scanned the whole table on every call (prod plan: SCAN selection_reference_snapshots_v1).
const MIGRATIONS = 'domain-migrations/learning'
const INDEX_MIGRATION = '0067_selection_reference_producer_run_index.sql'
const SEARCH_PLAN = [
  'SEARCH selection_reference_snapshots_v1 USING INDEX idx_selection_reference_v1_producer_run (producer_run_id=?)',
]

function migrated(skip?: string): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    if (file !== skip) db.exec(readFileSync(`${MIGRATIONS}/${file}`, 'utf8'))
  }
  return db
}

function plan(db: DatabaseSync): string[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${SELECTION_REFERENCE_PREVIOUS_ROUTING_SQL}`).all()
    .map((row) => String((row as { detail: string }).detail))
}

test('previous routing read is an index SEARCH on the migrated and the bootstrap schema', () => {
  assert.ok(readdirSync(MIGRATIONS).includes(INDEX_MIGRATION))
  assert.deepEqual(plan(migrated()), SEARCH_PLAN)
  const bootstrap = new DatabaseSync(':memory:')
  bootstrap.exec(readFileSync('domain-schemas/learning.sql', 'utf8'))
  assert.deepEqual(plan(bootstrap), SEARCH_PLAN)
  // The index is what removes the scan: without 0067 the same SQL scans the table.
  assert.deepEqual(plan(migrated(INDEX_MIGRATION)), ['SCAN selection_reference_snapshots_v1'])
})

test('daily pipeline summary reference count is an index SEARCH', () => {
  // routes/other.ts counts the latest run's references by producer_run_id alone; it scanned too.
  const source = readFileSync(new URL('../routes/other.ts', import.meta.url), 'utf8')
  const match = source.match(/const referenceCount = await learningDb\.prepare\(`([\s\S]*?)`\)/)
  assert.ok(match)
  const sql = match[1].replaceAll("${STRATEGY_FORMAL_LABELER_VERSIONS.map(() => '?').join(',')}", '?, ?')
  assert.ok(!sql.includes('${'))
  const details = migrated().prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
    .map((row) => String((row as { detail: string }).detail))
  assert.ok(details.includes(SEARCH_PLAN[0]), details.join(' | '))
  assert.ok(!details.some((detail) => /^SCAN selection_reference_snapshots_v1\b/.test(detail)), details.join(' | '))
})

test('previous routing read still returns the producer rows on every signal_date', () => {
  const db = migrated()
  const insert = db.prepare(`
    INSERT INTO selection_reference_snapshots_v1 (
      signal_date, symbol, producer_run_id, hard_gate_passed, hard_gate_reason, feature_available,
      strategy_labeled, strategy_selected, selection_stage, strategy_registry_checksum, feature_contract_version,
      strategy_router_version, strategy_router_score
    ) VALUES (?, ?, ?, 1, 'pass', 1, 1, 0, 'scoring', 'chk', 'contract', ?, ?)
  `)
  const run = 'screener-v2-2026-08-24-seek'
  for (const date of ['2026-08-21', '2026-08-24', '2026-08-25']) {
    for (const symbol of ['1101', '2330', '2454']) {
      insert.run(date, symbol, `screener-v2-${date}`, 'router-v1', 0.5)
    }
  }
  insert.run('2026-08-24', '1101', run, 'router-v1', 0.4)
  insert.run('2026-08-24', '2330', run, null, null)
  // Legacy row of the same producer on a foreign date, without a run header.
  insert.run('2026-08-23', '2454', run, 'router-v1', 0)

  const rows = db.prepare(SELECTION_REFERENCE_PREVIOUS_ROUTING_SQL).all(run)
    .map((row) => ({ ...row }))
    .sort((left, right) => `${left.signal_date}|${left.symbol}`.localeCompare(`${right.signal_date}|${right.symbol}`))
  assert.deepEqual(rows, [
    {
      signal_date: '2026-08-23', symbol: '2454', strategy_router_version: 'router-v1', strategy_router_score: 0,
      strategy_challenger_route_version: null, strategy_challenger_route_score: null,
    },
    {
      signal_date: '2026-08-24', symbol: '1101', strategy_router_version: 'router-v1', strategy_router_score: 0.4,
      strategy_challenger_route_version: null, strategy_challenger_route_score: null,
    },
    {
      signal_date: '2026-08-24', symbol: '2330', strategy_router_version: null, strategy_router_score: null,
      strategy_challenger_route_version: null, strategy_challenger_route_score: null,
    },
  ])
})
