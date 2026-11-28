// L-2 cold reads: every Worker reader of Learning `predictions` returns the same result after
// retention-hot-window-drain archived and deleted rows older than the 127-day hot window (120 + 7 buffer days).
// Each case runs the reader on an untouched copy, then on a drained copy with the R2 archive.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE, runRetentionHotWindowDrain } from './retentionHotWindowDrain'
import {
  oldestArchivablePredictionDate,
  readArchivedPredictions,
  releasedPredictionFrontier,
  readDailyRecommendationPredictions,
  readArchivedEnsembleStockDates,
  readPredictionTradeHistory,
  readStockLatestPredictions,
  readStockModelSignals,
} from './retentionPredictionsReader'
import { loadCandidateSignalDates, loadCandidateStockIds } from './priceHorizonProjection'
import { listLinUcbRewardSourceRows, listLinUcbRewardSourceRowsAcrossDomains } from './metaLearningRewardLedger'
import { listAdaptiveMetaPolicyReplayRowsAcrossDomains } from './adaptiveMetaPolicyReplayRunner'
import { META_SHADOW_COLD_MARK_LIMIT, hydrateMatureMetaShadowDecisionRewards } from './metaLearningShadowDecisions'
import { PREDICTION_COLD_STATS_COLUMNS } from './retentionPredictionColdStats'
import type { Bindings } from '../types'

const BUSINESS_DATE = '2026-12-02'
const CUTOFF = '2026-07-28' // BUSINESS_DATE - 127 days (120-day reader floor + 7 buffer days)
// The predictions floor never counts from a future business date, so "today" is BUSINESS_DATE.
// The clock still advances 1 ms per read: drain run ids carry Date.now().
const clockBase = Date.parse(`${BUSINESS_DATE}T04:00:00.000Z`)
let clockTicks = 0
Date.now = () => clockBase + clockTicks++

const OLD_DATES = ['2026-05-04', '2026-06-01', '2026-07-15', '2026-07-27']
const HOT_DATES = [CUTOFF, '2026-09-01', '2026-11-30']
const MODELS = ['ensemble', 'LightGBM', 'XGBoost', 'TabM', 'LightGBM::challenger']
const STOCKS = [2330, 2317, 2454]

function d1(sql: DatabaseSync) {
  function prepare(query: string, params: unknown[] = []) {
    return {
      query, params,
      bind(...values: unknown[]) { return prepare(query, values) },
      async first() { const row = sql.prepare(query).get(...params as any[]); return row ? { ...row } : null },
      async all() { return { results: sql.prepare(query).all(...params as any[]).map((row) => ({ ...row })) } },
      async run() { return { success: true, meta: { changes: Number(sql.prepare(query).run(...params as any[]).changes) } } },
    }
  }
  return { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    sql.exec('BEGIN')
    try {
      const results = statements.map((statement) => {
        const q = sql.prepare(statement.query)
        return { results: q.columns().length ? q.all(...statement.params as any[]) : (q.run(...statement.params as any[]), []) }
      })
      sql.exec('COMMIT')
      return results
    } catch (error) { if (sql.isTransaction) sql.exec('ROLLBACK'); throw error }
  } } as unknown as D1Database
}

