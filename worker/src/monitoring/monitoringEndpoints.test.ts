import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { STRATEGY_ROUTE_CHALLENGER_VERSION } from '../lib/strategyRouteCalibration'
import { CHAIN_ID, CHAIN_ROOT_STAGE } from './chain'
import { MATERIALIZATION_SOURCES } from './dataReadiness'
import { createMonitoringHandler, ROUTES, SLOW_TTL_S, TIMELINE_TTL_S } from './index'
import { day, insertRows, startFixture, tableScans, tempSorts, weekdays, type Fixture } from './monitoringFixture.testSupport'
import type { ExecutedQuery } from './readOnlyD1'
import { accessHeaders, accessKeys, fakeCache, TEST_AUD, TEST_TEAM, TEST_TOKEN } from './monitoringAuth.testSupport'

// 2026-11-24 (Tue) 23:00 TW. X = 11/24, X−1 = 11/23 (Mon).
const NOW = Date.parse('2026-11-24T15:00:00Z')
const X = '2026-11-24'
const XPREV = '2026-11-23'
/** P2's worker/src/lib/opsChainStageCatalog.ts (11/25): 33 stages per business date, 7 of them optional. */
const STAGES = ['market-close-refresh', 'finlab-v4-backfill', 'finlab-backfill-watchdog', 'update', 'indicator-queue', 'regime-compute',
  'strategy-learning-mature-evidence', 'screener', 'allocator-ev-readiness', 'pipeline', 'ml-predict', 'post-pipeline-chain',
  'allocator-ev-feature-snapshot-backfill', 'verify-v2', 'post-verify-chain', 'model-ic-rolling', 'linucb-reward-ledger', 'adapt',
  'daily-report', 'paper-active-postmarket', 'obsidian-sync', 'meta-learning-shadow', 'strategy-learning', 'evening-closure', 'us-leading',
  'news-analyst', 'morning-setup', 'recommendation', 'pre-market-warmup', 'premarket-evidence-watchdog', 'dataset-snapshot-export',
  'active8-oof-daily', 'allocator-ev-lifecycle-watchdog']
/** Full catalog for X and X−1. Section 5's ≤ 50 assumed 25 stages; with 33 the floor is 66 (reported to the owner). */
const STATE_MAX_ROWS_READ = 2 * STAGES.length
/** 10 trading days × 33 stages × 3 transitions; section 5's ≤ 750 assumed 25 stages (reported). */
const TIMELINE_MAX_ROWS_READ = 10 * STAGES.length * 3

let fx: Fixture
const queries: ExecutedQuery[] = []
let call: (path: string) => Promise<{ status: number; body: any; cache: string | null }>

async function sql(db: D1Database, statement: string) {
  await db.prepare(statement).run()
}

const DATES = weekdays(X, 12) // market history: 12 sessions
const datesValues = (dates: string[]) => dates.map((d) => `('${d}')`).join(',')

