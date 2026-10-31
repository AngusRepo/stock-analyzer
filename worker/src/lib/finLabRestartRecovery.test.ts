import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { finLabRequiresFullCapture, processUpdateBatch, runDailyUpdate, runFinLabBackfillWatchdog } from './updateOrchestrator'
import { finLabCompositionBlockerSuffix, finLabStartMarkerKey } from './finLabDispatchFence'
import { queueFinLabCompletion } from './finlabCompletionOutbox'
import { finLabRequiredFieldsForLane } from './finlabSourceContract'
import type { Bindings } from '../types'

// Bug 3 (restart stuck at the serving-table gate / superseded stage), Bug 4 (canonical not-ready burns the
// stage budget), D4 (composition requires a full capture). 2026-10-29 is the incident date.
const date = '2026-10-29', prev = '2026-10-28'
const finlabRunId = 'finlab-v4-daily-20261029-1793282705129'
const at = (clock: string, day = date) => Date.parse(`${day}T${clock}:00+08:00`)
const FULL_CAPTURE = 'daily_inference_composition_requires_full_capture'

type Market = { chipMissing?: boolean; twoiiMissing?: boolean; summaryMissing?: boolean; brokerReadsBeforeD1Error?: number; staleFromRead?: { table: string; read: number } }

/** Market/Core/legacy D1: answers the readiness queries by shape; writes are accepted and ignored. */
function marketDb(m: Market) {
  let brokerReads = 0
  let staleReads = 0
  const first = (sql: string, args: unknown[]) => {
    // A serving table can go stale between the readiness reads of one continuation.
    if (m.staleFromRead && sql.match(/FROM (\w+)/)?.[1] === m.staleFromRead.table) {
      if (/MAX\(date\) AS latest_date/.test(sql) && staleReads > m.staleFromRead.read) return { latest_date: prev }
      if (/COUNT\(/.test(sql) && args[0] === date && staleReads++ >= m.staleFromRead.read) return { count: 0 }
    }
    if (m.brokerReadsBeforeD1Error !== undefined && /canonical_broker_flow_daily/.test(sql)
      && brokerReads++ >= m.brokerReadsBeforeD1Error) throw new Error('D1_ERROR: simulated market read failure')
    const table = sql.match(/FROM (\w+)/)?.[1] ?? ''
    const serving = table === 'chip_data' || table === 'margin_data'
    if (/MAX\(date\) AS latest_date/.test(sql)) return { latest_date: serving && m.chipMissing ? prev : date }
    if (table === 'market_breadth') return { advance_count: 500, decline_count: 400, unchanged_count: 100, sample_size: 1000 }
    if (table === 'source_quality_metrics') return { freshness_status: 'fresh', latest_materialization: `${date}T13:00:00Z` }
    if (table === 'canonical_trading_restrictions') return { count: 10 }
    if (table === 'canonical_market_index_daily') return { count: /TWOII/.test(sql) && m.twoiiMissing ? 0 : 1 }
    if (/COUNT\(DISTINCT market_segment\)/.test(sql)) return { count: m.summaryMissing ? 0 : 2 }
    if (/COUNT\(/.test(sql)) return { count: serving && m.chipMissing && args[0] === date ? 0 : 5000 }
    return null
  }
  const db: any = {
    prepare(sql: string) {
      let args: unknown[] = []
      const statement: any = {
        bind(...values: unknown[]) { args = values; return statement },
        async first() { return first(sql, args) },
        async all() {
          // Serving prices: 1000 TWSE + 800 OTC rows resolved through the core stock identities.
          if (/FROM stock_prices\s+WHERE date = \?/.test(sql)) return { success: true, results: Array.from({ length: 1800 }, (_, i) => ({ stock_id: i + 1 })) }
          if (/FROM stocks\s+WHERE id IN/.test(sql)) return { success: true, results: args.map((id) => ({ id, symbol: String(id), market: Number(id) <= 1000 ? 'TWSE' : 'OTC' })) }
          return { success: true, results: [] }
        },
        async run() { return { success: true, meta: { changes: 0 } } },
      }
      return statement
    },
    async batch() { return [] },
  }
  return db as D1Database
}

async function fixture(t: any, market: Market = {}) {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', d1Databases: ['OPS'] })
  t.after(() => mf.dispose())
  const ops = await mf.getD1Database('OPS')
  await ops.batch([
    ops.prepare(`CREATE TABLE pipeline_stage_runs(business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,cursor_key TEXT,
      processed_count INTEGER DEFAULT 0,expected_count INTEGER,persisted_count INTEGER DEFAULT 0,attempt_count INTEGER DEFAULT 0,
      lease_owner TEXT,lease_expires_at TEXT,queued_at TEXT,started_at TEXT,completed_at TEXT,last_error TEXT,updated_at TEXT,
      PRIMARY KEY(business_date,stage))`),
    ops.prepare(`CREATE TABLE source_key_report(target_date TEXT,lane TEXT,field TEXT,api_key TEXT,required INTEGER,status TEXT,
      rows INTEGER,target_rows INTEGER,latest_date TEXT,updated_at TEXT)`),
    ops.prepare(`CREATE TABLE source_diff_report(run_id TEXT,source TEXT,dataset_lane TEXT,finlab_rows INTEGER)`),
    ops.prepare('CREATE TABLE scheduler_locks(lock_key TEXT PRIMARY KEY,owner TEXT,run_date TEXT,run_id TEXT,created_at TEXT,expires_at TEXT)'),
    ops.prepare(`CREATE TABLE system_logs(id INTEGER PRIMARY KEY,level TEXT,cron_name TEXT,message TEXT,meta TEXT,created_at TEXT)`),
    ...['pe', 'pb'].map((field) => ops.prepare(`INSERT INTO source_key_report VALUES (?,?,?,?,1,'ok',5000,5000,?,?)`)
      .bind(date, 'fundamental_factor_diversity', field, field, date, `${date}T13:00:00Z`)),
  ])
  const store = new Map<string, { value: string; expires: number }>()
  const KV = {
    async get(key: string, type?: string) {
      const hit = store.get(key)
      if (!hit || hit.expires <= Date.now()) return null
      return type === 'json' ? JSON.parse(hit.value) : hit.value
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, { value, expires: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : Infinity })
    },
    async delete(key: string) { store.delete(key) },
    async list() { return { keys: [] } },
  }
  const sent: any[] = []
  const db = marketDb(market)
  const env = {
    MULTI_D1_ACTIVE_DOMAINS: 'core,market,learning,ops,execution,paper,research',
    OFFICIAL_SUPPLEMENTAL_FETCH_MODE: 'disabled',
    ML_CONTROLLER_URL: 'https://controller.invalid', FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED: 'true',
    KV, DB: db, CORE_DB: db, MARKET_DB: db, LEARNING_DB: db, EXECUTION_DB: db, PAPER_DB: db, RESEARCH_DB: db, OPS_DB: ops,
    UPDATE_QUEUE: {
      send: async (msg: any, options?: any) => { sent.push({ ...msg, delaySeconds: options?.delaySeconds ?? 0 }) },
      sendBatch: async (batch: any[]) => { for (const item of batch) sent.push({ ...item.body, delaySeconds: item.delaySeconds ?? 0 }) },
    },
  } as unknown as Bindings
  const dispatches: any[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('https://controller.invalid/finlab/backfill/run')) {
      const body = JSON.parse(String(init?.body))
      dispatches.push(body)
      return Response.json({ status: 'spawned', run_id: body.run_id, function_call_id: `fc-${body.dispatch_attempt}` })
    }
    return new Response('unavailable', { status: 503 })
  })
  const kvSet = (key: string, value: unknown) => store.set(key, { value: JSON.stringify(value), expires: Infinity })
  const log = (task: string) => { const hit = store.get(`scheduler:run:${task}:${date}`); return hit ? JSON.parse(hit.value) : null }
  const setLog = (task: string, entry: Record<string, unknown>) =>
    kvSet(`scheduler:run:${task}:${date}`, { task, run_date: date, run_id: finlabRunId, ...entry })
  const stage = async (name = 'finlab_market') => {
    const row = await ops.prepare('SELECT status,attempt_count,cursor_key,lease_owner,last_error FROM pipeline_stage_runs WHERE business_date=? AND stage=?')
      .bind(date, name).first<any>()
    return row ? { ...row, runId: JSON.parse(row.cursor_key).runId } : null
  }
  const seedStage = (name: string, status: string, attempt: number, runId = finlabRunId, lease: string | null = null) =>
    ops.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,cursor_key,attempt_count,lease_owner,lease_expires_at,queued_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
      .bind(date, name, `${date}:finlab-completion-v1`, status, JSON.stringify({ runId, force: false }), attempt,
        lease, lease ? '2999-01-01 00:00:00' : null).run()
  const systemLogs = async () => (await ops.prepare('SELECT level,cron_name,message FROM system_logs').all<any>()).results ?? []
  const clock = (ms: number) => t.mock.timers.enable({ apis: ['Date'], now: ms })
  return { env, ops, sent, dispatches, log, setLog, kvSet, stage, seedStage, systemLogs, clock, store }
}

const deps = {
  runMarketScreener: async () => ({}),
  runMLAndRiskV2: async () => 'ok',
} as any
const completion = (runId = finlabRunId) =>
  ({ type: 'finlab_backfill_complete', triggerTime: date, runId, force: false, cursor: 0, attempt: 1 }) as any

// ---------------- Bug 3 ----------------

