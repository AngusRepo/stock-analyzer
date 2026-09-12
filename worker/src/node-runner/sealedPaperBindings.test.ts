import assert from 'node:assert/strict'
import test from 'node:test'
import { sealedPaperBindings } from './sealedPaperBindings'
import { withPaperExecutionScope } from '../lib/paperExecutionScope'

test('private bindings overwrite attempted DB capabilities and refuse actual credentials', () => {
  const ports = sealedPaperBindings(async () => null, { DB: 'foreign', KV: 'foreign', ARTIFACTS: 'foreign' })
  assert.equal(ports.environment.DB, ports.databases.core)
  assert.equal(ports.environment.PAPER_DB, ports.databases.paper)
  assert.notEqual(ports.databases.core, ports.databases.paper)
  assert.equal(typeof ports.environment.KV.get, 'function')
  assert.throws(() => sealedPaperBindings(async () => null, { FINMIND_TOKEN: 'synthetic-secret' }), /credentials_forbidden/)
})

test('native SQL bridge retains actual data-domain ownership', async () => {
  const calls: any[] = []
  const ports = sealedPaperBindings(async (op, payload) => {
    calls.push({ op, payload }); return { success: true, results: [] }
  }, {})
  await ports.databases.market.prepare('SELECT * FROM stock_prices WHERE stock_id=?').bind(1).all()
  await ports.databases.learning.prepare('SELECT * FROM predictions').all()
  assert.deepEqual(calls.map(c => c.payload.domain), ['market', 'learning'])
})

test('private outbound requests carry no auth header and only consume bridge responses', async () => {
  const calls: unknown[] = []
  const ports = sealedPaperBindings(async (op, payload) => {
    calls.push({ op, payload }); return { status: 200, body: '{"ok":true}', headers: {} }
  }, {})
  const result = await ports.fetchFrozen('https://sealed.invalid/read', {
    headers: { Authorization: 'Bearer synthetic-secret' }, method: 'POST', body: '{}',
  })
  assert.deepEqual(await result.json(), { ok: true })
  assert.deepEqual(calls, [{ op: 'frozen_fetch', payload: { url: 'https://sealed.invalid/read', method: 'POST', body: '{}' } }])
})

test('caught malformed KV and forbidden queue cannot hide an incomplete native scope', async () => {
  const ports = sealedPaperBindings(async () => '{broken', {})
  await assert.rejects(withPaperExecutionScope({ ...ports, accountId: 2, nowMs: 1 }, async () => {
    await ports.environment.KV.get('config', 'json').catch(() => null)
  }), /scope_incomplete/)
  const next = sealedPaperBindings(async () => null, {})
  await assert.rejects(withPaperExecutionScope({ ...next, accountId: 2, nowMs: 1 }, async () => {
    try { await next.environment.UPDATE_QUEUE.send({ symbol: '2330', stockId: 1 } as any) } catch {}
  }), /scope_incomplete/)
})

test('drain waits for fire-and-forget mutations and refuses caught late failures', async () => {
  let release!: () => void
  const ports = sealedPaperBindings(() => new Promise((_resolve, reject) => {
    release = () => reject(new Error('late_write_failed'))
  }), {})
  void ports.environment.KV.put('key', 'value').catch(() => undefined)
  await Promise.resolve()
  let completed = false
  const drained = ports.drain().finally(() => { completed = true })
  await Promise.resolve()
  assert.equal(completed, false)
  release()
  await assert.rejects(drained, /pending_operation_failed/)
})
