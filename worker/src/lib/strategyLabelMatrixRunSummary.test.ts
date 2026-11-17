import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { auditFormalStrategyEvidenceFrontier } from './eveningChainEvidenceClosure'
import { STRATEGY_AFFINITY_CHALLENGER_VERSION } from './multiStrategyPleRouter'
import { SELECTION_REFERENCE_CONTRACT_VERSION } from './selectionReferenceEvidence'
import {
  MATRIX_RUN_SUMMARY_CHALLENGER_VERSION,
  MATRIX_RUN_SUMMARY_CLEAR_SQL,
  MATRIX_RUN_SUMMARY_VERSION,
  matrixRunSummaryRefreshBinds,
  matrixRunSummaryRefreshSql,
  matrixRunSummaryUsableInline,
  readMatrixRunSummary,
} from './strategyLabelMatrixRunSummary'
import { STRATEGY_ROUTE_AFFINITY_VERSION } from './strategyRouteCalibration'
import {
  STRATEGY_FORMAL_LABELER_VERSION,
  STRATEGY_FORMAL_LABELER_VERSIONS,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
} from './strategySpec'

// The run-header count summary (learning 0065) must equal the cell counts the
// readers computed before, and readers must return the same answer whether a
// run is summarised or not. Plans must stay on the matrix key prefix.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const AFF = MATRIX_RUN_SUMMARY_CHALLENGER_VERSION
const LAB = STRATEGY_FORMAL_LABELER_VERSION
const RECON = STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION
const REF = SELECTION_REFERENCE_CONTRACT_VERSION

function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = []
      const values = () => params.map((value) => (value === undefined ? null : value)) as never[]
      const statement = {
        bind(...bound: unknown[]) { params = bound; return statement },
        async all() { return { success: true, results: db.prepare(sql).all(...values()), meta: {} } },
        async first() { return db.prepare(sql).get(...values()) ?? null },
        async run() { return { success: true, meta: { changes: Number(db.prepare(sql).run(...values()).changes) } } },
      }
      return statement
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      const out = []
      for (const statement of statements) out.push(await statement.run())
      return out
    },
  } as unknown as D1Database
}

// Every learning migration in order (the deployed shape), plus the ops/market
// tables the closure audit joins.
function replayed(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const dir = new URL('../../domain-migrations/learning/', import.meta.url)
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, dir), 'utf8'))
  }
  db.exec(read('../../domain-schemas/ops.sql').match(/CREATE TABLE IF NOT EXISTS canonical_run_heads \([\s\S]*?\n\);/)![0])
  db.exec(read('../../domain-schemas/market.sql').match(/CREATE TABLE IF NOT EXISTS market_trading_sessions \([\s\S]*?\n\);/)![0])
  return db
}

type Cell = { evaluable: number; hit: number; evidence: number; challenger: string | null; labeler?: string; checksum?: string }

function seedRun(db: DatabaseSync, run: { producer: string; date: string; labeler?: string; cells: Cell[]; references?: number; projected?: boolean }): void {
  const labeler = run.labeler ?? LAB
  const references = run.references ?? 3
  db.prepare(`INSERT INTO strategy_label_matrix_runs_v4(producer_run_id,signal_date,status,reference_candidate_count,
    strategy_count,expected_cell_count,persisted_cell_count,strategy_registry_checksum,labeler_version,reference_contract_version)
    VALUES (?,?,'ready',?,?,?,?,'registry',?,?)`)
    .run(run.producer, run.date, references, Math.max(1, Math.round(run.cells.length / references)), run.cells.length, run.cells.length, labeler, REF)
  const cell = db.prepare(`INSERT INTO strategy_label_matrix_v4(signal_date,symbol,producer_run_id,strategy_id,strategy_version,
    strategy_status,alpha_bucket,family_id,production_owner,strategy_hit,evaluable,evaluability_status,weak_label,affinity,
    affinity_evidence_count,position_weight,challenger_affinity_version,overlap,labeler_version,strategy_registry_checksum,
    reference_contract_version) VALUES (?,?,?,?,'v1','active','alpha','fam',1,?,?,'EVALUABLE',1,1,?,0,?,0,?,?,?)`)
  run.cells.forEach((item, index) => {
    cell.run(run.date, `S${index % references}`, run.producer, `strategy-${Math.floor(index / references)}`,
      item.hit, item.evaluable, item.evidence, item.challenger, item.labeler ?? labeler, item.checksum ?? 'registry', REF)
  })
  const reference = db.prepare(`INSERT INTO selection_reference_snapshots_v1(signal_date,symbol,producer_run_id,hard_gate_passed,
    hard_gate_reason,feature_available,strategy_labeled,strategy_selected,selection_stage,strategy_registry_checksum,
    feature_contract_version,strategy_labeler_version,strategy_challenger_affinity_version) VALUES (?,?,?,1,'ok',1,1,0,'scored','registry',?,?,?)`)
  for (let index = 0; index < references; index++) {
    reference.run(run.date, `S${index}`, run.producer, REF, labeler, run.projected === false ? null : AFF)
  }
}

