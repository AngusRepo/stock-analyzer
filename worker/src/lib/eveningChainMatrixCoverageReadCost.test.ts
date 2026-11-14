import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { auditEveningChainEvidenceClosure } from './eveningChainEvidenceClosure'
import {
  SELECTION_REFERENCE_CONTRACT_VERSION,
  SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION,
} from './selectionReferenceEvidence'
import { STRATEGY_ROUTE_AFFINITY_VERSION } from './strategyRouteCalibration'
import {
  STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
  STRATEGY_FORMAL_LABELER_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
} from './strategySpec'

// The closure's matrix coverage reads must return what the former SQL returned
// (counts filtered by producer_run_id alone, which scanned the whole matrix);
// the former SQL text is the reference. Matrix cells always carry their run's
// signal_date, so the new reads stay within that key prefix.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const REF = SELECTION_REFERENCE_CONTRACT_VERSION
const LEGACY_REF = SELECTION_REFERENCE_LEGACY_MATURE_CONTRACT_VERSION
const LAB = STRATEGY_FORMAL_LABELER_VERSION
const RECON = STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION
const LEGACY_LAB = STRATEGY_FORMAL_LABELER_LEGACY_VERSION
const AFF = STRATEGY_ROUTE_AFFINITY_VERSION

const FORMER_MATRIX_SQL = `
    SELECT r.expected_cell_count, r.persisted_cell_count,
           (SELECT COUNT(*) FROM strategy_label_matrix_v4 m WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version) matrix_rows,
           (SELECT COUNT(*) FROM strategy_label_matrix_v4 m WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1) matched_rows,
           (SELECT COUNT(*) FROM strategy_label_matrix_v4 m WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1 AND m.affinity_evidence_count>0) threshold_evidence_rows,
           (SELECT COUNT(*) FROM strategy_label_matrix_v4 m WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.challenger_affinity_version=?) challenger_projection_rows,
           (SELECT COUNT(*) FROM strategy_label_matrix_v4 m WHERE m.producer_run_id=r.producer_run_id AND m.labeler_version=r.labeler_version AND m.evaluable=1 AND m.strategy_hit=1 AND m.affinity_evidence_count>0 AND m.challenger_affinity_version=?) projected_threshold_rows
      FROM strategy_label_matrix_runs_v4 r
     WHERE r.signal_date=? AND r.status='ready' AND r.producer_run_id=?
       AND r.reference_contract_version=?
       AND r.labeler_version IN (?, ?)
     LIMIT 1
`

const FORMER_MATURE_SQL = `
      SELECT reference_candidate_count, expected_cell_count, persisted_cell_count,
             labeler_version, reference_contract_version,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.producer_run_id=mr.producer_run_id
                 AND m.labeler_version=mr.labeler_version
                 AND m.reference_contract_version=mr.reference_contract_version) matrix_rows,
             (SELECT COUNT(*) FROM selection_reference_snapshots_v1 r
               WHERE r.signal_date=mr.signal_date AND r.producer_run_id=mr.producer_run_id
                 AND r.hard_gate_passed=1
                 AND r.strategy_labeler_version=mr.labeler_version
                 AND r.feature_contract_version=mr.reference_contract_version) reference_contract_rows
        FROM strategy_label_matrix_runs_v4 mr
       WHERE signal_date=? AND producer_run_id=? AND status='ready'
         AND (
           (reference_contract_version=? AND labeler_version IN (?, ?))
           OR
           (reference_contract_version=? AND labeler_version IN (?, ?))
         )
         AND NOT EXISTS (
           SELECT 1 FROM strategy_label_matrix_v4 m
            WHERE m.producer_run_id=mr.producer_run_id
              AND m.labeler_version<>mr.labeler_version
         )
       LIMIT 1
`

type Recorded = { sql: string; params: unknown[] }
const STOP = 'stop_after_mature_matrix'

