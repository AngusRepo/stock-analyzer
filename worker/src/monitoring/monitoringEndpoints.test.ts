import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { STRATEGY_ROUTE_CHALLENGER_VERSION } from '../lib/strategyRouteCalibration'
import { CHAIN_ID, CHAIN_ROOT_STAGE } from './chain'
import { PROGRESS_SQL, PROGRESS_STAGES } from './chainSubStages'
import { MATERIALIZATION_SOURCES } from './dataReadiness'
import { FINLAB_STAGE_CARDS } from './judgment/finlabStageCards'
import { PIPELINE_STAGE_CARDS } from './judgment/pipelineStageCards'
import { createMonitoringHandler, ROUTES, SLOW_TTL_S, TIMELINE_TTL_S } from './index'
import { kvCache } from './kvCache'
import { day, finishedProgress, insertRows, midRunProgress, seedStageProgress, startFixture, tableScans, tempSorts, weekdays, type Fixture } from './monitoringFixture.testSupport'
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
/** Trading days of the 14 calendar days ending at X (10). The 14-day history is one state row per stage per day;
 * state and alerts read it too (ETA, failures_14d): all of it without the memo, X and X−1 only with it. */
const HISTORY_DATES = weekdays(X, 14).filter((date) => date >= day(X, -13))
const HISTORY_MAX_ROWS_READ = HISTORY_DATES.length * STAGES.length
/** Sub-stage progress for X and X−1: one primary-key seek per (date, stage), at most one row each. D1 bills the
 * index entry and the table row (measured: 10 rows → 22, 8 → 20, none → 4). */
const PROGRESS_MAX_ROWS_READ = 2 * 2 * PROGRESS_STAGES.length + 4
const FINLAB_CARDS = FINLAB_STAGE_CARDS.map((card) => card.id as string)
const PIPELINE_CARDS = PIPELINE_STAGE_CARDS.map((card) => card.id as string)
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

test('/v1/chain/state: X and X−1 by primary-key seek, DAG-annotated, sub-stage cards without a progress record', async () => {
  const body = await endpoint('/v1/chain/state', HISTORY_MAX_ROWS_READ + PROGRESS_MAX_ROWS_READ)
  assert.deepEqual([body.business_date, body.previous_business_date, body.active_business_date], [X, XPREV, X])
  // X has the FinLab parent only (3 cards); X−1 has both parents (9 cards).
  assert.equal(body.rows.length, X_ROWS.length + FINLAB_CARDS.length + STAGES.length + FINLAB_CARDS.length + PIPELINE_CARDS.length)
  assert.ok(body.rows.slice(0, X_ROWS.length + FINLAB_CARDS.length).every((row: any) => row.business_date === X && row.active), 'X first, DAG order')
  assert.equal(body.rows.filter((row: any) => !row.sub_stage).length, X_ROWS.length + STAGES.length)
  // No progress row at all: every card says so; a parent's success is never a card's.
  const cards = body.rows.filter((row: any) => row.sub_stage)
  assert.ok(cards.every((row: any) => row.status === 'pending' && row.started_at === null && row.completed_at === null && row.run_id === null))
  const finlabCards = cards.filter((row: any) => row.parent_stage_id === 'finlab-v4-backfill')
  assert.ok(finlabCards.every((row: any) => row.visual_status === 'waiting' && row.status_label === '無階段紀錄' && row.summary.startsWith('無階段紀錄')))
  const pipelineCards = cards.filter((row: any) => row.parent_stage_id === 'pipeline')
  assert.deepEqual(pipelineCards.map((row: any) => [row.business_date, row.stage_id, row.visual_status, row.summary]),
    PIPELINE_CARDS.map((id) => [XPREV, id, 'not_started', '本輪尚未開始']))
  const update = body.rows.find((row: any) => row.business_date === X && row.stage_id === 'update')
  assert.deepEqual([update.visual_status, update.phase, update.alerts], ['running', 'sources', ['stuck']])
  const failed = body.rows.find((row: any) => row.stage_id === 'finlab-v4-backfill' && row.business_date === X)
  assert.equal(failed.visual_status, 'blocked')
  assert.equal(body.current.find((c: any) => c.business_date === X).cue, 'Blocked here')
})

