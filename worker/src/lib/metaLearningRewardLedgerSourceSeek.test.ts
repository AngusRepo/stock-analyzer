import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { listLinUcbRewardSourceRowsAcrossDomains } from './metaLearningRewardLedger'

// The LinUCB source read used date(p.prediction_date) (SCAN p + TEMP B-TREE, ~25 s / 0.67M rows on
// learning-db, 2026-11-23). The seekable form must return exactly the rows of the former SQL, in order.
const MIGRATIONS = new URL('../../domain-migrations/learning/', import.meta.url)

const SELECT = `
    SELECT p.prediction_date AS date, p.stock_id, p.model_name,
           p.direction_correct,
           COALESCE(
             CASE WHEN json_valid(p.forecast_data) THEN json_extract(p.forecast_data, '$.rank_score') END,
             CASE WHEN json_valid(p.forecast_data) THEN json_extract(p.forecast_data, '$.ensemble_v2.avg_rank') END,
             p.direction_accuracy
           ) AS rank_score,
           p.market_risk_score, p.trade_pnl_pct, p.actual_return_pct
      FROM predictions p`
const OUTCOME = '(p.trade_pnl_pct IS NOT NULL OR p.actual_return_pct IS NOT NULL)'

type Window = { startDate?: string; endDate?: string; limit: number; requireOutcome?: boolean }

function formerSql(window: Window): { sql: string; params: unknown[] } {
  const clauses = window.requireOutcome === false ? [] : [OUTCOME]
  const params: unknown[] = []
  if (window.startDate) { clauses.push('date(p.prediction_date) >= date(?)'); params.push(window.startDate) }
  if (window.endDate) { clauses.push('date(p.prediction_date) <= date(?)'); params.push(window.endDate) }
  params.push(window.limit)
  return {
    sql: `${SELECT} WHERE ${clauses.length ? clauses.join(' AND ') : '1=1'}
     ORDER BY date(p.prediction_date) DESC, p.stock_id DESC, p.model_name DESC LIMIT ?`,
    params,
  }
}

function learningDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'))
  }
  return db
}

function seed(db: DatabaseSync): void {
  const insert = db.prepare(`INSERT INTO predictions (stock_id, model_name, prediction_date, forecast_data,
    direction_correct, trade_pnl_pct, actual_return_pct, market_risk_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  let n = 0
  for (const date of ['2026-08-29', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) {
    for (const stock of [50, 1101, 2330]) {
      for (const model of ['lightgbm', 'tabnet', 'xgboost']) {
        n += 1
        const matured = date !== '2026-09-04' && n % 5 !== 0
        insert.run(stock, model, date, JSON.stringify({ rank_score: n / 100 }), matured ? 1 : null,
          matured ? n / 10 : null, matured && n % 2 ? n / 20 : null, n % 7)
      }
    }
  }
}

async function captured(db: DatabaseSync, window: Window): Promise<{ sql: string; params: unknown[]; rows: unknown[] }> {
  let read: { sql: string; params: unknown[] } | null = null
  const predictionDb = { prepare: (sql: string) => ({
    bind: (...params: unknown[]) => ({
      async all() { read = { sql, params }; return { results: db.prepare(sql).all(...(params as any[])) } },
    }),
  }) } as unknown as D1Database
  const recommendationDb = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) } as unknown as D1Database
  await listLinUcbRewardSourceRowsAcrossDomains(predictionDb, recommendationDb, window)
  assert.ok(read, 'prediction read not issued')
  const { sql, params } = read as { sql: string; params: unknown[] }
  return { sql, params, rows: db.prepare(sql).all(...(params as any[])) }
}

const WINDOWS: Window[] = [
  { startDate: '2026-06-02', endDate: '2026-09-03', limit: 5000 }, // adaptiveEngine: 90 days back
  { startDate: '2026-06-02', endDate: '2026-09-03', limit: 7 }, // LIMIT cuts inside a date
  { endDate: '2026-09-02', limit: 5000 }, // postMarketChain sourceRows: endDate only
  { endDate: '2026-09-02', limit: 4 },
  { startDate: '2026-09-04', endDate: '2026-09-04', limit: 5000, requireOutcome: false }, // decisionRows
  { startDate: '2026-09-02', endDate: '2026-09-02', limit: 5, requireOutcome: false },
  { startDate: '2026-09-05', endDate: '2026-09-05', limit: 5000, requireOutcome: false }, // no rows
  { startDate: '2026-09-01T00:00:00Z', endDate: '2026-09-02 23:59:59', limit: 5000 }, // time-suffixed binds
]

test('the seekable LinUCB source read returns the former rows, in order, for every caller window', async () => {
  const db = learningDb()
  seed(db)
  for (const window of WINDOWS) {
    const { rows } = await captured(db, window)
    const former = formerSql(window)
    assert.deepEqual(rows, db.prepare(former.sql).all(...(former.params as any[])), JSON.stringify(window))
  }
  const { rows } = await captured(db, { endDate: '2026-09-02', limit: 5000 })
  assert.ok(rows.length > 10, 'fixture must exercise multiple dates')
})

test('the LinUCB source read seeks idx_pred_date_stock_model_generated with no temp sort', async () => {
  const db = learningDb()
  for (const window of WINDOWS) {
    const { sql, params } = await captured(db, window)
    assert.ok(!/date\(p\.prediction_date\)/.test(sql), sql)
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as any[])) as Array<{ detail: string }>)
      .map((row) => row.detail)
    assert.ok(plan.some((detail) => /^SEARCH p USING INDEX idx_pred_date_stock_model_generated \(prediction_date[<>]/.test(detail)), plan.join('\n'))
    assert.ok(!plan.some((detail) => /^SCAN p\b|TEMP B-TREE/.test(detail)), plan.join('\n'))
  }
  const former = formerSql(WINDOWS[0])
  const formerPlan = (db.prepare(`EXPLAIN QUERY PLAN ${former.sql}`).all(...(former.params as any[])) as Array<{ detail: string }>)
    .map((row) => row.detail)
  assert.ok(formerPlan.some((detail) => /^SCAN p\b/.test(detail)), formerPlan.join('\n'))
})

test('LinUCB source binds are normalized to YYYY-MM-DD; values date() would null out throw', async () => {
  const db = learningDb()
  const { params } = await captured(db, { startDate: '2026-09-01T08:30:00.000Z', endDate: '2026-09-02 10:00', limit: 10 })
  assert.deepEqual(params, ['2026-09-01', '2026-09-02', 10])
  for (const bad of ['2026/09/02', '2026-9-2', '2026-02-30', 'yesterday', '2026-09-02T10:00:00+08:00']) {
    await assert.rejects(captured(db, { endDate: bad, limit: 10 }), /linucb_source_invalid_endDate/, bad)
  }
})