test('B3-1/B3-9: an exhausted finlab_market row is re-armed and the restart (before the cutoff) reaches the serving-table refresh', async (t) => {
  const f = await fixture(t, { chipMissing: true })
  await f.seedStage('finlab_market', 'error', 3)
  await f.seedStage('finlab_sequence', 'error', 3)
  f.clock(at('22:50'))
  const summary = await runDailyUpdate(f.env, false, date)
  assert.doesNotMatch(summary, /non-FinLab source-readiness gate|superseded_delivery|retry_exhausted/)
  assert.match(summary, /^triggered evening-chain: FinLab canonical ready for 2026-10-29; source waiting; queued same-day market data retry/)
  assert.match(summary, /chip latest=2026-10-28 expected=2026-10-29/)
  const row = await f.stage()
  // A waiting result gives the attempt back and re-queues the same run id 120 s later.
  assert.deepEqual([row.runId, row.status, row.attempt_count], [`evening-ready-${date}`, 'queued', 0])
  assert.ok(f.sent.some((msg) => msg.type === 'finlab_backfill_complete' && msg.runId === `evening-ready-${date}` && msg.delaySeconds === 120))
  // finlab_sequence is not touched by the market re-arm.
  const sequence = await f.stage('finlab_sequence')
  assert.deepEqual([sequence.status, sequence.attempt_count, sequence.runId], ['error', 3, finlabRunId])
  assert.ok(f.sent.some((msg) => msg.type === 'source_readiness_retry'))
  assert.equal(f.dispatches.length, 0)
})

test('B3-2: a waiting finlab_market row is re-armed too', async (t) => {
  const f = await fixture(t, { chipMissing: true })
  await f.seedStage('finlab_market', 'waiting', 1)
  f.clock(at('22:50'))
  assert.match(await runDailyUpdate(f.env, true, date), /FinLab canonical ready .*source waiting; queued same-day market data retry/)
  assert.equal((await f.stage()).runId, `evening-ready-${date}`)
})

test('B3-3: a running row with a live lease is not re-armed and nothing reruns', async (t) => {
  const f = await fixture(t, { chipMissing: true })
  await f.seedStage('finlab_market', 'running', 1, finlabRunId, 'live-owner')
  f.clock(at('23:18'))
  const summary = await runDailyUpdate(f.env, true, date)
  assert.match(summary, /status=pending finlab_stage=finlab_market superseded_delivery/)
  const row = await f.stage()
  assert.deepEqual([row.status, row.runId, row.lease_owner, row.attempt_count], ['running', finlabRunId, 'live-owner', 1])
  assert.ok(!f.sent.some((msg) => msg.type === 'source_readiness_retry'))
})

test('B3-4: a completed finlab_market row is not re-armed; the stuck readiness is logged', async (t) => {
  const f = await fixture(t, { chipMissing: true })
  await f.seedStage('finlab_market', 'success', 1)
  f.clock(at('23:18'))
  const summary = await runDailyUpdate(f.env, true, date)
  assert.match(summary, /^running: evening-chain root found finlab_market already complete but source readiness still waiting/)
  assert.deepEqual([(await f.stage()).status, (await f.stage()).runId], ['success', finlabRunId])
  assert.ok((await f.systemLogs()).some((row: any) => row.level === 'warn' && row.cron_name === 'evening-chain'))
  assert.equal(f.log('evening-chain').status, 'running')
})

test('B3-5: a missing FinLab canonical lane still goes to a FinLab refetch, not the continuation', async (t) => {
  const f = await fixture(t, { chipMissing: true, twoiiMissing: true })
  await f.seedStage('finlab_market', 'error', 3)
  f.clock(at('23:18'))
  const summary = await runDailyUpdate(f.env, true, date)
  assert.match(summary, /awaiting FinLab canonical callback/)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.dispatches[0].lanes, 'regime_context')
  const row = await f.stage()
  assert.deepEqual([row.status, row.attempt_count, row.runId], ['error', 3, finlabRunId])
})

test('B3-6: only the official market summary missing hands off to the continuation', async (t) => {
  const f = await fixture(t, { summaryMissing: true })
  f.clock(at('22:50'))
  const summary = await runDailyUpdate(f.env, false, date)
  assert.match(summary, /^triggered evening-chain: FinLab canonical ready .*source waiting; queued official market summary retry/)
  assert.equal(f.dispatches.length, 0)
})

test('B3-7: a forced historical replay re-arms the stage instead of returning a superseded no-op', async (t) => {
  const f = await fixture(t, { chipMissing: true })
  await f.seedStage('finlab_market', 'error', 3)
  f.kvSet('market:twse_holiday_schedule:v2:2026', { schemaVersion: 'twse-holiday-schedule-v2', dates: [] })
  f.clock(at('01:00', '2026-10-30'))
  // The re-armed continuation really runs; past the cutoff the missing serving data ends the date terminal.
  assert.match(await runDailyUpdate(f.env, true, date), /^failed: finlab_continuation_cutoff_terminal: .*chip latest=2026-10-28/)
  const row = await f.stage()
  // Failed attempt 1 (error, re-queued 120 s later by the outbox).
  assert.deepEqual([row.runId, row.status, row.attempt_count], [`historical-replay-${date}`, 'queued', 1])
  assert.match(row.last_error, /finlab_continuation_cutoff_terminal/)
})

test('B3-8: a non-force restart while the chain is in flight is still suppressed', async (t) => {
  const f = await fixture(t, { chipMissing: true })
  await f.seedStage('finlab_market', 'error', 3)
  f.setLog('evening-chain', { status: 'running', summary: 'in flight', timestamp: new Date(at('23:10')).toISOString() })
  f.clock(at('23:18'))
  assert.match(await runDailyUpdate(f.env, false, date), /already in flight/)
  assert.equal((await f.stage()).runId, finlabRunId)
})

// ---------------- Bug 4 ----------------

test('B4-1/B4-2: canonical not-ready waits without spending attempts; one readiness retry per 10 minutes', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.setLog('finlab-v4-backfill', { status: 'success', summary: 'FinLab V4 backfill status=ready dispatch_attempt=1' })
  for (let minute = 0; minute <= 26; minute += 2) {
    f.clock(at('22:32') + minute * 60_000)
    await processUpdateBatch(completion(), f.env, deps)
    const row = await f.stage()
    assert.equal(row.status, 'queued', `delivery at +${minute}m`)
    assert.equal(row.attempt_count, 0, `delivery at +${minute}m`)
    t.mock.timers.reset()
  }
  assert.equal(f.sent.filter((msg) => msg.type === 'source_readiness_retry').length, 3) // 22:32, 22:42, 22:52
  assert.equal(f.sent.filter((msg) => msg.type === 'finlab_backfill_complete' && msg.delaySeconds === 120).length, 14)
  assert.match(f.log('evening-chain').summary, /FinLab canonical lanes waiting for 2026-10-29 until 23:00 TW cutoff/)
})

test('B4-2: no readiness retry is queued while a FinLab refetch is in flight', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.setLog('finlab-v4-backfill', { status: 'triggered', summary: 'triggered finlab-v4-backfill dispatch_attempt=1' })
  f.clock(at('22:32'))
  await processUpdateBatch(completion(), f.env, deps)
  assert.deepEqual([(await f.stage()).status, (await f.stage()).attempt_count], ['queued', 0])
  assert.equal(f.sent.filter((msg) => msg.type === 'source_readiness_retry').length, 0)
})

test('B4-3/B4-4: from the 23:00 cutoff (and for any past date) the continuation fails as before and is logged', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.clock(at('23:00'))
  await processUpdateBatch(completion(), f.env, deps)
  const row = await f.stage()
  assert.equal(row.attempt_count, 1)
  assert.match(row.last_error, /FinLab canonical daily not ready/)
  const logs = await f.systemLogs()
  assert.ok(logs.some((entry: any) => entry.level === 'error' && /not ready by 23:00 TW cutoff/.test(entry.message)))
  t.mock.timers.reset()
  f.clock(at('01:00', '2026-10-30'))
  await processUpdateBatch(completion(), f.env, deps)
  assert.equal((await f.stage()).attempt_count, 2)
  assert.equal((await f.systemLogs()).filter((entry: any) => /TW cutoff/.test(entry.message)).length, 1)
})

test('B4-5: an error that is not canonical readiness still fails the attempt instead of waiting', async (t) => {
  // The summary pre-check reads broker flow once; the failure hits the canonical readiness read after it.
  const f = await fixture(t, { brokerReadsBeforeD1Error: 1 })
  f.clock(at('22:32'))
  await assert.rejects(processUpdateBatch(completion(), f.env, deps), /simulated market read failure/)
  const row = await f.stage()
  assert.equal(row.attempt_count, 1)
  assert.match(row.last_error, /simulated market read failure/)
  assert.equal(f.sent.filter((msg) => msg.type === 'source_readiness_retry').length, 0)
})

test('B4-6: once the canonical lane lands the next delivery passes the gate into the bulk refresh', async (t) => {
  const f = await fixture(t, { chipMissing: true })
  f.clock(at('22:55'))
  await processUpdateBatch(completion(), f.env, deps)
  assert.match(f.log('evening-chain').summary, /source waiting; queued same-day market data retry .*chip latest=2026-10-28/)
})

// ---------------- D4: full capture ----------------

test('R-0: the callback carries the composition reason from the canonical apply blockers into the summary', () => {
  const blocked = (blockers: unknown[]) => ({ status: 'materializer_blocked', reason: 'source_key_blockers', blockers })
  const reason = { lane: 'regime_context', kind: 'daily_inference_composition', reason: FULL_CAPTURE,
    business_date: date, requested_lanes: ['regime_context'], error: 'no sealed head' }
  const result = { canonical_d1_apply: { per_dataset: {
    canonical_market_index_daily: blocked([reason]),
    canonical_futures_daily: blocked([reason]),
    canonical_regime_context_daily: blocked([{ ...reason, kind: 'other', reason: 'not_composition' }]),
  } } }
  assert.equal(finLabCompositionBlockerSuffix(result), ` composition_blockers=${FULL_CAPTURE}`)
  assert.equal(finLabCompositionBlockerSuffix({ canonical_d1_apply: { per_dataset: { x: blocked([]) } } }), '')
  assert.equal(finLabCompositionBlockerSuffix(undefined), '')
  assert.equal(finLabCompositionBlockerSuffix({ canonical_d1_apply: { per_dataset: { x: blocked([{ ...reason, reason: 'a b;c' }]) } } }), '')
  const route = readFileSync(new URL('../routes/adminControlRoutes.ts', import.meta.url), 'utf8')
  assert.ok(route.includes('finLabCallbackSummary(String(body.summary ?? \'\'), fence.incomingAttempt, current?.summary)\n      + finLabCompositionBlockerSuffix(body.result)'))
})

