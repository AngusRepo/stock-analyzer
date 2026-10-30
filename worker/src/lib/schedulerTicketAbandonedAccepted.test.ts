import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { Miniflare } from 'miniflare'
import { createAdminTriggerRoutes } from '../routes/adminTriggerRoutes'
import {
  admitSchedulerExecutionTicket,
  failAcceptedSchedulerTicket,
  schedulerDeliveryIdentity,
  updateSchedulerExecutionTicket,
} from './schedulerExecutionTickets'

// FU1: 10/23 23:55Z the active8-oof-daily watchdog delivery ended (Scheduler code 14) after admission
// and before execution; its ticket stayed `accepted` with started_at NULL and showed as running.
const migration = fs.readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8')
const identity = (scheduledAt: string) => schedulerDeliveryIdentity(new Headers({
  'X-CloudScheduler-JobName': 'projects/stockvision/locations/asia-east1/jobs/active8-oof-daily-watchdog',
  'X-CloudScheduler-ScheduleTime': scheduledAt,
}))

async function withDb(run: (db: D1Database) => Promise<void>): Promise<void> {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['OPS'] })
  try {
    const db = await mf.getD1Database('OPS')
    for (const statement of migration.replace(/^--.*$/gm, '').split(';').map((sql) => sql.trim()).filter(Boolean)) {
      await db.prepare(statement).run()
    }
    await run(db as unknown as D1Database)
  } finally {
    await mf.dispose()
  }
}

const admit = (db: D1Database, scheduledAt: string, n = 0) => admitSchedulerExecutionTicket(db, {
  identity: identity(scheduledAt), task: 'active8-oof-daily', requestedRunDate: '2026-10-23', proposedRunId: `run-${scheduledAt}-${n}`,
})
const age = (db: D1Database, ticketId: string, seconds: number) => db.prepare(
  `UPDATE scheduler_execution_tickets_v1 SET accepted_at=datetime('now', ?) WHERE ticket_id=?`,
).bind(`-${seconds} seconds`, ticketId).run()
const read = (db: D1Database, ticketId: string) => db.prepare(
  'SELECT * FROM scheduler_execution_tickets_v1 WHERE ticket_id=?',
).bind(ticketId).first<Record<string, any>>()

test('FU1: a gate failure settles only a still-accepted ticket as error, and the same delivery can retry', async () => {
  await withDb(async (db) => {
    const first = await admit(db, '2026-10-23T23:55:05Z')
    const ticket = first.ticket
    assert.equal(await failAcceptedSchedulerTicket(db, { ticketId: ticket.ticket_id, runId: ticket.run_id, error: 'D1_ERROR: network' }), true)
    const settled = await read(db, ticket.ticket_id)
    assert.equal(settled?.status, 'error')
    assert.equal(settled?.started_at, null)
    assert.match(String(settled?.last_summary), /pre-execution gate failed: D1_ERROR/)
    const retry = await admit(db, '2026-10-23T23:55:05Z', 1)
    assert.equal(retry.reason, 'retry_admitted')
    await updateSchedulerExecutionTicket(db, { ticketId: ticket.ticket_id, runId: ticket.run_id, status: 'running', authority: 'scheduler_http' })
    // A started ticket is never rewritten by the gate-failure path.
    assert.equal(await failAcceptedSchedulerTicket(db, { ticketId: ticket.ticket_id, runId: ticket.run_id, error: 'late' }), false)
    assert.equal((await read(db, ticket.ticket_id))?.status, 'running')
  })
})

test('FU1: a retried delivery re-admits an abandoned accepted ticket within the attempt budget, then settles it', async () => {
  await withDb(async (db) => {
    const { ticket } = await admit(db, '2026-10-23T23:55:05Z')
    const inflight = await admit(db, '2026-10-23T23:55:05Z', 1)
    assert.equal(inflight.reason, 'duplicate_inflight') // a live request is not stolen
    for (const attempt of [2, 3]) {
      await age(db, ticket.ticket_id, 301)
      const retry = await admit(db, '2026-10-23T23:55:05Z', attempt)
      assert.equal(retry.reason, 'retry_admitted')
      assert.equal(retry.ticket.attempt_count, attempt)
    }
    await age(db, ticket.ticket_id, 301)
    const exhausted = await admit(db, '2026-10-23T23:55:05Z', 4)
    assert.equal(exhausted.shouldExecute, false)
    assert.equal(exhausted.reason, 'attempt_limit')
    assert.equal(exhausted.ticket.status, 'error')
    assert.equal(exhausted.ticket.last_error, 'abandoned_before_execution')
  })
})

