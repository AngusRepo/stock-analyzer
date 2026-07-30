import assert from 'node:assert/strict'
import { auditEveningChainEvidenceClosure } from './eveningChainEvidenceClosure'

type Overrides = { identityRows?: number; matureOwner?: string | null; sectorBreadthRows?: number }

class FakeStatement {
  private args: unknown[] = []

  constructor(private readonly db: FakeD1, private readonly sql: string) {}

  bind(...args: unknown[]): FakeStatement {
    this.args = args
    return this
  }

  first<T>(): Promise<T> {
    return Promise.resolve(this.db.first(this.sql, this.args) as T)
  }
}

class FakeD1 {
  constructor(private readonly overrides: Overrides = {}) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql)
  }

  first(sql: string, _args: unknown[]): unknown {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.includes('SUM(CASE WHEN r.stock_id IS NOT NULL')) {
      return { reference_rows: 100, identity_rows: this.overrides.identityRows ?? 100, artifact_rows: 100, reconciled_rows: 100 }
    }
    if (normalized.includes('FROM strategy_label_matrix_runs_v4 r')) {
      return { expected_cell_count: 2500, persisted_cell_count: 2500, matrix_rows: 2500 }
    }
    if (normalized.includes('FROM strategy_redundancy_artifacts_v1')) {
      return { status: 'pass', evidence_artifact_id: 'artifact:strategy_redundancy_oof:test' }
    }
    if (normalized.includes('FROM sector_flow')) {
      return { sector_rows: 20, breadth_rows: this.overrides.sectorBreadthRows ?? 20 }
    }
    if (normalized.includes('FROM market_trading_sessions')) {
      return { session_date: '2026-07-22' }
    }
    if (normalized.includes('FROM canonical_run_heads')) {
      const producerRunId = this.overrides.matureOwner === undefined ? 'screener-2026-07-22' : this.overrides.matureOwner
      return { run_id: producerRunId }
    }
    if (normalized.includes('FROM strategy_label_matrix_runs_v4')) {
      return { reference_candidate_count: 100, expected_cell_count: 2500, persisted_cell_count: 2500 }
    }
    if (normalized.includes('COUNT(*) reference_rows') && normalized.includes('price_horizon_labels_v1')) {
      return { reference_rows: 100, horizon_rows: 100, label_rows: 100 }
    }
    if (normalized.includes('FROM price_horizon_projection_status')) {
      return { status: 'success', candidate_count: 100, materialized_count: 100, rejected_count: 0 }
    }
    throw new Error(`unexpected SQL: ${normalized}`)
  }
}

function envFor(db: FakeD1): any {
  return { DB: db, MULTI_D1_ACTIVE_DOMAINS: '' }
}

async function main(): Promise<void> {
const passing = await auditEveningChainEvidenceClosure(envFor(new FakeD1()), '2026-07-29', 'screener-2026-07-29')
assert.equal(passing.referenceIdentityRows, 100)
assert.equal(passing.matureSignalDate, '2026-07-22')
assert.equal(passing.priceHorizonRows, 100)

await assert.rejects(
  auditEveningChainEvidenceClosure(envFor(new FakeD1({ identityRows: 99 })), '2026-07-29', 'screener-2026-07-29'),
  /evening_chain_reference_identity_incomplete:99\/100/,
)
await assert.rejects(
  auditEveningChainEvidenceClosure(envFor(new FakeD1({ matureOwner: null })), '2026-07-29', 'screener-2026-07-29'),
  /evening_chain_mature_canonical_head_missing:2026-07-22/,
)
await assert.rejects(
  auditEveningChainEvidenceClosure(envFor(new FakeD1({ sectorBreadthRows: 19 })), '2026-07-29', 'screener-2026-07-29'),
  /evening_chain_sector_breadth_incomplete:19\/20/,
)
}

void main()
