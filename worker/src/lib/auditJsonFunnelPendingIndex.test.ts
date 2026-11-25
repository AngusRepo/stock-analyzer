import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { test } from 'node:test'
import {
  AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
  buildAuditJsonCandidateQuery,
  buildAuditJsonPendingProbe,
  runAuditJsonArchiveRetention,
  type AuditJsonArchiveTargetId,
} from './auditJsonArchive'
import type { RetentionCursor } from './retentionRunLedger'

// audit-json retention walked screener_funnel_items' date index below the 90-day cutoff and read
// every row's evidence on each run to find nothing (7 days to 2026-11-24: 478M rows, ops-db's
// largest reader). ops 0026 adds one partial index holding only rows whose evidence still has to
// move; both funnel targets repeat its predicate and check their own run filter per entry.
const opsSchema = readFileSync('domain-schemas/ops.sql', 'utf8')
const learningSchema = readFileSync('domain-schemas/learning.sql', 'utf8')
const migration = readFileSync('domain-migrations/ops/0026_screener_funnel_audit_json_pending_index.sql', 'utf8')
const INDEX = 'idx_screener_funnel_items_audit_json_pending'
const TARGETS: AuditJsonArchiveTargetId[] = ['screener_funnel_items', 'canonical_screener_funnel_items']
const PIT = 'pit_residual_momentum_shadow'

function ddl(name: string): string {
  const match = [opsSchema, learningSchema].join('\n').match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))
  assert.ok(match, name)
  return match[0]
}

const FUNNEL_INDEXES = [...opsSchema.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)\s+ON screener_funnel_(?:items|runs)\b[^;]*;/g)]

function openDb(withPendingIndex: boolean): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=OFF')
  for (const name of ['screener_funnel_runs', 'screener_funnel_items', 'canonical_run_heads', 'dataset_snapshots', 'data_retention_policies', 'data_retention_runs', 'data_retention_run_items', 'data_retention_cursors']) db.exec(ddl(name))
  for (const [statement, name] of FUNNEL_INDEXES) if (withPendingIndex || name !== INDEX) db.exec(statement)
  return db
}

function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const big = (tag: string) => JSON.stringify({ tag, payload: '證據'.repeat(300) + 'x'.repeat(600) })
const small = (tag: string) => JSON.stringify({ tag })
const archivedPointer = (tag: string) => JSON.stringify({ schema_version: 'd1-audit-json-pointer-v1', archived_to_r2: true, tag, pad: 'x'.repeat(1200) })

function day(base: string, offset: number): string {
  return new Date(Date.parse(`${base}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
}

function addRun(db: DatabaseSync, runId: string, date: string, createdAt: string, canonical: boolean): void {
  db.prepare(`INSERT INTO screener_funnel_runs(run_id,date,status,created_at) VALUES(?,?,'success',?)`).run(runId, date, createdAt)
  if (canonical) db.prepare(`INSERT INTO canonical_run_heads(logical_run_key,run_id,promoted_at) VALUES(?,?,?)`).run(`screener:${runId}`, runId, createdAt)
}

function addItem(db: DatabaseSync, runId: string, date: string, symbol: string, stage: string, evidence: string): void {
  db.prepare(`INSERT INTO screener_funnel_items(run_id,date,symbol,stage,decision,reason_code,evidence) VALUES(?,?,?,?,'keep','ok',?)`)
    .run(runId, date, symbol, stage, evidence)
}

test('ops 0026 and the ops domain schema define the same pending index', () => {
  const pick = (text: string) => text.match(new RegExp(`CREATE INDEX IF NOT EXISTS ${INDEX}\\b[^;]*;`))?.[0].replace(/\s+/g, ' ')
  assert.ok(pick(migration))
  assert.equal(pick(migration), pick(opsSchema))
})

test('funnel page queries and pending probes read the pending partial index, never the table', () => {
  const db = openDb(true)
  try {
    for (const target of TARGETS) {
      for (const cursor of [null, { cursor_date: '2026-01-16', cursor_key: '42' } as RetentionCursor]) {
        for (const query of [
          buildAuditJsonCandidateQuery(target, '2026-01-21', 250, 1024, cursor),
          buildAuditJsonPendingProbe(target, '2026-01-21', 1024, cursor),
          buildAuditJsonCandidateQuery(target, '2026-01-21', 250, 4096, cursor),
        ]) {
          const plan = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.binds as SQLInputValue[]).map((row) => String(row.detail))
          const joined = plan.join(' | ')
          const range = cursor ? /\(date>\? AND date<\?\)$/ : /\(date<\?\)$/
          assert.ok(plan.some((detail) => detail.startsWith(`SEARCH screener_funnel_items USING INDEX ${INDEX} `) && range.test(detail)), `${target}: ${joined}`)
          assert.ok(!plan.some((detail) => /^SCAN screener_funnel_items\b/.test(detail)), `${target}: ${joined}`)
          assert.ok(!plan.some((detail) => /TEMP B-TREE FOR LAST TERM OF ORDER BY/.test(detail)), `${target}: ${joined}`)
        }
      }
    }
    // A threshold below the index's cannot use it and keeps the former date walk (manual runs only).
    const below = buildAuditJsonCandidateQuery('screener_funnel_items', '2026-01-21', 250, 512, null)
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${below.sql}`).all(...below.binds as SQLInputValue[]).map((row) => String(row.detail))
    assert.ok(!plan.some((detail) => detail.includes(INDEX)), plan.join(' | '))
  } finally {
    db.close()
  }
})