async function fixture(drained: boolean) {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync('domain-schemas/learning.sql', 'utf8'))
  sql.exec(readFileSync('domain-schemas/ops.sql', 'utf8'))
  sql.exec('ALTER TABLE predictions ADD COLUMN signal_raw TEXT') // prod learning-db has it (ALTER-added TEXT); the schema file lags
  sql.prepare(`UPDATE data_retention_policies SET hot_retention_days=120, cold_retention_days=3650,
    archive_store='r2', action='archive_delete', hard_reference_protected=1, status='active'
    WHERE policy_id='learning_lineage_v1'`).run()
  const core = new DatabaseSync(':memory:')
  core.exec(`CREATE TABLE stocks (id INTEGER PRIMARY KEY, symbol TEXT, name TEXT, sector TEXT, market TEXT);
    CREATE TABLE daily_recommendations (date TEXT, stock_id INTEGER, symbol TEXT, rank INTEGER, score REAL,
      score_components TEXT, alpha_context TEXT, alpha_allocation TEXT, ml_vote_summary TEXT, market_segment TEXT,
      recommendation_lane TEXT, has_buy_signal INTEGER)`)
  const objects = new Map<string, string>()
  const env = {
    DB: d1(sql), LEARNING_DB: d1(sql), OPS_DB: d1(sql), CORE_DB: d1(core),
    ARTIFACTS: {
      async put(key: string, body: string) { objects.set(key, body) },
      async get(key: string) {
        const body = objects.get(key)
        return body === undefined ? null : { size: Buffer.byteLength(body), text: async () => body }
      },
    },
  } as unknown as Bindings
  let id = 5000
  for (const date of [...OLD_DATES, ...HOT_DATES]) {
    for (const stock of STOCKS) {
      core.prepare('INSERT OR IGNORE INTO stocks(id, symbol, name, sector, market) VALUES(?,?,?,?,?)')
        .run(stock, String(stock), `S${stock}`, 'semis', 'TWSE')
      core.prepare(`INSERT INTO daily_recommendations(date, stock_id, symbol, rank, score, score_components, alpha_context,
        alpha_allocation, ml_vote_summary, market_segment, recommendation_lane, has_buy_signal) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(date, stock, String(stock), stock % 7, 50 + stock % 9, '{}', '{}', '{"selected":1}', '{}', 'TWSE', 'core', 1)
      for (const [index, model] of MODELS.entries()) {
        ++id
        const verified = (id % 5) !== 0
        // Two ensemble versions per day exercise "latest generated_at, then id" ordering.
        for (const version of model === 'ensemble' ? [0, 1] : [0]) {
          sql.prepare(`INSERT INTO predictions(id, stock_id, model_name, generated_at, prediction_date, forecast_data,
            trade_signal, signal_raw, direction_accuracy, direction_correct, actual_return_pct, trade_pnl_pct, trade_pnl_r,
            price_error_pct, market_risk_score, verified_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id * 10 + version, stock, model, `${date} 13:3${version}:0${index}`, date,
              JSON.stringify({ rank_score: (id % 11) / 10, ensemble_v2: { avg_rank: 0.5 }, v: version }),
              'buy', (id % 3) - 1, 0.5 + (id % 4) / 10, verified ? id % 2 : null,
              verified ? ((id % 13) - 6) / 100 : null, verified && id % 3 ? ((id % 9) - 4) / 100 : null,
              verified ? 0.4 : null, 1.2, 0.3 + (id % 5) / 10, verified ? `${date} 20:00:00` : null, `${date} 13:30:00`)
        }
      }
      for (const arm of ['tree_family', 'do_nothing']) {
        sql.prepare(`INSERT INTO meta_shadow_decisions(decision_id, policy_id, business_date, symbol, arm_id, evidence_json)
          VALUES(?,?,?,?,?,?)`).run(`${date}:${stock}:${arm}`, 'NeuralUCB', date, String(stock), arm, '{}')
      }
    }
  }
  if (drained) {
    for (let round = 0; round < 20; round++) {
      const result = await runRetentionHotWindowDrain(env, { policyIds: ['learning_lineage_v1'], businessDate: BUSINESS_DATE,
        confirmPhrase: RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE, limitPerDataset: 5, maxRounds: 10, budgetMs: 120_000 })
      assert.notEqual(result.status, 'error', JSON.stringify(result))
      const left = sql.prepare('SELECT COUNT(*) n FROM predictions WHERE prediction_date < ?').get(CUTOFF) as { n: number }
      if (!left.n) break
    }
    const left = sql.prepare('SELECT COUNT(*) n FROM predictions WHERE prediction_date < ?').get(CUTOFF) as { n: number }
    assert.equal(left.n, 0, 'drain must remove every row before the cutoff')
  }
  return { sql, env, learning: d1(sql), core: d1(core) }
}

test('the archive holds exactly the deleted rows, and recent dates skip the ops lookup', async () => {
  const before = await fixture(false)
  const deleted = before.sql.prepare('SELECT * FROM predictions WHERE prediction_date < ? ORDER BY id').all(CUTOFF)
  const after = await fixture(true)
  const archived = (await readArchivedPredictions(after.env, { start: '0000-01-01', end: '9999-12-31' }))
    .sort((a, b) => Number(a.id) - Number(b.id))
  assert.equal(archived.length, deleted.length)
  assert.deepEqual(archived.map((row) => ({ ...row })), deleted.map((row) => ({ ...row })))
  assert.equal(oldestArchivablePredictionDate(), CUTOFF)
  let opsReads = 0
  const counting = { ...after.env, OPS_DB: { prepare: () => { opsReads++; throw new Error('no ops read expected') } } } as any
  assert.deepEqual(await readArchivedPredictions(counting, { start: CUTOFF, end: '9999-12-31' }), [])
  assert.equal(opsReads, 0)
})