test('R-6: the matcher only takes the exact reason token', () => {
  assert.equal(finLabRequiresFullCapture(`status=partial_failed dispatch_attempt=1 composition_blockers=${FULL_CAPTURE}`), true)
  assert.equal(finLabRequiresFullCapture(`composition_blockers=other_reason,${FULL_CAPTURE}`), true)
  for (const text of [`${FULL_CAPTURE}_v2`, `x${FULL_CAPTURE}`, 'daily_inference_composition_requires', '', null, undefined])
    assert.equal(finLabRequiresFullCapture(text), false, String(text))
})

const partial = (attempt: number, reason = true) => ({
  status: 'error', timestamp: new Date(at('21:20')).toISOString(),
  summary: `FinLab V4 backfill run_id=${finlabRunId} status=partial_failed canonical=True rows=0 macro_context=ok external_evidence=ok `
    + `dispatch_attempt=${attempt} function_call_id=fc-${attempt}${reason ? ` composition_blockers=${FULL_CAPTURE}` : ''}`,
})

test('R-1/R-4: the watchdog sends one full capture, then stops on the same reason', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.setLog('finlab-v4-backfill', partial(1))
  f.clock(at('21:40'))
  await runFinLabBackfillWatchdog(f.env, date)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 1)
  const sent = f.dispatches[0]
  assert.equal(sent.run_id, finlabRunId)
  assert.equal(sent.dispatch_attempt, 2)
  assert.equal(sent.reuse_successful_artifacts, false)
  assert.ok(String(sent.lanes).split(',').includes('daily_price'), sent.lanes)
  assert.ok(String(sent.lanes).split(',').length > 1)
  assert.ok(String(sent.canonical_datasets).includes('canonical_market_daily'))
  // The full capture comes back with the same reason: no further resend, terminal error and a system log.
  f.setLog('finlab-v4-backfill', partial(2))
  f.clock(at('22:00'))
  const failed = await runFinLabBackfillWatchdog(f.env, date)
  assert.match(failed, /^failed: FinLab full capture already used for 2026-10-29/)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.log('finlab-v4-backfill').status, 'error')
  assert.equal(f.log('evening-chain').status, 'error')
  assert.equal(f.log('update').status, 'blocked')
  assert.ok((await f.systemLogs()).some((row: any) => row.level === 'error' && row.cron_name === 'finlab-v4-backfill'))
  // Later ticks leave the terminal state alone: no resend and no repeated system log.
  t.mock.timers.reset()
  f.clock(at('22:20'))
  await runFinLabBackfillWatchdog(f.env, date)
  assert.equal(f.dispatches.length, 1)
  assert.equal((await f.systemLogs()).filter((row: any) => row.cron_name === 'finlab-v4-backfill').length, 1)
})

test('R-2: a partial failure without the reason keeps the narrow, artifact-reusing retry', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.setLog('finlab-v4-backfill', partial(1, false))
  f.clock(at('21:40'))
  await runFinLabBackfillWatchdog(f.env, date)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.dispatches[0].lanes, 'regime_context')
  assert.equal(f.dispatches[0].reuse_successful_artifacts, true)
})

test('R-3: the reason does not lift the 3-attempt cap', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.setLog('finlab-v4-backfill', partial(3))
  f.clock(at('21:40'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^failed: FinLab pending watchdog exhausted/)
  assert.equal(f.dispatches.length, 0)
})

test('R-5: a root restart after the reason dispatches one full capture, then stops', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.setLog('finlab-v4-backfill', partial(1))
  f.clock(at('22:00'))
  assert.match(await runDailyUpdate(f.env, true, date), /awaiting FinLab canonical callback/)
  assert.equal(f.dispatches.length, 1)
  assert.ok(String(f.dispatches[0].lanes).split(',').includes('daily_price'))
  assert.equal(f.dispatches[0].reuse_successful_artifacts, false)
  assert.match(f.log('finlab-v4-backfill').summary, /full_capture_retry=1/)
  assert.doesNotMatch(f.log('finlab-v4-backfill').summary, /retry_lanes=/)
  f.setLog('finlab-v4-backfill', partial(1))
  assert.match(await runDailyUpdate(f.env, true, date), /^failed: FinLab full capture already used/)
  assert.equal(f.dispatches.length, 1)
})

test('R-5: a failed full-capture dispatch releases the claim', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'controller rejected dispatch' }, { status: 422 }))
  f.setLog('finlab-v4-backfill', partial(1))
  f.clock(at('22:00'))
  await assert.rejects(runDailyUpdate(f.env, true, date))
  assert.equal(f.store.has(`finlab:full-capture-retry:${date}`), false)
})

test('R-5: a watchdog full capture the controller refuses releases the claim', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'controller rejected dispatch' }, { status: 422 }))
  f.setLog('finlab-v4-backfill', partial(1))
  f.clock(at('21:40'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^failed \(422\)/)
  assert.equal(f.store.has(`finlab:full-capture-retry:${date}`), false)
})

test('R-7: the full-capture rule only applies to a partial failure; a late-lane failure keeps its own narrow retry', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.setLog('finlab-v4-backfill', { status: 'error', timestamp: new Date(at('21:20')).toISOString(),
    summary: `FinLab V4 backfill run_id=${finlabRunId} finlab_source_not_ready dispatch_attempt=1 function_call_id=fc-1 composition_blockers=${FULL_CAPTURE}` })
  f.clock(at('21:40'))
  await runFinLabBackfillWatchdog(f.env, date)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.dispatches[0].lanes, 'regime_context')
  assert.equal(f.dispatches[0].reuse_successful_artifacts, true)
  assert.equal(f.store.has(`finlab:full-capture-retry:${date}`), false)
})

test('B3-10: with readiness fully ok a completed stage is left alone and no warning is written', async (t) => {
  const f = await fixture(t)
  await f.seedStage('finlab_market', 'success', 1)
  f.clock(at('23:18'))
  const summary = await runDailyUpdate(f.env, true, date)
  assert.match(summary, /^triggered evening-chain: source readiness already ready for 2026-10-29; status=pending finlab_stage=finlab_market superseded_delivery/)
  assert.equal((await f.stage()).status, 'success')
  assert.equal((await f.systemLogs()).length, 0)
})

// ---------------- 10/30 follow-up: ① pending full capture, ⑥ post-cutoff bound ----------------

/** Controller fetch: answers each dispatch in order (html = Cloud Run 502 page, i.e. dispatch_unconfirmed). */
function controllerReplies(t: any, f: Awaited<ReturnType<typeof fixture>>, replies: Array<'spawned' | 'html'>, onDispatch?: () => void) {
  let n = 0
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('https://controller.invalid/finlab/backfill/run')) return new Response('unavailable', { status: 503 })
    const body = JSON.parse(String(init?.body))
    f.dispatches.push(body)
    onDispatch?.()
    if ((replies[n++] ?? 'spawned') === 'html') return new Response('<!DOCTYPE html><html><title>Error 502</title></html>', { status: 502 })
    return Response.json({ status: 'spawned', run_id: body.run_id, function_call_id: `fc-${body.dispatch_attempt}` })
  })
}
const isFull = (body: any) => String(body.lanes).split(',').includes('daily_price') && body.reuse_successful_artifacts === false

test('F-1: an unconfirmed watchdog full capture is resent as a full capture, not narrowed and not terminal', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  controllerReplies(t, f, ['html', 'spawned'])
  f.setLog('finlab-v4-backfill', partial(1))
  f.clock(at('21:40'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /dispatch_unconfirmed/)
  assert.match(f.log('finlab-v4-backfill').summary, /dispatch_unconfirmed .*full_capture_retry=1/)
  t.mock.timers.reset()
  f.clock(at('22:00'))
  const resent = await runFinLabBackfillWatchdog(f.env, date)
  assert.doesNotMatch(resent, /^failed/)
  assert.equal(f.dispatches.length, 2)
  assert.ok(f.dispatches.every(isFull), JSON.stringify(f.dispatches.map((d) => d.lanes)))
  assert.equal(f.dispatches[1].dispatch_attempt, 3)
  assert.match(f.log('finlab-v4-backfill').summary, /full_capture_retry=1/)
  assert.equal((await f.systemLogs()).length, 0)
  // Still inside the 3-attempt cap: a third pending attempt is exhausted, not resent.
  t.mock.timers.reset()
  f.clock(at('22:20'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^failed: FinLab pending watchdog exhausted/)
  assert.equal(f.dispatches.length, 2)
})

test('F-2: a root full capture reserves with the marker, so a lost dispatch is resent as a full capture', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  let reservation = ''
  controllerReplies(t, f, ['spawned', 'spawned'], () => { if (!reservation) reservation = f.log('finlab-v4-backfill').summary })
  f.setLog('finlab-v4-backfill', partial(1))
  f.clock(at('22:00'))
  await runDailyUpdate(f.env, true, date)
  assert.match(reservation, /^triggered FinLab dispatch reservation .*dispatch_attempt=1 full_capture_retry=1$/)
  // The Worker stopped after the reservation: the watchdog only sees the reservation and no callback.
  f.setLog('finlab-v4-backfill', { status: 'triggered', summary: reservation, timestamp: new Date(at('22:00')).toISOString(),
    run_id: reservation.match(/run_id=(\S+)/)![1] })
  t.mock.timers.reset()
  f.clock(at('22:20'))
  await runFinLabBackfillWatchdog(f.env, date)
  assert.equal(f.dispatches.length, 2)
  assert.ok(isFull(f.dispatches[1]), f.dispatches[1].lanes)
  assert.equal((await f.systemLogs()).length, 0)
})

