import assert from 'node:assert/strict'
import test from 'node:test'
import {
  durableTaskRecoveryDelaySeconds,
  processDurableSchedulerTask,
  scheduleDurableTaskLeaseRecovery,
} from './durableSchedulerTask'
import type { MaintenanceLeaseBusy } from './maintenanceLease'
import type { Bindings, UpdateQueueMsg } from '../types'

interface FenceRow {
  owner: string
  runId: string
  expiresAtMs: number
}

class RecoveryStatement {
  private values: unknown[] = []

  constructor(
    readonly sql: string,
    private readonly owner: RecoveryDb,
  ) {}

  bind(...values: unknown[]): RecoveryStatement {
    const bound = new RecoveryStatement(this.sql, this.owner)
    bound.values = values
    return bound
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes('INSERT INTO scheduler_locks')) {
      const [key, owner, , runId, modifier] = this.values.map(String)
      const current = this.owner.fences.get(key)
      if (current && current.expiresAtMs > this.owner.nowMs) return null
      const seconds = Number(/^\+(\d+) seconds$/.exec(modifier)?.[1] ?? 0)
      this.owner.fences.set(key, {
        owner,
        runId,
        expiresAtMs: this.owner.nowMs + seconds * 1000,
      })
      return { lock_key: key } as T
    }
    if (this.sql.includes('SELECT owner, run_id')) {
      const [key] = this.values.map(String)
      const current = this.owner.fences.get(key)
      if (!current || current.expiresAtMs <= this.owner.nowMs) return null
      return { owner: current.owner, run_id: current.runId } as T
    }
    if (this.sql.includes('DELETE FROM scheduler_locks') && this.sql.includes('RETURNING lock_key')) {
      const [key, owner, runId] = this.values.map(String)
      const current = this.owner.fences.get(key)
      if (!current || current.owner !== owner || current.runId !== runId) return null
      this.owner.fences.delete(key)
      return { lock_key: key } as T
    }
    throw new Error('unexpected first SQL: ' + this.sql)
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (!this.sql.includes('DELETE FROM scheduler_locks')) throw new Error('unexpected run SQL')
    if (this.owner.failDelete) throw new Error('injected_fence_cleanup_failure')
    const [key, owner, runId] = this.values.map(String)
    const current = this.owner.fences.get(key)
    if (current && current.owner === owner && current.runId === runId) {
      this.owner.fences.delete(key)
      return { meta: { changes: 1 } }
    }
    return { meta: { changes: 0 } }
  }
}

class RecoveryDb {
  fences = new Map<string, FenceRow>()
  failDelete = false

  constructor(public nowMs: number) {}

  prepare(sql: string): RecoveryStatement {
    return new RecoveryStatement(sql, this)
  }
}

class RecoveryQueue {
  sent: Array<{ body: UpdateQueueMsg; delaySeconds: number | null }> = []
  fail = false

  async send(body: UpdateQueueMsg, options?: { delaySeconds?: number }): Promise<void> {
    if (this.fail) throw new Error('injected_queue_send_failure')
    this.sent.push({ body, delaySeconds: options?.delaySeconds ?? null })
  }

  async sendBatch(): Promise<void> {}
}

class MemoryKv {
  values = new Map<string, string>()

