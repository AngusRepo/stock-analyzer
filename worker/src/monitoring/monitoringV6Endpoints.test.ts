import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createMonitoringHandler, OPB_TTL_S, SLOW_TTL_S, V6_ROUTES } from './index'
import { day, domainDdl, insertRows, startFixture, tableScans, tempSorts, weekdays, type Fixture } from './monitoringFixture.testSupport'
import type { ExecutedQuery } from './readOnlyD1'
import { SERVING_STATE_KEY } from './modelOps'
import { EXPECTED_RETURN_SERVING_STATE_KEY } from '../lib/expectedReturnServingState'
import { accessHeaders, accessKeys, TEST_AUD, TEST_TEAM, TEST_TOKEN } from './monitoringAuth.testSupport'

// 2026-11-26 (Thu) 16:00 TW: after the 14:30 daily closure; today's plan was sealed at 07:29.
const NOW = Date.parse('2026-11-26T08:00:00Z')
const X = '2026-11-26'
const TABLES: Record<string, { binding: string; tables: string[] }> = {
  paper: { binding: 'PAPER_DB', tables: ['paper_daily_plan_reviews_v1', 'paper_daily_plan_heads_v1'] },
  learning: { binding: 'LEARNING_DB', tables: ['active8_ensemble_artifacts_v1', 'active8_ensemble_pointer_v1', 'predictions', 'model_champion_history',
    'l4_opb_arm_replay_v1', 'expected_return_forward_guard_state', 'expected_return_serving_forward_evaluations'] },
  ops: { binding: 'OPS_DB', tables: ['scheduler_execution_tickets_v1'] },
}
const R33 = ['LightGBM', 'ExtraTrees', 'TabM', 'GNN']
const hex = (seed: string) => seed.repeat(64).slice(0, 64)
/** 2026-11-20 (Fri): no plan sealed, no predictions for TabM. */
const GAP = '2026-11-20'

let fx: Fixture
const queries: ExecutedQuery[] = []
let call: (path: string, nowMs?: number) => Promise<{ status: number; body: any }>

async function seedRoster(db: D1Database) {
  const payload = JSON.stringify({ model_order: R33, payload_checksum: hex('c'), validation: { decision: 'PASS' }, cohort_id: 'core4' })
  await insertRows(db, 'active8_ensemble_artifacts_v1', [{ artifact_id: 'ens-nov', cohort_id: 'core4', training_run_id: 'run-nov',
    knowledge_cutoff_date: '2026-10-29', schema_version: 'active8-oof-ensemble-serving-artifact-v1', payload_json: payload, payload_checksum: hex('c'),
    base_artifact_set_checksum: hex('d'), validation_decision: 'PASS', validation_json: '{}', archive_uri: 'gs://y', state: 'production', production_effect: 1 }])
  await insertRows(db, 'active8_ensemble_pointer_v1', [{ singleton_id: 1, artifact_id: 'ens-nov', cohort_id: 'core4', payload_checksum: hex('c'),
    base_artifact_set_checksum: hex('d'), promoted_at: '2026-11-24 10:55:24', promotion_reason: 'r33_cutover' }])
}

async function seedSeal(db: D1Database) {
  // 300 trading days of seals (only the 14-day window is read), none on GAP; X−2 revised once; account 2 ignored.
  const dates = weekdays(X, 300).filter((date) => date !== GAP)
  const review = (account: number, date: string, revision: number, at: string) => ({ account_id: account, trade_date: date, checksum: hex(String(revision)) + date,
    plan_id: `plan-${date}`, previous_hash: revision ? hex('0') + date : null, revision, payload_json: '{}', created_at: at })
  const sealedAt = (date: string) => `${day(date, -1)} 23:29:15`
  await insertRows(db, 'paper_daily_plan_reviews_v1', [...dates.map((date) => review(1, date, 0, sealedAt(date))),
    review(1, day(X, -2), 1, `${day(X, -2)} 00:40:00`), review(2, GAP, 0, sealedAt(GAP))])
  await insertRows(db, 'paper_daily_plan_heads_v1', [...dates.map((date) => ({ account_id: 1, trade_date: date, plan_id: `plan-${date}`,
    checksum: hex(date === day(X, -2) ? '1' : '0') + date })), { account_id: 2, trade_date: GAP, plan_id: `plan-${GAP}`, checksum: hex('0') + GAP }])
}

