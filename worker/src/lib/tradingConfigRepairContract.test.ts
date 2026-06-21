import assert from 'node:assert/strict'
import {
  buildTradingConfigRepairPlan,
  invalidateConfigCache,
  repairTradingConfigOperationalDefaults,
} from './tradingConfig'

class FakeKV {
  store = new Map<string, string>()

  async get(key: string, mode?: string) {
    const raw = this.store.get(key)
    if (!raw) return null
    return mode === 'json' ? JSON.parse(raw) : raw
  }

  async put(key: string, value: string) {
    this.store.set(key, value)
  }
}

async function run(): Promise<void> {
  invalidateConfigCache()
  const kv = new FakeKV()
  kv.store.set('trading:config', JSON.stringify({
    position: {
      dailyBuyLimit: 200_000,
      manualDailyLimit: 200_000,
    },
    alphaFramework: {
      allocation: {
        method: 'sparse_tangent_inverse_risk',
        topK: 3,
        selectionPoolSize: 30,
        slateSize: 10,
        weights: {},
      },
    },
  }))

  const plan = await buildTradingConfigRepairPlan(kv as unknown as KVNamespace)
  assert.equal(plan.exists, true)
  assert.equal(plan.needsRepair, true)
  assert(plan.legacyAllocationFields.includes('topK'), 'repair plan must flag legacy allocation.topK')
  assert(plan.legacyAllocationFields.includes('method'), 'repair plan must flag legacy allocation.method')
  assert(
    plan.changes.some((change) =>
      change.path === 'position.dailyBuyLimit' &&
      change.current === 200_000 &&
      change.target === 500_000
    ),
    'repair plan must surface production dailyBuyLimit drift',
  )
  assert(
    plan.changes.some((change) =>
      change.path === 'position.manualDailyLimit' &&
      change.current === 200_000 &&
      change.target === 500_000
    ),
    'repair plan must surface production manualDailyLimit drift',
  )
  assert.equal(plan.target.alphaFramework.allocation.buySignalCount, 5)
  assert.equal((plan.target.alphaFramework.allocation as any).topK, undefined)

  const repaired = await repairTradingConfigOperationalDefaults(kv as unknown as KVNamespace)
  assert.equal(repaired.written, true)
  const written = JSON.parse(kv.store.get('trading:config') ?? '{}')
  assert.equal(written.position.dailyBuyLimit, 500_000)
  assert.equal(written.position.manualDailyLimit, 500_000)
  assert.equal(written.alphaFramework.allocation.buySignalCount, 5)
  assert.equal(written.alphaFramework.allocation.topK, undefined)
  assert.equal(written.alphaFramework.allocation.method, undefined)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
