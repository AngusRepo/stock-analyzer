import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { hydrateMatureMetaShadowDecisionRewards } from './metaLearningShadowDecisions'

// The hydration join used to walk every verified prediction (7.14M rows, 7.7 s on 2026-11-18).
// The seekable form must return exactly the rows of the former SQL, kept verbatim below.
const MIGRATIONS = new URL('../../domain-migrations/learning/', import.meta.url)

const FORMER_SQL = `
    SELECT d.decision_id,
           d.business_date,
           d.symbol,
           d.arm_id,
           d.evidence_json,
           p.model_name,
           p.direction_correct,
           p.trade_pnl_pct,
           p.actual_return_pct
      FROM meta_shadow_decisions d
      JOIN predictions p
        ON CAST(p.stock_id AS TEXT) = d.symbol
       AND date(p.prediction_date) = date(d.business_date)
     WHERE d.counterfactual_reward IS NULL
       AND date(d.business_date) <= date(?)
       AND p.verified_at IS NOT NULL
       AND (p.direction_correct IS NOT NULL OR p.trade_pnl_pct IS NOT NULL OR p.actual_return_pct IS NOT NULL)
     ORDER BY date(d.business_date) ASC, d.decision_id ASC, p.model_name ASC
     LIMIT ?
`

function learningDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, MIGRATIONS), 'utf8'))
  }
  return db
}