const ARMS = ['base', 'diversified_alpha', 'liquidity_diversified']
async function seedLedger(paper: D1Database, learning: D1Database) {
  // The context changed on 11/24 (new L3 identity): the newest plans' context has no replay yet.
  const plans = weekdays(day(X, -1), 60)
  await insertRows(paper, 'l4_portfolio_plans_v1', plans.map((date) => ({ plan_id: `p-${date}`, account_id: 1, signal_date: date, policy_identity: 'p',
    activated: 1, allocation_snapshot_id: 's', created_at: `${date} 23:28:00`,
    payload_json: JSON.stringify({ opb: { context_identity: date >= '2026-11-24' ? hex('n') : hex('o') }, padding: 'x'.repeat(3_000) }) })))
  // Old context: signal dates up to 11/13, known five sessions later (newest known 11/20); inserted oldest first.
  const replay = weekdays('2026-11-13', 40).reverse().flatMap((signal) => ARMS.map((arm) => ({ context_identity: hex('o'), signal_date: signal,
    arm_digest: hex(String(ARMS.indexOf(arm))), arm_id: arm, schema_version: 'l4-opb-arm-replay-v1', known_date: weekdays(day(signal, 7), 1)[0] > '2026-11-20' ? '2026-11-20' : weekdays(day(signal, 7), 1)[0],
    arm_return: 0, base_return: 0, delta: 0, effective_digest: hex('e'), arm_inert: 0, status: 'complete', snapshot_id: 's', plan_id: 'p', replay_plan_id: 'r',
    consistency: 'ok', payload_checksum: hex('0'), materialized_at: X })))
  await insertRows(learning, 'l4_opb_arm_replay_v1', replay)
}

async function seedServing(db: D1Database) {
  const days = weekdays(day(X, -1), 12)
  // 200 stocks per model and date, plus a retired model that is not in the roster.
  await insertRows(db, 'predictions', days.flatMap((date) => [...R33, 'XGBoost'].filter((model) => !(model === 'TabM' && date === GAP))
    .flatMap((model) => Array.from({ length: 200 }, (_, stock) => ({ stock_id: stock + 1, model_name: model, prediction_date: date })))))
  const history = (model: string, version: string, effective: string, retired: string | null) => ({ event_id: `${model}-${version}-${effective}`, model_name: model,
    version, artifact_id: `${model}:${version}`, effective_at: effective, retired_at: retired, source: 'model_champion_history', evidence_grade: 'exact' })
  await insertRows(db, 'model_champion_history', R33.flatMap((model) => [
    history(model, 'v-jul', '2026-07-20T00:00:00.000000+00:00', '2026-10-01T08:40:28.850646+00:00'),
    history(model, 'v-sep', '2026-10-01T08:40:28.850646+00:00', '2026-11-19T08:13:35.005863+00:00'),
    history(model, 'v-nov', '2026-11-19T08:13:35.005863+00:00', null)]))
}

