import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyFinLabLateLaneNotReady,
  finLabLatePublicationFields,
  finLabLateRetryCutoffPassed,
  finLabLateRetryCutoffTw,
} from './finlabSourceContract'
import { finLabDispatchSupersededByStart, runDailyUpdate, runFinLabBackfillWatchdog } from './updateOrchestrator'
import { readFileSync } from 'node:fs'
import type { Bindings } from '../types'

const date = '2026-10-22'
const runId = 'finlab-v4-daily-20261022-1'
const at = (clock: string) => Date.parse(`${date}T${clock}:00+08:00`)

test('T-W1: late-lane not-ready is only the contract late_publication fields', () => {
  assert.deepEqual(finLabLatePublicationFields(), ['margin_balance', 'short_balance'])
  assert.equal(finLabLateRetryCutoffTw(), '23:00')
  for (const summary of [
    'finlab_source_not_ready lane=chip_diversity fields=margin_balance,short_balance target_date=2026-10-22 latest=2026-10-21',
    'ValueError: daily_composition_market_dates_missing:margin_balance dispatch_attempt=1',
    'daily_composition_market_dates_missing:short_balance',
  ]) assert.equal(classifyFinLabLateLaneNotReady(summary), true, summary)
  for (const summary of [
    'ValueError: daily_composition_market_dates_missing:pe dispatch_attempt=1',
    'daily_composition_market_dates_missing:pb',
    'daily_composition_market_dates_missing:dividend_yield',
    'daily_composition_history_changed:margin_balance',
    'daily_composition_current_field_missing:margin_balance',
    'FinLab quota exceeded: daily limit reached',
    '',
    null,
  ]) assert.equal(classifyFinLabLateLaneNotReady(summary), false, String(summary))
  assert.equal(finLabLateRetryCutoffPassed(date, at('22:59')), false)
  assert.equal(finLabLateRetryCutoffPassed(date, at('23:00')), true)
  // After midnight the previous run date is still past its cutoff.
  assert.equal(finLabLateRetryCutoffPassed(date, Date.parse('2026-10-23T00:10:00+08:00')), true)
})

function fixture(t: any, options: { webhook?: boolean, syslogFails?: boolean } = {}) {
  const store = new Map<string, string>()
  const KV = {
    async get(key: string, type?: string) { const v = store.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
  // Empty D1: no source rows and no source key report rows for the target date. system_logs inserts are recorded.
  const syslogs: { level: string, cron: string, message: string, meta: any }[] = []
  const db = {
    prepare: (sql: string) => {
      let args: any[] = []
      const statement: any = {
        bind: (...values: any[]) => { args = values; return statement },
        first: async () => null,
        all: async () => ({ success: true, results: [] }),
        run: async () => {
          if (/INSERT INTO system_logs/.test(sql)) {
            if (options.syslogFails) throw new Error('D1_ERROR: ops unavailable')
            syslogs.push({ level: args[0], cron: args[1], message: args[2], meta: args[3] ? JSON.parse(args[3]) : null })
          }
          return { success: true, meta: { changes: 0 } }
        },
      }
      return statement
    },
    batch: async () => [],
  }
  const env = {
    ML_CONTROLLER_URL: 'https://controller.invalid', FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED: 'true',
    ...(options.webhook === false ? {} : { DISCORD_WEBHOOK_URL: 'https://discord.invalid/webhook' }), KV,
    DB: db, CORE_DB: db, MARKET_DB: db, LEARNING_DB: db, OPS_DB: db, EXECUTION_DB: db, PAPER_DB: db, RESEARCH_DB: db,
    UPDATE_QUEUE: { send: async () => {} },
  } as unknown as Bindings
  const dispatches: any[] = []
  const alerts: string[] = []
  const fetched: string[] = []
  const warns: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warns.push(args.map(String).join(' ')) })
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    fetched.push(String(url))
    if (String(url).startsWith('https://discord.invalid')) {
      alerts.push(JSON.parse(String(init.body)).content)
      return new Response(null, { status: 204 })
    }
    const body = JSON.parse(String(init.body))
    dispatches.push(body)
    // The handler may have started (and sent its start heartbeat) behind a front-end 5xx.
    if (controller.heartbeat) setLog('finlab-v4-backfill', { status: 'running', timestamp: new Date().toISOString(),
      summary: `running run_id=${body.run_id} dispatch_attempt=${body.dispatch_attempt}` })
    if (controller.html) return new Response('<!DOCTYPE html><html><title>Error 502</title></html>', { status: 502 })
    if (controller.appError) return Response.json({ detail: 'controller rejected dispatch' }, { status: 422 })
    return Response.json({ status: 'spawned', run_id: body.run_id, function_call_id: `fc-${body.dispatch_attempt}` })
  })
  const controller = { html: false, heartbeat: false, appError: false }
  const log = (task: string) => JSON.parse(store.get(`scheduler:run:${task}:${date}`) ?? 'null')
  const setLog = (task: string, entry: Record<string, unknown>) =>
    store.set(`scheduler:run:${task}:${date}`, JSON.stringify({ task, run_date: date, run_id: runId, ...entry }))
  const notReady = (attempt: number, clock: string) => setLog('finlab-v4-backfill', {
    status: 'error', timestamp: new Date(at(clock)).toISOString(),
    summary: `ValueError: daily_composition_market_dates_missing:margin_balance dispatch_attempt=${attempt} function_call_id=fc-${attempt}`,
  })
  const watchdogAt = async (clock: string) => {
    t.mock.timers.enable({ apis: ['Date'], now: at(clock) })
    try { return await runFinLabBackfillWatchdog(env, date) } finally { t.mock.timers.reset() }
  }
  const lateLaneLogs = () => syslogs.filter((entry) => /^late_lane_/.test(entry.meta?.reason ?? ''))
  return { env, store, log, setLog, notReady, watchdogAt, dispatches, alerts, fetched, warns, syslogs, lateLaneLogs, controller }
}

