/** Dumps the monitoring Worker's real responses for a seeded evening, for `build.mjs --mode fixture`.
 * Run from worker/ (it uses the Worker's own handler, Miniflare D1 and test doubles):
 *   node --import tsx ../infra/grafana/build/dump-fixtures.mts <out dir> [now ISO]
 * The scenario: the last 12 weekdays of chains, two recurring failures, and X in flight at 23:40 Taiwan
 * (FinLab published, the pipeline in L2). The other three chains: 12 intraday days, 5 weekly and 3 monthly periods,
 * the weekly root failing every week (as in prod since 10/25). */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const src = (file: string) => pathToFileURL(join(process.cwd(), 'src/monitoring', file)).href
const { createMonitoringHandler, ROUTES } = await import(src('index.ts'))
const { CHAIN_ID } = await import(src('chain.ts'))
const { CHAIN_IDS, periodKeyFor, periodKeys } = await import(src('judgment/chainCatalog.ts'))
const { startFixture, insertRows, weekdays, day, seedStageProgress, PIPELINE_RUN_PHASES } = await import(src('monitoringFixture.testSupport.ts'))
const { accessHeaders, accessKeys, TEST_AUD, TEST_TEAM, TEST_TOKEN } = await import(src('monitoringAuth.testSupport.ts'))
const { STRATEGY_ROUTE_CHALLENGER_VERSION } = await import(pathToFileURL(join(process.cwd(), 'src/lib/strategyRouteCalibration.ts')).href)

const out = process.argv[2]
if (!out) throw new Error('usage: dump-fixtures.mts <out dir> [now ISO]')
const TW = 8 * 3600_000
// Default now: the most recent 23:40 Taiwan on a weekday.
function defaultNow(): number {
  let at = Date.parse(new Date(Date.now() + TW).toISOString().slice(0, 10) + 'T15:40:00Z')
  while (at > Date.now() || [0, 6].includes(new Date(at + TW).getUTCDay())) at -= 86_400_000
  return at
}
const NOW = process.argv[3] ? Date.parse(process.argv[3]) : defaultNow()
const X = new Date(NOW + TW).toISOString().slice(0, 10)
const tw = (date: string, hhmm: string, plusDays = 0) => new Date(Date.parse(`${day(date, plusDays)}T${hhmm}:00Z`) - TW).toISOString()

/** [stage, optional, start (Taiwan), end, deadline, day offset of all three]. Times follow expected_by_proposal.md. */
const PLAN: Array<[string, 0 | 1, string, string, string | null, number]> = [
  ['market-close-refresh', 0, '18:10', '18:12', '18:30', 0], ['finlab-v4-backfill', 0, '21:46', '22:08', '22:45', 0],
  ['finlab-backfill-watchdog', 1, '22:10', '22:10', null, 0], ['update', 0, '22:08', '22:11', '22:50', 0],
  ['indicator-queue', 0, '22:11', '22:16', '23:00', 0], ['regime-compute', 0, '22:16', '22:24', '23:30', 0],
  ['strategy-learning-mature-evidence', 0, '22:24', '22:31', '23:15', 0], ['screener', 0, '22:31', '22:44', '23:30', 0],
  ['allocator-ev-readiness', 0, '22:44', '22:46', '23:30', 0], ['pipeline', 0, '22:46', '07:30', '08:00', 1],
  ['ml-predict', 0, '22:50', '00:35', '08:00', 1], ['dataset-snapshot-export', 0, '14:21', '14:56', '15:30', 1],
  ['allocator-ev-feature-snapshot-backfill', 0, '14:20', '14:20', '14:45', 1], ['us-leading', 0, '06:30', '06:31', '07:00', 1],
  ['news-analyst', 0, '06:45', '06:52', '07:15', 1], ['morning-setup', 0, '08:40', '08:42', '08:50', 1],
  ['recommendation', 0, '07:28', '07:30', '08:00', 1], ['pre-market-warmup', 0, '08:40', '08:41', '08:50', 1],
  ['premarket-evidence-watchdog', 1, '08:45', '08:45', null, 1], ['post-pipeline-chain', 0, '14:20', '14:21', '14:45', 1],
  ['verify-v2', 0, '14:21', '14:22', '14:45', 1], ['post-verify-chain', 0, '14:22', '14:29', '15:00', 1],
  ['active8-oof-daily', 0, '14:30', '14:52', '15:30', 1], ['allocator-ev-lifecycle-watchdog', 1, '14:55', '14:56', null, 1],
  ['model-ic-rolling', 0, '14:29', '14:29', '15:00', 1], ['linucb-reward-ledger', 0, '14:30', '14:30', '15:00', 1],
  ['adapt', 0, '14:30', '14:30', '15:00', 1], ['daily-report', 0, '14:30', '14:30', '15:00', 1],
  ['paper-active-postmarket', 1, '14:31', '14:33', null, 1], ['obsidian-sync', 1, '14:33', '14:33', null, 1],
  ['meta-learning-shadow', 1, '14:33', '14:36', null, 1], ['strategy-learning', 1, '14:36', '14:50', null, 1],
  ['evening-closure', 0, '14:56', '14:57', '15:30', 1],
]
const SKIPPED = new Set(['adapt', 'daily-report'])
/** Final errors on past dates: two recurring stages and one single failure. */
const FAILED: Record<string, Array<[number, string]>> = {
  'allocator-ev-lifecycle-watchdog': [[1, 'lifecycle window: no matured snapshot for the signal date'], [6, 'lifecycle window: no matured snapshot for the signal date']],
  'active8-oof-daily': [[2, 'daily closure: l4_distribution unscored 2 of 737']],
  'post-verify-chain': [[5, 'post-verify fan-out incomplete: strategy-learning not settled']],
}
const RETRIED: Record<string, number[]> = { 'finlab-v4-backfill': [3, 8], pipeline: [1] }

