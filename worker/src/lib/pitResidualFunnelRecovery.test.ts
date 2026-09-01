import assert from 'node:assert/strict'
import { recoverMissingPitResidualFunnels } from './pitResidualFunnelEnrichment'

class Statement {
  args: unknown[] = []

  constructor(readonly db: MockDb, readonly sql: string) {}

  bind(...args: unknown[]) {
    this.args = args
    return this
  }

  all<T>() {
    return this.db.all(this.sql, this.args) as Promise<{ results: T[] }>
  }

  first<T>() {
    return this.db.first(this.sql, this.args) as Promise<T | null>
  }

  run() {
    return this.db.run(this.sql, this.args)
  }
}

class MockDb {
  residualRows = 0

  constructor(readonly domain: 'ops' | 'learning') {}

  prepare(sql: string) {
    return new Statement(this, sql)
  }

  async all(sql: string, args: unknown[]): Promise<{ results: Array<Record<string, unknown>> }> {
    if (this.domain === 'ops' && sql.includes('WITH ranked AS')) {
      return { results: [{
        business_date: '2026-08-31',
        pipeline_canonical_run_id: 'pipeline-dispatch:2026-08-31:canonical',
      }] }
    }
    if (this.domain === 'ops' && sql.includes('SELECT symbol, name, score_after')) {
      return args[1] === 'pit_residual_momentum_shadow_base'
        ? { results: [{ symbol: '2330', name: '台積電', score_after: 77.5 }] }
        : { results: [] }
    }
    if (this.domain === 'learning' && sql.includes('SELECT DISTINCT signal_date')) {
      return { results: [{ signal_date: '2026-08-31' }] }
    }
    if (this.domain === 'learning' && sql.includes('SELECT signal_date, symbol, industry')) {
      return { results: [{
        signal_date: '2026-08-31',
        symbol: '2330',
        industry: '半導體',
        residual_momentum_rank: 0.8,
        breadth_rank: 0.7,
        flow_diffusion_rank: 0.6,
        research_base_score: 0.4,
        research_shadow_score: 0.44,
        factor_contract_version: 'pit-factor-shadow-v1',
        taxonomy_snapshot_date: '2026-08-31',
        taxonomy_checksum: 'taxonomy-checksum',
        residual_weight: 0.1,
        primary_horizon_sessions: 10,
        decision_effect: 'none',
      }] }
    }
    return { results: [] }
  }

  async first(sql: string, _args: unknown[]): Promise<Record<string, unknown> | null> {
    if (this.domain === 'ops' && sql.includes('SELECT r.run_id, r.status')) {
      return { run_id: 'screener-20260831', status: 'success', candidate_count: 830, final_count: 683 }
    }
    if (this.domain === 'ops' && sql.includes('SELECT COUNT(*) AS row_count')) {
      return { row_count: this.residualRows }
    }
    if (this.domain === 'learning' && sql.includes('SELECT MAX(signal_date)')) {
      return { signal_date: '2026-08-31' }
    }
    return null
  }

  async run(_sql: string, _args: unknown[]) {
    return { success: true, meta: { changes: 1 } }
  }

  async batch(statements: Statement[]) {
    this.residualRows = statements.filter((statement) => (
      statement.sql.includes('INSERT INTO screener_funnel_items')
    )).length
    return statements.map(() => ({ success: true, meta: { changes: 1 } }))
  }
}

async function main() {
  const ops = new MockDb('ops')
  const learning = new MockDb('learning')
  const env = {
    DB: ops,
    OPS_DB: ops,
    LEARNING_DB: learning,
    MULTI_D1_ACTIVE_DOMAINS: 'ops,learning',
  } as any

  const result = await recoverMissingPitResidualFunnels(env, {
    throughDate: '2026-09-01',
    maxDates: 1,
  })

  assert.deepEqual(result.attemptedDates, ['2026-08-31'])
  assert.equal(result.recovered.length, 1)
  assert.equal(result.failures.length, 0)
  assert.equal(result.recovered[0].sourceSignalDate, '2026-08-31')
  assert.equal(result.recovered[0].baseCandidateCount, 1)
  assert.equal(result.recovered[0].residualItemCount, 1)
  assert.equal(result.recovered[0].decisionEffect, 'none')
  assert.match(result.recovered[0].summary, /candidate_count_unchanged=830/)
  assert.match(result.recovered[0].summary, /final_count_unchanged=683/)

  console.log('pit residual funnel recovery tests passed')
}

void main()