let ticketSeq = 0
const ticket = (task: string, date: string, status: string, updatedAt: string, extra: Record<string, unknown> = {}) => {
  const id = `t-${++ticketSeq}`
  return { ticket_id: id, dedupe_key: id, root_ticket_id: id, scheduler_job_id: task, task, business_date: date, run_id: id, attempt_id: id,
    ticket_kind: 'physical_root', status, status_authority: 'scheduler_http', payload_checksum: 'c', updated_at: updatedAt, accepted_at: updatedAt,
    scheduled_at: updatedAt, completed_at: updatedAt, ...extra }
}
const OVERLOAD = 'Error: D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.'
async function seedTickets(db: D1Database) {
  const rows: Record<string, unknown>[] = []
  for (let offset = 0; offset < 30; offset++) for (let job = 0; job < 20; job++) rows.push(ticket(`daily-${job}`, day(X, -offset), 'success', `${day(X, -offset)} 10:00:00`))
  // In the 24 h: two overloads of daily-snapshot, one in a summary only, one on a business date six days back (a watchdog re-run).
  rows.push(ticket('daily-snapshot', X, 'error', `${X} 02:25:16`, { last_error: OVERLOAD, last_summary: OVERLOAD }))
  rows.push(ticket('daily-snapshot', X, 'error', `${X} 02:05:00`, { last_error: OVERLOAD }))
  rows.push(ticket('strategy-learning-watchdog', day(X, -6), 'error', `${day(X, -1)} 22:19:28`, { last_summary: `recovery blocked reason=run_error:${OVERLOAD}` }))
  rows.push(ticket('maintenance', X, 'blocked', `${X} 06:00:00`, { last_error: 'Requests queued for too long' }))
  // The marker past the 300th character of a long error (prod weekly-readiness 11/22: character 317); last_error set and empty.
  rows.push(ticket('weekly-readiness', X, 'error', `${X} 04:00:00`, { last_error: `Error: weekly_readiness_blocked ${'{"blocker":"x"}'.repeat(25)} ${OVERLOAD}` }))
  rows.push(ticket('premarket', X, 'error', `${X} 04:30:00`, { last_error: '', last_summary: `${'y'.repeat(320)} ${OVERLOAD}` }))
  // 300 error tickets of the window's business dates updated before the 24 h: not read at all (updated_at is the seek range).
  for (let n = 0; n < 300; n++) rows.push(ticket(`old-${n % 10}`, day(X, -(n % 7)), 'error', `${day(X, -3)} 01:00:00`, { last_error: OVERLOAD }))
  // Out of the 24 h, another error, and a success that mentions an overload it recovered from: none counted.
  rows.push(ticket('audit-json-retention', day(X, -2), 'error', `${day(X, -2)} 19:48:15`, { last_error: OVERLOAD }))
  rows.push(ticket('pipeline', X, 'error', `${X} 03:00:00`, { last_error: 'timeout' }))
  rows.push(ticket('daily-snapshot', X, 'success', `${X} 03:00:00`, { last_summary: 'retried after D1 DB is overloaded' }))
  await insertRows(db, 'scheduler_execution_tickets_v1', rows)
}

before(async () => {
  fx = await startFixture()
  for (const [domain, { binding, tables }] of Object.entries(TABLES)) {
    for (const stmt of domainDdl(domain, tables)) await fx.raw[binding].prepare(stmt).run()
  }
  await seedRoster(fx.raw.LEARNING_DB)
  await seedSeal(fx.raw.PAPER_DB)
  await seedLedger(fx.raw.PAPER_DB, fx.raw.LEARNING_DB)
  await seedServing(fx.raw.LEARNING_DB)
  await seedTickets(fx.raw.OPS_DB)
  const keys = await accessKeys()
  const env = { ...fx.env, ACCESS_TEAM_DOMAIN: TEST_TEAM, ACCESS_AUD: TEST_AUD, MONITORING_READ_TOKEN: TEST_TOKEN }
  call = async (path, nowMs = NOW) => {
    const handler = createMonitoringHandler({ now: () => nowMs, fetch: keys.fetcher, cache: null, onQuery: (query) => queries.push(query) })
    const response = await handler(new Request(`https://monitoring.test${path}`, { headers: await accessHeaders(keys, nowMs) }), env)
    return { status: response.status, body: await response.json() }
  }
})

after(async () => { await fx?.mf.dispose() })

const measured: Record<string, number> = {}
async function endpoint(path: string, maxRowsRead: number, ttl: number, nowMs = NOW) {
  const start = queries.length
  const result = await call(path, nowMs)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.cache_ttl_s, ttl)
  assert.equal(result.body.rows_read, queries.slice(start).reduce((sum, q) => sum + q.rowsRead, 0), 'rows_read is the sum of D1 meta.rows_read')
  assert.ok(result.body.rows_read <= maxRowsRead, `${path} rows_read=${result.body.rows_read} > ${maxRowsRead}`)
  assert.ok(Array.isArray(result.body.rows), 'Infinity/JSONata root array')
  const stamps = (value: unknown, key = ''): string[] => Array.isArray(value) ? value.flatMap((item) => stamps(item))
    : value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => stamps(v, k))
    : key.endsWith('_at') && typeof value === 'string' && /\d{2}:\d{2}/.test(value) ? [value] : []
  for (const stamp of stamps(result.body)) assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, path)
  measured[path] = Math.max(measured[path] ?? 0, result.body.rows_read)
  return result.body
}