test('T-W2: the watchdog retries a late lane with the same run_id past the 3-attempt cap until 23:00', async (t) => {
  const f = fixture(t)
  f.notReady(1, '21:16')
  assert.match(await f.watchdogAt('21:20'), /^skipped: FinLab late lane not ready age=/)
  assert.equal(f.dispatches.length, 0)

  const summary = await f.watchdogAt('21:40')
  assert.match(summary, /^triggered finlab-v4-backfill/)
  assert.equal(f.dispatches.length, 1)
  const sent = f.dispatches[0]
  assert.equal(sent.run_id, runId)
  assert.equal(sent.dispatch_attempt, 2)
  assert.equal(sent.supersede_function_call_id, 'fc-1')
  assert.equal(sent.daily_source_refresh, true)
  assert.ok(String(sent.lanes).split(',').includes('chip_diversity'))
  // No key rows for the target: the whole chip lane is refetched, not just required foreign_net keys.
  assert.deepEqual(JSON.parse(sent.key_scope_json).find((entry: any) => entry.lane === 'chip_diversity'),
    { lane: 'chip_diversity', fields: [] })
  assert.match(f.log('finlab-v4-backfill').summary, /watchdog_retriggered_from_attempt=1/)
  assert.equal(f.log('evening-chain').status, 'triggered')
  assert.match(f.log('evening-chain').summary, /late lane not ready/)

  // A fourth attempt is still sent at 22:50 (the generic cap is 3).
  f.notReady(3, '22:30')
  await f.watchdogAt('22:50')
  assert.equal(f.dispatches.at(-1).dispatch_attempt, 4)
  assert.equal(f.alerts.length, 0)
  assert.equal(f.lateLaneLogs().length, 0, 'retries before the cutoff are not reported')

  // From 23:00 no new attempt: terminal error and one ops error (no Discord, even with a webhook set).
  f.notReady(4, '22:45')
  const failed = await f.watchdogAt('23:00')
  assert.equal(f.dispatches.length, 2)
  assert.equal(failed, `failed: FinLab late lane not published by 23:00 TW cutoff fields=margin_balance,short_balance dispatch_attempt=4 run_id=${runId}`)
  assert.equal(f.log('finlab-v4-backfill').status, 'error')
  assert.equal(f.log('evening-chain').status, 'error')
  assert.equal(f.log('evening-chain').summary, failed)
  assert.equal(f.alerts.length, 0)
  assert.deepEqual(f.lateLaneLogs(), [{ level: 'error', cron: 'evening-chain', message: failed,
    meta: { run_date: date, run_id: runId, reason: 'late_lane_cutoff' } }])
  assert.equal(f.warns.filter((line) => line === `[FinLab] ${failed}`).length, 1)
  // The terminal head is no longer pending: later ticks neither dispatch nor log again.
  assert.match(await f.watchdogAt('23:10'), /^skipped: no pending FinLab trigger/)
  assert.equal(f.dispatches.length, 2)
  assert.equal(f.lateLaneLogs().length, 1)
  // The same date and reason reached again (a not-ready head rewritten after the cutoff) is not logged twice.
  f.notReady(4, '22:45')
  assert.equal(await f.watchdogAt('23:20'), failed)
  assert.equal(f.lateLaneLogs().length, 1)
  assert.equal(f.warns.filter((line) => line === `[FinLab] ${failed}`).length, 1)
  assert.equal(f.alerts.length, 0)
})

