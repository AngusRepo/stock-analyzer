import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createMonitoringHandler, KV_DRIFT_TTL_S, OPB_TTL_S, P4_ROUTES, ROSTER_TTL_S, SLOW_TTL_S, TIMELINE_TTL_S } from './index'
import { day, domainDdl, insertRows, startFixture, tableScans, tempSorts, weekdays, type Fixture } from './monitoringFixture.testSupport'
import { MONTHLY_JOB_ID, nextFirstWeekdayRun } from './modelRoster'
import schedulerManifest from '../../../infra/gcp-scheduler-jobs.json'
import { latestArmStatistics } from './opb'
import { parseKvDriftSummary } from './schedulerTickets'
import type { ExecutedQuery } from './readOnlyD1'
import { accessHeaders, accessKeys, TEST_AUD, TEST_TEAM, TEST_TOKEN } from './monitoringAuth.testSupport'

// 2026-11-25 (Wed) 15:00 TW, after the 14:20 snapshot and receipt.
const NOW = Date.parse('2026-11-25T07:00:00Z')
const X = '2026-11-25'
/** Tables p4 reads that the shared fixture does not create. */
const P4_TABLES: Record<string, { binding: string; tables: string[] }> = {
  paper: { binding: 'PAPER_DB', tables: ['paper_accounts', 'paper_daily_snapshots', 'paper_positions', 'paper_orders', 'l4_policy_account_rewards_v1'] },
  core: { binding: 'CORE_DB', tables: ['market_risk'] },
  learning: { binding: 'LEARNING_DB', tables: ['active8_ensemble_artifacts_v1', 'active8_ensemble_pointer_v1', 'model_artifact_registry',
    'model_champion_pointers', 'l4_opb_arm_replay_v1', 'meta_reward_ledger'] },
  ops: { binding: 'OPS_DB', tables: ['scheduler_execution_tickets_v1'] },
}
const R33 = ['LightGBM', 'ExtraTrees', 'TabM', 'GNN']
const LEGACY = ['XGBoost', 'DLinear', 'PatchTST', 'iTransformer']
const hex = (seed: string) => seed.repeat(64).slice(0, 64)

let fx: Fixture
const queries: ExecutedQuery[] = []
let call: (path: string) => Promise<{ status: number; body: any }>

async function seedPaper(db: D1Database, core: D1Database) {
  await insertRows(db, 'paper_accounts', [{ id: 1 }, { id: 2 }])
  const dates = weekdays(X, 300).reverse()
  await insertRows(db, 'paper_daily_snapshots', dates.map((date, i) => ({
    account_id: 1, date, cash: 500_000, positions_value: 500_000 + (i % 7) * 1_000 - (i > 280 ? 20_000 : 0),
    total_value: 1_000_000 + (i % 7) * 1_000 - (i > 280 ? 20_000 : 0), pnl: 0, pnl_pct: 0.5, benchmark_value: 90, max_drawdown_to_date: 0.02,
  })))
  // The index close of X is not written yet at 15:00 TW: stays null.
  await insertRows(core, 'market_risk', dates.filter((date) => date !== X).map((date, i) => ({ date, twii_close: 20_000 + i * 10 })))
  await insertRows(db, 'paper_positions', [
    ...['2330', '2317', '2454'].map((symbol) => ({ account_id: 1, symbol, shares: 1000, avg_cost: 100, entry_date: day(X, -3) })),
    ...Array.from({ length: 20 }, (_, i) => ({ account_id: 1, symbol: String(3000 + i), shares: 0, avg_cost: 10 })),
    { account_id: 2, symbol: '2330', shares: 500, avg_cost: 100 },
  ])
  await insertRows(db, 'paper_orders', [
    ...weekdays(day(X, -1), 120).flatMap((date) => [0, 1, 2, 3].map((n) => ({ account_id: 1, symbol: String(2000 + n), side: n % 2 ? 'sell' : 'buy',
      shares: 1000, price: 10, total_cost: 10_000, source: 'l4', created_at: `${date} 0${n + 1}:00:00` }))),
    // X−1 23:59:59 TW is yesterday; X 00:00 TW (X−1 16:00 UTC) onwards is today.
    { account_id: 1, symbol: '2330', side: 'buy', shares: 1000, price: 100, total_cost: 100_000, source: 'l4', created_at: `${day(X, -1)} 15:59:59` },
    { account_id: 1, symbol: '2317', side: 'buy', shares: 1000, price: 100, total_cost: 100_000, source: 'l4', created_at: `${day(X, -1)} 16:00:00` },
    { account_id: 1, symbol: '2454', side: 'sell', shares: 1000, price: 100, total_cost: 100_000, source: 'l4', created_at: `${X} 01:30:00` },
    { account_id: 2, symbol: '2454', side: 'sell', shares: 1000, price: 100, total_cost: 100_000, source: 'manual', created_at: `${X} 01:30:00` },
  ])
  await insertRows(db, 'paper_order_intents', [
    ...['2317', '2454', '1101'].map((symbol, i) => ({ intent_key: `x-${symbol}`, account_id: 1, trade_date: X, symbol, side: i ? 'sell' : 'buy', source: 'l4', status: i === 2 ? 'failed' : 'success' })),
    { intent_key: 'x-other', account_id: 2, trade_date: X, symbol: '2330', side: 'buy', source: 'manual', status: 'success' },
    ...weekdays(day(X, -1), 60).flatMap((date) => [0, 1, 2].map((n) => ({ intent_key: `${date}-${n}`, account_id: 1, trade_date: date, symbol: String(2000 + n), side: 'buy', source: 'l4' }))),
  ])
}

