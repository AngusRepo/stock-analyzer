import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { modelIcEvidenceSql } from './dataQualityMonitor'

// The data-quality monitor's model IC evidence read used date(prediction_date), which cannot
// seek, so it walked every verified row of the eight models (~185k reads, 72 runs a day on
// 2026-11-12). The date-index seeks must return the same rows for every TEXT shape date() reads.
const schema = readFileSync('domain-schemas/learning.sql', 'utf8')
const MODELS = ['LightGBM', 'TabM', 'ResidualMLP', 'FT-T', 'iTransformer', 'TabPFN', 'CatBoost', 'NODE']
const placeholders = MODELS.map(() => '?').join(',')

const legacySql = `SELECT model_name,
              COUNT(*) AS count,
              COUNT(DISTINCT stock_id) AS stocks,
              MAX(date(verified_at)) AS latest_date
       FROM predictions
       WHERE model_name IN (${placeholders})
         AND actual_return_pct IS NOT NULL
         AND verified_at IS NOT NULL
         AND date(prediction_date) >= date('now', '-7 days')
       GROUP BY model_name
       ORDER BY model_name`

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schema.match(/CREATE TABLE IF NOT EXISTS predictions \([\s\S]*?\n\);/)![0])
  for (const index of schema.matchAll(/CREATE INDEX IF NOT EXISTS \w+\s+ON predictions\([^;]*\);/g)) db.exec(index[0])
  return db
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const julian = (date: string) => Date.parse(date + 'T00:00:00Z') / 86400000 + 2440587.5

/** Every prediction_date shape date() accepts or rejects, around one anchor day. */
function shapes(anchor: string): string[] {
  const at = Date.parse(anchor + 'T00:00:00Z'), year = Number(anchor.slice(0, 4))
  const values: string[] = ['', 'garbage', 'now', 'NOW', '20', '2', '1999-12-31']
  for (let offset = -16; offset <= 3; offset++) {
    const day = iso(at + offset * 86400000), jd = julian(day)
    values.push(day, `${day}T08:00:00`, `${day} 23:59:59-14:00`, `${day}T00:00:00+14:00`, `${day}Z`, `${day} `, ` ${day}`,
      String(jd), `+${jd}`, `00${jd}`, ` ${jd}`, `${jd / 1e6}e6`, `${jd / 1e5}E+5`, `${jd} `)
  }
  for (const y of [year - 1, year, year + 1]) for (let month = 1; month <= 12; month++) for (const dd of [29, 30, 31, 32]) {
    const text = `${y}-${String(month).padStart(2, '0')}-${dd}` // day overflow: 02-31 -> 03-03
    values.push(text, `${text} 23:59:59-14:00`)
  }
  return values
}

function seed(db: DatabaseSync, anchors: string[]) {
  const insert = db.prepare(`INSERT INTO predictions(stock_id,model_name,prediction_date,verified_at,actual_return_pct)
    VALUES(?,?,?,?,?)`)
  let i = 0
  for (const value of [...new Set(anchors.flatMap(shapes))]) {
    for (const model of [...MODELS, 'ensemble', 'legacy_lstm']) {
      i++
      const verified = i % 9 === 0 ? null : `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')} 10:00:00`
      insert.run(1000 + (i % 37), model, value, verified, i % 7 === 0 ? null : (i % 13) / 10)
    }
  }
  for (const model of MODELS) insert.run(1, model, null, '2026-11-01 10:00:00', 0.1)
}

// 'now' is the clock; replacing it with a fixed day runs the same predicate at chosen anchors.
const at = (sql: string, anchor: string | null) => anchor ? sql.replaceAll(`date('now',`, `date('${anchor}',`) : sql

test('the date-index seeks return the same per-model evidence as the date() scan', () => {
  const today = iso(Date.now())
  const anchors = ['2026-03-08', '2026-03-11', '2024-03-07', '2026-11-12', '2027-01-03', '2026-12-31', today]
  const db = openDb()
  try {
    seed(db, anchors)
    const sql = modelIcEvidenceSql(placeholders)
    for (const anchor of [...anchors, null]) {
      const legacy = db.prepare(at(legacySql, anchor)).all(...MODELS)
      const seek = db.prepare(at(sql, anchor)).all(...MODELS, ...MODELS)
      assert.deepEqual(seek, legacy, String(anchor))
      assert.equal(legacy.length, MODELS.length, String(anchor))
    }
  } finally {
    db.close()
  }
})

test('both branches seek idx_pred_date_model_stock and never scan the table', () => {
  const db = openDb()
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${modelIcEvidenceSql(placeholders)}`).all(...MODELS, ...MODELS)
      .map((row) => String(row.detail))
    assert.ok(plan.includes('SEARCH predictions USING INDEX idx_pred_date_model_stock (prediction_date>?)'), plan.join(' | '))
    assert.ok(plan.includes('SEARCH predictions USING INDEX idx_pred_date_model_stock (prediction_date<?)'), plan.join(' | '))
    assert.ok(!plan.some((detail) => /^SCAN predictions|idx_pred_model_verified_date/.test(detail)), plan.join(' | '))
  } finally {
    db.close()
  }
})
