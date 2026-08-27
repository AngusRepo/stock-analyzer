import assert from 'node:assert/strict'
import { breeze2AdvisoryCacheKey, requestBreeze2FactCheck, type Breeze2FactCheckRequest } from './breeze2Runtime'
import type { Bindings } from '../types'


async function main() {
  const request: Breeze2FactCheckRequest = {
    symbol: '2330',
    stock_name: '台積電',
    trigger: 'morning_debate',
    reason: 'semantic_fact_check',
    theme: { score: 0.8, nested: { z: 2, a: 1 } },
    news: [{ title: 'immutable headline' }],
    evidence_items: [{ source: 'test', snippet: 'evidence' }],
    metadata: { run_date: '2026-08-27', rank: 1 },
    execute_modal: true,
    mutation_allowed: false,
    real_trading_allowed: false,
  }

  const reordered: Breeze2FactCheckRequest = {
    ...request,
    theme: { nested: { a: 1, z: 2 }, score: 0.8 },
    metadata: { rank: 1, run_date: '2026-08-27' },
  }
  assert.equal(await breeze2AdvisoryCacheKey(request), await breeze2AdvisoryCacheKey(reordered))
  assert.notEqual(
    await breeze2AdvisoryCacheKey(request),
    await breeze2AdvisoryCacheKey({ ...request, metadata: { ...request.metadata, run_date: '2026-08-28' } }),
  )

  const values = new Map<string, string>()
  let writtenTtl: number | undefined
  const kv = {
    async get(key: string, type?: string) {
      const raw = values.get(key)
      if (raw == null) return null
      return type === 'json' ? JSON.parse(raw) : raw
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      values.set(key, value)
      writtenTtl = options?.expirationTtl
    },
  } as unknown as KVNamespace
  const env = {
    KV: kv,
    ML_CONTROLLER_URL: 'https://controller.example',
  } as Bindings

  const report = {
    schema_version: 'breeze2-research-context-v1',
    allowed_use: 'research_context_only',
    decision_effect: 'advisory_only',
    primary_candidate_source_allowed: false,
    recommended_decision_context: 'neutral',
  }
  let fetchCalls = 0
  const fetcher = async () => {
    fetchCalls += 1
    return new Response(JSON.stringify(report), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  assert.deepEqual(await requestBreeze2FactCheck(env, request, 1_000, fetcher), report)
  assert.deepEqual(await requestBreeze2FactCheck(env, request, 1_000, fetcher), report)
  assert.equal(fetchCalls, 1, 'identical retry must reuse advisory cache')
  assert.equal(writtenTtl, 6 * 60 * 60)

  const changed = { ...request, symbol: '2317' }
  const invalidKey = await breeze2AdvisoryCacheKey(changed)
  values.set(invalidKey, JSON.stringify({ schema_version: 'tampered' }))
  await requestBreeze2FactCheck(env, changed, 1_000, fetcher)
  assert.equal(fetchCalls, 2, 'invalid cache entry must fail open to authoritative controller')

  console.log('breeze2 advisory cache tests passed')
}


void main()
