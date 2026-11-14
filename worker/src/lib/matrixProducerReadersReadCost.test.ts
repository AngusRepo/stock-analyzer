import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { SELECTION_REFERENCE_CONTRACT_VERSION } from './selectionReferenceEvidence'
import { STRATEGY_ROUTE_AFFINITY_VERSION } from './strategyRouteCalibration'
import { STRATEGY_FORMAL_LABELER_VERSIONS, STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION } from './strategySpec'

// The dashboard maturity packet (pipelineDecisionMaturity.ts) and the pipeline
// tracking route (routes/other.ts) must return what their former
// producer_run_id-only matrix reads returned; the former SQL text is the
// reference and the current SQL is read from the source. Matrix cells always
// carry their run header's signal_date.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const PLACEHOLDERS = STRATEGY_FORMAL_LABELER_VERSIONS.map(() => '?').join(',')
const [LAB, LEGACY_LAB] = STRATEGY_FORMAL_LABELER_VERSIONS
const RECON = STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION
const REF = SELECTION_REFERENCE_CONTRACT_VERSION
const AFF = STRATEGY_ROUTE_AFFINITY_VERSION
const INCUMBENT_LAB = 'strategy-labeler-incumbent-test'

const formerMaturity = (labelerFilter: string, tail: string) => `
      SELECT r.status, r.reference_candidate_count, r.strategy_count,
             r.expected_cell_count, r.persisted_cell_count, r.labeler_version,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1) matched_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1
                 AND m.affinity_evidence_count>0) raw_threshold_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1
                 AND m.affinity_evidence_count>0 AND m.challenger_affinity_version=?) projected_threshold_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.challenger_affinity_version=?) challenger_projection_cells,
             r.updated_at
        FROM strategy_label_matrix_runs_v4 r
       WHERE r.signal_date=? AND r.producer_run_id=?
         AND r.status='ready'
         AND r.reference_contract_version=?
         AND r.labeler_version ${labelerFilter} (${PLACEHOLDERS})
       ${tail}
`
const FORMER_MATURITY_PRIMARY = formerMaturity('IN', 'LIMIT 1')
const FORMER_MATURITY_INCUMBENT = formerMaturity('NOT IN', 'ORDER BY r.updated_at DESC\n       LIMIT 1')
const FORMER_TRACKING = `
    SELECT symbol, strategy_id
      FROM strategy_label_matrix_v4
     WHERE producer_run_id = ?
       AND production_owner = 1
       AND strategy_hit = 1
       AND EXISTS (
         SELECT 1 FROM strategy_label_matrix_runs_v4 mr
          WHERE mr.producer_run_id=strategy_label_matrix_v4.producer_run_id
            AND mr.status='ready'
            AND mr.labeler_version IN (${PLACEHOLDERS})
            AND mr.labeler_version=strategy_label_matrix_v4.labeler_version
       )
`

function currentMaturitySql(): string[] {
  const source = read('./pipelineDecisionMaturity.ts')
  const queries = [...source.matchAll(/learningDb\.prepare\(`(\s*SELECT r\.status, r\.reference_candidate_count[\s\S]*?)`\)/g)]
    .map((match) => match[1].replaceAll('${formalLabelerPlaceholders}', PLACEHOLDERS))
  assert.equal(queries.length, 2)
  assert.ok(queries.every((sql) => !sql.includes('${')))
  return queries
}

function currentTrackingSql(): string {
  const source = read('../routes/other.ts')
  const match = source.match(/const \{ results: rawMatrixRows \} = await learningDb\.prepare\(`([\s\S]*?)`\)/)
  assert.ok(match)
  const sql = match[1].replaceAll("${STRATEGY_FORMAL_LABELER_VERSIONS.map(() => '?').join(',')}", PLACEHOLDERS)
  assert.ok(!sql.includes('${'))
  return sql
}

