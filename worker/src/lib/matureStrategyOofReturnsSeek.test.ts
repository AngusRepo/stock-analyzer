import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { buildMatureStrategyOofReturnsSql } from './marketScreener'
import { buildStrategyFormalMatureCompatibilitySql, SELECTION_REFERENCE_FORMAL_MATURE_COMPATIBILITY } from './selectionReferenceEvidence'
import { CANONICAL_SELECTION_ADJUSTMENT_SOURCE } from './canonicalSelectionLabels'

// The previous query joined the matrix by signal_date alone and kept the hits
// afterwards: 4.6M rows and 32 s per screener run on 2026-11-06. The seek form
// must return exactly the same rows and aggregates.
const schema = readFileSync('domain-schemas/learning.sql', 'utf8')
const TABLES = ['strategy_label_matrix_v4', 'canonical_selection_labels_v4', 'strategy_label_matrix_runs_v4']
const compat = buildStrategyFormalMatureCompatibilitySql('mr')

const legacySql = `
    WITH mature_dates AS (
      SELECT DISTINCT signal_date
        FROM canonical_selection_labels_v4
       WHERE outcome_known_date <= ?
         AND signal_date < ?
         AND label_schema_version = 'canonical-strategy-selection-label-v4'
       ORDER BY signal_date DESC
       LIMIT 60
    )
    SELECT m.strategy_id, m.signal_date,
           AVG(l.residual_return_net) residual_return,
           COUNT(*) sample_count
      FROM strategy_label_matrix_v4 m
      JOIN mature_dates d ON d.signal_date=m.signal_date
      JOIN canonical_selection_labels_v4 l
        ON l.signal_date=m.signal_date
       AND l.symbol=m.symbol
       AND l.producer_run_id=m.producer_run_id
       AND l.label_schema_version='canonical-strategy-selection-label-v4'
       AND l.adjustment_source=?
       AND l.reference_contract_version=m.reference_contract_version
     WHERE m.evaluable=1
       AND m.strategy_hit=1
       AND EXISTS (
         SELECT 1 FROM strategy_label_matrix_runs_v4 mr
          WHERE mr.producer_run_id=m.producer_run_id AND mr.status='ready'
            AND mr.reference_contract_version=m.reference_contract_version
            AND ${compat.sql}
            AND mr.labeler_version=m.labeler_version
       )
       AND EXISTS (
         SELECT 1 FROM json_each(?) h
          WHERE h.key=m.signal_date AND h.value=m.producer_run_id
       )
     GROUP BY m.strategy_id, m.signal_date
    HAVING COUNT(*) >= 3
     ORDER BY m.strategy_id, m.signal_date
`

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const table of TABLES) {
    db.exec(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0])
    for (const index of schema.matchAll(new RegExp(`CREATE INDEX IF NOT EXISTS \\w+\\s+ON ${table}\\([^;]*\\);`, 'g'))) db.exec(index[0])
  }
  return db
}

// Deterministic generator so a failure reproduces.
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const AS_OF = '2026-11-06'
const CONTRACTS = SELECTION_REFERENCE_FORMAL_MATURE_COMPATIBILITY

function seed(db: DatabaseSync, seedValue: number): Record<string, string> {
  const random = rng(seedValue)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  const dates: string[] = []
  for (let day = 1; day <= 75; day += 1) dates.push(`2026-${String(6 + Math.floor((day - 1) / 25)).padStart(2, '0')}-${String(((day - 1) % 25) + 1).padStart(2, '0')}`)
  const strategies = Array.from({ length: 12 }, (_, index) => `S${String(index).padStart(2, '0')}`)
  const symbols = Array.from({ length: 14 }, (_, index) => `${2300 + index}`)
  const canonical: Record<string, string> = {}
  const insertMatrix = db.prepare(`
    INSERT INTO strategy_label_matrix_v4 (
      signal_date, symbol, producer_run_id, strategy_id, strategy_version, strategy_status, alpha_bucket, family_id,
      production_owner, strategy_hit, evaluable, weak_label, affinity, position_weight, overlap,
      labeler_version, strategy_registry_checksum, reference_contract_version
    ) VALUES (?, ?, ?, ?, 'v1', 'active', 'core', 'fam', 0, ?, ?, 0, 0, 0, 0, ?, 'chk', ?)
  `)
  const insertRun = db.prepare(`
    INSERT INTO strategy_label_matrix_runs_v4 (
      producer_run_id, signal_date, status, reference_candidate_count, strategy_count, expected_cell_count,
      strategy_registry_checksum, labeler_version, reference_contract_version
    ) VALUES (?, ?, ?, 0, 0, 0, 'chk', ?, ?)
  `)
  const insertLabel = db.prepare(`
    INSERT INTO canonical_selection_labels_v4 (
      signal_date, symbol, label_schema_version, producer_run_id, entry_date, exit_date, outcome_known_date,
      entry_raw_open, exit_raw_close, entry_adjustment_factor, exit_adjustment_factor, gross_return, transaction_cost_bps,
      absolute_return_net, benchmark_return_net, benchmark_scope, residual_return_net, cross_section_rank,
      adjustment_source, reference_contract_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, 0, 0, 0, 0, 'market', ?, 0, ?, ?)
  `)
  for (const [dateIndex, date] of dates.entries()) {
    const runs = [`run-${date}`, ...(random() < 0.4 ? [`alt-${date}`] : [])]
    if (random() < 0.9) canonical[date] = runs[Math.floor(random() * runs.length)]
    const dateStrategies = strategies.filter(() => random() < 0.8)
    for (const run of runs) {
      const contract = random() < 0.85 ? pick(CONTRACTS) : { referenceContractVersion: 'other-contract', labelerVersions: ['other-labeler'] }
      const labeler = random() < 0.9 ? pick(contract.labelerVersions) : 'stray-labeler'
      insertRun.run(run, date, random() < 0.85 ? 'ready' : 'failed', labeler, contract.referenceContractVersion)
      for (const symbol of symbols) {
        for (const strategy of dateStrategies) {
          insertMatrix.run(date, symbol, run, strategy, random() < 0.3 ? 1 : 0, random() < 0.7 ? 1 : 0, labeler, contract.referenceContractVersion)
        }
        // Most cells carry a label; its maturity decides whether the date counts.
        if (random() < 0.9) {
          const mature = dateIndex < 62 || random() < 0.2
          const known = mature ? '2026-11-01' : '2026-11-20'
          insertLabel.run(
            date, symbol, 'canonical-strategy-selection-label-v4', run, '2026-10-01', known, known,
            Math.round((random() - 0.5) * 2000) / 10000,
            random() < 0.85 ? CANONICAL_SELECTION_ADJUSTMENT_SOURCE : 'other-source',
            random() < 0.9 ? contract.referenceContractVersion : 'other-contract',
          )
        }
      }
    }
  }
  return canonical
}