test('/recommendations/daily prediction reads match before and after the drain', async () => {
  const before = await fixture(false)
  const after = await fixture(true)
  for (const date of [...OLD_DATES, HOT_DATES[1]]) {
    assert.deepEqual(
      await readDailyRecommendationPredictions(after.env, after.learning, date, STOCKS),
      await readDailyRecommendationPredictions(before.env, before.learning, date, STOCKS), date)
  }
  const old = await readDailyRecommendationPredictions(after.env, after.learning, OLD_DATES[0], STOCKS)
  assert.ok(old.ensembleRows.results.length > 0 && old.perModelRows.results.length > 0)
  assert.ok(old.perModelRows.results.every((row) => !String(row.model_name).endsWith('::challenger')))
})

test('/ml/trade-history matches before and after the drain', async () => {
  const before = await fixture(false)
  const after = await fixture(true)
  for (const limit of [5, 40, 500]) {
    for (const stock of STOCKS) {
      const expected = await readPredictionTradeHistory(before.env, stock, limit)
      assert.deepEqual(await readPredictionTradeHistory(after.env, stock, limit), expected, `${stock}:${limit}`)
      if (limit === 500) assert.ok(expected.some((row) => String(row.generated_at) < CUTOFF))
    }
  }
})

test('LinUCB reward source rows match before and after the drain', async () => {
  const before = await fixture(false)
  const after = await fixture(true)
  for (const options of [{}, { startDate: '2026-05-01', endDate: '2026-12-01' }, { startDate: '2026-06-01', endDate: '2026-07-15' },
    { limit: 20 }, { limit: 200, requireOutcome: false }]) {
    const expected = await listLinUcbRewardSourceRowsAcrossDomains(before.learning, before.core, options)
    const actual = await listLinUcbRewardSourceRowsAcrossDomains(after.learning, after.core, { ...options, coldEnv: after.env })
    assert.deepEqual(actual, expected, JSON.stringify(options))
  }
  const truncated = await listLinUcbRewardSourceRowsAcrossDomains(after.learning, after.core, { startDate: '2026-05-01' })
  const full = await listLinUcbRewardSourceRowsAcrossDomains(before.learning, before.core, { startDate: '2026-05-01' })
  assert.ok(truncated.length < full.length, 'without the archive the window really is shorter')
})

function countingGets(env: Bindings) {
  const store = (env as any).ARTIFACTS
  const counter = { gets: 0, env: undefined as unknown as Bindings }
  counter.env = { ...env, ARTIFACTS: { put: store.put, async get(key: string) { counter.gets++; return store.get(key) } } } as unknown as Bindings
  return counter
}

test('latest-N reads touch R2 only while the archive can still change the result', async () => {
  const before = await fixture(false)
  const after = await fixture(true)
  const archives = (after.sql.prepare(`SELECT COUNT(*) n FROM run_artifacts WHERE domain='retention_learning_lineage_v1_predictions'`)
    .get() as { n: number }).n
  assert.ok(archives >= 10, `fixture must spread the archive over many chunks (${archives})`)
  const r2 = countingGets(after.env)
  // A full hot page (the nightly postMarketChain read is limit 5000 over a 120-day hot window): no R2 at all.
  for (const options of [{ limit: 20 }, { endDate: BUSINESS_DATE, limit: 20 }]) {
    r2.gets = 0
    const actual = await listLinUcbRewardSourceRowsAcrossDomains(after.learning, after.core, { ...options, coldEnv: r2.env })
    assert.deepEqual(actual, await listLinUcbRewardSourceRowsAcrossDomains(before.learning, before.core, options))
    assert.equal(r2.gets, 0, JSON.stringify(options))
  }
  // Single-database variant (legacy layout): daily_recommendations beside predictions.
  after.sql.exec(`CREATE TABLE daily_recommendations (date TEXT, stock_id INTEGER, rank INTEGER, market_segment TEXT,
    recommendation_lane TEXT, has_buy_signal INTEGER, score_components TEXT, alpha_context TEXT, alpha_allocation TEXT, ml_vote_summary TEXT)`)
  for (const date of [...OLD_DATES, ...HOT_DATES]) for (const stock of STOCKS)
    after.sql.prepare(`INSERT INTO daily_recommendations VALUES(?,?,?,?,?,?,?,?,?,?)`).run(date, stock, stock % 7, 'TWSE', 'core', 1, '{}', '{}', '{}', '{}')
  r2.gets = 0
  assert.equal((await listLinUcbRewardSourceRows(after.learning, { limit: 20, coldEnv: r2.env })).length, 20)
  assert.equal(r2.gets, 0, 'single-database guard of a full page reads no archive')
  // A short page reads newest chunks first and stops once the page is settled.
  for (const options of [{ startDate: '2026-05-01', endDate: '2026-07-20', limit: 10 }, { limit: 50 }]) {
    r2.gets = 0
    const actual = await listLinUcbRewardSourceRowsAcrossDomains(after.learning, after.core, { ...options, coldEnv: r2.env })
    assert.deepEqual(actual, await listLinUcbRewardSourceRowsAcrossDomains(before.learning, before.core, options), JSON.stringify(options))
    assert.ok(r2.gets > 0 && r2.gets < archives, `${JSON.stringify(options)} read ${r2.gets}/${archives} chunks`)
  }
  for (const stock of STOCKS) {
    r2.gets = 0
    assert.deepEqual(await readPredictionTradeHistory(r2.env, stock, 5), await readPredictionTradeHistory(before.env, stock, 5))
    assert.equal(r2.gets, 0, `trade-history ${stock} full page`)
    r2.gets = 0
    assert.deepEqual(await readPredictionTradeHistory(r2.env, stock, 25), await readPredictionTradeHistory(before.env, stock, 25))
    assert.ok(r2.gets < archives, `trade-history ${stock} short page read ${r2.gets}/${archives} chunks`)
  }
  await assert.rejects(listLinUcbRewardSourceRows(after.learning, { startDate: '2026-05-01', coldEnv: r2.env }),
    /linucb_source_archived_predictions_require_split_domains/)
})