test('/v1/chain/alerts: failed / overdue / stuck / missed per the contract', async () => {
  const body = await endpoint('/v1/chain/alerts', HISTORY_MAX_ROWS_READ)
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
  const body = await endpoint('/v1/chain/alerts', HISTORY_MAX_ROWS_READ)
  assert.ok(body.rows.some((row: any) => row.stage_id === CHAIN_ROOT_STAGE && row.kind === 'missed' && row.business_date === X))
  await fx.raw.OPS_DB.prepare("UPDATE ops_chain_stage_state_v1 SET status = 'success' WHERE business_date = ? AND stage_id = ?").bind(X, CHAIN_ROOT_STAGE).run()
})

test('/v1/chain/timeline?days=14: primary-key range, 10 trading days of transitions', async () => {
  const body = await endpoint('/v1/chain/timeline?days=14', TIMELINE_MAX_ROWS_READ)
  assert.equal(body.from, day(X, -13))
  assert.equal(body.truncated, false)
  assert.ok(body.rows.length > 800 && body.rows.every((row: any) => row.time === row.transition_at))
})

test('/v1/chain/history?days=14: final state per stage per day, repeat failures; alerts carry failures_14d', async () => {
  const set = (sql: string, ...binds: unknown[]) => fx.raw.OPS_DB.prepare(sql).bind(...binds).run()
  await set("UPDATE ops_chain_stage_state_v1 SET status = 'error', error = 'FinLab margin dates missing' WHERE stage_id = 'finlab-v4-backfill' AND business_date IN (?, ?)",
    '2026-11-19', '2026-11-20')
  await set("UPDATE ops_chain_stage_state_v1 SET attempt = 2 WHERE stage_id = 'update' AND business_date = ?", '2026-11-18')
  try {
    const body = await endpoint('/v1/chain/history?days=14', HISTORY_MAX_ROWS_READ)
    assert.deepEqual([body.from, body.to, body.truncated], [day(X, -13), X, false])
    assert.equal(body.rows.length, (HISTORY_DATES.length - 1) * STAGES.length + X_ROWS.length)
    assert.deepEqual(body.rows.map((row: any) => row.business_date), [...body.rows.map((row: any) => row.business_date)].sort(), 'oldest first')
    const cell = (date: string, stage: string) => body.rows.find((row: any) => row.business_date === date && row.stage_id === stage)
    const retried = cell('2026-11-18', 'update')
    assert.deepEqual([retried.time, retried.status, retried.attempt, retried.result, retried.optional], ['2026-11-17T16:00:00.000Z', 'success', 2, 'retry_success', false])
    assert.equal(cell('2026-11-17', 'update').result, 'success')
    assert.deepEqual([cell(X, 'finlab-backfill-watchdog').optional, cell(X, 'finlab-backfill-watchdog').result], [true, 'error'])
    assert.deepEqual(body.repeat_failures.map((item: any) => [item.stage_id, item.failures, item.repeat, item.last_failed_date, item.dates]), [
      ['finlab-v4-backfill', 3, true, X, `2026-11-19,2026-11-20,${X}`],
      ['finlab-backfill-watchdog', 1, false, X, X],
    ])
    assert.equal(body.repeat_failures[0].last_error, 'FinLab margin dates missing')
    const alerts = await endpoint('/v1/chain/alerts', HISTORY_MAX_ROWS_READ)
    assert.deepEqual(Object.fromEntries(alerts.rows.map((row: any) => [`${row.stage_id}:${row.kind}`, row.failures_14d])), {
      'finlab-v4-backfill:failed': 3, 'finlab-backfill-watchdog:failed': 1, 'regime-compute:overdue': 0, 'update:stuck': 0,
    })
  } finally {
    await set("UPDATE ops_chain_stage_state_v1 SET status = 'success', error = NULL WHERE stage_id = 'finlab-v4-backfill' AND business_date IN (?, ?)", '2026-11-19', '2026-11-20')
    await set("UPDATE ops_chain_stage_state_v1 SET attempt = 1 WHERE stage_id = 'update' AND business_date = ?", '2026-11-18')
  }
})