function clock(date: string, hhmm: string, offset: number, start?: string) {
  // A stage that starts in the evening and ends after midnight ends on the next calendar day.
  return tw(date, hhmm, offset || (start && hhmm < start ? 1 : 0))
}

async function seedChain(db: D1Database) {
  const state: Record<string, unknown>[] = []
  const transitions: Record<string, unknown>[] = []
  const dates = weekdays(X, 12) as string[]
  dates.forEach((date, age) => {
    for (const [stage, optional, start, end, deadline, offset] of PLAN) {
      // An overnight stage (pipeline, ml-predict) starts the evening before the day its end and deadline fall on.
      const startedAt = clock(date, start, offset && start > end ? offset - 1 : offset)
      const endedAt = clock(date, end, offset, offset ? undefined : start)
      const expectedBy = deadline ? clock(date, deadline, offset) : null
      const failure = FAILED[stage]?.find(([d]) => d === age)
      const retried = RETRIED[stage]?.includes(age)
      const inFlight = age === 0
      const started = !inFlight || Date.parse(startedAt) <= NOW
      const ended = !inFlight || Date.parse(endedAt) <= NOW
      const status = !started ? 'pending' : !ended ? 'running' : failure ? 'error' : SKIPPED.has(stage) ? 'skipped' : 'success'
      const attempt = started ? (retried ? 2 : 1) : 0
      state.push({ business_date: date, chain_id: CHAIN_ID, stage_id: stage, status, optional, expected_by: expectedBy, attempt,
        started_at: started ? startedAt : null, completed_at: ended ? endedAt : null,
        execution_name: stage === 'pipeline' && started ? `pipeline-v2-${date.replaceAll('-', '')}` : null,
        // The sub-stage cards only accept progress of the run the state row names.
        run_id: !started ? null : stage === 'finlab-v4-backfill' ? `finlab-${date}` : stage === 'pipeline' ? `pipeline-${date}` : null,
        heartbeat_at: status === 'running' && stage === 'finlab-v4-backfill' ? new Date(NOW - 2 * 60_000).toISOString() : null,
        summary: status === 'success' ? 'ok' : null, error: status === 'error' ? failure![1] : null,
        updated_at: ended ? endedAt : started ? startedAt : tw(date, '18:10') })
      const push = (at: string, to: string, from: string | null, n: number) => transitions.push({ business_date: date, chain_id: CHAIN_ID,
        stage_id: stage, transition_at: at, to_status: to, from_status: from, attempt: n })
      push(tw(date, '18:10'), 'pending', null, 0)
      if (started && retried) {
        const first = new Date(Date.parse(startedAt) - 20 * 60_000).toISOString()
        push(first, 'running', 'pending', 1)
        push(new Date(Date.parse(startedAt) - 60_000).toISOString(), 'error', 'running', 1)
        push(startedAt, 'running', 'error', 2)
      } else if (started) push(startedAt, 'running', 'pending', 1)
      if (ended) push(endedAt === startedAt ? new Date(Date.parse(endedAt) + 1000).toISOString() : endedAt, status, 'running', attempt)
    }
  })
  await insertRows(db, 'ops_chain_stage_state_v1', state)
  await insertRows(db, 'ops_chain_stage_transitions_v1', transitions)
  // Sub-stage progress for the two dates the state endpoint serves: X mid-run, X−1 finished.
  const finlab = (date: string) => ({ runId: `finlab-${date}`, phases: ['completed', 'completed', 'completed'], startedAt: tw(date, '21:46'), phaseMs: 22 * 60_000 / 3 })
  await seedStageProgress(db, dates[0], { finlab: finlab(dates[0]), pipeline: { runId: `pipeline-${dates[0]}`, execution: { status: 'running' },
    batches: [{ phase: 'input_prep', completed: 8, total: 8 }],
    progress: { phase: 'node_l2_timesfm_enrich', status: 'running', done: PIPELINE_RUN_PHASES.slice(0, 8), startedAt: tw(dates[0], '22:46'), phaseMs: 6 * 60_000 } } })
  await seedStageProgress(db, dates[1], { finlab: finlab(dates[1]), pipeline: { runId: `pipeline-${dates[1]}`, execution: { status: 'success' },
    batches: [{ phase: 'input_prep', completed: 8, total: 8 }],
    progress: { phase: 'node_write_d1', status: 'completed', done: PIPELINE_RUN_PHASES, startedAt: tw(dates[1], '22:46'), phaseMs: 6 * 60_000 } } })
}

