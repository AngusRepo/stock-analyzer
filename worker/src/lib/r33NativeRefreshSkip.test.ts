import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bindings } from '../types'
import { R33_MONTHLY_MODEL_PROFILE, runActive8OofLifecycle } from './controllerResearchWorkflows'
import { R33_EQUAL7_ISOTONIC, SINGLE_B_TABPACK } from './paperStrategyMode'

// Major 3: under R33 the exo137 weekly/monthly cohort would only feed the native L4 refresh.
async function run(mode: string, cadence: 'daily' | 'weekly' | 'monthly', flag?: string, runDate: string | null = '2026-11-13') {
  const previousFetch = globalThis.fetch
  const requests: Record<string, unknown>[] = [], logs: unknown[][] = []
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({ status: 'spawned', promoted: false })
  }
  const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ run: async () => { logs.push([sql, ...args]); return { success: true } } }) }) }
  const env = {
    KV: { get: async () => ({ l4Distribution: { operating_mode: mode } }) },
    ML_CONTROLLER_URL: 'https://isolated-controller.invalid',
    ACTIVE8_FEATURE_SEMANTIC_VERSION: 'formal131-without-unverified-daily-owners-v1',
    OPS_DB: db, DB: db,
    ...(flag === undefined ? {} : { R33_MONTHLY_PROFILE: flag }),
  } as unknown as Bindings
  let summary = ''
  try { summary = await runActive8OofLifecycle(env, runDate ?? undefined, cadence) } finally { globalThis.fetch = previousFetch }
  return { summary, requests, logs }
}

test('R33 weekly and monthly (without the R33 profile) skip the dispatch and write system_log', async () => {
  for (const cadence of ['weekly', 'monthly'] as const) {
    const { summary, requests, logs } = await run(R33_EQUAL7_ISOTONIC, cadence)
    assert.equal(requests.length, 0)
    assert.match(summary, /status=skipped reason=r33_has_no_native_l4_refresh job_dispatched=false/)
    assert.equal(logs.length, 1)
    assert.match(String(logs[0][0]), /INSERT INTO system_logs/)
    assert.deepEqual(logs[0].slice(1, 4), ['warn', 'active8-oof-' + cadence, 'R33: native L4 refresh skipped'])
  }
})

test('R33 daily closure and the R33 monthly lifecycle still dispatch; other modes are unchanged', async () => {
  // Daily (no run date: no date fences) dispatches the closure job, never the R33 skip.
  const daily = await run(R33_EQUAL7_ISOTONIC, 'daily', undefined, null)
  assert.equal(daily.requests.length, 1); assert.equal(daily.logs.length, 0)
  const monthly = await run(R33_EQUAL7_ISOTONIC, 'monthly', '1')
  assert.equal(monthly.requests[0].model_profile_schema_version, R33_MONTHLY_MODEL_PROFILE)
  assert.equal(monthly.logs.length, 0)
  for (const cadence of ['weekly', 'monthly'] as const) {
    const other = await run(SINGLE_B_TABPACK, cadence)
    assert.equal(other.requests.length, 1); assert.equal(other.logs.length, 0)
  }
})