test('/v1/chain/state: ETA from the typical finishing offset, at risk before the deadline passes, chain summary', async () => {
  const set = (sql: string, ...binds: unknown[]) => fx.raw.OPS_DB.prepare(sql).bind(...binds).run()
  // The seeded history finishes stage i at root start + floor(i / 4) h + (i % 4) × 15 min; verify-v2 (i = 13) at +195 min.
  await set("UPDATE ops_chain_stage_state_v1 SET started_at = '2026-11-24T06:00:00Z', completed_at = '2026-11-24T06:10:00Z' WHERE business_date = ? AND stage_id = ?", X, CHAIN_ROOT_STAGE)
  await set("UPDATE ops_chain_stage_state_v1 SET expected_by = '2026-11-24T09:00:00.000Z' WHERE business_date = ? AND stage_id = 'verify-v2'", X)
  try {
    // 14:30 TW: the chain started 30 minutes ago and no deadline has passed yet.
    const early = Date.parse('2026-11-24T06:30:00Z')
    const keys = await accessKeys()
    const handler = createMonitoringHandler({ now: () => early, fetch: keys.fetcher, cache: null, onQuery: (query) => queries.push(query) })
    const env = { ...fx.env, ACCESS_TEAM_DOMAIN: TEST_TEAM, ACCESS_AUD: TEST_AUD, MONITORING_READ_TOKEN: TEST_TOKEN }
    const body = await (await handler(new Request('https://monitoring.test/v1/chain/state', { headers: await accessHeaders(keys, early) }), env)).json() as any
    const eta = (stage: string, date = X) => {
      const row = body.rows.find((item: any) => item.business_date === date && item.stage_id === stage)
      return [row.typical_done_offset_min, row.eta, row.eta_margin_min, row.at_risk, row.alerts]
    }
    assert.deepEqual(eta('verify-v2'), [195, '2026-11-24T09:15:00.000Z', -15, true, []], 'typically done 15 minutes after its deadline: at risk, not overdue')
    assert.deepEqual(eta('update'), [45, '2026-11-24T06:45:00.000Z', 555, false, []])
    assert.deepEqual(eta('finlab-v4-backfill').slice(0, 4), [15, null, null, false], 'ended stages have no ETA')
    assert.deepEqual(eta('daily-report', XPREV).slice(0, 4), [270, null, null, false])
    const [today, previous] = body.current
    assert.deepEqual([today.business_date, today.required_total, today.required_done, today.failed, today.root_started_at, today.elapsed_min,
      today.worst_margin_min, today.worst_margin_stage], [X, X_ROWS.length - 1, 2, 2, '2026-11-24T06:00:00.000Z', 30, -15, 'verify-v2'])
    // X−1 ended: elapsed is root start to its last finish (i = 32: +8 h), not to now.
    assert.deepEqual([previous.business_date, previous.required_total, previous.required_done, previous.failed, previous.elapsed_min,
      previous.worst_margin_min, previous.worst_margin_stage], [XPREV, STAGES.length, STAGES.length, 0, 480, null, null])
  } finally {
    await set("UPDATE ops_chain_stage_state_v1 SET expected_by = '2026-11-24T16:00:00Z' WHERE business_date = ? AND stage_id = 'verify-v2'", X)
  }
  // 23:00 TW: a stage past its typical finishing time is expected no earlier than now.
  const late = (await call('/v1/chain/state')).body.rows.filter((row: any) => row.business_date === X)
  const at = (stage: string) => { const row = late.find((item: any) => item.stage_id === stage); return [row.eta, row.eta_margin_min, row.at_risk] }
  assert.deepEqual(at('regime-compute'), [new Date(NOW).toISOString(), -30, true], 'overdue implies at risk')
  assert.deepEqual(at('verify-v2'), [new Date(NOW).toISOString(), 60, false])
})

/** /v1/chain/state at another clock; `cache` keeps the memo across calls of one handler. */
async function stateAt(now: number, cache: unknown = null, path = '/v1/chain/state') {
  const keys = await accessKeys()
  const handler = createMonitoringHandler({ now: () => now, fetch: keys.fetcher, cache: cache as never, onQuery: (query) => queries.push(query) })
  const env = { ...fx.env, ACCESS_TEAM_DOMAIN: TEST_TEAM, ACCESS_AUD: TEST_AUD, MONITORING_READ_TOKEN: TEST_TOKEN }
  return await (await handler(new Request(`https://monitoring.test${path}`, { headers: await accessHeaders(keys, now) }), env)).json() as any
}

