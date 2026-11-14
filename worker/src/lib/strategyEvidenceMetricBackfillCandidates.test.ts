import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { backfillMissingStrategyEvidenceMetricSnapshots, STRATEGY_METRIC_READER_REVISION } from './strategyEvidenceMetrics'

// The backfill must pick exactly the dates the former
// strategy_evidence_observations_v1 selection picked; that SQL text is the
// reference. Its plan must not scan the matrix or the outcomes.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10)
const READER_SCOPE = `%:reader:${STRATEGY_METRIC_READER_REVISION}`
const REFERENCE_SQL = `
  SELECT DISTINCT v.outcome_known_date
    FROM strategy_evidence_observations_v1 v
   WHERE v.outcome_known_date < ?
     AND NOT EXISTS (
       SELECT 1 FROM strategy_evidence_metric_snapshot_runs_v2 r
        WHERE r.outcome_as_of_date=v.outcome_known_date
          AND r.status='ready'
          AND r.definition_version='strategy-evidence-metrics-v4'
          AND r.source_mode=?
          AND r.publication_scope LIKE ?
     )
   ORDER BY v.outcome_known_date
   LIMIT ?`

type Mode = 'authority_bridge' | 'learning_target'
type Captured = { sql: string; params: unknown[]; dates: string[] }

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function schema(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(read('../../domain-schemas/learning.sql'))
  db.exec(read('../../domain-migrations/learning/0011_strategy_multi_horizon_outcomes.sql'))
  db.exec(read('../../domain-migrations/learning/0015_strategy_evidence_profile_index.sql'))
  db.exec(read('../../domain-migrations/learning/0020_evidence_session_owner_read_models.sql'))
  // The schema admits only ready receipts, but the selection still filters on
  // status; drop the CHECK so the fixture can hold non-ready receipts.
  const runs = db.prepare(`SELECT sql FROM sqlite_master WHERE name='strategy_evidence_metric_snapshot_runs_v2'`).get() as { sql: string }
  assert.match(runs.sql, /CHECK\(status='ready'\)/)
  db.exec('DROP TABLE strategy_evidence_metric_snapshot_runs_v2')
  db.exec(runs.sql.replace(/\s*CHECK\(status='ready'\)/, ''))
  return db
}

// Legacy non-evaluable cells, selections without matrix cells, outcomes
// missing for some horizons, shifted exits, receipts of both source modes and
// receipts of an older reader revision or not ready.
function seed(seedValue: number): { db: DatabaseSync; days: number } {
  const next = random(seedValue)
  const db = schema()
  const days = 20 + Math.floor(next() * 40)
  const legacyUntil = Math.floor(next() * (days / 2))
  const strategies = 2 + Math.floor(next() * 4)
  const cell = db.prepare(`INSERT INTO strategy_label_matrix_v4(signal_date,symbol,producer_run_id,strategy_id,strategy_version,
    strategy_status,alpha_bucket,family_id,production_owner,strategy_hit,evaluable,weak_label,affinity,position_weight,overlap,
    labeler_version,strategy_registry_checksum,reference_contract_version)
    VALUES (?,?,?,?,'v1','active','trend','fam',1,?,?,0,0,0,0,'labeler','chk','ref')`)
  const outcome = db.prepare(`INSERT INTO canonical_selection_outcomes_v1(signal_date,symbol,producer_run_id,horizon_days,
    entry_date,exit_date,outcome_known_date,gross_return,transaction_cost_bps,absolute_return_net,benchmark_return_net,
    benchmark_scope,residual_return_net,cross_section_rank,adjustment_source,reference_contract_version)
    VALUES (?,?,?,?,?,?,?,0,18,0,0,'sector',0,0.5,'adj','ref')`)
  const receipt = db.prepare(`INSERT INTO strategy_evidence_metric_snapshot_runs_v2(snapshot_run_id,outcome_as_of_date,
    definition_version,source_mode,publication_scope,materialization_source,status,profile_count,observation_count,
    metric_row_count,ready_row_count,payload_checksum)
    VALUES (?,?,'strategy-evidence-metrics-v4',?,?,'fixture',?,0,0,0,0,?)`)
  for (let signal = 0; signal < days; signal += 1) {
    const selections = Math.floor(next() * 5)
    for (let index = 0; index < selections; index += 1) {
      const symbol = String(2300 + index)
      const run = `run-${signal}`
      if (next() > 0.15) {
        for (let strategy = 0; strategy < strategies; strategy += 1) {
          const evaluable = signal < legacyUntil ? 0 : Number(next() > 0.2)
          cell.run(day(signal), symbol, run, `s${strategy}`, Number(next() < 0.3), evaluable)
        }
      }
      for (const horizon of [3, 5, 10]) {
        if (next() < 0.1) continue
        const exit = day(signal + horizon + Math.floor(next() * 3))
        outcome.run(day(signal), symbol, run, horizon, day(signal + 1), exit, exit)
      }
    }
  }
  for (let asOf = 0; asOf < days + 15; asOf += 1) {
    const kind = next()
    const scope = kind < 0.3 ? `canonical:run-${asOf}:reader:${STRATEGY_METRIC_READER_REVISION}`
      : kind < 0.4 ? `daily:${day(asOf)}:reader:${STRATEGY_METRIC_READER_REVISION}`
        : kind < 0.55 ? `daily:${day(asOf)}:reader:formal-matrix-v3-only`
          : kind < 0.7 ? `canonical:run-${asOf}:reader:${STRATEGY_METRIC_READER_REVISION}`
            : null
    if (!scope) continue
    const status = kind < 0.55 ? 'ready' : kind < 0.62 ? 'writing' : 'failed'
    const mode: Mode = next() < 0.85 ? 'authority_bridge' : 'learning_target'
    receipt.run(`receipt-${asOf}-${mode}-${kind}`, day(asOf), mode, scope, status, 'f'.repeat(64))
  }
  return { db, days }
}

