import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  buildStrategyFormalMatureCompatibilitySql,
  buildStrategyRedundancyBackfillDatesSql,
  SELECTION_REFERENCE_FORMAL_MATURE_COMPATIBILITY,
} from './selectionReferenceEvidence'

// The backfill route's date selection used to check the matrix and the snapshots by
// producer_run_id alone (SCAN m + SCAN r, 2.36M rows per call on 2026-11-12). The new
// query must select the same dates as the former query followed by the route's
// canonical-head filter. The former SQL text is the reference.
const schema = readFileSync('domain-schemas/learning.sql', 'utf8')
const TABLES = ['strategy_label_matrix_v4', 'strategy_label_matrix_runs_v4', 'selection_reference_snapshots_v1']
const compat = buildStrategyFormalMatureCompatibilitySql('mr')

const formerSql = `
    SELECT DISTINCT mr.signal_date, mr.producer_run_id
      FROM strategy_label_matrix_runs_v4 mr
     WHERE mr.signal_date BETWEEN ? AND ?
       AND mr.status='ready'
       AND ${compat.sql}
       AND NOT EXISTS (
         SELECT 1 FROM strategy_label_matrix_v4 m
          WHERE m.producer_run_id=mr.producer_run_id
            AND m.labeler_version IS NOT mr.labeler_version
       )
       AND NOT EXISTS (
         SELECT 1 FROM selection_reference_snapshots_v1 r
          WHERE r.producer_run_id=mr.producer_run_id
            AND r.strategy_labeler_version IS NOT mr.labeler_version
       )
     ORDER BY mr.signal_date
`

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const table of TABLES) {
    db.exec(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0])
    for (const index of schema.matchAll(new RegExp(`CREATE INDEX IF NOT EXISTS \\w+\\s+ON ${table}\\([^;]*\\);`, 'g'))) db.exec(index[0])
  }
  return db
}

function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const START = '2026-10-05'
const END = '2026-10-25'

function seed(db: DatabaseSync, seedValue: number): Map<string, string> {
  const random = rng(seedValue)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
  const insertRun = db.prepare(`
    INSERT INTO strategy_label_matrix_runs_v4 (
      producer_run_id, signal_date, status, reference_candidate_count, strategy_count, expected_cell_count,
      strategy_registry_checksum, labeler_version, reference_contract_version
    ) VALUES (?, ?, ?, 0, 0, 0, 'chk', ?, ?)
  `)
  const insertMatrix = db.prepare(`
    INSERT INTO strategy_label_matrix_v4 (
      signal_date, symbol, producer_run_id, strategy_id, strategy_version, strategy_status, alpha_bucket, family_id,
      production_owner, strategy_hit, evaluable, weak_label, affinity, position_weight, overlap,
      labeler_version, strategy_registry_checksum, reference_contract_version
    ) VALUES (?, ?, ?, ?, 'v1', 'active', 'core', 'fam', 0, 0, 1, 0, 0, 0, 0, ?, 'chk', ?)
  `)
  const insertSnapshot = db.prepare(`
    INSERT INTO selection_reference_snapshots_v1 (
      signal_date, symbol, producer_run_id, hard_gate_passed, hard_gate_reason, feature_available,
      strategy_labeled, strategy_selected, selection_stage, strategy_registry_checksum, feature_contract_version,
      strategy_labeler_version
    ) VALUES (?, ?, ?, 1, 'pass', 1, 1, 0, 'scoring', 'chk', 'f', ?)
  `)
  const canonical = new Map<string, string>()
  for (let day = 1; day <= 30; day += 1) {
    const date = `2026-10-${String(day).padStart(2, '0')}`
    const runs = [`run-${date}`, ...(random() < 0.5 ? [`alt-${date}`] : [])]
    const head = random()
    if (head < 0.8) canonical.set(date, pick(runs))
    else if (head < 0.88) canonical.set(date, `run-2026-10-${String(((day + 3) % 28) + 1).padStart(2, '0')}`) // head names another date's run
    for (const run of runs) {
      const contract = random() < 0.85 ? pick(SELECTION_REFERENCE_FORMAL_MATURE_COMPATIBILITY) : { referenceContractVersion: 'other-contract', labelerVersions: ['other-labeler'] }
      const labeler = pick(contract.labelerVersions)
      insertRun.run(run, date, random() < 0.85 ? 'ready' : pick(['writing', 'failed']), labeler, contract.referenceContractVersion)
      const matrixDrift = random() < 0.15
      const snapshotDrift = random()
      for (let symbolIndex = 0; symbolIndex < 6; symbolIndex += 1) {
        const symbol = `${2300 + symbolIndex}`
        for (const strategy of ['S1', 'S2', 'S3']) {
          const drift = matrixDrift && symbolIndex === 5 && strategy === 'S3'
          insertMatrix.run(date, symbol, run, strategy, drift ? 'stray-labeler' : labeler, contract.referenceContractVersion)
        }
        // Snapshot labeler drift: another value, or NULL (IS NOT treats NULL as a mismatch).
        const snapshotLabeler = symbolIndex === 2 && snapshotDrift < 0.08 ? 'stray-labeler'
          : symbolIndex === 3 && snapshotDrift >= 0.08 && snapshotDrift < 0.16 ? null
          : labeler
        if (random() < 0.95) insertSnapshot.run(date, symbol, run, snapshotLabeler)
      }
    }
  }
  return canonical
}