test('G-1: past the cutoff the consumer queues no readiness retry and ends the date terminal', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  for (const clock of ['23:05', '23:07']) {
    f.clock(at(clock))
    await processUpdateBatch(completion(), f.env, deps)
    t.mock.timers.reset()
  }
  assert.equal(f.sent.filter((msg) => msg.type === 'source_readiness_retry').length, 0)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.match(f.log('evening-chain').summary, /not ready by 23:00 TW cutoff/)
  assert.equal(f.log('update').status, 'blocked')
  assert.notEqual(f.log('finlab-v4-backfill')?.status, 'running')
  assert.equal((await f.systemLogs()).length, 1)
})

const readinessRetry = (attempt = 1) => ({ type: 'source_readiness_retry', triggerTime: date, cursor: 0, attempt }) as any

test('G-2: past the cutoff a readiness retry refetches FinLab once per date, then ends terminal', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.clock(at('23:05'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  assert.equal(f.dispatches.length, 1)
  t.mock.timers.reset()
  f.setLog('finlab-v4-backfill', { status: 'success', summary: 'FinLab V4 backfill status=ready dispatch_attempt=1' })
  f.clock(at('23:25'))
  await processUpdateBatch(readinessRetry(2), f.env, deps)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.match(f.log('evening-chain').summary, /after the post-cutoff refetch/)
  assert.ok((await f.systemLogs()).some((row: any) => /after the post-cutoff refetch/.test(row.message)))
})

test('G-3: before the cutoff a readiness retry still refetches without using the post-cutoff budget', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.clock(at('22:40'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.store.has(`finlab:post-cutoff-refetch:${date}`), false)
  assert.equal((await f.systemLogs()).length, 0)
})

test('G-4: the post-cutoff loop (stage failures, readiness retries, refetch callbacks) drains with a bounded FinLab spend', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  let now = at('23:02')
  // One readiness retry queued before the cutoff and the market stage failing past it.
  const queue: any[] = [readinessRetry(), completion()]
  let processed = 0
  while (queue.length && processed < 200) {
    const msg = queue.shift()
    processed += 1
    f.clock(now)
    const before = f.sent.length
    await processUpdateBatch(msg, f.env, deps).catch(() => {})
    // Every dispatched refetch calls back successfully (route: queueFinLabCompletion with force) with the lane still missing.
    for (const sent of f.dispatches.filter((d) => !d.called)) {
      sent.called = true
      await queueFinLabCompletion(f.env, date, sent.run_id, true)
    }
    t.mock.timers.reset()
    queue.push(...f.sent.slice(before).filter((m) => m.type === 'source_readiness_retry' || m.type === 'finlab_backfill_complete'))
    now += 3 * 60_000
  }
  assert.ok(processed < 200, `queue did not drain (${processed})`)
  assert.equal(f.dispatches.length, 1)
  // The refetch callback re-ran the market stage under its own run id.
  assert.equal((await f.stage()).runId, f.dispatches[0].run_id)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.equal(f.log('update').status, 'blocked')
})

test('G-5: after the cutoff terminal the post-canonical watchdog does not rerun the continuation', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.setLog('finlab-v4-backfill', { status: 'success', summary: 'FinLab V4 backfill status=ready dispatch_attempt=1',
    timestamp: new Date(at('22:30')).toISOString() })
  f.clock(at('23:05'))
  await processUpdateBatch(completion(), f.env, deps)
  t.mock.timers.reset()
  const before = await f.stage()
  for (const clock of ['23:10', '23:20']) {
    f.clock(at(clock))
    assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab canonical cutoff terminal already recorded/)
    t.mock.timers.reset()
  }
  assert.deepEqual(await f.stage(), before)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.equal(f.dispatches.length, 0)
})

test('G-6: a refetch-cap terminal also stops the post-canonical watchdog', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  for (const [clock, attempt] of [['23:05', 1], ['23:25', 2]] as const) {
    f.clock(at(clock))
    await processUpdateBatch(readinessRetry(attempt), f.env, deps)
    t.mock.timers.reset()
  }
  f.setLog('finlab-v4-backfill', { status: 'success', summary: 'FinLab V4 backfill status=ready dispatch_attempt=1',
    timestamp: new Date(at('23:20')).toISOString() })
  f.clock(at('23:40'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab canonical cutoff terminal already recorded/)
  assert.equal(await f.stage(), null)
})

test('G-7: past the cutoff a serving gap found after the refresh keeps the bounded readiness retry', async (t) => {
  // A table read stale only from its third read (the check after the bulk refresh) gives the
  // 'source readiness not ready after refresh' error, which is not a canonical not-ready error.
  const f = await fixture(t, { staleFromRead: { table: 'canonical_broker_flow_daily', read: 2 } })
  f.clock(at('23:05'))
  await processUpdateBatch(completion(), f.env, deps)
  assert.match((await f.stage()).last_error, /source readiness not ready after refresh/)
  assert.equal(f.sent.filter((msg) => msg.type === 'source_readiness_retry').length, 1)
  assert.notEqual(f.log('update')?.status, 'blocked')
  assert.equal((await f.systemLogs()).length, 0)
})

test('F-3: a watchdog full capture reserves with the marker, so a Worker stop mid-dispatch still resends a full capture', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  let reservation = ''
  controllerReplies(t, f, ['spawned', 'spawned'], () => { if (!reservation) reservation = f.log('finlab-v4-backfill').summary })
  f.setLog('finlab-v4-backfill', partial(1))
  f.clock(at('21:40'))
  await runFinLabBackfillWatchdog(f.env, date)
  assert.match(reservation, /^triggered FinLab watchdog dispatch reservation .*dispatch_attempt=2 full_capture_retry=1$/)
  // The Worker stopped after the reservation: only the reservation is left, with no callback.
  f.setLog('finlab-v4-backfill', { status: 'triggered', summary: reservation, timestamp: new Date(at('21:40')).toISOString() })
  t.mock.timers.reset()
  f.clock(at('22:00'))
  await runFinLabBackfillWatchdog(f.env, date)
  assert.equal(f.dispatches.length, 2)
  assert.ok(isFull(f.dispatches[1]), f.dispatches[1].lanes)
  assert.equal(f.dispatches[1].dispatch_attempt, 3)
})

// ---------------- 10/30 §10: official source cutoff, closed-date watchdog, refetch budget ----------------

/** Delivers the market continuation every 2 minutes from `from` up to (excluding) `until`; returns what threw. */
async function deliverEvery2Min(t: any, f: Awaited<ReturnType<typeof fixture>>, from: string, until: string) {
  const errors: string[] = []
  for (let now = at(from); now < at(until); now += 2 * 60_000) {
    f.clock(now)
    await processUpdateBatch(completion(), f.env, deps).catch((error) => { errors.push(String(error?.message ?? error)) })
    t.mock.timers.reset()
  }
  return errors
}

test('OF-1: an official summary published late but before the cutoff is waited for and the chain completes', async (t) => {
  const market: Market = { summaryMissing: true }
  const f = await fixture(t, market)
  assert.deepEqual(await deliverEvery2Min(t, f, '22:30', '22:50'), [])
  assert.deepEqual([(await f.stage()).status, (await f.stage()).attempt_count], ['queued', 0])
  assert.equal(f.sent.filter((msg) => msg.type === 'source_readiness_retry').length, 2) // 22:30, 22:40
  market.summaryMissing = false
  assert.deepEqual(await deliverEvery2Min(t, f, '22:52', '22:54'), [])
  assert.ok(f.sent.some((msg) => msg.type === 'update_batch'), f.sent.map((msg) => msg.type).join(','))
  assert.equal((await f.systemLogs()).length, 0)
  assert.notEqual(f.log('update')?.status, 'blocked')
  assert.notEqual(f.log('evening-chain')?.status, 'error')
})