test('/v1/policy/seal: today sealed before the cutoff, the 14-day window by primary-key seek, a missing trading day', async () => {
  const body = await endpoint('/v1/policy/seal', 40, SLOW_TTL_S)
  const window = weekdays(X, 14).filter((date) => date >= day(X, -13)).reverse()
  assert.deepEqual(body.rows.map((row: any) => row.date), window)
  assert.deepEqual([body.summary.today_status, body.summary.today_sealed_at], ['sealed', '2026-11-25T23:29:15.000Z'])
  assert.equal(body.rows.at(-1).minutes_before_cutoff, 76, '07:29 TW against the 08:45 cutoff')
  assert.deepEqual([body.summary.missing_days, body.summary.latest_missing_date], [1, GAP], 'account 2 sealed GAP: not account 1')
  const revised = body.rows.find((row: any) => row.date === day(X, -2))
  assert.deepEqual([revised.revision, revised.sealed_at], [1, `${day(X, -3)}T23:29:15.000Z`], 'first seal time, revision count')
})

test('/v1/policy/seal: no head before the 08:45 cutoff is waiting, after it missing', async () => {
  // GAP (Fri) 08:00 TW: no plan sealed yet, the cutoff still ahead.
  const before = await endpoint('/v1/policy/seal', 40, SLOW_TTL_S, Date.parse(`${GAP}T00:00:00Z`))
  assert.deepEqual([before.today, before.summary.today_status, before.summary.missing_days], [GAP, 'waiting', 0])
  assert.ok(before.rows.every((row: any) => row.date <= GAP), 'no row after today')
  const after = await endpoint('/v1/policy/seal', 40, SLOW_TTL_S, Date.parse(`${GAP}T00:45:00Z`))
  assert.deepEqual([after.summary.today_status, after.summary.missing_days], ['missing', 1])
})

test('/v1/opb/ledger: lag in trading days from the rowid tail, the live context without replay', async () => {
  const body = await endpoint('/v1/opb/ledger', 200, OPB_TTL_S)
  assert.equal(body.expected_known_date, '2026-11-25', 'the trading day before the closure of X (16:00 TW)')
  assert.equal(body.summary.ledger_last_known_date, '2026-11-20')
  assert.equal(body.summary.lag_trading_days, 3, '11/23, 11/24, 11/25')
  assert.deepEqual([body.summary.current_context_identity, body.summary.current_context_since, body.summary.current_context_rows,
    body.summary.current_context_lag_trading_days], [hex('n'), '2026-11-24', 0, null])
  assert.equal(body.rows.length, 2)
})

test('/v1/models/serving: per model and trading day, a missing day, the 11/19 cutover, today pending', async () => {
  const body = await endpoint('/v1/models/serving', 80, OPB_TTL_S)
  assert.deepEqual(body.models, R33)
  const days = weekdays(X, 14).filter((date) => date >= day(X, -13)).reverse()
  assert.equal(body.rows.length, days.length * R33.length)
  const cell = (date: string, model: string) => body.rows.find((row: any) => row.date === date && row.model_name === model)
  assert.deepEqual([cell(GAP, 'TabM').state, cell(GAP, 'LightGBM').state], ['missing', 'serving'])
  assert.deepEqual([cell('2026-11-19', 'GNN').state, cell('2026-11-19', 'GNN').version, cell('2026-11-18', 'GNN').version], ['switched', 'v-nov', 'v-sep'])
  assert.equal(cell(X, 'LightGBM').state, 'pending', 'X: its pipeline runs tonight')
  assert.equal(cell(X, 'LightGBM').cell, 'pending|v-nov')
  assert.deepEqual([body.summary.latest_finished_date, body.summary.missing_cells], [day(X, -1), 1])
})

