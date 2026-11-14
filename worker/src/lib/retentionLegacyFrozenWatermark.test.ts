import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  buildRetentionArchiveOnlyQuery,
  retentionArchiveOnlyBinds,
  retentionR2PolicyConfig,
  runRetentionArchiveOnly,
} from './retentionArchiveOnly'

// Legacy schema slice with the production indexes these sources seek through.
const LEGACY_DDL = `
  CREATE TABLE screener_funnel_runs(run_id TEXT PRIMARY KEY, date TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX idx_screener_funnel_runs_date ON screener_funnel_runs(date DESC, created_at DESC);
  CREATE TABLE screener_funnel_items(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, date TEXT NOT NULL, symbol TEXT NOT NULL);
  CREATE INDEX idx_screener_funnel_items_run ON screener_funnel_items(run_id);
  CREATE INDEX idx_screener_funnel_items_date_id ON screener_funnel_items(date, id);
  CREATE TABLE canonical_run_heads(logical_run_key TEXT PRIMARY KEY, run_id TEXT NOT NULL);
  CREATE TABLE pending_buy_runs(id INTEGER PRIMARY KEY AUTOINCREMENT, trade_date TEXT NOT NULL, status TEXT NOT NULL);
  CREATE INDEX idx_pending_buy_runs_status ON pending_buy_runs(status, trade_date DESC);
  CREATE TABLE pending_buy_items(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, symbol TEXT NOT NULL);
  CREATE INDEX idx_pending_buy_items_run ON pending_buy_items(run_id);
  CREATE TABLE paper_execution_events(id INTEGER PRIMARY KEY AUTOINCREMENT, trade_date TEXT NOT NULL, event_type TEXT NOT NULL, status TEXT NOT NULL, pending_run_id INTEGER);
  CREATE INDEX idx_paper_execution_events_date ON paper_execution_events(trade_date DESC, event_type, status);
  CREATE TABLE predictions(id INTEGER PRIMARY KEY AUTOINCREMENT, generated_at TEXT NOT NULL, prediction_date TEXT);
  CREATE TABLE dataset_snapshots(snapshot_id TEXT PRIMARY KEY, kind TEXT, business_date TEXT, status TEXT, r2_key TEXT);
  CREATE TABLE state_space_shadow_results(id INTEGER PRIMARY KEY AUTOINCREMENT, run_date TEXT NOT NULL);
  CREATE TABLE allocator_ev_snapshot_runs(run_id TEXT PRIMARY KEY, status TEXT, updated_at TEXT);
  CREATE TABLE data_domain_writer_epochs(domain TEXT PRIMARY KEY, epoch INTEGER NOT NULL, writer_state TEXT NOT NULL);
  INSERT INTO data_domain_writer_epochs VALUES ('ops',1,'cutover'),('paper',1,'cutover'),('learning',1,'cutover');
`

// The real OPS schema seeds the legacy_hot_r2_v1 policy row (hot window 30 days).
const OPS_DDL = fs.readFileSync('domain-schemas/ops.sql', 'utf8')

type Executed = { sql: string; args: unknown[] }

function d1(db: DatabaseSync, log?: Executed[]) {
  const prepare = (sql: string) => {
    let args: unknown[] = []
    const statement = {
      bind(...values: unknown[]) { args = values; return statement },
      async all() { log?.push({ sql, args }); return { results: db.prepare(sql).all(...(args as any[])) } },
      async first() { log?.push({ sql, args }); return db.prepare(sql).get(...(args as any[])) ?? null },
      async run() { log?.push({ sql, args }); db.prepare(sql).run(...(args as any[])); return { success: true, meta: { changes: 1 } } },
    }
    return statement
  }
  return { prepare, async batch(statements: Array<{ run(): Promise<unknown> }>) { for (const s of statements) await s.run(); return [] } }
}

