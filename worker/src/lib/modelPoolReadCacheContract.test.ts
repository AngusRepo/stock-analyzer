/// <reference path="../cf-types.d.ts" />

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  MODEL_POOL_READ_CACHE_PREFIX,
  buildModelPoolControllerPath,
  invalidateModelPoolReadCache,
  modelPoolReadCacheKey,
  readThroughModelPoolCache,
  resolveModelPoolReadCacheTtl,
  shouldBypassModelPoolReadCache,
} from './modelPoolReadCache'

class FakeKV {
  store = new Map<string, string>()
  puts: Array<{ key: string; ttl?: number }> = []

  async get(key: string, type?: 'json'): Promise<any> {
    const value = this.store.get(key)
    if (value == null) return null
    return type === 'json' ? JSON.parse(value) : value
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, value)
    this.puts.push({ key, ttl: options?.expirationTtl })
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<{ keys: { name: string }[]; list_complete: boolean }> {
    const prefix = options?.prefix ?? ''
    const limit = options?.limit ?? 1000
    const keys = [...this.store.keys()]
      .filter((key) => key.startsWith(prefix))
      .slice(0, limit)
      .map((name) => ({ name }))
    return { keys, list_complete: true }
  }
}

async function main() {
  const dashboardRoutes = fs.readFileSync('src/routes/dashboardReadRoutes.ts', 'utf8')
  const dailyWorkflows = fs.readFileSync('src/lib/controllerDailyWorkflows.ts', 'utf8')
  const researchWorkflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
  assert(
    dashboardRoutes.includes('cachedModelPoolControllerJson<any>(c, \'/model_pool/lineage\')') &&
      dashboardRoutes.includes('readThroughModelPoolCache') &&
      dashboardRoutes.includes('invalidateModelPoolReadCache(c.env.KV)'),
    'dashboard model-pool proxy must use Worker KV read-through cache and invalidate after confirmed mutations',
  )
  assert(
    dailyWorkflows.includes("'/model_pool/compute_weekly_ic'") &&
      dailyWorkflows.includes('await invalidateModelPoolReadCache(env.KV)') &&
      researchWorkflows.includes("'/model_pool/artifact_registry/validation_chain'") &&
      researchWorkflows.includes('await invalidateModelPoolReadCache(env.KV)'),
    'scheduler-owned ModelPool mutations must invalidate Worker read cache after successful controller writes',
  )

  assert.equal(resolveModelPoolReadCacheTtl({}), 45)
  assert.equal(resolveModelPoolReadCacheTtl({ MODEL_POOL_PROXY_CACHE_TTL_SECONDS: '12' } as any), 12)
  assert.equal(resolveModelPoolReadCacheTtl({ MODEL_POOL_READ_CACHE_TTL_SECONDS: '999' } as any), 300)
  assert.equal(resolveModelPoolReadCacheTtl({ MODEL_POOL_PROXY_CACHE_TTL_SECONDS: 'bad' } as any), 0)

  assert.equal(shouldBypassModelPoolReadCache('true'), true)
  assert.equal(shouldBypassModelPoolReadCache(null, 'max-age=0, no-cache'), true)
  assert.equal(shouldBypassModelPoolReadCache('0'), false)

  const path = buildModelPoolControllerPath('/model_pool/artifact_registry', {
    model_name: 'XGBoost',
    limit: 10,
    empty: '',
  }, { bypassCache: true })
  assert.equal(path, '/model_pool/artifact_registry?model_name=XGBoost&limit=10&bypass_cache=true')
  assert(modelPoolReadCacheKey(path).startsWith(MODEL_POOL_READ_CACHE_PREFIX))

  const kv = new FakeKV()
  let fetches = 0
  const first = await readThroughModelPoolCache(kv as unknown as KVNamespace, '/model_pool/lineage', async () => {
    fetches += 1
    return { version: fetches }
  }, { ttlSeconds: 45 })
  const second = await readThroughModelPoolCache(kv as unknown as KVNamespace, '/model_pool/lineage', async () => {
    fetches += 1
    return { version: fetches }
  }, { ttlSeconds: 45 })
  assert.deepEqual(first, { version: 1 })
  assert.deepEqual(second, { version: 1 })
  assert.equal(fetches, 1)
  assert.equal(kv.puts[0]?.ttl, 45)

  const bypassed = await readThroughModelPoolCache(kv as unknown as KVNamespace, '/model_pool/lineage', async () => {
    fetches += 1
    return { version: fetches }
  }, { ttlSeconds: 45, bypassCache: true })
  assert.deepEqual(bypassed, { version: 2 })

  const invalidated = await invalidateModelPoolReadCache(kv as unknown as KVNamespace)
  assert.equal(invalidated.deleted, 1)
  assert.equal(kv.store.size, 0)
}

main()