const gateEvidence = (oosIc: number, decision = 'STRONG_PASS') => JSON.stringify({ gate: { decision, failed_gates: [],
  metrics: { oos_ic: oosIc, min_oos_ic_mean: 0, weak_oos_ic_mean: 0.0129, strong_oos_ic_mean: 0.0259 }, policy: { pbo: { max_pbo: 0.36 } } },
  padding: 'x'.repeat(2_000) })

async function seedModels(db: D1Database) {
  const payload = (order: string[], checksum: string) => JSON.stringify({ model_order: order, payload_checksum: checksum,
    validation: { decision: 'PASS', oof_checks_status: 'pass' }, cohort_id: 'core4' })
  await insertRows(db, 'active8_ensemble_artifacts_v1', [
    { artifact_id: 'ens-oct', cohort_id: 'eight', training_run_id: 'run-oct', knowledge_cutoff_date: '2026-09-30', schema_version: 'active8-oof-ensemble-serving-artifact-v1',
      payload_json: payload([...R33, ...LEGACY], hex('a')), payload_checksum: hex('a'), base_artifact_set_checksum: hex('b'), validation_decision: 'PASS',
      validation_json: '{}', archive_uri: 'gs://x', state: 'archived', production_effect: 0 },
    { artifact_id: 'ens-nov', cohort_id: 'core4', training_run_id: 'run-nov', knowledge_cutoff_date: '2026-10-29', schema_version: 'active8-oof-ensemble-serving-artifact-v1',
      payload_json: payload(R33, hex('c')), payload_checksum: hex('c'), base_artifact_set_checksum: hex('d'), validation_decision: 'PASS',
      validation_json: '{}', archive_uri: 'gs://y', state: 'production', production_effect: 1 },
  ])
  await insertRows(db, 'active8_ensemble_pointer_v1', [{ singleton_id: 1, artifact_id: 'ens-nov', cohort_id: 'core4', payload_checksum: hex('c'),
    base_artifact_set_checksum: hex('d'), promoted_at: '2026-11-24 10:55:24', promotion_reason: 'r33_cutover' }])
  const registry = (model: string, run: string, sourceRunDate: string, state: string, updatedAt: string, ic: number, decision = 'STRONG_PASS', type = 'oof_full_fit_release') => ({
    artifact_id: `${model}:${run}:${type}`, model_name: model, version: `v-${run}`, candidate_type: type, state, training_run_id: run,
    source_run_date: sourceRunDate, offline_gate_decision: decision, offline_gate_failed_gates: decision === 'FAIL' ? '["oos_ic"]' : '[]',
    offline_evidence_json: gateEvidence(ic, decision), updated_at: updatedAt,
  })
  await insertRows(db, 'model_artifact_registry', [
    ...R33.map((model, i) => registry(model, 'run-nov', '2026-11-05', 'production', '2026-11-24 10:55:24', 0.12 - i * 0.01)),
    ...[...R33, ...LEGACY].map((model) => registry(model, 'run-oct', '2026-10-04', 'archived', '2026-11-19 08:13:39', 0.05)),
    // A later run that failed its gates: the latest monthly run, not the live one.
    ...['LightGBM', 'TabM'].map((model) => registry(model, 'run-nov-b', '2026-11-20', 'offline_failed', '2026-11-22 03:00:00', -0.01, 'FAIL')),
    // Outside the 62-day window, and another candidate type inside it: neither is read.
    ...Array.from({ length: 30 }, (_, n) => [...R33, ...LEGACY].map((model) => registry(model, `run-old-${n}`, '2026-03-01', 'archived', '2026-04-01 00:00:00', 0.03))).flat(),
    ...Array.from({ length: 20 }, (_, n) => R33.map((model) => registry(model, `drift-${n}`, '2026-11-10', 'shadowing', '2026-11-15 00:00:00', 0.02, 'PASS', 'weekly_drift'))).flat(),
  ])
  await insertRows(db, 'model_champion_pointers', [...R33.map((model) => ({ model_name: model, champion_version: 'v-run-nov',
    champion_artifact_id: `${model}:run-nov:oof_full_fit_release`, promoted_at: '2026-11-24 10:55:24', promotion_reason: 'r33_cutover' })),
    ...LEGACY.map((model) => ({ model_name: model, champion_version: 'v-run-oct', champion_artifact_id: `${model}:run-oct:oof_full_fit_release` }))])
}

