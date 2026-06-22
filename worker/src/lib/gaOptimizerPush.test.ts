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

class FakeStatement {
  values: unknown[] = []

  constructor(private readonly db: FakeDB, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values
    return this
  }

  async run() {
    this.db.runs.push({ sql: this.sql, values: this.values })
    return { success: true }
  }
}

class FakeDB {
  runs: Array<{ sql: string; values: unknown[] }> = []
  batches: string[][] = []

  prepare(sql: string) {
    return new FakeStatement(this, sql)
  }

  async batch(statements: FakeStatement[]) {
    this.batches.push(statements.map((stmt) => (stmt as any).sql))
    return statements.map(() => ({ success: true }))
  }
}

const env = {
  DB: new FakeDB(),
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
  assert(body.kv_readback_ok === true, 'ga_optimizer push should read back latest KV state')
  assert(body.candidate_record?.candidate_id?.startsWith('parameter:ga_optimizer:'), 'ga_optimizer push should persist a D1 parameter candidate record')
  assert(body.candidate_evidence_record?.status === 'PROMOTION_READY', 'L3-ready GA push should write a promotion-ready GA-specific evidence packet')
  assert(String(body.candidate_evidence_record?.promotion_packet_id ?? '').startsWith('promotion_packet:parameter:ga_optimizer:'), 'GA-specific evidence should mint a promotion packet id')
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
  const evidenceRun = (env.DB as any).runs.find((run: any) =>
    String(run.sql).includes('parameter_candidate_evidence') &&
    String(run.values?.[1]) === 'ga_optimizer_policy_packet_validation'
  )
  assert(evidenceRun, 'ga_optimizer push should persist candidate-specific validation evidence')
  assert(String(evidenceRun.values?.[3]).includes('"sandbox_config_required":false'), 'GA validation evidence must not depend on sandbox config state')
  assert(String(evidenceRun.values?.[3]).includes('"mutates_trading_config":false'), 'GA validation evidence must preserve no trading config mutation boundary')

  const requestReview = await adminOptunaRoutes.request('/api/admin/ga-promotion/review', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer service-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'request', level: 'L3', reason: 'test_request' }),
  }, env)
  assert(requestReview.status === 200, 'GA L3 review request should be accepted from admin/service UI path')
  const requested = JSON.parse((env.KV as any).store.get('optimizer:ga:latest'))
  assert(requested.promotion.pendingApprovalLevel === 'L3', 'GA review request should create explicit pending L3 approval')
  assert(requested.mutates_trading_config === false, 'GA review request must not mutate trading:config')

  const approveReview = await adminOptunaRoutes.request('/api/admin/ga-promotion/review', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer service-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'approve', level: 'L3', reason: 'test_approve' }),
  }, env)
  assert(approveReview.status === 200, 'GA L3 approval should be accepted from admin/service UI path')
  const approved = JSON.parse((env.KV as any).store.get('optimizer:ga:latest'))
  assert(approved.promotion.level === 'L3', 'approved GA review should advance promotion state to L3')
  assert(approved.promotion.approved_level === 'L3', 'GA L3 approval marker should be retained in KV state')
  assert(!(env.KV as any).store.has('trading:config'), 'GA review approval must not write trading:config directly')

  const secondPush = await adminOptunaRoutes.request('/api/admin/optuna-push', {
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
          { generation: 1, best_score: 1.25 },
        ],
        best: {
          score: 1.25,
          metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
          gate: { decision: 'PASS', passed: true, failed_gates: [], checks: { pbo: true, monte_carlo_mdd_95th: true } },
        },
        best_alphaFramework: {
          riskOverlay: { highVolThreshold: 0.04 },
          allocation: { weights: { bull: { trend_following: 0.55 } } },
        },
      },
      meta: { best_score: 1.25 },
    }),
  }, env)
  assert(secondPush.status === 200, 'GA push after L3 approval should be accepted')
  const secondBody = await secondPush.json() as any
  assert(secondBody.promotion.level === 'L3', 'GA push must preserve prior L3 approval instead of dropping back to L2')
  assert(secondBody.promotion.nextLevel === 'L4', 'GA L3 state should expose L4 as next level')
  assert(secondBody.promotion.canRequestNextLevel === true, 'GA L3 state should be able to request L4 approval')

  const approveL4 = await adminOptunaRoutes.request('/api/admin/ga-promotion/review', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer service-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'approve', level: 'L4', reason: 'test_approve_l4' }),
  }, env)
  assert(approveL4.status === 200, 'GA L4 approval should be accepted from admin/service UI path')
  const full = JSON.parse((env.KV as any).store.get('optimizer:ga:latest'))
  assert(full.promotion.level === 'L4', 'approved GA review should advance promotion state to L4')
})()
