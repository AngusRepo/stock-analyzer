import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { enqueueMaintenanceBacklogDrain, processMaintenanceBacklogDrain } from './maintenanceBacklogDrain'
import { admitSchedulerExecutionTicket, updateSchedulerExecutionTicket } from './schedulerExecutionTickets'
import { logSchedulerResult } from './schedulerRunLogger'
import { createAdminTriggerRoutes } from '../routes/adminTriggerRoutes'
import type { UpdateQueueMsg } from '../types'

const activeKey = 'maintenance:backlog-drain:audit-json-retention:active'
const failureKey = 'maintenance:backlog-drain:audit-json-retention:failure'
const options = { targets: ['invalid_fixture_target'], retentionDays: 90, limitPerTable: 1, minBlobBytes: 1024 }
const openWindow = new Date('2026-09-29T17:05:00Z')

function fixture() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8'))
  sql.exec('CREATE TABLE maintenance_task_leases(lease_group TEXT PRIMARY KEY, task_name TEXT, owner_id TEXT, lease_expires_at TEXT, acquired_at TEXT, heartbeat_at TEXT)')
  const db = { prepare(query: string) {
    let args: any[] = []
    const statement = { bind(...values: any[]) { args = values; return statement },
      async first() { return sql.prepare(query).get(...args) ?? null },
      async all() { return { results: sql.prepare(query).all(...args), meta: { size_after: 0 } } },
      async run() { return { success: true, meta: { changes: Number(sql.prepare(query).run(...args).changes) } } },
    }
    return statement
  } }
  const values = new Map<string, string>()
  const messages: UpdateQueueMsg[] = []
  const env = { DB: db, OPS_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops', LOCAL_AUTH_BYPASS: '1', ENVIRONMENT: 'test', CF_VERSION_METADATA: { id: 'version-a' },
    KV: { async get(key: string, type?: string) { const v = values.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v },
      async put(key: string, value: string) { values.set(key, value) }, async delete(key: string) { values.delete(key) } },
    UPDATE_QUEUE: { async send(message: UpdateQueueMsg) { messages.push(message) } },
  } as any
  async function enqueue(runId = 'audit-run-1') {
    const { ticket } = await admitSchedulerExecutionTicket(db as any, {
      identity: { schedulerJobId: null, scheduledAt: null, ticketKind: 'manual' },
      task: 'audit-json-retention', requestedRunDate: '2026-09-29', proposedRunId: runId,
    })
    await enqueueMaintenanceBacklogDrain(env, { task: 'audit-json-retention', runDate: ticket.business_date, runId,
      schedulerTicketId: ticket.ticket_id, schedulerRunId: runId, auditJsonOptions: options })
    return ticket
  }
  const ticketRow = (id: string) => sql.prepare('SELECT * FROM scheduler_execution_tickets_v1 WHERE ticket_id=?').get(id)!
  return { sql, db, values, messages, env, enqueue, ticketRow }
}

test('chunk errors retry boundedly under one ticket, then expose terminal error and cooldown', async () => {
  const f = fixture()
  try {
    const ticket = await f.enqueue()
    for (let failure = 0; failure < 3; failure++) {
      const msg = f.messages[failure]
      assert.equal(msg.schedulerTicketId, ticket.ticket_id)
      assert.equal(msg.schedulerRunId, ticket.run_id)
      await processMaintenanceBacklogDrain(f.env, msg, openWindow)
      assert.equal(f.ticketRow(ticket.ticket_id).status, failure < 2 ? 'running' : 'error')
    }
    assert.equal(f.messages.length, 3)
    assert.equal(f.values.has(activeKey), false)
    const receipt = JSON.parse(f.values.get(`${failureKey}:${ticket.run_id}`)!)
    assert.match(receipt.error, /audit_json_durable_unknown_target/)
    assert.equal(receipt.worker_version, 'version-a')
    const terminal = { ...f.ticketRow(ticket.ticket_id) }
    await processMaintenanceBacklogDrain(f.env, f.messages[2], openWindow)
    assert.deepEqual({ ...f.ticketRow(ticket.ticket_id) }, terminal)
    const next = await enqueueMaintenanceBacklogDrain(f.env, { task: 'audit-json-retention', runDate: '2026-09-29', runId: 'next-slot', auditJsonOptions: options })
    assert.deepEqual(next, { queued: false, runId: ticket.run_id, reason: 'failure_cooldown' })
    assert.equal(f.messages.length, 3)
    f.env.CF_VERSION_METADATA.id = 'version-b'
    const repaired = await f.enqueue('audit-run-new-version')
    assert.equal(f.messages.length, 4)
    assert.equal(f.ticketRow(repaired.ticket_id).status, 'running')
    assert.equal(JSON.parse(f.values.get(`${failureKey}:${ticket.run_id}`)!).worker_version, 'version-a')
  } finally { f.sql.close() }
})

