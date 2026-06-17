import { adminConfigCoreRoutes } from '../routes/adminConfigCoreRoutes'
import { RISK_CONFIG_KV_KEY } from './riskConfig'
import type { Bindings } from '../types'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

class FakeKV {
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

const kv = new FakeKV()
const env = {
  KV: kv,
  STOCKVISION_AUTH_TOKEN: 'service-token',
  JWT_SECRET: 'test-secret',
} as unknown as Bindings

void (async () => {
  {
    const res = await adminConfigCoreRoutes.request('/api/admin/risk-config', {}, env)
    assert(res.status === 401, 'risk-config status route should require service token')
  }

  {
    const res = await adminConfigCoreRoutes.request('/api/admin/risk-config', {
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    assert(res.status === 200, 'risk-config status route should allow service token')
    const body = await res.json() as any
    assert(body.exists === false, 'missing trading:risk_config should be visible')
    assert(body.runtimeKillSwitchActive === true, 'missing risk config should report runtime S1 active')
    assert(body.production_effect === false, 'status route must be read-only')
  }

  {
    const res = await adminConfigCoreRoutes.request('/api/admin/risk-config/push-defaults', {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env)
    assert(res.status === 200, 'risk-config push-defaults should dry-run by default')
    const body = await res.json() as any
    assert(body.mode === 'dry_run', 'risk-config push-defaults default mode should be dry_run')
    assert(body.production_effect === false, 'dry-run must not affect production')
    assert(!kv.store.has(RISK_CONFIG_KV_KEY), 'dry-run must not write trading:risk_config')
  }

  {
    const res = await adminConfigCoreRoutes.request('/api/admin/risk-config/push-defaults', {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: false }),
    }, env)
    assert(res.status === 400, 'risk-config write should require explicit confirm header')
    assert(!kv.store.has(RISK_CONFIG_KV_KEY), 'unconfirmed write must not write trading:risk_config')
  }

  {
    const res = await adminConfigCoreRoutes.request('/api/admin/risk-config/push-defaults', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer service-token',
        'Content-Type': 'application/json',
        'X-Confirm-Risk-Config': 'true',
      },
      body: JSON.stringify({ dry_run: false }),
    }, env)
    assert(res.status === 200, 'confirmed risk-config write should succeed')
    const body = await res.json() as any
    const stored = JSON.parse(kv.store.get(RISK_CONFIG_KV_KEY)!)
    assert(body.mode === 'persisted', 'confirmed write should persist missing config')
    assert(body.written === true, 'confirmed write should report written=true')
    assert(stored.system.killSwitch === false, 'default risk config seed should set explicit killSwitch=false')
  }

  console.log('adminRiskConfigRouteContract.test.ts passed')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
