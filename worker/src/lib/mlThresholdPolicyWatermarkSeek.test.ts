import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { ML_THRESHOLD_POLICY_WATERMARK_SQL } from './observabilityEvents'

// /obs used to compute both dates with one MAX(CASE json_type(forecast_data…))
// over every ensemble row (about 30k rows, 15 s of JSON parsing per refresh on
// 2026-11-06). The two seeks must return the same dates and walk the
// prediction_date index without a sort.
const schema = readFileSync('domain-schemas/learning.sql', 'utf8')

const legacySql =
  'SELECT MAX(prediction_date) AS latest_prediction_date, ' +
  'MAX(CASE WHEN json_valid(forecast_data) THEN CASE ' +
  "WHEN json_type(forecast_data, '$.ensemble_v2.signal_policy')='object' " +
  "OR json_type(forecast_data, '$.ensemble_v2.ml_threshold_policy')='object' " +
  'THEN prediction_date END END) AS evidence_date ' +
  'FROM predictions WHERE prediction_date<=? ' +
  "AND model_name IN ('ensemble', 'ensemble_v2') AND forecast_data IS NOT NULL"

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schema.match(/CREATE TABLE IF NOT EXISTS predictions \([\s\S]*?\n\);/)![0])
  for (const index of schema.matchAll(/CREATE INDEX IF NOT EXISTS \w+\s+ON predictions\([^;]*\);/g)) db.exec(index[0])
  return db
}

function seek(db: DatabaseSync, date: string): { latest_prediction_date: string | null; evidence_date: string | null } {
  const latest = db.prepare(ML_THRESHOLD_POLICY_WATERMARK_SQL.latestPredictionDate).get(date) as { prediction_date: string | null } | undefined
  const evidence = db.prepare(ML_THRESHOLD_POLICY_WATERMARK_SQL.evidenceDate).get(date) as { prediction_date: string | null } | undefined
  return { latest_prediction_date: latest?.prediction_date ?? null, evidence_date: evidence?.prediction_date ?? null }
}

test('the watermark seeks return the same dates as the aggregate scan', () => {
  const db = openDb()
  try {
    const insert = db.prepare('INSERT INTO predictions (stock_id, model_name, prediction_date, forecast_data) VALUES (?, ?, ?, ?)')
    const policy = JSON.stringify({ ensemble_v2: { signal_policy: { buy_coverage: 0.2 } } })
    const threshold = JSON.stringify({ ensemble_v2: { ml_threshold_policy: { k: 1 } } })
    const plain = JSON.stringify({ ensemble_v2: { signal_policy: 'legacy-string' } })
    insert.run(1, 'ensemble', '2026-11-01', policy)
    insert.run(2, 'ensemble', '2026-11-02', threshold)
    insert.run(3, 'ensemble_v2', '2026-11-03', plain)
    insert.run(4, 'ensemble', '2026-11-04', 'not json')
    insert.run(5, 'ensemble', '2026-11-05', null)
    insert.run(6, 'lightgbm', '2026-11-06', policy) // another model never counts
    insert.run(7, 'ensemble', '2026-11-07', policy) // after the requested date
    insert.run(8, 'ensemble', null, policy) // undated rows never count
    for (const [date, expected] of [
      ['2026-11-06', { latest_prediction_date: '2026-11-04', evidence_date: '2026-11-02' }],
      ['2026-11-07', { latest_prediction_date: '2026-11-07', evidence_date: '2026-11-07' }],
      ['2026-11-01', { latest_prediction_date: '2026-11-01', evidence_date: '2026-11-01' }],
      ['2026-10-31', { latest_prediction_date: null, evidence_date: null }],
    ] as const) {
      assert.deepEqual({ ...(db.prepare(legacySql).get(date) as object) }, expected, date)
      assert.deepEqual(seek(db, date), expected, date)
    }
  } finally {
    db.close()
  }
})

test('both seeks walk a prediction_date index and never sort', () => {
  const db = openDb()
  try {
    for (const sql of Object.values(ML_THRESHOLD_POLICY_WATERMARK_SQL)) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('2026-11-06').map((row) => String(row.detail))
      assert.ok(plan.some((detail) => /^SEARCH predictions USING INDEX idx_pred_date_\w+ \(prediction_date<\?\)/.test(detail)), plan.join(' | '))
      assert.ok(!plan.some((detail) => /^SCAN /.test(detail) || /TEMP B-TREE/.test(detail)), plan.join(' | '))
    }
  } finally {
    db.close()
  }
})
