import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { buildStrategyFormalMatureCompatibilitySql } from './selectionReferenceEvidence'
import { auditStrategyRouteBackfillEligibility } from './strategyRouteBackfillEligibility'
import { STRATEGY_ROUTE_AFFINITY_VERSION, STRATEGY_ROUTE_CHALLENGER_VERSION } from './strategyRouteCalibration'

// The eligibility audit must return exactly the rows the former SQL returned
// (four correlated matrix COUNTs per head); the former SQL text is the
// reference. The new plan reads strategy_label_matrix_v4 in one search.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const COMPAT = buildStrategyFormalMatureCompatibilitySql('mr')
const [V4_REF, V4_LAB, PIT_LAB, V3_REF, V3_LAB] = COMPAT.binds
const AS_OF = '2026-11-12'
const START = '2026-07-01'

const FORMER_SQL = `
    WITH canonical_heads AS (
      SELECT h.key signal_date, CAST(h.value AS TEXT) producer_run_id
        FROM json_each(?) h
       WHERE h.key BETWEEN ? AND ?
    ),
    formal_runs AS (
      SELECT producer_run_id, signal_date, expected_cell_count, labeler_version,
             reference_contract_version
        FROM strategy_label_matrix_runs_v4 mr
       WHERE status='ready' AND ${COMPAT.sql}
    )
    SELECT h.signal_date, h.producer_run_id,
           COUNT(r.symbol) reference_rows,
           SUM(CASE WHEN r.symbol IS NOT NULL AND EXISTS (
             SELECT 1 FROM canonical_selection_labels_v4 l
              WHERE l.signal_date=h.signal_date AND l.symbol=r.symbol
                AND l.producer_run_id=h.producer_run_id
                AND l.label_schema_version=? AND l.reference_contract_version=mr.reference_contract_version
                AND l.outcome_known_date<=?
           ) THEN 1 ELSE 0 END) mature_label_rows,
           SUM(CASE WHEN r.symbol IS NOT NULL AND EXISTS (
             SELECT 1 FROM canonical_selection_label_rejections_v4 q
              WHERE q.signal_date=h.signal_date
                AND q.symbol=r.symbol
                AND q.producer_run_id=h.producer_run_id
           ) THEN 1 ELSE 0 END) rejected_label_rows,
           COALESCE((
             SELECT COUNT(*) FROM strategy_label_matrix_v4 m
              WHERE m.signal_date=h.signal_date AND m.producer_run_id=h.producer_run_id
                AND m.labeler_version=mr.labeler_version
                AND m.reference_contract_version=mr.reference_contract_version
           ), 0) matrix_rows,
           COALESCE(mr.expected_cell_count, 0) expected_matrix_rows,
           COALESCE((
             SELECT COUNT(*) FROM strategy_label_matrix_v4 m
              WHERE m.signal_date=h.signal_date AND m.producer_run_id=h.producer_run_id
                AND m.labeler_version=mr.labeler_version
                AND m.reference_contract_version=mr.reference_contract_version
                AND m.evaluable=1
           ), 0) evaluable_matrix_rows,
           COALESCE((
             SELECT COUNT(*) FROM strategy_label_matrix_v4 m
              WHERE m.signal_date=h.signal_date AND m.producer_run_id=h.producer_run_id
                AND m.labeler_version=mr.labeler_version
                AND m.reference_contract_version=mr.reference_contract_version
                AND m.evaluable=1 AND m.strategy_hit=1
           ), 0) matched_matrix_rows,
           SUM(CASE WHEN r.strategy_challenger_affinity_version=?
                    THEN 1 ELSE 0 END) challenger_affinity_rows,
           COALESCE((
             SELECT COUNT(*) FROM strategy_label_matrix_v4 m
              WHERE m.signal_date=h.signal_date AND m.producer_run_id=h.producer_run_id
                AND m.labeler_version=mr.labeler_version
                AND m.reference_contract_version=mr.reference_contract_version
                AND m.evaluable=1 AND m.strategy_hit=1 AND m.affinity_evidence_count>0
           ), 0) threshold_margin_rows,
           SUM(CASE WHEN COALESCE(
                     e.route_score,
                     CASE WHEN r.strategy_challenger_route_version=?
                          THEN r.strategy_challenger_route_score END
                   ) IS NOT NULL THEN 1 ELSE 0 END) challenger_route_rows
      FROM canonical_heads h
      LEFT JOIN formal_runs mr
        ON mr.signal_date=h.signal_date AND mr.producer_run_id=h.producer_run_id
      LEFT JOIN selection_reference_snapshots_v1 r
        ON r.signal_date=h.signal_date
       AND r.producer_run_id=h.producer_run_id
       AND r.hard_gate_passed=1
       AND r.feature_contract_version=mr.reference_contract_version
       AND mr.labeler_version=r.strategy_labeler_version
      LEFT JOIN strategy_route_versioned_evidence_v1 e
        ON e.signal_date=r.signal_date AND e.symbol=r.symbol
       AND e.producer_run_id=r.producer_run_id AND e.route_version=?
     GROUP BY h.signal_date, h.producer_run_id
     ORDER BY h.signal_date
`