const ARMS = ['base', 'diversified_alpha', 'diversified_all_eligible', 'liquidity_diversified', 'conservative_diversified', 'high_score_conservative']
const PLAN_DATES = weekdays(day(X, -1), 120)
/** Context changes on the newest three signal dates (one per date). */
const contextOf = (i: number) => i < 3 ? hex(String(i + 1)) : hex('e')
const armOf = (i: number) => i % 5 === 0 ? 'base' : ARMS[1 + (i % 4)]
const inertOf = (i: number) => i % 6 === 1

async function seedOpb(paper: D1Database, learning: D1Database) {
  const opb = (i: number) => ({ enabled: true, schema_version: 'l4-opb-relative-arms-v2', context_identity: contextOf(i),
    status: inertOf(i) ? 'arm_inert' : i === 0 ? 'cold_start_base' : 'learned_policy', arm_id: inertOf(i) ? 'base' : armOf(i), arm_inert: inertOf(i),
    effective_groups: inertOf(i) ? [hex('f')] : ARMS.map((arm) => hex(String.fromCharCode(97 + ARMS.indexOf(arm)))),
    // Prod arm_inert plans store empty arm_statistics (l4_opb_selection.py: `statistics or {}`).
    arm_statistics: inertOf(i) ? {} : Object.fromEntries(ARMS.map((arm) => [arm, { samples: i === 0 ? 0 : 10, effective_samples: 5, mean: null, lower_bound: null }])) })
  await insertRows(paper, 'l4_portfolio_plans_v1', PLAN_DATES.flatMap((date, i) => [
    { plan_id: `plan-${date}`, account_id: 1, signal_date: date, policy_identity: 'p', activated: 1, allocation_snapshot_id: 's',
      payload_json: JSON.stringify({ opb: opb(i), padding: 'x'.repeat(5_000) }), created_at: `${date} 23:28:00` },
    // A superseded re-plan on the newest date: the activated plan is the date's plan.
    ...(i === 0 ? [{ plan_id: `replan-${date}`, account_id: 1, signal_date: date, policy_identity: 'p', activated: 0, allocation_snapshot_id: 's',
      payload_json: JSON.stringify({ opb: { ...opb(i), arm_id: 'diversified_alpha' } }), created_at: `${date} 23:59:00` }] : []),
  ]))
  // Receipts in rowid order, one per known date (the trading day after the signal date).
  await insertRows(paper, 'l4_policy_account_rewards_v1', weekdays(X, 120).reverse().map((date, n) => ({
    receipt_id: `r-${date}`, known_date: date, policy_identity: 'p',
    payload_json: JSON.stringify({ arm_id: armOf(n), complete: n % 10 !== 0, reason: n % 10 ? 'complete_account' : 'mixed_policy_session', reward: 0, arm_inert: false }),
  })))
  await insertRows(learning, 'l4_opb_arm_replay_v1', [
    // The current context has replay for its own date only; the old context carries the history.
    ...ARMS.map((arm) => ({ context_identity: contextOf(0), signal_date: PLAN_DATES[0], arm_digest: hex(String.fromCharCode(97 + ARMS.indexOf(arm))), arm_id: arm,
      schema_version: 'l4-opb-arm-replay-v1', known_date: X, arm_return: 0.01, base_return: 0.005, delta: 0.005, effective_digest: hex(String.fromCharCode(97 + ARMS.indexOf(arm))),
      arm_inert: 0, status: 'complete', snapshot_id: 's', plan_id: 'p', replay_plan_id: 'rp', consistency: 'ok', payload_checksum: hex('0'), materialized_at: X })),
    ...PLAN_DATES.slice(3).flatMap((date) => ARMS.map((arm) => ({ context_identity: hex('e'), signal_date: date, arm_digest: hex(String.fromCharCode(97 + ARMS.indexOf(arm))), arm_id: arm,
      schema_version: 'l4-opb-arm-replay-v1', known_date: day(date, 1), arm_return: 0, base_return: 0, delta: 0, effective_digest: hex(String.fromCharCode(97 + ARMS.indexOf(arm))),
      arm_inert: 0, status: 'complete', snapshot_id: 's', plan_id: 'p', replay_plan_id: 'rp', consistency: 'ok', payload_checksum: hex('0'), materialized_at: X }))),
  ])
  await insertRows(learning, 'meta_reward_ledger', [
    ...Array.from({ length: 80 }, (_, i) => ({ policy_id: 'LinUCB', arm_id: `lane:${i % 4}`, context_hash: `ctx-${i}`, samples: 10, reward_sum: 0.1 * (i % 4),
      reward_mean: 0.01 * (i % 4), last_reward_at: day(X, -8 - (i % 3)), updated_at: `${day(X, -2)}T06:30:00Z` })),
    ...Array.from({ length: 200 }, (_, i) => ({ policy_id: 'other', arm_id: `a${i}`, context_hash: 'global', samples: 1, reward_sum: 0 })),
  ])
}

