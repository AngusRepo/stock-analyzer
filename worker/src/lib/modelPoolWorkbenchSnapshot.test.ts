import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import {
  MODEL_POOL_WORKBENCH_LATEST_KEY,
  loadModelPoolWorkbenchSnapshot,
  loadModelPoolWorkbenchSnapshotById,
  modelPoolWorkbenchEvidence,
  modelPoolWorkbenchSnapshotKey,
  modelPoolWorkbenchSummary,
  resetModelPoolWorkbenchSnapshotMemory,
} from './modelPoolWorkbenchSnapshot'

class FakeKv {
  store = new Map<string, string>()
  puts: string[] = []
  async get(key: string, type?: 'json') {
    const raw = this.store.get(key)
    if (raw == null) return null
    return type === 'json' ? JSON.parse(raw) : raw
  }
  async put(key: string, value: string) { this.puts.push(key); this.store.set(key, value) }
}

const payload = (tag: string) => ({
  status: 'ok',
  lineage: { models: { TabM: { status: 'active' } }, tag },
  selection: { candidates: [{ artifact_id: `a-${tag}`, evidence: 'x'.repeat(100) }] },
  promotion_queue: { items: [{ artifact_id: `a-${tag}` }] },
  champion_pointers: {
    v5_serving: { status: 'ready' },
    pointers: [{ model_name: 'TabM', champion_version: 'v1', champion_artifact_id: 'a1', registry_row: { big: 'x'.repeat(1000) } }],
  },
  overview: { ok: true },
})

let clock = Date.parse('2026-11-26T02:00:00Z')
const now = () => clock
beforeEach(() => { resetModelPoolWorkbenchSnapshotMemory(); clock = Date.parse('2026-11-26T02:00:00Z') })

test('first read observes the controller once and stores snapshot plus latest pointer', async () => {
  const kv = new FakeKv()
  let calls = 0
  const loaded = await loadModelPoolWorkbenchSnapshot(kv as any, async () => { calls += 1; return payload('one') }, { nowMs: now })
  assert.equal(calls, 1)
  assert.equal(loaded.meta.cache, 'miss')
  assert.match(loaded.meta.id, /^[a-f0-9]{24}$/)
  assert.equal(loaded.meta.stale, false)
  assert.ok(loaded.meta.section_bytes.selection > 0)
  assert.deepEqual(kv.puts, [modelPoolWorkbenchSnapshotKey(loaded.meta.id), MODEL_POOL_WORKBENCH_LATEST_KEY])

  clock += 700_000
  resetModelPoolWorkbenchSnapshotMemory()
  const cached = await loadModelPoolWorkbenchSnapshot(kv as any, async () => { calls += 1; return payload('two') }, { nowMs: now })
  assert.equal(calls, 1)
  assert.equal(cached.meta.cache, 'kv')
  assert.equal(cached.meta.id, loaded.meta.id)
  assert.equal(cached.meta.stale, true, 'older than fresh_seconds is served but marked stale')
})

test('fresh asks the controller and moves the latest pointer; old ids stay readable until they expire', async () => {
  const kv = new FakeKv()
  const first = await loadModelPoolWorkbenchSnapshot(kv as any, async () => payload('one'), { nowMs: now })
  const second = await loadModelPoolWorkbenchSnapshot(kv as any, async () => payload('two'), { mode: 'fresh', nowMs: now })
  assert.equal(second.meta.cache, 'refresh')
  assert.notEqual(second.meta.id, first.meta.id)
  assert.equal(JSON.parse(kv.store.get(MODEL_POOL_WORKBENCH_LATEST_KEY)!).id, second.meta.id)
  const old = await loadModelPoolWorkbenchSnapshotById(kv as any, first.meta.id, now)
  assert.equal((old!.payload.lineage as any).tag, 'one')
})