async function seedMarket(db: D1Database) {
  const stocks = `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 2346), d(dt) AS (VALUES ${datesValues(DATES)})`
  await sql(db, `${stocks} INSERT INTO stock_prices (stock_id, date, open, high, low, close, volume) SELECT i, dt, 10, 11, 9, 10, 1000 FROM s, d`)
  await sql(db, `${stocks} INSERT INTO technical_indicators (stock_id, date) SELECT i, dt FROM s, d`)
  await sql(db, `${stocks} INSERT INTO chip_data (symbol, date) SELECT printf('%04d', i), dt FROM s, d`)
  await sql(db, `${stocks} INSERT INTO canonical_market_daily (stock_id, date, source, lineage_json, as_of_date, market_segment, close, volume, value)
    SELECT printf('%04d', i), dt, 'finlab.price', '{}', dt, CASE WHEN i % 7 = 0 THEN 'EMERGING' ELSE 'LISTED_OTC' END, 10 + i % 5, 1000, 10000 FROM s, d`)
  const long = weekdays(X, 300)
  const longValues = `d(dt) AS (VALUES ${datesValues(long)})`
  await sql(db, `WITH sym(s) AS (VALUES ('TWII'),('TWOII'),('TW50'),('TWMC'),('TWEI'),('TWDP'),('TWHC')), ${longValues}
    INSERT INTO canonical_market_index_daily (symbol, date, source, lineage_json, as_of_date, close) SELECT s, dt, 'finlab', '{}', dt, 1 FROM sym, d`)
  await sql(db, `WITH sym(s) AS (VALUES ('TXF'),('MTX')), ses(x) AS (VALUES ('day'),('night')), cm(m) AS (VALUES ('202612'),('202701'),('202703')), ${longValues}
    INSERT INTO canonical_futures_daily (symbol, date, contract_month, session, source, lineage_json, as_of_date, close)
    SELECT s, dt, m, x, 'taifex', '{}', dt, 1 FROM sym, ses, cm, d`)
  await sql(db, `WITH seg(s) AS (VALUES ('TWSE'),('TPEX')), ${longValues}
    INSERT INTO canonical_market_summary_daily (date, market_segment, source, lineage_json, as_of_date, margin_balance_value, short_balance_units)
    SELECT dt, s, 'twse', '{}', dt, 1, 1 FROM seg, d`)
  await sql(db, `WITH seg(s) AS (VALUES ('TWSE'),('TPEX')), inv(v) AS (VALUES ('foreign'),('trust'),('dealer'),('total')), ${longValues}
    INSERT INTO canonical_institutional_amount_daily (date, market_segment, investor, source, lineage_json, as_of_date)
    SELECT dt, s, v, 'twse', '{}', dt FROM seg, inv, d`)
  await sql(db, `WITH ds(x) AS (VALUES ('tw_option_put_call_ratio'),('tw_taifex_futures_large_trader'),('tw_business_indicators'),('tw_other_context')),
    f(y) AS (VALUES ('a'),('b'),('c')), ${longValues}
    INSERT INTO canonical_regime_context_daily (date, dataset, field, category, source, lineage_json, as_of_date)
    SELECT dt, x, y, 'all', 'finlab', '{}', dt FROM ds, f, d`)
  // GDELT ~120 accepted items a day for 60 days, plus another source's 3,000 items.
  await sql(db, `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 7199)
    INSERT INTO external_evidence_items (source_id, source_kind, title, published_at, source_url, allowed_use, decision_effect,
      source_quality_score, entity_linking_confidence, accepted)
    SELECT 'gdelt_events', 'news', 't', strftime('%Y-%m-%dT%H:%M:%SZ', '${X}T12:00:00Z', printf('-%d minutes', i * 12)), 'u', 'context', 'none', 1, 1,
           CASE WHEN i % 10 = 0 THEN 0 ELSE 1 END FROM n`)
  // Another source, accepted and newer than GDELT's newest item (12:00): the GDELT reads must seek
  // source_id, not walk the accepted index across every source.
  await sql(db, `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 4999)
    INSERT INTO external_evidence_items (source_id, source_kind, title, published_at, source_url, allowed_use, decision_effect,
      source_quality_score, entity_linking_confidence, accepted)
    SELECT 'cnyes_news', 'news', 't', strftime('%Y-%m-%dT%H:%M:%SZ', '${X}T23:59:00Z', printf('-%d minutes', i * 3)), 'u', 'context', 'none', 1, 1, 1 FROM n`)
  await sql(db, `WITH src(s) AS (VALUES ('gdelt_events'),('finlab')), ds(x) AS (VALUES ('global_event_pressure'),('tone')), ${longValues}
    INSERT INTO source_quality_metrics (source, dataset, as_of_date, freshness_status, metrics_json) SELECT s, x, dt, 'fresh', '{}' FROM src, ds, d`)
}