test('stale delivery never deletes or overwrites a successor active owner', async () => {
  const f = fixture()
  try {
    const oldTicket = await f.enqueue()
    f.values.set(activeKey, 'new-active-owner')
    await processMaintenanceBacklogDrain(f.env, f.messages[0], new Date('2026-09-29T23:00:00Z'))
    assert.equal(f.values.get(activeKey), 'new-active-owner')
    assert.equal(f.messages.length, 1)
    assert.equal(f.ticketRow(oldTicket.ticket_id).status, 'skipped')
    assert.match(String(f.ticketRow(oldTicket.ticket_id).last_summary), /owner_superseded/)
    assert.equal(f.values.has(failureKey), false)
  } finally { f.sql.close() }
})

for (const status of ['success', 'skipped'] as const) for (const failedPhase of ['active_release', 'terminal_log'] as const) {
  test(`${status} redelivery repairs the same run after ${failedPhase} interruption`, async () => {
    const f = fixture()
    try {
      const ticket = await f.enqueue()
      const summary = `actual durable ${status}`
      await updateSchedulerExecutionTicket(f.db as any, { ticketId: ticket.ticket_id, runId: ticket.run_id,
        status, authority: 'durable_queue', summary })
      const terminalBefore = { ...f.ticketRow(ticket.ticket_id) }
      const originalPut = f.env.KV.put
      const originalDelete = f.env.KV.delete
      let injected = false
      f.env.KV.put = async (key: string, value: string) => {
        if (!injected && failedPhase === 'terminal_log' && key.startsWith('scheduler:run:audit-json-retention:')) {
          injected = true
          throw new Error('terminal_log_interrupted')
        }
        return originalPut(key, value)
      }
      f.env.KV.delete = async (key: string) => {
        if (!injected && failedPhase === 'active_release' && key === activeKey) {
          injected = true
          throw new Error('active_release_interrupted')
        }
        return originalDelete(key)
      }
      await assert.rejects(processMaintenanceBacklogDrain(f.env, f.messages[0], openWindow), new RegExp(`${failedPhase}_interrupted`))
      await processMaintenanceBacklogDrain(f.env, f.messages[0], openWindow)
      for (const key of [`scheduler:run:audit-json-retention:${ticket.business_date}`, `cron:log:audit-json-retention:${ticket.business_date}`]) {
        const log = JSON.parse(f.values.get(key)!)
        assert.equal(log.status, status)
        assert.equal(log.run_id, ticket.run_id)
        assert.equal(log.summary, summary)
      }
      assert.equal(JSON.parse(f.values.get(`scheduler:run:daily:${ticket.business_date}`)!)['audit-json-retention'].status, status)
      assert.equal(f.values.has(activeKey), false)
      assert.deepEqual({ ...f.ticketRow(ticket.ticket_id) }, terminalBefore)
      assert.equal(f.messages.length, 1, 'terminal recovery must never restart the chunk')
    } finally { f.sql.close() }
  })
}

