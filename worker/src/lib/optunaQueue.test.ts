import assert from 'node:assert/strict'
import {
  OPTUNA_QUEUE_PROCESSOR_D1_LOCK_KEY,
  OPTUNA_QUEUE_PROCESSOR_LOCK_KEY,
  acquireOptunaQueueProcessorD1Lock,
  acquireOptunaQueueProcessorLock,
  acquireOptunaRunD1Lock,
  closeOptunaRunD1Lock,
  enqueueOptunaRequest,
  listQueue,
  optunaRunDateFromRunId,
  optunaTriggerSourceForReason,
  popNextPending,
  releaseOptunaQueueProcessorD1Lock,
  releaseOptunaQueueProcessorLock,
} from './optunaQueue'

class FakeKV {
  store = new Map<string, string>()

  async get(key: string, type?: 'json'): Promise<any> {
    const value = this.store.get(key)
    if (value == null) return null
    return type === 'json' ? JSON.parse(value) : value
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}

class FakeD1 {
  locks = new Map<string, Record<string, string | null>>()

  prepare(sql: string): any {
    const db = this
    return {
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values
        return this
      },
      async run() {
        if (sql.includes('INSERT INTO scheduler_locks')) {
          const [lockKey, owner, runDate, runId, createdAt, expiresAt] = this.values.map(v => v == null ? null : String(v))
          const existing = db.locks.get(String(lockKey))
          if (!existing || (existing.expires_at && existing.expires_at <= createdAt)) {
            db.locks.set(String(lockKey), {
              lock_key: lockKey,
              owner,
              run_date: runDate,
              run_id: runId,
              created_at: createdAt,
              expires_at: expiresAt,
            })
            return { success: true, results: [], meta: { changes: 1 } }
          }
          return { success: true, results: [], meta: { changes: 0 } }
        }
        if (sql.includes('DELETE FROM scheduler_locks')) {
          const [lockKey, runId] = this.values.map(v => String(v))
          const existing = db.locks.get(lockKey)
          if (existing?.run_id === runId) {
            db.locks.delete(lockKey)
            return { success: true, results: [], meta: { changes: 1 } }
          }
          return { success: true, results: [], meta: { changes: 0 } }
        }
        if (sql.includes('UPDATE scheduler_locks')) {
          const [owner, expiresAt, lockKey] = this.values.map(v => v == null ? null : String(v))
          const existing = db.locks.get(String(lockKey))
          if (!existing) return { success: true, results: [], meta: { changes: 0 } }
          db.locks.set(String(lockKey), { ...existing, owner, expires_at: expiresAt })
          return { success: true, results: [], meta: { changes: 1 } }
        }
        throw new Error(`unsupported sql: ${sql}`)
      },
    }
  }
}

const kv = new FakeKV() as unknown as KVNamespace
const fakeD1 = new FakeD1()
const db = fakeD1 as unknown as D1Database

assert.equal(optunaTriggerSourceForReason('regime_shift'), 'regime_change')
assert.equal(optunaTriggerSourceForReason('sharpe_rolling'), 'risk_anomaly')
assert.equal(optunaTriggerSourceForReason('manual'), 'manual_research')

async function main() {
  const first = await enqueueOptunaRequest(kv, {
    reason: 'regime_shift',
    target: 'per_regime',
    regime_hint: 'volatile',
    note: 'sideways->volatile',
  })
  assert.equal(first.enqueued, true)
  assert.match(first.id, /^per_regime:regime_shift:volatile:/)

  const duplicate = await enqueueOptunaRequest(kv, {
    reason: 'regime_shift',
    target: 'per_regime',
    regime_hint: 'volatile',
  })
  assert.equal(duplicate.enqueued, false)

  const entries = await listQueue(kv)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].trigger_source, 'regime_change')
  assert.equal(entries[0].idempotency_key, first.id)
  assert.equal(entries[0].cooldown_key, 'optuna:cooldown:per_regime:regime_shift:volatile')
  assert.ok(entries[0].cooldown_until)

  const claimed = await popNextPending(kv)
  assert.equal(claimed?.id, first.id)
  assert.equal(claimed?.status, 'in_progress')
  assert.ok(claimed?.processing_started_at)

  assert.equal(await acquireOptunaQueueProcessorLock(kv, 'run-1', 60), true)
  assert.equal(await acquireOptunaQueueProcessorLock(kv, 'run-2', 60), false)
  await releaseOptunaQueueProcessorLock(kv, 'wrong-run')
  assert.ok(await kv.get(OPTUNA_QUEUE_PROCESSOR_LOCK_KEY))
  await releaseOptunaQueueProcessorLock(kv, 'run-1')
  assert.equal(await kv.get(OPTUNA_QUEUE_PROCESSOR_LOCK_KEY), null)

  const d1Processor = await acquireOptunaQueueProcessorD1Lock(db, 'd1-run-1', 60)
  assert.equal(d1Processor.acquired, true)
  assert.equal(d1Processor.lock_key, OPTUNA_QUEUE_PROCESSOR_D1_LOCK_KEY)
  assert.equal((await acquireOptunaQueueProcessorD1Lock(db, 'd1-run-2', 60)).acquired, false)
  await releaseOptunaQueueProcessorD1Lock(db, 'wrong-run')
  assert.ok(fakeD1.locks.get(OPTUNA_QUEUE_PROCESSOR_D1_LOCK_KEY))
  await releaseOptunaQueueProcessorD1Lock(db, 'd1-run-1')
  assert.equal(fakeD1.locks.get(OPTUNA_QUEUE_PROCESSOR_D1_LOCK_KEY), undefined)

  const perRun = await acquireOptunaRunD1Lock(db, claimed!, 'per-regime-run-1', 60)
  assert.equal(perRun.acquired, true)
  assert.equal(perRun.lock_key, `optuna:run:${first.id}`)
  assert.equal((await acquireOptunaRunD1Lock(db, claimed!, 'per-regime-run-2', 60)).acquired, false)
  assert.equal(optunaRunDateFromRunId(first.id), first.id.slice(-10))
  const closed = await closeOptunaRunD1Lock(db, first.id, 'success')
  assert.equal(closed.closed, true)
  assert.equal(fakeD1.locks.get(`optuna:run:${first.id}`)?.owner, 'optuna_per_regime_run_success')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
