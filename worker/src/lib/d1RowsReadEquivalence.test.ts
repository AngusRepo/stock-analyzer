import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { listCanonicalReferences } from './canonicalSelectionLabels'
import { SELECTION_REFERENCE_CONTRACT_VERSION } from './selectionReferenceEvidence'
import { listStrategyRewardSourceRows } from './strategyLearning'
import { STRATEGY_FORMAL_LABELER_VERSION } from './strategySpec'

// D1-RR: each rows-read rewrite must return exactly what the former query
// returned. The unchanged canonical_run_heads path (or the former SQL text)
// is the reference.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const headsDdl = read('../../domain-schemas/ops.sql').match(/CREATE TABLE IF NOT EXISTS canonical_run_heads \([\s\S]*?\n\);/)![0]
const REF = SELECTION_REFERENCE_CONTRACT_VERSION
const LAB = STRATEGY_FORMAL_LABELER_VERSION
const day = (n: number) => new Date(Date.UTC(2026, 8, 1 + n)).toISOString().slice(0, 10)

function d1(db: DatabaseSync, rewrite: (sql: string) => string = (sql) => sql): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = []
      const statement = {
        bind(...values: unknown[]) { params = values; return statement },
        async all() { return { success: true, results: db.prepare(rewrite(sql)).all(...(params as never[])), meta: {} } },
        async first(column?: string) {
          const row = db.prepare(rewrite(sql)).get(...(params as never[])) as Record<string, unknown> | undefined
          return row ? (column ? row[column] : row) : null
        },
        async run() { return { success: true, meta: { changes: Number(db.prepare(rewrite(sql)).run(...(params as never[])).changes) } } },
      }
      return statement
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) { return Promise.all(statements.map((s) => s.run())) },
  } as unknown as D1Database
}

// Six dates; each has its head run and a stale run. Day 3's head has no ready
// matrix run; day 4 has no head at all.
function seedSelection(R: number): { db: DatabaseSync; heads: Record<string, string> } {
  const db = new DatabaseSync(':memory:')
  db.exec(read('../../domain-schemas/learning.sql'))
  db.exec(read('../../domain-migrations/learning/0011_strategy_multi_horizon_outcomes.sql'))
  db.exec(read('../../domain-migrations/learning/0020_evidence_session_owner_read_models.sql'))
  db.exec(headsDdl)
  const heads: Record<string, string> = {}
  for (let n = 0; n < 6; n++) if (n !== 4) heads[day(n)] = `run-${n}`
  heads['2026-08-01'] = 'run-without-rows'
  const ref = db.prepare(`INSERT INTO selection_reference_snapshots_v1(signal_date,symbol,producer_run_id,stock_id,market_segment,sector,
    hard_gate_passed,hard_gate_reason,feature_available,strategy_labeled,strategy_selected,selection_stage,strategy_registry_checksum,
    feature_contract_version,strategy_labeler_version) VALUES (?,?,?,?,?,?,1,'ok',1,1,0,'scored','chk',?,?)`)
  const cell = db.prepare(`INSERT INTO strategy_label_matrix_v4(signal_date,symbol,producer_run_id,strategy_id,strategy_version,strategy_status,
    alpha_bucket,family_id,production_owner,strategy_hit,weak_label,affinity,position_weight,overlap,labeler_version,strategy_registry_checksum,
    reference_contract_version,evaluable) VALUES (?,?,?,?,'v1','active','trend','fam',1,?,0.1,0.2,0.3,0,?,'chk',?,?)`)
  const label = db.prepare(`INSERT INTO canonical_selection_labels_v4(signal_date,symbol,producer_run_id,entry_date,exit_date,outcome_known_date,
    entry_raw_open,exit_raw_close,entry_adjustment_factor,exit_adjustment_factor,gross_return,transaction_cost_bps,absolute_return_net,
    benchmark_return_net,benchmark_scope,residual_return_net,cross_section_rank,adjustment_source,reference_contract_version)
    VALUES (?,?,?,date(?,'+1 day'),date(?,'+6 days'),date(?,'+6 days'),10,11,1,1,0.1,18,?,0.01,'sector',?,0.5,'adj',?)`)
  const outcome = db.prepare(`INSERT INTO canonical_selection_outcomes_v1(signal_date,symbol,producer_run_id,horizon_days,entry_date,exit_date,
    outcome_known_date,gross_return,transaction_cost_bps,absolute_return_net,benchmark_return_net,benchmark_scope,residual_return_net,
    cross_section_rank,adjustment_source,reference_contract_version) VALUES (?,?,?,?,date(?,'+1 day'),?,?,0.1,18,0.05,0.01,'sector',?,0.5,'adj',?)`)
  const snapshot = db.prepare(`INSERT INTO allocator_ev_feature_snapshots(snapshot_date,stock_id,symbol,alpha_allocation,alpha_context,as_of_guard,
    snapshot_source,generated_at) VALUES (?,?,?,'{}',?,'guard',?,?)`)
  const run = db.prepare(`INSERT INTO strategy_label_matrix_runs_v4(producer_run_id,signal_date,status,reference_candidate_count,strategy_count,
    expected_cell_count,persisted_cell_count,strategy_registry_checksum,labeler_version,reference_contract_version) VALUES (?,?,?,?,3,?,?,'chk',?,?)`)
  for (let n = 0; n < 6; n++) {
    const date = day(n)
    for (const producer of [`run-${n}`, `stale-${n}`]) {
      run.run(producer, date, n === 3 && producer === `run-${n}` ? 'writing' : 'ready', R, R * 3, R * 3, LAB, REF)
      for (let k = 0; k < R; k++) {
        const symbol = String(1000 + k)
        ref.run(date, symbol, producer, 1 + k, k % 3 ? 'OTC' : 'TSE', `sec${k % 4}`, REF, LAB)
        if (k % 10 !== 9) label.run(date, symbol, producer, date, date, date, (k % 13) / 100, (k % 7) / 100, REF)
        for (let s = 0; s < 3; s++) {
          const hit = (k * 7 + s * 3 + n) % 4 === 0 ? 1 : 0
          cell.run(date, symbol, producer, `strat_${s}`, hit, LAB, REF, k % 17 === 3 ? 0 : 1)
        }
        if (k % 5 === 4) continue
        for (const h of [3, 5, 10]) {
          const known = new Date(Date.parse(date) + (h + 1) * 86_400_000).toISOString().slice(0, 10)
          outcome.run(date, symbol, producer, h, date, known, known, (k % 11) / 100, REF)
        }
        if (k % 3 === 0 && producer === `run-${n}`) {
          // Two sources per symbol and date; the view keeps the newest.
          snapshot.run(date, 1 + k, symbol, JSON.stringify({ regime: 'bull', market_regime_context: { regime_bucket: 'b1', large: 'x'.repeat(64) } }), 'a', '2026-10-01 10:00:00')
          snapshot.run(date, 1 + k, symbol, JSON.stringify({ regime: 'bear', regime_surface: 'hmm' }), 'b', `2026-10-01 1${k % 2}:30:00`)
        }
      }
    }
  }
  return { db, heads }
}

