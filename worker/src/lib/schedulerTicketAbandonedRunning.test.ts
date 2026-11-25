import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createAdminTriggerRoutes } from '../routes/adminTriggerRoutes'
import {
  admitSchedulerExecutionTicket,
  failStartedSchedulerTicket,
  schedulerDeliveryIdentity,
  schedulerHttpResultTicketStatus,
  SYNC_EXECUTION_STARTED_SUMMARY,
  updateSchedulerExecutionTicket,
} from './schedulerExecutionTickets'
import {
  isFinalRetentionArchiveTick,
  retentionArchiveDayStarved,
  retentionArchiveFinalTickUtc,
} from './retentionArchiveDailyGuarantee'

// 11/23 17:00–22:30Z: five screener-v2-watchdog sync deliveries answered 500 after their own error
// settle failed, and 39 more ticks settled `running` for a screener lease another owner held. None of
// those tickets had a writer left, so they stayed running forever.
const migration = fs.readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8')

type Hook = (query: string, args: any[]) => void
function sqliteOps(hook?: { before?: Hook; after?: Hook }) {
  const sql = new DatabaseSync(':memory:')
  sql.exec(migration)
  const db = { prepare(query: string) {
    let args: any[] = []
    const statement = { bind(...values: any[]) { args = values; return statement },
      async first() { return sql.prepare(query).get(...args) ?? null },
      async all() { return { results: sql.prepare(query).all(...args), meta: {} } },
      async run() {
        hook?.before?.(query, args)
        const changes = Number(sql.prepare(query).run(...args).changes)
        hook?.after?.(query, args)
        return { success: true, meta: { changes } }
      } }
    return statement
  } } as unknown as D1Database
  return { sql, db }
}

const identity = (job: string, scheduledAt: string) => schedulerDeliveryIdentity(new Headers({
  'X-CloudScheduler-JobName': `projects/stockvision/locations/asia-east1/jobs/${job}`,
  'X-CloudScheduler-ScheduleTime': scheduledAt,
}))
const admit = (db: D1Database, job: string, scheduledAt: string, date = '2026-11-23') => admitSchedulerExecutionTicket(db, {
  identity: identity(job, scheduledAt), task: job, requestedRunDate: date, proposedRunId: `${job}-${scheduledAt}`,
})
const start = (db: D1Database, ticket: { ticket_id: string; run_id: string }, summary = SYNC_EXECUTION_STARTED_SUMMARY) =>
  updateSchedulerExecutionTicket(db, { ticketId: ticket.ticket_id, runId: ticket.run_id, status: 'running', authority: 'scheduler_http', summary })
const read = (sql: DatabaseSync, ticketId: string) =>
  sql.prepare('SELECT * FROM scheduler_execution_tickets_v1 WHERE ticket_id=?').get(ticketId) as Record<string, any>
const ageStart = (sql: DatabaseSync, ticketId: string, seconds: number) =>
  sql.prepare(`UPDATE scheduler_execution_tickets_v1 SET started_at=datetime('now', ?) WHERE ticket_id=?`).run(`-${seconds} seconds`, ticketId)

test('an observer tick reporting a lease another owner holds settles as skipped; other running results are unchanged', () => {
  assert.equal(schedulerHttpResultTicketStatus('screener-v2-watchdog', 'running'), 'skipped')
  assert.equal(schedulerHttpResultTicketStatus('screener-v2-watchdog', 'error'), 'error')
  assert.equal(schedulerHttpResultTicketStatus('screener-v2-watchdog', 'waiting'), 'queued')
  // The evening-chain root ticket is closed later by eveningChainRootClosure (running -> success|error).
  assert.equal(schedulerHttpResultTicketStatus('evening-chain', 'running'), 'running')
})

