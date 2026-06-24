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
    if (sql.includes('score_v2_count')) {
      return { total: 25, score_v2_count: 25, signal_count: 25, confidence_count: 25 } as T
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
    if (sql.includes('FROM theme_signals')) {
      return {
        theme_signal_total: 8,
        theme_signal_sources: 4,
        theme_signal_latest_generated_at: '2026-04-30 18:00:00',
      } as T
    }
    if (sql.includes('FROM stock_theme_features')) {
      return {
        stock_theme_feature_total: 24,
        stock_theme_feature_symbols: 12,
        stock_theme_feature_latest_generated_at: '2026-04-30 18:01:00',
      } as T
    }
    return {} as T
  }

  async run(): Promise<{ success: true; meta: Record<string, never> }> {
    return { success: true, meta: {} }
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
    if (sql.includes('FROM strategy_spec_registry')) {
      return {
        results: [
          {
            strategy_id: 'trend_following_seed_v1',
            version: 'strategy-spec-v1',
            name: 'Trend following seed',
            status: 'active',
            owner: 'strategy',
            alpha_bucket: 'trend_following',
            family_id: 'TREND_RECLAIM_CONTINUATION',
            variant_id: 'ma_macd_adx_reclaim_v1',
            owner_type: 'strategy',
            promotion_status: 'production',
            supported_regimes_json: JSON.stringify(['bull', 'sideways', 'volatile']),
            thesis: 'Select stocks with durable price structure and trend continuation evidence before ML ranking.',
            thresholds_json: JSON.stringify({
              minPrice: 10,
              minCloseAboveMa20Pct: 0,
              minCloseAboveMa60Pct: -0.02,
              minVolumeExpansion20: 0.9,
              minReturn20d: 0,
            }),
            candidate_policy_json: JSON.stringify({
              poolQuota: 14,
              costBudget: 18,
              evidenceRequirements: ['raw_price_structure', 'raw_volume', 'raw_momentum'],
              maxMlShare: 0.24,
            }),
            risk_notes_json: JSON.stringify(['test runtime spec']),
            source_refs_json: JSON.stringify(['default_strategy_specs']),
            created_by: 'p5_strategy_governance',
            created_at: '2026-04-30T00:00:00Z',
            updated_at: '2026-04-30T00:00:00Z',
          },
        ] as T[],
      }
    }
    if (sql.includes('FROM screener_funnel_items')) {
      return {
        results: [
          {
            symbol: '2330',
            name: 'TSMC',
            sector: 'Semiconductor',
            industry: 'Semiconductor',
            score_components: JSON.stringify({ finalScore: 70, chipScore: 25, techScore: 22, momentumScore: 10 }),
            current_price: 900,
            funnel_evidence: JSON.stringify({
              raw_signals: {
                close_above_ma20_pct: 0.03,
                close_above_ma60_pct: 0.08,
                volume_expansion_20: 1.3,
                return_20d: 0.06,
                closeAboveMa20Pct: 0.03,
                closeAboveMa60Pct: 0.08,
                volumeExpansion20: 1.3,
                return20d: 0.06,
                technicalIndicators: {
                  macdHist: 0.2,
                  adx14: 24,
                  diTrend: 1,
                },
              },
            }),
            funnel_score: 70,
            funnel_rank: 1,
          },
          {
            symbol: '2317',
            name: 'Hon Hai',
            sector: 'Electronics',
            industry: 'EMS',
            score_components: JSON.stringify({ finalScore: 64, chipScore: 20, techScore: 20, momentumScore: 8 }),
            current_price: 160,
            funnel_evidence: JSON.stringify({
              raw_signals: {
                close_above_ma20_pct: 0.02,
                close_above_ma60_pct: 0.04,
                volume_expansion_20: 1.1,
                return_20d: 0.04,
                closeAboveMa20Pct: 0.02,
                closeAboveMa60Pct: 0.04,
                volumeExpansion20: 1.1,
                return20d: 0.04,
                technicalIndicators: {
                  macdHist: 0.1,
                  adx14: 22,
                  diTrend: 1,
                },
              },
            }),
            funnel_score: 64,
            funnel_rank: 2,
          },
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
    assert(body.source === 'screener_funnel_scoring_pass', 'strategy dry-run should read screener funnel scoring-pass candidates by default')
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
      assert(runBody.experiment.status === 'review_ready', 'successful research evaluation should move experiment metadata to review_ready')
      assert(calls.every((url) => url.includes('/dry-run') || url.includes('/backtest/replay')), 'research evaluation route must not call mutating controller endpoints')

      const historyRes = await adminReadRoutes.request(`/api/admin/research/experiments/${id}/evaluation-runs`, {
        headers: { Authorization: 'Bearer service-token' },
      }, env)
      const historyBody = await historyRes.json() as any
      assert(historyBody.runs.length >= 1, 'research evaluation dry-run should persist a history entry')
      assert(historyBody.runs[0].experiment_id === id, 'evaluation history should be scoped to experiment id')
      const refreshedListRes = await adminReadRoutes.request('/api/admin/research/experiments', {
        headers: { Authorization: 'Bearer service-token' },
      }, env)
      const refreshedListBody = await refreshedListRes.json() as any
      const refreshed = refreshedListBody.experiments.find((experiment: any) => experiment.id === id)
      assert(refreshed?.status === 'review_ready', 'research experiment list should reflect review_ready after successful dry-run')
      const approveRes = await adminWriteRoutes.request(`/api/admin/research/experiments/${id}/status`, {
        method: 'POST',
        headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json', 'X-Confirm-Research': 'true' },
        body: JSON.stringify({ status: 'approved_for_patch', reason: 'test-review' }),
      }, env)
      assert(approveRes.status === 200, 'research experiment status route should allow metadata-only approval')
      const approveBody = await approveRes.json() as any
      assert(approveBody.experiment.status === 'approved_for_patch', 'status route should update research experiment metadata')
      assert(approveBody.production_effect === false, 'research status approval must not affect production')
      const handoffRes = await adminWriteRoutes.request(`/api/admin/research/experiments/${id}/patch-handoff`, {
        method: 'POST',
        headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json', 'X-Confirm-Research': 'true' },
        body: JSON.stringify({ reviewer: 'Wei', reason: 'test-handoff', dry_run: true }),
      }, env)
      assert(handoffRes.status === 200, 'approved research experiment should create metadata-only patch handoff')
      const handoffBody = await handoffRes.json() as any
      assert(handoffBody.handoff.mode === 'metadata_only', 'patch handoff must be metadata only')
      assert(handoffBody.handoff.can_write_model_artifact_registry === false, 'patch handoff must not write model_artifact_registry directly')
      assert(handoffBody.production_effect === false, 'patch handoff must not affect production')
      const handoffListRes = await adminReadRoutes.request(`/api/admin/research/experiments/${id}/patch-handoffs`, {
        headers: { Authorization: 'Bearer service-token' },
      }, env)
      const handoffListBody = await handoffListRes.json() as any
      assert(handoffListBody.handoffs.length >= 1, 'patch handoff should be listable')
      const intentRes = await adminWriteRoutes.request(`/api/admin/research/experiments/${id}/artifact-intent`, {
        method: 'POST',
        headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json', 'X-Confirm-Research': 'true' },
        body: JSON.stringify({ reviewer: 'Wei', reason: 'test-intent', dry_run: true }),
      }, env)
      assert(intentRes.status === 409, 'strategy patch handoff should not create model_artifact_registry artifact intent')
      const intentListRes = await adminReadRoutes.request(`/api/admin/research/experiments/${id}/artifact-intents`, {
        headers: { Authorization: 'Bearer service-token' },
      }, env)
      const intentListBody = await intentListRes.json() as any
      assert(intentListBody.intents.length === 0, 'strategy patch should not list model artifact intents')
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

  {
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push(String(input))
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      if (body.dry_run !== true || body.mutation_allowed !== false) {
        throw new Error('model upgrade evaluation runner must force dry_run and mutation_allowed=false')
      }
      return new Response(JSON.stringify({
        ok: true,
        endpoint: new URL(String(input)).pathname,
        candidate_id: body.candidate_id,
        benchmark_report: {
          oos_ic: 0.031,
          pbo: 0.12,
          cost_sensitivity: { status: 'ok' },
          data_slice_report: { status: 'ok' },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const runRes = await adminWriteRoutes.request('/api/admin/research/model-upgrade/evaluation-run', {
        method: 'POST',
        headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json', 'X-Confirm-Research': 'true' },
        body: JSON.stringify({ dry_run: true, seed_missing: true, limit: 2 }),
      }, env)
      assert(runRes.status === 200, 'model upgrade evaluation route should run confirmed dry-run batch')
      const runBody = await runRes.json() as any
      assert(runBody.mode === 'dry_run_execution', 'model upgrade evaluation route should stay dry-run execution')
      assert(runBody.production_effect === false, 'model upgrade evaluation route must not affect production')
      assert(runBody.runs.length === 2, 'model upgrade evaluation route should run requested batch limit')
      assert(runBody.runs.every((run: any) => run.verdict === 'ready_for_review'), 'model upgrade evaluation dry-runs should create review-ready evidence when safe steps pass')
      assert(calls.every((url) => url.includes('/dry-run') || url.includes('/backtest/replay')), 'model upgrade evaluation route must call safe dry-run endpoints only')
      const priorityRunRes = await adminWriteRoutes.request('/api/admin/research/model-upgrade/evaluation-run', {
        method: 'POST',
        headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json', 'X-Confirm-Research': 'true' },
        body: JSON.stringify({ dry_run: true, seed_missing: true, limit: 1 }),
      }, env)
      assert(priorityRunRes.status === 200, 'model upgrade evaluation route should support one-at-a-time dry-run progression')
      const priorityRunBody = await priorityRunRes.json() as any
      assert(priorityRunBody.runs.length === 1, 'one-at-a-time model upgrade dry-run should execute a single target')
      assert(priorityRunBody.runs[0].candidate_id !== 'ResidualMLP', 'one-at-a-time route should advance pending candidates before rerunning prior needs-attention rows')
      const statusRes = await adminReadRoutes.request('/api/admin/research/model-upgrade/status', {
        headers: { Authorization: 'Bearer service-token' },
      }, env)
      const statusBody = await statusRes.json() as any
      const candidateIds = new Set(statusBody.candidates.map((row: any) => row.candidate_id))
      for (const id of ['ResidualMLP', 'DLinear', 'PatchTST', 'GNN', 'TabM', 'iTransformer', 'TimesFM', 'GAOptimizer', 'KalmanFilter', 'MarkovSwitching']) {
        assert(candidateIds.has(id), `model upgrade status should include full P7 track candidate ${id}`)
      }
      const timesFmRow = statusBody.candidates.find((row: any) => row.candidate_id === 'TimesFM')
      assert(timesFmRow?.stage === 'l2_feature_sidecar_member', 'TimesFM should remain the single active L2 sidecar slot for the 2.5 runtime')
      assert(!candidateIds.has('TimesFM25'), 'TimesFM25 migration benchmark must not appear as a tenth active model-upgrade candidate')
      assert(statusBody.candidates.some((row: any) => row.registry_status === 'track_only' && row.requires_experiment_registry === false), 'non-experiment tracks should be visible as track_only')
      assert(statusBody.candidates.some((row: any) => row.registry_status === 'ready_for_review'), 'model upgrade status should surface review-ready evidence after batch run')
      const target = statusBody.candidates.find((row: any) => row.registry_status === 'ready_for_review' && row.requires_experiment_registry && row.latest_experiment_id)
      assert(target, 'model upgrade status should expose a review-ready target experiment')
      const approveRes = await adminWriteRoutes.request(`/api/admin/research/experiments/${target.latest_experiment_id}/status`, {
        method: 'POST',
        headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json', 'X-Confirm-Research': 'true' },
        body: JSON.stringify({ status: 'approved_for_patch', reason: 'model-upgrade-artifact-intent-test' }),
      }, env)
      assert(approveRes.status === 200, 'model upgrade experiment should allow metadata-only approval')
      const handoffRes = await adminWriteRoutes.request(`/api/admin/research/experiments/${target.latest_experiment_id}/patch-handoff`, {
        method: 'POST',
        headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json', 'X-Confirm-Research': 'true' },
        body: JSON.stringify({ reviewer: 'Wei', reason: 'model-upgrade-handoff-test', dry_run: true }),
      }, env)
      assert(handoffRes.status === 200, 'model upgrade handoff should target model_artifact_registry metadata path')
      const intentRes = await adminWriteRoutes.request(`/api/admin/research/experiments/${target.latest_experiment_id}/artifact-intent`, {
        method: 'POST',
        headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json', 'X-Confirm-Research': 'true' },
        body: JSON.stringify({ reviewer: 'Wei', reason: 'model-upgrade-intent-test', dry_run: true }),
      }, env)
      assert(intentRes.status === 200, 'model upgrade approved experiment should create metadata-only artifact intent')
      const intentBody = await intentRes.json() as any
      assert(intentBody.intent.mode === 'metadata_only', 'model upgrade artifact intent must be metadata only')
      assert(intentBody.intent.preflight.can_write_registry === false, 'artifact intent must not write model_artifact_registry directly')
      assert(intentBody.intent.status === 'blocked_missing_artifact', 'artifact intent without artifact files should be blocked visibly')
      const refreshedStatusRes = await adminReadRoutes.request('/api/admin/research/model-upgrade/status', {
        headers: { Authorization: 'Bearer service-token' },
      }, env)
      const refreshedStatus = await refreshedStatusRes.json() as any
      const refreshedRow = refreshedStatus.candidates.find((row: any) => row.latest_experiment_id === target.latest_experiment_id)
      assert(refreshedRow.latest_patch_handoff_id, 'model upgrade status should surface latest patch handoff id')
      assert(refreshedRow.latest_artifact_intent_status === 'blocked_missing_artifact', 'model upgrade status should surface latest artifact intent status')
      assert(refreshedRow.registry_preflight_ready === false, 'missing artifact fields should keep registry preflight blocked')
      assert(refreshedRow.artifact_intent_missing_fields.length >= 1, 'model upgrade status should surface missing artifact fields')
      assert(refreshedRow.next_action === 'attach_artifact_checksum_manifest_feature_policy', 'model upgrade status should point to artifact metadata attachment')
      const readyIntentRes = await adminWriteRoutes.request(`/api/admin/research/experiments/${target.latest_experiment_id}/artifact-intent`, {
        method: 'POST',
        headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json', 'X-Confirm-Research': 'true' },
        body: JSON.stringify({
          model_name: target.candidate_id,
          artifact_version: 'v-test-shadow',
          artifact_path: 'gs://stockvision-models/research/residualmlp/model.pkl',
          training_manifest_path: 'gs://stockvision-models/research/residualmlp/training_manifest.json',
          feature_policy_version: 'model-feature-policy-v1',
          checksum: 'sha256:test',
          dry_run: true,
        }),
      }, env)
      assert(readyIntentRes.status === 200, 'complete artifact metadata should create a preflight-ready intent')
      const readyIntentBody = await readyIntentRes.json() as any
      assert(readyIntentBody.intent.status === 'ready_for_registry_preflight', 'complete artifact intent should be ready for registry preflight')
      const readyStatusRes = await adminReadRoutes.request('/api/admin/research/model-upgrade/status', {
        headers: { Authorization: 'Bearer service-token' },
      }, env)
      const readyStatus = await readyStatusRes.json() as any
      const readyRow = readyStatus.candidates.find((row: any) => row.latest_experiment_id === target.latest_experiment_id)
      assert(readyRow.registry_preflight_ready === true, 'model upgrade status should surface registry preflight readiness')
      assert(readyRow.next_action === 'manual_registry_owner_can_review_intent', 'ready intent should route to manual registry owner review')
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