test('UI reads (dashboard model signals, stock latest predictions) match before and after the drain', async () => {
  const before = await fixture(false)
  const after = await fixture(true)
  for (const stock of STOCKS) {
    for (const limit of [5, 30, 300]) {
      assert.deepEqual(await readStockModelSignals(after.env, stock, limit), await readStockModelSignals(before.env, stock, limit), `${stock}:${limit}`)
      const latest = await readStockLatestPredictions(after.env, stock, limit)
      const expected = await readStockLatestPredictions(before.env, stock, limit)
      // ORDER BY generated_at only: ties may come back in either order, the rows and the time order are the same.
      assert.deepEqual(latest.map((row) => row.generated_at), expected.map((row) => row.generated_at), `${stock}:${limit}`)
      const key = (rows: Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row)).sort()
      assert.deepEqual(key(latest), key(expected), `${stock}:${limit}`)
    }
    assert.ok((await readStockModelSignals(before.env, stock, 300)).some((row) => String(row.prediction_date) < CUTOFF))
    // GET /stocks/:id recommendation: one stock, the recommendation date (archived for OLD_DATES).
    for (const date of [...OLD_DATES, CUTOFF]) {
      assert.deepEqual(await readDailyRecommendationPredictions(after.env, after.learning, date, [stock]),
        await readDailyRecommendationPredictions(before.env, before.learning, date, [stock]), `${stock}:${date}`)
    }
  }
  const stocksRoute = readFileSync('src/routes/stocks.ts', 'utf8')
  assert.match(stocksRoute, /readDailyRecommendationPredictions\(\s*c\.env, databaseForDataDomain\(c\.env, 'learning'\), recRow\.date, \[id\]/)
  assert.match(stocksRoute, /predictions_status: predictionsStatus/)
})

test('price-horizon candidate dates and stock ids keep archived ensemble predictions', async () => {
  const before = await fixture(false)
  const after = await fixture(true)
  for (const { sql } of [before, after])
    sql.exec('CREATE TABLE IF NOT EXISTS price_horizon_labels_v2 (price_date TEXT, stock_id INTEGER, horizon_days INTEGER)')
  const r2 = countingGets(after.env)
  const archived = (start: string, end: string) => readArchivedEnsembleStockDates(r2.env, start, end)
  for (const [start, end] of [['2026-05-01', '2026-12-02'], [OLD_DATES[1], OLD_DATES[1]], ['2026-07-01', '2026-09-01']]) {
    const expected = [...await loadCandidateSignalDates(before.learning, start, end)].sort()
    assert.ok(expected.some((date) => date < CUTOFF))
    assert.deepEqual([...await loadCandidateSignalDates(after.learning, start, end, archived)].sort(), expected, `${start}..${end}`)
    assert.notDeepEqual([...await loadCandidateSignalDates(after.learning, start, end)].sort(), expected, 'hot-only is really short')
  }
  for (const date of [...OLD_DATES, HOT_DATES[1]]) {
    assert.deepEqual(await loadCandidateStockIds(after.learning, date, undefined, archived),
      await loadCandidateStockIds(before.learning, date), date)
  }
  assert.equal(r2.gets, 0, 'candidate sets come from manifest metadata, not R2 chunks')
})

