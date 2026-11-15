import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { test } from 'node:test'
import {
  AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
  AUDIT_JSON_REF_V2_GATE_KEY,
  AUDIT_JSON_REF_V2_SCHEMA,
  AUDIT_JSON_REF_V2_TARGET_ID,
  buildAuditJsonCandidateQuery,
  buildAuditJsonPendingProbe,
  runAuditJsonArchiveRetention,
  type AuditJsonArchiveTargetId,
} from './auditJsonArchive'
import type { RetentionCursor } from './retentionRunLedger'

// audit-json retention found its strategy_decision_log rows by walking the date index below
// the cutoff and reading every row's JSON (2026-11-13: 1.32M rows / 12.1 s per page query,
// 1.32M / 4.1 s per pending probe, ref-v2 1.64M / 9.8 s), all to find nothing. Learning 0069
// keeps one partial index per target predicate holding only the rows still to process.
const learningSchema = readFileSync('domain-schemas/learning.sql', 'utf8')
const opsSchema = readFileSync('domain-schemas/ops.sql', 'utf8')
const migration = readFileSync('domain-migrations/learning/0069_oof_hits_and_audit_json_pending_indexes.sql', 'utf8')
const PENDING_INDEX: Record<'strategy_decision_log' | typeof AUDIT_JSON_REF_V2_TARGET_ID, string> = {
  strategy_decision_log: 'idx_strategy_decision_log_audit_json_pending',
  [AUDIT_JSON_REF_V2_TARGET_ID]: 'idx_strategy_decision_log_ref_v2_pending',
}
const TARGETS = Object.keys(PENDING_INDEX) as Array<keyof typeof PENDING_INDEX>
const DECISION_INDEXES = [...learningSchema.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)\s+ON strategy_decision_log\b[^;]*;/g)]
const REF_MARK = JSON.stringify({ schema_version: AUDIT_JSON_REF_V2_SCHEMA })

function ddl(name: string): string {
  const match = [learningSchema, opsSchema].join('\n').match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))
  assert.ok(match, name)
  return match[0]
}

function openDb(withPendingIndexes: boolean): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=OFF')
  for (const name of ['strategy_decision_log', 'dataset_snapshots', 'data_retention_policies', 'data_retention_runs', 'data_retention_run_items', 'data_retention_cursors']) db.exec(ddl(name))
  for (const [statement, name] of DECISION_INDEXES) {
    if (withPendingIndexes || !Object.values(PENDING_INDEX).includes(name)) db.exec(statement)
  }
  return db
}

function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

// LENGTH() counts characters: over 1024 of them.
const big = (tag: string) => JSON.stringify({ tag, payload: '證據'.repeat(300) + 'x'.repeat(600) })
const small = (tag: string) => JSON.stringify({ tag })
const archivedPointer = (tag: string) => JSON.stringify({ schema_version: 'd1-audit-json-pointer-v1', archived_to_r2: true, tag, pad: 'x'.repeat(1200) })

function insert(db: DatabaseSync, row: { id: string; date: string; context: string; evidence: string; ids: boolean }): void {
  db.prepare(`INSERT INTO strategy_decision_log(decision_id,date,symbol,strategy_id,strategy_version,strategy_status,alpha_bucket,
    matched,match_score,reason_code,context_json,evidence_json,context_id,evidence_artifact_id)
    VALUES(?,?,?,'S1','v1','active','trend',1,0.5,'matched',?,?,?,?)`)
    .run(row.id, row.date, row.id.slice(-4), row.context, row.evidence, row.ids ? `ctx-${row.id}` : null, row.ids ? `art-${row.id}` : null)
}

