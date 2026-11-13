import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { MATRIX_RUN_SUMMARY_CLEAR_SQL, MATRIX_RUN_SUMMARY_VERSION, matrixRunSummaryRefreshBinds, matrixRunSummaryRefreshSql } from './strategyLabelMatrixRunSummary'
import { STRATEGY_EVIDENCE_V5_LIVE_FRONTIER_START_DATE } from './strategyEvidenceV5Contract'
import { drainHistoricalStrategyEvidenceV5, listHistoricalStrategyEvidenceV5Dates } from './strategyLearning'
import {
  STRATEGY_FORMAL_LABELER_LEGACY_VERSION,
  STRATEGY_FORMAL_LABELER_VERSION,
  STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION,
} from './strategySpec'

// The live-frontier selector must return what the former valid_runs query
// returned, except that a current success ledger over a matrix run not touched
// since that success is trusted instead of re-counted. The former SQL text is
// the reference.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const RECON = STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION
const V4_REF = 'selection-reference-snapshot-v4-regime-veto-evidence'
const V3_REF = 'selection-reference-snapshot-v3'
const CHALLENGER = 'strategy-threshold-margin-affinity-v2'
const AS_OF = '2026-10-30'
const CHECKSUM = 'a'.repeat(64)

const FORMER_SQL = `
    WITH source_dates AS (
      SELECT mr.signal_date date, mr.producer_run_id
        FROM strategy_label_matrix_runs_v4 mr
       WHERE mr.signal_date>=? AND mr.signal_date<=?
         AND mr.status='ready'
         AND EXISTS (
           SELECT 1 FROM json_each(?) h
            WHERE h.key=mr.signal_date
              AND h.value=mr.producer_run_id
         )
       GROUP BY mr.signal_date, mr.producer_run_id
    ),
    valid_runs AS (
      SELECT mr.signal_date, mr.producer_run_id, mr.reference_contract_version
        FROM strategy_label_matrix_runs_v4 mr
       WHERE mr.signal_date<=?
         AND mr.status='ready'
         AND mr.labeler_version IN (
           '${STRATEGY_FORMAL_LABELER_VERSION}',
           '${STRATEGY_FORMAL_LABELER_LEGACY_VERSION}',
           '${STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION}'
         )
         AND mr.reference_contract_version IN (
           'selection-reference-snapshot-v4-regime-veto-evidence',
           'selection-reference-snapshot-v3'
         )
         AND mr.expected_cell_count > 0
         AND mr.persisted_cell_count=mr.expected_cell_count
         AND (
           SELECT COUNT(*)
             FROM strategy_label_matrix_v4 m
            WHERE m.signal_date=mr.signal_date
              AND m.producer_run_id=mr.producer_run_id
              AND m.labeler_version=mr.labeler_version
              AND m.strategy_registry_checksum=mr.strategy_registry_checksum
              AND m.reference_contract_version=mr.reference_contract_version
              AND m.challenger_affinity_version='strategy-threshold-margin-affinity-v2'
         )=mr.expected_cell_count
         AND (
           SELECT COUNT(*)
             FROM strategy_label_matrix_v4 m
            WHERE m.signal_date=mr.signal_date
              AND m.producer_run_id=mr.producer_run_id
              AND m.evaluable=1 AND m.strategy_hit=1 AND m.affinity_evidence_count>0
         )=(
           SELECT COUNT(*)
             FROM strategy_label_matrix_v4 m
            WHERE m.signal_date=mr.signal_date
              AND m.producer_run_id=mr.producer_run_id
              AND m.evaluable=1 AND m.strategy_hit=1 AND m.affinity_evidence_count>0
              AND m.challenger_affinity_version='strategy-threshold-margin-affinity-v2'
         )
         AND (
           SELECT COUNT(*)
             FROM selection_reference_snapshots_v1 sr
            WHERE sr.signal_date=mr.signal_date
              AND sr.producer_run_id=mr.producer_run_id
              AND sr.strategy_labeler_version=mr.labeler_version
              AND sr.strategy_registry_checksum=mr.strategy_registry_checksum
              AND sr.feature_contract_version=mr.reference_contract_version
              AND sr.strategy_challenger_affinity_version='strategy-threshold-margin-affinity-v2'
         )=mr.reference_candidate_count
         AND EXISTS (
           SELECT 1 FROM json_each(?) h
            WHERE h.key=mr.signal_date
              AND h.value=mr.producer_run_id
         )
       GROUP BY mr.signal_date, mr.producer_run_id, mr.reference_contract_version
    )
    SELECT d.date
      FROM source_dates d
      LEFT JOIN strategy_evidence_rebuild_runs_v5 r ON r.signal_date=d.date
      LEFT JOIN valid_runs v ON v.signal_date=d.date AND v.producer_run_id=d.producer_run_id
     WHERE (
         r.signal_date IS NULL
         OR COALESCE(r.evaluation_contract_version, '') <> 'strategy-evaluation-v2'
         OR COALESCE(r.labeler_version, '') <> '${STRATEGY_FORMAL_RECONSTRUCTION_LABELER_VERSION}'
         OR r.status <> 'success'
         OR (r.status='success' AND v.signal_date IS NULL)
         OR COALESCE(r.producer_run_id, '') <> d.producer_run_id
         OR COALESCE(r.source_reference_contract_version, '') <> COALESCE(v.reference_contract_version, '')
         OR COALESCE(r.production_policy_id, '') = ''
         OR COALESCE(r.production_policy_knowledge_cutoff_date, '') >= d.date
         OR length(COALESCE(r.production_policy_checksum, '')) <> 64
         OR COALESCE(r.production_policy_source_contract, '') = ''
       )
     ORDER BY d.date ASC
     LIMIT ?
`

