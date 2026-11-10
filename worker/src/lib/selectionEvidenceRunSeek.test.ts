import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

// Both tables key on (signal_date, ..., producer_run_id), so a producer_run_id-only
// predicate scanned every stored run (11.1M matrix rows, 13 s, on 2026-11-05).
const schema = readFileSync('domain-schemas/learning.sql', 'utf8')
const source = readFileSync('src/lib/selectionReferenceEvidence.ts', 'utf8')

test('ready-run readback and promotion seek one signal date instead of scanning every run', () => {
  const db = new DatabaseSync(':memory:')
  try {
    for (const table of ['strategy_label_matrix_v4', 'selection_reference_snapshots_v1']) {
      db.exec(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0])
      for (const index of schema.matchAll(new RegExp(`CREATE INDEX IF NOT EXISTS \\w+\\s+ON ${table}\\([^;]*\\);`, 'g'))) db.exec(index[0])
    }
    for (const [table, alias] of [['strategy_label_matrix_v4', 'm'], ['selection_reference_snapshots_v1', 'r']]) {
      assert.match(source, new RegExp(`FROM ${table} ${alias}\\s+WHERE ${alias}\\.signal_date=\\? AND ${alias}\\.producer_run_id=\\?`))
      assert.match(source, new RegExp(`DELETE FROM ${table}\\s+WHERE signal_date=\\? AND producer_run_id=\\? AND EXISTS`))
      assert.doesNotMatch(source, new RegExp(`DELETE FROM ${table}\\s+WHERE producer_run_id=\\?`))
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM ${table} ${alias} WHERE ${alias}.signal_date=? AND ${alias}.producer_run_id=?`)
        .all('2026-11-05', 'screener-v2-1').map((row) => String(row.detail))
      assert.ok(plan.some((detail) => /^SEARCH /.test(detail) && /signal_date=\?/.test(detail)), plan.join(' | '))
      assert.ok(!plan.some((detail) => /^SCAN /.test(detail)), plan.join(' | '))
    }
  } finally {
    db.close()
  }
})
