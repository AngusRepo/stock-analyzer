import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createAdminTriggerRoutes } from '../routes/adminTriggerRoutes'

class MemoryKv {
  private readonly values = new Map<string, string>()

  async get(key: string, type?: string): Promise<unknown> {
    const value = this.values.get(key)
    if (value == null) return null
    return type === 'json' ? JSON.parse(value) : value
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
}

interface LockRow {
  owner: string
  runId: string
}

class MemoryD1Statement {
  private args: unknown[] = []

  constructor(
    private readonly sql: string,
    private readonly locks: Map<string, LockRow>,
  ) {}

  bind(...args: unknown[]): this {
    this.args = args
    return this
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes('DELETE FROM scheduler_locks') && this.sql.includes('expires_at <= ?') && !this.sql.includes('lock_key = ?')) {
      return { meta: { changes: 0 } }
    }
    if (this.sql.includes('INSERT INTO scheduler_locks')) {
      const [lockKey, owner, , runId] = this.args as string[]
      if (this.locks.has(lockKey)) return { meta: { changes: 0 } }
      this.locks.set(lockKey, { owner, runId })
      return { meta: { changes: 1 } }
    }
    if (this.sql.includes('UPDATE scheduler_locks')) {
      const [owner, , lockKey, expectedOwner, expectedRunId] = this.args as string[]
      const row = this.locks.get(lockKey)
      if (!row || row.owner !== expectedOwner || row.runId !== expectedRunId) return { meta: { changes: 0 } }
      this.locks.set(lockKey, { owner, runId: row.runId })
      return { meta: { changes: 1 } }
    }
    if (this.sql.includes('DELETE FROM scheduler_locks') && this.sql.includes('lock_key = ?')) {
      const [lockKey, expectedOwner, expectedRunId] = this.args as string[]
      const row = this.locks.get(lockKey)
      if (!row || row.owner !== expectedOwner || row.runId !== expectedRunId) return { meta: { changes: 0 } }
      this.locks.delete(lockKey)
      return { meta: { changes: 1 } }
    }
    throw new Error(`Unexpected D1 run SQL: ${this.sql}`)
  }

  async first<T>(): Promise<T | null> {
    const row = this.locks.get(String(this.args[0]))
    return (row ? { owner: row.owner } : null) as T | null
  }
}

class MemoryD1 {
  readonly locks = new Map<string, LockRow>()

  prepare(sql: string): MemoryD1Statement {
    return new MemoryD1Statement(sql, this.locks)
  }
}

async function main(): Promise<void> {
  const token = 'scheduler-test-token'
  const executed: string[] = []
  const env = {
    STOCKVISION_AUTH_TOKEN: token,
    KV: new MemoryKv(),
    DB: new MemoryD1(),
  } as any
  const routes = createAdminTriggerRoutes({
    buildTaskMap: () => ({
      'debate-memory-retention': async () => {
        executed.push('debate-memory-retention')
        return 'retention complete'
      },
      'orphan-reachability-gc': async () => {
        executed.push('orphan-reachability-gc')
        return 'gc complete'
      },
    }),
  })
  const app = new Hono<any>()
  app.route('/', routes)
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as any

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('global fetch must not be used for scheduler batch dispatch')
  }
  try {
    const response = await app.request(
      'https://worker.invalid/api/admin/scheduler-batch/daily-1900-maintenance',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-CloudScheduler-ScheduleTime': '2026-07-19T19:00:00Z',
        },
      },
      env,
      executionCtx,
    )
    assert.equal(response.status, 200)
    const body = await response.json() as any
    assert.equal(body.success, true)
    assert.deepEqual(executed.sort(), ['debate-memory-retention', 'orphan-reachability-gc'])
    assert(body.outcomes.every((outcome: any) => outcome.status === 'success'))
    assert.equal(env.DB.locks.size, 2)
    assert([...env.DB.locks.values()].every((row: LockRow) => row.owner === 'scheduler_batch_complete'))
  } finally {
    globalThis.fetch = originalFetch
  }

  console.log('schedulerBatchLiveRoute: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})