test('a throw after the sync start settles only its own still-started ticket', async () => {
  const { sql, db } = sqliteOps()
  const started = (await admit(db, 'screener-v2-watchdog', '2026-11-23T17:00:05Z')).ticket
  await start(db, started)
  const waiting = (await admit(db, 'evening-chain', '2026-11-23T13:45:00Z')).ticket
  await start(db, waiting, 'running: 21:00 evening-chain waiting at source')
  assert.equal(await failStartedSchedulerTicket(db, { ticketId: started.ticket_id, runId: started.run_id, error: 'D1_ERROR: overloaded' }), true)
  assert.equal(await failStartedSchedulerTicket(db, { ticketId: waiting.ticket_id, runId: waiting.run_id, error: 'late' }), false)
  assert.equal(await failStartedSchedulerTicket(db, { ticketId: started.ticket_id, runId: 'other-run', error: 'late' }), false)
  const row = read(sql, started.ticket_id)
  assert.equal(row.status, 'error')
  assert.match(String(row.last_summary), /^escaped_after_start: D1_ERROR: overloaded/)
  assert.ok(row.completed_at)
  assert.equal(read(sql, waiting.ticket_id).status, 'running')
  sql.close()
})

test('the next delivery closes stale sync-started tickets of its task, never live, manual, other-owner or other-task ones', async () => {
  const { sql, db } = sqliteOps()
  const job = 'screener-v2-watchdog'
  const stale = (await admit(db, job, '2026-11-23T17:00:05Z')).ticket
  const fresh = (await admit(db, job, '2026-11-23T17:30:05Z')).ticket
  const otherOwner = (await admit(db, job, '2026-11-23T16:00:05Z')).ticket
  const oldDate = (await admit(db, job, '2026-11-10T16:00:05Z', '2026-11-10')).ticket
  const otherTask = (await admit(db, 'intraday-check', '2026-11-23T03:24:05Z')).ticket
  const manual = (await admitSchedulerExecutionTicket(db, {
    identity: schedulerDeliveryIdentity(new Headers()), task: job, requestedRunDate: '2026-11-23', proposedRunId: 'manual-run',
  })).ticket
  for (const row of [stale, fresh, oldDate, otherTask, manual]) await start(db, row)
  await start(db, otherOwner, 'running: closed later by its owner')
  for (const row of [stale, otherOwner, oldDate, otherTask, manual]) ageStart(sql, row.ticket_id, 1_500)
  ageStart(sql, fresh.ticket_id, 600)

  const next = await admit(db, job, '2026-11-23T18:00:05Z')
  assert.equal(next.reason, 'admitted')
  const staleRow = read(sql, stale.ticket_id)
  assert.equal(staleRow.status, 'error')
  assert.equal(staleRow.last_error, 'abandoned_while_running')
  assert.ok(staleRow.completed_at)
  for (const row of [fresh, otherOwner, otherTask, manual]) assert.equal(read(sql, row.ticket_id).status, 'running')
  // Outside the 7-day lookback: left to the one-time audited cleanup.
  assert.equal(read(sql, oldDate.ticket_id).status, 'running')
  sql.close()
})

test('the sweep and the retention guarantee read through indexes, never a table scan', () => {
  const { sql } = sqliteOps()
  const sweep = fs.readFileSync('src/lib/schedulerExecutionTickets.ts', 'utf8')
    .match(/async function settleAbandonedRunningTickets[\s\S]*?`([\s\S]*?)`/)![1]
  const guarantee = fs.readFileSync('src/lib/retentionArchiveDailyGuarantee.ts', 'utf8')
    .match(/const success = await db\.prepare\(`([\s\S]*?)`/)![1]
  const plan = (query: string, args: any[]) => (sql.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args) as any[])
    .map((row) => String(row.detail)).join(' | ')
  const sweepPlan = plan(sweep, ['s', 'e', '2026-11-23', '-7 days', '2026-11-23', 'screener-v2-watchdog', 'x', '-1200 seconds'])
  assert.match(sweepPlan, /USING INDEX idx_scheduler_execution_tickets_status \(status=\? AND business_date>\? AND business_date<\?\)/)
  const guaranteePlan = plan(guarantee, ['retention-archive-only', '2026-11-24'])
  assert.match(guaranteePlan, /USING INDEX idx_scheduler_execution_tickets_(job_date|status)/)
  for (const detail of [sweepPlan, guaranteePlan]) assert.doesNotMatch(detail, /\bSCAN scheduler_execution_tickets_v1\b/)
  sql.close()
})