async function seedChain(db: D1Database) {
  const state: Record<string, unknown>[] = []
  const transitions: Record<string, unknown>[] = []
  for (const date of weekdays(XPREV, 25)) {
    STAGES.forEach((stage, index) => {
      const at = `${date}T${String(6 + Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}:00Z`
      state.push({ business_date: date, chain_id: CHAIN_ID, stage_id: stage, status: 'success', attempt: 1, started_at: at, completed_at: at,
        expected_by: `${date}T23:00:00Z`, updated_at: at })
      for (const [offset, to, from] of [[0, 'pending', null], [1, 'running', 'pending'], [2, 'success', 'running']] as const) {
        transitions.push({ business_date: date, chain_id: CHAIN_ID, stage_id: stage, transition_at: at.replace(':00Z', `:0${offset}Z`), to_status: to, from_status: from, attempt: 1 })
      }
    })
  }
  await insertRows(db, 'ops_chain_stage_state_v1', state)
  await insertRows(db, 'ops_chain_stage_transitions_v1', transitions)
}

/** X (11/24): the evening chain in flight, one row per alert rule. */
const X_ROWS: Record<string, unknown>[] = [
  { stage_id: CHAIN_ROOT_STAGE, status: 'success', started_at: '2026-11-24T06:00:00Z', completed_at: '2026-11-24T06:10:00Z', expected_by: '2026-11-24T06:30:00Z' },
  { stage_id: 'finlab-v4-backfill', status: 'error', error: 'FinLab margin dates missing', completed_at: '2026-11-24T07:00:00Z', expected_by: '2026-11-24T16:00:00Z' },
  { stage_id: 'finlab-backfill-watchdog', status: 'error', optional: 1, error: 'watchdog failed', expected_by: '2026-11-24T08:00:00Z' },
  { stage_id: 'update', status: 'running', started_at: '2026-11-24T14:00:00Z', heartbeat_at: '2026-11-24T14:40:00Z', expected_by: '2026-11-24T16:00:00Z' },
  { stage_id: 'indicator-queue', status: 'running', started_at: '2026-11-24T14:00:00Z', execution_name: 'pipeline-v2-abc', expected_by: '2026-11-24T16:00:00Z' },
  { stage_id: 'regime-compute', status: 'pending', expected_by: '2026-11-24T14:30:00Z' },
  { stage_id: 'screener', status: 'skipped', expected_by: '2026-11-24T14:30:00Z' },
  { stage_id: 'allocator-ev-readiness', status: 'running', started_at: '2026-11-24T14:50:00Z', heartbeat_at: '2026-11-24T14:55:00Z', expected_by: '2026-11-24T16:00:00Z' },
  // Writes running once and never heartbeats (contract 11/25): not stuck, overdue only after expected_by.
  { stage_id: 'verify-v2', status: 'running', started_at: '2026-11-24T12:00:00Z', expected_by: '2026-11-24T16:00:00Z' },
]