// Answers every other closure read with passing values and records the two
// matrix coverage reads, then stops the audit.
function recordingEnv(log: Recorded[], mature: { date: string; producer: string }): any {
  const first = (sql: string, params: unknown[]): unknown => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.includes('SUM(CASE WHEN r.stock_id IS NOT NULL')) {
      return { reference_rows: 6, identity_rows: 6, artifact_rows: 6, reconciled_rows: 6, reference_projection_rows: 6 }
    }
    if (normalized.includes('FROM strategy_label_matrix_runs_v4 r ')) {
      log.push({ sql, params })
      return {
        expected_cell_count: 12, persisted_cell_count: 12, matrix_rows: 12, matched_rows: 4,
        threshold_evidence_rows: 4, challenger_projection_rows: 12, projected_threshold_rows: 4,
      }
    }
    if (normalized.includes('FROM strategy_redundancy_artifacts_v1')) return { status: 'pass', evidence_artifact_id: 'artifact' }
    if (normalized.includes('FROM sector_flow')) return { sector_rows: 1, breadth_rows: 1 }
    if (normalized.includes('FROM market_trading_sessions')) return { session_date: mature.date }
    if (normalized.includes('FROM canonical_run_heads')) return { run_id: mature.producer, signal_date: mature.date }
    if (normalized.includes('FROM strategy_label_matrix_runs_v4 mr ')) {
      log.push({ sql, params })
      throw new Error(STOP)
    }
    throw new Error(`unexpected SQL: ${normalized}`)
  }
  const db = {
    prepare(sql: string) {
      let params: unknown[] = []
      const statement = {
        bind(...bound: unknown[]) { params = bound; return statement },
        async first() { return first(sql, params) },
        async all() { throw new Error(`unexpected SQL all: ${sql}`) },
      }
      return statement
    },
  }
  return { DB: db, MULTI_D1_ACTIVE_DOMAINS: '' }
}

async function capture(businessDate: string, producer: string, matureDate: string, matureProducer: string): Promise<{
  matrix: Recorded
  mature: Recorded
}> {
  const log: Recorded[] = []
  await assert.rejects(
    auditEveningChainEvidenceClosure(recordingEnv(log, { date: matureDate, producer: matureProducer }), businessDate, producer),
    new RegExp(STOP),
  )
  assert.equal(log.length, 2)
  return { matrix: log[0], mature: log[1] }
}

function schema(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(read('../../domain-schemas/learning.sql'))
  db.exec(read('../../domain-migrations/learning/0064_drop_redundant_date_indexes.sql'))
  return db
}

type Cell = { symbol: string; strategy: string; evaluable?: number; hit?: number; evidence?: number; challenger?: string | null; labeler?: string; ref?: string }

function seedRun(db: DatabaseSync, run: {
  producer: string; date: string; status?: string; labeler: string; ref: string; expected?: number; cells: Cell[]; references?: Array<{ symbol: string; gate?: number; labeler?: string; ref?: string }>
}): void {
  db.prepare(`INSERT INTO strategy_label_matrix_runs_v4(producer_run_id,signal_date,status,reference_candidate_count,
    strategy_count,expected_cell_count,persisted_cell_count,strategy_registry_checksum,labeler_version,reference_contract_version)
    VALUES (?,?,?,?,?,?,?,'registry',?,?)`).run(run.producer, run.date, run.status ?? 'ready', run.references?.length ?? 3, 4,
    run.expected ?? run.cells.length, run.expected ?? run.cells.length, run.labeler, run.ref)
  const cell = db.prepare(`INSERT INTO strategy_label_matrix_v4(signal_date,symbol,producer_run_id,strategy_id,strategy_version,
    strategy_status,alpha_bucket,family_id,production_owner,strategy_hit,evaluable,evaluability_status,weak_label,affinity,
    affinity_evidence_count,position_weight,challenger_affinity_version,overlap,labeler_version,strategy_registry_checksum,
    reference_contract_version) VALUES (?,?,?,?,'v1','active','alpha','fam',1,?,?,'EVALUABLE',1,1,?,0,?,0,?,'registry',?)`)
  for (const item of run.cells) {
    cell.run(run.date, item.symbol, run.producer, item.strategy, item.hit ?? 0, item.evaluable ?? 0, item.evidence ?? 0,
      item.challenger === undefined ? AFF : item.challenger, item.labeler ?? run.labeler, item.ref ?? run.ref)
  }
  const reference = db.prepare(`INSERT INTO selection_reference_snapshots_v1(signal_date,symbol,producer_run_id,hard_gate_passed,
    hard_gate_reason,feature_available,strategy_labeled,strategy_selected,selection_stage,strategy_registry_checksum,
    feature_contract_version,strategy_labeler_version) VALUES (?,?,?,?,'ok',1,1,0,'scored','registry',?,?)`)
  for (const item of run.references ?? []) {
    reference.run(run.date, item.symbol, run.producer, item.gate ?? 1, item.ref ?? run.ref, item.labeler ?? run.labeler)
  }
}

function grid(symbols: string[], strategies: string[], pick: (index: number) => Partial<Cell> = () => ({})): Cell[] {
  return symbols.flatMap((symbol, s) => strategies.map((strategy, k) => ({ symbol, strategy, ...pick(s * strategies.length + k) })))
}