test('an archive whose delete never committed is retired by the drain and skipped by readers', async () => {
  const before = await fixture(false)
  const broken = await fixture(false)
  let failDeletes = 1
  let failRetire = 1 // Retirement fails too (ops unavailable), so the orphan stays listed until the next pass.
  for (const binding of ['DB', 'LEARNING_DB', 'OPS_DB']) {
    const db = (broken.env as any)[binding]
    const batch = db.batch.bind(db), prepare = db.prepare.bind(db)
    db.batch = async (statements: any[]) => {
      if (failDeletes > 0 && statements.some((statement) => /DELETE FROM "?predictions"?\s/.test(statement.query))) {
        failDeletes--
        throw new Error('D1_ERROR: simulated network loss before commit')
      }
      return batch(statements)
    }
    db.prepare = (query: string) => {
      if (failRetire > 0 && /SET retention_class='staging_orphan'/.test(query)) { failRetire--; throw new Error('ops down') }
      return prepare(query)
    }
  }
  const drain = (businessDate = BUSINESS_DATE) => runRetentionHotWindowDrain(broken.env, { policyIds: ['learning_lineage_v1'], businessDate,
    confirmPhrase: RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE, limitPerDataset: 5, maxRounds: 1, budgetMs: 120_000 })
  // The failed pass ran for the previous business date: its payload (cutoff) differs from every later one.
  const first = await drain('2026-12-01')
  assert.equal(failDeletes, 0)
  assert.match(JSON.stringify(first), /simulated network loss/)
  const orphanSql = `SELECT artifact_id, retention_class FROM run_artifacts WHERE domain='retention_learning_lineage_v1_predictions'`
  const [orphan] = broken.sql.prepare(orphanSql).all() as any[]
  assert.equal(orphan.retention_class, 'ten_year_cold_archive', 'the failed pass could not retire it')
  assert.equal((broken.sql.prepare('SELECT COUNT(*) n FROM learning_retention_releases_v1').get() as any).n, 0)
  for (let round = 0; round < 40; round++) {
    await drain()
    if (!(broken.sql.prepare('SELECT COUNT(*) n FROM predictions WHERE prediction_date < ?').get(CUTOFF) as any).n) break
  }
  const retired = broken.sql.prepare(`${orphanSql} AND artifact_id=?`).get(orphan.artifact_id) as any
  assert.equal(retired.retention_class, 'staging_orphan', 'the next pass retires the unreleased archive')
  const unreleased = broken.sql.prepare(`SELECT a.artifact_id FROM run_artifacts a WHERE a.domain='retention_learning_lineage_v1_predictions'
    AND a.retention_class='ten_year_cold_archive' AND NOT EXISTS (SELECT 1 FROM learning_retention_releases_v1 r WHERE r.artifact_id=a.artifact_id)`).all()
  assert.deepEqual(unreleased, [], 'every ten-year predictions archive is released')
  const r2 = countingGets(broken.env)
  for (const limit of [5, 40]) for (const stock of STOCKS)
    assert.deepEqual(await readPredictionTradeHistory(r2.env, stock, limit), await readPredictionTradeHistory(before.env, stock, limit))
  assert.deepEqual(
    (await readArchivedPredictions(broken.env, { start: '0000-01-01', end: '9999-12-31' })).sort((a, b) => Number(a.id) - Number(b.id)),
    before.sql.prepare('SELECT * FROM predictions WHERE prediction_date < ? ORDER BY id').all(CUTOFF).map((row) => ({ ...row })))
  // Readers skip a receipt-less archive even before it is retired.
  broken.sql.prepare(`UPDATE run_artifacts SET retention_class='ten_year_cold_archive' WHERE artifact_id=?`).run(orphan.artifact_id)
  for (const stock of STOCKS)
    assert.deepEqual(await readPredictionTradeHistory(broken.env, stock, 40), await readPredictionTradeHistory(before.env, stock, 40))
})

test('adaptive meta-policy replay rows match before and after the drain', async () => {
  const before = await fixture(false)
  const after = await fixture(true)
  for (const options of [{ startDate: '2026-05-01', endDate: '2026-12-01' }, { startDate: '2026-06-01', endDate: '2026-08-10' },
    { startDate: '2026-05-01', endDate: '2026-12-01', limit: 25 }]) {
    const expected = await listAdaptiveMetaPolicyReplayRowsAcrossDomains(before.learning, before.core, options)
    assert.ok(expected.length > 0)
    const actual = await listAdaptiveMetaPolicyReplayRowsAcrossDomains(after.learning, after.core, { ...options, coldEnv: after.env })
    assert.deepEqual(actual, expected, JSON.stringify(options))
  }
})

