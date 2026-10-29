import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { isFinLabDispatchTransportError } from './controllerResearchWorkflows'
import { finLabStartMarkerKey } from './finLabDispatchFence'
import { dispatchEveningFinLabRefresh, finLabDispatchSupersededByStart, runFinLabBackfillWatchdog } from './updateOrchestrator'
import type { Bindings } from '../types'

// R33-NEW-32: B3-F residuals. (1) Workers fetch can reject with a plain Error, not only TypeError.
// (2) A `triggered` write from one colo can land over the start heartbeat written in another.

const date = '2026-10-22'
const runId = 'finlab-v4-daily-20261022-1'
const at = (clock: string) => Date.parse(`${date}T${clock}:00+08:00`)
const scope = { lanes: 'chip_diversity', reuseSuccessfulArtifacts: false }

function fixture(t: any) {
  const store = new Map<string, string>()
  const KV = {
    async get(key: string, type?: string) { const v = store.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
  const statement: any = {
    bind: () => statement, first: async () => null,
    all: async () => ({ success: true, results: [] }), run: async () => ({ success: true, meta: { changes: 0 } }),
  }
  const db = { prepare: () => statement, batch: async () => [] }
  const env = {
    ML_CONTROLLER_URL: 'https://controller.invalid', FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED: 'true', KV,
    DB: db, CORE_DB: db, MARKET_DB: db, LEARNING_DB: db, OPS_DB: db, EXECUTION_DB: db, PAPER_DB: db, RESEARCH_DB: db,
    UPDATE_QUEUE: { send: async () => {} },
  } as unknown as Bindings
  const dispatches: any[] = []
  const controller: { onDispatch?: (body: any) => void; respond?: (body: any) => Response } = {}
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    dispatches.push(body)
    controller.onDispatch?.(body)
    return controller.respond?.(body) ?? Response.json({ status: 'spawned', run_id: body.run_id, function_call_id: `fc-${body.dispatch_attempt}`,
      dispatch_attempt: body.dispatch_attempt })
  })
  const log = () => JSON.parse(store.get(`scheduler:run:finlab-v4-backfill:${date}`) ?? 'null')
  const setLog = (entry: Record<string, unknown>) => store.set(`scheduler:run:finlab-v4-backfill:${date}`,
    JSON.stringify({ task: 'finlab-v4-backfill', run_date: date, run_id: runId, ...entry }))
  const watchdogAt = async (clock: string) => {
    t.mock.timers.enable({ apis: ['Date'], now: at(clock) })
    try { return await runFinLabBackfillWatchdog(env, date) } finally { t.mock.timers.reset() }
  }
  return { env, store, log, setLog, watchdogAt, dispatches, controller }
}

test('Workers network errors that are not TypeError leave the dispatch outcome unknown', () => {
  for (const error of [new Error('Network connection lost.'), new Error('internal error; reference = 0a1b2c'),
    new TypeError('fetch failed'), new Error('read ECONNRESET'), new DOMException('timeout', 'TimeoutError')]) {
    assert.equal(isFinLabDispatchTransportError(error), true, String(error))
  }
  for (const error of [new Error('FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED not enabled; FinLab primary canonical refresh is blocked'),
    new Error('ML_CONTROLLER_URL not set'), new SyntaxError('Unexpected token < in JSON (network)'), 'network', null]) {
    assert.equal(isFinLabDispatchTransportError(error), false, String(error))
  }
})

test('an evening dispatch rejected with a plain network Error keeps the reservation for the watchdog', async (t) => {
  const f = fixture(t)
  f.controller.respond = () => { throw new Error('Network connection lost.') }
  const result = await dispatchEveningFinLabRefresh(f.env, date, false, scope)
  assert.match(result.summary, /dispatch_unconfirmed .* error=Error$/)
  assert.equal(f.log().status, 'triggered')
})

test('an accepted dispatch does not report its outcome over a start heartbeat already received', async (t) => {
  {
    // Same colo: the heartbeat replaced the head while the request was in flight.
    const f = fixture(t)
    f.controller.onDispatch = (body) => f.setLog({ status: 'running', run_id: body.run_id, summary: `running dispatch_attempt=1` })
    const result = await dispatchEveningFinLabRefresh(f.env, date, false, scope)
    assert.match(result.summary, /callback expected$/)
    assert.equal(result.startObserved, true)
    t.mock.restoreAll()
  }
  {
    // Other colo: only the per-attempt start marker is visible here.
    const f = fixture(t)
    f.controller.onDispatch = (body) => f.store.set(finLabStartMarkerKey(date, body.run_id, 1), 'x')
    const result = await dispatchEveningFinLabRefresh(f.env, date, false, scope)
    assert.equal(result.startObserved, true)
    assert.equal(await finLabDispatchSupersededByStart(f.env, date, result.summary), true)
    t.mock.restoreAll()
  }
  {
    const f = fixture(t)
    const result = await dispatchEveningFinLabRefresh(f.env, date, false, scope)
    assert.equal(result.startObserved, false)
    assert.equal(await finLabDispatchSupersededByStart(f.env, date, result.summary), false)
    t.mock.restoreAll()
  }
})

test('the watchdog treats a triggered head as started when that attempt has a start marker', async (t) => {
  const triggered = (attempt: number) => ({ status: 'triggered', timestamp: new Date(at('21:00')).toISOString(),
    summary: `triggered finlab-v4-backfill run_id=${runId} function_call_id=fc-${attempt} dispatch_attempt=${attempt} callback expected` })
  {
    const f = fixture(t)
    f.setLog(triggered(1))
    f.store.set(finLabStartMarkerKey(date, runId, 1), 'x')
    assert.match(await f.watchdogAt('21:30'), /^skipped: FinLab start heartbeat received for 2026-10-22 \(start marker/)
    assert.equal(f.dispatches.length, 0)
    t.mock.restoreAll()
  }
  {
    // A marker for an earlier attempt does not cover a newer pending attempt.
    const f = fixture(t)
    f.setLog(triggered(2))
    f.store.set(finLabStartMarkerKey(date, runId, 1), 'x')
    assert.doesNotMatch(await f.watchdogAt('21:30'), /start marker/)
    assert.equal(f.dispatches.length, 1)
    assert.equal(f.dispatches[0].dispatch_attempt, 3)
    t.mock.restoreAll()
  }
  {
    const f = fixture(t)
    f.setLog(triggered(1))
    await f.watchdogAt('21:30')
    assert.equal(f.dispatches.length, 1)
    t.mock.restoreAll()
  }
})

test('the start heartbeat callback writes the per-attempt marker after the dispatch fence', () => {
  const routes = readFileSync(new URL('../routes/adminControlRoutes.ts', import.meta.url), 'utf8')
  const fence = routes.indexOf('if (fence.ignored) {')
  const marker = routes.indexOf('finLabStartMarkerKey(callbackRunDate, callbackRunId, fence.incomingAttempt)')
  assert(fence > 0 && marker > fence)
  assert(routes.slice(fence, marker).includes("body.status === 'running' && callbackRunId"))
})