test('OF-2: an official summary still missing at the cutoff ends the date terminal and the stage stops', async (t) => {
  const f = await fixture(t, { summaryMissing: true })
  await deliverEvery2Min(t, f, '22:56', '23:00')
  const retriesBefore = f.sent.filter((msg) => msg.type === 'source_readiness_retry').length
  await deliverEvery2Min(t, f, '23:00', '23:10')
  const row = await f.stage()
  assert.equal(row.attempt_count, 3)
  assert.match(row.last_error, /finlab_continuation_cutoff_terminal/)
  assert.equal(f.sent.filter((msg) => msg.type === 'source_readiness_retry').length, retriesBefore)
  const logs = await f.systemLogs()
  assert.equal(logs.length, 1)
  assert.match(logs[0].message, /official market source not published by 23:00 TW cutoff/)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.equal(f.log('update').status, 'blocked')
  // The outbox stops re-queueing the stage once its 3 attempts are used.
  const queued = f.sent.filter((msg) => msg.type === 'finlab_backfill_complete').length
  await deliverEvery2Min(t, f, '23:10', '23:12')
  assert.equal(f.sent.filter((msg) => msg.type === 'finlab_backfill_complete').length, queued)
  // The closed date is not reopened by the post-canonical watchdog either.
  f.setLog('finlab-v4-backfill', { status: 'success', summary: 'FinLab V4 backfill status=ready dispatch_attempt=1',
    timestamp: new Date(at('22:30')).toISOString() })
  f.clock(at('23:20'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab canonical cutoff terminal already recorded/)
  assert.equal((await f.stage()).attempt_count, 3)
})

test('BU-1: prices not ready wait with deduplicated retries before the cutoff and end terminal at it', async (t) => {
  const f = await fixture(t, { chipMissing: true })
  await deliverEvery2Min(t, f, '22:30', '22:50')
  assert.equal(f.sent.filter((msg) => msg.type === 'source_readiness_retry').length, 2)
  assert.equal((await f.systemLogs()).length, 0)
  await deliverEvery2Min(t, f, '23:00', '23:02')
  assert.match((await f.systemLogs())[0]?.message ?? '', /official market source not published .*chip latest=2026-10-28/)
  assert.equal(f.log('update').status, 'blocked')
})

test('RT-1: a readiness retry chain reschedules before the cutoff and ends terminal after it', async (t) => {
  const f = await fixture(t, { chipMissing: true })
  f.clock(at('22:40'))
  await processUpdateBatch(readinessRetry(3), f.env, deps)
  t.mock.timers.reset()
  assert.deepEqual(f.sent.filter((msg) => msg.type === 'source_readiness_retry').map((msg) => msg.attempt), [4])
  f.clock(at('23:05'))
  await processUpdateBatch(readinessRetry(4), f.env, deps)
  assert.equal(f.sent.filter((msg) => msg.type === 'source_readiness_retry').length, 1)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.equal(f.log('update').status, 'blocked')
  assert.equal((await f.systemLogs()).length, 1)
})

test('WD-1: after the refetch-cap terminal the watchdog does not resend and keeps the date terminal', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.clock(at('23:05'))
  await processUpdateBatch(readinessRetry(), f.env, deps) // the one post-cutoff refetch
  t.mock.timers.reset()
  f.clock(at('23:07'))
  await processUpdateBatch(readinessRetry(2), f.env, deps) // refetch cap: terminal
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.log('finlab-v4-backfill').status, 'triggered')
  // Not stale yet: skip only, no resend.
  f.clock(at('23:10'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab canonical cutoff terminal already recorded/)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 1)
  // No callback by the stale threshold: still no resend, and the terminal state is written back.
  f.setLog('evening-chain', { status: 'triggered', summary: 'stale non-terminal', timestamp: new Date(at('23:05')).toISOString() })
  f.clock(at('23:40'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab canonical cutoff terminal already recorded/)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.match(f.log('evening-chain').summary, /got no callback after the cutoff/)
  assert.equal(f.log('update').status, 'blocked')
})

test('WD-2: past the cutoff a failed refetch is not resent; a late-lane failure keeps its own cutoff path', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.kvSet(`source-readiness:canonical-cutoff-logged:${date}`, '2026-10-29T15:00:00.000Z')
  f.setLog('finlab-v4-backfill', partial(1, false))
  f.clock(at('23:30'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab canonical cutoff terminal already recorded/)
  assert.equal(f.dispatches.length, 0)
  assert.equal(f.log('evening-chain').status, 'error')
  // No post-cutoff refetch went out: the cutoff terminal (already logged), not refetch_cap.
  assert.match(f.log('evening-chain').summary, /^FinLab canonical lanes not ready by 23:00 TW cutoff .*FinLab failed; no post-cutoff readiness refetch was sent; no resend$/)
  assert.equal(f.store.has(`source-readiness:canonical-refetch-cap-logged:${date}`), false)
  assert.equal((await f.systemLogs()).length, 0)
  f.setLog('finlab-v4-backfill', { status: 'error', timestamp: new Date(at('23:00')).toISOString(),
    summary: `FinLab V4 backfill run_id=${finlabRunId} finlab_source_not_ready dispatch_attempt=1` })
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^failed: FinLab late lane not published by 23:00 TW cutoff/)
})