function day(base: string, offset: number): string {
  return new Date(Date.parse(`${base}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10)
}

test('learning 0069 and the domain schema define the same pending indexes', () => {
  const pick = (text: string, name: string) => text.match(new RegExp(`CREATE INDEX IF NOT EXISTS ${name}\\b[^;]*;`))?.[0].replace(/\s+/g, ' ')
  for (const name of Object.values(PENDING_INDEX)) {
    assert.ok(pick(migration, name), name)
    assert.equal(pick(migration, name), pick(learningSchema, name), name)
  }
})

test('page queries and pending probes read the pending partial index, never the table', () => {
  const db = openDb(true)
  try {
    for (const target of TARGETS) {
      for (const cursor of [null, { cursor_date: '2026-01-16', cursor_key: 'd' } as RetentionCursor]) {
        for (const query of [
          buildAuditJsonCandidateQuery(target, '2026-01-21', 250, 1024, cursor),
          buildAuditJsonPendingProbe(target, '2026-01-21', 1024, cursor),
          // Any min_blob_bytes at or above the index threshold implies its predicate.
          buildAuditJsonCandidateQuery(target, '2026-01-21', 250, 4096, cursor),
        ]) {
          const plan = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.binds as SQLInputValue[]).map((row) => String(row.detail))
          const joined = plan.join(' | ')
          const range = cursor ? /\(date>\? AND date<\?\)$/ : /\(date<\?\)$/
          assert.ok(plan.some((detail) => detail.startsWith(`SEARCH strategy_decision_log USING INDEX ${PENDING_INDEX[target]} `) && range.test(detail)), `${target}: ${joined}`)
          assert.ok(!plan.some((detail) => /^SCAN strategy_decision_log\b/.test(detail)), `${target}: ${joined}`)
          // Rows come off the index in page order: no sort of the eligible rows.
          assert.ok(!plan.some((detail) => /TEMP B-TREE FOR LAST TERM OF ORDER BY/.test(detail)), `${target}: ${joined}`)
        }
      }
    }
    // A threshold below the index's cannot use it and keeps the former date walk (manual runs only).
    const below = buildAuditJsonCandidateQuery('strategy_decision_log', '2026-01-21', 250, 512, null)
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${below.sql}`).all(...below.binds as SQLInputValue[]).map((row) => String(row.detail))
    assert.ok(!plan.some((detail) => detail.includes(PENDING_INDEX.strategy_decision_log)), plan.join(' | '))
  } finally {
    db.close()
  }
})

