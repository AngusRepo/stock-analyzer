import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { auditStrategyRouteBackfillEligibility } from './strategyRouteBackfillEligibility'

type Row = {
  signal_date: string
  producer_run_id: string
  reference_rows: number
  mature_label_rows: number
  rejected_label_rows: number
  matrix_rows: number
  expected_matrix_rows: number
  evaluable_matrix_rows: number
  matched_matrix_rows: number
  threshold_margin_rows: number
  challenger_route_rows: number
  challenger_affinity_rows: number
}

class FakeStatement {
  constructor(private readonly db: FakeD1, readonly sql: string) {}
  boundArgs: unknown[] = []
  bind(...args: unknown[]): FakeStatement {
    this.boundArgs = args
    return this
  }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.rows as T[] } }
  async run(): Promise<unknown> { return {} }
}

class FakeD1 {
  batches = 0
  sqls: string[] = []
  statements: FakeStatement[] = []
  constructor(readonly rows: Row[]) {}
  prepare(sql: string): FakeStatement {
    this.sqls.push(sql)
    const statement = new FakeStatement(this, sql)
    this.statements.push(statement)
    return statement
  }
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
      rejected_label_rows: 0,
      evaluable_matrix_rows: 20, matched_matrix_rows: 8,
      challenger_affinity_rows: 10,
      threshold_margin_rows: 8, challenger_route_rows: 10,
    },
    {
      signal_date: '2026-07-16', producer_run_id: 'run-16', reference_rows: 10,
      mature_label_rows: 10, matrix_rows: 100, expected_matrix_rows: 100,
      rejected_label_rows: 0,
      evaluable_matrix_rows: 20, matched_matrix_rows: 8,
      challenger_affinity_rows: 10,
      threshold_margin_rows: 8, challenger_route_rows: 9,
    },
    {
      signal_date: '2026-07-17', producer_run_id: 'run-17', reference_rows: 10,
      mature_label_rows: 9, matrix_rows: 100, expected_matrix_rows: 100,
      rejected_label_rows: 0,
      evaluable_matrix_rows: 20, matched_matrix_rows: 8,
      challenger_affinity_rows: 10,
      threshold_margin_rows: 8, challenger_route_rows: 10,
    },
    {
      signal_date: '2026-07-18', producer_run_id: 'run-18', reference_rows: 10,
      mature_label_rows: 9, matrix_rows: 100, expected_matrix_rows: 100,
      rejected_label_rows: 0,
      evaluable_matrix_rows: 20, matched_matrix_rows: 8, challenger_affinity_rows: 10,
      threshold_margin_rows: 7, challenger_route_rows: 9,
    },
    {
      signal_date: '2026-07-19', producer_run_id: 'run-19', reference_rows: 10,
      mature_label_rows: 9, rejected_label_rows: 1,
      matrix_rows: 100, expected_matrix_rows: 100,
      evaluable_matrix_rows: 20, matched_matrix_rows: 8, challenger_affinity_rows: 10,
      threshold_margin_rows: 8, challenger_route_rows: 10,
    },
    {
      signal_date: '2026-07-20', producer_run_id: 'run-20', reference_rows: 0,
      mature_label_rows: 0, rejected_label_rows: 0,
      matrix_rows: 0, expected_matrix_rows: 0,
      evaluable_matrix_rows: 0, matched_matrix_rows: 0, challenger_affinity_rows: 0,
      threshold_margin_rows: 0, challenger_route_rows: 0,
    },
  ])
  const canonicalRunIds = Object.fromEntries(
    ['15', '16', '17', '18', '19', '20'].map((day) => [`2026-07-${day}`, `run-${day}`]),
  )

  const rows = await auditStrategyRouteBackfillEligibility(db as unknown as D1Database, '2026-07-30', {
    canonicalRunIds,
  })
  assert(db.sqls[0].includes('WITH canonical_heads AS'))
  assert(db.sqls[0].includes('FROM json_each(?) h'))
  assert(db.sqls[0].includes('LEFT JOIN selection_reference_snapshots_v1 r'))
  assert(db.sqls[0].includes('canonical_selection_label_rejections_v4'))
  assert(!db.sqls[0].includes('canonical_run_heads'))
  assert.equal(db.statements[0].boundArgs[0], JSON.stringify(canonicalRunIds))

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
  assert.equal(rows[4].status, 'eligible')
  assert.equal(rows[4].rejectedLabelRows, 1)
  assert.equal(rows[5].status, 'unavailable')
  assert.equal(rows[5].referenceRows, 0)
  assert(rows[5].blockers.includes('canonical_reference_carrier_missing'))
  assert(rows[5].blockers.includes('canonical_strategy_matrix_missing'))
  assert(rows[5].blockers.includes('full_route_pit_inputs_not_persisted'))
  const tombstoneSql = db.sqls.find((sql) => sql.includes('superseded_noncanonical_run')) ?? ''
  assert(tombstoneSql.includes('AND NOT EXISTS ('))
  assert(tombstoneSql.includes('CAST(h.value AS TEXT)=strategy_route_backfill_eligibility_v1.producer_run_id'))
  assert.equal(db.batches, 1)

  const noAuthority = await auditStrategyRouteBackfillEligibility(
    db as unknown as D1Database,
    '2026-07-30',
    { canonicalRunIds: {} },
  )
  assert.deepEqual(noAuthority, [], 'missing Ops authority must fail closed')

  const routeSource = readFileSync(new URL('../routes/adminWriteRoutes.ts', import.meta.url), 'utf8')
  assert.match(routeSource, /\/api\/admin\/strategy\/route-backfill\/eligibility/)
  assert.match(routeSource, /auditStrategyRouteBackfillEligibility/)
  assert.match(routeSource, /loadCanonicalScreenerRunIds/)
  assert.match(routeSource, /persist: !dryRun/)
  assert.match(routeSource, /X-Confirm-Strategy-Learning/)
  assert.match(routeSource, /canonical_route_eligibility_rows_missing/)
}

void main()