type DateRow = { signal_date: string; producer_run_id: string }

// The route keeps only the canonical head's run per date, then takes the dates.
function routeDates(rows: DateRow[], canonical: Map<string, string>): string[] {
  return rows.filter((row) => canonical.get(row.signal_date) === row.producer_run_id).map((row) => row.signal_date)
}

test('the date-scoped backfill selection returns the same dates as the producer scan', () => {
  for (const seedValue of [3, 17, 20261112, 99]) {
    const db = openDb()
    try {
      const canonical = seed(db, seedValue)
      const former = db.prepare(formerSql).all(START, END, ...compat.binds) as DateRow[]
      const current = db.prepare(buildStrategyRedundancyBackfillDatesSql(compat))
        .all(JSON.stringify(Object.fromEntries(canonical)), START, END, ...compat.binds) as DateRow[]
      const expected = routeDates(former, canonical)
      assert.ok(expected.length >= 3, `seed ${seedValue} selected only ${expected.length} dates`)
      assert.ok(expected.length < 21, `seed ${seedValue} excluded no date`)
      assert.deepEqual(routeDates(current, canonical), expected, `seed ${seedValue}`)
      // The new query already keeps only canonical heads, so the route filter is a no-op on it.
      assert.deepEqual(current.map((row) => row.signal_date), expected, `seed ${seedValue}`)
    } finally {
      db.close()
    }
  }
})

test('a drifted cell or snapshot of another producer on the same date does not exclude the canonical run', () => {
  const db = openDb()
  try {
    const canonical = seed(db, 5)
    const date = [...canonical.keys()].find((key) => key >= START && key <= END && canonical.get(key) === `run-${key}`)!
    const former = routeDates(db.prepare(formerSql).all(START, END, ...compat.binds) as DateRow[], canonical)
    db.prepare(`INSERT INTO strategy_label_matrix_v4 (
      signal_date, symbol, producer_run_id, strategy_id, strategy_version, strategy_status, alpha_bucket, family_id,
      production_owner, strategy_hit, evaluable, weak_label, affinity, position_weight, overlap,
      labeler_version, strategy_registry_checksum, reference_contract_version
    ) VALUES (?, '9999', 'foreign-producer', 'S1', 'v1', 'active', 'core', 'fam', 0, 0, 1, 0, 0, 0, 0, 'stray', 'chk', 'x')`).run(date)
    db.prepare(`INSERT INTO selection_reference_snapshots_v1 (
      signal_date, symbol, producer_run_id, hard_gate_passed, hard_gate_reason, feature_available,
      strategy_labeled, strategy_selected, selection_stage, strategy_registry_checksum, feature_contract_version,
      strategy_labeler_version
    ) VALUES (?, '9999', 'foreign-producer', 1, 'pass', 1, 1, 0, 'scoring', 'chk', 'f', NULL)`).run(date)
    const current = db.prepare(buildStrategyRedundancyBackfillDatesSql(compat))
      .all(JSON.stringify(Object.fromEntries(canonical)), START, END, ...compat.binds) as DateRow[]
    assert.deepEqual(current.map((row) => row.signal_date), former)
    assert.deepEqual(routeDates(db.prepare(formerSql).all(START, END, ...compat.binds) as DateRow[], canonical), former)
  } finally {
    db.close()
  }
})

test('no table of the backfill selection is scanned', () => {
  const db = openDb()
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${buildStrategyRedundancyBackfillDatesSql(compat)}`)
      .all('{}', START, END, ...compat.binds)
      .map((row) => String(row.detail))
    const joined = plan.join(' | ')
    assert.ok(!plan.some((detail) => /^SCAN (m|r|mr)\b/.test(detail)), joined)
    assert.ok(plan.some((detail) => /^SEARCH mr USING (INDEX \w+|PRIMARY KEY) \(producer_run_id=\?/.test(detail)), joined)
    assert.ok(plan.some((detail) => /^SEARCH m USING .*\(signal_date=\?/.test(detail)), joined)
    // Or by idx_selection_reference_v1_producer_run (learning 0067). Writers stamp one signal_date
    // per producer; legacy cross-date rows only widen the bound to that producer's rows.
    assert.ok(plan.some((detail) => /^SEARCH r USING .*\((signal_date|producer_run_id)=\?/.test(detail)), joined)
  } finally {
    db.close()
  }
})
