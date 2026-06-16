import { DEFAULT_RISK_CONFIG, getRiskConfig, isKillSwitchActive } from './riskConfig'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
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
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