function memoryR2() {
  const objects = new Map<string, string>()
  return {
    objects,
    async get(key: string) { const body = objects.get(key); return body == null ? null : { text: async () => body } },
    async put(key: string, body: string) { objects.set(key, body) },
  }
}

function seedScreener(db: DatabaseSync, date: string, runs: Array<{ id: string; status: string; created: string; items: number; head?: boolean }>) {
  for (const run of runs) {
    db.prepare('INSERT INTO screener_funnel_runs VALUES (?,?,?,?)').run(run.id, date, run.status, run.created)
    if (run.head) db.prepare('INSERT INTO canonical_run_heads VALUES (?,?)').run(`head:${run.id}`, run.id)
    for (let i = 0; i < run.items; i += 1) db.prepare('INSERT INTO screener_funnel_items(run_id,date,symbol) VALUES (?,?,?)').run(run.id, date, `${run.id}-${i}`)
  }
}

const screenerSource = () => retentionR2PolicyConfig('legacy_hot_r2_v1')!.sources.find((s) => s.datasetId === 'obsolete_screener_items')!

test('screener eligibility keeps the NOT EXISTS row set while building the head set once', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(LEGACY_DDL)
    seedScreener(db, '2026-05-01', [
      { id: 'old', status: 'success', created: '2026-05-01 09:00', items: 3 },
      { id: 'pinned', status: 'success', created: '2026-05-01 10:00', items: 2, head: true },
      { id: 'failed', status: 'error', created: '2026-05-01 12:00', items: 2 },
      { id: 'latest', status: 'success', created: '2026-05-01 11:00', items: 4 },
    ])
    seedScreener(db, '2026-05-02', [{ id: 'only', status: 'success', created: '2026-05-02 09:00', items: 2 }])
    const expected = db.prepare(`SELECT i.id FROM screener_funnel_items i
      WHERE i.date < '2026-06-01' AND NOT EXISTS (SELECT 1 FROM canonical_run_heads h WHERE h.run_id=i.run_id)
        AND i.run_id <> COALESCE((SELECT latest.run_id FROM screener_funnel_runs latest WHERE latest.date=i.date
          AND latest.status='success' ORDER BY latest.created_at DESC LIMIT 1), '')
      ORDER BY i.date, i.id`).all().map((r) => r.id)
    const source = screenerSource()
    const rows = db.prepare(buildRetentionArchiveOnlyQuery(source, null)).all(...(retentionArchiveOnlyBinds(source, '2026-06-01', null, 100) as any[]))
    assert.deepEqual(rows.map((r) => r.id), expected)
    assert.equal(expected.length, 5) // 'old' (3) + 'failed' (2)

    const plan = db.prepare('EXPLAIN QUERY PLAN ' + buildRetentionArchiveOnlyQuery(source, { cursor_date: '2026-06-01', cursor_key: '0' }))
      .all(...(retentionArchiveOnlyBinds(source, '2026-06-01', { cursor_date: '2026-06-01', cursor_key: '0' }, 100) as any[]))
      .map((r) => String(r.detail)).join('\n')
    assert.match(plan, /SEARCH i USING (COVERING )?INDEX idx_screener_funnel_items_date_id \(date>\? AND date<\?\)/)
    assert.match(plan, /LIST SUBQUERY/)
    assert.doesNotMatch(plan, /CORRELATED SCALAR SUBQUERY \d+\n.*SCAN h/)
  } finally { db.close() }
})

