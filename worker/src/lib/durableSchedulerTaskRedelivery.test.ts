import assert from 'node:assert/strict'
import test from 'node:test'
import { processDurableSchedulerTask } from './durableSchedulerTask'
import type { Bindings, UpdateQueueMsg } from '../types'

// One ticket row; UPDATE applies only from the statuses the real guard allows for `running`.
function ticketDb(ticket: Record<string, unknown>) {
  const updates: unknown[][] = []
  const db = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => {
          updates.push(values)
          const allowed = ['accepted', 'queued', 'running']
          const applies = /UPDATE scheduler_execution_tickets_v1/.test(sql) && values[0] === 'running'
            && values[8] === ticket.ticket_id && values[9] === ticket.run_id && allowed.includes(String(ticket.status))
          if (applies) ticket.status = 'running'
          return { meta: { changes: applies ? 1 : 0 } }
        },
        first: async () => ({ ...ticket }),
      }),
    }),
  }
  return { db: db as unknown as D1Database, updates }
}

function kv() {
  const puts: string[] = []
  return { puts, binding: { put: async (key: string) => { puts.push(key) }, get: async () => null } as unknown as KVNamespace }
}

const message: UpdateQueueMsg = {
  type: 'scheduled_admin_task', cursor: 0, triggerTime: '2026-11-17', runId: 'external-evidence-run-1',
  scheduledTask: 'external-evidence', schedulerTicketId: 'ticket-1',
}

for (const status of ['error', 'success']) {
  test(`redelivery after a ${status} ticket is acknowledged without rerun or a second run log`, async () => {
    const { db } = ticketDb({ ticket_id: 'ticket-1', run_id: 'external-evidence-run-1', status })
    const store = kv()
    let ran = 0
    await processDurableSchedulerTask(message, { DB: db, KV: store.binding } as Bindings, {
      runTask: async () => { ran += 1; return { summary: 'ok' } },
    })
    assert.equal(ran, 0)
    assert.deepEqual(store.puts, [])
  })
}

test('a ticket owned by another run still fails the delivery', async () => {
  const { db } = ticketDb({ ticket_id: 'ticket-1', run_id: 'external-evidence-run-0', status: 'error' })
  const store = kv()
  await assert.rejects(processDurableSchedulerTask(message, { DB: db, KV: store.binding } as Bindings, {
    runTask: async () => ({ summary: 'ok' }),
  }), /ticket transition rejected/)
})

test('a fresh delivery still runs the task', async () => {
  const { db } = ticketDb({ ticket_id: 'ticket-1', run_id: 'external-evidence-run-1', status: 'queued' })
  const store = kv()
  let ran = 0
  await processDurableSchedulerTask(message, { DB: db, KV: store.binding } as Bindings, {
    runTask: async () => { ran += 1; return { summary: 'external evidence receipt=ready' } },
  }).catch(() => undefined)
  assert.equal(ran, 1)
})

test('a transient ticket write failure on a live ticket is rethrown, not acknowledged', async () => {
  const ticket = { ticket_id: 'ticket-1', run_id: 'external-evidence-run-1', status: 'queued' }
  const db = {
    prepare: () => ({
      bind: () => ({
        run: async () => { throw new Error('D1_ERROR: overloaded') },
        first: async () => ({ ...ticket }),
      }),
    }),
  } as unknown as D1Database
  let ran = 0
  await assert.rejects(processDurableSchedulerTask(message, { DB: db, KV: kv().binding } as Bindings, {
    runTask: async () => { ran += 1; return { summary: 'ok' } },
  }), /overloaded/)
  assert.equal(ran, 0)
})