test('T-W2: real failures keep the old path and a succeeded chain is left alone', async (t) => {
  const f = fixture(t)
  f.setLog('finlab-v4-backfill', {
    status: 'error', timestamp: new Date(at('21:16')).toISOString(),
    summary: 'ValueError: daily_composition_market_dates_missing:pe dispatch_attempt=1',
  })
  assert.match(await f.watchdogAt('21:40'), /^skipped: no pending FinLab trigger/)
  f.setLog('finlab-v4-backfill', {
    status: 'error', timestamp: new Date(at('21:16')).toISOString(),
    summary: 'daily_composition_history_changed:margin_balance dispatch_attempt=1',
  })
  assert.match(await f.watchdogAt('21:40'), /^skipped: no pending FinLab trigger/)
  f.notReady(1, '21:16')
  f.setLog('evening-chain', { status: 'success', timestamp: new Date(at('21:30')).toISOString(), summary: 'done' })
  assert.match(await f.watchdogAt('21:40'), /^skipped: evening-chain already succeeded/)
  assert.equal(f.dispatches.length, 0)
  assert.equal(f.alerts.length, 0)
  assert.equal(f.lateLaneLogs().length, 0)
})

test('T-W2: the generic 3-attempt cap still applies to partial failures', async (t) => {
  const f = fixture(t)
  f.setLog('finlab-v4-backfill', {
    status: 'error', timestamp: new Date(at('21:16')).toISOString(),
    summary: 'partial_failed lanes=chip_diversity dispatch_attempt=3',
  })
  assert.match(await f.watchdogAt('21:40'), /^failed: FinLab pending watchdog exhausted/)
  assert.equal(f.dispatches.length, 0)
})