test('FU1: the next delivery of the task closes older abandoned accepted tickets, never live or started ones', async () => {
  await withDb(async (db) => {
    const abandoned = (await admit(db, '2026-10-23T23:55:05Z')).ticket
    const fresh = (await admit(db, '2026-10-23T23:25:05Z')).ticket
    const started = (await admit(db, '2026-10-23T22:25:05Z')).ticket
    await updateSchedulerExecutionTicket(db, { ticketId: started.ticket_id, runId: started.run_id, status: 'running', authority: 'scheduler_http' })
    for (const row of [abandoned, started]) await age(db, row.ticket_id, 600)
    await age(db, fresh.ticket_id, 120)
    const before = await read(db, abandoned.ticket_id)
    const next = await admit(db, '2026-10-24T00:25:05Z')
    assert.equal(next.reason, 'admitted')
    const abandonedRow = await read(db, abandoned.ticket_id)
    assert.equal(abandonedRow?.status, 'error')
    assert.equal(abandonedRow?.last_error, 'abandoned_before_execution')
    assert.ok(abandonedRow?.completed_at)
    assert.equal(abandonedRow?.updated_at, before?.updated_at) // the new delivery stays the latest ticket
    assert.equal((await read(db, fresh.ticket_id))?.status, 'accepted')
    assert.equal((await read(db, started.ticket_id))?.status, 'running')
  })
})

test('FU1: a gate that throws after admission settles the ticket as error and keeps the error response', async () => {
  const routes = createAdminTriggerRoutes({ buildTaskMap: () => ({ 'weekly-backtest': async () => 'unexpected execution' }) })
  const sql = new DatabaseSync(':memory:')
  sql.exec(migration)
  const ops = { prepare(query: string) {
    let args: any[] = []
    const statement = { bind(...values: any[]) { args = values; return statement },
      async first() { return sql.prepare(query).get(...args) ?? null },
      async all() { return { results: sql.prepare(query).all(...args), meta: {} } },
      async run() { return { success: true, meta: { changes: Number(sql.prepare(query).run(...args).changes) } } } }
    return statement
  } }
  const kv = {
    async get(key: string) { if (key.startsWith('ratelimit:')) throw new Error('KV GET failed: 503'); return null },
    async put() {},
  }
  const env = { LOCAL_AUTH_BYPASS: '1', ENVIRONMENT: 'test', KV: kv, OPS_DB: ops, MULTI_D1_ACTIVE_DOMAINS: 'ops' } as any
  const response = await routes.request('https://stockvision.invalid/api/admin/trigger/weekly-backtest?sync=1',
    { method: 'POST' }, env)
  assert.equal(response.status, 500)
  const rows = sql.prepare('SELECT status, started_at, last_error FROM scheduler_execution_tickets_v1').all() as any[]
  sql.close()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'error')
  assert.equal(rows[0].started_at, null)
  assert.match(String(rows[0].last_error), /KV GET failed: 503/)
})

test('FU1: the route records the admitted ticket only after it owns the delivery', () => {
  const route = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
  const handler = route.slice(route.indexOf('const handleTrigger = async'))
  const ownership = handler.indexOf('if (!ticketAdmission.shouldExecute)')
  const recordIndex = handler.indexOf('Object.assign(admitted, { db: ticketDb, ticketId: schedulerTicketId, runId: executionRunId })')
  const firstGateIndex = handler.indexOf('const rlCount = parseInt(')
  assert(ownership > 0 && ownership < recordIndex && recordIndex < firstGateIndex)
})
