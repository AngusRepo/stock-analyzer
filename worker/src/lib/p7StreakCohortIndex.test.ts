import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { P7_COHORT_SQL } from './riskChecks/p7Streak'

// P7 runs on every intraday risk check (~265 a day). Unpinned, the planner walked
// idx_predictions_verification_label: every model's verified v4 row (~290k reads per call,
// 2026-11-12). Pinned to the model index it reads the verified ensemble rows only.
const schema = readFileSync('domain-schemas/learning.sql', 'utf8')
const LABEL = 'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'

const legacySql = `
      WITH eligible AS (
        SELECT prediction_date,verification_label_end_date,direction_correct,
          ROW_NUMBER() OVER(PARTITION BY prediction_date,stock_id ORDER BY generated_at DESC,id DESC) AS n
        FROM predictions WHERE model_name='ensemble' AND direction_correct IN (0,1)
          AND verified_at IS NOT NULL AND datetime(verified_at)<=datetime(?) AND datetime(generated_at)<=datetime(?)
          AND verification_label_known_date<=? AND verification_label_end_date<=?
          AND prediction_date<verification_label_end_date
          AND json_valid(forecast_data)
          AND json_extract(forecast_data,'$.ensemble_v2.artifact_id')=?
          AND json_extract(forecast_data,'$.ensemble_v2.cohort_id')=?
          AND json_extract(forecast_data,'$.ensemble_v2.artifact_checksum')=?
          AND json_extract(forecast_data,'$.ensemble_v2.base_artifact_set_checksum')=?
          AND json_extract(forecast_data,'$.ensemble_v2.forecast_horizon_bars')=5
          AND verification_label_schema_version='next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'
      ) SELECT prediction_date AS date,MAX(verification_label_end_date) AS end_date,
          AVG(CAST(direction_correct AS REAL)) AS accuracy,COUNT(*) AS samples
        FROM eligible WHERE n=1 GROUP BY prediction_date ORDER BY prediction_date DESC LIMIT 100
    `

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schema.match(/CREATE TABLE IF NOT EXISTS predictions \([\s\S]*?\n\);/)![0])
  for (const index of schema.matchAll(/CREATE INDEX IF NOT EXISTS \w+\s+ON predictions\([^;]*\);/g)) db.exec(index[0])
  return db
}

const identity = { artifact_id: 'current', cohort_id: 'cohort', artifact_checksum: 'checksum', base_artifact_set_checksum: 'base', forecast_horizon_bars: 5 }
const binds = (now: string, today: string) => [now, now, today, today, 'current', 'cohort', 'checksum', 'base']
const day = (offset: number) => new Date(Date.UTC(2026, 10, 14) + offset * 86400000).toISOString().slice(0, 10)

