import { adminOptunaRoutes } from '../routes/adminOptunaRoutes'
import type { Bindings } from '../types'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

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

const env = {
  KV: new FakeKV(),
  STOCKVISION_AUTH_TOKEN: 'service-token',
} as unknown as Bindings

void (async () => {
  const res = await adminOptunaRoutes.request('/api/admin/optuna-push', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer service-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: 'ga_optimizer',
      params: {
        optimizer: 'GAOptimizer',
        status: 'learning',
        best_alphaFramework: {
          riskOverlay: { highVolThreshold: 0.045 },
          allocation: { weights: { bull: { trend_following: 0.5 } } },
        },
      },
      meta: { best_score: 1.2 },
    }),
  }, env)

  assert(res.status === 200, 'ga_optimizer push should be accepted')
  const body = await res.json() as any
  assert(body.target === 'meta_optimizer_learning_state', 'ga_optimizer should write learning state, not sandbox')
  assert(body.updatedKeys.includes('optimizer:ga:latest'), 'ga_optimizer should update latest learning key')

  const latest = JSON.parse((env.KV as any).store.get('optimizer:ga:latest'))
  assert(latest.status === 'learning', 'latest GA state should stay in learning mode')
  assert(latest.best_alphaFramework.riskOverlay.highVolThreshold === 0.045, 'latest GA state should preserve learned policy')
})()
