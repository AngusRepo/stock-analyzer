import assert from 'node:assert/strict'
import { runS12IntradaySetupWatch, type SetupWatchSeed } from './s12IntradaySetupWatch'

class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly seeds: SetupWatchSeed[],
    private readonly lease: Record<string, unknown> | null,
  ) {}

  bind(): FakeStatement {
    return this
  }

  async all<T>(): Promise<{ results: T[] }> {
    assert(this.sql.includes('FROM s12_structure_snapshots'))
    return { results: this.seeds as T[] }
  }

  async first<T>(): Promise<T | null> {
    assert(this.sql.includes('FROM scheduler_locks'))
    return this.lease as T | null
  }
}

class FakeD1 {
  constructor(
    private readonly seeds: SetupWatchSeed[],
    private readonly lease: Record<string, unknown> | null,
  ) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(sql, this.seeds, this.lease)
  }
}

const seed: SetupWatchSeed = {
  symbol: '2330',
  source_trade_date: '2026-07-30',
  state: 'waiting_15m_zone_touch',
  demand_zone_low: 100,
  demand_zone_high: 105,
}

async function main(): Promise<void> {
const originalFetch = globalThis.fetch
try {
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('active lease must not trigger Cloud Run Job')
  }
  const active = await runS12IntradaySetupWatch({
    DB: new FakeD1([seed], {
      run_date: '2026-07-31',
      run_id: 's12-structure-active',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }) as unknown as D1Database,
    S12_DURABLE_STRUCTURE_JOB_ENABLED: '1',
  } as any, '2026-07-31')
  assert.equal(active.status, 'running')
  assert.equal(active.run_id, 's12-structure-active')
  assert.equal(fetchCalls, 0)

  let requestBody: Record<string, unknown> | null = null
  globalThis.fetch = async (_input, init) => {
    fetchCalls += 1
    requestBody = JSON.parse(String(init?.body ?? '{}'))
    return new Response(JSON.stringify({
      status: 'triggered',
      run_id: 's12-structure-new',
      execution_id: 'execution-new',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const triggered = await runS12IntradaySetupWatch({
    DB: new FakeD1([seed], null) as unknown as D1Database,
    S12_DURABLE_STRUCTURE_JOB_ENABLED: '1',
    ML_CONTROLLER_URL: 'https://controller.example.test',
    ML_CONTROLLER_SECRET: 'test-secret',
  } as any, '2026-07-31')
  assert.equal(triggered.status, 'triggered')
  assert.equal(fetchCalls, 1)
  assert.equal(requestBody?.source, 'intraday_session')
  assert.equal(requestBody?.chain_run_id, 's12-intraday-session:2026-07-31')
  assert.equal('symbols' in (requestBody ?? {}), false)
} finally {
  globalThis.fetch = originalFetch
}

console.log('s12 intraday session routing tests passed')
}

void main()