/** [stage, optional, day offset, start, end, deadline] in Taiwan time from the period key; null deadline = PAUSED or optional
 * (the row stays pending when start is null). Times follow the catalog's expected_by and infra/gcp-scheduler-jobs.json. */
type OtherPlan = Array<[string, 0 | 1, number, string | null, string | null, string | null]>
const OTHER: Record<string, { keys: (x: string) => string[]; created: string; plan: OtherPlan; failed: Record<string, Array<[number, string]>> }> = {
  intraday_guard: {
    keys: (x) => weekdays(x, 12) as string[], created: '09:00',
    plan: [['intraday-check', 0, 0, '09:00', '13:30', '09:10'], ['eod-exit', 0, 0, '13:25', '13:26', '13:30'],
      ['post-close-price-refresh', 0, 0, '13:40', '13:41', '13:50'], ['daily-snapshot', 0, 0, '14:20', '14:21', '14:40'],
      ['rescore-10', 0, 0, '10:00', '10:01', '10:10'], ['rescore-11', 0, 0, '11:00', '11:01', '11:10'],
      ['rescore-12', 0, 0, '12:00', '12:01', '12:10'], ['rescore-1230', 0, 0, '12:30', '12:31', '12:40']],
    failed: { 'rescore-1230': [[1, 're-score: L4 snapshot not ready'], [4, 're-score: L4 snapshot not ready']], 'daily-snapshot': [[3, 'daily snapshot: close price not settled']] },
  },
  weekly_research: {
    keys: (x) => periodKeys('weekly_research', periodKeyFor('weekly_research', x), 5), created: '18:30',
    plan: [['weekly-audit', 0, 0, '18:30', '18:38', '19:00'], ['storage-integrity-audit', 0, 2, '03:30', '03:41', '04:00'],
      ['model-ic-full-check', 0, 0, '19:30', '19:42', '20:00'], ['weekly-backtest', 0, 2, '06:00', '06:24', '07:00'],
      ['alpha-quality', 0, 2, '06:00', '06:09', '06:30'], ['active8-oof-weekly', 0, 2, null, null, null],
      ['weekly-optuna', 1, 2, '01:00', '01:32', null], ['sector-leaders', 1, 1, '08:00', '08:05', null],
      ['adaptive-meta-policy-replay', 1, 2, '08:00', '08:04', null], ['s12-smcvwap-calibration', 1, 2, '08:30', '08:41', null],
      ['linucb-multiplier-replay', 1, 2, '09:00', '09:03', null], ['weekly-cleanup', 0, 2, '04:00', '04:02', '04:30'],
      ['weekly-readiness', 0, 2, '12:00', '12:01', '12:30']],
    failed: { 'weekly-readiness': [0, 1, 2, 3, 4].map((n) => [n, 'weekly root: required job not success (CorporateCoverage)'] as [number, string]),
      'storage-integrity-audit': [[0, 'artifact s12_research_minute_bars:2026-08-07 checksum mismatch']], 'model-ic-full-check': [[2, 'D1 HTTP 400']] },
  },
  monthly_artifact: {
    keys: (x) => periodKeys('monthly_artifact', periodKeyFor('monthly_artifact', x), 3), created: '10:00',
    // -1 = the month's first Sunday (sun() anchor), which can fall before the key.
    plan: [['monthly-strategy-mining', 0, 0, '10:00', '10:48', '13:00'], ['monthly-optuna', 0, 0, null, null, null],
      ['active8-oof-monthly', 0, -1, null, null, null], ['monthly-readiness', 0, -1, '12:30', '12:31', '13:00']],
    failed: {},
  },
}

