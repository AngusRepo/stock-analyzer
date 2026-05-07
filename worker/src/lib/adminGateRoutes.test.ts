import { adminReadRoutes } from '../routes/adminReadRoutes'
import { adminWriteRoutes } from '../routes/adminWriteRoutes'
import { EXPECTED_V2_MODELS } from './dataQualityMonitor'
import type { Bindings } from '../types'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

class FakeStatement {
  private binds: unknown[] = []

  constructor(private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.binds = values
    return this
  }

  async first<T = unknown>(): Promise<T | null> {
    const sql = this.sql
    if (sql.includes('MAX(date) AS latest_date')) return { latest_date: '2026-04-30' } as T
    if (sql.includes('COUNT(*) AS count FROM stock_prices')) return { count: 2300 } as T
    if (sql.includes('COUNT(*) AS count FROM chip_data')) return { count: 2300 } as T
    if (sql.includes('COUNT(*) AS count FROM technical_indicators')) return { count: 2300 } as T
    if (sql.includes('ml_score_positive')) {
      return { total: 25, ml_score_positive: 25, signal_count: 25, confidence_count: 25 } as T
    }
    if (sql.includes('current_price_valid')) {
      return {
        total: 25,
        unclassified: 0,
        invalid_scores: 0,
        missing_components: 0,
        missing_reasons: 0,
        current_price_valid: 25,
        tradable_count: 20,
        emerging_watchlist_count: 5,
        eligible_ml_count: 25,
        eligible_pending_count: 20,
        avg_score: 72,
        min_score: 45,
        max_score: 88,
        high_score_count: 0,
        perfect_score_count: 0,
      } as T
    }
    if (sql.includes('missing_industry_tags')) return { total: 25, missing_industry_tags: 0 } as T
    if (sql.includes('latest_theme_date')) {
      return {
        latest_theme_date: '2026-04-30',
        latest_theme_rows: 47,
        top_concept_symbols: 494,
        top_unmapped_symbols: 0,
        top_other_symbols: 0,
      } as T
    }
    if (sql.includes('FROM screener_funnel_runs')) {
      return {
        funnel_run_id: 'screener-2026-04-30-test',
        funnel_status: 'success',
        funnel_final_count: 20,
        funnel_emerging_count: 5,
        funnel_candidate_count: 90,
        funnel_universe_count: 1800,
        funnel_created_at: '2026-04-30 09:20:00',
      } as T
    }
    if (sql.includes('pending_buy_runs')) {
      return {
        run_trade_date: String(this.binds[0]),
        source_reco_date: '2026-04-29',
        candidate_count: 3,
        active_count: 1,
      } as T
    }
    if (sql.includes('feature_version')) {
      return { total: 250, missing_feature_version: 0, distinct_feature_versions: 1 } as T
    }
    if (sql.includes('FROM dataset_snapshots')) {
      return {
        manifest_total: 7,
        price_hot_window_manifest: 1,
        technical_indicator_hot_window_manifest: 1,
        chip_hot_window_manifest: 1,
        backtest_compute_snapshot_manifest: 1,
        price_history_compute_snapshot_manifest: 1,
        pipeline_report_manifest: 1,
        screener_report_manifest: 1,
      } as T
    }
    return {} as T
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const sql = this.sql
    if (sql.includes('FROM predictions')) {
      return {
        results: EXPECTED_V2_MODELS.map((model_name) => ({ model_name, count: 30, stocks: 30, latest_date: '2026-04-30' })) as T[],
      }
    }
    if (sql.includes('PRAGMA table_info(daily_recommendations)')) {
      const names = [
        'date',
        'stock_id',
        'symbol',
        'rank',
        'score',
        'signal',
        'confidence',
        'chip_score',
        'tech_score',
        'momentum_score',
        'ml_score',
        'alpha_context',
        'alpha_allocation',
        'ml_vote_summary',
        'score_components',
      ]
      return { results: names.map((name) => ({ name })) as T[] }
    }
    if (sql.includes('FROM daily_recommendations') && sql.includes('ORDER BY rank ASC')) {
      return {
        results: [
          { symbol: '2330', name: '台積電', sector: '半導體', industry: '半導體業', score: 70, chip_score: 25, tech_score: 22, momentum_score: 10, current_price: 900 },
          { symbol: '9999', name: '弱勢股', sector: '其他', industry: '其他', score: 30, chip_score: 2, tech_score: 2, momentum_score: 1, current_price: 20 },
        ] as T[],
      }
    }
    return { results: [] }
  }
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
  async delete(key: string) {
    this.store.delete(key)
  }
  async list(opts?: { prefix?: string; limit?: number }) {
    const keys = [...this.store.keys()]
      .filter((name) => !opts?.prefix || name.startsWith(opts.prefix))
      .slice(0, opts?.limit ?? 100)
      .map((name) => ({ name }))
    return { keys, list_complete: true }
  }
}

