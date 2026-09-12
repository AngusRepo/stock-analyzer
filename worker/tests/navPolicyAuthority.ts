// Original authenticated Controller HTTP result, transported through the real
// Worker client in a private request-local port. No external network or orders.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { verifyNavPolicyPromotionEvidence } from '../src/lib/pairedNavPromotionEvidence'
import { withPaperExecutionScope } from '../src/lib/paperExecutionScope'

const original = JSON.parse(fs.readFileSync(process.env.NAV_POLICY_AUTHORITY_FIXTURE!, 'utf8'))
const now = new Date(original.observed_at)
const env = { ML_CONTROLLER_URL: 'https://controller.invalid', ML_CONTROLLER_SECRET: 'isolated-nav-test-token' } as any
const db = { prepare() { assert.fail('unqualified policy must fail before reading or writing D1') } } as any

async function rejected({ payload = original.payload, response = original, reason = /gate_identity_invalid/,
  environment = env, expectedCalls = 1, status = 200 }: any = {}) {
  let calls = 0
  await withPaperExecutionScope({ accountId: 1, nowMs: now.getTime(), environment,
    databases: {}, fetchFrozen: async (url, init) => {
      calls++
      assert.equal(String(url), 'https://controller.invalid/nav/policy-decision')
      assert.equal(init?.method, 'POST')
      assert.equal(new Headers(init?.headers).get('X-Controller-Token'), 'isolated-nav-test-token')
      const request = JSON.parse(String(init?.body))
      assert.deepEqual(request, { owner: 'l15_route', candidate_artifact_id: payload.artifact_id,
        candidate_checksum: payload.artifact_checksum, business_date: payload.evaluation_business_date })
      assert.deepEqual(Object.keys(request).sort(), ['business_date', 'candidate_artifact_id', 'candidate_checksum', 'owner'])
      return new Response(JSON.stringify(response), { status, headers: { 'Content-Type': 'application/json' } })
    },
  }, async () => {
    await assert.rejects(() => verifyNavPolicyPromotionEvidence(db, environment,
      { owner: 'l15_route', payload }, now), reason)
  })
  assert.equal(calls, expectedCalls)
}

test('original PENDING cannot become a policy publication proof', async () => {
  assert.equal(original.payload.prospective_validation.decision, 'PENDING')
  await rejected()
})

test('caller PASS, version and policy edits cannot replace original authority', async () => {
  for (const mutate of [
    (p: any) => { p.prospective_validation.decision = 'PASS' },
    (p: any) => { p.policy_definition.challenger_version = 'caller-version' },
    (p: any) => { p.prospective_validation.nav_validation.evaluable_date_count = 30 },
  ]) {
    const payload = structuredClone(original.payload)
    mutate(payload)
    await rejected({ payload, reason: /policy_original_decision_changed/ })
  }
})

test('missing controller auth and original endpoint failure do not fall back to caller evidence', async () => {
  await rejected({ environment: { ...env, ML_CONTROLLER_SECRET: '' }, expectedCalls: 0,
    reason: /policy_controller_auth_missing/ })
  await rejected({ response: { detail: 'nav_policy_original_allocation_missing' }, status: 409, reason: /HTTP 409/ })
})

test('cached, future, wrong-owner and incomplete authority responses cannot issue a proof', async () => {
  for (const change of [{ observed_at: '2020-01-01T00:00:00Z' },
    { observed_at: '2099-01-01T00:00:00Z' }, { owner: 'atomic_strategy' },
    { read_only: false }, { source: 'model_registry' }, { observed_at: '2026-09-07 14:00:00' }]) {
    await rejected({ response: { ...original, ...change }, reason: /policy_original_decision_changed/ })
  }
})