const cellsOf = (count: number, pick: (index: number) => Partial<Cell>): Cell[] => Array.from({ length: count }, (_, index) => ({
  evaluable: 1, hit: 1, evidence: 1, challenger: AFF, ...pick(index),
}))

const RUNS = [
  // Complete and projected.
  { producer: 'complete', date: '2026-09-01', cells: cellsOf(12, (i) => ({ hit: i % 3 === 0 ? 1 : 0, evaluable: i % 5 === 4 ? 0 : 1 })) },
  // Matched cells without threshold evidence, and a half-done projection.
  { producer: 'partial', date: '2026-09-02', cells: cellsOf(12, (i) => ({ evidence: i % 4 === 0 ? 0 : 1, challenger: i < 6 ? AFF : null })) },
  // Reconstruction labeler, nothing matched.
  { producer: 'recon', date: '2026-09-03', labeler: RECON, cells: cellsOf(9, () => ({ hit: 0 })) },
  // One cell off the header contract: the summary must not be used.
  { producer: 'mixed', date: '2026-09-04', cells: cellsOf(9, (i) => (i === 0 ? { checksum: 'other-registry' } : {})) },
  { producer: 'mixed-labeler', date: '2026-09-05', cells: cellsOf(9, (i) => (i === 0 ? { labeler: RECON } : {})) },
  // A header with no cells.
  { producer: 'empty', date: '2026-09-08', cells: [] as Cell[], references: 3 },
]

function seedAll(db: DatabaseSync): void {
  for (const run of RUNS) seedRun(db, run)
}

function summariseAll(db: DatabaseSync): void {
  for (const run of RUNS) db.prepare(matrixRunSummaryRefreshSql()).run(...matrixRunSummaryRefreshBinds(run.producer, run.date))
}

const directCounts = (db: DatabaseSync, producer: string, date: string) => db.prepare(`
  SELECT COUNT(m.symbol) matrix_rows,
         COALESCE(SUM(m.labeler_version=mr.labeler_version AND m.strategy_registry_checksum=mr.strategy_registry_checksum
                      AND m.reference_contract_version=mr.reference_contract_version), 0) contract_rows,
         COALESCE(SUM(m.evaluable=1), 0) evaluable_rows,
         COALESCE(SUM(m.evaluable=1 AND m.strategy_hit=1), 0) matched_rows,
         COALESCE(SUM(m.evaluable=1 AND m.strategy_hit=1 AND m.affinity_evidence_count>0), 0) threshold_evidence_rows,
         COALESCE(SUM(m.challenger_affinity_version=?), 0) challenger_projection_rows,
         COALESCE(SUM(m.evaluable=1 AND m.strategy_hit=1 AND m.affinity_evidence_count>0 AND m.challenger_affinity_version=?), 0) projected_threshold_rows
    FROM strategy_label_matrix_runs_v4 mr
    LEFT JOIN strategy_label_matrix_v4 m ON m.signal_date=mr.signal_date AND m.producer_run_id=mr.producer_run_id
   WHERE mr.producer_run_id=? AND mr.signal_date=?
`).get(AFF, AFF, producer, date) as Record<string, number>

test('summary challenger version is the projection and route affinity version', () => {
  assert.equal(MATRIX_RUN_SUMMARY_CHALLENGER_VERSION, STRATEGY_AFFINITY_CHALLENGER_VERSION)
  assert.equal(MATRIX_RUN_SUMMARY_CHALLENGER_VERSION, STRATEGY_ROUTE_AFFINITY_VERSION)
  assert.equal(MATRIX_RUN_SUMMARY_VERSION, `matrix-run-summary-v1|${AFF}`)
  assert.throws(() => matrixRunSummaryUsableInline('mr', "x' OR 1=1 --"), /matrix_run_summary_version_invalid/)
})

