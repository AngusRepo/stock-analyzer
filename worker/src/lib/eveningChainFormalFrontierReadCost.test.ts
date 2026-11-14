import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { auditFormalStrategyEvidenceFrontier, buildFormalFrontierClosureSql } from './eveningChainEvidenceClosure'
import { STRATEGY_ROUTE_AFFINITY_VERSION } from './strategyRouteCalibration'

// The formal frontier audit runs on every evening-chain closure over every canonical head since
// 2026-08-18. Its five correlated matrix COUNTs each re-read all producers' cells of the head date
// (the matrix key prefix is signal_date alone). The single-pass form must return exactly what the
// former SQL returned, kept verbatim below as the reference, and touch the matrix once per page.
const AFF = STRATEGY_ROUTE_AFFINITY_VERSION
const MIGRATIONS = new URL('../../domain-migrations/learning/', import.meta.url)

const formerSql = (values: string) => `
      WITH target(signal_date, producer_run_id) AS (VALUES ${values})
      SELECT t.signal_date, t.producer_run_id,
             e.status ledger_status, e.labeler_version ledger_labeler_version,
             e.evaluation_contract_version,
             e.producer_run_id ledger_producer_run_id,
             e.source_reference_contract_version,
             e.production_policy_id,
             e.production_policy_knowledge_cutoff_date,
             e.production_policy_checksum,
             e.production_policy_source_contract,
             (SELECT COUNT(*) FROM strategy_production_policy_history_v1 p
               WHERE p.policy_id=e.production_policy_id
                 AND p.knowledge_cutoff_date=e.production_policy_knowledge_cutoff_date
                 AND p.checksum=e.production_policy_checksum
                 AND p.status='active') production_policy_rows,
             mr.status matrix_status, mr.labeler_version matrix_labeler_version,
             mr.reference_contract_version, mr.reference_candidate_count,
             mr.expected_cell_count, mr.persisted_cell_count,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.signal_date=t.signal_date AND m.producer_run_id=t.producer_run_id
                 AND m.labeler_version=mr.labeler_version
                 AND m.strategy_registry_checksum=mr.strategy_registry_checksum
                 AND m.reference_contract_version=mr.reference_contract_version) matrix_contract_rows,
             (SELECT COUNT(*) FROM selection_reference_snapshots_v1 r
               WHERE r.signal_date=t.signal_date AND r.producer_run_id=t.producer_run_id
                 AND r.hard_gate_passed=1
                 AND r.strategy_labeler_version=mr.labeler_version
                 AND r.strategy_registry_checksum=mr.strategy_registry_checksum
                 AND r.feature_contract_version=mr.reference_contract_version) reference_contract_rows,
             (SELECT COUNT(*) FROM selection_reference_snapshots_v1 r
               WHERE r.signal_date=t.signal_date AND r.producer_run_id=t.producer_run_id
                 AND r.hard_gate_passed=1
                 AND r.strategy_challenger_affinity_version=?) reference_projection_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.signal_date=t.signal_date AND m.producer_run_id=t.producer_run_id
                 AND m.challenger_affinity_version=?) challenger_projection_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.signal_date=t.signal_date AND m.producer_run_id=t.producer_run_id
                 AND m.evaluable=1 AND m.strategy_hit=1) matched_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.signal_date=t.signal_date AND m.producer_run_id=t.producer_run_id
                 AND m.evaluable=1 AND m.strategy_hit=1 AND m.affinity_evidence_count>0) threshold_evidence_rows,
             (SELECT COUNT(*) FROM strategy_label_matrix_v4 m
               WHERE m.signal_date=t.signal_date AND m.producer_run_id=t.producer_run_id
                 AND m.evaluable=1 AND m.strategy_hit=1 AND m.affinity_evidence_count>0
                 AND m.challenger_affinity_version=?) projected_threshold_rows
        FROM target t
        LEFT JOIN strategy_label_matrix_runs_v4 mr
          ON mr.signal_date=t.signal_date AND mr.producer_run_id=t.producer_run_id
        LEFT JOIN strategy_evidence_rebuild_runs_v5 e ON e.signal_date=t.signal_date
       ORDER BY t.signal_date
`

function learningDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'))
  }
  return db
}

const HEADS = [
  { signal_date: '2026-09-01', producer_run_id: 'run-a' }, // run + cells + a stale-labeler cell + another producer's cells
  { signal_date: '2026-09-02', producer_run_id: 'run-b' }, // cells without a matrix run
  { signal_date: '2026-09-03', producer_run_id: 'run-c' }, // matrix run without cells
  { signal_date: '2026-09-04', producer_run_id: 'run-d' }, // nothing
]