test('a drained funnel table costs only the rows still to process', () => {
  for (const target of TARGETS) {
    const counts: Record<string, number> = {}
    for (const withIndex of [true, false]) {
      const db = openDb(withIndex)
      try {
        for (let d = 0; d < 60; d += 1) {
          const date = day('2026-01-01', d)
          addRun(db, `c-${date}`, date, `${date}T10:00:00Z`, true)
          addRun(db, `x-${date}`, date, `${date}T09:00:00Z`, false)
          for (let i = 0; i < 25; i += 1) {
            addItem(db, `c-${date}`, date, `S${i}`, 'final_selection', archivedPointer(`c${d}-${i}`))
            addItem(db, `x-${date}`, date, `S${i}`, 'final_selection', archivedPointer(`x${d}-${i}`))
          }
        }
        // Three rows still to move for this target.
        const runOf = (date: string) => (target === 'screener_funnel_items' ? `x-${date}` : `c-${date}`)
        for (const date of ['2026-01-05', '2026-01-30', '2026-02-20']) addItem(db, runOf(date), date, 'NEW', 'final_selection', big(date))
        let calls = 0
        db.function('probe', (value) => { calls += 1; return value })
        const examined = (query: { sql: string; binds: unknown[] }) => {
          const sql = query.sql.replace(/WHERE date IS NOT NULL/, 'WHERE probe(id) IS NOT NULL AND date IS NOT NULL')
          assert.notEqual(sql, query.sql)
          calls = 0
          const rows = db.prepare(sql).all(...query.binds as SQLInputValue[])
          return { rows: rows.length, calls }
        }
        const page = examined(buildAuditJsonCandidateQuery(target, '2026-04-01', 250, 1024, null))
        const probe = examined(buildAuditJsonPendingProbe(target, '2026-04-01', 1024, null))
        assert.equal(page.rows, 3)
        assert.equal(probe.rows, 1)
        counts[String(withIndex)] = page.calls + probe.calls
      } finally {
        db.close()
      }
    }
    assert.ok(counts.true <= 4, `${target} with 0026 examined ${counts.true}`)
    assert.ok(counts.false >= 3000, `${target} without 0026 examined ${counts.false}`)
  }
})

// Full retention runs on two copies of the same data, one with and one without the index.
// Rows stay in the index while no target moves them (PIT stages of canonical runs, rows of a
// run that becomes canonical later); both copies must still select the same rows every run.
type Copy = { db: DatabaseSync; env: any }

function copyFor(withIndex: boolean): Copy {
  const db = openDb(withIndex)
  const adapter = {
    prepare(sql: string) {
      let params: SQLInputValue[] = []
      return {
        sql,
        bind(...values: SQLInputValue[]) { params = values; return this },
        async all() { return { results: db.prepare(sql).all(...params), meta: {} } },
        async first() { return db.prepare(sql).get(...params) ?? null },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } } },
      }
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      db.exec('BEGIN')
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        db.exec('COMMIT')
        return results
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  const objects = new Map<string, string>()
  const env = {
    DB: adapter,
    KV: { async get() { return null } },
    ARTIFACTS: {
      async get(key: string) { const body = objects.get(key); return body == null ? null : { text: async () => body } },
      async put(key: string, body: string) { objects.set(key, body) },
    },
  }
  return { db, env }
}

const snapshot = (db: DatabaseSync) => new Map((db.prepare('SELECT id, evidence FROM screener_funnel_items').all() as Array<Record<string, string>>)
  .map((row) => [String(row.id), String(row.evidence)]))

