import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { runAuditJsonArchiveRetention, AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE } from './auditJsonArchive'

for (const mode of ['ok', 'missing', 'corrupt', 'concurrent_change', 'lock_retry', 'byte_budget', 'oversize'] as const) {
  test(`audit JSON ${mode}: verify immutable copy and compare original before scrub`, async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE paper_execution_events(id INTEGER PRIMARY KEY, account_id INTEGER,
      trade_date TEXT, symbol TEXT, side TEXT, event_type TEXT, status TEXT, reason TEXT,
      detail_json TEXT, order_id TEXT, pending_run_id TEXT, source TEXT, created_at TEXT)`)
    const original = JSON.stringify({ detail: mode === 'oversize' ? 'x'.repeat(1100000) : mode === 'byte_budget' ? 'x'.repeat(600000) : '原始證據'.repeat(400) })
    db.prepare("INSERT INTO paper_execution_events(id,trade_date,detail_json) VALUES(1,'2020-01-01',?)").run(original)
    if (mode === 'byte_budget') db.prepare("INSERT INTO paper_execution_events(id,trade_date,detail_json) VALUES(2,'2020-01-02',?)").run(original)
    let transportedBytes = 0
    let manifestWrites = 0
    const adapter = { prepare(sql: string) {
      let params: any[] = []
      return {
        sql, get params() { return params },
        bind(...args: any[]) { params = args; return this },
        async all() { const rows = db.prepare(sql).all(...params); transportedBytes = Math.max(transportedBytes, Buffer.byteLength(JSON.stringify(rows))); return { results: rows } },
        async first() { return sql.includes('SELECT 1 pending') ? db.prepare(sql).get(...params) ?? null : null },
        async run() { if (sql.includes('INTO dataset_snapshots')) manifestWrites++; return { meta: { changes: 1 } } },
      }
    }, async batch(statements: any[]) {
      return statements.map(s => s.sql.includes('WITH backed_up')
        ? { meta: { changes: Number(db.prepare(s.sql).run(...s.params).changes) } }
        : { meta: { changes: 1 } })
    } }
    const objects = new Map<string, string>()
    const r2 = {
      async get(key: string) {
        const raw = objects.get(key)
        return raw == null || mode === 'missing' ? null : { text: async () => mode === 'corrupt' ? 'corrupt' : raw }
      },
      async put(key: string, raw: string, options: any) {
        assert.equal(options.onlyIf.etagDoesNotMatch, '*')
        assert.equal(options.customMetadata.minimum_retention_days, '3650')
        objects.set(key, raw)
        if (mode === 'concurrent_change') db.exec("UPDATE paper_execution_events SET detail_json='newer evidence' WHERE id=1")
        if (mode === 'lock_retry') throw new Error('concurrent writer won the immutable key')
      },
    }
    try {
      const run = () => runAuditJsonArchiveRetention({ DB: adapter, ARTIFACTS: r2 } as any, {
        businessDate: '2026-09-22', targets: ['paper_execution_events'],
        dryRun: false, confirmPhrase: AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE,
      })
      if (mode === 'oversize') {
        await assert.rejects(run, /large_object_path/)
        assert.equal(objects.size, 0)
        assert.equal(manifestWrites, 0)
        return
      }
      const result = await run()
      assert(transportedBytes < 1100000)
      if (mode === 'byte_budget') {
        assert.equal(result.total_scrubbed_rows, 1)
        assert.equal(result.tables[0].backlog_remaining, true)
        assert.equal(db.prepare('SELECT detail_json FROM paper_execution_events WHERE id=2').get()!.detail_json, original)
      }
      const stored = db.prepare('SELECT detail_json FROM paper_execution_events WHERE id=1').get()!.detail_json
      if (mode === 'ok' || mode === 'lock_retry' || mode === 'byte_budget') {
        assert.equal(result.total_scrubbed_rows, 1)
        const pointer = JSON.parse(String(stored))
        assert.equal(pointer.archived_to_r2, true)
        assert.equal(JSON.parse(objects.get(pointer.r2_key)!).rows[0].detail_json, original)
      } else {
        assert.equal(result.tables[0].status, 'failed')
        assert.equal(stored, mode === 'concurrent_change' ? 'newer evidence' : original)
        if (mode !== 'concurrent_change') assert.equal(manifestWrites, 0)
      }
    } finally { db.close() }
  })
}
