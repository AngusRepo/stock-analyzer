import {
  DEFAULT_RISK_CONFIG,
  RISK_CONFIG_KV_KEY,
  buildRiskConfigRepairPlan,
  getRiskConfig,
  isKillSwitchActive,
  seedRiskConfigDefaults,
} from './riskConfig'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

class MapKV {
  store = new Map<string, string>()

  async get(key: string, mode?: string) {
    const raw = this.store.get(key)
    if (raw === undefined) return null
    return mode === 'json' ? JSON.parse(raw) : raw
  }

  async put(key: string, value: string) {
    this.store.set(key, value)
  }
}

async function run(): Promise<void> {
  {
    const cfg = await getRiskConfig(undefined)
    assert(cfg.system.killSwitch === true, 'missing KV binding must fail closed')
    assert(cfg.order.maxSingleOrderValue === 0, 'missing KV binding must block order validation consumers')
    assert(await isKillSwitchActive(undefined) === true, 'missing KV binding must activate S1')
  }

  {
    const missingConfigKv = { get: async () => null } as any
    const cfg = await getRiskConfig(missingConfigKv)
    assert(cfg.system.killSwitch === true, 'missing risk config must fail closed')
    assert(await isKillSwitchActive(missingConfigKv) === true, 'missing risk config must activate S1')
  }

  {
    const readFailureKv = { get: async () => { throw new Error('kv_down') } } as any
    const cfg = await getRiskConfig(readFailureKv)
    assert(cfg.system.killSwitch === true, 'KV read failure must fail closed')
    assert(await isKillSwitchActive(readFailureKv) === true, 'KV read failure must activate S1')
  }

  {
    const explicitOffKv = { get: async () => ({ system: { killSwitch: false } }) } as any
    const cfg = await getRiskConfig(explicitOffKv)
    assert(cfg.system.killSwitch === false, 'explicit killSwitch=false may pass S1')
    assert(cfg.order.maxSingleOrderValue === DEFAULT_RISK_CONFIG.order.maxSingleOrderValue, 'partial explicit config still merges defaults')
    assert(await isKillSwitchActive(explicitOffKv) === false, 'explicit killSwitch=false must be honored')
  }

  {
    const missingFieldKv = { get: async () => ({ system: {} }) } as any
    assert(await isKillSwitchActive(missingFieldKv) === true, 'missing killSwitch field must activate S1')
  }

  {
    const kv = new MapKV() as any
    const plan = await buildRiskConfigRepairPlan(kv)
    assert(plan.exists === false, 'missing risk config repair plan must report missing source')
    assert(plan.runtimeKillSwitchActive === true, 'missing risk config must remain runtime fail-closed')
    assert(plan.seedConfig.system.killSwitch === false, 'repair seed should use explicit default killSwitch=false')

    const written = await seedRiskConfigDefaults(kv)
    assert(written.written === true, 'missing risk config should be written by explicit seed path')
    assert(kv.store.has(RISK_CONFIG_KV_KEY), 'seed path must write trading:risk_config')
    assert(await isKillSwitchActive(kv) === false, 'seeded default config should disable S1 kill switch')
  }

  {
    const kv = new MapKV() as any
    await kv.put(RISK_CONFIG_KV_KEY, JSON.stringify({ system: { killSwitch: true } }))
    const written = await seedRiskConfigDefaults(kv)
    const stored = JSON.parse(kv.store.get(RISK_CONFIG_KV_KEY))
    assert(written.written === true, 'partial risk config should be normalized by seed path')
    assert(stored.system.killSwitch === true, 'seed path must preserve explicit manual killSwitch=true')
    assert(await isKillSwitchActive(kv) === true, 'manual killSwitch=true must remain active after repair')
  }

  {
    const kv = new MapKV() as any
    await kv.put(RISK_CONFIG_KV_KEY, JSON.stringify(DEFAULT_RISK_CONFIG))
    const written = await seedRiskConfigDefaults(kv)
    assert(written.written === false, 'complete risk config should be no-op')
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
