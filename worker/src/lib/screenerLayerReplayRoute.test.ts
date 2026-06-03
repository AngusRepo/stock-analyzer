import { adminReadRoutes } from '../routes/adminReadRoutes'
import type { Bindings } from '../types'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function dateString(base: string, offsetDays: number): string {
  const date = new Date(`${base}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}

class FakeStatement {
  constructor(private readonly sql: string) {}

  bind(..._values: unknown[]) {
    return this
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.sql.includes('FROM screener_funnel_items i')) {
      return {
        results: [
          {
            run_id: 'run-2026-06-01',
            date: '2026-06-01',
            symbol: '2330',
            name: 'TSMC',
            decision: 'pass',
            reason_code: 'strategy_breadth_seed',
            score_after: 92,
            rank: 1,
            stock_id: 1,
            evidence: JSON.stringify({ formal_l2_queue: true, strategy_pool_fallback_source: null }),
          },
          {
            run_id: 'run-2026-06-01',
            date: '2026-06-01',
            symbol: '2885',
            name: 'Bank',
            decision: 'observe',
            reason_code: 'raw_signal_top_up_observe_after_strategy_quota',
            score_after: 70,
            rank: 2,
            stock_id: 2,
            evidence: JSON.stringify({ formal_l2_queue: false, strategy_pool_fallback_source: 'raw_signal_top_up' }),
          },
        ] as T[],
      }
    }
    if (this.sql.includes('FROM stock_prices')) {
      const rows: Array<Record<string, unknown>> = []
      for (const stockId of [1, 2]) {
        for (let i = 0; i < 25; i += 1) {
          const close = stockId === 1 ? 100 + i * 0.4 : 50 - i * 0.15
          rows.push({
            stock_id: stockId,
            date: dateString('2026-06-02', i),
            open: close - 0.1,
            close,
          })
        }
      }
      return { results: rows as T[] }
    }
    return { results: [] }
  }
}

const env = {
  DB: { prepare: (sql: string) => new FakeStatement(sql) },
  KV: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ keys: [] }) },
  JWT_SECRET: 'test-secret',
  STOCKVISION_AUTH_TOKEN: 'service-token',
} as unknown as Bindings

void (async () => {
  {
    const res = await adminReadRoutes.request('/api/admin/screener/layer-replay?date=2026-06-01', {}, env)
    assert(res.status === 401, 'screener layer replay route should require auth')
  }

  {
    const res = await adminReadRoutes.request('/api/admin/screener/layer-replay?date=2026-06-01&limit=10&l2_keep_ratio=0.75&l3_keep_ratio=0.7', {
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    assert(res.status === 200, 'screener layer replay route should allow service token')
    const body = await res.json() as any
    assert(body.mode === 'read_only_replay', 'screener layer replay route must be read-only')
    assert(body.report.version === 'screener_layer_replay_v1', 'screener layer replay route should return report v1')
    assert(body.report.loadedCandidates === 2, 'screener layer replay should load layer1 rows')
    assert(body.report.scenarios.length === 2, 'screener layer replay should compare two scenarios')
    const topUpScenario = body.report.scenarios.find((row: any) => row.scenarioId === 'strategy_plus_raw_top_up')
    assert(topUpScenario?.stages[0].rawTopUpCount === 1, 'top-up scenario should expose observe-row contamination')
    assert(body.report.notes.includes('strategy_plus_raw_top_up_is_replay_only_not_formal_l2_policy'), 'top-up should stay read-only replay policy')
  }
})()
