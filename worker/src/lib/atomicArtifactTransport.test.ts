import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adminControlRoutes } from '../routes/adminControlRoutes'
import { RestAtomicArtifactReader } from '../node-runner/cloudflareRestBindings'

const key = 'evidence/class=canonical_model_evidence/domain=screener_funnel_chunk/business_date=2026-09-21/chunk=x.json'
const body = '{"frozen":true}'
const request = (value: unknown, token = 'test-service') => new Request('https://local.test/api/internal/evidence-artifacts/atomic-source/read', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
function bindings(size: number, exists = true, actualSize = size) {
  let reads = 0
  const db = { prepare: () => ({ bind: () => ({ first: async () => exists ? { byte_size: size } : null }) }) }
  const env = { DB: db, OPS_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops', MULTI_D1_STRICT: 'true',
    STOCKVISION_AUTH_TOKEN: 'test-service', ARTIFACTS: { get: async () => { reads++
      return { size: actualSize, body: new Response(body).body, text: () => { throw Error('must stream') } } } } }
  return { env: env as any, reads: () => reads }
}

test('Atomic raw transport authenticates and streams only bounded ready manifests', async () => {
  const b = bindings(Buffer.byteLength(body))
  assert.equal((await adminControlRoutes.fetch(request({ r2_key: key }, 'wrong'), b.env)).status, 401)
  assert.equal((await adminControlRoutes.fetch(request({ r2_key: 'private/key' }), b.env)).status, 400)
  assert.equal((await adminControlRoutes.fetch(request({ r2_key: key, url: 'https://elsewhere.test' }), b.env)).status, 400)
  assert.equal(b.reads(), 0)
  const ok = await adminControlRoutes.fetch(request({ r2_key: key }), b.env)
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), body)
  assert.equal(b.reads(), 1)
  const missing = bindings(10, false)
  assert.equal((await adminControlRoutes.fetch(request({ r2_key: key }), missing.env)).status, 404)
  assert.equal(missing.reads(), 0)
  const big = bindings(8 * 1024 * 1024 + 1)
  assert.equal((await adminControlRoutes.fetch(request({ r2_key: key }), big.env)).status, 413)
  assert.equal(big.reads(), 0)
  const mismatch = bindings(20, true, 10)
  assert.equal((await adminControlRoutes.fetch(request({ r2_key: key }), mismatch.env)).status, 409)
})

test('Node artifact adapter consumes exact raw bytes and fails closed on transport errors', async () => {
  const old = globalThis.fetch
  try {
    const b = bindings(Buffer.byteLength(body))
    globalThis.fetch = async (input: any, init: any) => adminControlRoutes.fetch(new Request(input, init), b.env)
    const reader = new RestAtomicArtifactReader({ workerUrl: 'https://local.test', serviceToken: 'test-service', maxRetries: 0 })
    assert.equal(await reader.read(key), body)
    await assert.rejects(reader.read('arbitrary/key'), /atomic_artifact_key_invalid/)
    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    await assert.rejects(reader.read(key), /atomic_artifact_read_http_503/)
  } finally { globalThis.fetch = old }
})