const mixed = (index: number): Partial<Cell> => ({
  evaluable: index % 4 === 3 ? 0 : 1,
  hit: index % 3 === 0 ? 1 : 0,
  evidence: index % 6 === 0 ? 0 : 1,
  challenger: index === 5 ? null : AFF,
})

function scenario(): DatabaseSync {
  const db = schema()
  const symbols = ['1101', '2330', '2603']
  const strategies = ['s1', 's2', 's3', 's4']
  // Business date: the head run, a foreign producer and a stale reconstruction on the same date.
  seedRun(db, { producer: 'head-1112', date: '2026-11-12', labeler: LAB, ref: REF, cells: [
    ...grid(symbols, strategies, mixed),
    // Other labeler cells of the head producer: never counted by either read.
    { symbol: '2882', strategy: 's1', evaluable: 1, hit: 1, evidence: 1, labeler: RECON },
  ] })
  seedRun(db, { producer: 'foreign-1112', date: '2026-11-12', labeler: LAB, ref: REF, cells: grid(symbols, strategies, () => ({ evaluable: 1, hit: 1, evidence: 1 })) })
  seedRun(db, { producer: 'writing-1112', date: '2026-11-12', status: 'writing', labeler: LAB, ref: REF, cells: grid(symbols, strategies) })
  seedRun(db, { producer: 'recon-1112', date: '2026-11-12', labeler: RECON, ref: REF, cells: grid(symbols, strategies, mixed) })
  seedRun(db, { producer: 'oldref-1112', date: '2026-11-12', labeler: LAB, ref: LEGACY_REF, cells: grid(symbols, strategies) })
  seedRun(db, { producer: 'empty-1112', date: '2026-11-12', labeler: LAB, ref: REF, expected: 12, cells: [] })
  // Mature date: a current carrier, a legacy carrier, and runs whose cells mix labelers.
  const references = symbols.map((symbol) => ({ symbol }))
  seedRun(db, { producer: 'mature-1105', date: '2026-11-05', labeler: LAB, ref: REF, cells: [
    ...grid(symbols, strategies),
    { symbol: '2882', strategy: 's1', ref: LEGACY_REF },
  ], references: [...references, { symbol: '9999', gate: 0 }, { symbol: '8888', labeler: RECON }] })
  seedRun(db, { producer: 'foreign-1105', date: '2026-11-05', labeler: RECON, ref: REF, cells: grid(symbols, strategies, () => ({ labeler: LEGACY_LAB })) })
  seedRun(db, { producer: 'legacy-0710', date: '2026-07-10', labeler: LEGACY_LAB, ref: LEGACY_REF, cells: grid(symbols, strategies), references })
  seedRun(db, { producer: 'mixed-1104', date: '2026-11-04', labeler: LAB, ref: REF, cells: [
    ...grid(symbols, strategies),
    { symbol: '2882', strategy: 's1', labeler: RECON },
  ], references })
  return db
}

const cases: Array<[string, string, string, string]> = [
  ['2026-11-12', 'head-1112', '2026-11-05', 'mature-1105'],
  ['2026-11-12', 'foreign-1112', '2026-07-10', 'legacy-0710'],
  ['2026-11-12', 'recon-1112', '2026-11-04', 'mixed-1104'],
  ['2026-11-12', 'writing-1112', '2026-11-05', 'foreign-1105'],
  ['2026-11-12', 'oldref-1112', '2026-11-06', 'mature-1105'],
  ['2026-11-12', 'empty-1112', '2026-11-05', 'missing'],
  ['2026-11-11', 'head-1112', '2026-07-10', 'mature-1105'],
  ['2026-11-12', 'missing', '2026-11-05', 'mature-1105'],
]

test('closure matrix coverage rows are identical to the former producer-only SQL', async () => {
  const db = scenario()
  const observed: unknown[] = []
  for (const [businessDate, producer, matureDate, matureProducer] of cases) {
    const { matrix, mature } = await capture(businessDate, producer, matureDate, matureProducer)
    assert.deepEqual(matrix.params.length, (FORMER_MATRIX_SQL.match(/\?/g) ?? []).length)
    assert.deepEqual(mature.params.length, (FORMER_MATURE_SQL.match(/\?/g) ?? []).length)
    const formerMatrix = db.prepare(FORMER_MATRIX_SQL).get(...matrix.params as never[])
    const formerMature = db.prepare(FORMER_MATURE_SQL).get(...mature.params as never[])
    assert.deepEqual(db.prepare(matrix.sql).get(...matrix.params as never[]), formerMatrix, `${businessDate}:${producer}`)
    assert.deepEqual(db.prepare(mature.sql).get(...mature.params as never[]), formerMature, `${matureDate}:${matureProducer}`)
    observed.push(formerMatrix, formerMature)
  }
  // The cases cover present, absent, empty and blocked rows.
  const [headMatrix, headMature] = observed as Array<Record<string, unknown> | undefined>
  assert.deepEqual({ ...headMatrix }, {
    expected_cell_count: 13, persisted_cell_count: 13, matrix_rows: 12, matched_rows: 3,
    threshold_evidence_rows: 1, challenger_projection_rows: 11, projected_threshold_rows: 1,
  })
  assert.equal(headMature?.matrix_rows, 12)
  assert.equal(headMature?.reference_contract_rows, 3)
  assert.equal(observed[5], undefined)
  assert.deepEqual({ ...(observed[10] as object) }, {
    expected_cell_count: 12, persisted_cell_count: 12, matrix_rows: 0, matched_rows: 0,
    threshold_evidence_rows: 0, challenger_projection_rows: 0, projected_threshold_rows: 0,
  })
  assert.equal(observed[11], undefined)
  assert.equal(observed[6], undefined)
})