function insertHeadTable(db: DatabaseSync, heads: Record<string, string>): void {
  const put = db.prepare("INSERT INTO canonical_run_heads(logical_run_key,run_id,promoted_at) VALUES (?,?,'2026-10-01')")
  for (const [date, runId] of Object.entries(heads)) put.run(`screener:${date}:TW:production:market_screener`, runId)
}

test('reward source rows walked per head date equal the single heads-table pass', async () => {
  const { db, heads } = seedSelection(40)
  try {
    insertHeadTable(db, heads)
    for (const window of [{ endDate: day(30) }, { startDate: day(1), endDate: day(30) }, { endDate: day(8) }]) {
      const expected = await listStrategyRewardSourceRows(d1(db), { ...window, limit: 5000 })
      assert.ok(expected.length > 30)
      assert.ok(expected.every((row) => !String(row.date).startsWith(day(3)) && !String(row.date).startsWith(day(4))))
      for (const limit of [7, 5000]) {
        const actual = await listStrategyRewardSourceRows(d1(db), { ...window, limit, canonicalRunIds: heads })
        assert.deepEqual(actual, expected)
      }
      // Past the pass cap, consecutive head dates share a range-bounded pass;
      // no date is dropped.
      for (const maxDatePasses of [1, 2]) {
        const actual = await listStrategyRewardSourceRows(d1(db), { ...window, limit: 7, canonicalRunIds: heads, maxDatePasses })
        assert.deepEqual(actual, expected)
      }
    }
  } finally { db.close() }
})

test('canonical references walked per dirty date equal the single heads-table pass', async () => {
  const { db, heads } = seedSelection(520) // more than one 500-row page per date
  try {
    insertHeadTable(db, heads)
    for (const [start, end] of [[undefined, undefined], [day(1), day(3)]] as const) {
      const expected = await listCanonicalReferences(d1(db), day(30), start, end)
      assert.ok(expected.length > 1000)
      const actual = await listCanonicalReferences(d1(db), day(30), start, end, heads)
      assert.deepEqual(actual, expected)
    }
  } finally { db.close() }
})
