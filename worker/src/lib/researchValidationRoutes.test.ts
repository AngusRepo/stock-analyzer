import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { researchValidationRoutes } from '../routes/researchValidationRoutes'

async function run() {
const app = new Hono()
app.route('/', researchValidationRoutes)
const env = {
  STOCKVISION_AUTH_TOKEN: 'local-contract-only',
  ML_CONTROLLER_URL: 'https://controller.fixture',
  ML_CONTROLLER_SECRET: 'local-controller-only',
}
const original = globalThis.fetch
const calls: Array<{ url: string; init: RequestInit | undefined }> = []
globalThis.fetch = async (input, init) => {
  calls.push({ url: String(input), init })
  return new Response(JSON.stringify({ status: 'INSUFFICIENT', promotion_authority: false }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
}
try {
  const denied = await app.request('/api/admin/research-validation/runs', {}, env)
  assert.equal(denied.status, 401)
  assert.equal(calls.length, 0)
  const headers = { Authorization: `Bearer ${env.STOCKVISION_AUTH_TOKEN}`, 'Content-Type': 'application/json' }
  const missing = await app.request('/api/admin/research-validation/run', { headers }, env)
  assert.equal(missing.status, 400)
  const runs = await app.request('/api/admin/research-validation/runs', { headers }, env)
  assert.equal(runs.status, 200)
  assert.equal(runs.headers.get('Cache-Control'), 'no-store')
  assert.equal(calls[0].url, 'https://controller.fixture/research_validation/runs')
  assert.equal(new Headers(calls[0].init?.headers).get('X-Controller-Token'), env.ML_CONTROLLER_SECRET)
  const encoded = await app.request('/api/admin/research-validation/run?run_key=mining%3Arun%26other', { headers }, env)
  assert.equal(encoded.status, 200)
  assert.equal(calls[1].url, 'https://controller.fixture/research_validation/run?run_key=mining%3Arun%26other')
  assert.equal((await app.request('/api/admin/research-validation/production_bundle', { headers }, env)).status, 200)
  const causal = await app.request('/api/admin/research-validation/causal', {
    method: 'POST', headers, body: JSON.stringify({ candidate_id: 'fixture', symbols: ['2330'] }),
  }, env)
  assert.equal(causal.status, 200)
  assert.equal(calls.at(-1)?.init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { candidate_id: 'fixture', symbols: ['2330'] })
  const invalid = await app.request('/api/admin/research-validation/causal', { method: 'POST', headers, body: 'broken' }, env)
  assert.equal(invalid.status, 400)
} finally { globalThis.fetch = original }

}
void run().catch(error => { console.error(error); process.exitCode = 1 })
