import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { buildAdminWorkerDomainTaskMap } from './adminTriggerWorkerDomainTasks'
import { DEBATE_MEMORY_RETENTION_DELETE_LIMIT } from './debateMemoryRetention'

function domainDb(domain: string) {
  const sqlite = new DatabaseSync(':memory:')
  const dir = new URL(`../../domain-migrations/${domain}/`, import.meta.url)
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), 'utf8'))
  }
  const statements: string[] = []
  const db = { prepare(sql: string) {
    statements.push(sql)
    let args: any[] = []
    const statement = { bind(...values: any[]) { args = values; return statement },
      async first() { return sqlite.prepare(sql).get(...args) ?? null },
      async all() { return { results: sqlite.prepare(sql).all(...args), success: true } },
      async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } } } }
    return statement
  } }
  return { sqlite, db, statements }
}

test('debate-memory-retention runs while audit-json holds the heavy lease, one bounded indexed delete per run', async () => {
  const paper = domainDb('paper'), ops = domainDb('ops')
  // audit-json-retention holds d1_heavy_maintenance (the 03:00 collision that skipped 11 of 14 nights).
  ops.sqlite.prepare(`INSERT INTO maintenance_task_leases(lease_group,task_name,owner_id,lease_expires_at,acquired_at,heartbeat_at)
    VALUES('d1_heavy_maintenance','audit-json-retention','audit-json-retention:x',datetime('now','+300 seconds'),CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run()
  const insert = paper.sqlite.prepare(`INSERT INTO debate_memory(symbol,debate_date,thesis_summary,direction,verdict,conviction_score,llm_source,created_at)
    VALUES(?,?,'t','neutral','APPROVE',50,'test',CURRENT_TIMESTAMP)`)
  const extra = 100
  for (let index = 0; index < DEBATE_MEMORY_RETENTION_DELETE_LIMIT + extra; index += 1) {
    insert.run(`S${index}`, `2020-01-${String(1 + (index % 28)).padStart(2, '0')}`)
  }
  insert.run('KEEP', paper.sqlite.prepare(`SELECT DATE('now','-179 days') AS d`).get()!.d as string)
  insert.run('KEEP', paper.sqlite.prepare(`SELECT DATE('now') AS d`).get()!.d as string)
  const env = { PAPER_DB: paper.db, OPS_DB: ops.db, MULTI_D1_ACTIVE_DOMAINS: 'ops,paper', MULTI_D1_STRICT: 'true' } as any
  const run = () => buildAdminWorkerDomainTaskMap({ env, req: { query: () => undefined, queries: () => undefined } }, {} as any)['debate-memory-retention']()

  const first = await run()
  assert.equal(first, `deleted=${DEBATE_MEMORY_RETENTION_DELETE_LIMIT} rows_read=0 capped_at=${DEBATE_MEMORY_RETENTION_DELETE_LIMIT}`)
  assert.doesNotMatch(String(first), /maintenance_lease_busy/)
  assert.equal(await run(), `deleted=${extra} rows_read=0`)
  assert.equal(await run(), 'deleted=0 rows_read=0')
  const left = paper.sqlite.prepare('SELECT symbol FROM debate_memory ORDER BY debate_date').all().map((row: any) => row.symbol)
  assert.deepEqual(left, ['KEEP', 'KEEP'])
  // The lease is neither taken nor released by the retention task.
  assert.equal(ops.statements.length, 0)
  assert.equal((ops.sqlite.prepare(`SELECT task_name FROM maintenance_task_leases WHERE lease_group='d1_heavy_maintenance'`).get() as any).task_name,
    'audit-json-retention')

  for (const sql of new Set(paper.statements)) {
    const params = (sql.match(/\?/g) ?? []).map((_, index) => index === 0 ? '-180 days' : 500)
    const plan = (paper.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(row => row.detail)
    assert.deepEqual(plan.filter(detail => /^SCAN /.test(detail)), [], `retention delete must not scan: ${plan.join(' | ')}`)
    assert.ok(plan.some(detail => /SEARCH debate_memory USING COVERING INDEX idx_debate_memory_date/.test(detail)), plan.join(' | '))
    assert.match(sql, /LIMIT \?/)
  }
})

test('debate-memory-retention is no longer a heavy-lease task; the heavy drains still are', () => {
  const admin = readFileSync(new URL('./adminTriggerWorkerDomainTasks.ts', import.meta.url), 'utf8')
  const start = admin.indexOf('const D1_HEAVY_MAINTENANCE_TASKS')
  const heavy = admin.slice(start, admin.indexOf('])', start))
  assert.doesNotMatch(heavy, /'debate-memory-retention'/)
  for (const task of ['audit-json-retention', 'retention-archive-only', 'retention-hot-window-drain', 'weekly-cleanup']) {
    assert.match(heavy, new RegExp(`'${task}'`))
  }
})