for (const status of ['success', 'skipped'] as const) {
  test(`${status} terminal repair preserves a newer visible run`, async () => {
    const f = fixture()
    try {
      const ticket = await f.enqueue()
      await updateSchedulerExecutionTicket(f.db as any, { ticketId: ticket.ticket_id, runId: ticket.run_id,
        status, authority: 'durable_queue', summary: 'older terminal' })
      await logSchedulerResult(f.env.KV, 'audit-json-retention', { status: 'running', summary: 'new owner is running',
        duration_ms: 0, run_id: 'newer-run', run_date: ticket.business_date })
      const keys = [`scheduler:run:audit-json-retention:${ticket.business_date}`, `cron:log:audit-json-retention:${ticket.business_date}`, `scheduler:run:daily:${ticket.business_date}`]
      const visibleBefore = keys.map(key => f.values.get(key))
      await processMaintenanceBacklogDrain(f.env, f.messages[0], openWindow)
      assert.deepEqual(keys.map(key => f.values.get(key)), visibleBefore)
      assert.equal(f.messages.length, 1)
    } finally { f.sql.close() }
  })
}

test('redelivered old messages retain the persisted failure count and never rerun an already failed attempt', async () => {
  const f = fixture()
  try {
    const ticket = await f.enqueue()
    const original = f.messages[0]
    await processMaintenanceBacklogDrain(f.env, original, openWindow)
    const progressKey = 'maintenance:backlog-drain:audit-json-retention:progress'
    const firstFailure = f.values.get(progressKey)
    const queuedBeforeRedelivery = f.messages.length
    await processMaintenanceBacklogDrain(f.env, original, openWindow)
    assert.equal(f.messages.length, queuedBeforeRedelivery, 'known sent retry must not fork another branch')
    assert.equal(f.values.get(progressKey), firstFailure, 'stale attempt must not execute and overwrite its failure receipt')
    assert.equal(f.messages.at(-1)?.maintenanceFailureAttempt, 1)
    await processMaintenanceBacklogDrain(f.env, f.messages.at(-1)!, openWindow)
    assert.equal(JSON.parse(f.values.get(progressKey)!).failure_attempt, 2)
    await processMaintenanceBacklogDrain(f.env, original, openWindow)
    assert.equal(f.messages.at(-1)?.maintenanceFailureAttempt, 2)
    await processMaintenanceBacklogDrain(f.env, f.messages.at(-1)!, openWindow)
    assert.equal(f.ticketRow(ticket.ticket_id).status, 'error')
    const queuedAtTerminal = f.messages.length
    await processMaintenanceBacklogDrain(f.env, original, openWindow)
    assert.equal(f.messages.length, queuedAtTerminal)
  } finally { f.sql.close() }
})

test('transient failure followed by deferred work closes as skipped without false error or success', async () => {
  const f = fixture()
  try {
    const ticket = await f.enqueue()
    await processMaintenanceBacklogDrain(f.env, f.messages[0], openWindow)
    assert.equal(f.ticketRow(ticket.ticket_id).completed_at, null)
    await processMaintenanceBacklogDrain(f.env, f.messages[1], new Date('2026-09-29T23:00:00Z'))
    assert.equal(f.ticketRow(ticket.ticket_id).status, 'skipped')
    assert.match(String(f.ticketRow(ticket.ticket_id).last_summary), /backlog_remaining=true/)
    assert.equal(f.values.has(failureKey), false)
  } finally { f.sql.close() }
})

test('concurrent duplicate deliveries serialize chunk failure in D1 without resetting its counter', async () => {
  const f = fixture()
  try {
    const ticket = await f.enqueue()
    await Promise.all([processMaintenanceBacklogDrain(f.env, f.messages[0], openWindow), processMaintenanceBacklogDrain(f.env, f.messages[0], openWindow)])
    const metadata = JSON.parse(String(f.ticketRow(ticket.ticket_id).metadata_json))
    assert.equal(metadata.maintenance_chunk.failures, 1)
    assert.equal(metadata.maintenance_chunk.dispatched, true)
    assert.equal(f.messages.filter(m => m.maintenanceFailureAttempt === 1).length, 1)
  } finally { f.sql.close() }
})