const env = {
  DB: { prepare: (sql: string) => new FakeStatement(sql) },
  KV: new FakeKV(),
  JWT_SECRET: 'test-secret',
  STOCKVISION_AUTH_TOKEN: 'service-token',
  ML_CONTROLLER_URL: 'https://controller.example.test',
  ML_CONTROLLER_SECRET: 'controller-secret',
} as unknown as Bindings

void (async () => {
  {
    const res = await adminReadRoutes.request('/api/admin/data-quality/status?date=2026-04-30', {}, env)
    assert(res.status === 401, 'data-quality route should require auth')
  }

  {
    const res = await adminReadRoutes.request('/api/admin/data-quality/status?date=2026-04-30', {
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    assert(res.status === 200, 'data-quality route should allow service token')
    const body = await res.json() as any
    assert(body.overall === 'ok', 'data-quality route should return ok for clean fake dataset')
    assert(body.checks.some((check: any) => check.id === 'screener_score_distribution'), 'data-quality route should include screener score gate')
  }

  {
    const res = await adminReadRoutes.request('/api/admin/gate/predeploy?date=2026-04-30', {
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    assert(res.status === 200, 'predeploy route should allow service token')
    const body = await res.json() as any
    assert(body.decision === 'PASS', 'predeploy route should pass for clean fake dataset')
    assert(body.checks.some((check: any) => check.id === 'data_quality.prediction_coverage'), 'predeploy route should include data-quality checks')
  }

  {
    const res = await adminReadRoutes.request('/api/admin/strategy/specs', {
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    assert(res.status === 200, 'strategy specs route should allow service token')
    const body = await res.json() as any
    assert(body.mode === 'read_only', 'strategy specs route should be read-only')
    assert(body.specs.length >= 1, 'strategy specs route should return specs')
    assert(body.owner_boundaries.length >= 1, 'strategy specs route should return owner boundaries')
  }

  {
    const res = await adminReadRoutes.request('/api/admin/strategy/dry-run?date=2026-04-30', {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    assert(res.status === 200, 'strategy dry-run route should allow service token')
    const body = await res.json() as any
    assert(body.mode === 'dry_run', 'strategy dry-run should not mutate state')
    assert(body.source === 'daily_recommendations', 'strategy dry-run should read daily recommendations by default')
    assert(body.candidate_count === 2, 'strategy dry-run should load fake recommendation candidates')
    assert(body.results.some((result: any) => result.matched >= 1), 'strategy dry-run should report matches')
  }

  {
    const res = await adminReadRoutes.request('/api/admin/research/experiments', {
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    assert(res.status === 200, 'research experiments route should allow service token')
    const body = await res.json() as any
    assert(body.mode === 'read_only', 'research experiments list should be read-only')
    assert(Array.isArray(body.experiments), 'research experiments list should return array')
  }

  {
    const res = await adminReadRoutes.request('/api/admin/research/gate', {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token' },
      body: JSON.stringify({ action: 'deploy_prod' }),
    }, env)
    assert(res.status === 200, 'research gate route should allow service token')
    const body = await res.json() as any
    assert(body.mode === 'read_only', 'research gate route should be read-only')
    assert(body.gate.decision === 'BLOCK', 'research gate should block production deploy')
  }

  {
    const before = (env.KV as any).store.size
    const res = await adminWriteRoutes.request('/api/admin/research/experiments', {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hypothesis: '測試策略研究登錄 dry-run 是否只產生 review packet',
        strategySpecIds: ['trend_following_seed_v1'],
        metrics: ['ic_4w_avg'],
        dry_run: true,
      }),
    }, env)
    assert(res.status === 200, 'research experiment dry-run should allow service token')
    const body = await res.json() as any
    assert(body.mode === 'dry_run', 'research experiment default path should be dry-run')
    assert((env.KV as any).store.size === before, 'research experiment dry-run must not write KV')
  }

  {
    const res = await adminWriteRoutes.request('/api/admin/research/experiments', {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hypothesis: '測試策略研究登錄沒有 confirm header 時必須拒絕',
        dry_run: false,
      }),
    }, env)
    assert(res.status === 400, 'persisting research experiment without confirm header should fail')
  }

  {
    const res = await adminWriteRoutes.request('/api/admin/research/experiments', {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json', 'X-Confirm-Research': 'true' },
      body: JSON.stringify({
        hypothesis: '測試策略研究登錄正式寫入需要 confirm header',
        strategySpecIds: ['trend_following_seed_v1'],
        metrics: ['ic_4w_avg', 'pbo'],
        dry_run: false,
      }),
    }, env)
    assert(res.status === 200, 'confirmed research experiment should persist')
    const body = await res.json() as any
    assert(body.mode === 'persisted', 'confirmed research experiment should report persisted mode')

    const listRes = await adminReadRoutes.request('/api/admin/research/experiments', {
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    const listBody = await listRes.json() as any
    assert(listBody.experiments.length >= 1, 'persisted research experiment should be listable')
    assert(listBody.experiments[0].approval_gate.can_deploy === false, 'persisted experiment should keep deploy blocked')
    assert(listBody.experiments[0].evaluation_plan.mode === 'dry_run_only', 'persisted experiment should expose dry-run evaluation plan')
    assert(listBody.experiments[0].evaluation_plan.steps.every((step: any) => step.mutation_allowed === false), 'evaluation plan steps must be non-mutating')

    const planRes = await adminReadRoutes.request(`/api/admin/research/experiments/${listBody.experiments[0].id}/evaluation-plan`, {
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    assert(planRes.status === 200, 'research experiment evaluation plan route should return persisted plan')
    const planBody = await planRes.json() as any
    assert(planBody.plan.steps.length >= 3, 'evaluation plan route should include dry-run steps')
    const historyRes = await adminReadRoutes.request(`/api/admin/research/experiments/${listBody.experiments[0].id}/evaluation-runs`, {
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    assert(historyRes.status === 200, 'research experiment evaluation history route should be available')
    const historyBody = await historyRes.json() as any
    assert(Array.isArray(historyBody.runs), 'evaluation history route should return runs array')
  }

  {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push(String(input))
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      if (body.dry_run !== true || body.mutation_allowed !== false) {
        throw new Error('research evaluation runner must force dry_run and mutation_allowed=false')
      }
      return new Response(JSON.stringify({ ok: true, endpoint: new URL(String(input)).pathname }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const listRes = await adminReadRoutes.request('/api/admin/research/experiments', {
        headers: { Authorization: 'Bearer service-token' },
      }, env)
      const listBody = await listRes.json() as any
      const id = listBody.experiments[0].id
      const runRes = await adminWriteRoutes.request(`/api/admin/research/experiments/${id}/evaluation-plan/run`, {
        method: 'POST',
        headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run: true }),
      }, env)
      assert(runRes.status === 200, 'research evaluation dry-run should execute from write route')
      const runBody = await runRes.json() as any
      assert(runBody.mode === 'dry_run_execution', 'research evaluation route should stay dry-run execution')
      assert(runBody.report.results.length === 3, 'research evaluation route should run safe plan steps')
      assert(calls.every((url) => url.includes('/dry-run') || url.includes('/backtest/replay')), 'research evaluation route must not call mutating controller endpoints')

      const historyRes = await adminReadRoutes.request(`/api/admin/research/experiments/${id}/evaluation-runs`, {
        headers: { Authorization: 'Bearer service-token' },
      }, env)
      const historyBody = await historyRes.json() as any
      assert(historyBody.runs.length >= 1, 'research evaluation dry-run should persist a history entry')
      assert(historyBody.runs[0].experiment_id === id, 'evaluation history should be scoped to experiment id')
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  {
    const listRes = await adminReadRoutes.request('/api/admin/research/experiments', {
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    const listBody = await listRes.json() as any
    const id = listBody.experiments[0].id
    const runRes = await adminWriteRoutes.request(`/api/admin/research/experiments/${id}/evaluation-plan/run`, {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: false }),
    }, env)
    assert(runRes.status === 400, 'research evaluation route should reject dry_run=false')
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