type Recorded = { sql: string; params: unknown[] }

function d1(db: DatabaseSync, log?: Recorded[]): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = []
      const values = () => params.map((value) => value === undefined ? null : value) as never[]
      const statement = {
        bind(...bound: unknown[]) { params = bound; return statement },
        async all() {
          log?.push({ sql, params })
          return { success: true, results: db.prepare(sql).all(...values()), meta: {} }
        },
        async run() {
          log?.push({ sql, params })
          db.prepare(sql).run(...values())
          return { success: true, results: [], meta: {} }
        },
      }
      return statement
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      return results
    },
  } as unknown as D1Database
}

function schema(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(read('../../domain-schemas/learning.sql'))
  db.exec(read('../../domain-migrations/learning/0064_drop_redundant_date_indexes.sql'))
  return db
}

type Seed = {
  date: string
  producer: string
  run?: { status?: string; ref?: string; labeler?: string; expected?: number } | null
  // [symbol, strategy, evaluable, hit, affinity_evidence_count, labeler?, ref?]
  cells?: Array<[string, string, number, number, number, string?, string?]>
  // [symbol, hard_gate_passed, challenger affinity version, route version, route score, labeler?, ref?]
  references?: Array<[string, number, string | null, string | null, number | null, string?, string?]>
  labels?: Array<[string, string]> // [symbol, outcome_known_date]
  rejections?: string[]
  routeEvidence?: string[]
}