let ticketSeq = 0
function ticket(job: string | null, task: string, date: string, status: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  const id = `t-${++ticketSeq}`
  return { ticket_id: id, dedupe_key: id, root_ticket_id: id, scheduler_job_id: job, task, business_date: date, run_id: id, attempt_id: id,
    ticket_kind: job ? 'physical_root' : 'manual', status, status_authority: 'scheduler_http', payload_checksum: 'c', updated_at: updatedAt,
    accepted_at: updatedAt, scheduled_at: updatedAt, ...(['success', 'error', 'skipped', 'blocked'].includes(status) ? { completed_at: updatedAt } : {}), ...extra }
}
const utc = (date: string, hhmm: string) => `${date} ${hhmm}:00`

async function seedTickets(db: D1Database) {
  const rows: Record<string, unknown>[] = []
  // Bulk: 40 days × 25 daily jobs of plain success tickets, plus errors older than the window. None of them is read.
  for (let offset = 0; offset < 40; offset++) {
    const date = day(X, -offset)
    for (let job = 0; job < 25; job++) rows.push(ticket(`daily-${job}`, `daily-${job}`, date, 'success', utc(date, '10:00')))
  }
  for (let offset = 20; offset < 40; offset++) rows.push(ticket('screener-v2-watchdog', 'screener-v2-watchdog', day(X, -offset), 'error', utc(day(X, -offset), '14:00'), { last_summary: 'status=failed old' }))
  // final_failure on X−1, X−2, X−4 (occurrences 1-3); X−1 has three attempts.
  for (const offset of [1, 2, 4]) {
    const date = day(X, -offset)
    for (const hh of offset === 1 ? ['13:00', '13:30', '14:00'] : ['13:00']) rows.push(ticket('screener-v2-watchdog', 'screener-v2-watchdog', date, 'error', utc(date, hh), { last_error: '', last_summary: 'status=failed screener v2 missing date' }))
  }
  // recovered: error, then a later success.
  rows.push(ticket('evening-chain', 'evening-chain', day(X, -2), 'error', utc(day(X, -2), '14:00'), { last_error: 'D1 DB is overloaded' }))
  rows.push(ticket('evening-chain', 'evening-chain', day(X, -2), 'success', utc(day(X, -2), '15:00'), { last_summary: 'evening chain complete' }))
  // designed retry.
  rows.push(ticket('audit-json-retention', 'audit-json-retention', day(X, -1), 'error', utc(day(X, -1), '20:00'), { last_summary: 'maintenance_lease_busy: retention lease held' }))
  // upstream blocked, a manual ticket with no scheduler job.
  rows.push(ticket(null, 'pipeline', day(X, -3), 'blocked', utc(day(X, -3), '01:33'), { last_summary: 'historical learning lineage boundary blocked' }))
  // orphan running (3 days, no completion) and an unsettled trigger (2 days); one fresh running ticket.
  rows.push(ticket('sector-leaders', 'sector-leaders', day(X, -3), 'running', utc(day(X, -3), '22:30')))
  rows.push(ticket('premarket-evidence-watchdog', 'premarket-evidence-watchdog', day(X, -2), 'triggered', utc(day(X, -2), '00:10'), { last_summary: 'status=pending premarket' }))
  rows.push(ticket('intraday-check', 'intraday-check', X, 'running', utc(X, '06:50')))
  // A dispatch recorded as success over an earlier error is not a closure (schedulerTicketClosureDefect).
  rows.push(ticket('active8-oof-monthly', 'active8-oof-monthly', day(X, -3), 'error', utc(day(X, -3), '18:00'), { last_error: 'timeout' }))
  rows.push(ticket('active8-oof-monthly', 'active8-oof-monthly', day(X, -3), 'success', utc(day(X, -3), '19:00'), { last_summary: 'status=spawned call=fc-1' }))
  // kv-config-drift: daily, match until X; X−1 retried to a success.
  for (let offset = 0; offset < 12; offset++) {
    const date = day(X, -offset)
    if (offset === 0) {
      const text = 'kv_config_drift trading:config=drift:0bf52c5366e7 trading:risk_config=match:b1f9c64776dd | stored_risk_v2_drift since=2026-10-11 checked=1 skipped_pre_v2=29 failed=0 policy_changed=0'
      rows.push(ticket('kv-config-drift', 'kv-config-drift', date, 'error', utc(day(date, -1), '22:00'), { last_summary: text, last_error: `Error: ${text}` }))
      continue
    }
    if (offset === 1) rows.push(ticket('kv-config-drift', 'kv-config-drift', date, 'error', utc(day(date, -1), '22:00'), { last_error: 'kv_config_manifest_unavailable:503' }))
    rows.push(ticket('kv-config-drift', 'kv-config-drift', date, 'success', utc(day(date, -1), '22:05'),
      { last_summary: 'kv_config_drift trading:config=match:7e8264d95c17 trading:risk_config=match:b1f9c64776dd | stored_risk_v2_drift since=2026-10-11 checked=1 skipped_pre_v2=29 failed=0 policy_changed=0' }))
  }
  await insertRows(db, 'scheduler_execution_tickets_v1', rows)
}