test('Q9: a late-lane retry left dispatch_unconfirmed by an HTML 5xx is still bounded by the cutoff, not 3 attempts', async (t) => {
  const f = fixture(t)
  f.notReady(2, '21:50')
  f.controller.html = true
  assert.match(await f.watchdogAt('22:10'), /dispatch_unconfirmed .* dispatch_attempt=3 error=html_502$/)
  const pending = f.log('finlab-v4-backfill')
  assert.equal(pending.status, 'triggered')
  assert.match(pending.summary, /late_lane_retry=1/)
  // Attempt 3 is lost: the watchdog resends attempt 4 (the generic cap would stop at 3), same run_id, whole chip lane.
  f.controller.html = false
  await f.watchdogAt('22:30')
  assert.equal(f.dispatches.length, 2)
  assert.equal(f.dispatches[1].dispatch_attempt, 4)
  assert.equal(f.dispatches[1].run_id, runId)
  assert.match(f.log('finlab-v4-backfill').summary, /late_lane_retry=1/)
  // Attempt 4 is lost too and the cutoff has passed: no new attempt, terminal error and alerts.
  f.setLog('finlab-v4-backfill', { status: 'triggered', timestamp: new Date(at('22:41')).toISOString(),
    summary: 'triggered finlab-v4-backfill dispatch_unconfirmed function_call_id=unknown dispatch_attempt=4 error=html_502; watchdog_retriggered_from_attempt=3 late_lane_retry=1' })
  assert.match(await f.watchdogAt('22:50'), /below watchdog threshold/)
  const failed = await f.watchdogAt('23:00')
  assert.match(failed, /^failed: FinLab late lane not published by 23:00 TW cutoff .* dispatch_attempt=4 /)
  assert.equal(f.dispatches.length, 2)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.equal(f.alerts.length, 0)
  assert.deepEqual(f.lateLaneLogs().map((entry) => [entry.message, entry.meta.reason]), [[failed, 'late_lane_cutoff']])
  // A plain pending dispatch without the marker keeps the generic cap.
  f.setLog('finlab-v4-backfill', { status: 'triggered', timestamp: new Date(at('21:20')).toISOString(),
    summary: 'triggered finlab-v4-backfill dispatch_unconfirmed function_call_id=unknown dispatch_attempt=3 error=html_502' })
  assert.match(await f.watchdogAt('21:40'), /^failed: FinLab pending watchdog exhausted/)
})

test('T-W2: a late lane stops at the controller dispatch_attempt limit (5) and the cutoff settles it', async (t) => {
  const f = fixture(t)
  f.notReady(4, '22:00')
  await f.watchdogAt('22:20')
  assert.equal(f.dispatches.at(-1).dispatch_attempt, 5)
  // Attempt 5 not ready again before the cutoff: no attempt 6 (the controller rejects it), no alert.
  f.notReady(5, '22:30')
  assert.match(await f.watchdogAt('22:50'), /^skipped: FinLab late lane at dispatch attempt limit dispatch_attempt=5; awaiting 23:00 TW cutoff/)
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.alerts.length, 0)
  assert.equal(f.lateLaneLogs().length, 0)
  // Attempt 5 lost (still pending) before the cutoff: also no resend.
  f.setLog('finlab-v4-backfill', { status: 'triggered', timestamp: new Date(at('22:20')).toISOString(),
    summary: 'triggered finlab-v4-backfill dispatch_unconfirmed function_call_id=unknown dispatch_attempt=5 error=html_502; watchdog_retriggered_from_attempt=4 late_lane_retry=1' })
  assert.match(await f.watchdogAt('22:50'), /at dispatch attempt limit dispatch_attempt=5/)
  assert.equal(f.dispatches.length, 1)
  // At the cutoff the chain fails terminally and update is blocked like a failed FinLab callback.
  const failed = await f.watchdogAt('23:00')
  assert.match(failed, /^failed: FinLab late lane not published by 23:00 TW cutoff .* dispatch_attempt=5 /)
  assert.equal(f.log('update').status, 'blocked')
  assert.equal(f.log('update').summary, `status=blocked blocked_by=finlab-v4-backfill executed=false; ${failed}`)
  assert.equal(f.alerts.length, 0)
  assert.equal(f.lateLaneLogs().length, 1, 'update blocked adds no second ops log')
})

test('R8-a: a start heartbeat that arrives behind an HTML 5xx is not overwritten by the watchdog', async (t) => {
  const f = fixture(t)
  f.notReady(1, '21:16')
  f.controller.html = true
  f.controller.heartbeat = true
  assert.match(await f.watchdogAt('21:40'), /dispatch_unconfirmed .* dispatch_attempt=2 error=html_502$/)
  assert.equal(f.log('finlab-v4-backfill').status, 'running')
  assert.match(f.log('finlab-v4-backfill').summary, /dispatch_attempt=2/)
})