test('meta shadow reward hydration matches before and after the drain', async () => {
  const nowIso = `${BUSINESS_DATE}T05:00:00.000Z`
  for (const limit of [7, 20000]) {
    const b = await fixture(false), a = await fixture(true)
    const expected = await hydrateMatureMetaShadowDecisionRewards(b.learning, { endDate: BUSINESS_DATE, limit, nowIso })
    const { cold_unavailable_decisions: coldUnavailable, ...actual } = await hydrateMatureMetaShadowDecisionRewards(a.learning,
      { endDate: BUSINESS_DATE, limit, nowIso, coldEnv: a.env })
    const { cold_unavailable_decisions: undrainedUnavailable, ...expectedRest } = expected
    assert.equal(undrainedUnavailable, 0)
    assert.deepEqual(actual, expectedRest, String(limit))
    const state = (sql: DatabaseSync) => sql.prepare(`SELECT decision_id, business_date, counterfactual_reward, evidence_json
      FROM meta_shadow_decisions ORDER BY decision_id`).all() as any[]
    // Rewards are identical; the drained copy only adds the explicit terminal status to pre-floor
    // decisions that have no reward in the undrained copy either.
    const terminal = state(a.sql).filter((row) => JSON.parse(row.evidence_json).outcome_hydration?.status === 'outcome_unavailable_after_cold_scan')
    assert.equal(terminal.length, coldUnavailable)
    const undrained = new Map(state(b.sql).map((row) => [row.decision_id, row]))
    for (const row of terminal) {
      assert.ok(row.business_date < CUTOFF && row.counterfactual_reward === null)
      assert.equal(undrained.get(row.decision_id).counterfactual_reward, null, row.decision_id)
    }
    const strip = (rows: any[]) => rows.map((row) => terminal.some((t) => t.decision_id === row.decision_id)
      ? { ...row, evidence_json: '{}' } : row)
    assert.deepEqual(strip(state(a.sql)), strip(state(b.sql)))
    if (limit !== 20000) assert.equal(coldUnavailable, 0, 'a truncated page never declares a decision unavailable')
    if (limit === 20000) {
      const oldHydrated = a.sql.prepare(`SELECT COUNT(*) n FROM meta_shadow_decisions
        WHERE business_date < ? AND counterfactual_reward IS NOT NULL`).get(CUTOFF) as { n: number }
      assert.ok(oldHydrated.n > 0, 'decisions past the hot window hydrate from the archive')
    }
  }
})

test('meta shadow hydration reads each pre-floor chunk once: unmatched decisions become explicit terminal rows', async () => {
  const after = await fixture(true)
  // Decisions on dates with no predictions at all (never matchable).
  for (const [date, sym] of [['2026-05-05', '2330'], ['2026-07-20', '2317']]) {
    after.sql.prepare(`INSERT INTO meta_shadow_decisions(decision_id, policy_id, business_date, symbol, arm_id, evidence_json)
      VALUES(?,?,?,?,?,?)`).run(`${date}:${sym}:stuck`, 'NeuralUCB', date, sym, 'tree_family', '{}')
  }
  let gets = 0
  const artifacts = (after.env as any).ARTIFACTS
  const env = { ...after.env, ARTIFACTS: { put: artifacts.put, async get(key: string) { gets++; return artifacts.get(key) } } } as any
  const nights = []
  for (let night = 0; night < 3; night++) {
    gets = 0
    const report = await hydrateMatureMetaShadowDecisionRewards(after.learning,
      { endDate: BUSINESS_DATE, limit: 50000, nowIso: `${BUSINESS_DATE}T05:00:00.000Z`, coldEnv: env })
    nights.push({ gets, report })
  }
  assert.ok(nights[0].gets > 0 && nights[0].report.cold_unavailable_decisions >= 2)
  assert.equal(nights[1].gets, 0, 'second night: no R2 get')
  assert.equal(nights[2].gets, 0)
  assert.equal(nights[1].report.cold_unavailable_decisions, 0)
  const stuck = after.sql.prepare(`SELECT counterfactual_reward, evidence_json FROM meta_shadow_decisions
    WHERE decision_id LIKE '%:stuck'`).all() as any[]
  assert.equal(stuck.length, 2)
  for (const row of stuck) {
    assert.equal(row.counterfactual_reward, null, 'never a fake reward')
    assert.equal(JSON.parse(row.evidence_json).outcome_hydration.reason, 'no_verified_prediction_in_hot_window_or_released_cold_archive')
  }
  const pendingOld = after.sql.prepare(`SELECT COUNT(*) n FROM meta_shadow_decisions WHERE counterfactual_reward IS NULL
    AND business_date < ? AND instr(evidence_json, '"outcome_unavailable_after_cold_scan"') = 0`).get(CUTOFF) as { n: number }
  assert.equal(pendingOld.n, 0, 'every pre-floor decision is hydrated or explicitly unavailable')
})