before(async () => {
  fx = await startFixture()
  for (const [domain, { binding, tables }] of Object.entries(P4_TABLES)) {
    for (const stmt of domainDdl(domain, tables)) await fx.raw[binding].prepare(stmt).run()
  }
  await seedPaper(fx.raw.PAPER_DB, fx.raw.CORE_DB)
  await seedModels(fx.raw.LEARNING_DB)
  await seedOpb(fx.raw.PAPER_DB, fx.raw.LEARNING_DB)
  await seedTickets(fx.raw.OPS_DB)
  const keys = await accessKeys()
  const handler = createMonitoringHandler({ now: () => NOW, fetch: keys.fetcher, cache: null, onQuery: (query) => queries.push(query) })
  const env = { ...fx.env, ACCESS_TEAM_DOMAIN: TEST_TEAM, ACCESS_AUD: TEST_AUD, MONITORING_READ_TOKEN: TEST_TOKEN }
  call = async (path) => {
    const response = await handler(new Request(`https://monitoring.test${path}`, { headers: await accessHeaders(keys, NOW) }), env)
    return { status: response.status, body: await response.json() }
  }
})

after(async () => { await fx?.mf.dispose() })

const measured: Record<string, number> = {}
async function endpoint(path: string, maxRowsRead: number, ttl: number) {
  const start = queries.length
  const result = await call(path)
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(typeof result.body.generated_at, 'string')
  assert.equal(result.body.cache_ttl_s, ttl)
  assert.equal(result.body.rows_read, queries.slice(start).reduce((sum, q) => sum + q.rowsRead, 0), 'rows_read is the sum of D1 meta.rows_read')
  assert.ok(result.body.rows_read <= maxRowsRead, `${path} rows_read=${result.body.rows_read} > ${maxRowsRead}`)
  assert.ok(Array.isArray(result.body.rows), 'Infinity/JSONata root array')
  // Grafana's JSONata reads anything but millisecond `Z` stamps as the date's midnight.
  const stamps = (value: unknown, key = ''): string[] => Array.isArray(value) ? value.flatMap((item) => stamps(item))
    : value && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => stamps(v, k))
    : key.endsWith('_at') && typeof value === 'string' && /\d{2}:\d{2}/.test(value) ? [value] : []
  for (const stamp of stamps(result.body)) assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, path)
  measured[path.split('?')[0]] = result.body.rows_read
  return result.body
}

