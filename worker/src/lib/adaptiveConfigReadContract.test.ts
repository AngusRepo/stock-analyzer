import assert from 'node:assert'
import {
  DEFAULT_ADAPTIVE_PARAMS,
  getAdaptiveParams,
  invalidateAdaptiveCache,
  setAdaptiveParams,
} from './adaptiveConfig'

class FakeKV {
  store = new Map<string, string>()
  failRead = false

  async get(key: string, mode?: string) {
    if (this.failRead) throw new Error('kv_down')
    const raw = this.store.get(key)
    if (!raw) return null
    return mode === 'json' ? JSON.parse(raw) : raw
  }

  async put(key: string, value: string) {
    this.store.set(key, value)
  }
}

async function run(): Promise<void> {
  {
    invalidateAdaptiveCache()
    const kv = new FakeKV() as unknown as KVNamespace
    await assert.rejects(
      () => getAdaptiveParams(kv),
      /adaptive params missing/,
      'adaptive params read must fail closed when ml:adaptive_params is missing',
    )
  }

  {
    invalidateAdaptiveCache()
    const kv = new FakeKV()
    kv.failRead = true
    await assert.rejects(
      () => getAdaptiveParams(kv as unknown as KVNamespace),
      /adaptive params read failed/,
      'adaptive params read must fail closed on KV read failure',
    )
  }

  {
    invalidateAdaptiveCache()
    const kv = new FakeKV()
    kv.store.set('ml:adaptive_params', JSON.stringify({
      ...DEFAULT_ADAPTIVE_PARAMS,
      provenance: undefined,
    }))
    await assert.rejects(
      () => getAdaptiveParams(kv as unknown as KVNamespace),
      /fallback\/legacy provenance/,
      'legacy adaptive params without provenance must not be used by runtime readers',
    )
  }

  {
    invalidateAdaptiveCache()
    const kv = new FakeKV()
    kv.store.set('ml:adaptive_params', JSON.stringify({
      ...DEFAULT_ADAPTIVE_PARAMS,
      confidence_delta: 0.03,
      provenance: {
        ...DEFAULT_ADAPTIVE_PARAMS.provenance,
        source: 'ml-controller',
        fallback: false,
      },
    }))
    const params = await getAdaptiveParams(kv as unknown as KVNamespace)
    assert.equal(params.confidence_delta, 0.03)
    assert.equal(params.provenance.fallback, false)
  }

  {
    invalidateAdaptiveCache()
    const kv = new FakeKV()
    await setAdaptiveParams(kv as unknown as KVNamespace, {
      ...DEFAULT_ADAPTIVE_PARAMS,
      confidence_delta: 0.07,
      computed_at: '2026-07-07T23:05:00+08:00',
      provenance: {
        ...DEFAULT_ADAPTIVE_PARAMS.provenance,
        source: 'ml-controller',
        fallback: false,
      },
    }, { source: 'ml-controller', fallback: false })

    assert.ok(kv.store.has('ml:adaptive_params'), 'adaptive params write path must persist the global KV key')
    assert.ok(kv.store.has('ml:adaptive_params:2026-07-07'), 'adaptive params write path must also persist the computed-date scoped KV key')
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