type Recorded = { sql: string; params: unknown[] }

function d1(db: DatabaseSync, log?: Recorded[]): D1Database {
  const prepare = (sql: string) => {
    let params: unknown[] = []
    const values = () => params.map((value) => value === undefined ? null : value) as never[]
    const statement = {
      bind(...bound: unknown[]) { params = bound; return statement },
      async all() {
        log?.push({ sql, params })
        return { success: true, results: db.prepare(sql).all(...values()), meta: {} }
      },
      async first() {
        log?.push({ sql, params })
        return db.prepare(sql).get(...values()) ?? null
      },
      async run() {
        log?.push({ sql, params })
        const result = db.prepare(sql).run(...values())
        return { success: true, results: [], meta: { changes: Number(result.changes) } }
      },
    }
    return statement
  }
  return {
    prepare,
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const results = []
      for (const statement of statements) results.push(await statement.run())
      return results
    },
  } as unknown as D1Database
}

type DateCase = {
  date: string
  run?: string
  ledger?: Record<string, unknown> | null
  matrixUpdatedAt?: string
  ledgerUpdatedAt?: string
  runOverrides?: Record<string, unknown>
  break?: 'matrix_contract' | 'threshold_projection' | 'reference'
}

function schema(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(read('../../domain-schemas/learning.sql'))
  db.exec(read('../../domain-migrations/learning/0064_drop_redundant_date_indexes.sql'))
  return db
}