test('lost handoff acknowledgement recovers the same retry without reexecuting its failed chunk', async () => {
  const f = fixture()
  try {
    const ticket = await f.enqueue()
    const originalPrepare = f.db.prepare
    let loseMarker = true
    f.db.prepare = (query: string) => {
      const statement = originalPrepare(query)
      const originalRun = statement.run
      statement.run = async () => {
        if (loseMarker && query.includes("'$.maintenance_chunk.dispatched'")) {
          loseMarker = false
          throw new Error('lost_handoff_ack')
        }
        return originalRun()
      }
      return statement
    }
    await assert.rejects(processMaintenanceBacklogDrain(f.env, f.messages[0], openWindow), /lost_handoff_ack/)
    await processMaintenanceBacklogDrain(f.env, f.messages[0], openWindow)
    const metadata = JSON.parse(String(f.ticketRow(ticket.ticket_id).metadata_json))
    assert.equal(metadata.maintenance_chunk.failures, 1)
    assert.equal(metadata.maintenance_chunk.dispatched, true)
    assert.deepEqual(f.messages.slice(1).map(m => m.maintenanceFailureAttempt), [1, 1])
    await processMaintenanceBacklogDrain(f.env, f.messages[1], openWindow)
    await processMaintenanceBacklogDrain(f.env, f.messages[2], openWindow)
    assert.equal(JSON.parse(String(f.ticketRow(ticket.ticket_id).metadata_json)).maintenance_chunk.failures, 2)
    assert.equal(f.messages.filter(m => m.maintenanceFailureAttempt === 2).length, 1)
  } finally { f.sql.close() }
})

test('continuation send failure leaves a terminal ticket and visible cooldown, never false completion', async () => {
  const f = fixture()
  try {
    const ticket = await f.enqueue()
    f.env.UPDATE_QUEUE.send = async () => { throw new Error('queue_unavailable') }
    await processMaintenanceBacklogDrain(f.env, f.messages[0], openWindow)
    assert.equal(f.ticketRow(ticket.ticket_id).status, 'error')
    assert.match(String(f.ticketRow(ticket.ticket_id).last_error), /continuation_send_failed.*queue_unavailable/)
    assert.equal(f.values.has(activeKey), false)
    assert.equal(JSON.parse(f.values.get(failureKey)!).run_id, ticket.run_id)
    await processMaintenanceBacklogDrain(f.env, f.messages[0], openWindow)
    assert.equal(f.messages.length, 1)
  } finally { f.sql.close() }
})

test('lease contention is bounded and continuation retains its ticket', async () => {
  const f = fixture()
  try {
    const ticket = await f.enqueue()
    f.sql.exec("INSERT INTO maintenance_task_leases VALUES('d1_heavy_maintenance','another-task','another-owner','2099-01-01','2026-09-29','2026-09-29')")
    await processMaintenanceBacklogDrain(f.env, { ...f.messages[0], leaseRetryAttempt: 58 }, openWindow)
    assert.equal(f.messages[1].leaseRetryAttempt, 59)
    assert.equal(f.messages[1].schedulerTicketId, ticket.ticket_id)
    await processMaintenanceBacklogDrain(f.env, f.messages[1], openWindow)
    assert.equal(f.messages.length, 2)
    assert.equal(f.ticketRow(ticket.ticket_id).status, 'error')
    assert.match(String(f.ticketRow(ticket.ticket_id).last_error), /maintenance_lease_deferrals_exhausted/)
    assert.equal(f.sql.prepare('SELECT owner_id FROM maintenance_task_leases').get()?.owner_id, 'another-owner')
  } finally { f.sql.close() }
})

