import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { signJWT } from './auth'
import { executionSubmissionControl } from './executionSubmissionControl'
import { adminWriteRoutes } from '../routes/adminWriteRoutes'
import type { Bindings, Variables } from '../types'

async function main() {
  const env = { ML_CONTROLLER_URL: 'https://controller.invalid', ML_CONTROLLER_SECRET: 'test-controller-token' }
  const pause = { kind: 'pause' as const, request_id: 'r1', actor: 'admin:1', reason: 'admin_return_to_paper' }
  const sha = 'a'.repeat(64)
  const resume = {
    kind: 'resume' as const, request_id: 'r2', actor: 'admin:1', reason: 'gate passed',
    approval_scope: 'wei-live', approval_expires_at: '2026-12-31T05:30:00+00:00', gate_receipt_sha256: sha,
  }

  // A lost ACK is unknown and never retried.
  const calls: Array<{ url: string; body: string; method: string }> = []
  const lostAck = (async (url, options) => {
    calls.push({ url: String(url), body: String(options?.body), method: String(options?.method) })
    assert.equal((options?.headers as Record<string, string>)['X-Controller-Token'], env.ML_CONTROLLER_SECRET)
    throw new Error('response lost')
  }) as typeof fetch
  assert.equal((await executionSubmissionControl(env, pause, lostAck)).status, 'unknown')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://controller.invalid/finlab/execution/return-to-paper')
  assert.deepEqual(JSON.parse(calls[0].body), { request_id: 'r1', actor: 'admin:1', reason: 'admin_return_to_paper' })
  assert.equal((await executionSubmissionControl(env, resume, lostAck)).status, 'unknown')
  assert.equal(calls[1].url, 'https://controller.invalid/finlab/execution/resume')
  assert.equal(JSON.parse(calls[1].body).gate_receipt_sha256, sha)

  const reply = (payload: unknown, status = 200) => (async () => Response.json(payload, { status })) as typeof fetch
  // A pause reply without a receipt, or an explicit unconfirmed write, is not a stop.
  assert.equal((await executionSubmissionControl(env, pause, reply({ status: 'live_submission_paused' }))).status, 'unknown')
  assert.equal((await executionSubmissionControl(env, pause, reply({
    status: 'live_submission_paused', receipt: { sha256: 's' }, pause_confirmed: false,
  }))).status, 'unknown')
  // A pause reply that reads open is never shown as stopped.
  assert.equal((await executionSubmissionControl(env, pause, reply({
    status: 'live_submission_open', receipt: { sha256: 's' },
  }))).status, 'unknown')
  // A paused reply whose receipt is a lapsed resume row is not a durable stop.
  assert.equal((await executionSubmissionControl(env, pause, reply({
    status: 'live_submission_paused', receipt: { sha256: 's', action: 'resume' },
  }))).status, 'unknown')
  const stopped = { status: 'live_submission_paused', receipt: { sha256: 'receipt-sha', action: 'pause' } }
  assert.deepEqual(await executionSubmissionControl(env, pause, reply(stopped)), stopped)
  // Resume needs its own resume receipt; a conflict is surfaced as rejected.
  assert.equal((await executionSubmissionControl(env, resume, reply({ status: 'live_submission_open' }))).status, 'unknown')
  assert.equal((await executionSubmissionControl(env, resume, reply({
    status: 'live_submission_paused', resume_receipt: { sha256: 's', action: 'pause' },
  }))).status, 'unknown')
  const resumed = { status: 'live_submission_open', resume_receipt: { sha256: 'r', action: 'resume' } }
  assert.deepEqual(await executionSubmissionControl(env, resume, reply(resumed)), resumed)
  assert.deepEqual(await executionSubmissionControl(env, resume, reply({ detail: 'live_resume_approval_mismatch' }, 409)),
    { status: 'rejected', reason: 'live_resume_approval_mismatch' })
  // Malformed commands never leave the Worker.
  const never = (async () => { throw new Error('must not call') }) as typeof fetch
  assert.equal((await executionSubmissionControl(env, { ...resume, gate_receipt_sha256: 'short' }, never)).reason,
    'execution_control_request_invalid')
  assert.equal((await executionSubmissionControl(env, { ...pause, request_id: ' ' }, never)).reason,
    'execution_control_request_invalid')
  assert.equal((await executionSubmissionControl({ ML_CONTROLLER_URL: '', ML_CONTROLLER_SECRET: '' }, pause, never)).status,
    'blocked')
  // State read is a GET without body.
  const seen: string[] = []
  await executionSubmissionControl(env, { kind: 'state' }, (async (url, options) => {
    seen.push(`${options?.method} ${url} ${options?.body ?? ''}`)
    return Response.json(stopped)
  }) as typeof fetch)
  assert.deepEqual(seen, ['GET https://controller.invalid/finlab/execution/submission-state '])

  // Route authentication: anonymous and non-admin callers never reach control.
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
  app.route('/', adminWriteRoutes)
  const bindings = { JWT_SECRET: 'test-jwt-key', ENVIRONMENT: 'production' } as Bindings
  for (const path of ['return-to-paper', 'resume']) {
    const url = `https://worker.invalid/api/admin/execution/${path}`
    const body = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: 'r1' }) }
    assert.equal((await app.request(url, body, bindings)).status, 401)
    const user = await signJWT({ sub: '2', role: 'user' }, bindings.JWT_SECRET)
    assert.equal((await app.request(url, { ...body, headers: { ...body.headers, Authorization: `Bearer ${user}` } }, bindings)).status, 403)
  }
  {
    const url = 'https://worker.invalid/api/admin/execution/submission-state'
    assert.equal((await app.request(url, {}, bindings)).status, 401)
    const user = await signJWT({ sub: '2', role: 'user' }, bindings.JWT_SECRET)
    assert.equal((await app.request(url, { headers: { Authorization: `Bearer ${user}` } }, bindings)).status, 403)
  }
  const admin = await signJWT({ sub: '1', role: 'admin' }, bindings.JWT_SECRET)
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }
  const missing = await app.request('https://worker.invalid/api/admin/execution/resume',
    { method: 'POST', headers: auth, body: JSON.stringify({ request_id: 'r1' }) }, bindings)
  assert.equal(missing.status, 400)
  const unconfigured = await app.request('https://worker.invalid/api/admin/execution/return-to-paper',
    { method: 'POST', headers: auth, body: JSON.stringify({ request_id: 'r1' }) }, bindings)
  assert.equal(unconfigured.status, 200)
  assert.equal((await unconfigured.json() as { status: string }).status, 'blocked', 'unconfigured controller never claims a stop')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