before(async () => {
  fx = await startFixture()
  await seedMarket(fx.raw.MARKET_DB)
  await seedChain(fx.raw.OPS_DB)
  await insertRows(fx.raw.OPS_DB, 'ops_chain_stage_state_v1', X_ROWS.map((row) => ({ business_date: X, chain_id: CHAIN_ID, attempt: 1, updated_at: '2026-11-24T14:00:00Z', ...row })))
  await insertRows(fx.raw.OPS_DB, 'storage_capacity_daily', Array.from({ length: 60 }, (_, i) => day(X, -i - 1)).flatMap((date, i) =>
    ['DB', 'CORE_DB', 'MARKET_DB', 'LEARNING_DB', 'OPS_DB', 'EXECUTION_DB', 'PAPER_DB', 'RESEARCH_DB'].map((binding) => ({
      observed_date: date, domain: binding.replace('_DB', '').toLowerCase(), binding_name: binding, used_bytes: 4e9 - i * 1e7, max_bytes: 1e10,
      utilization_pct: 40, status: 'healthy', measurement_source: 'd1_result_meta_size_after', observed_at: `${date} 01:00:00`,
    }))))
  // Shadow A: the newest 3 dates hold only challenger runs, so the prior cohort needs the date walk.
  await insertRows(fx.raw.LEARNING_DB, 'strategy_route_calibration_runs_v1', weekdays(X, 250).flatMap((date, i) => [
    { run_id: `c-${date}`, artifact_version: 'a', as_of_date: date, status: 'pending_maturity', candidate_route_version: STRATEGY_ROUTE_CHALLENGER_VERSION,
      sample_count: 10, date_count: 5, paired_sample_count: 0, created_at: `${date}T10:00:00Z`, gate_json: '{}' },
    ...(i < 3 ? [] : [{ run_id: `p-${date}`, artifact_version: 'a', as_of_date: date, status: 'pass', candidate_route_version: 'older-route-v1',
      sample_count: 40, date_count: 20, paired_sample_count: 30, created_at: `${date}T09:00:00Z`, gate_json: '{}' }]),
  ]))
  await insertRows(fx.raw.LEARNING_DB, 'rfs_sparse_comparisons_v1', weekdays(X, 200).map((date) => ({
    plan_id: `plan-${date}`, schema_version: 'rfs-b-sparse-comparison-v1', signal_date: date, policy_identity: 'p', allocation_snapshot_id: 's',
    observed_at: `${date}T12:00:00Z`, status: 'collecting', packet_checksum: 'a'.repeat(64),
    payload_json: JSON.stringify({ model_checksum: 'm', validation_blockers: [], source_expected_return_candidate_count: 12 }),
  })))
  await insertRows(fx.raw.PAPER_DB, 'l4_portfolio_head_v1', [{ account_id: 1, plan_id: null }])
  await insertRows(fx.raw.PAPER_DB, 'paper_order_intents', weekdays(X, 120).flatMap((date) => Array.from({ length: 25 }, (_, i) => ({
    account_id: 1, trade_date: date, symbol: String(1000 + i), side: i % 2 ? 'buy' : 'sell', source: 'l4',
  }))))

  const keys = await accessKeys()
  const fetcher = keys.fetcher
  const handler = createMonitoringHandler({ now: () => NOW, fetch: fetcher, cache: null, onQuery: (query) => queries.push(query) })
  const env = { ...fx.env, ACCESS_TEAM_DOMAIN: TEST_TEAM, ACCESS_AUD: TEST_AUD, MONITORING_READ_TOKEN: TEST_TOKEN }
  call = async (path) => {
    const response = await handler(new Request(`https://monitoring.test${path}`, { headers: await accessHeaders(keys, NOW) }), env)
    return { status: response.status, body: await response.json(), cache: response.headers.get('x-monitoring-cache') }
  }
})

after(async () => { await fx?.mf.dispose() })

const measured: Record<string, number> = {}
async function endpoint(path: string, maxRowsRead: number) {
  const start = queries.length
  const result = await call(path)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(typeof result.body.generated_at, 'string')
  assert.equal(result.body.rows_read, queries.slice(start).reduce((sum, q) => sum + q.rowsRead, 0), 'rows_read is the sum of D1 meta.rows_read')
  assert.ok(result.body.rows_read <= maxRowsRead, `${path} rows_read=${result.body.rows_read} > ${maxRowsRead}`)
  assert.ok(Array.isArray(result.body.rows), 'Infinity/JSONata root array')
  measured[path] = result.body.rows_read
  return result.body
}