test('snapshot older than the retention window is not served', async () => {
  const kv = new FakeKv()
  await loadModelPoolWorkbenchSnapshot(kv as any, async () => payload('one'), { nowMs: now })
  resetModelPoolWorkbenchSnapshotMemory()
  clock += 7 * 3600 * 1000
  let calls = 0
  const loaded = await loadModelPoolWorkbenchSnapshot(kv as any, async () => { calls += 1; return payload('two') }, { nowMs: now })
  assert.equal(calls, 1)
  assert.equal((loaded.payload.lineage as any).tag, 'two')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const settle = () => new Promise((r) => setImmediate(r))

test('controller errors are not stored; an observation without overview is returned degraded but never stored', async () => {
  const kv = new FakeKv()
  await assert.rejects(loadModelPoolWorkbenchSnapshot(kv as any, async () => ({ status: 'error', error: 'verified_read_failed' }), { nowMs: now }), /verified_read_failed/)
  const degraded = await loadModelPoolWorkbenchSnapshot(kv as any, async () => ({ ...payload('degraded'), overview: null }), { mode: 'fresh', nowMs: now })
  assert.equal(degraded.meta.degraded, 'overview_unavailable')
  assert.equal((degraded.payload.lineage as any).tag, 'degraded', 'this request still gets the lineage / selection it waited for')
  assert.equal(kv.puts.length, 0)
  assert.equal(await loadModelPoolWorkbenchSnapshotById(kv as any, degraded.meta.id, now), null, 'not in memory either')
  // The next read does not see it: it observes again.
  let calls = 0
  const next = await loadModelPoolWorkbenchSnapshot(kv as any, async () => { calls += 1; return payload('ok') }, { nowMs: now })
  assert.equal(calls, 1)
  assert.equal(next.meta.degraded, undefined)
  assert.equal((next.payload.lineage as any).tag, 'ok')
})

test('fresh always observes; an older observation finishing later does not move latest back', async () => {
  const kv = new FakeKv()
  const before = deferred<ReturnType<typeof payload>>()
  let calls = 0
  const early = loadModelPoolWorkbenchSnapshot(kv as any, () => { calls += 1; return before.promise }, { mode: 'revalidate', nowMs: now })
  await settle()
  clock += 10_000 // promotion lands; the page asks for a fresh observation
  const fresh = await loadModelPoolWorkbenchSnapshot(kv as any, async () => { calls += 1; return payload('post-promotion') }, { mode: 'fresh', nowMs: now })
  assert.equal(calls, 2)
  assert.equal(fresh.meta.cache, 'refresh')
  assert.equal((fresh.payload.lineage as any).tag, 'post-promotion')
  before.resolve(payload('pre-promotion'))
  const late = await early
  assert.equal((late.payload.lineage as any).tag, 'pre-promotion', 'the early caller still gets its own observation')
  assert.equal(JSON.parse(kv.store.get(MODEL_POOL_WORKBENCH_LATEST_KEY)!).id, fresh.meta.id)
  const cached = await loadModelPoolWorkbenchSnapshot(kv as any, async () => { calls += 1; return payload('x') }, { nowMs: now })
  assert.equal((cached.payload.lineage as any).tag, 'post-promotion')
})

test('revalidate uses a latest within fresh_seconds (even with unchanged content), else observes', async () => {
  const kv = new FakeKv()
  let calls = 0
  const fetcher = async () => { calls += 1; return payload('same') }
  const stale = await loadModelPoolWorkbenchSnapshot(kv as any, fetcher, { nowMs: now })
  clock += 700_000
  const tab1 = await loadModelPoolWorkbenchSnapshot(kv as any, fetcher, { mode: 'revalidate', staleId: stale.meta.id, nowMs: now })
  assert.equal(calls, 2)
  assert.equal(tab1.meta.id, stale.meta.id, 'content did not change, so the id is the same')
  assert.equal(tab1.meta.stale, false)
  clock += 1_000
  // A second tab still holding the old copy gets the fresh one without a controller call.
  const tab2 = await loadModelPoolWorkbenchSnapshot(kv as any, fetcher, { mode: 'revalidate', staleId: stale.meta.id, nowMs: now })
  assert.equal(calls, 2)
  assert.equal(tab2.meta.stale, false)
})

test('a snapshot read from KV is kept in isolate memory for the following summary and evidence reads', async () => {
  const kv = new FakeKv()
  const first = await loadModelPoolWorkbenchSnapshot(kv as any, async () => payload('one'), { nowMs: now })
  resetModelPoolWorkbenchSnapshotMemory()
  const gets: string[] = []
  const counting = { get: async (key: string, type?: 'json') => { gets.push(key); return kv.get(key, type) }, put: kv.put.bind(kv) }
  const a = await loadModelPoolWorkbenchSnapshot(counting as any, async () => payload('x'), { nowMs: now })
  const b = await loadModelPoolWorkbenchSnapshot(counting as any, async () => payload('x'), { nowMs: now })
  const evidence = await loadModelPoolWorkbenchSnapshotById(counting as any, first.meta.id, now)
  assert.equal(a.meta.cache, 'kv')
  assert.equal(b.meta.cache, 'memory')
  assert.equal(evidence!.meta.cache, 'memory')
  assert.equal(gets.filter((key) => key === modelPoolWorkbenchSnapshotKey(first.meta.id)).length, 1)
})

test('by-id lookup rejects malformed ids and misses on unknown ids', async () => {
  const kv = new FakeKv()
  assert.equal(await loadModelPoolWorkbenchSnapshotById(kv as any, '../latest'), null)
  assert.equal(await loadModelPoolWorkbenchSnapshotById(kv as any, 'a'.repeat(24)), null)
})

test('summary keeps first-paint sections and slims legacy pointers; evidence carries selection and queue', () => {
  const full = payload('one')
  const summary = modelPoolWorkbenchSummary(full)
  assert.deepEqual(Object.keys(summary).sort(), ['champion_pointers', 'lineage', 'overview', 'status'])
  assert.deepEqual((summary.champion_pointers as any).v5_serving, { status: 'ready' })
  assert.deepEqual((summary.champion_pointers as any).pointers, [
    { model_name: 'TabM', champion_version: 'v1', champion_artifact_id: 'a1', authority: 'legacy_rollback_audit_only' },
  ])
  assert.ok(!JSON.stringify(summary).includes('registry_row'))
  const evidence = modelPoolWorkbenchEvidence(full)
  assert.deepEqual(Object.keys(evidence).sort(), ['promotion_queue', 'selection', 'status'])
  assert.deepEqual(evidence.selection, full.selection)
})

test('the observation is registered with the waiting request waitUntil', async () => {
  const kv = new FakeKv()
  const registered: Promise<unknown>[] = []
  await loadModelPoolWorkbenchSnapshot(kv as any, async () => payload('one'), { nowMs: now, waitUntil: (p) => { registered.push(p) } })
  assert.equal(registered.length, 1)
  await assert.rejects(loadModelPoolWorkbenchSnapshot(kv as any, async () => { throw new Error('controller_down') }, { mode: 'fresh', nowMs: now, waitUntil: (p) => { registered.push(p) } }))
  await assert.doesNotReject(registered[1])
})
