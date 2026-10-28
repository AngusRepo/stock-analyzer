import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bindings } from '../types'
import { R33_MONTHLY_MODEL_PROFILE, runActive8OofLifecycle } from './controllerResearchWorkflows'
import { SINGLE_B_TABPACK } from './paperStrategyMode'

async function profileSent(cadence: 'daily' | 'weekly' | 'monthly', flag?: string): Promise<Record<string, unknown>> {
  const previousFetch = globalThis.fetch
  let request: Record<string, unknown> = {}
  globalThis.fetch = async (_input, init) => {
    request = JSON.parse(String(init?.body))
    return Response.json({ status: 'spawned', promoted: false })
  }
  const env = {
    KV: { get: async () => ({ l4Distribution: { operating_mode: SINGLE_B_TABPACK } }) },
    ML_CONTROLLER_URL: 'https://isolated-controller.invalid',
    ACTIVE8_FEATURE_SEMANTIC_VERSION: 'formal131-without-unverified-daily-owners-v1',
    ...(flag === undefined ? {} : { R33_MONTHLY_PROFILE: flag }),
  } as unknown as Bindings
  try {
    await runActive8OofLifecycle(env, '2026-10-30', cadence)
  } finally { globalThis.fetch = previousFetch }
  return request
}

test('R33_MONTHLY_PROFILE=1 sends only the monthly lifecycle to the R33 profile', async () => {
  const monthly = await profileSent('monthly', '1')
  assert.equal(R33_MONTHLY_MODEL_PROFILE, 'active8-release-model-profiles-v7-r33-exo131')
  assert.equal(monthly.model_profile_schema_version, R33_MONTHLY_MODEL_PROFILE)
  assert.equal(monthly.cadence, 'monthly')
  assert.equal(monthly.promote, false, 'R33 monthly candidates never promote')
  const weekly = await profileSent('weekly', '1')
  assert.equal(weekly.model_profile_schema_version, 'active8-release-model-profiles-v6-timexer-exo131')
})

test('without the flag monthly keeps the existing profile', async () => {
  for (const flag of [undefined, '0', 'true']) {
    const monthly = await profileSent('monthly', flag)
    assert.equal(monthly.model_profile_schema_version, 'active8-release-model-profiles-v6-timexer-exo131')
  }
})