test('/v1/paper/nav?days=60: snapshot and market_risk ranges, TW-day orders, index rebased to the window', async () => {
  const body = await endpoint('/v1/paper/nav?days=60', 200, SLOW_TTL_S)
  const window = weekdays(X, 60).filter((date) => date >= day(X, -59)).reverse()
  assert.deepEqual(body.rows.map((row: any) => row.date), window)
  const [first, last] = [body.rows[0], body.rows.at(-1)]
  assert.equal(first.nav_return_pct, 0)
  assert.equal(first.twii_return_pct, 0)
  assert.equal(last.date, X)
  assert.equal(last.twii_close, null, 'no index close for X yet: null, not an older close')
  const indexed = body.rows.filter((row: any) => row.twii_close != null).at(-1)
  assert.equal(body.summary.twii_as_of, indexed.date, 'summary benchmark from the last day with an index close')
  assert.equal(body.summary.excess_return_pct, indexed.excess_return_pct)
  assert.notEqual(body.summary.excess_return_pct, null)
  assert.ok(body.rows.every((row: any) => row.drawdown_pct <= 0))
  assert.equal(body.summary.max_drawdown_to_date_pct, 2, 'stored fraction served as percent')
  assert.equal(body.index_source, 'core.market_risk.twii_close')
  assert.deepEqual(body.positions.map((row: any) => row.symbol), ['2317', '2330', '2454'])
  assert.deepEqual(body.orders_today.map((row: any) => row.created_at), [`${day(X, -1)}T16:00:00.000Z`, `${X}T01:30:00.000Z`])
  assert.deepEqual([body.summary.buys_today, body.summary.sells_today], [1, 1])
  assert.equal(body.intents_today.length, 3, 'account 1 only')
  assert.equal((await call('/v1/paper/nav?days=0')).status, 400)
  assert.equal((await call('/v1/paper/nav?days=366')).status, 400)
})

test('/v1/models/roster: published core4, live gate thresholds, latest monthly run, next first-Sunday run', async () => {
  // Pointer ×2, the 14-state window seek (a probe per state + 14 rows in the window), champions, two runs' rows.
  const body = await endpoint('/v1/models/roster', 100, ROSTER_TTL_S)
  assert.equal(body.roster_status, 'published')
  assert.deepEqual(body.rows.map((row: any) => row.model_name), R33)
  const lgbm = body.rows[0]
  assert.deepEqual([lgbm.gate_decision, lgbm.oos_ic, lgbm.min_oos_ic_mean, lgbm.strong_oos_ic_mean, lgbm.max_pbo, lgbm.state, lgbm.gate_training_run_id],
    ['STRONG_PASS', 0.12, 0, 0.0259, 0.36, 'production', 'run-nov'])
  assert.equal(body.ensemble.training_run_id, 'run-nov')
  assert.deepEqual(body.ensemble.validation, { decision: 'PASS', oof_checks_status: 'pass' })
  assert.equal(body.latest_monthly_run.training_run_id, 'run-nov-b')
  assert.equal(body.latest_monthly_run.is_live, false)
  assert.deepEqual(body.latest_monthly_run.models.map((row: any) => [row.model_name, row.gate_decision]), [['LightGBM', 'FAIL'], ['TabM', 'FAIL']])
  assert.equal(body.next_monthly_run.job_id, 'active8-oof-monthly')
  // The repo manifest pauses the monthly job, so no run date is promised (nextFirstWeekdayRun is tested below).
  assert.equal(body.next_monthly_run.repo_desired_state, 'PAUSED')
  assert.equal(body.next_monthly_run.next_run_at, null)
})