test('BG-1: the post-cutoff refetch budget is only spent by an actual FinLab dispatch', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  // No dispatch: the date's full capture was already used, so the root ends without sending FinLab.
  f.kvSet(`finlab:full-capture-retry:${date}`, '2026-10-29T13:40:00.000Z')
  f.setLog('finlab-v4-backfill', partial(1))
  f.clock(at('23:05'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 0)
  assert.equal(f.store.has(`finlab:post-cutoff-refetch:${date}`), false)
  // A refused dispatch gives the budget back too, and closes the date instead of throwing into queue redelivery.
  f.store.delete(`finlab:full-capture-retry:${date}`)
  f.setLog('finlab-v4-backfill', partial(1, false))
  t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'rejected' }, { status: 422 }))
  f.clock(at('23:07'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  t.mock.timers.reset()
  assert.equal(f.store.has(`finlab:post-cutoff-refetch:${date}`), false)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.match(f.log('evening-chain').summary, /^FinLab canonical lanes not ready by 23:00 TW cutoff .*post-cutoff FinLab refetch could not be dispatched/)
  assert.equal(f.store.has(`source-readiness:canonical-refetch-cap-logged:${date}`), false)
  assert.equal(f.log('update').status, 'blocked')
  // A real dispatch spends it.
  controllerReplies(t, f, ['spawned'])
  f.clock(at('23:09'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.store.has(`finlab:post-cutoff-refetch:${date}`), true)
})

test('BG-1b: a post-cutoff refetch that skips FinLab (quota-blocked keys) and drops the run_id spends no budget', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  // Every required key of the lane, per the contract, is quota-blocked: nothing is refetchable.
  await f.ops.batch(finLabRequiredFieldsForLane('regime_context').map((field) => f.ops.prepare(
    `INSERT INTO source_key_report VALUES (?,?,?,?,1,'quota_blocked',0,0,?,?)`).bind(date, 'regime_context', field, field, prev, `${date}T13:00:00Z`)))
  f.setLog('finlab-v4-backfill', { status: 'running', summary: 'FinLab callback completed; canonical lanes still waiting',
    timestamp: new Date(at('22:50')).toISOString() })
  f.clock(at('23:05'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  assert.equal(f.dispatches.length, 0)
  assert.match(f.log('finlab-v4-backfill').summary ?? '', /canonical_apply_pending_no_refetch/)
  assert.equal(f.log('finlab-v4-backfill').run_id, undefined)
  assert.equal(f.store.has(`finlab:post-cutoff-refetch:${date}`), false)
})

test('WD-3: a post-canonical watchdog run that reaches the official cutoff ends terminal without throwing', async (t) => {
  const f = await fixture(t, { summaryMissing: true })
  f.setLog('finlab-v4-backfill', { status: 'success', summary: 'FinLab V4 backfill status=ready dispatch_attempt=1',
    timestamp: new Date(at('22:30')).toISOString() })
  f.clock(at('23:05'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^failed: finlab_continuation_cutoff_terminal: official_market_summary_waiting=/)
  assert.equal(f.log('update').status, 'blocked')
  assert.equal((await f.systemLogs()).length, 1)
})

test('BG-2: an unconfirmed post-cutoff refetch keeps the budget, and the watchdog does not resend it', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  controllerReplies(t, f, ['html'])
  f.clock(at('23:05'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 1)
  assert.match(f.log('finlab-v4-backfill').summary, /dispatch_unconfirmed/)
  assert.equal(f.store.has(`finlab:post-cutoff-refetch:${date}`), true)
  // No terminal was recorded yet, but the refetch is out: no resend; once stale the date is closed.
  f.clock(at('23:30'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /no post-cutoff resend/)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.equal(f.log('update').status, 'blocked')
})

// ---------------- 10/30 §10.4: post-cutoff refetch failures and the date's last watchdog run ----------------

test('BG-3: a transient error before the post-cutoff dispatch is retried by the queue and spends no budget', async (t) => {
  const market: Market = { twoiiMissing: true, brokerReadsBeforeD1Error: 2 }
  const f = await fixture(t, market)
  f.clock(at('23:02'))
  await assert.rejects(processUpdateBatch(readinessRetry(), f.env, deps), /D1_ERROR/)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 0)
  assert.equal(f.store.has(`finlab:post-cutoff-refetch:${date}`), false)
  assert.equal((await f.systemLogs()).length, 0)
  assert.notEqual(f.log('evening-chain')?.status, 'error')
  assert.notEqual(f.log('update')?.status, 'blocked')
  // The queue redelivery dispatches the one refetch, which then spends the budget.
  market.brokerReadsBeforeD1Error = undefined
  f.clock(at('23:03'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.store.has(`finlab:post-cutoff-refetch:${date}`), true)
})

test('BG-4: a post-cutoff dispatch whose refusal was not recorded keeps the budget and is not reported as undispatched', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  // The controller refuses, but the KV write of that error log is lost (the logger swallows it): only the
  // reservation with the new run_id is left, so nothing proves FinLab did not run.
  const put = f.env.KV.put.bind(f.env.KV)
  let dropErrorLog = true
  ;(f.env.KV as any).put = async (key: string, value: string, options?: any) => {
    if (dropErrorLog && key === `scheduler:run:finlab-v4-backfill:${date}` && JSON.parse(value).status === 'error') {
      dropErrorLog = false
      throw new Error('KV put failed')
    }
    return put(key, value, options)
  }
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    f.dispatches.push(JSON.parse(String(init?.body)))
    return Response.json({ detail: 'rejected' }, { status: 422 })
  })
  f.clock(at('23:05'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  t.mock.timers.reset()
  assert.equal(dropErrorLog, false)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.log('finlab-v4-backfill').status, 'triggered')
  assert.equal(f.store.has(`finlab:post-cutoff-refetch:${date}`), true)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.match(f.log('evening-chain').summary, new RegExp(`run_id=${f.dispatches[0].run_id} not recorded as refused \\(may have gone out\\); follow-up failed`))
  assert.doesNotMatch(f.log('evening-chain').summary, /could not be dispatched/)
  assert.equal(f.store.has(`source-readiness:canonical-refetch-cap-logged:${date}`), true)
  assert.equal(f.log('update').status, 'blocked')
  // The kept budget stops any resend.
  f.clock(at('23:30'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /no post-cutoff resend/)
  assert.equal(f.dispatches.length, 1)
})

test('WD-4: the date\'s last watchdog run closes a late post-cutoff refetch that got no callback', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.clock(at('23:41'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.log('evening-chain').status, 'running')
  // 16 minutes left in the day: a later run can still see it stale, so only skip.
  f.clock(at('23:44'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /no post-cutoff resend/)
  t.mock.timers.reset()
  assert.equal(f.log('evening-chain').status, 'running')
  assert.equal((await f.systemLogs()).length, 0)
  // 23:50 (pending 9 minutes, not stale) is the last run: the date ends terminal, still without a resend.
  f.clock(at('23:50'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /no post-cutoff resend/)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.match(f.log('evening-chain').summary, /got no callback after the cutoff \(last watchdog run of the date\)/)
  assert.equal(f.log('update').status, 'blocked')
  assert.equal((await f.systemLogs()).length, 1)
})

test('WD-4b: earlier in the night a pending post-cutoff refetch younger than the stale threshold is left alone', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.clock(at('23:20'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  t.mock.timers.reset()
  f.clock(at('23:30'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /no post-cutoff resend/)
  assert.equal(f.log('evening-chain').status, 'running')
  assert.notEqual(f.log('update')?.status, 'blocked')
  assert.equal((await f.systemLogs()).length, 0)
})

test('WD-5: a post-cutoff refetch due in the date\'s last watchdog window is not sent; the date ends terminal', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.clock(at('23:47'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 0)
  assert.equal(f.store.has(`finlab:post-cutoff-refetch:${date}`), false)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.match(f.log('evening-chain').summary, /^FinLab canonical lanes not ready by 23:00 TW cutoff .*not sent in the date's last watchdog window/)
  assert.equal(f.store.has(`source-readiness:canonical-refetch-cap-logged:${date}`), false)
  assert.equal(f.log('update').status, 'blocked')
  // A date already past its midnight has no last window: a young pending refetch is left to the stale rule.
  const g = await fixture(t, { twoiiMissing: true })
  g.kvSet(`finlab:post-cutoff-refetch:${date}`, '2026-10-29T16:05:00.000Z')
  g.setLog('finlab-v4-backfill', { status: 'triggered', summary: `triggered finlab-v4-backfill run_id=${finlabRunId} dispatch_attempt=1`,
    timestamp: new Date(at('00:05', '2026-10-30')).toISOString() })
  g.clock(at('00:10', '2026-10-30'))
  assert.match(await runFinLabBackfillWatchdog(g.env, date), /no post-cutoff resend/)
  assert.notEqual(g.log('evening-chain')?.status, 'error')
  assert.equal((await g.systemLogs()).length, 0)
})

// ---------------- 11/1 §11 (NEW-1030-13): r7 Minor 1–4 ----------------

const pendingDispatch = (clock: string, extra = '') => ({ status: 'triggered', timestamp: new Date(at(clock)).toISOString(),
  summary: `triggered finlab-v4-backfill run_id=${finlabRunId} function_call_id=fc-1 dispatch_attempt=1${extra}` })

test('M1: a dispatch pending past the cutoff without a callback is never resent; once stale the date ends at the cutoff', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  // Dispatched at 22:57, before the cutoff; no terminal is recorded and no post-cutoff refetch went out.
  f.setLog('finlab-v4-backfill', pendingDispatch('22:57'))
  f.clock(at('23:00'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab triggered past the 23:00 TW cutoff for 2026-10-29; no post-cutoff resend$/)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 0)
  assert.equal((await f.systemLogs()).length, 0)
  for (const clock of ['23:20', '23:40', '23:50']) {
    f.clock(at(clock))
    assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab canonical cutoff terminal already recorded/)
    t.mock.timers.reset()
  }
  assert.equal(f.dispatches.length, 0)
  assert.equal(f.log('finlab-v4-backfill').status, 'triggered')
  assert.equal(f.log('evening-chain').status, 'error')
  assert.match(f.log('evening-chain').summary, /^FinLab canonical lanes not ready by 23:00 TW cutoff .*FinLab got no callback; no post-cutoff readiness refetch was sent; no resend$/)
  assert.equal(f.log('update').status, 'blocked')
  assert.equal(f.store.has(`source-readiness:canonical-cutoff-logged:${date}`), true)
  assert.equal(f.store.has(`source-readiness:canonical-refetch-cap-logged:${date}`), false)
  assert.equal((await f.systemLogs()).length, 1)
})

test('M1 counter: before the cutoff a stale dispatch is resent, and past it a FinLab failure keeps its retry', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.setLog('finlab-v4-backfill', pendingDispatch('22:30'))
  f.clock(at('22:50'))
  await runFinLabBackfillWatchdog(f.env, date)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.dispatches[0].dispatch_attempt, 2)
  // A callback that came back failed (not a missing callback) on a date with no terminal: the retry is unchanged.
  const g = await fixture(t, { twoiiMissing: true })
  g.setLog('finlab-v4-backfill', partial(1, false))
  g.clock(at('23:20'))
  await runFinLabBackfillWatchdog(g.env, date)
  t.mock.timers.reset()
  assert.equal(g.dispatches.length, 1)
  assert.notEqual(g.log('evening-chain')?.status, 'error')
})

test('M1 boundary (Wei 10/30): a dispatch sent after 22:55:00 TW gets no resend; at or before 22:55:00 it keeps the 23:10 rescue', async (t) => {
  const sentAt = (ms: number) => ({ ...pendingDispatch('22:00'), timestamp: new Date(ms).toISOString() })
  // Rescue side: 22:40 and exactly 22:55:00 (stale by the 23:10 run) are resent as attempt 2.
  for (const ms of [at('22:40'), at('22:55')]) {
    const f = await fixture(t, { twoiiMissing: true })
    f.setLog('finlab-v4-backfill', sentAt(ms))
    f.clock(at('23:10'))
    await runFinLabBackfillWatchdog(f.env, date)
    t.mock.timers.reset()
    assert.equal(f.dispatches.length, 1, new Date(ms).toISOString())
    assert.equal(f.dispatches[0].dispatch_attempt, 2)
    assert.notEqual(f.log('evening-chain')?.status, 'error')
    // The rescue resend (sent 23:10, after 22:55) is the only one: still pending at 23:30 it closes, no further resend.
    f.clock(at('23:30'))
    await runFinLabBackfillWatchdog(f.env, date)
    t.mock.timers.reset()
    assert.equal(f.dispatches.length, 1)
    assert.equal(f.log('evening-chain').status, 'error')
    assert.equal(f.log('update').status, 'blocked')
  }
  // No-resend side: 22:55:01 and 22:56 are only skipped at 23:10 and close at the cutoff once stale, never resent.
  for (const ms of [at('22:55') + 1000, at('22:56')]) {
    const f = await fixture(t, { twoiiMissing: true })
    f.setLog('finlab-v4-backfill', sentAt(ms))
    f.clock(at('23:10'))
    assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab triggered past the 23:00 TW cutoff for 2026-10-29; no post-cutoff resend$/)
    t.mock.timers.reset()
    f.clock(at('23:20'))
    await runFinLabBackfillWatchdog(f.env, date)
    t.mock.timers.reset()
    assert.equal(f.dispatches.length, 0, new Date(ms).toISOString())
    assert.match(f.log('evening-chain').summary, /^FinLab canonical lanes not ready by 23:00 TW cutoff .*FinLab got no callback; no post-cutoff readiness refetch was sent; no resend$/)
    assert.equal(f.log('update').status, 'blocked')
  }
})

test('M1 boundary: past the cutoff no resend once the attempts are spent, nor for a date past its midnight', async (t) => {
  // Attempt 3 (the last) sent at 22:50: closes at the cutoff instead of the exhausted error, with the ops log.
  const f = await fixture(t, { twoiiMissing: true })
  f.setLog('finlab-v4-backfill', { ...pendingDispatch('22:50'),
    summary: `triggered finlab-v4-backfill run_id=${finlabRunId} function_call_id=fc-1 dispatch_attempt=3` })
  f.clock(at('23:10'))
  await runFinLabBackfillWatchdog(f.env, date)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 0)
  assert.match(f.log('evening-chain').summary, /^FinLab canonical lanes not ready by 23:00 TW cutoff .*FinLab got no callback; no post-cutoff readiness refetch was sent; no resend$/)
  assert.equal(f.log('update').status, 'blocked')
  assert.equal((await f.systemLogs()).length, 1)
  // A manual watchdog run for a date already past its midnight resends nothing, even for a 21:30 dispatch.
  const g = await fixture(t, { twoiiMissing: true })
  g.setLog('finlab-v4-backfill', pendingDispatch('21:30'))
  g.clock(at('10:00', '2026-10-30'))
  await runFinLabBackfillWatchdog(g.env, date)
  t.mock.timers.reset()
  assert.equal(g.dispatches.length, 0)
  assert.equal(g.log('evening-chain').status, 'error')
  assert.equal(g.log('update').status, 'blocked')
})

test('M1 warn (Wei 10/30): a lost callback with canonical lanes ready writes one ops warn in the date\'s last watchdog run', async (t) => {
  const f = await fixture(t)
  f.setLog('finlab-v4-backfill', pendingDispatch('23:42'))
  f.clock(at('23:50'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /canonical lanes ready; no post-cutoff resend$/)
  t.mock.timers.reset()
  const warns = async () => (await f.systemLogs()).filter((row: any) => row.level === 'warn')
  assert.equal((await f.systemLogs()).length, 1)
  assert.equal((await warns()).length, 1)
  assert.equal((await warns())[0].cron_name, 'evening-chain')
  assert.match((await warns())[0].message, new RegExp(`^FinLab run_id=${finlabRunId} past the 23:00 TW cutoff got no callback by the last watchdog run of 2026-10-29 while the canonical lanes are ready`))
  assert.equal(f.dispatches.length, 0)
  assert.notEqual(f.log('evening-chain')?.status, 'error')
  assert.equal(f.store.has(`source-readiness:canonical-cutoff-logged:${date}`), false)
  // A second watchdog run of the same date (manual, still in the last window) writes no second warn.
  f.clock(at('23:55'))
  await runFinLabBackfillWatchdog(f.env, date)
  t.mock.timers.reset()
  assert.equal((await f.systemLogs()).length, 1)
  // Counter: a canonical lane still missing takes the terminal path, with no lost-callback warn.
  const g = await fixture(t, { twoiiMissing: true })
  g.setLog('finlab-v4-backfill', pendingDispatch('23:42'))
  g.clock(at('23:50'))
  await runFinLabBackfillWatchdog(g.env, date)
  t.mock.timers.reset()
  assert.equal(g.log('evening-chain').status, 'error')
  assert.equal(g.store.has(`finlab:lost-callback-canonical-ready-warned:${date}`), false)
  assert.equal((await g.systemLogs()).filter((row: any) => row.level === 'warn').length, 0)
  // Counter: before the last run (23:20) a lost callback with canonical lanes ready writes nothing.
  const h = await fixture(t)
  h.setLog('finlab-v4-backfill', pendingDispatch('23:02'))
  h.clock(at('23:20'))
  await runFinLabBackfillWatchdog(h.env, date)
  t.mock.timers.reset()
  assert.equal((await h.systemLogs()).length, 0)
  // Counter: an official-source terminal already closed the chain: no lost-callback warn either.
  const k = await fixture(t)
  k.kvSet(`source-readiness:official-cutoff-logged:${date}`, '2026-10-29T15:00:00.000Z')
  k.setLog('finlab-v4-backfill', pendingDispatch('23:42'))
  k.clock(at('23:50'))
  await runFinLabBackfillWatchdog(k.env, date)
  t.mock.timers.reset()
  assert.equal(k.store.has(`finlab:lost-callback-canonical-ready-warned:${date}`), false)
  assert.equal((await k.systemLogs()).length, 0)
})

test('M1: a lost callback whose data already landed is not closed; a pending full capture past the cutoff is', async (t) => {
  // Readiness is complete (the callback was lost after the data landed): no terminal, no resend.
  const f = await fixture(t)
  f.setLog('finlab-v4-backfill', pendingDispatch('22:57'))
  f.setLog('update', { status: 'running', summary: 'source became ready', timestamp: new Date(at('23:05')).toISOString() })
  f.clock(at('23:20'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab triggered past the 23:00 TW cutoff for 2026-10-29; canonical lanes ready; no post-cutoff resend$/)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 0)
  assert.notEqual(f.log('evening-chain')?.status, 'error')
  assert.equal(f.log('update').status, 'running')
  assert.equal((await f.systemLogs()).length, 0)
  // A pending full capture (composition reason) gets no post-cutoff resend either; the last run closes it.
  const g = await fixture(t, { twoiiMissing: true })
  g.setLog('finlab-v4-backfill', pendingDispatch('23:42', ' full_capture_retry=1'))
  g.clock(at('23:50'))
  await runFinLabBackfillWatchdog(g.env, date)
  t.mock.timers.reset()
  assert.equal(g.dispatches.length, 0)
  assert.equal(g.log('evening-chain').status, 'error')
  assert.match(g.log('evening-chain').summary, /FinLab got no callback \(last watchdog run of the date\); no post-cutoff readiness refetch was sent; no resend$/)
  assert.equal(g.log('update').status, 'blocked')
})

test('M2: a readiness retry of a date already past its midnight sends no refetch and ends the date at the cutoff', async (t) => {
  const f = await fixture(t, { twoiiMissing: true })
  f.clock(at('00:05', '2026-10-30'))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 0)
  assert.equal(f.store.has(`finlab:post-cutoff-refetch:${date}`), false)
  assert.equal(f.sent.length, 0)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.match(f.log('evening-chain').summary, /^FinLab canonical lanes not ready by 23:00 TW cutoff .*post-cutoff FinLab refetch not sent after the date ended/)
  assert.equal(f.log('update').status, 'blocked')
  assert.equal(f.store.has(`source-readiness:canonical-refetch-cap-logged:${date}`), false)
  assert.equal((await f.systemLogs()).length, 1)
  // Counter: 16 minutes before the date's midnight a later watchdog run is left, so the refetch is sent.
  const g = await fixture(t, { twoiiMissing: true })
  g.clock(at('23:44'))
  await processUpdateBatch(readinessRetry(), g.env, deps)
  assert.equal(g.dispatches.length, 1)
  assert.equal(g.store.has(`finlab:post-cutoff-refetch:${date}`), true)
  assert.notEqual(g.log('evening-chain')?.status, 'error')
  t.mock.timers.reset()
  // Past its midnight with the date's refetch already sent: refetch_cap, still no dispatch.
  const h = await fixture(t, { twoiiMissing: true })
  h.kvSet(`finlab:post-cutoff-refetch:${date}`, '2026-10-29T15:05:00.000Z')
  h.clock(at('00:05', '2026-10-30'))
  await processUpdateBatch(readinessRetry(), h.env, deps)
  t.mock.timers.reset()
  assert.equal(h.dispatches.length, 0)
  assert.match(h.log('evening-chain').summary, /^FinLab canonical lanes still not ready after the post-cutoff refetch /)
  assert.equal(h.store.has(`source-readiness:canonical-refetch-cap-logged:${date}`), true)
  assert.equal(h.store.has(`source-readiness:canonical-cutoff-logged:${date}`), false)
})

/** The one post-cutoff refetch, sent at `clock`, whose start heartbeat then arrives at `started`. */
async function startedRefetch(t: any, clock: string, started: string, marker = false, market: Market = { twoiiMissing: true }) {
  const f = await fixture(t, market)
  f.clock(at(clock))
  await processUpdateBatch(readinessRetry(), f.env, deps)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 1)
  const runId = f.dispatches[0].run_id
  if (marker) {
    // R33-NEW-32: the start marker is kept while another colo rewrote `triggered` over the heartbeat.
    f.kvSet(finLabStartMarkerKey(date, runId, 1), new Date(at(started)).toISOString())
    f.setLog('finlab-v4-backfill', { ...pendingDispatch(started), run_id: runId,
      summary: `triggered finlab-v4-backfill run_id=${runId} dispatch_attempt=1` })
  } else {
    f.setLog('finlab-v4-backfill', { status: 'running', run_id: runId, timestamp: new Date(at(started)).toISOString(),
      summary: `FinLab V4 backfill started run_id=${runId} dispatch_attempt=1` })
  }
  return f
}

test('M3: a post-cutoff refetch that started but never completes ends refetch_cap in the date\'s last run, without a resend', async (t) => {
  const f = await startedRefetch(t, '23:05', '23:06')
  // A capture can run 13-25 minutes: before the last run it is left alone, even past the pending stale threshold.
  for (const clock of ['23:10', '23:30', '23:40']) {
    f.clock(at(clock))
    assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab start heartbeat received for 2026-10-29$/)
    t.mock.timers.reset()
  }
  assert.equal(f.log('evening-chain').status, 'running')
  assert.equal((await f.systemLogs()).length, 0)
  f.clock(at('23:50'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /post-cutoff refetch started but did not complete$/)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.match(f.log('evening-chain').summary, /^FinLab canonical lanes still not ready after the post-cutoff refetch .*FinLab started after the cutoff but did not complete by the last watchdog run of the date; no resend$/)
  assert.equal(f.log('update').status, 'blocked')
  assert.equal(f.store.has(`source-readiness:canonical-refetch-cap-logged:${date}`), true)
  assert.equal((await f.systemLogs()).length, 1)
})

test('M3: the date\'s last watchdog run closes a refetch started just before it, also behind a start marker', async (t) => {
  for (const marker of [false, true]) {
    const f = await startedRefetch(t, '23:44', '23:45', marker)
    f.clock(at('23:50'))
    assert.match(await runFinLabBackfillWatchdog(f.env, date), /post-cutoff refetch started but did not complete$/)
    t.mock.timers.reset()
    assert.equal(f.dispatches.length, 1)
    assert.equal(f.log('evening-chain').status, 'error')
    assert.match(f.log('evening-chain').summary, /did not complete by the last watchdog run of the date; no resend$/)
    assert.equal(f.log('update').status, 'blocked')
  }
})

test('M3 counter: a started refetch before the last run, or a pre-cutoff run, is left alone; one whose data landed is not closed', async (t) => {
  const f = await startedRefetch(t, '23:20', '23:21')
  f.clock(at('23:44'))
  assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab start heartbeat received for 2026-10-29$/)
  t.mock.timers.reset()
  assert.equal(f.log('evening-chain').status, 'running')
  assert.equal((await f.systemLogs()).length, 0)
  // Its data already landed (the completion callback is lost or still on its way): the last run does not close it
  // (only the lost-callback warn, covered by 'M3 warn').
  const market: Market = { twoiiMissing: true }
  const h = await startedRefetch(t, '23:30', '23:31', false, market)
  market.twoiiMissing = false
  h.clock(at('23:50'))
  assert.match(await runFinLabBackfillWatchdog(h.env, date), /^skipped: FinLab start heartbeat received for 2026-10-29$/)
  t.mock.timers.reset()
  assert.notEqual(h.log('evening-chain')?.status, 'error')
  assert.equal((await h.systemLogs()).filter((row: any) => row.level === 'error').length, 0)
  // Started before the cutoff (no post-cutoff refetch): the existing running skip, even in the last run.
  const g = await fixture(t, { twoiiMissing: true })
  g.setLog('finlab-v4-backfill', { status: 'running', timestamp: new Date(at('22:40')).toISOString(),
    summary: `FinLab V4 backfill started run_id=${finlabRunId} dispatch_attempt=1` })
  g.clock(at('23:50'))
  assert.match(await runFinLabBackfillWatchdog(g.env, date), /^skipped: FinLab start heartbeat received for 2026-10-29$/)
  assert.notEqual(g.log('evening-chain')?.status, 'error')
  assert.equal((await g.systemLogs()).length, 0)
})