test('refresh writes the cell counts, and readers use only summaries that cover every cell', async () => {
  const db = replayed()
  seedAll(db)
  for (const run of RUNS) assert.equal(await readMatrixRunSummary(d1(db), run.date, run.producer, AFF), null, run.producer)
  summariseAll(db)
  for (const run of RUNS) {
    const header = db.prepare(`SELECT summary_version, summary_matrix_rows matrix_rows, summary_contract_rows contract_rows,
      summary_evaluable_rows evaluable_rows, summary_matched_rows matched_rows,
      summary_threshold_evidence_rows threshold_evidence_rows, summary_challenger_projection_rows challenger_projection_rows,
      summary_projected_threshold_rows projected_threshold_rows, updated_at
      FROM strategy_label_matrix_runs_v4 WHERE producer_run_id=?`).get(run.producer) as Record<string, unknown>
    const { summary_version: version, updated_at: _updated, ...counts } = header
    assert.equal(version, MATRIX_RUN_SUMMARY_VERSION, run.producer)
    assert.deepEqual({ ...counts }, { ...directCounts(db, run.producer, run.date) }, run.producer)
    const usable = await readMatrixRunSummary(d1(db), run.date, run.producer, AFF)
    if (run.producer.startsWith('mixed')) assert.equal(usable, null, run.producer)
    else assert.equal(usable?.matrixRows, run.cells.length, run.producer)
    // Another challenger version, another date, or a cleared summary: count the cells.
    assert.equal(await readMatrixRunSummary(d1(db), run.date, run.producer, 'other-affinity'), null)
    assert.equal(await readMatrixRunSummary(d1(db), '2026-01-01', run.producer, AFF), null)
  }
  db.prepare(MATRIX_RUN_SUMMARY_CLEAR_SQL).run('complete', '2026-09-01')
  assert.equal(await readMatrixRunSummary(d1(db), '2026-09-01', 'complete', AFF), null)
  // The refresh leaves updated_at alone (the V5 selector reads it as "run replaced").
  const before = db.prepare(`SELECT updated_at FROM strategy_label_matrix_runs_v4 WHERE producer_run_id='partial'`).get()
  db.prepare(`UPDATE strategy_label_matrix_runs_v4 SET updated_at='2026-09-30 00:00:00' WHERE producer_run_id='partial'`).run()
  db.prepare(matrixRunSummaryRefreshSql()).run(...matrixRunSummaryRefreshBinds('partial', '2026-09-02'))
  assert.equal((db.prepare(`SELECT updated_at FROM strategy_label_matrix_runs_v4 WHERE producer_run_id='partial'`).get() as any).updated_at,
    '2026-09-30 00:00:00')
})