function seed(db: DatabaseSync): void {
  const run = db.prepare(`INSERT INTO strategy_label_matrix_runs_v4 (producer_run_id, signal_date, status,
    reference_candidate_count, strategy_count, expected_cell_count, persisted_cell_count,
    strategy_registry_checksum, labeler_version, reference_contract_version) VALUES (?, ?, 'ready', 3, 2, 6, 6, 'chk', 'lab', 'ref')`)
  run.run('run-a', '2026-09-01')
  run.run('run-x', '2026-09-01')
  run.run('run-c', '2026-09-03')
  const cell = db.prepare(`INSERT INTO strategy_label_matrix_v4 (signal_date, symbol, producer_run_id, strategy_id,
    strategy_version, strategy_status, alpha_bucket, family_id, production_owner, strategy_hit, evaluable,
    weak_label, affinity, affinity_evidence_count, position_weight, challenger_affinity_version, overlap,
    labeler_version, strategy_registry_checksum, reference_contract_version)
    VALUES (?, ?, ?, ?, 'v1', 'active', 'a', 'f', 0, ?, ?, 0, 0, ?, 0, ?, 0, ?, 'chk', 'ref')`)
  let n = 0
  for (const [date, producer] of [['2026-09-01', 'run-a'], ['2026-09-01', 'run-x'], ['2026-09-02', 'run-b']]) {
    for (const symbol of ['1101', '2330', '2454']) {
      for (const strategy of ['s1', 's2']) {
        n += 1
        cell.run(date, symbol, producer, strategy, n % 3 === 0 ? 0 : 1, n % 4 === 0 ? 0 : 1, n % 5,
          n % 2 === 0 ? AFF : null, n === 2 ? 'stale-lab' : 'lab')
      }
    }
  }
  db.prepare(`INSERT INTO strategy_evidence_rebuild_runs_v5 (signal_date, status, producer_run_id,
    evaluation_contract_version, source_reference_contract_version) VALUES (?, 'success', ?, 'strategy-evaluation-v2', 'ref')`)
    .run('2026-09-01', 'run-a')
  db.prepare(`INSERT INTO strategy_evidence_rebuild_runs_v5 (signal_date, status) VALUES ('2026-09-03', 'blocked')`).run()
}

const values = HEADS.map(() => '(?, ?)').join(', ')
const binds = [...HEADS.flatMap((head) => [head.signal_date, head.producer_run_id]), AFF, AFF, AFF]

function plan(db: DatabaseSync, sql: string): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>).map((row) => row.detail)
}

test('the single-pass frontier closure returns what the five correlated COUNTs returned', () => {
  const db = learningDb()
  seed(db)
  const former = db.prepare(formerSql(values)).all(...binds)
  const current = db.prepare(buildFormalFrontierClosureSql(values)).all(...binds)
  assert.equal(current.length, HEADS.length)
  assert.deepEqual(current, former)
  const first = current[0] as Record<string, number>
  // Non-trivial counts: the stale-labeler cell drops out of matrix_contract_rows only, and the
  // other producer's cells of the same date never count.
  assert.equal(first.matrix_contract_rows, 5)
  assert.ok(first.matched_rows > 0 && first.challenger_projection_rows > 0)
})

test('the frontier closure reads the matrix once per head date, by its signal_date key', () => {
  const db = learningDb()
  const formerPlan = plan(db, formerSql(values))
  const currentPlan = plan(db, buildFormalFrontierClosureSql(values))
  const matrixReads = (rows: string[]) => rows.filter((row) => /^(SEARCH|SCAN) m\b/.test(row))
  assert.equal(matrixReads(formerPlan).length, 5, formerPlan.join('\n'))
  assert.equal(matrixReads(currentPlan).length, 1, currentPlan.join('\n'))
  assert.match(matrixReads(currentPlan)[0], /^SEARCH m USING INDEX \S+ \(signal_date=\?\)/, currentPlan.join('\n'))
  assert.doesNotMatch(currentPlan.join('\n'), /SCAN (m|mr|e|r|p|strategy_label_matrix_v4)\b/, currentPlan.join('\n'))
})

test('auditFormalStrategyEvidenceFrontier issues the single-pass closure SQL', async () => {
  const learning = learningDb()
  seed(learning)
  const seen: string[] = []
  const shim = (db: DatabaseSync | null, rows: unknown[] = []): any => {
    const statement = (sql: string, params: unknown[] = []): any => ({
      bind: (...next: unknown[]) => statement(sql, next),
      async all() {
        if (!db) return { success: true, results: rows }
        seen.push(sql)
        return { success: true, results: db.prepare(sql).all(...(params as any[])) }
      },
      async first() { return db ? db.prepare(sql).get(...(params as any[])) ?? null : null },
    })
    return { prepare: (sql: string) => statement(sql) }
  }
  await auditFormalStrategyEvidenceFrontier(shim(learning), shim(null, HEADS), shim(null, []), '2026-09-04')
  const closure = seen.find((sql) => sql.includes('WITH target(signal_date, producer_run_id)'))
  assert.ok(closure, 'frontier closure query not issued')
  const closurePlan = (learning.prepare(`EXPLAIN QUERY PLAN ${closure}`).all(...binds) as Array<{ detail: string }>)
    .map((row) => row.detail)
  assert.equal(closurePlan.filter((row) => /^(SEARCH|SCAN) m\b/.test(row)).length, 1, closurePlan.join('\n'))
})