test('/v1/chain/state: the 9 sub-stage cards from pipeline_stage_runs, only for the run each parent names', async () => {
  const db = fx.raw.OPS_DB
  const set = (sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).run()
  const finlabRun = (date: string, run: string | null) => set("UPDATE ops_chain_stage_state_v1 SET run_id = ? WHERE business_date = ? AND stage_id = 'finlab-v4-backfill'", run, date)
  const cardsOf = (body: any, date: string, parent: string) => body.rows.filter((row: any) => row.business_date === date && row.parent_stage_id === parent)
  const counts = (body: any) => body.current.map((item: any) => [item.business_date, item.required_total, item.required_done, item.failed])
  // X mid-run: FinLab in its second phase, the pipeline (a running state row) in L2. X−1: a finished day.
  await set("UPDATE ops_chain_stage_state_v1 SET status = 'running', error = NULL, completed_at = NULL, started_at = '2026-11-24T14:35:00Z' WHERE business_date = ? AND stage_id = 'finlab-v4-backfill'", X)
  await insertRows(db, 'ops_chain_stage_state_v1', [{ business_date: X, chain_id: CHAIN_ID, stage_id: 'pipeline', status: 'running', attempt: 1,
    run_id: 'ticket-run', execution_name: 'pipeline-v2-exec', started_at: '2026-11-24T14:20:00Z', expected_by: '2026-11-25T00:00:00.000Z', updated_at: '2026-11-24T14:20:00Z' }])
  const withoutProgress = counts(await stateAt(NOW))
  try {
    await finlabRun(X, `finlab-${X}`)
    await finlabRun(XPREV, `finlab-${XPREV}`)
    await seedStageProgress(db, XPREV, finishedProgress(XPREV))
    await seedStageProgress(db, X, { ...midRunProgress(X, NOW),
      finlab: { runId: `finlab-${X}`, phases: ['completed', 'running'], startedAt: '2026-11-24T14:35:00.000Z' } })
    const start = queries.length
    const body = await stateAt(NOW)
    assert.ok(body.rows_read <= HISTORY_MAX_ROWS_READ + PROGRESS_MAX_ROWS_READ, `rows_read=${body.rows_read}`)
    measured['/v1/chain/state (18 cards, progress seeded)'] = body.rows_read

    // One primary-key seek per (date, stage): 4 progress rows a date here (index entry + table row each).
    const read = queries.slice(start).filter((query) => query.sql === PROGRESS_SQL)
    assert.deepEqual(read.map((query) => query.rowsRead), [20])
    const plan = (await db.prepare(`EXPLAIN QUERY PLAN ${PROGRESS_SQL}`).bind(X, XPREV).all<{ detail: string }>()).results.map((row) => row.detail)
    assert.deepEqual(plan, ['SEARCH pipeline_stage_runs USING INDEX sqlite_autoindex_pipeline_stage_runs_1 (business_date=? AND stage=?)'])

    const finlab = cardsOf(body, X, 'finlab-v4-backfill')
    assert.deepEqual(finlab.map((row: any) => [row.stage_id, row.status, row.visual_status, row.display_status, row.started_at, row.completed_at]), [
      ['finlab-acquire', 'success', 'completed', 'completed', '2026-11-24T14:35:00.000Z', '2026-11-24T14:45:00.000Z'],
      ['finlab-validate', 'running', 'running', 'running', '2026-11-24T14:45:00.000Z', null],
      ['finlab-publish', 'pending', 'waiting', 'waiting', null, null],
    ])
    assert.deepEqual(finlab.map((row: any) => [row.label, row.phase, row.run_id, row.summary]), [
      ['FinLab 資料取得', 'sources', `finlab-${X}`, '取得所需來源與必要格式整理'],
      ['FinLab 整理與驗證', 'sources', `finlab-${X}`, '跨資料集完整性驗證與推論輸入組合'],
      ['FinLab 發布與交接', 'sources', `finlab-${X}`, '等待前一階段完成'],
    ])
    const pipeline = cardsOf(body, X, 'pipeline')
    assert.deepEqual(pipeline.map((row: any) => [row.stage_id, row.visual_status, row.status, row.summary]), [
      ['pipeline-inputs', 'completed', 'success', '階段已完成'],
      ['pipeline-snapshot', 'completed', 'success', '階段已完成'],
      ['pipeline-feature-batches', 'completed', 'success', '階段已完成 · 特徵批次 8/8'],
      ['pipeline-features', 'completed', 'success', '階段已完成'],
      ['pipeline-l2', 'running', 'running', 'L2 時序特徵'],
      ['pipeline-l3', 'waiting', 'pending', '等待L2 特徵增強完成'],
    ])
    // The canonical run of pipeline_execution, not the ticket run the state row holds.
    assert.ok(pipeline.every((row: any) => row.run_id === `pipeline-${X}` && row.phase === 'models' && row.status_label))
    assert.ok(pipeline.slice(0, 4).every((row: any) => row.started_at && row.completed_at) && pipeline[4].started_at && pipeline[4].completed_at === null)
    assert.deepEqual([pipeline[5].started_at, pipeline[5].completed_at], [null, null])
    const done = [...cardsOf(body, XPREV, 'finlab-v4-backfill'), ...cardsOf(body, XPREV, 'pipeline')]
    assert.deepEqual(done.map((row: any) => row.stage_id), [...FINLAB_CARDS, ...PIPELINE_CARDS])
    assert.ok(done.every((row: any) => row.visual_status === 'completed' && row.status === 'success' && row.started_at && row.completed_at && !row.active))

    // Cards are display rows only: no deadline, alert or ETA; parents stay; the counts are the catalog stages'.
    const cards = body.rows.filter((row: any) => row.sub_stage)
    assert.equal(cards.length, 18)
    assert.ok(cards.every((row: any) => row.expected_by === null && row.alerts.length === 0 && row.eta === null && row.eta_margin_min === null
      && row.typical_done_offset_min === null && row.at_risk === false && row.display_position === row.position && row.position != null))
    assert.deepEqual(counts(body), withoutProgress)
    assert.deepEqual(counts(body), [[X, X_ROWS.length, 2, 1], [XPREV, STAGES.length, STAGES.length, 0]])
    const alerts = (await call('/v1/chain/alerts')).body.rows.map((row: any) => row.stage_id)
    assert.ok(!alerts.some((id: string) => FINLAB_CARDS.includes(id) || PIPELINE_CARDS.includes(id)))
    // display_position: the panel's order, cards in place of their parents, ml-predict nowhere.
    const day1 = body.rows.filter((row: any) => row.business_date === XPREV)
    for (const id of ['finlab-v4-backfill', 'pipeline', 'ml-predict']) {
      const parent = day1.find((row: any) => row.stage_id === id)
      assert.deepEqual([parent.sub_stage, parent.parent_stage_id, parent.display_position, parent.position], [false, null, null, null], id)
    }
    const shown = day1.filter((row: any) => row.display_position != null)
    assert.deepEqual(shown.map((row: any) => row.display_position), shown.map((_: unknown, index: number) => index))
    assert.equal(shown.length, STAGES.length - 3 + 9)
    assert.deepEqual(shown.slice(1, 4).map((row: any) => row.stage_id), FINLAB_CARDS)
    assert.ok(PIPELINE_CARDS.includes(body.current[0].stage_id) || FINLAB_CARDS.includes(body.current[0].stage_id) || STAGES.includes(body.current[0].stage_id))

    // With the memo, a poll past the route TTL reads X, X−1 and the progress rows.
    let clock = NOW
    const cache = fakeCache(() => clock)
    await stateAt(clock, cache)
    clock += (TIMELINE_TTL_S + 61) * 1000
    const warm = await stateAt(clock, cache)
    assert.ok(warm.rows_read <= STATE_MAX_ROWS_READ + PROGRESS_MAX_ROWS_READ, `warm=${warm.rows_read}`)
    measured['warm /v1/chain/state (18 cards, progress seeded)'] = warm.rows_read

    // Another run's progress is no record: FinLab by the state row's run_id, the pipeline by pipeline_execution's run.
    await finlabRun(X, 'another-run')
    await seedStageProgress(db, X, { ...midRunProgress(X, NOW), pipeline: { runId: `pipeline-${X}`, execution: { status: 'running' },
      progress: { runId: 'older-run', phase: 'node_l2_timesfm_enrich', status: 'running', done: ['node_load_inputs'], startedAt: '2026-11-24T14:20:00.000Z' } } })
    const other = await stateAt(NOW)
    assert.ok(cardsOf(other, X, 'finlab-v4-backfill').every((row: any) => row.status === 'pending' && row.status_label === '無階段紀錄' && row.run_id === null && row.started_at === null))
    assert.deepEqual(cardsOf(other, X, 'pipeline').map((row: any) => [row.visual_status, row.summary, row.run_id]), PIPELINE_CARDS.map(() => ['not_started', '本輪尚未開始', null]))
    // A dispatch attempt the state row names that is newer than the progress: the progress is a previous attempt's.
    await finlabRun(X, `finlab-${X}`)
    await set("UPDATE ops_chain_stage_state_v1 SET summary = 'triggered FinLab watchdog dispatch reservation run_id=r dispatch_attempt=2' WHERE business_date = ? AND stage_id = 'finlab-v4-backfill'", X)
    assert.ok(cardsOf(await stateAt(NOW), X, 'finlab-v4-backfill').every((row: any) => row.status_label === '無階段紀錄'))
    await set("UPDATE ops_chain_stage_state_v1 SET summary = NULL WHERE business_date = ? AND stage_id = 'finlab-v4-backfill'", X)

    // A failed parent: the card in flight failed itself (failed), the cards behind it never ran (blocked).
    await set("UPDATE ops_chain_stage_state_v1 SET status = 'error', error = 'pipeline_l2_failed' WHERE business_date = ? AND stage_id = 'pipeline'", X)
    await seedStageProgress(db, X, { ...midRunProgress(X, NOW), finlab: { runId: `finlab-${X}`, phases: ['completed', 'failed'], startedAt: '2026-11-24T14:35:00.000Z' } })
    const failed = await stateAt(NOW)
    assert.deepEqual(cardsOf(failed, X, 'finlab-v4-backfill').map((row: any) => [row.status, row.visual_status, row.display_status, row.completed_at]), [
      ['success', 'completed', 'completed', '2026-11-24T14:45:00.000Z'], ['error', 'blocked', 'failed', '2026-11-24T14:55:00.000Z'], ['pending', 'waiting', 'waiting', null]])
    assert.deepEqual(cardsOf(failed, X, 'pipeline').slice(4).map((row: any) => [row.stage_id, row.status, row.visual_status, row.display_status, row.error]), [
      ['pipeline-l2', 'error', 'blocked', 'failed', 'pipeline_l2_failed'], ['pipeline-l3', 'blocked', 'blocked', 'blocked', null]])
    assert.equal(failed.current[0].failed, 2, 'the pipeline row and the watchdog row; no card')
    await set("UPDATE ops_chain_stage_state_v1 SET status = 'running', error = NULL WHERE business_date = ? AND stage_id = 'pipeline'", X)

    // L3 sealed: pipeline_execution waits on awaiting_premarket. The state row stays running with its own summary.
    const sealedRun = { runId: `pipeline-${X}`, execution: { status: 'waiting' as const, lastError: 'awaiting_premarket' } }
    await seedStageProgress(db, X, { pipeline: { ...sealedRun, progress: { phase: 'awaiting_premarket', status: 'waiting',
      done: ['node_load_inputs', 'node_load_market_env', 'node_attach_serving_context', 'node_prepare_l2_inputs', 'node_build_payloads',
        'node_prepare_sequence_inputs', 'seal_l2_inputs', 'prepare_prediction_request', 'dispatch_prediction', 'modal_inference', 'node_l3_formal_predict', 'seal_l3_results'],
      startedAt: '2026-11-24T13:00:00.000Z' } } })
    const sealed = await stateAt(NOW)
    assert.deepEqual(cardsOf(sealed, X, 'pipeline').map((row: any) => [row.visual_status, row.summary]), [
      ['completed', '階段已完成'], ['noop', '本輪無子作業紀錄'], ['noop', '本輪無子作業紀錄'], ['completed', '階段已完成'], ['completed', '階段已完成'], ['completed', '階段已完成']])
    const parent = sealed.rows.find((row: any) => row.business_date === X && row.stage_id === 'pipeline')
    assert.deepEqual([parent.status, parent.summary, parent.run_id], ['running', null, 'ticket-run'])
    // The seal alone (no progress row) proves L3 and nothing else.
    await seedStageProgress(db, X, { pipeline: sealedRun })
    assert.deepEqual(cardsOf(await stateAt(NOW), X, 'pipeline').map((row: any) => row.visual_status),
      ['not_started', 'not_started', 'not_started', 'not_started', 'not_started', 'completed'])
  } finally {
    await seedStageProgress(db, X, {})
    await seedStageProgress(db, XPREV, {})
    await set("DELETE FROM ops_chain_stage_state_v1 WHERE business_date = ? AND stage_id = 'pipeline'", X)
    await set("UPDATE ops_chain_stage_state_v1 SET status = 'error', error = 'FinLab margin dates missing', run_id = NULL, summary = NULL, started_at = NULL, completed_at = '2026-11-24T07:00:00Z' WHERE business_date = ? AND stage_id = 'finlab-v4-backfill'", X)
    await finlabRun(XPREV, null)
  }
})

