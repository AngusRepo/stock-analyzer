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
        history: [
          { generation: 0, best_score: 1.0 },
          { generation: 1, best_score: 1.2 },
        ],
        best: {
          score: 1.2,
          metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
          gate: { decision: 'PASS', passed: true, failed_gates: [], checks: { pbo: true, monte_carlo_mdd_95th: true } },
        },
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
  assert(body.target === 'production_meta_optimizer_learning_state', 'ga_optimizer should write production learning state, not sandbox')
  assert(body.updatedKeys.includes('optimizer:ga:latest'), 'ga_optimizer should update latest learning key')
  assert(body.promotion.level === 'L2', 'gate-passing stable GA state should auto-promote only through L2 shadow config')
  assert(body.promotion.approvalRequiredForNextLevel === true, 'L3/L4 promotion must require Wei approval')
  assert(body.promotion.canRequestNextLevel === true, 'L2 GA state should explicitly expose that L3 approval can be requested')
  assert(body.promotion.missingEvidence.length === 0, 'L3-ready GA state should have no missing evidence')

  const latest = JSON.parse((env.KV as any).store.get('optimizer:ga:latest'))
  assert(latest.status === 'shadow_config', 'latest GA state should expose promotion status')
  assert(latest.promotion.nextAction.includes('Ready to request Wei approval for L3'), 'latest GA state should expose the concrete L3 request action')
  assert(latest.production_learning_loop === true, 'GA must be a production learning loop')
  assert(latest.mutates_trading_config === false, 'GA learning push must not mutate trading:config')
  assert(latest.best_alphaFramework.riskOverlay.highVolThreshold === 0.045, 'latest GA state should preserve learned policy')
  assert(!(env.KV as any).store.has('trading:config'), 'ga_optimizer push must not write trading:config')
})()
