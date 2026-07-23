import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { strategyDiscoveryRoutes } from '../routes/strategyDiscoveryRoutes'
import { signJWT } from '../lib/auth'

async function main() {
  const app = new Hono<any>()
  app.route('/', strategyDiscoveryRoutes)
  app.get('/api/health', (c) => c.json({ status: 'ok' }))
  const kv = { get: async () => null, put: async () => undefined }
  const env: any = { JWT_SECRET: 'test-secret', KV: kv }
  const health = await app.request('https://stockvision.invalid/api/health', {}, env)
  assert.equal(health.status, 200)
  const anonymous = await app.request('https://stockvision.invalid/api/dashboard-state', {}, env)
  assert.equal(anonymous.status, 401)
  const userToken = await signJWT({ sub: '2', email: 'user@example.com', role: 'user', name: 'User' }, env.JWT_SECRET)
  const forbidden = await app.request('https://stockvision.invalid/api/dashboard-state', { headers: { Authorization: `Bearer ${userToken}` } }, env)
  assert.equal(forbidden.status, 403)
  const adminToken = await signJWT({ sub: '1', email: 'admin@example.com', role: 'admin', name: 'Admin' }, env.JWT_SECRET)
  const wrongMime = await app.request('https://stockvision.invalid/api/runs/RUN-1/codex-result', { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Idempotency-Key': 'security-test-1', 'Content-Type': 'text/plain' }, body: 'x' }, env)
  assert.equal(wrongMime.status, 415)
  const tooLarge = await app.request('https://stockvision.invalid/api/runs/RUN-1/codex-result', { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Idempotency-Key': 'security-test-2', 'Content-Type': 'application/zip', 'Content-Length': String(21 * 1024 * 1024) }, body: 'x' }, env)
  assert.equal(tooLarge.status, 413)
}

void main()
