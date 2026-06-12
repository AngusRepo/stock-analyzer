import { invalidateAdaptiveCache } from './adaptiveConfig'
import { runAdaptiveUpdate } from './adaptiveEngine'
import { invalidateConfigCache } from './tradingConfig'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

class FakeKV {
  store = new Map<string, string>()

  async get(key: string, mode?: string) {
    const raw = this.store.get(key)
    if (raw == null) return null
    return mode === 'json' ? JSON.parse(raw) : raw
  }

  async put(key: string, value: string) {
    this.store.set(key, value)
  }
}

function makeFakeDb(calls: Array<{ sql: string; binds: unknown[] }>) {
  return {
    prepare(sql: string) {
      const call = { sql, binds: [] as unknown[] }
      calls.push(call)
      return {
        bind(...args: unknown[]) {
          call.binds = args
          return this
        },
        async first() {
          if (sql.includes('FROM market_risk')) return { risk_score: 80, risk_level: 'red' }
          if (sql.includes('SUM(correct_count)')) return { avg_acc: 0.5, sample_count: 120, model_count: 3 }
          return null
        },
        async all() {
          if (sql.includes("period='30d'")) {
            return {
              results: [
                { model_name: 'LightGBM', total_count: 80, accuracy: 0.55, profit_factor: 1.2 },
                { model_name: 'TabM', total_count: 40, accuracy: 0.40, profit_factor: 0.8 },
              ],
            }
          }
          if (sql.includes("period='90d'")) {
            return {
              results: [
                { model_name: 'LightGBM', total_count: 180, accuracy: 0.58, profit_factor: 1.1 },
                { model_name: 'TabM', total_count: 90, accuracy: 0.45, profit_factor: 0.9 },
              ],
            }
          }
          return { results: [] }
        },
      }
    },
  } as unknown as D1Database
}

void (async () => {
  invalidateAdaptiveCache()
  invalidateConfigCache()

  const kv = new FakeKV()
  kv.store.set('ml:adaptive_params', JSON.stringify({
    version: 4,
    confidence_delta: 0,
    position_pct_delta: 0,
    bandit_max_mult: 2.5,
    provenance: { source: 'risk-assess' },
  }))
  kv.store.set('trading:config', JSON.stringify({
    signal: { buySignalScore: 0.51 },
    L2_formula: {
      confidence_risk_mult: 0.01,
      confidence_perf_mult: 0.01,
      bandit_loss_thresh_high: 0.9,
      bandit_loss_thresh_med: 0.2,
      bandit_max_mult_high: 1.1,
      bandit_max_mult_med: 1.4,
      bandit_max_mult_low: 2.4,
    },
  }))

  const originalFetch = globalThis.fetch
  let requestBody: any = null
  const dbCalls: Array<{ sql: string; binds: unknown[] }> = []
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body ?? '{}'))
    return new Response(JSON.stringify({
      adaptive_params: {
        confidence_delta: 0.02,
        position_pct_delta: 0,
        sltp_add: null,
        pf_quality_mult: {},
        bandit_max_mult: 1.4,
        bandit_force_explore: false,
        computed_at: '2026-06-08T00:00:00.000Z',
        market_risk_score: 80,
        recent_accuracy_30d: 0.5,
        provenance: {
          source: 'risk-assess',
          l2_formula_source: 'worker_trading_config',
        },
        version: 5,
      },
      summary: 'adaptive ok',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  try {
    const summary = await runAdaptiveUpdate({
      DB: makeFakeDb(dbCalls),
      KV: kv as unknown as KVNamespace,
      ML_CONTROLLER_URL: 'https://controller.example.com',
      ML_CONTROLLER_SECRET: 'controller-secret',
    }, { refreshLedger: false })

    assert(summary === 'adaptive ok', 'adaptive update should return controller summary')
    const modelAccuracyCalls = dbCalls.filter((call) => call.sql.includes('FROM model_accuracy'))
    assert(modelAccuracyCalls.length >= 3, 'adaptive update should query active-9 model_accuracy evidence')
    assert(modelAccuracyCalls.every((call) => call.sql.includes('model_name IN')), 'model_accuracy evidence queries must be scoped to active-9 models')
    const allBinds = modelAccuracyCalls.flatMap((call) => call.binds)
    assert(allBinds.includes('LightGBM') && allBinds.includes('TabM') && allBinds.includes('iTransformer') && allBinds.includes('TimesFM'), 'active-9 model binds must include tree, TabM, sequence, and foundation models')
    assert(!allBinds.includes('CatBoost'), 'active-9 adaptive evidence must not bind retired CatBoost')
    assert(requestBody.accuracy.active_9_quality_30d === 0.5, 'risk-assess payload must include active-9 confidence quality')
    assert(requestBody.accuracy.active_9_samples_30d === 120, 'risk-assess payload must include active-9 sample count')
    assert(requestBody.accuracy.rows_30d[0].accuracy === 0.55, 'risk-assess rows_30d must carry per-model accuracy for the controller hook')
    assert(requestBody.adaptive_config.L2_formula.bandit_loss_thresh_high === 0.9, 'risk-assess payload must include champion L2_formula')
    assert(requestBody.adaptive_config.baseline_buy_signal_score === 0.51, 'risk-assess payload must include baseline buy score')

    const persisted = JSON.parse(kv.store.get('ml:adaptive_params') ?? '{}')
    assert(persisted.provenance.l2_formula_source === 'worker_trading_config', 'adaptive params provenance must preserve L2 formula source')
    assert(persisted.bandit_context.linucb_reward_ledger.reward_ledger_status === 'handled_by_post_verify_chain', 'post-verify chain should avoid duplicate ledger refresh')
  } finally {
    globalThis.fetch = originalFetch
    invalidateAdaptiveCache()
    invalidateConfigCache()
  }
})()
