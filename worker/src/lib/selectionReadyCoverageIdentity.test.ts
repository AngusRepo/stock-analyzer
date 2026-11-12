import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  SELECTION_READY_REFERENCE_COVERAGE_SQL,
  STRATEGY_READY_MATRIX_COVERAGE_SQL,
} from './selectionReferenceEvidence'

// The ready-run readback re-expanded its identity JSON once per stored row in a correlated
// EXISTS (9.9M rows per call on 2026-11-12). The IN-list form must return the same counts.
// The former SQL texts are the reference.
const schema = readFileSync('domain-schemas/learning.sql', 'utf8')

const formerReferenceSql = `
        SELECT COUNT(*) row_count,
               SUM(CASE WHEN EXISTS (
                 SELECT 1 FROM json_each(?) j
                  WHERE json_extract(j.value, '$.symbol')=r.symbol
                    AND CAST(json_extract(j.value, '$.stock_id') AS INTEGER)=r.stock_id
               ) THEN 1 ELSE 0 END) identity_count,
               SUM(CASE
                 WHEN r.signal_date=? AND r.hard_gate_passed=1
                  AND r.strategy_labeler_version=? AND r.strategy_registry_checksum=?
                  AND r.feature_contract_version=? AND r.evidence_artifact_id=?
                 THEN 1 ELSE 0 END) contract_count
          FROM selection_reference_snapshots_v1 r
         WHERE r.signal_date=? AND r.producer_run_id=?
`
const formerMatrixSql = `
        SELECT COUNT(*) row_count,
               SUM(CASE WHEN EXISTS (
                 SELECT 1 FROM json_each(?) refs WHERE refs.value=m.symbol
               ) THEN 1 ELSE 0 END) reference_identity_count,
               SUM(CASE WHEN EXISTS (
                 SELECT 1 FROM json_each(?) strategies
                  WHERE json_extract(strategies.value, '$.strategy_id')=m.strategy_id
                    AND json_extract(strategies.value, '$.strategy_version')=m.strategy_version
               ) THEN 1 ELSE 0 END) strategy_identity_count,
               SUM(CASE
                 WHEN m.signal_date=? AND m.labeler_version=?
                  AND m.strategy_registry_checksum=? AND m.reference_contract_version=?
                 THEN 1 ELSE 0 END) contract_count
          FROM strategy_label_matrix_v4 m
         WHERE m.signal_date=? AND m.producer_run_id=?
`

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const table of ['strategy_label_matrix_v4', 'selection_reference_snapshots_v1']) {
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

const DATE = '2026-11-10'
const RUN = 'screener-v2-2026-11-10'
const LABELER = 'labeler'
const CHECKSUM = 'chk'
const CONTRACT = 'contract'
const ARTIFACT = 'artifact'

function seed(db: DatabaseSync, seedValue: number) {
  const random = rng(seedValue)
  const insertSnapshot = db.prepare(`
    INSERT INTO selection_reference_snapshots_v1 (
      signal_date, symbol, producer_run_id, stock_id, hard_gate_passed, hard_gate_reason, feature_available,
      strategy_labeled, strategy_selected, selection_stage, strategy_registry_checksum, feature_contract_version,
      strategy_labeler_version, evidence_artifact_id
    ) VALUES (?, ?, ?, ?, ?, 'pass', 1, 1, 0, 'scoring', ?, ?, ?, ?)
  `)
  const insertMatrix = db.prepare(`
    INSERT INTO strategy_label_matrix_v4 (
      signal_date, symbol, producer_run_id, strategy_id, strategy_version, strategy_status, alpha_bucket, family_id,
      production_owner, strategy_hit, evaluable, weak_label, affinity, position_weight, overlap,
      labeler_version, strategy_registry_checksum, reference_contract_version
    ) VALUES (?, ?, ?, ?, ?, 'active', 'core', 'fam', 0, 0, 1, 0, 0, 0, 0, ?, ?, ?)
  `)
  const symbols = Array.from({ length: 30 }, (_, index) => `${1100 + index}`)
  const strategies = ['S1', 'S2', 'S3', 'S4'].map((id) => ({ id, version: random() < 0.8 ? 'v1' : 'v2' }))
  for (const date of [DATE, '2026-11-07', '2026-11-11']) {
    for (const run of [RUN, 'screener-v2-other', `screener-v2-x-${date}`]) {
      for (const [index, symbol] of symbols.entries()) {
        if (random() < 0.1) continue
        const stockId = random() < 0.1 ? null : 5000 + index
        insertSnapshot.run(
          date, symbol, run, stockId, random() < 0.9 ? 1 : 0,
          random() < 0.9 ? CHECKSUM : 'other', random() < 0.9 ? CONTRACT : 'other',
          random() < 0.9 ? LABELER : null, random() < 0.9 ? ARTIFACT : 'other',
        )
        for (const strategy of strategies) {
          insertMatrix.run(
            date, symbol, run, strategy.id, random() < 0.9 ? strategy.version : 'v9',
            random() < 0.9 ? LABELER : 'other', random() < 0.9 ? CHECKSUM : 'other', random() < 0.9 ? CONTRACT : 'other',
          )
        }
      }
    }
  }
  // Identity payloads: a subset of the symbols, with duplicates, JSON numbers, nulls,
  // string stock ids (CAST), wrong stock ids, and unknown entries.
  type IdentityEntry = { symbol: string | number | null; stock_id: string | number | null }
  const referenceIdentity = symbols.flatMap((symbol, index): IdentityEntry[] => {
    const pick = random()
    if (pick < 0.15) return []
    if (pick < 0.2) return [{ symbol, stock_id: String(5000 + index) }]
    if (pick < 0.25) return [{ symbol, stock_id: 9999 }]
    if (pick < 0.3) return [{ symbol, stock_id: null }]
    if (pick < 0.35) return [{ symbol: Number(symbol), stock_id: 5000 + index }]
    if (pick < 0.4) return [{ symbol, stock_id: 5000 + index }, { symbol, stock_id: 5000 + index }]
    return [{ symbol, stock_id: 5000 + index }]
  })
  referenceIdentity.push({ symbol: 'ZZZZ', stock_id: 1 }, { symbol: null, stock_id: null })
  const referenceSymbols = [
    ...symbols.filter((_, index) => index !== 3 && random() < 0.8),
    Number(symbols[3]), symbols[4], null, 'ZZZZ',
  ]
  const strategyIdentity = [
    ...strategies.filter(() => random() < 0.85).map((row) => ({ strategy_id: row.id, strategy_version: row.version })),
    { strategy_id: 'S1', strategy_version: null }, { strategy_id: null, strategy_version: 'v1' }, { strategy_id: 'S5', strategy_version: 'v1' },
    { strategy_id: strategies[1].id, strategy_version: strategies[1].version },
  ]
  return {
    referenceIdentity: JSON.stringify(referenceIdentity),
    referenceSymbols: JSON.stringify(referenceSymbols),
    strategyIdentity: JSON.stringify(strategyIdentity),
  }
}

test('IN-list identity counts equal the correlated EXISTS counts', () => {
  for (const seedValue of [1, 8, 20261112, 77]) {
    const db = openDb()
    try {
      const payload = seed(db, seedValue)
      for (const [date, run] of [[DATE, RUN], [DATE, 'screener-v2-other'], ['2026-11-07', RUN], [DATE, 'missing-run']]) {
        const referenceBinds = [payload.referenceIdentity, DATE, LABELER, CHECKSUM, CONTRACT, ARTIFACT, date, run]
        const former = db.prepare(formerReferenceSql).get(...referenceBinds)
        const current = db.prepare(SELECTION_READY_REFERENCE_COVERAGE_SQL).get(...referenceBinds)
        assert.deepEqual(current, former, `seed ${seedValue} references ${date} ${run}`)
        const matrixBinds = [payload.referenceSymbols, payload.strategyIdentity, DATE, LABELER, CHECKSUM, CONTRACT, date, run]
        const formerMatrix = db.prepare(formerMatrixSql).get(...matrixBinds)
        const currentMatrix = db.prepare(STRATEGY_READY_MATRIX_COVERAGE_SQL).get(...matrixBinds)
        assert.deepEqual(currentMatrix, formerMatrix, `seed ${seedValue} matrix ${date} ${run}`)
        if (run === RUN && date === DATE) {
          const counts = formerMatrix as Record<string, number>
          assert.ok(counts.row_count > counts.reference_identity_count && counts.reference_identity_count > 0, JSON.stringify(counts))
          assert.ok(counts.row_count > counts.strategy_identity_count && counts.strategy_identity_count > 0, JSON.stringify(counts))
          const referenceCounts = former as Record<string, number>
          assert.ok(referenceCounts.row_count > referenceCounts.identity_count && referenceCounts.identity_count > 0, JSON.stringify(referenceCounts))
        }
      }
    } finally {
      db.close()
    }
  }
})

test('the identity JSON is expanded once, and the stored rows are reached by signal_date', () => {
  const db = openDb()
  try {
    for (const [sql, binds] of [
      [SELECTION_READY_REFERENCE_COVERAGE_SQL, ['[]', DATE, LABELER, CHECKSUM, CONTRACT, ARTIFACT, DATE, RUN]],
      [STRATEGY_READY_MATRIX_COVERAGE_SQL, ['[]', '[]', DATE, LABELER, CHECKSUM, CONTRACT, DATE, RUN]],
    ] as const) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds).map((row) => String(row.detail))
      const joined = plan.join(' | ')
      assert.ok(!plan.some((detail) => /CORRELATED/.test(detail)), joined)
      assert.ok(plan.some((detail) => /^LIST SUBQUERY/.test(detail)), joined)
      assert.ok(plan.some((detail) => /^SEARCH (m|r) USING .*\(signal_date=\?/.test(detail)), joined)
      assert.ok(!plan.some((detail) => /^SCAN (m|r)\b/.test(detail)), joined)
    }
  } finally {
    db.close()
  }
})