test('/v1/models/serving: before 09:00 TW the previous trading day is pending, from 09:00 missing', async () => {
  // Mon 11/23: the previous trading day is GAP, whose TabM predictions never landed.
  const early = await endpoint('/v1/models/serving', 80, OPB_TTL_S, Date.parse('2026-11-23T00:30:00Z'))
  const tabm = (body: any) => body.rows.find((row: any) => row.date === GAP && row.model_name === 'TabM').state
  assert.equal(tabm(early), 'pending')
  assert.equal(early.summary.latest_finished_date, '2026-11-19')
  const late = await endpoint('/v1/models/serving', 80, OPB_TTL_S, Date.parse('2026-11-23T01:00:00Z'))
  assert.equal(tabm(late), 'missing')
})

test('/v1/models/serving: a Friday stays pending over the weekend (its predictions land Monday morning)', async () => {
  // GAP is Fri 11/20. Sat 11/21 10:00 TW and Sun 11/22 23:00 TW: pending; Mon 11/23 09:00 TW: missing (test above).
  const tabm = (body: any) => body.rows.find((row: any) => row.date === GAP && row.model_name === 'TabM').state
  const saturday = await endpoint('/v1/models/serving', 80, OPB_TTL_S, Date.parse('2026-11-21T02:00:00Z'))
  assert.equal(tabm(saturday), 'pending')
  assert.equal(saturday.summary.latest_finished_date, '2026-11-19')
  const sunday = await endpoint('/v1/models/serving', 80, OPB_TTL_S, Date.parse('2026-11-22T15:00:00Z'))
  assert.equal(tabm(sunday), 'pending')
  assert.equal(sunday.summary.latest_finished_date, '2026-11-19')
  assert.equal(sunday.summary.missing_cells, sunday.rows.filter((row: any) => row.state === 'missing').length)
  assert.ok(sunday.rows.every((row: any) => row.date !== GAP || row.state !== 'missing'), 'no Friday cell counted as missing')
})

test('/v1/models/serving: a Monday holiday moves the Friday\'s due time to Tuesday 09:00', async () => {
  const tabm = (body: any) => body.rows.find((row: any) => row.date === GAP && row.model_name === 'TabM').state
  await fx.kv.put('holiday:2026-11-23', '1')
  try {
    assert.equal(tabm(await endpoint('/v1/models/serving', 80, OPB_TTL_S, Date.parse('2026-11-23T02:00:00Z'))), 'pending', 'Mon (holiday) 10:00')
    assert.equal(tabm(await endpoint('/v1/models/serving', 80, OPB_TTL_S, Date.parse('2026-11-23T23:59:00Z'))), 'pending', 'Tue 07:59')
    assert.equal(tabm(await endpoint('/v1/models/serving', 80, OPB_TTL_S, Date.parse('2026-11-24T01:00:00Z'))), 'missing', 'Tue 09:00')
  } finally {
    await fx.kv.delete('holiday:2026-11-23')
  }
})

