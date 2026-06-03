import { adminReadRoutes } from '../routes/adminReadRoutes'
import { buildStrategyInventoryReport } from './strategyInventoryReport'
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

  async all<T = unknown>(): Promise<{ results: T[] }> {
    if (this.sql.includes('FROM strategy_spec_registry')) {
      return { results: [] }
    }
    if (this.sql.includes('FROM strategy_decision_log')) {
      const date = String(this.binds[0] ?? '')
      if (date !== '2026-06-01') return { results: [] }
      return {
        results: [
          { strategy_id: 'defensive_accumulation_seed_v1', strategy_version: 'strategy-spec-v1', strategy_status: 'active', symbol: '2330' },
          { strategy_id: 'defensive_accumulation_seed_v1', strategy_version: 'strategy-spec-v1', strategy_status: 'active', symbol: '2317' },
          { strategy_id: 'defensive_accumulation_seed_v1', strategy_version: 'strategy-spec-v1', strategy_status: 'active', symbol: '2454' },
          { strategy_id: 'defensive_accumulation_seed_v1', strategy_version: 'strategy-spec-v1', strategy_status: 'active', symbol: '2603' },
          { strategy_id: 'finlab_ai_skill_chip_accumulation_v1', strategy_version: 'strategy-spec-v1', strategy_status: 'active', symbol: '2330' },
          { strategy_id: 'finlab_ai_skill_chip_accumulation_v1', strategy_version: 'strategy-spec-v1', strategy_status: 'active', symbol: '2317' },
          { strategy_id: 'finlab_ai_skill_chip_accumulation_v1', strategy_version: 'strategy-spec-v1', strategy_status: 'active', symbol: '2454' },
          { strategy_id: 'trend_following_seed_v1', strategy_version: 'strategy-spec-v1', strategy_status: 'active', symbol: '2885' },
        ] as T[],
      }
    }
    if (this.sql.includes('FROM strategy_reward_ledger')) {
      return {
        results: [
          {
            strategy_id: 'defensive_accumulation_seed_v1',
            samples: 80,
            hit_rate: 0.55,
            avg_return_pct: 0.012,
            max_drawdown_pct: -0.04,
            coverage: 0.8,
            updated_at: '2026-06-01T22:00:00Z',
          },
          {
            strategy_id: 'finlab_ai_skill_chip_accumulation_v1',
            samples: 80,
            hit_rate: 0.49,
            avg_return_pct: -0.002,
            max_drawdown_pct: -0.07,
            coverage: 0.8,
            updated_at: '2026-06-01T22:00:00Z',
          },
        ] as T[],
      }
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
    const report = await buildStrategyInventoryReport(env.DB, { date: '2026-06-01' })
    assert(report.version === 'strategy_inventory_report_v1', 'strategy inventory report should expose version')
    assert(report.specSource === 'default_fallback', 'fake empty registry should fallback to default specs')
    assert(report.formalStrategyOwners >= 2, 'inventory should include active formal strategy owners')
    const pair = report.overlapPairs.find((row) =>
      row.strategyA === 'defensive_accumulation_seed_v1' &&
      row.strategyB === 'finlab_ai_skill_chip_accumulation_v1',
    ) ?? report.overlapPairs.find((row) =>
      row.strategyB === 'defensive_accumulation_seed_v1' &&
      row.strategyA === 'finlab_ai_skill_chip_accumulation_v1',
    )
    assert(pair?.duplicateRisk === 'high', 'same-family high-overlap strategies should be flagged high risk')
    assert(pair?.suggestedAction === 'review_retire_weaker_owner', 'same-family high overlap should ask to review weaker owner')
    assert(
      report.retirementCandidates.some((row) => row.strategyId === 'finlab_ai_skill_chip_accumulation_v1'),
      'weaker high-overlap strategy should appear as retirement candidate',
    )
    assert(
      report.notes.includes('raw_top_up_observe_rows_are_not_counted_as_formal_strategy_owner_overlap'),
      'inventory should explicitly exclude raw top-up observe rows from formal overlap',
    )
  }

  {
    const res = await adminReadRoutes.request('/api/admin/strategy/inventory?date=2026-06-01', {}, env)
    assert(res.status === 401, 'strategy inventory route should require auth')
  }

  {
    const res = await adminReadRoutes.request('/api/admin/strategy/inventory?date=2026-06-01', {
      headers: { Authorization: 'Bearer service-token' },
    }, env)
    assert(res.status === 200, 'strategy inventory route should allow service token')
    const body = await res.json() as any
    assert(body.mode === 'read_only_inventory', 'strategy inventory route must be read-only')
    assert(body.report.overlapPairs.length >= 1, 'strategy inventory route should return overlap pairs')
  }
})()
