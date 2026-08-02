import assert from 'node:assert/strict'
import { adminControlRoutes } from '../routes/adminControlRoutes'
import { strategyMiningDispatchKey } from './strategyMiningGateway'

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
  prepare(sql: string): any {
    return {
      sql,
      params: [] as unknown[],
      bind(...params: unknown[]) {
        this.params = params
        return this
      },
    }
  }

  async batch(statements: any[]): Promise<any[]> {
    return statements.map(statement => ({
      success: true,
      results: /^\s*select/i.test(statement.sql) ? [{ run_id: 'existing-run' }] : [],
      meta: { changes: /^\s*select/i.test(statement.sql) ? 0 : 1 },
    }))
  }
}

const token = 'dedicated-strategy-token'
const runId = 'strategy-mining-2026-08-02-12345678-abcd'
const runDate = '2026-08-02'

function env(kv: FakeKV, db: FakeD1) {
  return {
    STRATEGY_MINING_CALLBACK_TOKEN: token,
    STOCKVISION_AUTH_TOKEN: 'global-token-must-not-work',
    KV: kv as unknown as KVNamespace,
    DB: db as unknown as D1Database,
  } as any
}

async function post(path: string, bearer: string, body: unknown, kv: FakeKV, db: FakeD1) {
  return adminControlRoutes.request(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }, env(kv, db))
}

async function main() {
  const kv = new FakeKV()
  const db = new FakeD1()

  const globalTokenRejected = await post('/api/internal/strategy-mining/d1', 'global-token-must-not-work', {
    statements: [{ sql: 'SELECT run_id FROM strategy_mining_runs LIMIT 1', params: [] }],
  }, kv, db)
  assert.equal(globalTokenRejected.status, 401)

  const allowed = await post('/api/internal/strategy-mining/d1', token, {
    statements: [{ sql: 'SELECT run_id FROM strategy_mining_runs LIMIT 1', params: [] }],
  }, kv, db)
  assert.equal(allowed.status, 200)
  const allowedBody = await allowed.json() as any
  assert.equal(allowedBody.mode, 'strategy_mining_d1_gateway')
  assert.equal(allowedBody.results[0].results[0].run_id, 'existing-run')

  const rejectedTable = await post('/api/internal/strategy-mining/d1', token, {
    statements: [{ sql: 'UPDATE users SET is_admin = 1', params: [] }],
  }, kv, db)
  assert.equal(rejectedTable.status, 400)

  const rejectedCommaJoin = await post('/api/internal/strategy-mining/d1', token, {
    statements: [{ sql: 'SELECT r.run_id FROM strategy_mining_runs r, users u', params: [] }],
  }, kv, db)
  assert.equal(rejectedCommaJoin.status, 400)

  const callbackBody = {
    task: 'monthly-strategy-mining',
    status: 'success',
    summary: `monthly Pymoo strategy mining success run_id=${runId}`,
    duration_ms: 1200,
    run_id: runId,
    run_date: runDate,
    metadata: { cadence: 'monthly', backend: 'modal' },
  }
  const unknownDispatch = await post('/api/internal/strategy-mining/callback', token, callbackBody, kv, db)
  assert.equal(unknownDispatch.status, 409)

  await kv.put(strategyMiningDispatchKey(runId), JSON.stringify({
    run_id: runId,
    run_date: runDate,
    status: 'accepted',
  }))
  const accepted = await post('/api/internal/strategy-mining/callback', token, callbackBody, kv, db)
  assert.equal(accepted.status, 200)
  const schedulerEntry = await kv.get(`scheduler:run:monthly-strategy-mining:${runDate}`, 'json')
  assert.equal(schedulerEntry.status, 'success')
  assert.equal(schedulerEntry.run_id, runId)

  const duplicate = await post('/api/internal/strategy-mining/callback', token, callbackBody, kv, db)
  assert.equal(duplicate.status, 200)
  assert.equal((await duplicate.json() as any).reason, 'duplicate_terminal_callback')

  const conflicting = await post('/api/internal/strategy-mining/callback', token, {
    ...callbackBody,
    status: 'error',
    error: 'late conflicting callback',
  }, kv, db)
  assert.equal(conflicting.status, 409)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
