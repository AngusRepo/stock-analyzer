import { adminReadRoutes } from '../routes/adminReadRoutes'
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
    if (sql.includes('COUNT(*) AS count FROM model_health_daily')) return { count: 10 } as T
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
        avg_score: 72,
        min_score: 45,
        max_score: 88,
        high_score_count: 0,
        perfect_score_count: 0,
      } as T
    }
    if (sql.includes('missing_industry_tags')) return { total: 25, missing_industry_tags: 0 } as T
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
    return {} as T
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const sql = this.sql
    if (sql.includes('FROM predictions')) {
      return {
        results: EXPECTED_V2_MODELS.map((model_name) => ({ model_name, count: 25, stocks: 25 })) as T[],
      }
    }
    if (sql.includes('PRAGMA table_info(daily_recommendations)')) {
      const names = ['date', 'stock_id', 'symbol', 'rank', 'score', 'signal', 'confidence', 'chip_score', 'tech_score', 'ml_score']
      return { results: names.map((name) => ({ name })) as T[] }
    }
    return { results: [] }
  }
}

const env = {
  DB: { prepare: (sql: string) => new FakeStatement(sql) },
  KV: { get: async () => null, put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) },
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
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