test('R8-a: the manual trigger route keeps a start heartbeat over an unconfirmed dispatch outcome', async (t) => {
  const f = fixture(t)
  const unconfirmed = `triggered finlab-v4-backfill dispatch_unconfirmed run_id=${runId} function_call_id=unknown dispatch_attempt=1 error=html_502`
  f.setLog('finlab-v4-backfill', { status: 'triggered', timestamp: new Date(at('21:16')).toISOString(), summary: 'reserved' })
  assert.equal(await finLabDispatchSupersededByStart(f.env, date, unconfirmed), false)
  f.setLog('finlab-v4-backfill', { status: 'running', timestamp: new Date(at('21:16')).toISOString(), summary: 'running' })
  assert.equal(await finLabDispatchSupersededByStart(f.env, date, unconfirmed), true)
  // A confirmed outcome, another run, or no run_id never suppresses the log.
  assert.equal(await finLabDispatchSupersededByStart(f.env, date, unconfirmed.replace(' dispatch_unconfirmed', '')), false)
  assert.equal(await finLabDispatchSupersededByStart(f.env, date, unconfirmed.replace(runId, 'other-run')), false)
  assert.equal(await finLabDispatchSupersededByStart(f.env, date, 'triggered finlab-v4-backfill dispatch_unconfirmed error=html_502'), false)
  const route = readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
  assert.equal(route.split('if (!maintenanceOwned && !await finLabOwnsRunLog(c.env, task, requestedRunDate, summary)) await logSchedulerResult(').length, 3,
    'both the async and sync trigger paths are guarded')
})

test('R8-a: a manual archive dispatch with an unknown outcome stays a failure; an evening one goes to the watchdog under the FinLab run_id', async (t) => {
  const f = fixture(t)
  f.controller.html = true
  ;(f.env as any).FINLAB_BACKFILL_LANES = 'chip_diversity'
  const { buildAdminGcpTriggerTaskMap } = await import('./adminTriggerGcpTasks')
  const { classifySchedulerSummary } = await import('./schedulerRunLogger')
  const handler = (query: Record<string, string>) => buildAdminGcpTriggerTaskMap(
    { env: f.env, req: { query: (k: string) => query[k] } } as any, {} as any)['finlab-v4-backfill']
  const archive = String(await handler({ date })())
  assert.match(archive, /^failed \(dispatch_unconfirmed\): triggered finlab-v4-backfill dispatch_unconfirmed run_id=\S+ .*archive dispatch is not resent by the watchdog$/)
  assert.equal(classifySchedulerSummary(archive), 'error')
  const evening = String(await handler({ date, continue_evening_chain: '1' })())
  assert.match(evening, /^triggered finlab-v4-backfill dispatch_unconfirmed run_id=finlab-v4-daily-/)
  assert.equal(classifySchedulerSummary(evening), 'triggered')
  // The route logs the FinLab run_id (what the watchdog resends and the callback fence compare), not the ticket id.
  const route = readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
  assert.ok(route.includes('run_id: finLabRunLogId(task, summary) ?? runId,') && route.includes('run_id: finLabRunLogId(task, summary) ?? syncRunId,'))
})