test('refresh and summary reads seek the run instead of scanning the matrix', () => {
  const db = replayed()
  const plans = [
    db.prepare(`EXPLAIN QUERY PLAN ${matrixRunSummaryRefreshSql(' AND mr.promotion_attempt_id=? AND mr.payload_checksum=?')}`)
      .all(...matrixRunSummaryRefreshBinds('run', '2026-09-01'), 'attempt', 'checksum'),
    db.prepare(`EXPLAIN QUERY PLAN ${MATRIX_RUN_SUMMARY_CLEAR_SQL}`).all('run', '2026-09-01'),
  ].map((rows) => (rows as Array<{ detail: string }>).map((row) => row.detail).join('\n'))
  for (const plan of plans) {
    assert.doesNotMatch(plan, /SCAN (m|mr|strategy_label_matrix_v4|strategy_label_matrix_runs_v4)\b/, plan)
  }
  assert.match(plans[0], /SEARCH m USING (COVERING )?INDEX \S+ \(signal_date=\?/, plans[0])
  assert.match(plans[0], /SEARCH mr USING INDEX sqlite_autoindex_strategy_label_matrix_runs_v4_1 \(producer_run_id=\?\)/, plans[0])
})

test('evening frontier audit returns the same backlog for summarised and unsummarised runs', async () => {
  const db = replayed()
  seedAll(db)
  const heads = db.prepare(`INSERT INTO canonical_run_heads(logical_run_key, run_id, promoted_at) VALUES (?, ?, '2026-09-01T00:00:00Z')`)
  const session = db.prepare(`INSERT INTO market_trading_sessions(session_date, source, sample_size) VALUES (?, 'test', 1)`)
  for (const run of RUNS) {
    heads.run(`screener:${run.date}:TW:production:market_screener`, run.producer)
    session.run(run.date)
  }
  const audit = () => auditFormalStrategyEvidenceFrontier(d1(db), d1(db), d1(db), '2026-09-30')
  const unsummarised = await audit()
  assert.equal(unsummarised.backlog.length, RUNS.length)
  summariseAll(db)
  assert.deepEqual(await audit(), unsummarised)
  // The header answers once summarised: a cell changed behind the summary's back is not seen.
  db.prepare(`UPDATE strategy_label_matrix_v4 SET challenger_affinity_version=NULL WHERE producer_run_id='complete'`).run()
  assert.deepEqual(await audit(), unsummarised)
  db.prepare(MATRIX_RUN_SUMMARY_CLEAR_SQL).run('complete', '2026-09-01')
  assert.notDeepEqual(await audit(), unsummarised)
})

// pipelineDecisionMaturity thresholdHistory: the SQL text from the source with
// its placeholders filled, against the former producer-only join.
const FORMER_THRESHOLD_HISTORY = `
      WITH recent_dates AS (
        SELECT signal_date FROM strategy_label_matrix_runs_v4
         WHERE signal_date <= ? AND status = 'ready' AND labeler_version IN (LABELERS)
         GROUP BY signal_date ORDER BY signal_date DESC LIMIT 7
      ), ranked_runs AS (
        SELECT producer_run_id, signal_date, labeler_version,
               ROW_NUMBER() OVER (PARTITION BY signal_date ORDER BY updated_at DESC, producer_run_id DESC) ordinal
          FROM strategy_label_matrix_runs_v4 runs JOIN recent_dates USING (signal_date)
         WHERE runs.status = 'ready' AND runs.labeler_version IN (LABELERS)
      )
      SELECT run.signal_date evidence_date,
             SUM(CASE WHEN matrix.evaluable=1 AND matrix.strategy_hit=1 AND matrix.affinity_evidence_count>0
                       AND matrix.challenger_affinity_version=? THEN 1 ELSE 0 END) value,
             SUM(CASE WHEN matrix.evaluable=1 AND matrix.strategy_hit=1 THEN 1 ELSE 0 END) target
        FROM ranked_runs run
        JOIN strategy_label_matrix_v4 matrix
          ON matrix.producer_run_id=run.producer_run_id AND matrix.labeler_version=run.labeler_version
       WHERE run.ordinal=1
       GROUP BY run.signal_date ORDER BY run.signal_date DESC LIMIT 7`

function thresholdHistorySql(): string {
  const source = read('./pipelineDecisionMaturity.ts')
  const start = source.indexOf('WITH recent_dates AS (')
  const sql = source.slice(start, source.indexOf('`).bind(', start))
  const labelers = STRATEGY_FORMAL_LABELER_VERSIONS.map(() => '?').join(', ')
  return sql
    .replaceAll('${formalLabelerPlaceholders}', labelers)
    .replaceAll('${MATURITY_SUMMARY_USABLE}', matrixRunSummaryUsableInline('r', STRATEGY_ROUTE_AFFINITY_VERSION))
}

test('maturity threshold history equals the former join and seeks the matrix', () => {
  const db = replayed()
  seedAll(db)
  const sql = thresholdHistorySql()
  assert.doesNotMatch(sql, /\$\{/)
  const binds = ['2026-09-30', ...STRATEGY_FORMAL_LABELER_VERSIONS, ...STRATEGY_FORMAL_LABELER_VERSIONS, AFF]
  const former = db.prepare(FORMER_THRESHOLD_HISTORY.replaceAll('LABELERS', STRATEGY_FORMAL_LABELER_VERSIONS.map(() => '?').join(', ')))
    .all('2026-09-30', ...STRATEGY_FORMAL_LABELER_VERSIONS, ...STRATEGY_FORMAL_LABELER_VERSIONS, AFF)
  assert.equal((sql.match(/\?/g) ?? []).length, binds.length)
  const current = db.prepare(sql).all(...binds)
  assert.deepEqual(current, former)
  assert.ok(former.length >= 4)
  summariseAll(db)
  assert.deepEqual(db.prepare(sql).all(...binds), former)
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>).map((row) => row.detail).join('\n')
  assert.doesNotMatch(plan, /SCAN (m|matrix|strategy_label_matrix_v4)\b/, plan)
  assert.match(plan, /SEARCH m USING (COVERING )?INDEX \S+ \(signal_date=\?/, plan)
})

test('the challenger projection clears the summary before rewriting cells and refreshes it after', () => {
  const source = read('./strategyLearning.ts')
  const clear = source.indexOf('await db.prepare(MATRIX_RUN_SUMMARY_CLEAR_SQL).bind(producerRunId, date).run()')
  const projection = source.indexOf('UPDATE strategy_label_matrix_v4\n                 SET production_owner=?')
  const referenceProjection = source.indexOf('UPDATE selection_reference_snapshots_v1\n               SET strategy_challenger_affinity_version=?')
  const refresh = source.indexOf('await db.prepare(matrixRunSummaryRefreshSql())\n            .bind(...matrixRunSummaryRefreshBinds(producerRunId, date)).run()')
  assert.ok(clear > 0 && projection > clear && referenceProjection > projection && refresh > referenceProjection,
    JSON.stringify({ clear, projection, referenceProjection, refresh }))
  // The promotion batch summarises in the same transaction as the cells.
  const writer = read('./selectionReferenceEvidence.ts')
  const cells = writer.indexOf('INSERT INTO strategy_label_matrix_v4 (')
  const header = writer.indexOf('INSERT INTO strategy_label_matrix_runs_v4 (')
  const summary = writer.indexOf("matrixRunSummaryRefreshSql(' AND mr.promotion_attempt_id=? AND mr.payload_checksum=?')")
  const promoted = writer.indexOf("SET status='promoted'")
  assert.ok(cells > 0 && header > cells && summary > header && promoted > summary)
})