test('/v1/chain/state: X and X−1 by primary-key seek, 2 × catalog rows, DAG-annotated', async () => {
  const body = await endpoint('/v1/chain/state', STATE_MAX_ROWS_READ)
  assert.deepEqual([body.business_date, body.previous_business_date], [X, XPREV])
  assert.equal(body.rows.length, X_ROWS.length + STAGES.length)
  assert.ok(body.rows.slice(0, X_ROWS.length).every((row: any) => row.business_date === X), 'X first, DAG order')
  const update = body.rows.find((row: any) => row.business_date === X && row.stage_id === 'update')
  assert.deepEqual([update.visual_status, update.phase, update.alerts], ['running', 'sources', ['stuck']])
  const failed = body.rows.find((row: any) => row.stage_id === 'finlab-v4-backfill' && row.business_date === X)
  assert.equal(failed.visual_status, 'blocked')
  assert.equal(body.current.find((c: any) => c.business_date === X).cue, 'Blocked here')
})

test('/v1/chain/alerts: failed / overdue / stuck / missed per the contract', async () => {
  const body = await endpoint('/v1/chain/alerts', STATE_MAX_ROWS_READ)
  const got = body.rows.map((row: any) => `${row.stage_id}:${row.kind}`).sort()
  assert.deepEqual(got, [
    'finlab-v4-backfill:failed', // error, deadline not passed yet
    'finlab-backfill-watchdog:failed', // optional: failure only, never overdue
    'regime-compute:overdue', // pending past expected_by
    'update:stuck', // heartbeat 20 min old; verify-v2 runs 3 h without a heartbeat: not stuck
  ].sort())
  assert.deepEqual(body.counts, { total: 4, failed: 2, overdue: 1, stuck: 1, missed: 0 })
  // indicator-queue runs on Cloud Run (execution_name): GCP alerting owns its liveness.
  assert.ok(!got.some((item: string) => item.startsWith('indicator-queue')))
})

test('/v1/chain/alerts: missed root, chain absent after the configured deadline', async () => {
  await fx.raw.OPS_DB.prepare("UPDATE ops_chain_stage_state_v1 SET status = 'pending', started_at = NULL, completed_at = NULL WHERE business_date = ? AND stage_id = ?")
    .bind(X, CHAIN_ROOT_STAGE).run()
  const body = await endpoint('/v1/chain/alerts', STATE_MAX_ROWS_READ)
  assert.ok(body.rows.some((row: any) => row.stage_id === CHAIN_ROOT_STAGE && row.kind === 'missed' && row.business_date === X))
  await fx.raw.OPS_DB.prepare("UPDATE ops_chain_stage_state_v1 SET status = 'success' WHERE business_date = ? AND stage_id = ?").bind(X, CHAIN_ROOT_STAGE).run()
})

test('/v1/chain/timeline?days=14: primary-key range, 10 trading days of transitions', async () => {
  const body = await endpoint('/v1/chain/timeline?days=14', TIMELINE_MAX_ROWS_READ)
  assert.equal(body.from, day(X, -13))
  assert.equal(body.truncated, false)
  assert.ok(body.rows.length > 800 && body.rows.every((row: any) => row.time === row.transition_at))
})

test('/v1/data-readiness: index seeks only, ≤ 20k rows on 2,346-stock sessions', async () => {
  const body = await endpoint(`/v1/data-readiness?date=${X}`, 20_000)
  assert.equal(body.target_date, X)
  const checks = Object.fromEntries(body.checks.map((check: any) => [check.id, check]))
  assert.deepEqual([checks.price_freshness.status, checks.price_freshness.rows_on_latest, checks.price_freshness.latest_date], ['ok', 2346, X])
  assert.equal(checks.chip_freshness.rows_on_latest, 2346)
  const gates = Object.fromEntries(body.rows.map((row: any) => [row.id, row]))
  assert.deepEqual(Object.keys(gates), MATERIALIZATION_SOURCES.map((source) => source.key))
  assert.equal(gates.twii_index.status, 'ready')
  assert.equal(gates.twoii_index.value, '1 rows')
  assert.equal(gates.txf_day_futures.value, '3 rows', 'TXF day session, three contract months')
  assert.equal(gates.market_breadth.value, `${(2346 - Math.floor(2346 / 7)).toLocaleString('en-US')} rows`, 'LISTED_OTC with a previous close')
  assert.equal(gates.put_call_ratio.value, '3 rows')
  assert.equal(gates.gdelt_global_news.status, 'ready')
  const gdelt = queries.slice(-60).filter((q) => q.sql.includes('FROM external_evidence_items'))
  assert.equal(gdelt.length, 2)
  const gdelt14d = Math.ceil((14 * 24 * 60 + 12 * 60) / 12) + 2 // GDELT items since target−14d (one per 12 min) + range end; other sources add 5,000
  for (const q of gdelt) assert.ok(q.rowsRead <= gdelt14d, `GDELT read crossed sources: rows_read=${q.rowsRead} :: ${q.sql}`)
})