test('legacy cursors bound the date index, including substr archive dates, and keep page parity', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(LEGACY_DDL)
    const run = db.prepare('INSERT INTO pending_buy_runs(trade_date,status) VALUES (?,?)')
    const event = db.prepare('INSERT INTO paper_execution_events(trade_date,event_type,status,pending_run_id) VALUES (?,?,?,?)')
    for (let day = 1; day <= 28; day += 1) {
      const date = `2026-06-${String(day).padStart(2, '0')}`
      const superseded = Number(run.run(date, day % 3 === 0 ? 'ready' : 'superseded').lastInsertRowid)
      for (let i = 0; i < 7; i += 1) {
        // Mixed raw formats: the archive date is substr(trade_date, 1, 10).
        event.run(i % 2 ? date : `${date} 0${i}:00:00`, i === 6 ? 'paper_order' : 'pending_buy', 'ok', superseded)
      }
    }
    const source = retentionR2PolicyConfig('legacy_hot_r2_v1')!.sources.find((s) => s.datasetId === 'superseded_pending_events')!
    const cutoff = '2026-06-25'
    const expected = db.prepare(`SELECT e.id FROM paper_execution_events e JOIN pending_buy_runs r ON r.id=e.pending_run_id
      WHERE substr(e.trade_date,1,10) < ? AND r.status='superseded'
        AND e.event_type IN ('pending_buy','debate','snapshot_audit','finlab_preview','finlab_execution_preview')
      ORDER BY substr(e.trade_date,1,10), e.id`).all(cutoff).map((r) => r.id)
    const actual: unknown[] = []
    let cursor: { cursor_date: string; cursor_key: string } | null = null
    for (let page = 0; page < 50; page += 1) {
      const rows = db.prepare(buildRetentionArchiveOnlyQuery(source, cursor)).all(...(retentionArchiveOnlyBinds(source, cutoff, cursor, 11) as any[]))
      if (!rows.length) break
      actual.push(...rows.map((r) => r.id))
      const last = rows.at(-1)!
      cursor = { cursor_date: String(last.__archive_date), cursor_key: String(last.__cursor_key) }
    }
    assert.deepEqual(actual, expected)
    assert.ok(cursor)
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + buildRetentionArchiveOnlyQuery(source, cursor))
      .all(...(retentionArchiveOnlyBinds(source, cutoff, cursor, 11) as any[])).map((r) => String(r.detail)).join('\n')
    assert.match(plan, /SEARCH e USING INDEX idx_paper_execution_events_date \(trade_date>\? AND trade_date<\?\)/)
  } finally { db.close() }
})

test('non-legacy sources keep the original query text and bind order', () => {
  const source = retentionR2PolicyConfig('research_runs_v1')!.sources.find((s) => s.datasetId === 'analysis_runs')!
  const cursor = { cursor_date: '2020-01-01', cursor_key: '7' }
  assert.doesNotMatch(buildRetentionArchiveOnlyQuery(source, cursor), />= \?/)
  assert.deepEqual(retentionArchiveOnlyBinds(source, '2020-02-01', cursor, 5), ['2020-02-01', '2020-01-01', '7', 5])
  assert.deepEqual(retentionArchiveOnlyBinds(source, '2020-02-01', null, 5), ['2020-02-01', 5])
})

async function runLegacy(legacy: DatabaseSync, ops: DatabaseSync, businessDate: string, log: Executed[]) {
  const r2 = memoryR2()
  const result = await runRetentionArchiveOnly({
    DB: d1(legacy, log), OPS_DB: d1(ops), MULTI_D1_ACTIVE_DOMAINS: 'ops', ARTIFACTS: r2,
  } as any, { businessDate, policyIds: ['legacy_hot_r2_v1'], limitPerDataset: 100 })
  return { result, r2 }
}

const cursorOf = (ops: DatabaseSync, dataset: string) => ({ ...ops.prepare(
  `SELECT cursor_date, cursor_key FROM data_retention_cursors WHERE policy_id='legacy_hot_r2_v1' AND dataset_id=?`,
).get(dataset) })

const screenerLoads = (log: Executed[]) => log.filter((e) => e.sql.includes('FROM screener_funnel_items i'))