async function seedOtherChains(db: D1Database) {
  const state: Record<string, unknown>[] = []
  const transitions: Record<string, unknown>[] = []
  for (const [chainId, chain] of Object.entries(OTHER)) {
    chain.keys(X).filter((key) => key <= X).forEach((key, age) => {
      const firstSunday = day(`${key.slice(0, 7)}-01`, (7 - new Date(`${key.slice(0, 7)}-01T00:00:00Z`).getUTCDay()) % 7)
      const at = (offset: number, hhmm: string) => offset < 0 ? tw(firstSunday, hhmm) : tw(key, hhmm, offset)
      for (const [stage, optional, offset, start, end, deadline] of chain.plan) {
        const startedAt = start ? at(offset, start) : null
        const endedAt = end ? at(offset, end) : null
        const failure = chain.failed[stage]?.find(([n]) => n === age)
        const started = startedAt !== null && Date.parse(startedAt) <= NOW
        const ended = endedAt !== null && Date.parse(endedAt) <= NOW
        // The repeating guard's row is the worst result so far, never running.
        const repeat = stage === 'intraday-check'
        const status = !started ? 'pending' : !ended && !repeat ? 'running' : failure ? 'error' : 'success'
        const createdAt = [at(0, chain.created), startedAt].filter(Boolean).sort()[0] as string
        state.push({ business_date: key, chain_id: chainId, stage_id: stage, status, optional, expected_by: deadline ? at(offset, deadline) : null,
          attempt: started ? 1 : 0, started_at: started ? startedAt : null, completed_at: ended ? endedAt : null, execution_name: null, run_id: null,
          heartbeat_at: null, summary: status === 'success' ? 'ok' : null, error: status === 'error' ? failure![1] : null,
          updated_at: ended ? endedAt : started ? (repeat ? new Date(NOW - 60_000).toISOString() : startedAt) : createdAt })
        const push = (when: string, to: string, from: string | null, n: number) => transitions.push({ business_date: key, chain_id: chainId,
          stage_id: stage, transition_at: when, to_status: to, from_status: from, attempt: n })
        push(createdAt, 'pending', null, 0)
        if (started && !repeat) push(new Date(Date.parse(startedAt!) + 1000).toISOString(), 'running', 'pending', 1)
        if (started && (ended || repeat) && status !== 'pending') push(repeat && !ended ? startedAt! : endedAt!, status, repeat ? 'pending' : 'running', 1)
      }
    })
  }
  await insertRows(db, 'ops_chain_stage_state_v1', state)
  await insertRows(db, 'ops_chain_stage_transitions_v1', transitions)
}

