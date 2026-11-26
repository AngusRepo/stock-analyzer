import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  readStaleWhileRevalidate,
  readThroughWorkerCache,
  resetWorkerReadCacheMemory,
  shouldBypassWorkerReadCache,
  WORKER_READ_CACHE_MEMORY_TOTAL_CHARS,
  workerReadCacheMemoryChars,
  workerReadCacheHeaders,
  workerReadCacheKey,
} from './workerReadCache'

class FakeKv {
  store = new Map<string, string>()
  puts: Array<{ key: string; ttl?: number }> = []
  gets = 0
  async get(key: string) { this.gets += 1; return this.store.get(key) ?? null }
  async put(key: string, value: string, options?: { expirationTtl?: number }) {
    this.puts.push({ key, ttl: options?.expirationTtl })
    this.store.set(key, value)
  }
}

let clock = Date.parse('2026-11-26T02:00:00Z')
const now = () => clock
beforeEach(() => { resetWorkerReadCacheMemory(); clock = Date.parse('2026-11-26T02:00:00Z') })

test('cache key sorts parts and drops empty values', () => {
  assert.equal(workerReadCacheKey('x:v1', { b: '2', a: 1, c: null, d: '' }), 'cache:read:v1:x:v1?a=1&b=2')
  assert.equal(workerReadCacheKey('x:v1'), 'cache:read:v1:x:v1')
})

test('miss reads the source once, then memory, then KV in another isolate, until the TTL', async () => {
  const kv = new FakeKv()
  let calls = 0
  const fetcher = async () => ({ n: ++calls })
  const first = await readThroughWorkerCache(kv as any, 'k', fetcher, { ttlSeconds: 300, nowMs: now })
  assert.equal(first.status, 'miss')
  assert.deepEqual(first.value, { n: 1 })
  assert.deepEqual(kv.puts, [{ key: 'k', ttl: 300 }])

  clock += 10_000
  const second = await readThroughWorkerCache(kv as any, 'k', fetcher, { ttlSeconds: 300, nowMs: now })
  assert.equal(second.status, 'memory')
  assert.equal(second.ageSeconds, 10)

  resetWorkerReadCacheMemory()
  const third = await readThroughWorkerCache(kv as any, 'k', fetcher, { ttlSeconds: 300, nowMs: now })
  assert.equal(third.status, 'kv')
  assert.equal(calls, 1)

  clock += 300_000
  const expired = await readThroughWorkerCache(kv as any, 'k', fetcher, { ttlSeconds: 300, nowMs: now })
  assert.equal(expired.status, 'miss')
  assert.deepEqual(expired.value, { n: 2 })
})

test('short TTLs still write KV with the 60 s minimum and are enforced from captured_at', async () => {
  const kv = new FakeKv()
  let calls = 0
  await readThroughWorkerCache(kv as any, 'k', async () => ++calls, { ttlSeconds: 20, nowMs: now })
  assert.equal(kv.puts[0].ttl, 60)
  resetWorkerReadCacheMemory()
  clock += 25_000
  const again = await readThroughWorkerCache(kv as any, 'k', async () => ++calls, { ttlSeconds: 20, nowMs: now })
  assert.equal(again.status, 'miss')
  assert.equal(calls, 2)
})

test('bypass rebuilds and refreshes the cached copy', async () => {
  const kv = new FakeKv()
  let calls = 0
  await readThroughWorkerCache(kv as any, 'k', async () => ++calls, { ttlSeconds: 300, nowMs: now })
  const bypassed = await readThroughWorkerCache(kv as any, 'k', async () => ++calls, { ttlSeconds: 300, bypass: true, nowMs: now })
  assert.equal(bypassed.status, 'bypass')
  assert.equal(bypassed.value, 2)
  const next = await readThroughWorkerCache(kv as any, 'k', async () => ++calls, { ttlSeconds: 300, nowMs: now })
  assert.equal(next.value, 2)
})