test('C28-25: a scheduled root while the evening chain waits on the late lane neither starts a run nor overwrites the waiting record', async (t) => {
  const f = fixture(t)
  const waiting = { status: 'waiting', timestamp: new Date(at('21:40')).toISOString(),
    summary: 'status=waiting awaiting_late_lane fields=margin_balance,short_balance cutoff=23:00 TW; FinLab watchdog retries' }
  f.setLog('evening-chain', waiting)
  const { classifySchedulerSummary } = await import('./schedulerRunLogger')
  const { createAdminTriggerRoutes } = await import('../routes/adminTriggerRoutes')
  const { DatabaseSync } = await import('node:sqlite')
  // The trigger route (sync and async) with the real evening-chain task, as a manual or GCP resend would call it.
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8'))
  const ops = { prepare(query: string) {
    let args: any[] = []
    const statement = { bind(...values: any[]) { args = values; return statement },
      async first() { return sql.prepare(query).get(...args) ?? null },
      async all() { return { results: sql.prepare(query).all(...args), meta: { size_after: 0 } } },
      async run() { return { success: true, meta: { changes: Number(sql.prepare(query).run(...args).changes) } } } }
    return statement
  } }
  const env = { ...(f.env as any), LOCAL_AUTH_BYPASS: '1', ENVIRONMENT: 'test', OPS_DB: ops, MULTI_D1_ACTIVE_DOMAINS: 'ops',
    DB: { prepare: () => ({ bind() { return this }, all: async () => ({ results: [], meta: { size_after: 0 } }), first: async () => null,
      run: async () => ({ success: true, meta: { changes: 0 } }) }) } }
  const pending: Promise<unknown>[] = []
  const routes = createAdminTriggerRoutes({ buildTaskMap: () => ({ 'evening-chain': () => runDailyUpdate(env) }) })
  const trigger = (query: string) => routes.request(`https://stockvision.invalid/api/admin/trigger/evening-chain?${query}`, { method: 'POST' }, env,
    { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException() {} } as any)
  t.mock.timers.enable({ apis: ['Date'], now: at('21:45') })
  try {
    const result = await runDailyUpdate(f.env)
    assert.match(result, /^running: full evening chain awaiting FinLab late lane for 2026-10-22; evening-chain root suppressed late_lane_owner=finlab_watchdog$/)
    // Non-terminal, like the existing in-flight suppression: a scheduler root ticket is not closed as skipped.
    assert.equal(classifySchedulerSummary(result), 'running')
    const sync = await trigger('sync=1')
    assert.equal(sync.status, 200)
    assert.equal(((await sync.json()) as any).result, result)
    // evening-chain is sync-only: an async request is refused before it can run.
    assert.equal((await trigger('')).status, 409)
    await Promise.all(pending)
    assert.equal(f.dispatches.length, 0)
    assert.equal(f.log('evening-chain').status, 'waiting')
    assert.equal(f.log('evening-chain').summary, waiting.summary)
    // The watchdog still owns the run afterwards.
    assert.doesNotMatch(String(await runFinLabBackfillWatchdog(f.env, date)), /already succeeded/)
  } finally { t.mock.timers.reset(); sql.close() }
  // After the cutoff, or for a waiting record that is not a late-lane wait, a manual restart is not suppressed.
  t.mock.timers.enable({ apis: ['Date'], now: at('23:05') })
  try {
    assert.doesNotMatch(String(await runDailyUpdate(f.env).catch((error) => String(error))), /awaiting FinLab late lane/)
  } finally { t.mock.timers.reset() }
  f.setLog('evening-chain', { ...waiting, summary: 'status=waiting other' })
  t.mock.timers.enable({ apis: ['Date'], now: at('21:45') })
  try {
    assert.doesNotMatch(String(await runDailyUpdate(f.env).catch((error) => String(error))), /awaiting FinLab late lane/)
  } finally { t.mock.timers.reset() }
})

test('C28-25: a definite late-lane resend failure alerts at once instead of waiting for the cutoff', async (t) => {
  const f = fixture(t)
  f.controller.appError = true
  f.notReady(1, '21:15')
  const summary = await f.watchdogAt('21:40')
  assert.equal(f.dispatches.length, 1)
  assert.equal(f.log('finlab-v4-backfill').status, 'error')
  assert.equal(f.log('evening-chain').status, 'error')
  assert.match(f.log('evening-chain').summary, /^failed: FinLab watchdog late lane resend failed run_id=\S+ dispatch_attempt=2; /)
  assert.ok(f.log('evening-chain').summary.endsWith(summary))
  assert.equal(f.alerts.length, 0)
  const failed = f.log('evening-chain').summary
  assert.deepEqual(f.lateLaneLogs(), [{ level: 'error', cron: 'evening-chain', message: failed,
    meta: { run_date: date, run_id: runId, reason: 'late_lane_resend_failed' } }])
  assert.equal(f.warns.filter((line) => line === `[FinLab] ${failed}`).length, 1)
  assert.equal(f.log('update').status, 'blocked')
  assert.match(f.log('update').summary, /^status=blocked blocked_by=finlab-v4-backfill executed=false; failed: FinLab watchdog late lane resend failed /)
  // A second resend failure the same date is not logged again.
  f.notReady(2, '21:45')
  await f.watchdogAt('22:10')
  assert.equal(f.dispatches.length, 2)
  assert.match(f.log('evening-chain').summary, /^failed: FinLab watchdog late lane resend failed run_id=\S+ dispatch_attempt=3; /)
  assert.equal(f.lateLaneLogs().length, 1)
  assert.equal(f.warns.filter((line) => /^\[FinLab\] failed: FinLab watchdog late lane resend failed/.test(line)).length, 1)
  // The cutoff is another reason and is logged once on its own.
  f.notReady(3, '22:45')
  const cutoff = await f.watchdogAt('23:00')
  assert.match(cutoff, /^failed: FinLab late lane not published by 23:00 TW cutoff /)
  assert.deepEqual(f.lateLaneLogs().map((entry) => entry.meta.reason), ['late_lane_resend_failed', 'late_lane_cutoff'])
  assert.equal(f.alerts.length, 0)
})