test('nextFirstWeekdayRun: Taipei first Sunday, same-day before and after the run, as a millisecond Z stamp', () => {
  // 2026-12-06 (Sun) 02:00 TW and 2027-01-03 (Sun) 02:00 TW.
  assert.equal(nextFirstWeekdayRun('first sunday of month 02:00', 'Asia/Taipei', Date.parse('2026-12-05T17:59:00Z')), '2026-12-05T18:00:00.000Z')
  assert.equal(nextFirstWeekdayRun('first sunday of month 02:00', 'Asia/Taipei', Date.parse('2026-12-05T18:00:00Z')), '2027-01-02T18:00:00.000Z')
  assert.equal(nextFirstWeekdayRun('first sunday of month 02:00', 'UTC', Date.parse('2026-12-05T17:59:00Z')), '2026-12-06T02:00:00.000Z')
  assert.equal(nextFirstWeekdayRun('0 2 * * *', 'Asia/Taipei', NOW), null)
})

test('/v1/models/roster: an enabled monthly job serves next_run_at as a millisecond Z stamp (Grafana $toMillis)', async () => {
  // The repo manifest pauses the job; enable it for this call only. endpoint() checks every *_at against the Z shape.
  const job = (schedulerManifest as { jobs: Array<{ id: string; desiredState?: string }> }).jobs.find((item) => item.id === MONTHLY_JOB_ID)!
  const desired = job.desiredState
  job.desiredState = 'ENABLED'
  try {
    const body = await endpoint('/v1/models/roster', 100, ROSTER_TTL_S)
    assert.equal(body.next_monthly_run.repo_desired_state, 'ENABLED')
    // NOW is 11/25: the next first Sunday 02:00 TW is 12/06.
    assert.equal(body.next_monthly_run.next_run_at, '2026-12-05T18:00:00.000Z')
  } finally {
    job.desiredState = desired
  }
})

test('/v1/opb: arm share, clip rate, receipts by rowid tail, current-context replay, LinUCB ledger', async () => {
  const body = await endpoint('/v1/opb', 250, OPB_TTL_S)
  const window = PLAN_DATES.filter((date) => date >= day(X, -29))
  assert.equal(body.summary.plan_days, window.length)
  assert.deepEqual(body.rows.map((row: any) => row.signal_date), [...window].reverse())
  const newest = body.rows.at(-1)
  assert.deepEqual([newest.arm_id, newest.status, newest.activated, newest.plans_on_date, newest.arm_count, newest.effective_groups], ['base', 'cold_start_base', true, 2, 6, 6])
  const inert = window.filter((_, i) => inertOf(i)).length
  assert.equal(body.summary.arm_inert_days, inert)
  assert.equal(body.summary.clip_rate, Math.round(inert / window.length * 1e4) / 1e4)
  assert.equal(body.arm_share.reduce((sum: number, row: any) => sum + row.plan_days, 0), window.length)
  const receiptDates = weekdays(X, 30).filter((date) => date >= day(X, -29))
  assert.deepEqual(body.receipts.map((row: any) => row.known_date), [...receiptDates].reverse())
  assert.ok(body.summary.complete_receipts < body.summary.receipts)
  assert.equal(body.summary.replay_rows_current_context, ARMS.length)
  assert.equal(body.summary.latest_arm_samples_total, 0)
  assert.deepEqual([body.summary.latest_arm_statistics_signal_date, body.summary.latest_arm_statistics_context_identity], [PLAN_DATES[0], contextOf(0)])
  assert.equal(body.summary.linucb_ledger_rows, 80)
  assert.deepEqual(body.linucb_ledger.map((row: any) => [row.arm_id, row.contexts]), [['lane:0', 20], ['lane:1', 20], ['lane:2', 20], ['lane:3', 20]])
  assert.equal(body.summary.linucb_last_reward_at, day(X, -8))
})

test('latestArmStatistics: an arm_inert newest plan falls back to the newest plan with statistics', () => {
  const stats = JSON.stringify({ base: { samples: 12, mean: 0.01 } })
  // The inert newest plan stores `{}` (prod), an older one may lack the key (NULL).
  assert.deepEqual(latestArmStatistics([{ signal_date: '2026-11-21', context_identity: 'c0', arm_statistics_json: null },
    { signal_date: '2026-11-24', context_identity: 'c1', arm_statistics_json: stats }, { signal_date: '2026-11-25', context_identity: 'c2', arm_statistics_json: '{}' }]),
  { signal_date: '2026-11-24', context_identity: 'c1', stats: { base: { samples: 12, mean: 0.01 } } })
  assert.deepEqual(latestArmStatistics([{ signal_date: '2026-11-25', context_identity: 'c2', arm_statistics_json: '{}' }]), { signal_date: null, context_identity: null, stats: {} })
})