function schema(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(read('../../domain-schemas/learning.sql'))
  db.exec(read('../../domain-migrations/learning/0064_drop_redundant_date_indexes.sql'))
  return db
}

type Cell = { symbol: string; strategy: string; evaluable?: number; hit?: number; evidence?: number; challenger?: string | null; owner?: number; labeler?: string }

function seedRun(db: DatabaseSync, run: { producer: string; date: string; status?: string; labeler: string; ref?: string; updatedAt?: string; cells: Cell[] }): void {
  db.prepare(`INSERT INTO strategy_label_matrix_runs_v4(producer_run_id,signal_date,status,reference_candidate_count,
    strategy_count,expected_cell_count,persisted_cell_count,strategy_registry_checksum,labeler_version,reference_contract_version,updated_at)
    VALUES (?,?,?,3,4,?,?,'registry',?,?,?)`).run(run.producer, run.date, run.status ?? 'ready', run.cells.length, run.cells.length,
    run.labeler, run.ref ?? REF, run.updatedAt ?? '2026-11-12 10:00:00')
  const cell = db.prepare(`INSERT INTO strategy_label_matrix_v4(signal_date,symbol,producer_run_id,strategy_id,strategy_version,
    strategy_status,alpha_bucket,family_id,production_owner,strategy_hit,evaluable,evaluability_status,weak_label,affinity,
    affinity_evidence_count,position_weight,challenger_affinity_version,overlap,labeler_version,strategy_registry_checksum,
    reference_contract_version) VALUES (?,?,?,?,'v1','active','alpha','fam',?,?,?,'EVALUABLE',1,1,?,0,?,0,?,'registry',?)`)
  for (const item of run.cells) {
    cell.run(run.date, item.symbol, run.producer, item.strategy, item.owner ?? 1, item.hit ?? 0, item.evaluable ?? 0,
      item.evidence ?? 0, item.challenger === undefined ? AFF : item.challenger, item.labeler ?? run.labeler, run.ref ?? REF)
  }
}

const SYMBOLS = ['2330', '1101', '2603']
const STRATEGIES = ['s3', 's1', 's4', 's2']
function grid(pick: (index: number) => Partial<Cell> = () => ({})): Cell[] {
  return SYMBOLS.flatMap((symbol, s) => STRATEGIES.map((strategy, k) => ({ symbol, strategy, ...pick(s * STRATEGIES.length + k) })))
}
const mixed = (index: number): Partial<Cell> => ({
  evaluable: index % 4 === 3 ? 0 : 1,
  hit: index % 3 === 0 || index % 5 === 0 ? 1 : 0,
  evidence: index % 6 === 0 ? 0 : 1,
  challenger: index === 5 ? null : AFF,
  owner: index % 7 === 2 ? 0 : 1,
})

function scenario(): DatabaseSync {
  const db = schema()
  seedRun(db, { producer: 'head-1112', date: '2026-11-12', labeler: LAB, cells: [
    ...grid(mixed),
    // Stray other-labeler cell of the head producer: excluded by both reads.
    { symbol: '2882', strategy: 's1', evaluable: 1, hit: 1, evidence: 1, labeler: RECON },
  ] })
  seedRun(db, { producer: 'foreign-1112', date: '2026-11-12', labeler: LAB, cells: grid(() => ({ evaluable: 1, hit: 1, evidence: 1 })) })
  seedRun(db, { producer: 'legacy-1112', date: '2026-11-12', labeler: LEGACY_LAB, cells: grid(mixed) })
  seedRun(db, { producer: 'writing-1112', date: '2026-11-12', status: 'writing', labeler: LAB, cells: grid(mixed) })
  seedRun(db, { producer: 'incumbent-1112', date: '2026-11-12', labeler: INCUMBENT_LAB, cells: grid(mixed) })
  seedRun(db, { producer: 'empty-1112', date: '2026-11-12', labeler: LAB, cells: [] })
  seedRun(db, { producer: 'head-1111', date: '2026-11-11', labeler: RECON, cells: grid(mixed) })
  return db
}