test('M3 warn (Wei 10/30): a started post-cutoff refetch whose callback is lost with canonical lanes ready shares the one warn', async (t) => {
  const warned = `finlab:lost-callback-canonical-ready-warned:${date}`
  // Positive: running or behind a start marker, data landed, the date's last run: one ops warn, no state change.
  for (const marker of [false, true]) {
    const market: Market = { twoiiMissing: true }
    const f = await startedRefetch(t, '23:30', '23:31', marker, market)
    market.twoiiMissing = false
    const before = ['finlab-v4-backfill', 'evening-chain', 'update'].map((task) => JSON.stringify(f.log(task) ?? null))
    const sentBefore = f.sent.length
    f.clock(at('23:50'))
    assert.match(await runFinLabBackfillWatchdog(f.env, date), /^skipped: FinLab start heartbeat received for 2026-10-29/)
    t.mock.timers.reset()
    const logs = await f.systemLogs()
    assert.equal(logs.length, 1)
    assert.equal(logs[0].level, 'warn')
    assert.equal(logs[0].cron_name, 'evening-chain')
    assert.match(logs[0].message, new RegExp(`^FinLab run_id=${f.dispatches[0].run_id} past the 23:00 TW cutoff got no callback by the last watchdog run of 2026-10-29 while the canonical lanes are ready`))
    assert.equal(f.store.has(warned), true)
    assert.equal(f.dispatches.length, 1)
    assert.deepEqual(['finlab-v4-backfill', 'evening-chain', 'update'].map((task) => JSON.stringify(f.log(task) ?? null)), before)
    assert.equal(f.sent.length, sentBefore)
    assert.equal(f.store.has(`source-readiness:canonical-refetch-cap-logged:${date}`), false)
  }
  // Counter 1: the date already warned from the triggered (no-callback) case: the started case writes no second one.
  const market: Market = { twoiiMissing: true }
  const g = await startedRefetch(t, '23:30', '23:31', false, market)
  market.twoiiMissing = false
  const runId = g.dispatches[0].run_id
  g.setLog('finlab-v4-backfill', { ...pendingDispatch('23:42'), run_id: runId,
    summary: `triggered finlab-v4-backfill run_id=${runId} dispatch_attempt=1` })
  g.clock(at('23:50'))
  assert.match(await runFinLabBackfillWatchdog(g.env, date), /canonical lanes ready; no post-cutoff resend$/)
  t.mock.timers.reset()
  assert.equal((await g.systemLogs()).length, 1)
  g.setLog('finlab-v4-backfill', { status: 'running', run_id: runId, timestamp: new Date(at('23:51')).toISOString(),
    summary: `FinLab V4 backfill started run_id=${runId} dispatch_attempt=1` })
  g.clock(at('23:55'))
  assert.match(await runFinLabBackfillWatchdog(g.env, date), /^skipped: FinLab start heartbeat received for 2026-10-29$/)
  t.mock.timers.reset()
  assert.equal((await g.systemLogs()).length, 1)
  // Counter 2: a canonical lane still missing: the existing refetch_cap terminal, no warn.
  const h = await startedRefetch(t, '23:30', '23:31')
  h.clock(at('23:50'))
  assert.match(await runFinLabBackfillWatchdog(h.env, date), /post-cutoff refetch started but did not complete$/)
  t.mock.timers.reset()
  assert.equal(h.store.has(warned), false)
  assert.equal((await h.systemLogs()).filter((row: any) => row.level === 'warn').length, 0)
  // Counter 3: data landed but not the date's last run (23:44): nothing written.
  const km: Market = { twoiiMissing: true }
  const k = await startedRefetch(t, '23:20', '23:21', false, km)
  km.twoiiMissing = false
  k.clock(at('23:44'))
  assert.match(await runFinLabBackfillWatchdog(k.env, date), /^skipped: FinLab start heartbeat received for 2026-10-29$/)
  t.mock.timers.reset()
  assert.equal(k.store.has(warned), false)
  assert.equal((await k.systemLogs()).length, 0)
  // Counter 4: an official-source terminal already closed the chain: no warn.
  const om: Market = { twoiiMissing: true }
  const o = await startedRefetch(t, '23:30', '23:31', false, om)
  om.twoiiMissing = false
  o.kvSet(`source-readiness:official-cutoff-logged:${date}`, '2026-10-29T15:00:00.000Z')
  o.clock(at('23:50'))
  await runFinLabBackfillWatchdog(o.env, date)
  t.mock.timers.reset()
  assert.equal(o.store.has(warned), false)
  assert.equal((await o.systemLogs()).length, 0)
  // Counter 5: the completion callback came back (the handler rewrote `running` while only a serving gap waits): no warn.
  const cm: Market = { twoiiMissing: true }
  const c = await startedRefetch(t, '23:30', '23:31', false, cm)
  cm.twoiiMissing = false
  c.setLog('finlab-v4-backfill', { status: 'running', run_id: c.dispatches[0].run_id, timestamp: new Date(at('23:40')).toISOString(),
    summary: 'FinLab callback completed but target-date canonical lanes are still waiting; source readiness not ready after refresh' })
  c.clock(at('23:50'))
  assert.match(await runFinLabBackfillWatchdog(c.env, date), /^skipped: FinLab start heartbeat received for 2026-10-29$/)
  t.mock.timers.reset()
  assert.equal(c.store.has(warned), false)
  assert.equal((await c.systemLogs()).length, 0)
})

