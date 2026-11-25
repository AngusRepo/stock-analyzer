import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { loadLatestSchedulerRootTicket, loadLatestSchedulerRootTickets, loadSchedulerExecutionTickets } from './schedulerExecutionTickets'

// ops 0028: the 7-day scheduler status reads seek the business_date index instead of scanning the
// ticket table, and the existing job/status index reads keep their plans. Rows are Miniflare D1 meta.rows_read.
const MIGRATION = '0028_scheduler_ticket_business_date_index.sql'
const DAYS = 60
const PER_DAY = 50

function opsSchema(withIndex: boolean): string[] {
  const sql = new DatabaseSync(':memory:')
  const dir = 'domain-migrations/ops/'
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.sql') && (withIndex || name !== MIGRATION)).sort()) {
    sql.exec(fs.readFileSync(dir + file, 'utf8'))
  }
  const rows = sql.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as Array<{ sql: string }>
  sql.close()
  return rows.map((row) => row.sql)
}

const day = (index: number) => new Date(Date.UTC(2026, 10, 25) - index * 86_400_000).toISOString().slice(0, 10)
const WEEK = Array.from({ length: 7 }, (_, index) => day(index))

async function ticketDb(withIndex: boolean) {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['OPS_DB'] })
  const db = await mf.getD1Database('OPS_DB')
  for (const statement of opsSchema(withIndex)) await db.prepare(statement).run()
  const inserts = []
  for (let d = 0; d < DAYS; d++) {
    for (let index = 0; index < PER_DAY; index++) {
      const id = `t-${day(d)}-${index}`
      inserts.push(db.prepare(`INSERT INTO scheduler_execution_tickets_v1
        (ticket_id,dedupe_key,root_ticket_id,scheduler_job_id,task,business_date,run_id,attempt_id,ticket_kind,status,status_authority,payload_checksum,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'physical_root',?,'scheduler_http','x',?)`)
        .bind(id, `d-${id}`, id, `job-${index}`, `task-${index}`, day(d), `r-${id}`, `a-${id}`, index % 5 ? 'success' : 'error', `${day(d)}T10:${String(index).padStart(2, '0')}:00.000Z`))
    }
  }
  await db.batch(inserts)
  return { mf, db }
}

async function rowsRead(db: D1Database, run: (db: D1Database) => Promise<unknown>): Promise<number> {
  let rows = 0
  const wrap = (statement: any): any => ({
    bind: (...values: unknown[]) => wrap(statement.bind(...values)),
    all: async () => { const result = await statement.all(); rows += Number(result.meta?.rows_read ?? 0); return result },
    first: async () => { const result = await statement.all(); rows += Number(result.meta?.rows_read ?? 0); return result.results?.[0] ?? null },
  })
  await run({ prepare: (query: string) => wrap(db.prepare(query)) } as unknown as D1Database)
  return rows
}

async function plan(db: D1Database, query: string, ...binds: unknown[]): Promise<string> {
  const result = await db.prepare(`EXPLAIN QUERY PLAN ${query}`).bind(...binds).all<{ detail: string }>()
  return (result.results ?? []).map((row) => row.detail).join(' | ')
}

const WEEK_IN = WEEK.map(() => '?').join(', ')

test('ops 0028: 7-day scheduler status reads seek the business_date index', async () => {
  const before = await ticketDb(false)
  const after = await ticketDb(true)
  try {
    const readAll = (db: D1Database) => loadSchedulerExecutionTickets(db, WEEK)
    const readRoots = (db: D1Database) => loadLatestSchedulerRootTickets(db, WEEK)
    // Same rows in the same order (the two fixtures differ only in their default timestamps).
    const ids = async (rows: Promise<Array<{ ticket_id: string }>>) => (await rows).map((row) => row.ticket_id)
    assert.equal((await readAll(after.db)).length, WEEK.length * PER_DAY)
    assert.deepEqual(await ids(readAll(after.db)), await ids(readAll(before.db)))
    assert.deepEqual(await ids(readRoots(after.db)), await ids(readRoots(before.db)))

    const scanAll = await rowsRead(before.db, readAll)
    const seekAll = await rowsRead(after.db, readAll)
    const scanRoots = await rowsRead(before.db, readRoots)
    const seekRoots = await rowsRead(after.db, readRoots)
    assert.ok(scanAll >= DAYS * PER_DAY, `before: ${scanAll}`)
    // An index seek counts the index entry and the table row, so the bound is twice the window plus the seeks.
    const bound = 2 * WEEK.length * PER_DAY + 2 * WEEK.length
    assert.ok(seekAll <= bound, `after: ${seekAll}`)
    // The ranked read re-counts the window rows in its co-routines; the seek still halves it.
    assert.ok(seekRoots * 2 <= scanRoots, `roots after: ${seekRoots} (before ${scanRoots})`)
    console.log(`rows_read 7-day all: ${scanAll} -> ${seekAll}; roots: ${scanRoots} -> ${seekRoots}`)

    const allPlan = await plan(after.db, `SELECT * FROM scheduler_execution_tickets_v1 WHERE business_date IN (${WEEK_IN}) ORDER BY updated_at DESC, ticket_id DESC`, ...WEEK)
    assert.match(allPlan, /SEARCH scheduler_execution_tickets_v1 USING INDEX idx_scheduler_execution_tickets_business_date \(business_date=\?\)/)
    assert.doesNotMatch(allPlan, /SCAN scheduler_execution_tickets_v1/)
    const rootsPlan = await plan(after.db, `SELECT scheduler_job_id FROM scheduler_execution_tickets_v1 tickets WHERE scheduler_job_id IS NOT NULL AND business_date IN (${WEEK_IN})`, ...WEEK)
    assert.match(rootsPlan, /SEARCH tickets USING INDEX idx_scheduler_execution_tickets_business_date \(business_date=\?\)/)
  } finally {
    await before.mf.dispose()
    await after.mf.dispose()
  }
})

test('ops 0028: job and status index reads keep their plans', async () => {
  const { mf, db } = await ticketDb(true)
  try {
    assert.match(await plan(db, `SELECT * FROM scheduler_execution_tickets_v1 WHERE scheduler_job_id=? AND business_date=? AND ticket_kind='physical_root' ORDER BY updated_at DESC, ticket_id DESC LIMIT 1`, 'job-1', WEEK[0]),
      /USING INDEX idx_scheduler_execution_tickets_job_date \(scheduler_job_id=\? AND business_date=\?\)/)
    assert.match(await plan(db, `SELECT business_date, task FROM scheduler_execution_tickets_v1 WHERE status=? AND business_date>=? AND business_date<=?`, 'error', WEEK[6], WEEK[0]),
      /USING INDEX idx_scheduler_execution_tickets_status \(status=\? AND business_date>\? AND business_date<\?\)/)
    const root = await loadLatestSchedulerRootTicket(db, { schedulerJobId: 'job-1', businessDate: WEEK[0] })
    assert.equal(root?.ticket_id, `t-${WEEK[0]}-1`)
  } finally {
    await mf.dispose()
  }
})