test('before the drain reaches a date, its pending decisions stay pending with no presence seek or write', async () => {
  const before = await fixture(false)
  // Old decisions with no prediction rows at all: before the drain nothing proves they are unavailable.
  for (const [date, sym] of [['2026-05-05', '2330'], ['2026-07-20', '2317']]) {
    before.sql.prepare(`INSERT INTO meta_shadow_decisions(decision_id, policy_id, business_date, symbol, arm_id, evidence_json)
      VALUES(?,?,?,?,?,?)`).run(`${date}:${sym}:stuck`, 'NeuralUCB', date, sym, 'tree_family', '{}')
  }
  const statements: string[] = []
  const learning = { prepare(query: string) { statements.push(query); return before.learning.prepare(query) } } as unknown as D1Database
  const report = await hydrateMatureMetaShadowDecisionRewards(learning,
    { endDate: BUSINESS_DATE, limit: 50000, nowIso: `${BUSINESS_DATE}T05:00:00.000Z`, coldEnv: before.env })
  assert.equal(report.cold_unavailable_decisions, 0)
  assert.equal(statements.filter((q) => /idx_pred_date_stock_model_generated/.test(q) && /SELECT 1 AS present/.test(q)).length, 0,
    'no per-decision presence seek before the drain')
  assert.equal(statements.filter((q) => /UPDATE meta_shadow_decisions\s+SET evidence_json/.test(q)).length, 0)
  const marked = before.sql.prepare(`SELECT COUNT(*) n FROM meta_shadow_decisions
    WHERE instr(evidence_json, '"outcome_unavailable_after_cold_scan"') > 0`).get() as { n: number }
  assert.equal(marked.n, 0)
})

test('a partly drained history marks only decisions up to the released frontier', async () => {
  const partial = await fixture(false)
  for (const [date, sym] of [['2026-05-05', '2330'], ['2026-07-20', '2317']]) {
    partial.sql.prepare(`INSERT INTO meta_shadow_decisions(decision_id, policy_id, business_date, symbol, arm_id, evidence_json)
      VALUES(?,?,?,?,?,?)`).run(`${date}:${sym}:stuck`, 'NeuralUCB', date, sym, 'tree_family', '{}')
  }
  // One small round: only the oldest rows (2026-05-04) leave the hot table.
  const result = await runRetentionHotWindowDrain(partial.env, { policyIds: ['learning_lineage_v1'], businessDate: BUSINESS_DATE,
    confirmPhrase: RETENTION_HOT_WINDOW_DRAIN_CONFIRM_PHRASE, limitPerDataset: 5, maxRounds: 1, budgetMs: 120_000 })
  assert.notEqual(result.status, 'error', JSON.stringify(result))
  const frontier = await releasedPredictionFrontier(partial.env as any, '2026-01-01')
  assert.ok(frontier && frontier < '2026-05-05', String(frontier))
  const seeks: unknown[][] = []
  const learning = { prepare(query: string) {
    const statement = partial.learning.prepare(query)
    if (!/SELECT 1 AS present/.test(query)) return statement
    return { bind(...values: unknown[]) { seeks.push(values); return statement.bind(...values) } }
  } } as unknown as D1Database
  await hydrateMatureMetaShadowDecisionRewards(learning,
    { endDate: BUSINESS_DATE, limit: 50000, nowIso: `${BUSINESS_DATE}T05:00:00.000Z`, coldEnv: partial.env })
  assert.ok(seeks.every(([date]) => String(date) <= frontier!), 'no presence seek past the frontier')
  const marked = partial.sql.prepare(`SELECT decision_id, business_date FROM meta_shadow_decisions
    WHERE instr(evidence_json, '"outcome_unavailable_after_cold_scan"') > 0`).all() as any[]
  assert.ok(marked.every((row) => row.business_date <= frontier!), JSON.stringify(marked))
  const stuck = partial.sql.prepare(`SELECT evidence_json FROM meta_shadow_decisions WHERE decision_id LIKE '%:stuck'`).all() as any[]
  assert.equal(stuck.length, 2)
  assert.ok(stuck.every((row) => row.evidence_json === '{}'), 'dates past the frontier stay pending')
})

