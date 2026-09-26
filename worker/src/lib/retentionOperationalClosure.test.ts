import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

test('hot-drain success requires actual run items with no remaining backlog', () => {
  const source = readFileSync('src/routes/adminReadRoutes.ts', 'utf8')
  const start = source.indexOf('WITH ranked_runs AS (')
  const end = source.indexOf('ORDER BY p.policy_id', start) + 'ORDER BY p.policy_id'.length
  assert(start >= 0 && end > start)
  const sql = source.slice(start, end)
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE data_retention_policies(policy_id TEXT, action TEXT, status TEXT);
    CREATE TABLE data_retention_runs(run_id TEXT, policy_id TEXT, status TEXT, completed_at TEXT, created_at TEXT);
    CREATE TABLE data_retention_run_items(run_id TEXT, status TEXT, backlog_remaining INTEGER);`)
  try {
    for (const [id, state, backlog, hasItem] of [
      ['closed', 'success', 0, true], ['backlog', 'success', 1, true],
      ['failed', 'error', 0, true], ['missing', 'success', 0, false],
    ] as const) {
      const run = `retention-hot-window-drain:${id}:current`
      db.prepare(`INSERT INTO data_retention_policies VALUES (?, 'archive_delete', 'active')`).run(id)
      db.prepare(`INSERT INTO data_retention_runs VALUES (?, ?, 'success', datetime('now'), datetime('now'))`).run(run, id)
      if (hasItem) db.prepare('INSERT INTO data_retention_run_items VALUES (?, ?, ?)').run(run, state, backlog)
    }
    const rows = db.prepare(sql).all()
    assert.deepEqual(rows.map(r => [r.policy_id, r.operational]), [
      ['backlog', 0], ['closed', 1], ['failed', 0], ['missing', 0],
    ])
  } finally { db.close() }
})
