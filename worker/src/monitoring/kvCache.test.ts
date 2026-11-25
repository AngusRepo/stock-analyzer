import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readOnlyEnv, type MonitoringEnv } from './env'
import { kvCache, MEMORY_MAX_BYTES, MEMORY_MAX_ENTRIES } from './kvCache'
import { ReadLedger } from './readOnlyD1'

function fakeKv(opts: { failPut?: boolean; failGet?: boolean } = {}) {
  const store = new Map<string, string>()
  const puts: { key: string; ttl?: number }[] = []
  let gets = 0
  const kv = {
    get: async (key: string, type?: string) => {
      gets++
      if (opts.failGet) throw new Error('KV GET failed: 503')
      const raw = store.get(key)
      return raw == null ? null : type === 'json' ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      if (opts.failPut) throw new Error('429 too many writes')
      puts.push({ key, ttl: options?.expirationTtl })
      store.set(key, value)
    },
  }
  return { kv: kv as unknown as KVNamespace, store, puts, gets: () => gets }
}

const req = (path: string) => new Request(`https://stockvision-monitoring.example.workers.dev${path}`)
const res = (body: unknown, ttl: number) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` } })

test('kvCache: hit from memory, then from KV in a fresh isolate, never past the stored expiry', async () => {
  let clock = 1_000_000
  const { kv, puts, gets } = fakeKv()
  const a = kvCache(kv, () => clock, new Map())
  await a.put(req('/v1/chain/state?date=2026-11-25'), res({ n: 1 }, 30))
  assert.deepEqual(puts, [{ key: '/v1/chain/state?date=2026-11-25', ttl: 60 }], 'KV TTL floored at 60 s, key without origin')

  assert.deepEqual(await (await a.match(req('/v1/chain/state?date=2026-11-25')))!.json(), { n: 1 })
  assert.equal(gets(), 0, 'same isolate: memory, no KV read')

  const b = kvCache(kv, () => clock, new Map())
  const fromKv = await b.match(new Request('https://other.host/v1/chain/state?date=2026-11-25'))
  assert.deepEqual(await fromKv!.json(), { n: 1 })
  assert.equal(fromKv!.headers.get('cache-control'), 'max-age=30')
  assert.equal(gets(), 1)

  clock += 31_000
  assert.equal(await a.match(req('/v1/chain/state?date=2026-11-25')), undefined, 'expired in memory')
  assert.equal(await kvCache(kv, () => clock, new Map()).match(req('/v1/chain/state?date=2026-11-25')), undefined, 'expired in KV although the key still lives')
})

test('kvCache: no max-age is not stored; a failed KV write still serves this isolate', async () => {
  const { kv, puts } = fakeKv()
  const cache = kvCache(kv, () => 0, new Map())
  await cache.put(req('/a'), new Response('{}', { headers: { 'cache-control': 'private, no-store' } }))
  assert.equal(puts.length, 0)
  assert.equal(await cache.match(req('/a')), undefined)

  const failing = kvCache(fakeKv({ failPut: true }).kv, () => 0, new Map())
  await failing.put(req('/b'), res({ ok: true }, 300))
  assert.deepEqual(await (await failing.match(req('/b')))!.json(), { ok: true })
})

test('kvCache: memory layer is bounded, oldest first', async () => {
  const memory = new Map()
  const cache = kvCache(fakeKv().kv, () => 0, memory)
  for (let i = 0; i <= MEMORY_MAX_ENTRIES; i++) await cache.put(req(`/k${i}`), res(i, 300))
  assert.equal(memory.size, MEMORY_MAX_ENTRIES)
  assert.equal(memory.has('/k0'), false)
  assert.equal(memory.has(`/k${MEMORY_MAX_ENTRIES}`), true)
})

test('readOnlyEnv: routes never see MONITORING_CACHE', () => {
  const env = { KV: { get: async () => null }, MONITORING_CACHE: fakeKv().kv } as unknown as MonitoringEnv
  assert.equal('MONITORING_CACHE' in readOnlyEnv(env, new ReadLedger()), false)
})

test('kvCache: a KV read error or an over-long key is a miss, never a throw', async () => {
  assert.equal(await kvCache(fakeKv({ failGet: true }).kv, () => 0, new Map()).match(req('/v1/capacity')), undefined)

  const { kv, puts, gets } = fakeKv()
  const cache = kvCache(kv, () => 0, new Map())
  const long = req(`/v1/chain/state?date=${'x'.repeat(600)}`)
  await cache.put(long, res({}, 30))
  assert.equal(await cache.match(long), undefined)
  assert.deepEqual([puts.length, gets()], [0, 0])
})

test('kvCache: memory layer is bounded by bytes and drops an expired entry it meets', async () => {
  let clock = 0
  const memory = new Map()
  const cache = kvCache(fakeKv().kv, () => clock, memory)
  const big = 'x'.repeat(MEMORY_MAX_BYTES / 2 / 3 + 1)
  for (const name of ['a', 'b', 'c']) await cache.put(req(`/${name}`), res(big, 300))
  assert.deepEqual([...memory.keys()], ['/b', '/c'])

  await cache.put(req('/short'), res(1, 30))
  clock += 31_000
  assert.equal(await cache.match(req('/short')), undefined)
  assert.equal(memory.has('/short'), false)
})