test('terminal marks are capped per run and the backlog drains oldest first on later runs', async () => {
  const after = await fixture(true)
  for (let i = 0; i < META_SHADOW_COLD_MARK_LIMIT + 50; i++) {
    after.sql.prepare(`INSERT INTO meta_shadow_decisions(decision_id, policy_id, business_date, symbol, arm_id, evidence_json)
      VALUES(?,?,?,?,?,?)`).run(`2026-05-05:${9000 + i}:stuck`, 'NeuralUCB', '2026-05-05', String(9000 + i), 'tree_family', '{}')
  }
  const run = () => hydrateMatureMetaShadowDecisionRewards(after.learning,
    { endDate: BUSINESS_DATE, limit: 50000, nowIso: `${BUSINESS_DATE}T05:00:00.000Z`, coldEnv: after.env })
  const first = await run()
  assert.equal(first.cold_unavailable_decisions, META_SHADOW_COLD_MARK_LIMIT)
  const stuckMarked = (after.sql.prepare(`SELECT decision_id, instr(evidence_json, '"outcome_unavailable_after_cold_scan"') > 0 AS marked
    FROM meta_shadow_decisions WHERE decision_id LIKE '2026-05-05:%:stuck' ORDER BY decision_id`).all() as any[]).map((row) => Number(row.marked))
  const firstPending = stuckMarked.indexOf(0)
  assert.ok(firstPending >= 0 && stuckMarked.slice(firstPending).every((m) => m === 0), 'marked oldest first, in decision order')
  let total = first.cold_unavailable_decisions
  for (let night = 0; night < 3; night++) total += (await run()).cold_unavailable_decisions
  const pendingOld = after.sql.prepare(`SELECT COUNT(*) n FROM meta_shadow_decisions WHERE counterfactual_reward IS NULL
    AND business_date < ? AND instr(evidence_json, '"outcome_unavailable_after_cold_scan"') = 0`).get(CUTOFF) as { n: number }
  assert.equal(pendingOld.n, 0, 'later runs finish the backlog')
  assert.ok(total >= META_SHADOW_COLD_MARK_LIMIT + 50)
})

test('the drain keeps whole-history totals of the deleted rows for verify period=all', async () => {
  const before = await fixture(false)
  const deleted = before.sql.prepare('SELECT * FROM predictions WHERE prediction_date < ?').all(CUTOFF) as any[]
  const after = await fixture(true)
  const stats = new Map((after.sql.prepare('SELECT * FROM prediction_cold_stats_v1').all() as any[])
    .map((row) => [`${row.stock_id}|${row.model_name}`, row]))
  const groups = new Map<string, any[]>()
  for (const row of deleted) groups.set(`${row.stock_id}|${row.model_name}`, [...(groups.get(`${row.stock_id}|${row.model_name}`) ?? []), row])
  assert.equal(stats.size, groups.size)
  const close = (a: number | null, b: number | null) => a === b || (a != null && b != null && Math.abs(a - b) < 1e-12)
  const sum = (values: number[]) => values.length ? values.reduce((x, y) => x + y, 0) : null
  for (const [key, rows] of groups) {
    const s = stats.get(key)!
    const d = rows.filter((row) => row.direction_correct === 0 || row.direction_correct === 1)
    const t = rows.filter((row) => row.trade_pnl_pct != null)
    assert.equal(s.archived_rows, rows.length, key)
    assert.equal(s.d_total, d.length, key)
    assert.equal(s.d_correct, d.filter((row) => row.direction_correct === 1).length, key)
    assert.ok(close(s.d_err_sum, sum(d.filter((row) => row.price_error_pct != null).map((row) => row.price_error_pct))), key)
    assert.ok(close(s.d_gross_profit, d.length ? sum(d.map((row) => row.trade_pnl_pct > 0 ? row.trade_pnl_pct : 0)) : null), key)
    assert.equal(s.t_total, t.length, key)
    assert.ok(close(s.t_pnl_sum, sum(t.map((row) => row.trade_pnl_pct))), key)
    assert.equal(s.t_max, t.length ? Math.max(...t.map((row) => row.trade_pnl_pct)) : null, key)
    assert.equal(s.t_min, t.length ? Math.min(...t.map((row) => row.trade_pnl_pct)) : null, key)
    assert.ok(close(s.t_r_sum, sum(t.filter((row) => row.trade_pnl_r != null).map((row) => row.trade_pnl_r))), key)
  }
})

test('ml-controller adds the same cold-stats aggregates on the hot side', () => {
  const python = readFileSync('../ml-controller/services/retention_prediction_reads.py', 'utf8')
  const block = python.slice(python.indexOf('PREDICTION_COLD_STATS_EXPRESSIONS'))
  const listed = [...block.slice(0, block.indexOf('\n)\n')).matchAll(/\('(\w+)', '(\w+)', "?'?(.*?)'?"?\),$/gm)]
    .map((match) => [match[1], match[2], match[3].replace(/\\'/g, "'")])
  assert.deepEqual(listed, PREDICTION_COLD_STATS_COLUMNS.map((column) => [...column]))
  const migration = readFileSync('domain-migrations/learning/0073_prediction_cold_stats.sql', 'utf8')
  for (const [name] of PREDICTION_COLD_STATS_COLUMNS) assert.match(migration, new RegExp(`\\n  ${name} (INTEGER|REAL)`), name)
})
