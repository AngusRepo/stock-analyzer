import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

// daily-snapshot's NAV reconciliation walked every paper_execution_events row for two lookups
// (2026-11-27 18:25: 163,938 rows / 4.8 s + TEMP B-TREE, then ~164K more) and PAPER_DB answered
// "D1 DB is overloaded" on 11/26 and 11/27. Paper 0012 adds (account_id, event_type, trade_date).
const schema = readFileSync('domain-schemas/paper.sql', 'utf8')
const migration = readFileSync('domain-migrations/paper/0012_paper_execution_events_account_type_date_index.sql', 'utf8')
const source = readFileSync('src/lib/paperSnapshotAudit.ts', 'utf8')
const INDEX = 'idx_paper_execution_events_account_type_date'

function statement(pattern: RegExp): string {
  const match = source.match(pattern)
  assert.ok(match, String(pattern))
  return match[1].replace(/\s+/g, ' ').trim()
}

// Taken from the source so the test cannot drift from the queries production runs.
const PREVIOUS_AUDIT = statement(/prepare\(`\s*(SELECT trade_date, detail_json FROM paper_execution_events[\s\S]*?LIMIT 1)\s*`\)/)
const CONVERSIONS = statement(/prepare\(`\s*(SELECT symbol, detail_json FROM paper_execution_events[\s\S]*?corporate_share_conversion[\s\S]*?)\s*`\)/)

function openDb(withIndex: boolean): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const table = schema.match(/CREATE TABLE IF NOT EXISTS paper_execution_events \([\s\S]*?\n\);/)
  assert.ok(table)
  db.exec(table[0])
  for (const [ddl, name] of schema.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)\s+ON paper_execution_events\b[^;]*;/g)) {
    if (withIndex || name !== INDEX) db.exec(ddl)
  }
  return db
}

function plan(db: DatabaseSync, sql: string, params: Array<string | number>): string {
  return db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map((row) => String((row as { detail: string }).detail)).join(' | ')
}

test('paper 0012 matches the schema copy of the index', () => {
  const ddl = (text: string) => text.match(new RegExp(`CREATE INDEX IF NOT EXISTS ${INDEX}[^;]*;`))?.[0].replace(/\s+/g, ' ')
  assert.ok(ddl(migration))
  assert.equal(ddl(migration), ddl(schema))
})

test('NAV reconciliation lookups search the account/type/date index without a sort', () => {
  const db = openDb(true)
  for (const [sql, params] of [[PREVIOUS_AUDIT, [1, '2026-11-27']], [CONVERSIONS, [1, '2026-11-26', '2026-11-27']]] as const) {
    const detail = plan(db, sql, [...params])
    assert.match(detail, new RegExp(`SEARCH paper_execution_events USING INDEX ${INDEX} \\(account_id=\\? AND event_type=\\? AND trade_date[<>]\\?`), detail)
    assert.doesNotMatch(detail, /\bSCAN\b|TEMP B-TREE/, detail)
  }
})

test('without paper 0012 the previous-audit lookup falls back to the account index and a sort', () => {
  const detail = plan(openDb(false), PREVIOUS_AUDIT, [1, '2026-11-27'])
  assert.doesNotMatch(detail, new RegExp(INDEX))
  assert.match(detail, /TEMP B-TREE/, detail)
})

test('the previous-audit lookup still returns the latest verified dated-marks row', () => {
  const db = openDb(true)
  const insert = db.prepare(`INSERT INTO paper_execution_events (account_id, trade_date, event_type, status, reason, detail_json)
    VALUES (1, ?, ?, ?, ?, ?)`)
  insert.run('2026-11-25', 'snapshot_audit', 'verified', 'dated_marks_complete', '{"d":25}')
  insert.run('2026-11-26', 'snapshot_audit', 'verified', 'dated_marks_complete', '{"d":26}')
  insert.run('2026-11-26', 'snapshot_audit', 'verified', 'dated_marks_complete', '{"d":"26b"}')
  insert.run('2026-11-26', 'snapshot_audit', 'skipped', 'nav_reconciliation_unavailable', '{}')
  insert.run('2026-11-27', 'snapshot_audit', 'verified', 'dated_marks_complete', '{"d":27}')
  const row = db.prepare(PREVIOUS_AUDIT).get(1, '2026-11-27') as { trade_date: string; detail_json: string }
  assert.deepEqual([row.trade_date, row.detail_json], ['2026-11-26', '{"d":"26b"}'])
})