test('the retention window final tick comes from the manifest (22:52 UTC)', () => {
  assert.deepEqual(retentionArchiveFinalTickUtc(), { hour: 22, minute: 52 })
  assert.equal(isFinalRetentionArchiveTick('2026-11-23T22:52:00.164Z'), true)
  assert.equal(isFinalRetentionArchiveTick('2026-11-23T22:37:00.164Z'), false)
  assert.equal(isFinalRetentionArchiveTick(null), false)
  assert.throws(() => retentionArchiveFinalTickUtc({ timeZone: 'UTC', jobs: [{ id: 'retention-archive-only', schedule: '*/15 18-22 * * *' }] }),
    /retention_archive_window_invalid/)
})

test('a busy retention tick fails only on the final tick of a business date with no successful archive', async () => {
  const { sql, db } = sqliteOps()
  const job = 'retention-archive-only'
  const early = (await admit(db, job, '2026-11-23T18:07:00.164Z', '2026-11-24')).ticket
  const final = (await admit(db, job, '2026-11-23T22:52:00.164Z', '2026-11-24')).ticket
  assert.equal(await retentionArchiveDayStarved(db, early.ticket_id), false)
  assert.equal(await retentionArchiveDayStarved(db, undefined), false)
  assert.equal(await retentionArchiveDayStarved(db, final.ticket_id), true)
  await start(db, early)
  await updateSchedulerExecutionTicket(db, { ticketId: early.ticket_id, runId: early.run_id, status: 'success', authority: 'scheduler_http' })
  assert.equal(await retentionArchiveDayStarved(db, final.ticket_id), false)
  sql.close()
})

const env = (db: D1Database) => ({
  LOCAL_AUTH_BYPASS: '1', ENVIRONMENT: 'test', OPS_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops',
  // Capacity probe (size_after) and other legacy reads see an empty, near-zero-size database.
  DB: { prepare() {
    const statement = { bind: () => statement, first: async () => null,
      all: async () => ({ results: [], meta: { size_after: 0 } }), run: async () => ({ success: true, meta: { changes: 0 } }) }
    return statement
  } },
  KV: { async get() { return null }, async put() {} },
}) as any
const sync = (routes: ReturnType<typeof createAdminTriggerRoutes>, db: D1Database) =>
  routes.request('https://stockvision.invalid/api/admin/trigger/weekly-backtest?force=1&sync=1', { method: 'POST' }, env(db))

test('a failed error settle keeps the execution error response and leaves the ticket to the abandoned-running sweep', async () => {
  const routes = createAdminTriggerRoutes({ buildTaskMap: () => ({ 'weekly-backtest': async () => { throw new Error('D1_ERROR: overloaded') } }) })
  const { sql, db } = sqliteOps({ before(query, args) {
    if (query.includes('SET status=?, status_authority=?') && args[0] === 'error') throw new Error('D1_ERROR: settle write lost')
  } })
  const errors: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => { errors.push(args) }
  try {
    const response = await sync(routes, db)
    assert.equal(response.status, 500)
    assert.match(JSON.stringify(await response.json()), /D1_ERROR: overloaded/)
  } finally {
    console.error = original
  }
  const rows = sql.prepare('SELECT status, last_summary FROM scheduler_execution_tickets_v1').all() as any[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'running')
  assert.equal(rows[0].last_summary, SYNC_EXECUTION_STARTED_SUMMARY)
  assert.ok(errors.some((args) => String(args[0]).includes('error settle failed')))
  sql.close()
})

test('a throw after the running write is settled by the route guard instead of staying running', async () => {
  const routes = createAdminTriggerRoutes({ buildTaskMap: () => ({ 'weekly-backtest': async () => 'unreachable' }) })
  const { sql, db } = sqliteOps({ after(query, args) {
    if (query.includes('SET status=?, status_authority=?') && args[0] === 'running') throw new Error('D1_ERROR: network lost after commit')
  } })
  const original = console.error
  console.error = () => {}
  try {
    const response = await sync(routes, db)
    assert.equal(response.status, 500)
  } finally {
    console.error = original
  }
  const rows = sql.prepare('SELECT status, last_summary, last_error FROM scheduler_execution_tickets_v1').all() as any[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'error')
  assert.match(String(rows[0].last_summary), /^escaped_after_start: D1_ERROR: network lost after commit/)
  sql.close()
})