function seed(db: DatabaseSync) {
  const insert = db.prepare(`INSERT INTO predictions(stock_id,model_name,prediction_date,generated_at,verified_at,direction_correct,
    verification_label_schema_version,verification_label_end_date,verification_label_known_date,forecast_data) VALUES(?,?,?,?,?,?,?,?,?,?)`)
  let seedValue = 7
  const next = () => (seedValue = (seedValue * 1103515245 + 12345) % 2147483648) / 2147483648
  const forecast = (extra: Record<string, unknown> = {}) => JSON.stringify({ ensemble_v2: { ...identity, ...extra } })
  // 150 business dates, more than the LIMIT 100, so the cut-off date set is compared too.
  for (let d = -220; d <= 2; d++) {
    if (new Date(day(d) + 'T00:00:00Z').getUTCDay() % 6 === 0) continue
    const date = day(d), end = day(d + 7), known = day(d + 7)
    for (let stock = 1; stock <= 6; stock++) {
      const correct = next() < 0.5 ? 0 : 1
      insert.run(stock, 'ensemble', date, `${date} 06:00:00`, `${known} 10:00:00`, correct, LABEL, end, known, forecast())
      // A later regeneration of the same stock/date wins; an equal generated_at falls to the higher id.
      if (stock % 3 === 0) insert.run(stock, 'ensemble', date, `${date} 07:00:00`, `${known} 10:00:00`, 1 - correct, LABEL, end, known, forecast())
      if (stock === 4) insert.run(stock, 'ensemble', date, `${date} 06:00:00`, `${known} 10:00:00`, 1, LABEL, end, known, forecast())
      // Other models with the same identity and the label only exist on the old index path.
      insert.run(stock, 'LightGBM', date, `${date} 06:00:00`, `${known} 10:00:00`, 1, LABEL, end, known, forecast())
    }
    // Each filter in turn: only the first row of every date passes all of them.
    const r = (extra: Partial<Record<string, unknown>>) => {
      const row = { stock: 9, model: 'ensemble', date, generated: `${date} 06:00:00`, verified: `${known} 10:00:00`, correct: 0,
        label: LABEL, end, known, forecast: forecast(), ...extra }
      insert.run(row.stock as number, row.model as string, row.date as string, row.generated as string, row.verified as string | null,
        row.correct as number | null, row.label as string | null, row.end as string | null, row.known as string | null, row.forecast as string | null)
    }
    if (d % 5 === 0) r({ stock: 10, correct: null })
    if (d % 7 === 0) r({ stock: 11, correct: 2 })
    if (d % 4 === 0) r({ stock: 12, verified: null })
    if (d % 6 === 0) r({ stock: 13, verified: '2026-11-14T03:00:00Z' }) // after "now"
    if (d % 3 === 0) r({ stock: 14, generated: '2026-11-14 03:00:00' })
    if (d % 8 === 0) r({ stock: 15, known: day(9), end: day(9) })
    if (d % 9 === 0) r({ stock: 16, end: date })
    if (d % 2 === 0) r({ stock: 17, forecast: '{not json' })
    if (d % 10 === 0) r({ stock: 18, forecast: forecast({ artifact_id: 'stale' }) })
    if (d % 11 === 0) r({ stock: 19, forecast: forecast({ forecast_horizon_bars: 4 }) })
    if (d % 12 === 0) r({ stock: 20, forecast: forecast({ cohort_id: 'other' }) })
    if (d % 13 === 0) r({ stock: 21, label: 'next-session-v3' })
    if (d % 14 === 0) r({ stock: 22, label: null })
    if (d % 15 === 0) r({ stock: 23, model: 'ensemble_v2' })
  }
}

test('the pinned P7 cohort read returns the same dates, accuracies and samples as the unpinned one', () => {
  const db = openDb()
  try {
    seed(db)
    let compared = 0
    for (const [now, today] of [
      ['2026-11-14T02:00:00.000Z', '2026-11-14'],
      ['2026-11-14T05:30:00.000Z', '2026-11-14'],
      ['2026-10-01T02:00:00.000Z', '2026-10-01'],
      ['2026-04-01T02:00:00.000Z', '2026-04-01'], // before every row
    ]) {
      const legacy = db.prepare(legacySql).all(...binds(now, today))
      const pinned = db.prepare(P7_COHORT_SQL).all(...binds(now, today))
      assert.deepEqual(pinned, legacy, now)
      compared += legacy.length
      if (today === '2026-11-14') assert.equal(legacy.length, 100)
    }
    assert.ok(compared > 200)
    // A different identity still finds nothing.
    assert.deepEqual(db.prepare(P7_COHORT_SQL).all('2026-11-14T02:00:00.000Z', '2026-11-14T02:00:00.000Z', '2026-11-14', '2026-11-14', 'x', 'cohort', 'checksum', 'base'), [])
  } finally {
    db.close()
  }
})

test('the P7 cohort read seeks the ensemble rows of the model index', () => {
  const db = openDb()
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${P7_COHORT_SQL}`).all(...binds('2026-11-14T02:00:00.000Z', '2026-11-14'))
      .map((row) => String(row.detail))
    assert.ok(plan.some((detail) => detail === 'SEARCH predictions USING INDEX idx_pred_model_verified_date (model_name=? AND verified_at>?)'), plan.join(' | '))
    assert.ok(!plan.some((detail) => /idx_predictions_verification_label|^SCAN predictions/.test(detail)), plan.join(' | '))
  } finally {
    db.close()
  }
})