type Row = { strategy_id: string; signal_date: string; residual_return: number; sample_count: number }

test('the strategy seek returns the same mature OOF rows as the date scan', () => {
  for (const seedValue of [7, 42, 20261106]) {
    const db = openDb()
    try {
      const canonical = seed(db, seedValue)
      const json = JSON.stringify(canonical)
      const legacy = db.prepare(legacySql).all(AS_OF, AS_OF, CANONICAL_SELECTION_ADJUSTMENT_SOURCE, ...compat.binds, json) as Row[]
      const seek = db.prepare(buildMatureStrategyOofReturnsSql(compat.sql))
        .all(AS_OF, AS_OF, json, CANONICAL_SELECTION_ADJUSTMENT_SOURCE, ...compat.binds) as Row[]
      assert.ok(legacy.length > 20, `seed ${seedValue} produced only ${legacy.length} rows`)
      assert.equal(seek.length, legacy.length, `seed ${seedValue}`)
      for (const [index, expected] of legacy.entries()) {
        const actual = seek[index]
        assert.equal(actual.strategy_id, expected.strategy_id, `seed ${seedValue} row ${index}`)
        assert.equal(actual.signal_date, expected.signal_date, `seed ${seedValue} row ${index}`)
        assert.equal(Number(actual.sample_count), Number(expected.sample_count), `seed ${seedValue} row ${index}`)
        assert.ok(Math.abs(Number(actual.residual_return) - Number(expected.residual_return)) < 1e-12, `seed ${seedValue} row ${index}`)
      }
    } finally {
      db.close()
    }
  }
})

test('the matrix is only ever reached through the (signal_date, strategy_id, evaluable, strategy_hit) index', () => {
  const db = openDb()
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${buildMatureStrategyOofReturnsSql(compat.sql)}`)
      .all(AS_OF, AS_OF, '{}', CANONICAL_SELECTION_ADJUSTMENT_SOURCE, ...compat.binds)
      .map((row) => String(row.detail))
    const joined = plan.join(' | ')
    assert.ok(!plan.some((detail) => /^SCAN (m|l|mr|canonical_selection_labels_v4|strategy_label_matrix_v4)\b/.test(detail)), joined)
    // Strategy enumeration: one seek per step on an index led by (signal_date, strategy_id).
    assert.ok(plan.some((detail) => /SEARCH m USING COVERING INDEX idx_strategy_label_matrix_\w+ \(signal_date=\? AND strategy_id>\?\)/.test(detail)), joined)
    // Hits: equality on all four leading columns, so only hit cells are read.
    assert.ok(plan.some((detail) => /SEARCH m USING (COVERING )?INDEX idx_strategy_label_matrix_v4_evaluable \(signal_date=\? AND strategy_id=\? AND evaluable=\? AND strategy_hit=\?\)/.test(detail)), joined)
    // Labels by primary key; mature dates walk the primary key newest first without a sort.
    assert.ok(plan.some((detail) => /SEARCH l USING (INDEX sqlite_autoindex_canonical_selection_labels_v4_1|PRIMARY KEY) \(signal_date=\? AND symbol=\? AND producer_run_id=\?/.test(detail)), joined)
    assert.ok(plan.some((detail) => /SEARCH canonical_selection_labels_v4 USING (INDEX sqlite_autoindex_canonical_selection_labels_v4_1|PRIMARY KEY) \(signal_date<\?\)/.test(detail)), joined)
    assert.ok(!plan.some((detail) => /TEMP B-TREE FOR ORDER BY/.test(detail)), joined)
  } finally {
    db.close()
  }
})
