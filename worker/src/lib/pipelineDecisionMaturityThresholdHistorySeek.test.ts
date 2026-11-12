import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

// The dashboard's 7-day threshold history joined the matrix on producer_run_id and
// labeler_version only. No matrix index leads with producer_run_id, so every
// dashboard call scanned the whole matrix (~11M rows) instead of seeking 7 dates.
const schema = readFileSync('domain-schemas/learning.sql', 'utf8')
const source = readFileSync('src/lib/pipelineDecisionMaturity.ts', 'utf8')

test('threshold history seeks the matrix by signal_date instead of scanning it', () => {
  const sql = source.match(/`(\s*WITH recent_dates AS \([\s\S]*?LIMIT 7\s*)`/)?.[1]
  assert.ok(sql, 'threshold history SQL not found')
  const db = new DatabaseSync(':memory:')
  try {
    for (const table of ['strategy_label_matrix_v4', 'strategy_label_matrix_runs_v4']) {
      db.exec(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0])
      for (const index of schema.matchAll(new RegExp(`CREATE INDEX IF NOT EXISTS \\w+\\s+ON ${table}\\([^;]*\\);`, 'g'))) db.exec(index[0])
    }
    const bound = sql.replaceAll('${formalLabelerPlaceholders}', '?')
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${bound}`)
      .all('2026-11-12', 'labeler-a', 'labeler-a', 'affinity-v2').map((row) => String(row.detail))
    assert.ok(plan.some((detail) => /^SEARCH matrix /.test(detail) && /signal_date=\?/.test(detail)), plan.join(' | '))
    assert.ok(!plan.some((detail) => /^SCAN matrix\b/.test(detail)), plan.join(' | '))
  } finally {
    db.close()
  }
})
