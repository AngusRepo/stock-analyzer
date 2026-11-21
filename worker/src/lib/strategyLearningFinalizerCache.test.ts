import assert from 'node:assert/strict'
import test from 'node:test'
import { openStrategyLearningFinalizerCache, strategyLearningFinalizerCacheKey } from './strategyLearningFinalizerCache'

function kv() {
  const values = new Map<string, string>(), ttls = new Map<string, number | undefined>()
  return { values, ttls, binding: {
    get: async (key: string, type?: string) => { const value = values.get(key); return value == null ? null : type === 'json' ? JSON.parse(value) : value },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => { values.set(key, value); ttls.set(key, options?.expirationTtl) },
  } as unknown as KVNamespace }
}

test('a later finalizer attempt of either path resumes from the stages an earlier attempt persisted', async () => {
  const store = kv()
  const first = await openStrategyLearningFinalizerCache(store.binding, { runDate: '2026-11-10', canonicalRunId: 'run-A', policyMutationAllowed: false })
  assert.deepEqual(first.stages, {})
  await first.persist('selection_labels', { persisted_rows: 3 })
  await first.persist('reward_ledger', undefined)
  const key = strategyLearningFinalizerCacheKey('2026-11-10', 'run-A', 'evidence-only')
  assert.equal(store.ttls.get(key), 7 * 24 * 3600)
  const next = await openStrategyLearningFinalizerCache(store.binding, { runDate: '2026-11-10', canonicalRunId: 'run-A', policyMutationAllowed: false })
  assert.deepEqual(next.stages, { selection_labels: { persisted_rows: 3 }, reward_ledger: null })
  // Another cache mode is another checkpoint.
  const policy = await openStrategyLearningFinalizerCache(store.binding, { runDate: '2026-11-10', canonicalRunId: 'run-A', policyMutationAllowed: true })
  assert.equal(policy.mode, 'policy-mutation')
  assert.deepEqual(policy.stages, {})
})

test('a fresh open ignores the stored stages and its persist replaces the checkpoint', async () => {
  const store = kv()
  const first = await openStrategyLearningFinalizerCache(store.binding, { runDate: '2026-11-10', canonicalRunId: 'run-A', policyMutationAllowed: false })
  await first.persist('selection_labels', { persisted_rows: 3 })
  await first.persist('reward_ledger', { rows: 1 })
  const repair = await openStrategyLearningFinalizerCache(store.binding, { runDate: '2026-11-10', canonicalRunId: 'run-A', policyMutationAllowed: false, fresh: true })
  assert.deepEqual(repair.stages, {})
  await repair.persist('selection_labels', { persisted_rows: 5 })
  const next = await openStrategyLearningFinalizerCache(store.binding, { runDate: '2026-11-10', canonicalRunId: 'run-A', policyMutationAllowed: false })
  assert.deepEqual(next.stages, { selection_labels: { persisted_rows: 5 } })
})

test('a checkpoint written for another canonical run is ignored', async () => {
  const store = kv()
  store.values.set(strategyLearningFinalizerCacheKey('2026-11-10', 'run-A', 'evidence-only'),
    JSON.stringify({ canonical_run_id: 'run-B', stages: { selection_labels: {} } }))
  const cache = await openStrategyLearningFinalizerCache(store.binding, { runDate: '2026-11-10', canonicalRunId: 'run-A', policyMutationAllowed: false })
  assert.deepEqual(cache.stages, {})
})