function seed(db: DatabaseSync, seeds: Seed[]): void {
  const run = db.prepare(`INSERT INTO strategy_label_matrix_runs_v4(producer_run_id,signal_date,status,reference_candidate_count,
    strategy_count,expected_cell_count,persisted_cell_count,strategy_registry_checksum,labeler_version,reference_contract_version)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
  const cell = db.prepare(`INSERT INTO strategy_label_matrix_v4(signal_date,symbol,producer_run_id,strategy_id,strategy_version,
    strategy_status,alpha_bucket,family_id,production_owner,strategy_hit,evaluable,evaluability_status,weak_label,affinity,
    affinity_evidence_count,position_weight,challenger_affinity_version,overlap,labeler_version,strategy_registry_checksum,
    reference_contract_version) VALUES (?,?,?,?,'v1','active','alpha','fam',1,?,?,'EVALUABLE',1,1,?,0,?,0,?,'registry',?)`)
  const reference = db.prepare(`INSERT INTO selection_reference_snapshots_v1(signal_date,symbol,producer_run_id,hard_gate_passed,
    hard_gate_reason,feature_available,strategy_labeled,strategy_selected,selection_stage,strategy_registry_checksum,
    feature_contract_version,strategy_labeler_version,strategy_challenger_affinity_version,strategy_challenger_route_version,
    strategy_challenger_route_score) VALUES (?,?,?,?,'ok',1,1,0,'scored','registry',?,?,?,?,?)`)
  const label = db.prepare(`INSERT INTO canonical_selection_labels_v4(signal_date,symbol,producer_run_id,entry_date,exit_date,
    outcome_known_date,entry_raw_open,exit_raw_close,entry_adjustment_factor,exit_adjustment_factor,gross_return,
    transaction_cost_bps,absolute_return_net,benchmark_return_net,benchmark_scope,residual_return_net,cross_section_rank,
    adjustment_source,reference_contract_version) VALUES (?,?,?,?,?,?,1,1,1,1,0,0,0,0,'market',0,0.5,'test',?)`)
  const rejection = db.prepare(`INSERT INTO canonical_selection_label_rejections_v4(signal_date,symbol,producer_run_id,reason_code,as_of_date)
    VALUES (?,?,?,'price_missing',?)`)
  const evidence = db.prepare(`INSERT INTO strategy_route_versioned_evidence_v1(route_version,signal_date,symbol,producer_run_id,
    route_score,incumbent_route_version,strategy_spec_version,evidence_method,source_reference_contract,evidence_artifact_id,
    source_sha,row_checksum,artifact_checksum) VALUES (?,?,?,?,55,'incumbent','spec','production_forward','ref','artifact','sha','row','art')`)
  for (const item of seeds) {
    const ref = item.run?.ref ?? V4_REF
    const labeler = item.run?.labeler ?? V4_LAB
    if (item.run !== null) {
      run.run(item.producer, item.date, item.run?.status ?? 'ready', 2, 3, item.run?.expected ?? 6, item.run?.expected ?? 6,
        'registry', labeler, ref)
    }
    for (const [symbol, strategy, evaluable, hit, evidenceCount, cellLabeler, cellRef] of item.cells ?? []) {
      cell.run(item.date, symbol, item.producer, strategy, hit, evaluable, evidenceCount, STRATEGY_ROUTE_AFFINITY_VERSION,
        cellLabeler ?? labeler, cellRef ?? ref)
    }
    for (const [symbol, gate, affinity, routeVersion, routeScore, refLabeler, refContract] of item.references ?? []) {
      reference.run(item.date, symbol, item.producer, gate, refContract ?? ref, refLabeler ?? labeler, affinity, routeVersion, routeScore)
    }
    for (const [symbol, known] of item.labels ?? []) {
      label.run(item.date, symbol, item.producer, `${item.date}T`, known, known, ref)
    }
    for (const symbol of item.rejections ?? []) rejection.run(item.date, symbol, item.producer, AS_OF)
    for (const symbol of item.routeEvidence ?? []) evidence.run(STRATEGY_ROUTE_CHALLENGER_VERSION, item.date, symbol, item.producer)
  }
}

const fullCells = (prefix = ''): NonNullable<Seed['cells']> => [
  [`${prefix}1101`, 's1', 1, 1, 1], [`${prefix}1101`, 's2', 1, 0, 0], [`${prefix}1101`, 's3', 0, 0, 0],
  [`${prefix}2330`, 's1', 1, 1, 0], [`${prefix}2330`, 's2', 1, 1, 2], [`${prefix}2330`, 's3', 0, 1, 1],
]

function scenario(): { seeds: Seed[]; heads: Record<string, string> } {
  const seeds: Seed[] = [
    {
      // Complete current carrier, plus a foreign producer and stray cells on the same date.
      date: '2026-09-01', producer: 'head-0901',
      cells: [...fullCells(), ['1101', 's4', 1, 1, 1, 'other-labeler'], ['2330', 's4', 1, 1, 1, undefined, V3_REF]],
      references: [
        ['1101', 1, STRATEGY_ROUTE_AFFINITY_VERSION, STRATEGY_ROUTE_CHALLENGER_VERSION, 61, undefined, undefined],
        ['2330', 1, STRATEGY_ROUTE_AFFINITY_VERSION, null, null, undefined, undefined],
        ['2603', 0, STRATEGY_ROUTE_AFFINITY_VERSION, null, null, undefined, undefined],
        ['2882', 1, null, null, null, 'other-labeler', undefined],
      ],
      labels: [['1101', '2026-09-08'], ['2330', '2026-11-20']],
      rejections: ['2330'],
      routeEvidence: ['2330'],
    },
    { date: '2026-09-01', producer: 'foreign-0901', cells: fullCells(), references: [['1101', 1, null, null, null]] },
    // Legacy mature carrier and the pit reconstruction labeler.
    { date: '2026-09-02', producer: 'head-0902', run: { ref: V3_REF, labeler: V3_LAB }, cells: fullCells(),
      references: [['1101', 1, STRATEGY_ROUTE_AFFINITY_VERSION, null, null], ['2330', 1, null, null, null]],
      labels: [['1101', '2026-09-09'], ['2330', '2026-09-09']] },
    { date: '2026-09-03', producer: 'head-0903', run: { labeler: PIT_LAB, expected: 7 }, cells: fullCells().slice(0, 5),
      references: [['1101', 1, STRATEGY_ROUTE_AFFINITY_VERSION, STRATEGY_ROUTE_CHALLENGER_VERSION, 40]] },
    // Not formal: header still writing, or an incompatible pair; its cells must not count.
    { date: '2026-09-04', producer: 'head-0904', run: { status: 'writing' }, cells: fullCells(),
      references: [['1101', 1, STRATEGY_ROUTE_AFFINITY_VERSION, null, null]] },
    { date: '2026-09-05', producer: 'head-0905', run: { ref: V3_REF, labeler: V4_LAB }, cells: fullCells(),
      references: [['1101', 1, null, null, null]] },
    // Ready formal header without cells, and a head without any header.
    { date: '2026-09-08', producer: 'head-0908', references: [['1101', 1, null, null, null]] },
    { date: '2026-09-09', producer: 'head-0909', run: null, cells: fullCells(), references: [['1101', 1, null, null, null]] },
    // Head producer whose formal header carries another date (cells carry that date).
    { date: '2026-09-11', producer: 'head-0910', cells: fullCells(), references: [['1101', 1, null, null, null]] },
    // Head date before the audit window.
    { date: '2026-06-30', producer: 'head-0630', cells: fullCells(), references: [['1101', 1, null, null, null]] },
    // A superseded producer of a head date.
    { date: '2026-09-15', producer: 'stale-0915', cells: fullCells(), references: [['1101', 1, null, null, null]] },
    { date: '2026-09-15', producer: 'head-0915', cells: fullCells('9'), references: [['91101', 1, STRATEGY_ROUTE_AFFINITY_VERSION, null, null]],
      labels: [['91101', '2026-09-22']] },
    // One producer is the head of two dates; its header and cells are on the first.
    // matrix_counts must join on the head's date as well as its producer.
    { date: '2026-09-17', producer: 'dup-0917', cells: fullCells(), references: [['1101', 1, STRATEGY_ROUTE_AFFINITY_VERSION, null, null]] },
  ]
  const heads: Record<string, string> = {
    '2026-06-30': 'head-0630',
    '2026-09-01': 'head-0901',
    '2026-09-02': 'head-0902',
    '2026-09-03': 'head-0903',
    '2026-09-04': 'head-0904',
    '2026-09-05': 'head-0905',
    '2026-09-08': 'head-0908',
    '2026-09-09': 'head-0909',
    '2026-09-10': 'head-0910',
    '2026-09-15': 'head-0915',
    '2026-09-16': 'head-missing',
    '2026-09-17': 'dup-0917',
    '2026-09-18': 'dup-0917',
  }
  return { seeds, heads }
}

async function capture(db: DatabaseSync, heads: Record<string, string>, startDate = START): Promise<Recorded> {
  const log: Recorded[] = []
  await auditStrategyRouteBackfillEligibility(d1(db, log), AS_OF, { startDate, persist: false, canonicalRunIds: heads })
  const query = log.find((entry) => entry.sql.includes('WITH canonical_heads AS'))
  assert(query, 'eligibility query not issued')
  return query
}

test('eligibility rows are identical to the former correlated-COUNT SQL', async () => {
  const db = schema()
  const { seeds, heads } = scenario()
  seed(db, seeds)
  for (const startDate of [START, '2026-09-02']) {
    const query = await capture(db, heads, startDate)
    const values = query.params as never[]
    const expected = db.prepare(FORMER_SQL).all(...values)
    const actual = db.prepare(query.sql).all(...values)
    assert.ok(expected.length >= 9)
    assert.deepEqual(actual, expected)
  }
  const current = db.prepare(FORMER_SQL).all(...(await capture(db, heads)).params as never[]) as Array<Record<string, unknown>>
  const head0901 = current.find((row) => row.signal_date === '2026-09-01')!
  // Foreign producers, other labelers and other contracts stay out of the counts.
  assert.equal(head0901.matrix_rows, 6)
  assert.equal(head0901.evaluable_matrix_rows, 4)
  assert.equal(head0901.matched_matrix_rows, 3)
  assert.equal(head0901.threshold_margin_rows, 2)
  assert.equal(current.find((row) => row.signal_date === '2026-09-04')!.matrix_rows, 0)
  assert.equal(current.find((row) => row.signal_date === '2026-09-10')!.matrix_rows, 0)
  assert.equal(current.find((row) => row.signal_date === '2026-09-17')!.matrix_rows, 6)
  assert.equal(current.find((row) => row.signal_date === '2026-09-18')!.matrix_rows, 0)
})

test('eligibility output is unchanged end to end', async () => {
  const db = schema()
  const { seeds, heads } = scenario()
  seed(db, seeds)
  const query = await capture(db, heads)
  const rows = await auditStrategyRouteBackfillEligibility(d1(db), AS_OF, { startDate: START, persist: false, canonicalRunIds: heads })
  const former = db.prepare(FORMER_SQL).all(...query.params as never[]) as Array<Record<string, unknown>>
  assert.deepEqual(rows.map((row) => [row.signalDate, row.producerRunId, row.matrixRows, row.evaluableMatrixRows,
    row.matchedMatrixRows, row.thresholdMarginRows, row.referenceRows, row.matureLabelRows, row.rejectedLabelRows,
    row.challengerAffinityRows, row.challengerRouteRows]), former.map((row) => [row.signal_date, row.producer_run_id,
    row.matrix_rows, row.evaluable_matrix_rows, row.matched_matrix_rows, row.threshold_margin_rows, row.reference_rows,
    row.mature_label_rows, row.rejected_label_rows, row.challenger_affinity_rows, row.challenger_route_rows]))
})

test('eligibility plan reads the matrix once by its signal_date prefix', async () => {
  const db = schema()
  const { seeds, heads } = scenario()
  seed(db, seeds)
  const query = await capture(db, heads)
  const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...query.params as never[]) as Array<{ detail: string }>)
    .map((row) => row.detail)
  const matrixSteps = (details: string[]) => details.filter((detail) => /^(SCAN|SEARCH) m\b/.test(detail))
  const current = plan(query.sql)
  assert.equal(matrixSteps(plan(FORMER_SQL)).length, 4)
  assert.equal(matrixSteps(current).length, 1, current.join('\n'))
  assert.match(matrixSteps(current)[0], /^SEARCH m USING (?:COVERING )?INDEX \w+ \(signal_date=\?/)
  assert.ok(!current.some((detail) => /^SCAN (m|r|mr|l|q|e)\b/.test(detail)), current.join('\n'))
})
