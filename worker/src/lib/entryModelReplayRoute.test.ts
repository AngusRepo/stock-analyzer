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
  private binds: unknown[] = []

  constructor(private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.binds = values
    return this
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.sql.includes('FROM daily_recommendations dr')) {
      return {
        results: [{
          date: '2026-05-01',
          symbol: '2330',
          name: '台積電',
          rank: 1,
          current_price: 101,
          stock_id: 1,
          alpha_context: JSON.stringify({
            risk_overlay: {
              structure_detail: {
                fair_value_low: 96,
                fair_value_high: 100,
                optimistic_value_high: 101,
              },
            },
          }),
        }] as T[],
      }
    }
    if (this.sql.includes('FROM stock_prices')) {
      const rows: Array<Record<string, unknown>> = []
      for (let i = 0; i < 145; i += 1) {
        const close = 98 + i * 0.03
        rows.push({
          stock_id: 1,
          date: dateString('2026-01-15', i),
          open: close - 0.2,
          high: close + 0.8,
          low: close - 0.8,
          close,
          volume: 1000 + i * 10,
        })
      }
      rows.push({
        stock_id: 1,
        date: '2026-05-02',
        open: 100.5,
        high: 103,
        low: 99.5,
        close: 102,
        volume: 3000,
      })
      rows.push({
        stock_id: 1,
        date: '2026-05-06',
        open: 102,
        high: 103,
        low: 101,
        close: 102.5,
        volume: 3200,
      })
      rows.push({
        stock_id: 1,
        date: '2026-05-26',
        open: 103,
        high: 104,
        low: 102,
        close: 103.5,
        volume: 3300,
      })
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
    const res = await adminReadRoutes.request('/api/admin/entry-model/replay?start=2026-05-01&end=2026-05-01', {}, env)
    assert(res.status === 401, 'entry model replay route should require auth')
  }

  {
    const res = await adminReadRoutes.request('/api/admin/entry-model/replay?start=2026-05-01&end=2026-05-01&limit=10', {
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    assert(res.status === 200, 'entry model replay route should allow service token')
    const body = await res.json() as any
    assert(body.mode === 'read_only_replay', 'entry model replay route must be read-only')
    assert(body.report.version === 'entry_model_replay_report_v1', 'entry model replay route should return report v1')
    assert(body.report.loadedCases === 1, 'entry model replay route should load replay cases from D1')
    assert(body.report.summary.cases === 1, 'entry model replay summary should include loaded cases')
    assert(body.report.results[0].oldDecision.reason, 'entry model replay should include old model decision')
    assert(body.report.results[0].newDecision.reason, 'entry model replay should include V2 decision')
  }
})()