test('/v1/capacity: SELECT 1 per binding plus 45 days of history', async () => {
  const body = await endpoint('/v1/capacity', 1_000)
  assert.equal(body.rows.length, 8)
  const ops = body.rows.find((row: any) => row.binding_name === 'OPS_DB')
  assert.equal(ops.forecast_status, 'ready')
  assert.ok(ops.observation_count >= 40)
})

test('/v1/evidence-clocks: shadow A walks dates by index; RFS totals are not served', async () => {
  const body = await endpoint('/v1/evidence-clocks', 5_000)
  const clocks = Object.fromEntries(body.rows.map((row: any) => [row.mechanism, row]))
  assert.equal(clocks.shadow_a.status, 'pending_maturity')
  assert.equal(body.details.shadow_a.prior_cohort.candidate_route_version, 'older-route-v1', 'found by the date walk')
  assert.equal(clocks.rfs_allocator.latest_evidence_date, X)
  assert.deepEqual(body.details.rfs_allocator.not_served, ['cohort_totals', 'matured_outcomes'])
  assert.equal(clocks.execution_parity.status, 'not_applicable_no_real_intents')
})

test('/v1/trading-day and holiday gating: a typhoon closure is not a trading day and raises no alerts', async () => {
  assert.deepEqual((await call(`/v1/trading-day?date=${X}`)).body.trading, true)
  assert.equal((await call('/v1/trading-day?date=2026-11-22')).body.trading, false, 'Sunday')
  // X−1's daily-report still pending, due 11/24 15:00 TW (on X, the next trading day at pre-creation).
  await fx.raw.OPS_DB.prepare("UPDATE ops_chain_stage_state_v1 SET status = 'pending', expected_by = ? WHERE business_date = ? AND stage_id = 'daily-report'")
    .bind('2026-11-24T07:00:00.000Z', XPREV).run()
  const overdue = (await call('/v1/chain/alerts')).body.rows.filter((row: any) => row.business_date === XPREV)
  assert.deepEqual(overdue.map((row: any) => `${row.stage_id}:${row.kind}`), ['daily-report:overdue'])
  await fx.kv.put(`holiday:${X}`, JSON.stringify({ source: 'twse_adhoc', title: '颱風停止上班上課', feed: 'twse.openapi.newsList' }))
  try {
    const typhoon = await call(`/v1/trading-day?date=${X}`)
    assert.deepEqual([typhoon.status, typhoon.body.trading], [200, false])
    // Default X falls back to the last trading day; the closure date's own rows raise nothing.
    const state = await call('/v1/chain/state')
    assert.deepEqual([state.body.business_date, state.body.x_trading_day], [XPREV, true])
    const alerts = await call(`/v1/chain/alerts?date=${X}`)
    assert.equal(alerts.body.x_trading_day, false)
    assert.deepEqual(alerts.body.rows.filter((row: any) => row.business_date === X), [], 'holiday rows raise no alerts')
    const defaults = await call('/v1/chain/alerts')
    assert.deepEqual(defaults.body.rows, [], 'X−2 complete; X−1 deadline fell on the closure date (stale until P2 rewrites it)')
  } finally {
    await fx.kv.delete(`holiday:${X}`)
    await fx.raw.OPS_DB.prepare("UPDATE ops_chain_stage_state_v1 SET status = 'success' WHERE business_date = ? AND stage_id = 'daily-report'").bind(XPREV).run()
  }
})