test('M4: past the cutoff the guard names the terminal it closes: refetch_cap only after a post-cutoff refetch', async (t) => {
  // A FinLab failure on a date closed at the cutoff with no post-cutoff refetch: the cutoff terminal, logged once.
  const f = await fixture(t, { twoiiMissing: true })
  f.clock(at('23:02'))
  await processUpdateBatch({ ...completion(), attempt: 1 }, f.env, deps)
  t.mock.timers.reset()
  assert.equal(f.store.has(`source-readiness:canonical-cutoff-logged:${date}`), true)
  const logged = (await f.systemLogs()).length
  f.setLog('finlab-v4-backfill', partial(1, false))
  f.clock(at('23:10'))
  await runFinLabBackfillWatchdog(f.env, date)
  t.mock.timers.reset()
  assert.equal(f.dispatches.length, 0)
  assert.match(f.log('evening-chain').summary, /^FinLab canonical lanes not ready by 23:00 TW cutoff .*FinLab failed; no post-cutoff readiness refetch was sent; no resend$/)
  assert.equal(f.store.has(`source-readiness:canonical-refetch-cap-logged:${date}`), false)
  assert.equal((await f.systemLogs()).length, logged)
  // Counter: the post-cutoff refetch went out and then failed: refetch_cap.
  const g = await fixture(t, { twoiiMissing: true })
  g.clock(at('23:05'))
  await processUpdateBatch(readinessRetry(), g.env, deps)
  t.mock.timers.reset()
  g.setLog('finlab-v4-backfill', { ...partial(2, false), run_id: g.dispatches[0].run_id, timestamp: new Date(at('23:15')).toISOString() })
  g.clock(at('23:20'))
  await runFinLabBackfillWatchdog(g.env, date)
  assert.equal(g.dispatches.length, 1)
  assert.match(g.log('evening-chain').summary, /^FinLab canonical lanes still not ready after the post-cutoff refetch .*FinLab failed after the cutoff; no resend$/)
  assert.equal(g.store.has(`source-readiness:canonical-refetch-cap-logged:${date}`), true)
  assert.equal((await g.systemLogs()).length, 1)
  t.mock.timers.reset()
  // Only the official-source terminal is recorded and the canonical lanes are complete: no canonical terminal.
  const h = await fixture(t)
  h.kvSet(`source-readiness:official-cutoff-logged:${date}`, '2026-10-29T15:00:00.000Z')
  h.setLog('finlab-v4-backfill', pendingDispatch('23:00'))
  h.clock(at('23:20'))
  assert.match(await runFinLabBackfillWatchdog(h.env, date), /canonical lanes ready; no post-cutoff resend$/)
  t.mock.timers.reset()
  assert.equal(h.store.has(`source-readiness:canonical-cutoff-logged:${date}`), false)
  assert.equal((await h.systemLogs()).length, 0)
  // Only the official-source terminal is recorded but a canonical lane is still missing: a pending dispatch is
  // only skipped until stale (no canonical terminal claimed), then closes with the cutoff terminal, no resend.
  const k = await fixture(t, { twoiiMissing: true })
  k.kvSet(`source-readiness:official-cutoff-logged:${date}`, '2026-10-29T15:00:00.000Z')
  k.setLog('finlab-v4-backfill', pendingDispatch('23:10'))
  k.clock(at('23:20'))
  assert.match(await runFinLabBackfillWatchdog(k.env, date), /^skipped: FinLab triggered past the 23:00 TW cutoff for 2026-10-29; no post-cutoff resend$/)
  t.mock.timers.reset()
  assert.equal(k.store.has(`source-readiness:canonical-cutoff-logged:${date}`), false)
  k.clock(at('23:30'))
  assert.match(await runFinLabBackfillWatchdog(k.env, date), /^skipped: FinLab canonical cutoff terminal already recorded/)
  t.mock.timers.reset()
  assert.equal(k.dispatches.length, 0)
  assert.equal(k.store.has(`source-readiness:canonical-cutoff-logged:${date}`), true)
  assert.match(k.log('evening-chain').summary, /^FinLab canonical lanes not ready by 23:00 TW cutoff .*FinLab got no callback; no post-cutoff readiness refetch was sent; no resend$/)
  assert.equal(k.log('update').status, 'blocked')
})