function seed(db: DatabaseSync, cases: DateCase[]): Record<string, string> {
  const heads: Record<string, string> = {}
  const run = db.prepare(`INSERT INTO strategy_label_matrix_runs_v4(producer_run_id,signal_date,status,reference_candidate_count,
    strategy_count,expected_cell_count,persisted_cell_count,strategy_registry_checksum,labeler_version,reference_contract_version,
    created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  const cell = db.prepare(`INSERT INTO strategy_label_matrix_v4(signal_date,symbol,producer_run_id,strategy_id,strategy_version,
    strategy_status,alpha_bucket,family_id,production_owner,strategy_hit,evaluable,evaluability_status,weak_label,affinity,
    affinity_evidence_count,position_weight,challenger_affinity_version,overlap,labeler_version,strategy_registry_checksum,
    reference_contract_version) VALUES (?,?,?,?,'v1','active','alpha','fam',1,1,1,'EVALUABLE',1,1,?,0,?,0,?,?,?)`)
  const reference = db.prepare(`INSERT INTO selection_reference_snapshots_v1(signal_date,symbol,producer_run_id,hard_gate_passed,
    hard_gate_reason,feature_available,strategy_labeled,strategy_selected,selection_stage,strategy_registry_checksum,
    feature_contract_version,strategy_labeler_version,strategy_challenger_affinity_version) VALUES (?,?,?,1,'ok',1,1,0,'scored',?,?,?,?)`)
  const ledger = db.prepare(`INSERT INTO strategy_evidence_rebuild_runs_v5(signal_date,status,labeler_version,evaluation_contract_version,
    producer_run_id,source_reference_contract_version,production_policy_id,production_policy_knowledge_cutoff_date,
    production_policy_checksum,production_policy_source_contract,blocker_reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (const item of cases) {
    const producer = item.run ?? `run-${item.date}`
    const symbols = ['1101', '2330']
    const strategies = ['s1', 's2']
    const runRow = {
      status: 'ready',
      reference_candidate_count: symbols.length,
      strategy_count: strategies.length,
      expected_cell_count: symbols.length * strategies.length,
      persisted_cell_count: symbols.length * strategies.length,
      strategy_registry_checksum: 'registry',
      labeler_version: STRATEGY_FORMAL_LABELER_VERSION,
      reference_contract_version: V4_REF,
      ...item.runOverrides,
    }
    run.run(producer, item.date, runRow.status, runRow.reference_candidate_count, runRow.strategy_count,
      runRow.expected_cell_count, runRow.persisted_cell_count, runRow.strategy_registry_checksum, runRow.labeler_version,
      runRow.reference_contract_version, '2026-09-01 00:00:00', item.matrixUpdatedAt ?? '2026-10-01 10:00:00')
    symbols.forEach((symbol, symbolIndex) => {
      strategies.forEach((strategy, strategyIndex) => {
        const first = symbolIndex === 0 && strategyIndex === 0
        cell.run(item.date, symbol, producer, strategy, 1,
          first && item.break === 'threshold_projection' ? 'legacy-affinity' : CHALLENGER,
          runRow.labeler_version,
          first && item.break === 'matrix_contract' ? 'other-registry' : 'registry',
          runRow.reference_contract_version)
      })
      if (!(symbolIndex === 0 && item.break === 'reference')) {
        reference.run(item.date, symbol, producer, 'registry', runRow.reference_contract_version, runRow.labeler_version, CHALLENGER)
      }
    })
    heads[item.date] = producer
    if (item.ledger === null) continue
    const row = {
      status: 'success',
      labeler_version: RECON,
      evaluation_contract_version: 'strategy-evaluation-v2',
      producer_run_id: producer,
      source_reference_contract_version: runRow.reference_contract_version,
      production_policy_id: 'policy-1',
      production_policy_knowledge_cutoff_date: '2026-08-01',
      production_policy_checksum: CHECKSUM,
      production_policy_source_contract: 'contract-1',
      blocker_reason: null,
      ...item.ledger,
    }
    ledger.run(item.date, row.status, row.labeler_version, row.evaluation_contract_version, row.producer_run_id,
      row.source_reference_contract_version, row.production_policy_id, row.production_policy_knowledge_cutoff_date,
      row.production_policy_checksum, row.production_policy_source_contract, row.blocker_reason,
      item.ledgerUpdatedAt ?? '2026-10-02 10:00:00')
  }
  return heads
}

function former(db: DatabaseSync, heads: Record<string, string>, limit = 5, frontierEnd = AS_OF): string[] {
  const json = JSON.stringify(heads)
  return (db.prepare(FORMER_SQL).all(STRATEGY_EVIDENCE_V5_LIVE_FRONTIER_START_DATE, frontierEnd, json, frontierEnd, json, limit) as Array<{ date: string }>)
    .map((row) => row.date)
}

async function current(db: DatabaseSync, heads: Record<string, string>, log?: Recorded[], priorityDate?: string): Promise<string[]> {
  return listHistoricalStrategyEvidenceV5Dates(d1(db, log), {
    asOfDate: AS_OF,
    maxDates: 5,
    priorityDate,
    resolveCanonicalScreenerRunIds: async () => heads,
  })
}

// Every case is a separate date; `same` is whether the former and current
// selectors must agree, `expected` what the current selector returns.
const CASES: Array<DateCase & { name: string; expected: boolean; same: boolean }> = [
  { name: 'no ledger', date: '2026-09-01', ledger: null, expected: true, same: true },
  { name: 'failed ledger', date: '2026-09-02', ledger: { status: 'failed', blocker_reason: 'boom' }, expected: true, same: true },
  { name: 'pending ledger', date: '2026-09-03', ledger: { status: 'pending' }, expected: true, same: true },
  { name: 'stale labeler', date: '2026-09-04', ledger: { labeler_version: 'strategy-decision-log-pit-reconstruction-v6' }, expected: true, same: true },
  { name: 'stale evaluation contract', date: '2026-09-05', ledger: { evaluation_contract_version: null }, expected: true, same: true },
  { name: 'blocked ledger', date: '2026-09-07', ledger: { status: 'blocked', blocker_reason: 'reference_lineage_incomplete' }, expected: true, same: true },
  { name: 'wrong producer run', date: '2026-09-08', ledger: { producer_run_id: 'run-other' }, expected: true, same: true },
  { name: 'missing policy checksum', date: '2026-09-09', ledger: { production_policy_checksum: 'short' }, expected: true, same: true },
  { name: 'policy cutoff not before date', date: '2026-09-10', ledger: { production_policy_knowledge_cutoff_date: '2026-09-10' }, expected: true, same: true },
  { name: 'success unchanged', date: '2026-09-11', expected: false, same: true },
  { name: 'success unchanged same second', date: '2026-09-14', matrixUpdatedAt: '2026-10-02 10:00:00', expected: false, same: true },
  { name: 'success unchanged iso ledger', date: '2026-09-15', ledgerUpdatedAt: '2026-10-02T10:00:00.000Z', expected: false, same: true },
  { name: 'success matrix changed valid', date: '2026-09-16', matrixUpdatedAt: '2026-10-03 10:00:00', expected: false, same: true },
  { name: 'success matrix changed contract gap', date: '2026-09-17', matrixUpdatedAt: '2026-10-03 10:00:00', break: 'matrix_contract', expected: true, same: true },
  { name: 'success matrix changed projection gap', date: '2026-09-18', matrixUpdatedAt: '2026-10-03 10:00:00', break: 'threshold_projection', expected: true, same: true },
  { name: 'success matrix changed reference gap', date: '2026-09-21', matrixUpdatedAt: '2026-10-03 10:00:00', break: 'reference', expected: true, same: true },
  { name: 'success matrix unparseable timestamp', date: '2026-09-22', matrixUpdatedAt: 'not-a-time', break: 'reference', expected: true, same: true },
  { name: 'success reference contract mismatch', date: '2026-09-23', ledger: { source_reference_contract_version: V3_REF }, expected: true, same: true },
  { name: 'success v3 legacy run', date: '2026-09-24', runOverrides: { labeler_version: STRATEGY_FORMAL_LABELER_LEGACY_VERSION, reference_contract_version: V3_REF }, expected: false, same: true },
  { name: 'success unsupported run labeler', date: '2026-09-25', runOverrides: { labeler_version: 'strategy-labeler-v1' }, expected: true, same: true },
  { name: 'success partial persisted cells', date: '2026-09-28', runOverrides: { persisted_cell_count: 3 }, expected: true, same: true },
  { name: 'success no expected cells', date: '2026-09-29', runOverrides: { expected_cell_count: 0, persisted_cell_count: 0 }, expected: true, same: true },
  { name: 'pre-frontier no ledger', date: '2026-08-10', ledger: null, expected: false, same: true },
  { name: 'non-ready run', date: '2026-09-30', ledger: null, runOverrides: { status: 'failed' }, expected: false, same: true },
  { name: 'after frontier end', date: '2026-10-31', ledger: null, expected: false, same: true },
  // The one intended difference: a success ledger written over a run that
  // has not changed since is trusted rather than re-counted.
  { name: 'success unchanged with gap', date: '2026-10-01', break: 'reference', expected: false, same: false },
]

test('changed-only selector matches the former valid_runs selector case by case', async () => {
  const db = schema()
  const heads = seed(db, CASES)
  for (const item of CASES) {
    const only = { [item.date]: heads[item.date] }
    const got = await current(db, only)
    assert.deepEqual(got, item.expected ? [item.date] : [], item.name)
    const was = former(db, only)
    if (item.same) assert.deepEqual(got, was, `${item.name}: former ${JSON.stringify(was)}`)
    else assert.notDeepEqual(got, was, `${item.name} is the documented trusted-success case`)
  }
})

test('summarised runs select exactly the dates their cell counts select', async () => {
  const db = schema()
  const heads = seed(db, CASES)
  const before = await Promise.all(CASES.map((item) => current(db, { [item.date]: heads[item.date] })))
  const ready = db.prepare(`SELECT producer_run_id, signal_date FROM strategy_label_matrix_runs_v4 WHERE status='ready'`)
    .all() as Array<{ producer_run_id: string; signal_date: string }>
  for (const run of ready) {
    db.prepare(matrixRunSummaryRefreshSql()).run(...matrixRunSummaryRefreshBinds(run.producer_run_id, run.signal_date))
  }
  const summarised = db.prepare(`SELECT COUNT(*) n FROM strategy_label_matrix_runs_v4 WHERE summary_version=?`)
    .get(MATRIX_RUN_SUMMARY_VERSION) as { n: number }
  assert.equal(Number(summarised.n), ready.length)
  // A summary is answered from the header only when it stands for every cell.
  const log: Recorded[] = []
  const after = await Promise.all(CASES.map((item) => current(db, { [item.date]: heads[item.date] }, log)))
  assert.deepEqual(after, before)
  const changedValid = log.find((entry) => entry.sql.includes('WITH source_dates AS'))!
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${changedValid.sql}`).all(...changedValid.params as never[]) as Array<{ detail: string }>)
    .map((row) => row.detail).join('\n')
  assert.doesNotMatch(plan, /SCAN (m|sr|strategy_label_matrix_v4|selection_reference_snapshots_v1)\b/, plan)
  // The header answers for a usable summary: a cell rewritten without clearing
  // the summary (which no writer does) is not seen until the summary is cleared.
  const date = '2026-09-16'
  const only = { [date]: heads[date] }
  db.prepare(`UPDATE strategy_label_matrix_v4 SET challenger_affinity_version='legacy-affinity'
               WHERE signal_date=? AND producer_run_id=? AND symbol='1101' AND strategy_id='s1'`).run(date, heads[date])
  assert.deepEqual(await current(db, only), [])
  db.prepare(MATRIX_RUN_SUMMARY_CLEAR_SQL).run(heads[date], date)
  assert.deepEqual(await current(db, only), [date])
})

test('changed-only selector keeps order, limit, and the non-canonical run filter', async () => {
  const db = schema()
  const sameCases = CASES.filter((item) => item.same)
  const heads = seed(db, sameCases)
  // A second ready run for a validated date must not be selected or validated.
  seed(db, [{ date: '2026-09-11', run: 'run-2026-09-11-shadow', ledger: null, break: 'reference' }])
  const all = await current(db, heads)
  assert.deepEqual(all, former(db, heads))
  assert.equal(all.length, 5)
  const tail = Object.fromEntries(Object.entries(heads).filter(([date]) => date >= '2026-09-11'))
  assert.deepEqual(await current(db, tail), former(db, tail))
  assert.deepEqual(await current(db, heads, undefined, '2026-09-15'), former(db, heads, 5, '2026-09-15'))
})

test('changed-only selector plan seeks the big tables instead of scanning them', async () => {
  const db = schema()
  const heads = seed(db, CASES)
  const log: Recorded[] = []
  await current(db, heads, log)
  const statement = log.find((entry) => entry.sql.includes('WITH source_dates AS'))
  assert(statement)
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.params as never[]) as Array<{ detail: string }>)
    .map((row) => row.detail)
  assert.doesNotMatch(plan.join('\n'), /SCAN (m|sr|strategy_label_matrix_v4|selection_reference_snapshots_v1)\b/, plan.join('\n'))
  assert.match(plan.join('\n'), /CORRELATED SCALAR SUBQUERY/)
  assert.match(plan.join('\n'), /SEARCH m USING (COVERING )?INDEX \S+ \([^)]*signal_date=\?/)
  assert.match(plan.join('\n'), /SEARCH sr USING (COVERING )?INDEX \S+ \([^)]*signal_date=\?/)
  assert.match(plan.join('\n'), /SEARCH mr USING (?:COVERING )?INDEX \S+ \(producer_run_id=\?\)/)
})

test('drain lists once per batch and skips the final list after an empty batch', async () => {
  const listCalls = (log: Recorded[]) => log.filter((entry) => entry.sql.includes('WITH source_dates AS')).length

  const empty = schema()
  const emptyHeads = seed(empty, [{ date: '2026-09-11' }])
  const emptyLog: Recorded[] = []
  const drained = await drainHistoricalStrategyEvidenceV5(d1(empty, emptyLog), {
    asOfDate: AS_OF,
    resolveCanonicalScreenerRunIds: async () => emptyHeads,
  })
  assert.deepEqual(drained.remainingDates, [])
  assert.equal(drained.batches, 0)
  assert.equal(listCalls(emptyLog), 1, 'former drain listed twice when nothing was pending')

  // No candidate contexts exist, so the rebuild blocks the date and the drain
  // must still fail closed on the remaining backlog.
  const blocked = schema()
  const blockedHeads = seed(blocked, [{ date: '2026-09-01', ledger: null }])
  const blockedLog: Recorded[] = []
  await assert.rejects(
    drainHistoricalStrategyEvidenceV5(d1(blocked, blockedLog), {
      asOfDate: AS_OF,
      resolveCanonicalScreenerRunIds: async () => blockedHeads,
    }),
    /formal_strategy_evidence_backlog_not_drained:2026-09-01/,
  )
  assert.equal(listCalls(blockedLog), 2, 'former drain listed three times for one blocked batch')
  const ledger = blocked.prepare('SELECT status FROM strategy_evidence_rebuild_runs_v5 WHERE signal_date=?').get('2026-09-01') as { status: string }
  assert.equal(ledger.status, 'blocked')
})