test('/v1/chain/alerts: a trading day with no chain row after 18:30 TW is missed (market-close-refresh never ran)', async () => {
  const keys = await accessKeys()
  const base = { ...fx.env, ACCESS_TEAM_DOMAIN: TEST_TEAM, ACCESS_AUD: TEST_AUD, MONITORING_READ_TOKEN: TEST_TOKEN }
  const get = async (now: number, env: object, date: string) => {
    const handler = createMonitoringHandler({ now: () => now, fetch: keys.fetcher, cache: null })
    const response = await handler(new Request(`https://monitoring.test/v1/chain/alerts?date=${date}`, { headers: await accessHeaders(keys, now) }), env as never)
    return ((await response.json()) as any).rows.map((row: any) => [row.business_date, row.stage_id, row.kind, row.status])
  }
  // Before the seeded chain history: 10/01 (Thu) and its X−1 09/30 have no rows.
  const at1800 = Date.parse('2026-10-01T10:00:00Z') // 18:00 TW
  assert.deepEqual(await get(at1800, base, '2026-10-01'), [['2026-09-30', CHAIN_ROOT_STAGE, 'missed', 'absent']], 'X before 18:30: only X−1')
  assert.deepEqual(await get(at1800 + 31 * 60_000, base, '2026-10-01'), [
    ['2026-10-01', CHAIN_ROOT_STAGE, 'missed', 'absent'], ['2026-09-30', CHAIN_ROOT_STAGE, 'missed', 'absent']])
  assert.equal((await get(at1800, { ...base, CHAIN_ROOT_EXPECTED_BY_TW: '17:00' }, '2026-10-01')).length, 2, 'override')
  assert.deepEqual(await get(NOW, base, '2026-10-03'), [['2026-10-02', CHAIN_ROOT_STAGE, 'missed', 'absent']], 'Saturday itself: no alert')
  assert.deepEqual(await get(NOW, base, X), (await get(NOW, base, X)).filter((row: any[]) => row[3] !== 'absent'), 'rows present: no absent alert')
})