function eligibleIds(db: DatabaseSync, target: AuditJsonArchiveTargetId, cutoff: string): string[] {
  const query = buildAuditJsonPendingProbe(target, cutoff, 1024, null)
  const sql = query.sql.replace('SELECT 1 pending FROM screener_funnel_items', 'SELECT id FROM screener_funnel_items NOT INDEXED').replace(/LIMIT 1$/, '')
  assert.notEqual(sql, query.sql)
  return (db.prepare(`${sql} ORDER BY id`).all(...query.binds as SQLInputValue[]) as Array<{ id: number }>).map((row) => String(row.id))
}

test('every funnel retention run selects the same rows with and without the pending index', async () => {
  const copies = [copyFor(true), copyFor(false)]
  const random = rng(23)
  const each = (fn: (db: DatabaseSync) => void) => { for (const copy of copies) fn(copy.db) }
  try {
    for (let d = 0; d < 40; d += 1) {
      const date = day('2026-03-01', d)
      each((db) => {
        addRun(db, `c-${date}`, date, `${date}T10:00:00Z`, true)
        addRun(db, `x-${date}`, date, `${date}T09:00:00Z`, false)
        addRun(db, `l-${date}`, date, `${date}T11:00:00Z`, false) // latest successful run: kept by the non-canonical target
      })
      for (let i = 0; i < 6; i += 1) {
        for (const run of ['c', 'x', 'l']) {
          const kind = random()
          const stage = random() < 0.25 ? PIT : 'final_selection'
          const evidence = kind < 0.5 ? big(`${run}${d}-${i}`) : kind < 0.75 ? archivedPointer(`${run}${d}-${i}`) : small(`${run}${d}-${i}`)
          each((db) => addItem(db, `${run}-${date}`, date, `S${i}`, stage, evidence))
        }
      }
    }
    let businessDate = '2026-04-05'
    for (let runIndex = 0; runIndex < 90; runIndex += 1) {
      for (const target of TARGETS) {
        const before = copies.map((copy) => snapshot(copy.db))
        const results = []
        for (const copy of copies) {
          results.push(await runAuditJsonArchiveRetention(copy.env, {
            businessDate, runId: `run-${runIndex}-${target}`, targets: [target], retentionDays: 30,
            limitPerTable: 25, minBlobBytes: 1024, dryRun: false, confirmPhrase: AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
          }))
        }
        const [indexed, plain] = results.map((result) => {
          const { status, candidate_rows, archived_rows, scrubbed_rows, backlog_remaining, cursor_date, cursor_key } = result.tables[0]
          return { status, candidate_rows, archived_rows, scrubbed_rows, backlog_remaining, cursor_date, cursor_key }
        })
        for (const result of results) assert.notEqual(result.tables[0].status, 'failed', JSON.stringify(result.tables[0]))
        assert.deepEqual(indexed, plain, `run ${runIndex} ${target}`)
        const changed = copies.map((copy, index) => {
          const after = snapshot(copy.db)
          return [...after.keys()].filter((id) => after.get(id) !== before[index].get(id)).sort()
        })
        assert.deepEqual(changed[0], changed[1], `run ${runIndex} ${target} changed rows`)
      }
      if (runIndex >= 50) continue // quiet runs: the drain must finish
      const draw = random()
      if (draw < 0.3) businessDate = day(businessDate, 1)
      else if (draw < 0.45) {
        // A non-canonical run is promoted later: its pending rows move to the canonical target.
        const date = day('2026-03-01', Math.floor(random() * 40))
        each((db) => db.prepare(`INSERT OR IGNORE INTO canonical_run_heads(logical_run_key,run_id,promoted_at) VALUES(?,?,?)`).run(`late:${date}`, `x-${date}`, `${date}T12:00:00Z`))
      } else if (draw < 0.6) {
        // A late backfill of an old date.
        const date = day('2026-03-01', Math.floor(random() * 20))
        each((db) => addItem(db, `x-${date}`, date, `L${runIndex}`, 'final_selection', big(`late-${runIndex}`)))
      }
    }
    const cutoff = day(businessDate, -30)
    for (const copy of copies) {
      for (const target of TARGETS) assert.deepEqual(eligibleIds(copy.db, target, cutoff), [], `${target} eligible rows left behind`)
      assert.equal(Object.values(copy.db.prepare('PRAGMA integrity_check').get()!)[0], 'ok')
    }
    // PIT rows of canonical runs are never moved and stay in the index.
    const stuck = copies[0].db.prepare(`SELECT COUNT(*) n FROM screener_funnel_items INDEXED BY ${INDEX}
      WHERE LENGTH(COALESCE(evidence, '')) > 1024 AND COALESCE(evidence, '') NOT LIKE '%"archived_to_r2":true%' AND date < ?`).get(cutoff) as { n: number }
    assert.ok(stuck.n > 0, 'fixture must keep some never-archived PIT rows below the cutoff')
  } finally {
    for (const copy of copies) copy.db.close()
  }
})