test('a concurrent successful terminal receipt wins over stale failure without a false cooldown', async () => {
  const f = fixture()
  try {
    const ticket = await f.enqueue()
    await processMaintenanceBacklogDrain(f.env, f.messages[0], openWindow)
    await processMaintenanceBacklogDrain(f.env, f.messages[1], openWindow)
    const originalPrepare = f.db.prepare
    f.db.prepare = (query: string) => {
      const statement = originalPrepare(query)
      const originalBind = statement.bind
      let args: any[] = []
      statement.bind = (...values: any[]) => { args = values; return originalBind(...values) }
      const originalRun = statement.run
      statement.run = async () => {
        if (query.includes('UPDATE scheduler_execution_tickets_v1') && args[0] === 'error') {
          f.sql.prepare("UPDATE scheduler_execution_tickets_v1 SET status='success', last_summary='concurrent completion' WHERE ticket_id=?").run(ticket.ticket_id)
          f.values.set(activeKey, 'successor-run')
        }
        return originalRun()
      }
      return statement
    }
    await processMaintenanceBacklogDrain(f.env, f.messages[2], openWindow)
    assert.equal(f.ticketRow(ticket.ticket_id).status, 'success')
    assert.equal(f.values.has(failureKey), false)
    assert.equal(f.values.has(`${failureKey}:${ticket.run_id}`), false)
    assert.equal(f.values.get(activeKey), 'successor-run')
  } finally { f.sql.close() }
})

for (const admittedAt of ['2026-09-29T15:59:50Z', '2026-09-29T16:00:10Z']) {
test(`HTTP enqueue receipt cannot downgrade a queue terminal ticket, and duplicate is not success (${admittedAt})`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(admittedAt) })
  const f = fixture()
  try {
    const routes = createAdminTriggerRoutes({ buildTaskMap: (_c, context) => ({ 'audit-json-retention': async () => {
      const queued = await enqueueMaintenanceBacklogDrain(f.env, { task: 'audit-json-retention', runDate: context!.businessDate!,
        runId: context!.schedulerRunId, schedulerTicketId: context!.schedulerTicketId, schedulerRunId: context!.schedulerRunId, auditJsonOptions: options })
      if (!queued.queued) return `audit_json_retention status=skipped durable=true queued=false reason=active run_id=${queued.runId}`
      // Queue completion wins the race before the initiating HTTP handler returns.
      // It retains the admitted business date even if completion crosses TW midnight.
      t.mock.timers.setTime(Date.parse(admittedAt) + 60_000)
      await updateSchedulerExecutionTicket(f.db as any, { ticketId: context!.schedulerTicketId!, runId: context!.schedulerRunId!, status: 'success', authority: 'durable_queue', summary: 'actual queue complete' })
      await logSchedulerResult(f.env.KV, 'audit-json-retention', { status: 'success', summary: 'actual queue complete', duration_ms: 0, run_id: context!.schedulerRunId, run_date: context!.businessDate })
      return `audit_json_retention status=running durable=true queued=true run_id=${queued.runId} maintenance_owner=durable_queue`
    } }) })
    const response = await routes.request('https://stockvision.invalid/api/admin/trigger/audit-json-retention?force=1&sync=1&durable=1', { method: 'POST' }, f.env)
    assert.equal(response.status, 202)
    const body = await response.json() as any
    assert.equal(f.ticketRow(body.ticket_id).status, 'success')
    assert.equal(f.ticketRow(body.ticket_id).last_summary, 'actual queue complete')
    const businessDate = String(f.ticketRow(body.ticket_id).business_date)
    assert.equal(businessDate, new Date(Date.parse(admittedAt) + 8 * 3_600_000).toISOString().slice(0, 10))
    const logKey = `scheduler:run:audit-json-retention:${businessDate}`
    assert.equal(JSON.parse(f.values.get(logKey)!).status, 'success')
    assert.equal(JSON.parse(f.values.get(logKey)!).summary, 'actual queue complete')
    assert.equal(JSON.parse(f.values.get(logKey)!).run_id, body.run_id)
    const duplicate = await routes.request('https://stockvision.invalid/api/admin/trigger/audit-json-retention?force=1&sync=1&durable=1', { method: 'POST' }, f.env)
    const duplicateBody = await duplicate.json() as any
    assert.equal(f.ticketRow(duplicateBody.ticket_id).status, 'skipped')
    assert.equal(f.ticketRow(body.ticket_id).status, 'success')
  } finally { f.sql.close() }
})
}
