import assert from 'node:assert'
import {
  buildChampionTradingConfig,
  getTradingConfig,
  invalidateConfigCache,
  setTradingConfig,
} from './tradingConfig'

class FakeKV {
  store = new Map<string, string>()
  failRead = false
  failSnapshotPut = false

  async get(key: string, mode?: string) {
    if (this.failRead) throw new Error('kv_down')
    const raw = this.store.get(key)
    if (!raw) return null
    return mode === 'json' ? JSON.parse(raw) : raw
  }

  async put(key: string, value: string) {
    if (this.failSnapshotPut && key.startsWith('trading:config:snapshot:')) {
      throw new Error('snapshot_kv_down')
    }
    this.store.set(key, value)
  }
}

async function run(): Promise<void> {
  {
    invalidateConfigCache()
    const kv = new FakeKV() as unknown as KVNamespace
    await assert.rejects(
      () => getTradingConfig(kv),
      /trading:config missing/,
      'runtime config read must fail closed when trading:config is missing',
    )
  }

  {
    invalidateConfigCache()
    const kv = new FakeKV()
    kv.failRead = true
    await assert.rejects(
      () => getTradingConfig(kv as unknown as KVNamespace),
      /trading:config read failed/,
      'runtime config read must fail closed on KV read failure',
    )
  }

  {
    invalidateConfigCache()
    const kv = new FakeKV()
    kv.store.set('trading:config', JSON.stringify({ signal: { buySignalScore: 0.51 } }))
    const cfg = await getTradingConfig(kv as unknown as KVNamespace)
    assert.equal(cfg.signal.buySignalScore, 0.51)
    kv.store.set('trading:config', JSON.stringify({ signal: { buySignalScore: 0.61 } }))
    assert.equal((await getTradingConfig(kv as unknown as KVNamespace)).signal.buySignalScore, 0.51)
    assert.equal((await getTradingConfig(kv as unknown as KVNamespace, { bypassCache: true })).signal.buySignalScore, 0.61)
    kv.failRead = true
    await assert.rejects(() => getTradingConfig(kv as unknown as KVNamespace, { bypassCache: true }), /read failed/)
    assert.equal(
      cfg.alphaFramework.allocation.engine,
      buildChampionTradingConfig(null).alphaFramework.allocation.engine,
      'partial champion config may still materialize schema defaults',
    )
  }

  {
    invalidateConfigCache()
    const kv = new FakeKV()
    kv.failSnapshotPut = true
    await assert.rejects(
      () => setTradingConfig(
        kv as unknown as KVNamespace,
        buildChampionTradingConfig({ signal: { buySignalScore: 0.61 } }),
        { source: 'contract_test' },
      ),
      /snapshot failed; main config write blocked/,
      'config writes must not proceed when the audit snapshot cannot be written',
    )
    assert(!kv.store.has('trading:config'), 'main trading:config must not be written after snapshot failure')
  }

  {
    // prev_hash and the no-op check use the value in KV, not a cold or stale cache.
    invalidateConfigCache()
    const kv = new FakeKV()
    const before = buildChampionTradingConfig({ signal: { buySignalScore: 0.61 } })
    kv.store.set('trading:config', JSON.stringify(before))
    const same = await setTradingConfig(kv as unknown as KVNamespace, before, { source: 'contract_test' })
    assert.equal(same.skipped, true, 'rewriting the stored value must be a no-op snapshot')
    invalidateConfigCache()
    const next = buildChampionTradingConfig({ signal: { buySignalScore: 0.62 } })
    const written = await setTradingConfig(kv as unknown as KVNamespace, next, { source: 'contract_test' })
    const snapshot = JSON.parse(kv.store.get(written.snapshotId!)!)
    assert.equal(typeof snapshot.meta.prev_hash, 'string', 'snapshot must hash the stored predecessor')
    assert.notEqual(snapshot.meta.prev_hash, snapshot.meta.new_hash)
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
