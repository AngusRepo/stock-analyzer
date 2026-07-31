import assert from 'node:assert/strict'
import { auditStrategyRouteBackfillEligibility } from './strategyRouteBackfillEligibility'

type Row = {
  signal_date: string
  producer_run_id: string
  reference_rows: number
  mature_label_rows: number
  matrix_rows: number
  expected_matrix_rows: number
  evaluable_matrix_rows: number
  threshold_margin_rows: number
  challenger_route_rows: number
  challenger_affinity_rows: number
}

class FakeStatement {
  constructor(private readonly db: FakeD1, readonly sql: string) {}
  bind(..._args: unknown[]): FakeStatement { return this }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.rows as T[] } }
  async run(): Promise<unknown> { return {} }
}

class FakeD1 {
  batches = 0
  constructor(readonly rows: Row[]) {}
  prepare(sql: string): FakeStatement { return new FakeStatement(this, sql) }
  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    this.batches += 1
    assert(statements.every((statement) => statement.sql.includes('strategy_route_backfill_eligibility_v1')))
    return statements.map(() => ({}))
  }
}

async function main(): Promise<void> {
  const db = new FakeD1([
    {
      signal_date: '2026-07-15', producer_run_id: 'run-15', reference_rows: 10,
      mature_label_rows: 10, matrix_rows: 100, expected_matrix_rows: 100,
      evaluable_matrix_rows: 20,
      challenger_affinity_rows: 10,
      threshold_margin_rows: 20, challenger_route_rows: 10,
    },
    {
      signal_date: '2026-07-16', producer_run_id: 'run-16', reference_rows: 10,
      mature_label_rows: 10, matrix_rows: 100, expected_matrix_rows: 100,
      evaluable_matrix_rows: 20,
      challenger_affinity_rows: 10,
      threshold_margin_rows: 20, challenger_route_rows: 9,
    },
    {
      signal_date: '2026-07-17', producer_run_id: 'run-17', reference_rows: 10,
      mature_label_rows: 9, matrix_rows: 100, expected_matrix_rows: 100,
      evaluable_matrix_rows: 20,
      challenger_affinity_rows: 10,
      threshold_margin_rows: 20, challenger_route_rows: 10,
    },
    {
      signal_date: '2026-07-18', producer_run_id: 'run-18', reference_rows: 10,
      mature_label_rows: 9, matrix_rows: 100, expected_matrix_rows: 100,
      evaluable_matrix_rows: 20, challenger_affinity_rows: 10,
      threshold_margin_rows: 19, challenger_route_rows: 9,
    },
  ])

  const rows = await auditStrategyRouteBackfillEligibility(db as unknown as D1Database, '2026-07-30')

  assert.equal(rows[0].status, 'eligible')
  assert.deepEqual(rows[0].blockers, [])
  assert.equal(rows[1].status, 'unavailable')
  assert(rows[1].blockers.includes('full_route_pit_inputs_not_persisted'))
  assert(rows[1].blockers.includes('challenger_route_score_missing'))
  assert.equal(rows[2].status, 'pending_maturity')
  assert(rows[2].blockers.includes('outcome_not_mature'))
  assert.equal(rows[3].status, 'unavailable')
  assert(rows[3].blockers.includes('outcome_not_mature'))
  assert(rows[3].blockers.includes('threshold_margin_evidence_incomplete'))
  assert(rows[3].blockers.includes('challenger_route_score_missing'))
  assert.equal(db.batches, 1)
}

void main()
