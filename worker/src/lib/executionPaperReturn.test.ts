import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { signJWT } from './auth'
import { executionSubmissionControl } from './executionPaperReturn'
import { adminWriteRoutes } from '../routes/adminWriteRoutes'
import type { Bindings, Variables } from '../types'

async function main() {
const env = { ML_CONTROLLER_URL: 'https://controller.invalid', ML_CONTROLLER_SECRET: 'test-controller-token' }
const command = { request_id: 'r1', reason: 'admin_return' }
const calls: Array<{ url: string; body: string }> = []
const lostAck = (async (url, options) => {
  calls.push({ url: String(url), body: String(options?.body) })
  assert.equal((options?.headers as Record<string, string>)['X-Controller-Token'], env.ML_CONTROLLER_SECRET)
  throw new Error('response lost')
}) as typeof fetch
const uncertain = await executionSubmissionControl(env, command, lostAck)
assert.equal(uncertain.status, 'unknown')
assert.equal(calls.length, 1, 'stop request is not automatically retried')
assert.equal(calls[0].url, 'https://controller.invalid/finlab/execution/return-to-paper')
assert.deepEqual(JSON.parse(calls[0].body), command)
const incomplete = await executionSubmissionControl(env, command,
  (async () => Response.json({ status: 'live_submission_paused' })) as typeof fetch)
assert.equal(incomplete.status, 'unknown')
const stopped = { status: 'live_submission_paused', receipt: { sha256: 'receipt-sha' } }
assert.deepEqual(await executionSubmissionControl(env, command,
  (async () => Response.json(stopped)) as typeof fetch), stopped)

// Real route authentication: neither anonymous callers nor non-admin JWTs can reach control.
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
app.route('/', adminWriteRoutes)
const bindings = { JWT_SECRET: 'test-jwt-key', ENVIRONMENT: 'production' } as Bindings
const body = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: 'r1' }) }
assert.equal((await app.request('https://worker.invalid/api/admin/execution/return-to-paper', body, bindings)).status, 401)
const jwt = await signJWT({ sub: '2', role: 'user' }, bindings.JWT_SECRET)
assert.equal((await app.request('https://worker.invalid/api/admin/execution/return-to-paper', {
  ...body, headers: { ...body.headers, Authorization: `Bearer ${jwt}` },
}, bindings)).status, 403)
const admin = await signJWT({ sub: '1', role: 'admin' }, bindings.JWT_SECRET)
const disabled = await app.request('https://worker.invalid/api/admin/execution/return-to-paper', {
  ...body, headers: { ...body.headers, Authorization: `Bearer ${admin}` },
}, bindings)
assert.equal(disabled.status, 200)
assert.equal((await disabled.json() as { status: string }).status, 'blocked', 'unconfigured gateway never claims a stop')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