test('a drained table costs only the rows still to process', () => {
  for (const target of TARGETS) {
    const counts: Record<string, number> = {}
    for (const withIndex of [true, false]) {
      const db = openDb(withIndex)
      try {
        for (let i = 0; i < 3000; i += 1) {
          const done = target === 'strategy_decision_log' ? archivedPointer(`a${i}`) : REF_MARK
          insert(db, { id: `d${String(i).padStart(5, '0')}`, date: day('2026-01-01', i % 60), context: done, evidence: done, ids: true })
        }
        for (const i of [17, 1200, 2999]) {
          const id = `d${String(i).padStart(5, '0')}`
          db.prepare('UPDATE strategy_decision_log SET context_json=?, evidence_json=? WHERE decision_id=?').run(big(id), small(id), id)
        }
        let calls = 0
        db.function('probe', (value) => { calls += 1; return value })
        // probe() leads the WHERE, so it counts every row the access path visits.
        const examined = (query: { sql: string; binds: unknown[] }) => {
          const sql = query.sql.replace(/WHERE date IS NOT NULL/, 'WHERE probe(decision_id) IS NOT NULL AND date IS NOT NULL')
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
    assert.ok(counts.true <= 4, `${target} with 0069 examined ${counts.true}`)
    assert.ok(counts.false >= 3000, `${target} without 0069 examined ${counts.false}`)
  }
})

// Full retention runs on two copies of the same data, one with and one without the pending
// indexes, with rows becoming eligible ahead of and behind the cursor between runs (cutoff
// moves, ids filled in later, a rewrite undoing a compaction, a late backfill) and rows
// leaving eligibility before they are reached. Both copies must select the same rows on every
// run, the drain must end with nothing eligible, and a row is archived again only after a
// rewrite made it eligible again.
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
    KV: { async get(key: string) { return key === AUDIT_JSON_REF_V2_GATE_KEY ? { mode: 'manual' } : null } },
    ARTIFACTS: {
      async get(key: string) { const body = objects.get(key); return body == null ? null : { text: async () => body } },
      async put(key: string, body: string) { objects.set(key, body) },
    },
  }
  return { db, env }
}

const snapshot = (db: DatabaseSync) => new Map((db.prepare('SELECT decision_id, context_json, evidence_json FROM strategy_decision_log').all() as Array<Record<string, string>>)
  .map((row) => [row.decision_id, `${row.context_json}\u0000${row.evidence_json}`]))

function eligibleIds(db: DatabaseSync, target: AuditJsonArchiveTargetId, cutoff: string): string[] {
  // The eligibility predicate, evaluated on every row (no index).
  const query = buildAuditJsonPendingProbe(target, cutoff, 1024, null)
  const sql = query.sql.replace('SELECT 1 pending FROM strategy_decision_log', 'SELECT decision_id FROM strategy_decision_log NOT INDEXED')
    .replace(/LIMIT 1$/, '')
  return (db.prepare(`${sql} ORDER BY decision_id`).all(...query.binds as SQLInputValue[]) as Array<{ decision_id: string }>).map((row) => row.decision_id)
}

for (const target of TARGETS) {
  test(`${target}: every run selects the same rows with and without the pending index, and the drain completes`, async () => {
    const refV2 = target === AUDIT_JSON_REF_V2_TARGET_ID
    const copies = [copyFor(true), copyFor(false)]
    const random = rng(refV2 ? 7 : 11)
    const eligibleJson = (tag: string) => (refV2 ? small(tag) : big(tag))
    const doneJson = (tag: string) => (refV2 ? REF_MARK : archivedPointer(tag))
    const each = (fn: (db: DatabaseSync) => void) => { for (const copy of copies) fn(copy.db) }
    const archivedCount = new Map<string, number>()
    const rewrites = new Map<string, number>()
    try {
      // 2026-03-01 .. 2026-04-14: eligible, already processed, never eligible (ids missing for the
      // archive target, a JSON array for ref-v2) and small rows.
      let serial = 0
      const newId = (date: string) => `${date}:${String(serial++).padStart(5, '0')}`
      for (let offset = 0; offset < 45; offset += 1) {
        const date = day('2026-03-01', offset)
        for (let i = 0; i < 6; i += 1) {
          const id = newId(date)
          const kind = random()
          const row = kind < 0.45 ? { context: eligibleJson(id), evidence: small(id), ids: true }
            : kind < 0.7 ? { context: doneJson(id), evidence: refV2 ? REF_MARK : small(id), ids: true }
              : kind < 0.85 ? { context: refV2 ? '[1,2]' : big(id), evidence: refV2 ? 'null' : big(id), ids: false }
                : { context: refV2 ? '{}' : small(id), evidence: '{}', ids: true }
          each((db) => insert(db, { id, date, ...row }))
        }
      }
      let businessDate = refV2 ? '2026-03-20' : '2026-04-10'
      const cutoffOf = (date: string) => day(date, refV2 ? -7 : -30)
      for (let runIndex = 0; runIndex < 80; runIndex += 1) {
        const before = copies.map((copy) => snapshot(copy.db))
        const results = []
        for (const copy of copies) {
          results.push(await runAuditJsonArchiveRetention(copy.env, {
            businessDate, runId: `run-${runIndex}`, targets: [target], retentionDays: 30,
            limitPerTable: 4, minBlobBytes: 1024, dryRun: false, confirmPhrase: AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
          }))
        }
        const [indexed, plain] = results.map((result) => {
          const { status, candidate_rows, archived_rows, scrubbed_rows, backlog_remaining, cursor_date, cursor_key } = result.tables[0]
          return { status, candidate_rows, archived_rows, scrubbed_rows, backlog_remaining, cursor_date, cursor_key }
        })
        assert.deepEqual(indexed, plain, `run ${runIndex}`)
        const changed = copies.map((copy, index) => {
          const after = snapshot(copy.db)
          return [...after.keys()].filter((id) => after.get(id) !== before[index].get(id)).sort()
        })
        assert.deepEqual(changed[0], changed[1], `run ${runIndex} changed rows`)
        for (const id of changed[0]) archivedCount.set(id, (archivedCount.get(id) ?? 0) + 1)

        if (runIndex >= 60) continue
        const draw = random()
        const rows = copies[0].db.prepare('SELECT decision_id, date, context_json, context_id FROM strategy_decision_log ORDER BY date, decision_id').all() as Array<Record<string, string | null>>
        const oldest = rows.slice(0, Math.max(1, Math.floor(rows.length / 3)))
        if (draw < 0.2) {
          businessDate = day(businessDate, 1) // the cutoff moves: rows ahead of the cursor become due
        } else if (draw < 0.4) {
          // A rewrite undoes the compaction of an old, already processed row: eligible behind the cursor.
          const row = oldest.find((r) => String(r.context_json).includes(refV2 ? AUDIT_JSON_REF_V2_SCHEMA : '"archived_to_r2":true'))
          if (row) {
            each((db) => db.prepare('UPDATE strategy_decision_log SET context_json=?, context_id=COALESCE(context_id, ?), evidence_artifact_id=COALESCE(evidence_artifact_id, ?) WHERE decision_id=?')
              .run(eligibleJson(`rw-${runIndex}`), `ctx-${runIndex}`, `art-${runIndex}`, String(row.decision_id)))
            rewrites.set(String(row.decision_id), (rewrites.get(String(row.decision_id)) ?? 0) + 1)
          }
        } else if (draw < 0.55) {
          // Ids filled in later (evidence migration) or the JSON becomes an object: eligible behind the cursor.
          const row = oldest.find((r) => (refV2 ? String(r.context_json) === '[1,2]' : r.context_id == null))
          if (row) each((db) => db.prepare(refV2
            ? "UPDATE strategy_decision_log SET context_json='{\"late\":true}' WHERE decision_id=?"
            : "UPDATE strategy_decision_log SET context_id='ctx-late', evidence_artifact_id='art-late' WHERE decision_id=?").run(String(row.decision_id)))
        } else if (draw < 0.7) {
          // A late backfill of an old date.
          const date = String(oldest[Math.floor(random() * oldest.length)].date)
          const id = newId(date)
          each((db) => insert(db, { id, date, context: eligibleJson(id), evidence: small(id), ids: true }))
        } else if (draw < 0.8) {
          // An eligible row leaves eligibility before it is reached.
          const pending = eligibleIds(copies[0].db, target, '9999-12-31')
          const id = pending[Math.floor(random() * pending.length)]
          if (id) each((db) => db.prepare('UPDATE strategy_decision_log SET context_json=?, evidence_json=? WHERE decision_id=?').run(refV2 ? '[0]' : small(id), refV2 ? '[0]' : small(id), id))
        }
      }
      // Drained: nothing below the cutoff is still eligible, and integrity_check confirms each
      // partial index holds exactly the rows satisfying its WHERE.
      const cutoff = cutoffOf(businessDate)
      for (const copy of copies) {
        assert.deepEqual(eligibleIds(copy.db, target, cutoff), [], 'eligible rows left behind')
        assert.equal(Object.values(copy.db.prepare('PRAGMA integrity_check').get()!)[0], 'ok')
      }
      // Rows due by the end were archived at least once overall; none was archived twice without a rewrite.
      assert.ok([...archivedCount.values()].reduce((sum, n) => sum + n, 0) > 40, 'the drain must have archived rows')
      for (const [id, count] of archivedCount) assert.ok(count <= 1 + (rewrites.get(id) ?? 0), `${id} archived ${count} times after ${rewrites.get(id) ?? 0} rewrites`)
      assert.ok([...rewrites.keys()].some((id) => (archivedCount.get(id) ?? 0) >= 2), 'a rewritten row must be archived again')
    } finally {
      for (const copy of copies) copy.db.close()
    }
  })
}
