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

  const env = {
    ML_CONTROLLER_URL: 'https://controller.example',
    KV: new Proxy({}, { get() { throw new Error('retired provider accessed KV') } }),
  } as Bindings
  let fetchCalls = 0
  const fetcher = async () => { fetchCalls++; throw new Error('retired provider fetched') }
  for (const execute_modal of [true, false]) {
    assert.equal(await requestBreeze2FactCheck(env, { ...request, execute_modal }, 1000, fetcher), null)
  }
  assert.equal(fetchCalls, 0, 'retired provider must never invoke Controller/Modal')

  console.log('breeze2 retirement and historical identity tests passed')
}


void main()
