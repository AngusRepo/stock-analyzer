import assert from 'node:assert/strict'
import { adminConfigWorkflowRoutes } from '../routes/adminConfigWorkflowRoutes'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'
import type { Bindings } from '../types'

class FakeKV {
  store = new Map<string, string>()

  async get(key: string, mode?: string) {
    const value = this.store.get(key)
    if (value == null) return null
    return mode === 'json' ? JSON.parse(value) : value
  }

  async put(key: string, value: string) {
    this.store.set(key, value)
  }
}

class FakeStatement {
  constructor(readonly sql: string) {}
  bind() { return this }
  async run() { return { success: true } }
  async first() { return null }
}

class FakeDB {
  prepare(sql: string) { return new FakeStatement(sql) }
  async batch(statements: FakeStatement[]) { return statements.map(() => ({ success: true })) }
}

void (async () => {
  const sandboxId = 'trading:config:sandbox:research_sweep:test'
  const kv = new FakeKV()
  await kv.put('trading:config', JSON.stringify(DEFAULT_TRADING_CONFIG))
  const productionBefore = kv.store.get('trading:config')
  await kv.put(sandboxId, JSON.stringify({
    config: DEFAULT_TRADING_CONFIG,
    source: 'research_sweep',
    pushed_at: new Date().toISOString(),
    hash: 'deadbeef',
  }))

  const env = {
    KV: kv,
    DB: new FakeDB(),
    STOCKVISION_AUTH_TOKEN: 'service-token',
  } as unknown as Bindings

  const response = await adminConfigWorkflowRoutes.request('/api/admin/config/promote', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer service-token',
      'Content-Type': 'application/json',
      'X-Confirm-Prod': 'true',
    },
    body: JSON.stringify({
      sandbox_id: sandboxId,
      dry_run: false,
      reason: 'attempt without candidate evidence',
    }),
  }, env)

  assert.equal(response.status, 409)
  const body = await response.json() as any
  assert.equal(body.error, 'parameter_candidate_evidence_required')
  assert.equal(body.detail, 'promotion_packet_id_required')
  assert.equal(kv.store.get('trading:config'), productionBefore, 'rejected promotion must not mutate production config')
})()