test('errors are never cached', async () => {
  const kv = new FakeKv()
  await assert.rejects(readThroughWorkerCache(kv as any, 'k', async () => { throw new Error('boom') }, { ttlSeconds: 300, nowMs: now }), /boom/)
  assert.equal(kv.puts.length, 0)
  const next = await readThroughWorkerCache(kv as any, 'k', async () => 'v', { ttlSeconds: 300, nowMs: now })
  assert.deepEqual([next.status, next.value], ['miss', 'v'])
})

test('a failing KV never fails the read', async () => {
  const kv = { get: async () => { throw new Error('kv down') }, put: async () => { throw new Error('kv down') } }
  const result = await readThroughWorkerCache(kv as any, 'k', async () => 'v', { ttlSeconds: 300, nowMs: now })
  assert.equal(result.value, 'v')
})

test('stale-while-revalidate serves fresh, then stale with one background refresh, then rebuilds inline', async () => {
  const kv = new FakeKv()
  let calls = 0
  const fetcher = async () => ++calls
  const waits: Promise<unknown>[] = []
  const options = { freshSeconds: 60, staleSeconds: 600, waitUntil: (p: Promise<unknown>) => { waits.push(p) }, nowMs: now }

  const cold = await readStaleWhileRevalidate(kv as any, 'm', fetcher, options)
  assert.deepEqual([cold.status, cold.value, cold.revalidating], ['miss', 1, false])

  clock += 30_000
  const fresh = await readStaleWhileRevalidate(kv as any, 'm', fetcher, options)
  assert.deepEqual([fresh.status, fresh.value, fresh.revalidating], ['memory', 1, false])
  assert.equal(waits.length, 1, "only the cold inline source read was registered")

  clock += 60_000
  const stale = await readStaleWhileRevalidate(kv as any, 'm', fetcher, options)
  assert.deepEqual([stale.value, stale.revalidating], [1, true])
  assert.equal(waits.length, 2, "one background refresh scheduled")
  await Promise.all(waits)
  const refreshed = await readStaleWhileRevalidate(kv as any, 'm', fetcher, options)
  assert.deepEqual([refreshed.value, refreshed.revalidating], [2, false])

  clock += 700_000
  resetWorkerReadCacheMemory()
  const tooOld = await readStaleWhileRevalidate(kv as any, 'm', fetcher, options)
  assert.deepEqual([tooOld.status, tooOld.value, tooOld.revalidating], ['miss', 3, false])
})

test('stale copy served from KV reports kv, not memory', async () => {
  const kv = new FakeKv()
  kv.store.set('m', JSON.stringify({ value: 'old', captured_at: new Date(clock - 120_000).toISOString() }))
  const waits: Promise<unknown>[] = []
  const result = await readStaleWhileRevalidate(kv as any, 'm', async () => 'new', {
    freshSeconds: 60, staleSeconds: 600, waitUntil: (p) => { waits.push(p) }, nowMs: now,
  })
  assert.deepEqual([result.status, result.value, result.revalidating], ['kv', 'old', true])
  await Promise.all(waits)
})

test('only an explicit fresh query bypasses; headers never let browsers keep the packet', () => {
  for (const value of ['1', 'true', 'YES']) assert.equal(shouldBypassWorkerReadCache(value), true)
  for (const value of [undefined, null, '', '0', 'no-cache']) assert.equal(shouldBypassWorkerReadCache(value), false)
  const headers = workerReadCacheHeaders({ value: 1, capturedAt: '', ageSeconds: Number.POSITIVE_INFINITY, status: 'kv' }, 300)
  assert.deepEqual(headers, { 'Cache-Control': 'private, no-store', 'X-SV-Cache': 'kv', 'X-SV-Cache-Age': '0', 'X-SV-Cache-TTL': '300' })
})

test('a value the caller marks uncacheable is returned but never stored', async () => {
  const kv = new FakeKv()
  let calls = 0
  const fetcher = async () => ({ n: ++calls, source_query_error_count: calls === 1 ? 1 : 0 })
  const cacheable = (value: { n: number; source_query_error_count: number }) => !value.source_query_error_count
  const partial = await readThroughWorkerCache(kv as any, 'p', fetcher, { ttlSeconds: 300, nowMs: now, cacheable })
  assert.equal(partial.value.n, 1)
  assert.equal(kv.puts.length, 0)
  const complete = await readThroughWorkerCache(kv as any, 'p', fetcher, { ttlSeconds: 300, nowMs: now, cacheable })
  assert.equal(complete.value.n, 2)
  const hit = await readThroughWorkerCache(kv as any, 'p', fetcher, { ttlSeconds: 300, nowMs: now, cacheable })
  assert.deepEqual([hit.status, hit.value.n], ['memory', 2])
})