const PRODUCERS: Array<[string, string]> = [
  ['2026-11-12', 'head-1112'], ['2026-11-12', 'foreign-1112'], ['2026-11-12', 'legacy-1112'],
  ['2026-11-12', 'writing-1112'], ['2026-11-12', 'incumbent-1112'], ['2026-11-12', 'empty-1112'],
  ['2026-11-11', 'head-1111'], ['2026-11-12', 'head-1111'], ['2026-11-12', 'missing'],
]

const plan = (db: DatabaseSync, sql: string, params: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
  .all(...params as never[]) as Array<{ detail: string }>).map((row) => row.detail)
const matrixSteps = (details: string[]) => details.filter((detail) => /^(SCAN|SEARCH) (m|strategy_label_matrix_v4)\b/.test(detail))

test('maturity matrix rows are identical to the former producer-only SQL', () => {
  const db = scenario()
  const [primary, incumbent] = currentMaturitySql()
  const seen = { primary: 0, incumbent: 0 }
  for (const [date, producer] of PRODUCERS) {
    const params = [AFF, AFF, date, producer, REF, ...STRATEGY_FORMAL_LABELER_VERSIONS]
    const formerPrimary = db.prepare(FORMER_MATURITY_PRIMARY).get(...params as never[])
    const formerIncumbent = db.prepare(FORMER_MATURITY_INCUMBENT).get(...params as never[])
    assert.deepEqual(db.prepare(primary).get(...params as never[]), formerPrimary, `${date}:${producer}`)
    assert.deepEqual(db.prepare(incumbent).get(...params as never[]), formerIncumbent, `${date}:${producer}`)
    if (formerPrimary) seen.primary += 1
    if (formerIncumbent) seen.incumbent += 1
  }
  assert.deepEqual(seen, { primary: 5, incumbent: 1 })
  const head = db.prepare(primary).get(AFF, AFF, '2026-11-12', 'head-1112', REF, ...STRATEGY_FORMAL_LABELER_VERSIONS) as Record<string, unknown>
  assert.deepEqual([head.matched_rows, head.raw_threshold_rows, head.projected_threshold_rows, head.challenger_projection_cells], [5, 3, 2, 11])
  for (const sql of [primary, incumbent]) {
    const details = plan(db, sql, [AFF, AFF, '2026-11-12', 'head-1112', REF, ...STRATEGY_FORMAL_LABELER_VERSIONS])
    assert.equal(matrixSteps(details).length, 4)
    assert.ok(matrixSteps(details).every((detail) => /^SEARCH m USING (?:COVERING )?INDEX \w+ \(signal_date=\?/.test(detail)), details.join('\n'))
  }
})

test('pipeline tracking matrix rows are identical to the former producer-only SQL', () => {
  const db = scenario()
  const current = currentTrackingSql()
  let nonEmpty = 0
  for (const [, producer] of PRODUCERS) {
    const former = db.prepare(FORMER_TRACKING).all(producer, ...STRATEGY_FORMAL_LABELER_VERSIONS)
    // Same rows in the same (rowid) order.
    assert.deepEqual(db.prepare(current).all(producer, producer, ...STRATEGY_FORMAL_LABELER_VERSIONS), former, producer)
    if (former.length) nonEmpty += 1
  }
  assert.equal(nonEmpty, 5)
  const details = plan(db, current, ['head-1112', 'head-1112', ...STRATEGY_FORMAL_LABELER_VERSIONS])
  assert.equal(matrixSteps(plan(db, FORMER_TRACKING, ['head-1112', ...STRATEGY_FORMAL_LABELER_VERSIONS]))[0], 'SCAN strategy_label_matrix_v4')
  assert.equal(matrixSteps(details).length, 1)
  assert.match(matrixSteps(details)[0], /^SEARCH strategy_label_matrix_v4 USING (?:COVERING )?INDEX \w+ \(signal_date=\?/, details.join('\n'))
})