test('/v1/chain/state: active_business_date is X once it has rows, else the chain still in flight (X−1)', async () => {
  const flags = (body: any) => [body.business_date, body.active_business_date, body.current.map((item: any) => item.active),
    [...new Set(body.rows.map((row: any) => `${row.business_date}:${row.active}`))]]
  assert.deepEqual(flags(await stateAt(NOW)), [X, X, [true, false], [`${X}:true`, `${XPREV}:false`]])
  // 11/25 (Wed) 08:00 TW: X = 11/25 has no row until its 18:10 root; the chain in flight is 11/24's.
  assert.deepEqual(flags(await stateAt(Date.parse('2026-11-25T00:00:00Z'))), ['2026-11-25', X, [false, true], [`${X}:true`]])
  // Neither date has rows: X.
  assert.deepEqual(flags(await stateAt(NOW, null, '/v1/chain/state?date=2026-10-01')), ['2026-10-01', '2026-10-01', [true, false], []])
})

test('/v1/chain/state: display_status is failed > overdue > stuck > at risk, else the visual status', async () => {
  const set = (sql: string, ...binds: unknown[]) => fx.raw.OPS_DB.prepare(sql).bind(...binds).run()
  const expectedBy = (stage: string, at: string) => set('UPDATE ops_chain_stage_state_v1 SET expected_by = ? WHERE business_date = ? AND stage_id = ?', at, X, stage)
  const shown = (body: any, stage: string, date = X) => {
    const row = body.rows.find((item: any) => item.business_date === date && item.stage_id === stage)
    return [row.status, row.display_status, row.visual_status, row.alerts, row.at_risk]
  }
  await set("UPDATE ops_chain_stage_state_v1 SET started_at = '2026-11-24T06:00:00Z' WHERE business_date = ? AND stage_id = ?", X, CHAIN_ROOT_STAGE)
  await expectedBy('verify-v2', '2026-11-24T14:00:00.000Z')
  await expectedBy('regime-compute', '2026-11-24T07:00:00.000Z')
  try {
    const late = await stateAt(NOW) // 23:00 TW
    assert.deepEqual(shown(late, 'verify-v2'), ['running', 'overdue', 'running', ['overdue'], true], 'an overdue running row')
    assert.deepEqual(shown(late, 'finlab-v4-backfill'), ['error', 'failed', 'blocked', ['failed'], false])
    assert.deepEqual(shown(late, 'update'), ['running', 'stuck', 'running', ['stuck'], false])
    assert.deepEqual(shown(late, 'allocator-ev-readiness'), ['running', 'running', 'running', [], false])
    assert.deepEqual(shown(late, 'screener').slice(0, 2), ['skipped', late.rows.find((row: any) => row.business_date === X && row.stage_id === 'screener').visual_status])
    assert.deepEqual(shown(late, 'update', XPREV), ['success', 'completed', 'completed', [], false])
    // 14:30 TW: regime-compute has not started and typically ends at 15:15, after its 15:00 deadline.
    const early = await stateAt(Date.parse('2026-11-24T06:30:00Z'))
    assert.deepEqual(shown(early, 'regime-compute'), ['pending', 'at_risk', 'not_started', [], true], 'an at-risk pending row')
    assert.deepEqual(shown(early, 'verify-v2'), ['running', 'running', 'running', [], false])
  } finally {
    await expectedBy('verify-v2', '2026-11-24T16:00:00Z')
    await expectedBy('regime-compute', '2026-11-24T14:30:00Z')
  }
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
  const cold = { readiness: await get(readiness), timeline: await get('/v1/chain/timeline?days=14'), capacity: await get('/v1/capacity'),
    history: await get('/v1/chain/history?days=14') }
  expire(Math.max(SLOW_TTL_S, TIMELINE_TTL_S))
  const warm = { readiness: await get(readiness), timeline: await get('/v1/chain/timeline?days=14'), capacity: await get('/v1/capacity'),
    history: await get('/v1/chain/history?days=14'), state: await get('/v1/chain/state'), alerts: await get('/v1/chain/alerts') }

  // The three per-date counts and the breadth join are not repeated: 4 MAX(rowid) seeks instead.
  assert.ok(warm.readiness.rows_read < cold.readiness.rows_read - 12_000, `readiness cold=${cold.readiness.rows_read} warm=${warm.readiness.rows_read}`)
  assert.deepEqual([warm.readiness.checks, warm.readiness.rows], [cold.readiness.checks, cold.readiness.rows])
  // Only X and X−1 are read again (the fixture's X has no transitions yet).
  assert.ok(warm.timeline.rows_read <= 2 * STAGES.length * 3, `timeline cold=${cold.timeline.rows_read} warm=${warm.timeline.rows_read}`)
  assert.deepEqual(warm.timeline.rows, cold.timeline.rows)
  // History: the ended days come from the memo; state and alerts (ETA, failures_14d) read X and X−1 only.
  assert.ok(cold.history.rows_read > 8 * STAGES.length && cold.history.rows_read <= HISTORY_MAX_ROWS_READ, `history cold=${cold.history.rows_read}`)
  assert.ok(warm.history.rows_read <= STATE_MAX_ROWS_READ, `history warm=${warm.history.rows_read}`)
  assert.deepEqual([warm.history.rows, warm.history.repeat_failures], [cold.history.rows, cold.history.repeat_failures])
  assert.ok(warm.state.rows_read <= STATE_MAX_ROWS_READ + PROGRESS_MAX_ROWS_READ && warm.alerts.rows_read <= STATE_MAX_ROWS_READ,
    `state warm=${warm.state.rows_read} alerts warm=${warm.alerts.rows_read}`)
  assert.equal(warm.state.rows.find((row: any) => row.business_date === XPREV && row.stage_id === 'update').typical_done_offset_min, 45)
  assert.equal(warm.capacity.rows_read, 0)
  assert.deepEqual(warm.capacity.rows, cold.capacity.rows)
  measured['warm /v1/data-readiness'] = warm.readiness.rows_read
  measured['warm /v1/chain/timeline'] = warm.timeline.rows_read
  measured['cold /v1/chain/history (memo test)'] = cold.history.rows_read
  measured['warm /v1/chain/history'] = warm.history.rows_read
  measured['warm /v1/chain/state'] = warm.state.rows_read
  measured['warm /v1/chain/alerts'] = warm.alerts.rows_read

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

test('workers.dev cache (memory + KV): HIT within the TTL in another isolate, memo reused past it', async () => {
  let clock = NOW
  const store = new Map<string, string>()
  const kv = {
    get: async (key: string) => (store.has(key) ? JSON.parse(store.get(key)!) : null),
    put: async (key: string, value: string) => { store.set(key, value) },
  } as unknown as KVNamespace
  const keys = await accessKeys()
  const env = { ...fx.env, ACCESS_TEAM_DOMAIN: TEST_TEAM, ACCESS_AUD: TEST_AUD, MONITORING_READ_TOKEN: TEST_TOKEN }
  const isolate = () => createMonitoringHandler({ now: () => clock, fetch: keys.fetcher, cache: kvCache(kv, () => clock, new Map()) })
  const get = async (handler: ReturnType<typeof isolate>, path: string) => {
    const response = await handler(new Request(`https://stockvision-monitoring.test.workers.dev${path}`, { headers: await accessHeaders(keys, clock) }), env)
    return { cache: response.headers.get('x-monitoring-cache'), body: await response.json() as any }
  }
  const readiness = `/v1/data-readiness?date=${X}`
  const cold = await get(isolate(), readiness)
  assert.equal(cold.cache, 'MISS')
  const hit = await get(isolate(), readiness)
  assert.deepEqual([hit.cache, hit.body.generated_at], ['HIT', cold.body.generated_at])
  clock += (SLOW_TTL_S + 1) * 1000
  const warm = await get(isolate(), readiness)
  assert.equal(warm.cache, 'MISS')
  assert.ok(warm.body.rows_read < cold.body.rows_read - 12_000, `cold=${cold.body.rows_read} warm=${warm.body.rows_read}`)
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

test('the copied progress validators are the main Worker\'s', () => {
  const body = (path: string, name: string) => new RegExp(`export function ${name}\\([\\s\\S]*?\\n}\\n`).exec(readFileSync(new URL(path, import.meta.url), 'utf8'))?.[0]
  const copy = './judgment/stageProgress.ts'
  for (const [path, name] of [['../lib/finlabStageProgress.ts', 'validFinLabStageProgress'], ['../lib/pipelineProgress.ts', 'validPipelineProgress']]) {
    assert.ok(body(path, name), name)
    assert.equal(body(copy, name), body(path, name), name)
  }
})