async function seedMarket(db: D1Database) {
  const run = (statement: string) => db.prepare(statement).run()
  const values = (dates: string[]) => dates.map((d) => `('${d}')`).join(',')
  const recent = weekdays(X, 3) as string[]
  const stocks = `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 2223), d(dt) AS (VALUES ${values(recent)})`
  await run(`${stocks} INSERT INTO stock_prices (stock_id, date, open, high, low, close, volume) SELECT i, dt, 10, 11, 9, 10, 1000 FROM s, d`)
  // Technical indicators and chip data lag one session: the evening chain has not written X yet.
  await run(`${stocks} INSERT INTO technical_indicators (stock_id, date) SELECT i, dt FROM s, d WHERE dt < '${X}'`)
  await run(`${stocks} INSERT INTO chip_data (symbol, date) SELECT printf('%04d', i), dt FROM s, d`)
  await run(`${stocks} INSERT INTO canonical_market_daily (stock_id, date, source, lineage_json, as_of_date, market_segment, close, volume, value)
    SELECT printf('%04d', i), dt, 'finlab.price', '{}', dt, CASE WHEN i % 7 = 0 THEN 'EMERGING' ELSE 'LISTED_OTC' END, 10 + i % 5, 1000, 10000 FROM s, d`)
  const long = `d(dt) AS (VALUES ${values(weekdays(X, 60) as string[])})`
  await run(`WITH sym(s) AS (VALUES ('TWII'),('TWOII')), ${long}
    INSERT INTO canonical_market_index_daily (symbol, date, source, lineage_json, as_of_date, close) SELECT s, dt, 'finlab', '{}', dt, 1 FROM sym, d`)
  await run(`WITH cm(m) AS (VALUES ('202612'),('202701')), ${long}
    INSERT INTO canonical_futures_daily (symbol, date, contract_month, session, source, lineage_json, as_of_date, close)
    SELECT 'TXF', dt, m, 'day', 'taifex', '{}', dt, 1 FROM cm, d`)
  await run(`WITH seg(s) AS (VALUES ('TWSE'),('TPEX')), ${long}
    INSERT INTO canonical_market_summary_daily (date, market_segment, source, lineage_json, as_of_date, margin_balance_value, short_balance_units)
    SELECT dt, s, 'twse', '{}', dt, 1, 1 FROM seg, d WHERE dt < '${X}'`)
  await run(`WITH seg(s) AS (VALUES ('TWSE'),('TPEX')), inv(v) AS (VALUES ('foreign'),('trust'),('dealer')), ${long}
    INSERT INTO canonical_institutional_amount_daily (date, market_segment, investor, source, lineage_json, as_of_date)
    SELECT dt, s, v, 'twse', '{}', dt FROM seg, inv, d`)
  await run(`WITH ds(x) AS (VALUES ('tw_option_put_call_ratio'),('tw_taifex_futures_large_trader'),('tw_business_indicators')), ${long}
    INSERT INTO canonical_regime_context_daily (date, dataset, field, category, source, lineage_json, as_of_date)
    SELECT dt, x, 'a', 'all', 'finlab', '{}', dt FROM ds, d`)
  await run(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 11)
    INSERT INTO external_evidence_items (source_id, source_kind, title, published_at, source_url, allowed_use, decision_effect,
      source_quality_score, entity_linking_confidence, accepted)
    SELECT 'gdelt_events', 'news', 't', strftime('%Y-%m-%dT%H:%M:%SZ', '${X}T04:00:00Z', printf('-%d hours', i * 20)), 'u', 'context', 'none', 1, 1, 1 FROM n`)
  await run(`INSERT INTO source_quality_metrics (source, dataset, as_of_date, freshness_status, metrics_json)
    VALUES ('gdelt_events', 'global_event_pressure', '${X}', 'fresh', '{}')`)
}

async function seedRest(raw: Record<string, D1Database>) {
  const bindings = ['DB', 'CORE_DB', 'MARKET_DB', 'LEARNING_DB', 'OPS_DB', 'EXECUTION_DB', 'PAPER_DB', 'RESEARCH_DB']
  const sizes: Record<string, [number, number]> = { DB: [9.1e9, 0], CORE_DB: [0.4e9, 1e6], MARKET_DB: [7.0e9, 9e6], LEARNING_DB: [7.1e9, 2.4e7],
    OPS_DB: [2.6e9, 6e6], EXECUTION_DB: [0.1e9, 2e5], PAPER_DB: [0.6e9, 1.5e6], RESEARCH_DB: [1.2e9, 3e6] }
  await insertRows(raw.OPS_DB, 'storage_capacity_daily', Array.from({ length: 45 }, (_, i) => day(X, -i - 1)).flatMap((date: string, i: number) =>
    bindings.map((binding) => ({ observed_date: date, domain: binding.replace('_DB', '').toLowerCase(), binding_name: binding,
      used_bytes: Math.round(sizes[binding][0] - i * sizes[binding][1]), max_bytes: 1e10, utilization_pct: 40, status: 'healthy',
      measurement_source: 'd1_result_meta_size_after', observed_at: `${date} 01:00:00` }))))
  await insertRows(raw.LEARNING_DB, 'strategy_route_calibration_runs_v1', (weekdays(X, 30) as string[]).flatMap((date, i) => [
    { run_id: `c-${date}`, artifact_version: 'a', as_of_date: date, status: 'pending_maturity', candidate_route_version: STRATEGY_ROUTE_CHALLENGER_VERSION,
      sample_count: 10 + i, date_count: 5, paired_sample_count: 0, created_at: `${date}T10:00:00Z`, gate_json: '{}' },
    ...(i < 3 ? [] : [{ run_id: `p-${date}`, artifact_version: 'a', as_of_date: date, status: 'pass', candidate_route_version: 'older-route-v1',
      sample_count: 40, date_count: 20, paired_sample_count: 30, created_at: `${date}T09:00:00Z`, gate_json: '{}' }]),
  ]))
  await insertRows(raw.LEARNING_DB, 'rfs_sparse_comparisons_v1', (weekdays(X, 20) as string[]).map((date) => ({
    plan_id: `plan-${date}`, schema_version: 'rfs-b-sparse-comparison-v1', signal_date: date, policy_identity: 'p', allocation_snapshot_id: 's',
    observed_at: `${date}T12:00:00Z`, status: 'collecting', packet_checksum: 'a'.repeat(64),
    payload_json: JSON.stringify({ model_checksum: 'm', validation_blockers: [], source_expected_return_candidate_count: 12 }) })))
  await insertRows(raw.PAPER_DB, 'l4_portfolio_head_v1', [{ account_id: 1, plan_id: null }])
  await insertRows(raw.PAPER_DB, 'paper_order_intents', (weekdays(X, 20) as string[]).flatMap((date) => Array.from({ length: 6 }, (_, i) => ({
    account_id: 1, trade_date: date, symbol: String(2300 + i), side: i % 2 ? 'buy' : 'sell', source: 'l4' }))))
}

const fx = await startFixture()
try {
  await seedMarket(fx.raw.MARKET_DB)
  await seedChain(fx.raw.OPS_DB)
  await seedOtherChains(fx.raw.OPS_DB)
  await seedRest(fx.raw)
  const keys = await accessKeys()
  const handler = createMonitoringHandler({ now: () => NOW, fetch: keys.fetcher, cache: null })
  const env = { ...fx.env, ACCESS_TEAM_DOMAIN: TEST_TEAM, ACCESS_AUD: TEST_AUD, MONITORING_READ_TOKEN: TEST_TOKEN }
  mkdirSync(out, { recursive: true })
  // The paths the dashboards query, parameters included.
  const paths = [...Object.keys(ROUTES).map((path) => (path === '/v1/chain/timeline' ? `${path}?days=14` : path === '/v1/chain/history' ? `${path}?days=14` : path)),
    ...(CHAIN_IDS as string[]).filter((id) => id !== CHAIN_ID).flatMap((id) => [`/v1/chain/state?chain=${id}`, `/v1/chain/history?days=14&chain=${id}`])]
  const index: Record<string, string> = {}
  for (const path of paths) {
    const response = await handler(new Request(`https://monitoring.test${path}`, { headers: await accessHeaders(keys, NOW) }), env)
    if (response.status !== 200) throw new Error(`${path} → ${response.status} ${await response.text()}`)
    const file = `${path.replace(/^\/v1\//, '').replace(/[/?=]/g, '-')}.json`
    writeFileSync(join(out, file), `${JSON.stringify(await response.json(), null, 1)}\n`)
    index[path] = file
  }
  writeFileSync(join(out, 'index.json'), `${JSON.stringify({ now: new Date(NOW).toISOString(), business_date: X, files: index }, null, 1)}\n`)
  console.log(`fixtures for ${X} (now ${new Date(NOW).toISOString()}):`, Object.keys(index).join(' '))
} finally {
  await fx.mf.dispose()
}