test('closure matrix coverage reads search the matrix by signal_date', async () => {
  const db = scenario()
  const { matrix, mature } = await capture('2026-11-12', 'head-1112', '2026-11-05', 'mature-1105')
  const plan = (entry: Recorded) => (db.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...entry.params as never[]) as Array<{ detail: string }>)
    .map((row) => row.detail)
  for (const entry of [matrix, mature]) {
    const details = plan(entry)
    const matrixSteps = details.filter((detail) => /^(SCAN|SEARCH) m\b/.test(detail))
    assert.ok(matrixSteps.length > 0 && matrixSteps.every((detail) => /^SEARCH m USING (?:COVERING )?INDEX \w+ \(signal_date=\?/.test(detail)), details.join('\n'))
  }
  assert.equal(plan(matrix).filter((detail) => /^SEARCH m\b/.test(detail)).length, 1)
})

test('a cell of the run on another signal_date is intentionally not counted', async () => {
  // persistSelectionEvidenceV4 throws strategy_label_matrix_row_contract_mismatch
  // when a matrix row's signal_date differs from input.signalDate
  // (selectionReferenceEvidence.ts ~688-700), and writes the run header and its
  // cells in one batch from that same date, so such a cell cannot be written.
  // Were one present, the former producer-only counts would include it and the
  // date-keyed reads do not.
  const db = scenario()
  db.prepare(`INSERT INTO strategy_label_matrix_v4(signal_date,symbol,producer_run_id,strategy_id,strategy_version,
    strategy_status,alpha_bucket,family_id,production_owner,strategy_hit,evaluable,evaluability_status,weak_label,affinity,
    affinity_evidence_count,position_weight,challenger_affinity_version,overlap,labeler_version,strategy_registry_checksum,
    reference_contract_version) VALUES (?,?,?,'s1','v1','active','alpha','fam',1,1,1,'EVALUABLE',1,1,1,0,?,0,?,'registry',?)`)
    .run('2026-11-10', '1101', 'head-1112', AFF, LAB, REF)
  db.prepare(`INSERT INTO strategy_label_matrix_v4(signal_date,symbol,producer_run_id,strategy_id,strategy_version,
    strategy_status,alpha_bucket,family_id,production_owner,strategy_hit,evaluable,evaluability_status,weak_label,affinity,
    affinity_evidence_count,position_weight,challenger_affinity_version,overlap,labeler_version,strategy_registry_checksum,
    reference_contract_version) VALUES (?,?,?,'s1','v1','active','alpha','fam',1,0,0,'EVALUABLE',1,1,0,0,?,0,?,'registry',?)`)
    .run('2026-11-03', '1101', 'mature-1105', AFF, RECON, REF)
  const { matrix, mature } = await capture('2026-11-12', 'head-1112', '2026-11-05', 'mature-1105')
  const formerMatrix = db.prepare(FORMER_MATRIX_SQL).get(...matrix.params as never[]) as Record<string, unknown>
  const currentMatrix = db.prepare(matrix.sql).get(...matrix.params as never[]) as Record<string, unknown>
  assert.equal(formerMatrix.matrix_rows, 13)
  assert.equal(currentMatrix.matrix_rows, 12)
  assert.equal(formerMatrix.projected_threshold_rows, 2)
  assert.equal(currentMatrix.projected_threshold_rows, 1)
  // The former NOT EXISTS saw the other-date, other-labeler cell and dropped the run.
  assert.equal(db.prepare(FORMER_MATURE_SQL).get(...mature.params as never[]), undefined)
  assert.equal((db.prepare(mature.sql).get(...mature.params as never[]) as Record<string, unknown>).matrix_rows, 12)
})