test('C28-25: without a Discord webhook the cutoff and resend failures still reach the ops log and console.warn', async (t) => {
  const f = fixture(t, { webhook: false })
  assert.equal((f.env as any).DISCORD_WEBHOOK_URL, undefined)
  f.controller.appError = true
  f.notReady(1, '21:15')
  await f.watchdogAt('21:40')
  const resend = f.log('evening-chain').summary
  assert.match(resend, /^failed: FinLab watchdog late lane resend failed /)
  f.notReady(2, '22:45')
  const cutoff = await f.watchdogAt('23:00')
  assert.deepEqual(f.lateLaneLogs().map((entry) => [entry.level, entry.cron, entry.message, entry.meta.reason]), [
    ['error', 'evening-chain', resend, 'late_lane_resend_failed'],
    ['error', 'evening-chain', cutoff, 'late_lane_cutoff'],
  ])
  assert.ok(f.warns.includes(`[FinLab] ${resend}`))
  assert.ok(f.warns.includes(`[FinLab] ${cutoff}`))
  assert.ok(f.fetched.every((url) => url.startsWith('https://controller.invalid')), f.fetched.join(','))
  assert.equal(f.alerts.length, 0)
})

test('C28-25: a failing ops log or KV never fails the watchdog and still warns', async (t) => {
  const f = fixture(t, { webhook: false, syslogFails: true })
  f.notReady(4, '22:45')
  const failed = await f.watchdogAt('23:00')
  assert.match(failed, /^failed: FinLab late lane not published by 23:00 TW cutoff /)
  assert.equal(f.log('evening-chain').status, 'error')
  assert.equal(f.lateLaneLogs().length, 0)
  assert.ok(f.warns.includes(`[FinLab] ${failed}`))
  // A KV failure on the dedup claim is swallowed as well.
  const g = fixture(t, { webhook: false })
  const get = g.env.KV.get.bind(g.env.KV)
  ;(g.env.KV as any).get = async (key: string, type?: string) => {
    if (key.startsWith('finlab:late-lane-')) throw new Error('KV unavailable')
    return get(key, type as any)
  }
  g.notReady(4, '22:45')
  assert.equal(await g.watchdogAt('23:00'), failed)
  assert.equal(g.lateLaneLogs().length, 0)
  assert.ok(g.warns.some((line) => line.startsWith(`[FinLab] ${failed}; ops log failed: KV unavailable`)))
  // An ops binding that cannot be resolved (it throws, unlike a failed insert) is swallowed too.
  // It is dropped only once the dedup key is claimed, so the watchdog's own ops reads are unaffected.
  const h = fixture(t, { webhook: false })
  const put = h.env.KV.put.bind(h.env.KV)
  ;(h.env.KV as any).put = async (key: string, value: string, opts?: any) => {
    if (key.startsWith('finlab:late-lane-')) Object.assign(h.env as any, { OPS_DB: undefined, MULTI_D1_ACTIVE_DOMAINS: 'ops' })
    return put(key, value, opts)
  }
  h.notReady(4, '22:45')
  assert.equal(await h.watchdogAt('23:00'), failed)
  assert.equal(h.log('evening-chain').status, 'error')
  assert.equal(h.lateLaneLogs().length, 0)
  assert.ok(h.warns.includes(`[FinLab] ${failed}; ops log failed: data_domain_binding_missing:ops`))
})