test('a sync watchdog tick that only observed the screener lease closes its ticket as skipped', async () => {
  const routes = createAdminTriggerRoutes({ buildTaskMap: () => ({
    'screener-v2-watchdog': async () => 'status=running screener={running screener watchdog reason=active_lease attempt=1} strategy_learning={SKIPPED none}',
  }) })
  const { sql, db } = sqliteOps()
  const response = await routes.request('https://stockvision.invalid/api/admin/trigger/screener-v2-watchdog?force=1&sync=1',
    { method: 'POST' }, env(db))
  assert.equal(response.status, 200)
  const rows = sql.prepare('SELECT status, completed_at, last_summary FROM scheduler_execution_tickets_v1').all() as any[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'skipped')
  assert.ok(rows[0].completed_at)
  assert.match(String(rows[0].last_summary), /reason=active_lease/)
  sql.close()
})

test('a Scheduler retry of a delivery whose settle write was lost re-runs it instead of answering duplicate_inflight', async () => {
  const { sql, db } = sqliteOps()
  const job = 'market-close-refresh'
  const first = (await admit(db, job, '2026-11-23T10:10:00Z')).ticket
  await start(db, first)
  // A near-simultaneous duplicate delivery still sees a live attempt.
  assert.equal((await admit(db, job, '2026-11-23T10:10:00Z')).reason, 'duplicate_inflight')
  for (const attempt of [2, 3]) {
    ageStart(sql, first.ticket_id, 120)
    const retry = await admit(db, job, '2026-11-23T10:10:00Z')
    assert.equal(retry.reason, 'retry_admitted')
    assert.equal(retry.ticket.attempt_count, attempt)
    assert.equal(retry.ticket.status, 'accepted')
    await start(db, retry.ticket)
  }
  ageStart(sql, first.ticket_id, 120)
  const exhausted = await admit(db, job, '2026-11-23T10:10:00Z')
  assert.equal(exhausted.shouldExecute, false)
  assert.equal(exhausted.reason, 'attempt_limit')
  assert.equal(exhausted.ticket.status, 'error')
  assert.equal(exhausted.ticket.last_error, 'abandoned_while_running')
  // A start marker replaced by any settle is never re-admitted.
  const settled = (await admit(db, job, '2026-11-24T10:10:00Z', '2026-11-24')).ticket
  await start(db, settled, 'running: owned elsewhere')
  ageStart(sql, settled.ticket_id, 120)
  assert.equal((await admit(db, job, '2026-11-24T10:10:00Z', '2026-11-24')).reason, 'duplicate_inflight')
  sql.close()
})

test('the owner real terminal result replaces an abandoned-while-running presumption, never another error', async () => {
  const { sql, db } = sqliteOps()
  const job = 'active8-oof-daily'
  const swept = (await admit(db, job, '2026-11-23T17:55:05Z')).ticket
  await start(db, swept)
  ageStart(sql, swept.ticket_id, 1_500)
  await admit(db, job, '2026-11-23T18:25:05Z')
  assert.equal(read(sql, swept.ticket_id).last_error, 'abandoned_while_running')
  const closed = await updateSchedulerExecutionTicket(db, {
    ticketId: swept.ticket_id, runId: swept.run_id, status: 'success', authority: 'scheduler_http', summary: 'callback success',
  })
  assert.equal(closed.status, 'success')
  assert.equal(closed.last_error, null)

  const failed = (await admit(db, job, '2026-11-23T19:25:05Z')).ticket
  await start(db, failed)
  await updateSchedulerExecutionTicket(db, { ticketId: failed.ticket_id, runId: failed.run_id, status: 'error', authority: 'scheduler_http', error: 'real failure' })
  await assert.rejects(updateSchedulerExecutionTicket(db, {
    ticketId: failed.ticket_id, runId: failed.run_id, status: 'success', authority: 'scheduler_http',
  }), /transition rejected/)
  assert.equal(read(sql, failed.ticket_id).last_error, 'real failure')
  sql.close()
})