function seed(db: DatabaseSync): void {
  const prediction = db.prepare(`INSERT INTO predictions (stock_id, model_name, prediction_date, verified_at,
    direction_correct, trade_pnl_pct, actual_return_pct) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  for (const date of ['2026-09-01', '2026-09-02', '2026-09-03']) {
    for (const [stock, model] of [[2330, 'xgboost'], [2330, 'lightgbm'], [50, 'xgboost'], [1101, 'tabnet']] as const) {
      prediction.run(stock, model, date, `${date}T10:00:00Z`, 1, 0.5, 1.2)
    }
    prediction.run(2330, 'unverified', date, null, 1, 0.5, 1.2) // not verified
    prediction.run(2330, 'no_outcome', date, `${date}T10:00:00Z`, null, null, null) // verified, no outcome
  }
  const decision = db.prepare(`INSERT INTO meta_shadow_decisions (decision_id, policy_id, business_date, symbol, arm_id,
    baseline_action, shadow_action, counterfactual_reward, context_json, evidence_json) VALUES (?, 'NeuralUCB', ?, ?, ?, 'hold', 'buy', ?, '{}', '{}')`)
  decision.run('d1', '2026-09-01', '2330', 'tree_family', null)
  decision.run('d2', '2026-09-01', '0050', 'tree_family', null) // leading zero: never equals CAST(50 AS TEXT)
  decision.run('d3', '2026-09-02', '1101', 'tabular_neural_family', null)
  decision.run('d4', '2026-09-02', '2330', 'do_nothing', null)
  decision.run('d5', '2026-09-02', '2330', 'tree_family', 0.1) // already hydrated
  decision.run('d6', '2026-09-03', '2330', 'tree_family', null) // after endDate
  decision.run('d7', '2026-09-01', '9999', 'tree_family', null) // no prediction
}

async function captured(db: DatabaseSync, endDate: string, limit: number): Promise<{ sql: string; params: unknown[] }> {
  let read: { sql: string; params: unknown[] } | null = null
  const statement = (sql: string, params: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async all() { read = { sql, params }; return { results: db.prepare(sql).all(...(params as any[])) } },
    async first() { return db.prepare(sql).get(...(params as any[])) ?? null },
    async run() { return { meta: { changes: 0 } } },
  })
  await hydrateMatureMetaShadowDecisionRewards({ prepare: (sql: string) => statement(sql) } as any, { endDate, limit })
  assert.ok(read, 'hydration read not issued')
  return read
}

test('the seekable hydration join returns the former rows, in order, under every limit', async () => {
  const db = learningDb()
  seed(db)
  for (const [endDate, limit] of [['2026-09-02', 50000], ['2026-09-02', 3], ['2026-09-03', 50000], ['2026-08-31', 50000]] as const) {
    const { sql, params } = await captured(db, endDate, limit)
    const current = db.prepare(sql).all(...(params as any[]))
    const former = db.prepare(FORMER_SQL).all(endDate, limit)
    assert.deepEqual(current, former, `${endDate} limit=${limit}`)
  }
  const all = db.prepare(FORMER_SQL).all('2026-09-02', 50000) as Array<{ decision_id: string }>
  assert.deepEqual([...new Set(all.map((row) => row.decision_id))], ['d1', 'd3', 'd4'])
})

test('the hydration join seeks predictions by (prediction_date, stock_id)', async () => {
  const db = learningDb()
  const { sql, params } = await captured(db, '2026-09-02', 50000)
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as any[])) as Array<{ detail: string }>)
    .map((row) => row.detail)
  assert.ok(plan.some((detail) => /^SEARCH p USING INDEX idx_pred_date_stock_model_generated \(prediction_date=\? AND stock_id=\?\)/.test(detail)), plan.join('\n'))
  assert.ok(!plan.some((detail) => /^SCAN p\b/.test(detail)), plan.join('\n'))
  const formerPlan = (db.prepare(`EXPLAIN QUERY PLAN ${FORMER_SQL}`).all('2026-09-02', 50000) as Array<{ detail: string }>)
    .map((row) => row.detail)
  assert.ok(formerPlan.some((detail) => /^SCAN p\b/.test(detail)), formerPlan.join('\n'))
  // learning 0070: pending decisions are read by their partial index, not the whole decision table.
  assert.ok(plan.some((detail) => /^SEARCH d USING INDEX idx_meta_shadow_decisions_pending \(business_date<\?\)/.test(detail)), plan.join('\n'))
})

test('pending decisions the seekable join cannot match are counted, not silently left pending', async () => {
  const db = learningDb()
  seed(db)
  const decision = db.prepare(`INSERT INTO meta_shadow_decisions (decision_id, policy_id, business_date, symbol, arm_id,
    baseline_action, shadow_action, counterfactual_reward, context_json, evidence_json) VALUES (?, 'NeuralUCB', ?, ?, 'tree_family', 'hold', 'buy', NULL, '{}', '{}')`)
  decision.run('u1', '2026-09-01 00:00:00', '2330')
  decision.run('u2', '2026-09-01', '00631L')
  decision.run('u3', '2026-09-03 00:00:00', '2330') // after endDate: not counted
  const statement = (sql: string, params: unknown[] = []): any => ({
    bind: (...next: unknown[]) => statement(sql, next),
    async all() { return { results: db.prepare(sql).all(...(params as any[])) } },
    async first() { return db.prepare(sql).get(...(params as any[])) ?? null },
    async run() { return { meta: { changes: 0 } } },
  })
  const report = await hydrateMatureMetaShadowDecisionRewards({ prepare: (sql: string) => statement(sql) } as any,
    { endDate: '2026-09-02', limit: 50000 })
  // d2 ('0050') never matched in the former SQL either; u1/u2 are the shapes only the former join matched.
  assert.equal(report.unseekable_pending_decisions, 3)
  const canonicalOnly = learningDb()
  seed(canonicalOnly)
  canonicalOnly.prepare(`DELETE FROM meta_shadow_decisions WHERE symbol='0050'`).run()
  const clean = await hydrateMatureMetaShadowDecisionRewards({ prepare: (sql: string) => ({
    bind: (...params: unknown[]) => ({
      all: async () => ({ results: canonicalOnly.prepare(sql).all(...(params as any[])) }),
      first: async () => canonicalOnly.prepare(sql).get(...(params as any[])) ?? null,
      run: async () => ({ meta: { changes: 0 } }),
    }),
  }) } as any, { endDate: '2026-09-02', limit: 50000 })
  assert.equal(clean.unseekable_pending_decisions, 0)
  const guardSql = readFileSync(new URL('./metaLearningShadowDecisions.ts', import.meta.url), 'utf8')
    .match(/const unseekable = await db\.prepare\(`([\s\S]*?)`\)/)?.[1] ?? ''
  const guardPlan = (db.prepare(`EXPLAIN QUERY PLAN ${guardSql}`).all('2026-09-02') as Array<{ detail: string }>).map((row) => row.detail)
  assert.ok(guardPlan.some((detail) => /USING INDEX idx_meta_shadow_decisions_pending/.test(detail)), guardPlan.join('\n'))
})

test('the hydration INDEXED BY target exists in the learning migrations', () => {
  // INDEXED BY fails the statement (not just slows it) if an index cleanup drops this index.
  const db = learningDb()
  const index = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_pred_date_stock_model_generated'`).get() as { sql?: string } | undefined
  assert.match(String(index?.sql), /ON predictions\s*\(prediction_date, stock_id/)
})