// Runs the real backfill selection and stops before materialization.
async function capture(db: DatabaseSync, cutoff: string, maxDates: number, sourceMode: Mode): Promise<Captured> {
  let captured: Captured | null = null
  const learning = {
    prepare(sql: string) {
      let params: unknown[] = []
      const statement = {
        bind(...values: unknown[]) { params = values; return statement },
        async all() {
          const rows = db.prepare(sql).all(...(params as never[])) as Array<{ outcome_known_date: string }>
          captured = { sql, params, dates: rows.map((row) => row.outcome_known_date) }
          return { success: true, results: [], meta: {} }
        },
      }
      return statement
    },
  } as unknown as D1Database
  await backfillMissingStrategyEvidenceMetricSnapshots({ DB: learning } as never, { knowledgeCutoffDate: cutoff, maxDates, sourceMode })
  assert.ok(captured, 'backfill selection did not run')
  return captured
}

const reference = (db: DatabaseSync, cutoff: string, mode: Mode, limit: number) =>
  (db.prepare(REFERENCE_SQL).all(cutoff, mode, READER_SCOPE, limit) as Array<{ outcome_known_date: string }>)
    .map((row) => row.outcome_known_date)

test('backfill candidates equal the former VIEW selection across randomized histories', async () => {
  let nonEmpty = 0
  let withheld = 0
  for (let seedValue = 1; seedValue <= 60; seedValue += 1) {
    const { db, days } = seed(seedValue)
    try {
      const cutoff = day(5 + Math.floor(random(seedValue * 7)() * (days + 10)))
      for (const mode of ['authority_bridge', 'learning_target'] as const) {
        for (const maxDates of [1, 2, 8]) {
          const actual = await capture(db, cutoff, maxDates, mode)
          assert.deepEqual(actual.dates, reference(db, cutoff, mode, maxDates), `seed=${seedValue} mode=${mode} max=${maxDates}`)
          if (maxDates !== 8) continue
          // The whole candidate set, not only its first page.
          const all = db.prepare(actual.sql).all(...(actual.params.slice(0, -1) as never[]), 100_000) as Array<{ outcome_known_date: string }>
          const expected = reference(db, cutoff, mode, 100_000)
          assert.deepEqual(all.map((row) => row.outcome_known_date), expected, `seed=${seedValue} mode=${mode} all`)
          if (expected.length) nonEmpty += 1
          // Uncovered outcome dates without an evaluable hit stay excluded.
          const uncovered = db.prepare(`SELECT COUNT(DISTINCT o.outcome_known_date) n FROM canonical_selection_outcomes_v1 o
            WHERE o.outcome_known_date < ? AND NOT EXISTS (SELECT 1 FROM strategy_evidence_metric_snapshot_runs_v2 r
              WHERE r.outcome_as_of_date=o.outcome_known_date AND r.status='ready' AND r.source_mode=?
                AND r.publication_scope LIKE ?)`)
            .get(cutoff, mode, READER_SCOPE) as { n: number }
          if (uncovered.n > expected.length) withheld += 1
        }
      }
    } finally { db.close() }
  }
  // The fixtures exercise both a non-empty selection and withheld no-hit dates.
  assert.ok(nonEmpty >= 20, `non-empty=${nonEmpty}`)
  assert.ok(withheld >= 20, `withheld=${withheld}`)
})

test('the backfill selection never scans the matrix or the outcomes', async () => {
  const { db } = seed(7)
  try {
    const { sql, params } = await capture(db, day(40), 1, 'authority_bridge')
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>)
      .map((row) => row.detail)
    const text = plan.join('\n')
    assert.doesNotMatch(sql, /strategy_evidence_observations_v1/)
    for (const detail of plan) {
      assert.doesNotMatch(detail, /^SCAN (m|o|r|strategy_label_matrix_v4|canonical_selection_outcomes_v1|strategy_evidence_metric_snapshot_runs_v2)\b/, text)
    }
    assert.match(text, /SEARCH o USING COVERING INDEX idx_canonical_selection_outcomes_v1_known \(horizon_days=\? AND outcome_known_date>\?\)/, text)
    assert.match(text, /SEARCH o USING INDEX idx_canonical_selection_outcomes_v1_known \(horizon_days=\? AND outcome_known_date=\?\)/, text)
    assert.match(text, /SEARCH m USING INDEX sqlite_autoindex_strategy_label_matrix_v4_1 \(signal_date=\? AND symbol=\? AND producer_run_id=\?\)/, text)
  } finally { db.close() }
})