test('/v1/serving-guard: no guard row is not applicable; a guard row serves its streaks and the identity\'s evaluations', async () => {
  const none = await endpoint('/v1/serving-guard', 5, OPB_TTL_S)
  assert.deepEqual([none.summary.status, none.summary.degraded_streak, none.rows.length], ['not_applicable', null, 0])
  const fingerprint = hex('f')
  await insertRows(fx.raw.LEARNING_DB, 'expected_return_forward_guard_state', [{ model_name: 'allocator_ev_fusion', artifact_id: 'fusion-1', model_fingerprint: fingerprint,
    model_version: 'v1', state: 'monitoring', evaluable_date_count: 6, degraded_streak: 2, recovery_streak: 0, last_prediction_date: day(X, -6),
    evidence_json: JSON.stringify({ reason: 'single_or_nonpersistent_degradation_warning' }), updated_at: `${day(X, -1)} 06:30:00` }])
  await insertRows(fx.raw.LEARNING_DB, 'expected_return_serving_forward_evaluations', weekdays(day(X, -6), 40).map((date, i) => ({ evaluation_id: `e-${date}`,
    prediction_date: date, label_known_date: day(date, 7), model_name: 'allocator_ev_fusion', artifact_id: 'fusion-1', model_fingerprint: fingerprint, model_version: 'v1',
    sample_count: 50, quality_decision: i < 2 ? 'DEGRADED' : 'PASS', evidence_json: '{}' })))
  // No serving state in KV: the guard is not bound to anything serving, so its streaks are not shown as normal.
  const unknown = await endpoint('/v1/serving-guard', 5, OPB_TTL_S)
  assert.deepEqual([unknown.summary.status, unknown.summary.degraded_streak, unknown.summary.serving_identity_source, unknown.rows.length],
    ['mismatch', null, 'serving_state_missing', 0])
  const serving = (artifact: string, print: string) => JSON.stringify({ artifacts: { allocator_ev_fusion: { artifact_id: artifact, model_fingerprint: print } } })
  await fx.kv.put('trading:config', JSON.stringify({}))
  await fx.kv.put(SERVING_STATE_KEY, serving('fusion-1', hex('9')))
  const other = await endpoint('/v1/serving-guard', 5, OPB_TTL_S)
  assert.deepEqual([other.summary.status, other.summary.identity_bound, other.summary.reason], ['mismatch', false, 'runtime_guard_identity_mismatch'], 'fingerprint differs')
  await fx.kv.put(SERVING_STATE_KEY, serving('fusion-1', fingerprint))
  const body = await endpoint('/v1/serving-guard', 40, OPB_TTL_S)
  assert.deepEqual([body.summary.status, body.summary.degraded_streak, body.summary.reason], ['warning', 2, 'single_or_nonpersistent_degradation_warning'])
  assert.equal(body.thresholds.degraded_streak_to_bypass, 3)
  assert.ok(body.rows.length > 0 && body.rows.every((row: any) => row.prediction_date >= day(X, -30)))
  assert.equal(body.rows.at(-1).quality_decision, 'DEGRADED')
  // l4Distribution in trading:config retires Fusion (readNewL4ServingState): any guard row is unbound.
  await fx.kv.put('trading:config', JSON.stringify({ l4Distribution: { scope: 'paper' } }))
  const l4 = await endpoint('/v1/serving-guard', 5, OPB_TTL_S)
  assert.deepEqual([l4.summary.status, l4.summary.serving_identity_source], ['mismatch', 'l4_distribution_retires_fusion'])
  assert.equal(SERVING_STATE_KEY, EXPECTED_RETURN_SERVING_STATE_KEY)
})

test('/v1/d1/overloaded: error and blocked tickets of the week by the status index, 24 h on updated_at', async () => {
  // ≈ one boundary probe per (status, business date) seek (2 × 11) plus index and table rows of the 7 hits; the 300 stale
  // error tickets would add 300.
  const body = await endpoint('/v1/d1/overloaded', 60, SLOW_TTL_S)
  assert.equal(body.summary.count, 6)
  assert.deepEqual(body.by_task.map((row: any) => [row.task, row.count]),
    [['daily-snapshot', 2], ['maintenance', 1], ['premarket', 1], ['strategy-learning-watchdog', 1], ['weekly-readiness', 1]])
  assert.equal(body.rows.find((row: any) => row.task === 'premarket').error.length, 200, 'empty last_error: the summary is served, cut to 200')
  assert.equal(body.tickets_read, 7, 'only tickets updated in the 24 h are read')
  assert.equal(body.truncated, false)
  assert.equal(body.summary.last_at, `${X}T06:00:00.000Z`)
})

test('every v6 query is read-only and EXPLAINs without a table SCAN or temp B-tree', async () => {
  assert.ok(queries.length >= 10, `queries=${queries.length}`)
  const seen = new Set<string>()
  for (const query of queries) {
    const key = `${query.db}|${query.sql}`
    if (seen.has(key)) continue
    seen.add(key)
    const label = `${query.db}: ${query.sql.replace(/\s+/g, ' ').slice(0, 160)}`
    assert.deepEqual(await tableScans(fx.raw[query.db], query), [], label)
    assert.deepEqual(await tempSorts(fx.raw[query.db], query), [], label)
  }
  for (const path of Object.keys(V6_ROUTES)) assert.ok(measured[path] != null, path)
  console.log('v6 rows_read', JSON.stringify(measured))
})
