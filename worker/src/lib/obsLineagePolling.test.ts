import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { buildLiveObservabilityEventReport, buildEventsFromModelPool } from './observabilityEvents'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { llm } from '../routes/other'

test('normal OBS refresh skips lineage; explicit live diagnostics request it', async () => {
  const f = l4NativeFixture(), previousFetch = globalThis.fetch
  f.sqls.ops.exec(readFileSync(new URL('../../domain-migrations/ops/0011_scheduler_execution_tickets.sql', import.meta.url), 'utf8'))
  const requests: string[] = []
  const fetchFixture = async (input: any) => {
    const url = String(input); requests.push(url)
    if (url === 'https://controller.invalid/model_pool/lineage')
      return Response.json({ models: { LightGBM: { rolling_ic: 0.1 } } })
    throw new Error('offline fixture: ' + url)
  }
  f.env.ML_CONTROLLER_URL = 'https://controller.invalid'
  f.ports.fetchFrozen = fetchFixture
  globalThis.fetch = fetchFixture
  try {
    const ordinary = await buildLiveObservabilityEventReport(f.env, { date: '2026-09-14' })
    assert.equal(requests.filter(url => url.includes('/model_pool/lineage')).length, 0)
    assert.equal(ordinary.events.some(event => event.source === 'model_pool_lineage'), false,
      'skipped verification must not report lifecycle as healthy')
    assert.ok(ordinary.events.some(event => event.domain === 'scheduler'))
    requests.length = 0
    const diagnostic = await buildLiveObservabilityEventReport(f.env, { date: '2026-09-14', live: true })
    assert.equal(requests.filter(url => url.includes('/model_pool/lineage')).length, 1)
    assert.ok(diagnostic.events.some(event => event.source === 'model_pool_lineage'))
  } finally { globalThis.fetch = previousFetch; f.close() }
})

test('absent model evidence produces no false green; explicit reader error remains visible', () => {
  assert.deepEqual(buildEventsFromModelPool({ generatedAt: '2026-10-03T00:00:00Z' }), [])
  const events = buildEventsFromModelPool({ generatedAt: '2026-10-03T00:00:00Z', sourceError: 'timeout' })
  assert.equal(events[0].severity, 'error')
})

test('retired paid analysis endpoints return 410 without database or provider access', async () => {
  const previousFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network') }
  try {
    const env = { LOCAL_AUTH_BYPASS: '1', ENVIRONMENT: 'test' } as any
    for (const path of ['/technical-analysis', '/trading-advice', '/analyst-summary', '/ask']) {
      const response = await llm.request(path, { method: 'POST' }, env)
      assert.equal(response.status, 410)
      assert.equal((await response.json() as any).code, 'paid_llm_retired')
    }
    assert.equal(calls, 0)
  } finally { globalThis.fetch = previousFetch }
})
