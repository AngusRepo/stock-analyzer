import assert from 'node:assert/strict'
import { adminControlRoutes } from '../routes/adminControlRoutes'
import {
  acquireOptunaRunD1Lock,
  enqueueOptunaRequest,
  listQueue,
  markTriggered,
  popNextPending,
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
        if (sql.includes('UPDATE scheduler_locks')) {
          const [owner, expiresAt, lockKey] = this.values.map(v => v == null ? null : String(v))
          const existing = db.locks.get(String(lockKey))
          if (existing) db.locks.set(String(lockKey), { ...existing, owner, expires_at: expiresAt })
          return { success: true, results: [], meta: { changes: existing ? 1 : 0 } }
        }
        throw new Error(`unsupported sql: ${sql}`)
      },
    }
  }
}

async function buildInProgressEntry(kv: FakeKV, db: FakeD1, suffix: string) {
  const enqueued = await enqueueOptunaRequest(kv as unknown as KVNamespace, {
    reason: 'manual',
    target: 'per_regime',
    regime_hint: suffix,
  })
  const entry = await popNextPending(kv as unknown as KVNamespace)
  assert.ok(entry)
  await acquireOptunaRunD1Lock(db as unknown as D1Database, entry, `lock-owner-${suffix}`, 3600)
  const runId = `execution-${suffix}`
  await markTriggered(kv as unknown as KVNamespace, entry.id, {
    run_id: runId,
    note: 'callback expected',
  })
  return { id: enqueued.id, runId }
}

async function postCallback(kv: FakeKV, db: FakeD1, body: Record<string, unknown>) {
  return adminControlRoutes.request('/api/admin/scheduler-callback', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, {
    STOCKVISION_AUTH_TOKEN: 'test-token',
    KV: kv as unknown as KVNamespace,
    DB: db as unknown as D1Database,
  } as any)
}

async function main() {
  const successKv = new FakeKV()
  const successDb = new FakeD1()
  const successRun = await buildInProgressEntry(successKv, successDb, 'volatile')

  const staleResponse = await postCallback(successKv, successDb, {
    task: 'optuna-per-regime',
    status: 'success',
    summary: 'stale completion',
    duration_ms: 100,
    run_id: 'execution-stale',
    queue_entry_id: successRun.id,
    sandbox_id: 'sandbox-stale',
  })
  assert.equal(staleResponse.status, 200)
  assert.equal((await listQueue(successKv as unknown as KVNamespace))[0].status, 'in_progress')
  assert.equal(successDb.locks.get(`optuna:run:${successRun.id}`)?.owner, 'optuna_per_regime_run')

  const successResponse = await postCallback(successKv, successDb, {
    task: 'optuna-per-regime',
    status: 'success',
    summary: 'per-regime complete',
    duration_ms: 1234,
    run_id: successRun.runId,
    queue_entry_id: successRun.id,
    sandbox_id: 'sandbox-success',
  })
  assert.equal(successResponse.status, 200)
  const successEntry = (await listQueue(successKv as unknown as KVNamespace))[0]
  assert.equal(successEntry.status, 'processed')
  assert.equal(successEntry.sandbox_id, 'sandbox-success')
  assert.equal(successDb.locks.get(`optuna:run:${successRun.id}`)?.owner, 'optuna_per_regime_run_success')

  const retryKv = new FakeKV()
  const retryDb = new FakeD1()
  const retryRun = await buildInProgressEntry(retryKv, retryDb, 'bear_market')
  const retryResponse = await postCallback(retryKv, retryDb, {
    task: 'optuna-per-regime',
    status: 'error',
    summary: 'job timeout',
    error: 'DeadlineExceeded',
    duration_ms: 7200000,
    run_id: retryRun.runId,
    queue_entry_id: retryRun.id,
  })
  assert.equal(retryResponse.status, 200)
  const retryEntry = (await listQueue(retryKv as unknown as KVNamespace))[0]
  assert.equal(retryEntry.status, 'pending')
  assert.equal(retryEntry.retry_count, 1)
  assert.equal(retryEntry.error, 'DeadlineExceeded')
  assert.equal(retryDb.locks.get(`optuna:run:${retryRun.id}`)?.owner, 'optuna_per_regime_run_error')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})