import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Miniflare } from 'miniflare'
import {
  admitSchedulerChildTicket,
  admitSchedulerExecutionTicket,
  schedulerDeliveryIdentity,
  updateSchedulerExecutionTicket,
} from './schedulerExecutionTickets'

const migration = fs.readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8')

function schedulerIdentity(jobId: string, scheduledAt: string) {
  return schedulerDeliveryIdentity(new Headers({
    'X-CloudScheduler-JobName': `projects/stockvision/locations/asia-east1/jobs/${jobId}`,
    'X-CloudScheduler-ScheduleTime': scheduledAt,
  }))
}

async function main(): Promise<void> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['OPS'],
  })
  try {
    const db = await mf.getD1Database('OPS')
    for (const statement of migration.replace(/^--.*$/gm, '').split(';').map((sql) => sql.trim()).filter(Boolean)) {
      await db.prepare(statement).run()
    }

    const identity = schedulerIdentity('weekly-cleanup', '2026-08-22T20:00:00Z')
    const admissions = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      admitSchedulerExecutionTicket(db, {
        identity,
        task: 'weekly-cleanup',
        proposedRunId: `weekly-cleanup-proposed-${index}`,
      })
    )))
    assert.equal(admissions.filter((row) => row.shouldExecute).length, 1)
    assert.equal(new Set(admissions.map((row) => row.ticket.ticket_id)).size, 1)
    assert.equal(new Set(admissions.map((row) => row.ticket.run_id)).size, 1)
    assert.equal(admissions[0].ticket.business_date, '2026-08-23')
    const root = admissions[0].ticket

    await updateSchedulerExecutionTicket(db, {
      ticketId: root.ticket_id,
      runId: root.run_id,
      status: 'queued',
      authority: 'durable_queue',
      summary: 'queue accepted',
    })
    await updateSchedulerExecutionTicket(db, {
      ticketId: root.ticket_id,
      runId: root.run_id,
      status: 'running',
      authority: 'durable_queue',
      summary: 'consumer started',
    })
    const completed = await updateSchedulerExecutionTicket(db, {
      ticketId: root.ticket_id,
      runId: root.run_id,
      status: 'success',
      authority: 'durable_queue',
      summary: 'weekly cleanup closed',
    })
    assert.equal(completed.status, 'success')
    assert.ok(completed.completed_at)
    await assert.rejects(
      updateSchedulerExecutionTicket(db, {
        ticketId: root.ticket_id,
        runId: root.run_id,
        status: 'error',
        authority: 'durable_queue',
        summary: 'late stale failure',
      }),
      /transition rejected/,
    )
    const terminalDuplicate = await admitSchedulerExecutionTicket(db, {
      identity,
      task: 'weekly-cleanup',
      proposedRunId: 'weekly-cleanup-late-duplicate',
    })
    assert.equal(terminalDuplicate.shouldExecute, false)
    assert.equal(terminalDuplicate.reason, 'duplicate_terminal')
    assert.equal(terminalDuplicate.ticket.run_id, root.run_id)

    const retryIdentity = schedulerIdentity('weekly-audit', '2026-08-21T10:30:00Z')
    const failed = await admitSchedulerExecutionTicket(db, {
      identity: retryIdentity,
      task: 'weekly-audit',
      proposedRunId: 'weekly-audit-first',
    })
    await updateSchedulerExecutionTicket(db, {
      ticketId: failed.ticket.ticket_id,
      runId: failed.ticket.run_id,
      status: 'error',
      authority: 'scheduler_http',
      summary: 'transport failed',
    })
    const retry = await admitSchedulerExecutionTicket(db, {
      identity: retryIdentity,
      task: 'weekly-audit',
      proposedRunId: 'weekly-audit-second-proposal',
    })
    assert.equal(retry.shouldExecute, true)
    assert.equal(retry.reason, 'retry_admitted')
    assert.equal(retry.ticket.run_id, failed.ticket.run_id)
    assert.equal(retry.ticket.attempt_count, 2)
    assert.match(retry.ticket.attempt_id, /:attempt:2$/)

    const children = await Promise.all(Array.from({ length: 4 }, () => admitSchedulerChildTicket(db, {
      rootTicketId: root.ticket_id,
      parentTicketId: root.ticket_id,
      childKey: 'lifecycle-dry-run',
      task: 'weekly-lifecycle-dry-run',
      businessDate: root.business_date,
      runId: root.run_id,
    })))
    assert.equal(new Set(children.map((row) => row.ticket_id)).size, 1)
    assert.equal(children[0].root_ticket_id, root.ticket_id)
    assert.equal(children[0].parent_ticket_id, root.ticket_id)

    await assert.rejects(
      admitSchedulerExecutionTicket(db, {
        identity: schedulerIdentity('weekly-cleanup', '2026-08-29T20:00:00Z'),
        task: 'weekly-audit',
        proposedRunId: 'manifest-mismatch',
      }),
      /task mismatch/,
    )

    console.log('scheduler execution ticket CAS integration passed')
  } finally {
    await mf.dispose()
  }
}

void main().catch((error) => {
  throw error
})
