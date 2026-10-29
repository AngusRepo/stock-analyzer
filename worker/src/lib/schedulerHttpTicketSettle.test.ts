import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { Miniflare } from 'miniflare'
import {
  admitSchedulerExecutionTicket,
  schedulerDeliveryIdentity,
  settleSchedulerHttpTicket,
  updateSchedulerExecutionTicket,
} from './schedulerExecutionTickets'

// FU17: a scheduler_http `blocked` result must not fight a ticket its owner already triggered
// (transition rejected -> catch writes `error` -> 5xx -> Cloud Scheduler redispatch).

const migration = fs.readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8')

async function withDb(run: (db: D1Database) => Promise<void>): Promise<void> {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['OPS'] })
  try {
    const db = await mf.getD1Database('OPS') as unknown as D1Database
    for (const statement of migration.replace(/^--.*$/gm, '').split(';').map((sql) => sql.trim()).filter(Boolean)) {
      await db.prepare(statement).run()
    }
    await run(db)
  } finally {
    await mf.dispose()
  }
}

async function admit(db: D1Database, minute: string) {
  const admitted = await admitSchedulerExecutionTicket(db, {
    identity: schedulerDeliveryIdentity(new Headers({
      'X-CloudScheduler-JobName': 'projects/local/locations/asia-east1/jobs/evening-chain',
      'X-CloudScheduler-ScheduleTime': `2026-10-27T13:${minute}:00Z`,
    })),
    task: 'evening-chain',
    proposedRunId: `evening-chain-${minute}`,
  })
  assert.equal(admitted.shouldExecute, true)
  await updateSchedulerExecutionTicket(db, { ticketId: admitted.ticket.ticket_id, runId: admitted.ticket.run_id,
    status: 'running', authority: 'scheduler_http', summary: 'sync execution started' })
  return admitted.ticket
}

// Same raw write as pipelineL3SealAcceptance.acceptEveningRootL3Wait.
async function handOffToOwner(db: D1Database, ticketId: string) {
  await db.prepare(`UPDATE scheduler_execution_tickets_v1 SET status='triggered', status_authority='durable_pipeline_stage'
    WHERE ticket_id=?`).bind(ticketId).run()
}

test('a blocked result keeps a ticket that its owner already triggered', async () => {
  await withDb(async (db) => {
    const ticket = await admit(db, '45')
    await handOffToOwner(db, ticket.ticket_id)
    const warn = console.warn
    console.warn = () => {}
    try {
      const settled = await settleSchedulerHttpTicket(db, { ticketId: ticket.ticket_id, runId: ticket.run_id,
        status: 'blocked', summary: 'status=blocked waiting for L3' })
      assert.equal(settled.status, 'triggered')
      assert.equal(settled.status_authority, 'durable_pipeline_stage')
    } finally {
      console.warn = warn
    }
    // The owner still settles it later.
    const closed = await updateSchedulerExecutionTicket(db, { ticketId: ticket.ticket_id, runId: ticket.run_id,
      status: 'success', authority: 'durable_queue', summary: 'closed' })
    assert.equal(closed.status, 'success')
  })
})

test('other settlements keep the existing transition rules', async () => {
  await withDb(async (db) => {
    const running = await admit(db, '46')
    assert.equal((await settleSchedulerHttpTicket(db, { ticketId: running.ticket_id, runId: running.run_id,
      status: 'blocked', summary: 'blocked' })).status, 'blocked')

    const terminal = await admit(db, '47')
    await settleSchedulerHttpTicket(db, { ticketId: terminal.ticket_id, runId: terminal.run_id, status: 'success', summary: 'ok' })
    await assert.rejects(settleSchedulerHttpTicket(db, { ticketId: terminal.ticket_id, runId: terminal.run_id,
      status: 'blocked', summary: 'late' }), /transition rejected/)

    const handedOff = await admit(db, '48')
    await handOffToOwner(db, handedOff.ticket_id)
    await assert.rejects(settleSchedulerHttpTicket(db, { ticketId: handedOff.ticket_id, runId: 'another-run',
      status: 'blocked', summary: 'wrong run' }), /transition rejected/)
    assert.equal((await settleSchedulerHttpTicket(db, { ticketId: handedOff.ticket_id, runId: handedOff.run_id,
      status: 'success', summary: 'done' })).status, 'success')
  })
})

test('the trigger route settles post-execution results through settleSchedulerHttpTicket', () => {
  const route = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
  assert.equal(route.split('await settleTicket(schedulerTicketStatusForRunLog(status), summary)').length, 3,
    'both the async and sync execution paths settle through the FU17 helper')
  assert.doesNotMatch(route, /updateTicket\(schedulerTicketStatusForRunLog\(status\)/)
})