test('a frozen legacy source parks its cursor at the cutoff and later runs read only newly crossing rows', async () => {
  const legacy = new DatabaseSync(':memory:')
  const ops = new DatabaseSync(':memory:')
  try {
    legacy.exec(LEGACY_DDL)
    ops.exec(OPS_DDL)
    // 2026-05-01 holds an obsolete run; 2026-05-02 has only its latest run.
    seedScreener(legacy, '2026-05-01', [
      { id: 'obsolete', status: 'success', created: '2026-05-01 09:00', items: 3 },
      { id: 'latest', status: 'success', created: '2026-05-01 10:00', items: 40 },
    ])
    seedScreener(legacy, '2026-05-02', [{ id: 'kept', status: 'success', created: '2026-05-02 09:00', items: 40 }])
    // Exactly on the first cutoff (2026-06-01 - 30 days = 2026-05-02): must survive the watermark.
    seedScreener(legacy, '2026-05-02', [{ id: 'on-cutoff-old', status: 'success', created: '2026-05-02 08:00', items: 2 }])

    const first = await runLegacy(legacy, ops, '2026-06-01', [])
    assert.equal(first.result.status, 'success')
    const firstPolicy = first.result.policies[0]
    assert.equal(firstPolicy.archived_rows, 3)
    assert.deepEqual(cursorOf(ops, 'obsolete_screener_items'), { cursor_date: '2026-05-02', cursor_key: '0' })
    // Sources with nothing eligible also stop re-reading their history.
    assert.deepEqual(cursorOf(ops, 'superseded_pending_events'), { cursor_date: '2026-05-02', cursor_key: '0' })

    const secondLog: Executed[] = []
    const second = await runLegacy(legacy, ops, '2026-06-01', secondLog)
    assert.equal(second.result.policies[0].archived_rows, 0)
    const [load] = screenerLoads(secondLog)
    assert.deepEqual(load.args, ['2026-05-02', '2026-05-02', '2026-05-02', '0', 100])
    const rangeRows = legacy.prepare('SELECT COUNT(*) AS n FROM screener_funnel_items WHERE date >= ? AND date < ?').get('2026-05-02', '2026-05-02') as { n: number }
    assert.equal(rangeRows.n, 0)

    // The cutoff moves one day: the rows dated exactly on the old cutoff are judged now.
    const third = await runLegacy(legacy, ops, '2026-06-02', [])
    assert.equal(third.result.policies[0].archived_rows, 2)
    const archived = [...third.r2.objects.values()].map((body) => JSON.parse(body).payload.rows.map((r: any) => r.run_id)).flat()
    assert.deepEqual(archived, ['on-cutoff-old', 'on-cutoff-old'])
    assert.deepEqual(cursorOf(ops, 'obsolete_screener_items'), { cursor_date: '2026-05-03', cursor_key: '0' })
  } finally { legacy.close(); ops.close() }
})

test('without a full legacy writer cutover the cursor keeps its archived-row meaning', async () => {
  const legacy = new DatabaseSync(':memory:')
  const ops = new DatabaseSync(':memory:')
  try {
    legacy.exec(LEGACY_DDL)
    legacy.exec(`UPDATE data_domain_writer_epochs SET writer_state='open' WHERE domain='paper'`)
    ops.exec(OPS_DDL)
    seedScreener(legacy, '2026-05-01', [
      { id: 'obsolete', status: 'success', created: '2026-05-01 09:00', items: 3 },
      { id: 'latest', status: 'success', created: '2026-05-01 10:00', items: 4 },
    ])
    const { result } = await runLegacy(legacy, ops, '2026-06-01', [])
    assert.equal(result.policies[0].archived_rows, 3)
    const lastObsolete = legacy.prepare(`SELECT MAX(id) AS id FROM screener_funnel_items WHERE run_id='obsolete'`).get() as { id: number }
    assert.deepEqual(cursorOf(ops, 'obsolete_screener_items'), { cursor_date: '2026-05-01', cursor_key: String(lastObsolete.id) })
    assert.deepEqual(cursorOf(ops, 'superseded_pending_events'), { cursor_date: null, cursor_key: null })
  } finally { legacy.close(); ops.close() }
})