test('/v1/chain/failure-classes?days=14: status-index seek, final ticket per (job, date), one class each', async () => {
  const body = await endpoint('/v1/chain/failure-classes?days=14', 120, TIMELINE_TTL_S)
  const byKey = Object.fromEntries(body.rows.map((row: any) => [`${row.job_id ?? row.task}|${row.business_date}`, row]))
  const cls = (key: string) => byKey[key]?.class
  assert.equal(cls(`screener-v2-watchdog|${day(X, -1)}`), 'final_failure')
  assert.deepEqual([byKey[`screener-v2-watchdog|${day(X, -1)}`].failure_occurrence, byKey[`screener-v2-watchdog|${day(X, -1)}`].failure_days_in_window,
    byKey[`screener-v2-watchdog|${day(X, -1)}`].non_success_tickets], [3, 3, 3])
  assert.equal(byKey[`screener-v2-watchdog|${day(X, -4)}`].failure_occurrence, 1)
  assert.equal(byKey[`screener-v2-watchdog|${day(X, -1)}`].detail, 'status=failed screener v2 missing date', 'empty last_error: the summary carries the text')
  assert.equal(cls(`evening-chain|${day(X, -2)}`), 'recovered')
  assert.equal(byKey[`evening-chain|${day(X, -2)}`].detail, 'D1 DB is overloaded', 'recovered: the error that was retried')
  assert.equal(cls(`audit-json-retention|${day(X, -1)}`), 'designed_retry')
  assert.equal(cls(`pipeline|${day(X, -3)}`), 'upstream_blocked')
  assert.equal(byKey[`pipeline|${day(X, -3)}`].final_known, false)
  assert.equal(cls(`sector-leaders|${day(X, -3)}`), 'orphan_running')
  assert.equal(cls(`premarket-evidence-watchdog|${day(X, -2)}`), 'unsettled_triggered')
  assert.equal(cls(`intraday-check|${X}`), 'in_progress')
  assert.equal(cls(`active8-oof-monthly|${day(X, -3)}`), 'final_failure', 'a dispatch receipt is not a closure')
  assert.equal(cls(`kv-config-drift|${day(X, -1)}`), 'recovered')
  assert.ok(body.rows.every((row: any) => row.business_date >= day(X, -13)), 'window start')
  assert.equal(body.truncated, false)
  assert.equal(body.classes.final_failure, 4 + 1)
  assert.equal(body.by_job[0].job_id, 'screener-v2-watchdog')
  assert.equal((await call('/v1/chain/failure-classes?days=0')).status, 400)
  assert.equal((await call('/v1/chain/failure-classes?days=15')).status, 400)
})

test('/v1/kv-drift: latest ticket per date, digest prefixes dropped', async () => {
  const body = await endpoint('/v1/kv-drift', 40, KV_DRIFT_TTL_S)
  assert.equal(body.rows.length, 7)
  assert.equal(body.latest.business_date, X)
  assert.deepEqual([body.latest.drift, body.latest.drifted_keys, body.latest['trading:config'], body.latest['trading:risk_config'], body.latest.stored_risk_v2],
    [true, 'trading:config', 'drift', 'match', 'match'])
  assert.doesNotMatch(body.latest.summary, /[0-9a-f]{12}/)
  assert.equal(body.rows[1].status, 'success', 'X−1 retried to a success')
  assert.equal(body.rows[1].drift, false)
})

test('parseKvDriftSummary: a failed manifest fetch has no key verdicts', () => {
  assert.deepEqual(parseKvDriftSummary('kv_config_manifest_unavailable:503').keys, [])
  assert.equal(parseKvDriftSummary('x | stored_risk_v2_drift_error boom').stored_risk_v2, 'error')
})

test('every p4 query is read-only and EXPLAINs without a table SCAN or temp B-tree', async () => {
  assert.ok(queries.length >= 15, `queries=${queries.length}`)
  const seen = new Set<string>()
  for (const query of queries) {
    const key = `${query.db}|${query.sql}`
    if (seen.has(key)) continue
    seen.add(key)
    const label = `${query.db}: ${query.sql.replace(/\s+/g, ' ').slice(0, 160)}`
    assert.deepEqual(await tableScans(fx.raw[query.db], query), [], label)
    assert.deepEqual(await tempSorts(fx.raw[query.db], query), [], label)
  }
  for (const path of Object.keys(P4_ROUTES)) assert.ok(measured[path] != null, path)
  console.log('p4 rows_read', JSON.stringify(measured))
})
