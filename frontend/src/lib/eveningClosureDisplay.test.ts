import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { SchedulerJob } from './api'
import { eveningClosureDisplay } from '../components/observability/eveningClosureDisplay'
const root = { id: 'evening-chain', lastStatus: 'running', lastRun: '10/2 21:18',
  lastRunAt: '2026-10-02T13:18:00Z', lastDuration: '5s', summary: 'FinLab callback expected',
  ticket: { logicalTask: 'evening-chain', status: 'running' } } as SchedulerJob
test('closure does not animate or claim a start time during upstream work', () => {
  const view = eveningClosureDisplay(root)
  assert.equal(view.lastStatus, 'waiting'); assert.equal(view.lastRunAt, null)
  assert.equal(view.nextRun, '等待全鏈完成'); assert.equal(view.lastDuration, 'N/A'); assert.equal(view.ticket.logicalTask, 'evening-closure')
})
test('L3 wait and historical SLA timeout cannot become a failed closure', () => {
  assert.equal(eveningClosureDisplay({ ...root, lastStatus: 'waiting' }).lastStatus, 'waiting')
  assert.equal(eveningClosureDisplay({ ...root, lastStatus: 'failed', lastError: 'stale triggered: no final callback' }).lastStatus, 'waiting')
})
test('real terminal receipts and errors remain visible', () => {
  for (const lastStatus of ['success', 'failed'] as const) {
    const view = eveningClosureDisplay({ ...root, lastStatus, lastError: lastStatus === 'failed' ? 'checksum mismatch' : undefined })
    assert.equal(view.lastStatus, lastStatus); assert.equal(view.lastRunAt, root.lastRunAt)
  }
})