test('memo: a poll past the route TTL re-reads only what changed (counts, timeline history, capacity history)', async () => {
  let clock = NOW
  const keys = await accessKeys()
  const handler = createMonitoringHandler({ now: () => clock, fetch: keys.fetcher, cache: fakeCache(() => clock) as never, onQuery: (query) => queries.push(query) })
  const env = { ...fx.env, ACCESS_TEAM_DOMAIN: TEST_TEAM, ACCESS_AUD: TEST_AUD, MONITORING_READ_TOKEN: TEST_TOKEN }
  const get = async (path: string) => {
    const response = await handler(new Request(`https://monitoring.test${path}`, { headers: await accessHeaders(keys, clock) }), env)
    assert.equal(response.headers.get('x-monitoring-cache'), 'MISS', path)
    return await response.json() as any
  }
  const expire = (ttl: number) => { clock += (ttl + 1) * 1000 }
  const readiness = `/v1/data-readiness?date=${X}`
  const cold = { readiness: await get(readiness), timeline: await get('/v1/chain/timeline?days=14'), capacity: await get('/v1/capacity') }
  expire(Math.max(SLOW_TTL_S, TIMELINE_TTL_S))
  const warm = { readiness: await get(readiness), timeline: await get('/v1/chain/timeline?days=14'), capacity: await get('/v1/capacity') }

  // The three per-date counts and the breadth join are not repeated: 4 MAX(rowid) seeks instead.
  assert.ok(warm.readiness.rows_read < cold.readiness.rows_read - 12_000, `readiness cold=${cold.readiness.rows_read} warm=${warm.readiness.rows_read}`)
  assert.deepEqual([warm.readiness.checks, warm.readiness.rows], [cold.readiness.checks, cold.readiness.rows])
  // Only X and X−1 are read again (the fixture's X has no transitions yet).
  assert.ok(warm.timeline.rows_read <= 2 * STAGES.length * 3, `timeline cold=${cold.timeline.rows_read} warm=${warm.timeline.rows_read}`)
  assert.deepEqual(warm.timeline.rows, cold.timeline.rows)
  assert.equal(warm.capacity.rows_read, 0)
  assert.deepEqual(warm.capacity.rows, cold.capacity.rows)
  measured['warm /v1/data-readiness'] = warm.readiness.rows_read
  measured['warm /v1/chain/timeline'] = warm.timeline.rows_read

  // One inserted price row: stock_prices is counted again, the other three are not.
  const price = (body: any) => body.checks.find((check: any) => check.id === 'price_freshness').rows_on_latest
  await fx.raw.MARKET_DB.prepare('INSERT INTO stock_prices (stock_id, date, open, high, low, close, volume) VALUES (999999, ?, 10, 11, 9, 10, 1000)').bind(X).run()
  try {
    expire(SLOW_TTL_S)
    const inserted = await get(readiness)
    assert.equal(price(inserted), price(cold.readiness) + 1)
    assert.ok(inserted.rows_read >= 2347 && inserted.rows_read <= warm.readiness.rows_read + 2347,
      `inserted=${inserted.rows_read} warm=${warm.readiness.rows_read}`)
  } finally {
    await fx.raw.MARKET_DB.prepare('DELETE FROM stock_prices WHERE stock_id = 999999').run()
  }
})

test('every query the endpoints ran is read-only and EXPLAINs without a table SCAN', async () => {
  assert.ok(queries.length > 40, `queries=${queries.length}`)
  const seen = new Set<string>()
  for (const query of queries) {
    const key = `${query.db}|${query.sql}`
    if (seen.has(key)) continue
    seen.add(key)
    assert.deepEqual(await tableScans(fx.raw[query.db], query), [], `${query.db}: ${query.sql.replace(/\s+/g, ' ').slice(0, 160)}`)
    const sorts = await tempSorts(fx.raw[query.db], query)
    // A temp B-tree bills every sorted row twice; the one left is the RFS latest-observed_at tie-break (a handful of rows).
    if (!/FROM rfs_sparse_comparisons_v1/.test(query.sql)) assert.deepEqual(sorts, [], `temp sort: ${query.sql.replace(/\s+/g, ' ').slice(0, 160)}`)
  }
  // Every route was exercised.
  for (const path of Object.keys(ROUTES)) assert.ok(path === '/v1/trading-day' || measured[path] != null || measured[`${path}?days=14`] != null
    || Object.keys(measured).some((key) => key.startsWith(path)), path)
  console.log('monitoring rows_read', JSON.stringify(measured))
})

test('materialization lag thresholds match buildDataQualityReport', () => {
  const source = readFileSync(new URL('../lib/dataQualityMonitor.ts', import.meta.url), 'utf8')
  for (const item of MATERIALIZATION_SOURCES) {
    const block = new RegExp(`key: '${item.key}',[\\s\\S]*?scope: '([^']*)'`).exec(source)
    assert.ok(block, item.key)
    const text = block[0]
    assert.match(text, new RegExp(`label: '${item.label}'`))
    assert.match(text, new RegExp(`warnLagDays: ${item.warnLagDays},`))
    assert.match(text, new RegExp(`failLagDays: ${item.failLagDays},`))
    assert.equal(block[1], item.scope)
    assert.equal(/required: false/.test(text), item.required === false, item.key)
  }
})