  async get(key: string, type?: string): Promise<unknown> {
    const value = this.values.get(key)
    if (value == null) return null
    return type === 'json' ? JSON.parse(value) : value
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
}

const runDate = '2026-08-23'
const runId = 's12-smcvwap-calibration-test-run'
const nowMs = Date.parse('2026-08-23T21:30:00.000Z')
const busy: MaintenanceLeaseBusy = {
  skipped: true,
  reason: 'maintenance_lease_busy:s12-smcvwap-calibration:2026-08-23:2026-08-23 21:33:23',
  leaseGroup: 's12_smcvwap_calibration:2026-08-23',
  holderTaskName: 's12-smcvwap-calibration:2026-08-23',
  holderOwnerId: 'holder-a',
  leaseExpiresAt: '2026-08-23 21:33:23',
}
const message: UpdateQueueMsg = {
  type: 'scheduled_admin_task',
  cursor: 0,
  triggerTime: runDate,
  runId,
  scheduledTask: 's12-smcvwap-calibration',
}

function env(db: RecoveryDb, queue: RecoveryQueue, kv = new MemoryKv()): {
  bindings: Bindings
  kv: MemoryKv
} {
  return {
    bindings: {
      DB: db as unknown as D1Database,
      KV: kv as unknown as KVNamespace,
      UPDATE_QUEUE: queue as unknown as Queue<UpdateQueueMsg>,
    } as Bindings,
    kv,
  }
}

test('uses UTC lease timestamps and bounds recovery delays', () => {
  assert.equal(durableTaskRecoveryDelaySeconds('2026-08-23 21:33:23', nowMs), 208)
  assert.equal(durableTaskRecoveryDelaySeconds('2026-08-23 21:29:00', nowMs), 5)
  assert.equal(durableTaskRecoveryDelaySeconds('2026-08-25 21:30:00', nowMs), 43_200)
})

test('deduplicates an active fence, reclaims it after expiry, and cleans it on enqueue failure', async () => {
  const db = new RecoveryDb(nowMs)
  const queue = new RecoveryQueue()
  const first = await scheduleDurableTaskLeaseRecovery(
    db as unknown as D1Database,
    queue as unknown as Queue<UpdateQueueMsg>,
    message,
    busy,
    nowMs,
  )
  assert.equal(first.reason, 'scheduled')
  assert.equal(first.delaySeconds, 208)
  assert.equal(queue.sent.length, 1)
  assert.equal(db.fences.size, 1)

  const duplicate = await scheduleDurableTaskLeaseRecovery(
    db as unknown as D1Database,
    queue as unknown as Queue<UpdateQueueMsg>,
    { ...message, runId: runId + '-different-delivery' },
    busy,
    nowMs,
  )
  assert.equal(duplicate.reason, 'deduplicated')
  assert.equal(queue.sent.length, 1)

  db.nowMs += 1_200_000
  const reclaimed = await scheduleDurableTaskLeaseRecovery(
    db as unknown as D1Database,
    queue as unknown as Queue<UpdateQueueMsg>,
    message,
    busy,
    db.nowMs,
  )
  assert.equal(reclaimed.reason, 'scheduled')
  assert.equal(queue.sent.length, 2)

  const failingDb = new RecoveryDb(nowMs)
  const failingQueue = new RecoveryQueue()
  failingQueue.fail = true
  await assert.rejects(
    scheduleDurableTaskLeaseRecovery(
      failingDb as unknown as D1Database,
      failingQueue as unknown as Queue<UpdateQueueMsg>,
      message,
      busy,
      nowMs,
    ),
    /durable recovery enqueue failed: injected_queue_send_failure/,
  )
  assert.equal(failingDb.fences.size, 0)
})

test('resumes a same-run recovery fence after claim-to-send crash and after cleanup failure', async () => {
  const fenceKey = 'durable_task_recovery:s12-smcvwap-calibration:2026-08-23:holder-a:1'
  const db = new RecoveryDb(nowMs)
  db.fences.set(fenceKey, {
    owner: 'durable_scheduler_lease_recovery',
    runId,
    expiresAtMs: nowMs + 900_000,
  })
  const queue = new RecoveryQueue()
  const resumed = await scheduleDurableTaskLeaseRecovery(
    db as unknown as D1Database,
    queue as unknown as Queue<UpdateQueueMsg>,
    message,
    busy,
    nowMs,
  )
  assert.equal(resumed.reason, 'scheduled')
  assert.equal(resumed.scheduled, true)
  assert.equal(queue.sent.length, 1)

  const cleanupFailureDb = new RecoveryDb(nowMs)
  cleanupFailureDb.failDelete = true
  cleanupFailureDb.fences.set(fenceKey, {
    owner: 'durable_scheduler_lease_recovery',
    runId,
    expiresAtMs: nowMs + 900_000,
  })
  const initiallyFailingQueue = new RecoveryQueue()
  initiallyFailingQueue.fail = true
  await assert.rejects(
    scheduleDurableTaskLeaseRecovery(
      cleanupFailureDb as unknown as D1Database,
      initiallyFailingQueue as unknown as Queue<UpdateQueueMsg>,
      message,
      busy,
      nowMs,
    ),
    /durable recovery enqueue failed: injected_queue_send_failure/,
  )
  assert.equal(cleanupFailureDb.fences.size, 1)
  initiallyFailingQueue.fail = false
  const redelivered = await scheduleDurableTaskLeaseRecovery(
    cleanupFailureDb as unknown as D1Database,
    initiallyFailingQueue as unknown as Queue<UpdateQueueMsg>,
    message,
    busy,
    nowMs,
  )
  assert.equal(redelivered.scheduled, true)
  assert.equal(initiallyFailingQueue.sent.length, 1)
})

test('holder A to B replacement schedules against B instead of dropping calibration', async () => {
  const db = new RecoveryDb(nowMs)
  const queue = new RecoveryQueue()
  const replacementBusy: MaintenanceLeaseBusy = {
    ...busy,
    holderOwnerId: 'holder-b',
    leaseExpiresAt: '2026-08-23 21:40:00',
  }
  const recovery = await scheduleDurableTaskLeaseRecovery(
    db as unknown as D1Database,
    queue as unknown as Queue<UpdateQueueMsg>,
    {
      ...message,
      durableTaskRecoveryAttempt: 1,
      durableTaskExpectedLeaseOwner: 'holder-a',
    },
    replacementBusy,
    nowMs,
  )
  assert.equal(recovery.reason, 'holder_replaced_scheduled')
  assert.equal(recovery.scheduled, true)
  assert.equal(recovery.attempt, 2)
  assert.equal(queue.sent.length, 1)
  assert.equal(queue.sent[0].body.durableTaskExpectedLeaseOwner, 'holder-b')
  assert.equal(queue.sent[0].body.durableTaskRecoveryAttempt, 2)
})

test('busy delivery schedules one delayed successor, ACKs running, then successor closes and releases its fence', async () => {
  const db = new RecoveryDb(nowMs)
  const queue = new RecoveryQueue()
  const setup = env(db, queue)
  await processDurableSchedulerTask(message, setup.bindings, {
    runTask: async () => busy,
  })
  assert.equal(queue.sent.length, 1)
  assert(Number(queue.sent[0].delaySeconds) >= 5)
  assert(Number(queue.sent[0].delaySeconds) <= 43_200)
  const running = JSON.parse(String(setup.kv.values.get(
    'scheduler:run:s12-smcvwap-calibration:2026-08-23',
  )))
  assert.equal(running.status, 'running')
  assert.match(running.summary, /recovery=scheduled/)
  assert.equal(setup.kv.values.has(
    'scheduler:terminal:s12-smcvwap-calibration:2026-08-23',
  ), false)
  assert.equal(db.fences.size, 1)

  const successor = queue.sent[0].body
  await processDurableSchedulerTask(successor, setup.bindings, {
    runTask: async () => ({ summary: 's12_tw_calibration status=frozen written=0' }),
  })
  const success = JSON.parse(String(setup.kv.values.get(
    'scheduler:run:s12-smcvwap-calibration:2026-08-23',
  )))
  assert.equal(success.status, 'success')
  assert.equal(setup.kv.values.has(
    'scheduler:terminal:s12-smcvwap-calibration:2026-08-23',
  ), true)
  assert.equal(db.fences.size, 0)
})

test('attempt limit is terminal error, ACKed, and never writes a success receipt', async () => {
  const db = new RecoveryDb(nowMs)
  const queue = new RecoveryQueue()
  const setup = env(db, queue)
  await processDurableSchedulerTask({
    ...message,
    durableTaskRecoveryAttempt: 3,
    durableTaskExpectedLeaseOwner: busy.holderOwnerId,
  }, setup.bindings, {
    runTask: async () => busy,
  })
  assert.equal(queue.sent.length, 0)
  const terminal = JSON.parse(String(setup.kv.values.get(
    'scheduler:run:s12-smcvwap-calibration:2026-08-23',
  )))
  assert.equal(terminal.status, 'error')
  assert.match(terminal.summary, /durable_recovery_exhausted/)
  assert.equal(setup.kv.values.has(
    'scheduler:terminal:s12-smcvwap-calibration:2026-08-23',
  ), false)
})