test('the source read is registered with the request waitUntil', async () => {
  const kv = new FakeKv()
  const registered: Promise<unknown>[] = []
  await readThroughWorkerCache(kv as any, 'w', async () => 'v', { ttlSeconds: 300, nowMs: now, waitUntil: (p) => { registered.push(p) } })
  assert.equal(registered.length, 1)
  await readThroughWorkerCache(kv as any, 'w', async () => 'v', { ttlSeconds: 300, nowMs: now, waitUntil: (p) => { registered.push(p) } })
  assert.equal(registered.length, 1, 'a cache hit starts no source read')
  // A failing source read must not reject the registered promise (it would surface as an unhandled error).
  await assert.rejects(readThroughWorkerCache(kv as any, 'x', async () => { throw new Error('boom') }, { ttlSeconds: 300, nowMs: now, waitUntil: (p) => { registered.push(p) } }))
  await assert.doesNotReject(registered[1])
})

test('isolate memory is bounded by total JSON chars, evicting the oldest entries', async () => {
  const big = 'x'.repeat(400 * 1024)
  const keys = Math.ceil(WORKER_READ_CACHE_MEMORY_TOTAL_CHARS / big.length) + 5
  for (let i = 0; i < keys; i += 1) {
    await readThroughWorkerCache(null, `m${i}`, async () => big, { ttlSeconds: 300, nowMs: now })
  }
  assert.ok(workerReadCacheMemoryChars() <= WORKER_READ_CACHE_MEMORY_TOTAL_CHARS)
  let calls = 0
  const oldest = await readThroughWorkerCache(null, 'm0', async () => { calls += 1; return big }, { ttlSeconds: 300, nowMs: now })
  assert.deepEqual([oldest.status, calls], ['miss', 1], 'the oldest entry was evicted')
  const newest = await readThroughWorkerCache(null, `m${keys - 1}`, async () => { calls += 1; return big }, { ttlSeconds: 300, nowMs: now })
  assert.equal(newest.status, 'memory')
})

test('a value too large for memory replaces the smaller one already there', async () => {
  const kv = new FakeKv()
  await readThroughWorkerCache(kv as any, 'big', async () => 'small-old', { ttlSeconds: 300, nowMs: now })
  const big = 'y'.repeat(600 * 1024)
  await readThroughWorkerCache(kv as any, 'big', async () => big, { ttlSeconds: 300, bypass: true, nowMs: now })
  const next = await readThroughWorkerCache(kv as any, 'big', async () => 'z', { ttlSeconds: 300, nowMs: now })
  assert.equal(next.status, 'kv')
  assert.equal(next.value, big)
})

test('stale-while-revalidate keeps one background refresh per key until it settles or its flag expires', async () => {
  const kv = new FakeKv()
  let calls = 0
  let release: (() => void) | null = null
  const fetcher = async () => { calls += 1; if (calls > 1) await new Promise<void>((r) => { release = r }); return calls }
  const waits: Promise<unknown>[] = []
  const options = { freshSeconds: 60, staleSeconds: 600, waitUntil: (p: Promise<unknown>) => { waits.push(p) }, nowMs: now }
  await readStaleWhileRevalidate(kv as any, 's', fetcher, options)
  clock += 120_000
  await readStaleWhileRevalidate(kv as any, 's', fetcher, options)
  await readStaleWhileRevalidate(kv as any, 's', fetcher, options)
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 2, 'the second stale read did not schedule another refresh')
  // A refresh whose request was cancelled never settles; after 30 s the flag no longer blocks.
  clock += 31_000
  await readStaleWhileRevalidate(kv as any, 's', fetcher, options)
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 3)
  release?.()
})
