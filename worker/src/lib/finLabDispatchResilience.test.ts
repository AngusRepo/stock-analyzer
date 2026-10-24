import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runFinLabV4Backfill } from './controllerResearchWorkflows'
import { dispatchEveningFinLabRefresh, finLabSupersedeCallId } from './updateOrchestrator'
import { classifySchedulerSummary } from './schedulerRunLogger'
import type { Bindings } from '../types'

function fixture() {
  const store = new Map<string, string>()
  const KV = {
    async get(key: string, type?: string) { const v = store.get(key); return v == null ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
  const env = { ML_CONTROLLER_URL: 'https://controller.invalid', FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED: 'true', KV } as unknown as Bindings
  const finlabLog = () => JSON.parse(store.get('scheduler:run:finlab-v4-backfill:2026-10-22') ?? 'null')
  return { env, store, finlabLog }
}

function mockFetch(t: any, responses: Array<(body: any) => Response | Promise<Response>>) {
  const bodies: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    const next = responses[bodies.length - 1]
    if (!next) throw new Error('unexpected extra dispatch')
    return next(body)
  })
  return bodies
}

const daily = { dailySourceRefresh: true, continueEveningChain: true, runId: 'finlab-v4-daily-20261022-1', platformRetryDelaysMs: [0, 0] }

test('Cloud Run platform 5xx is resent with the same run_id until the controller accepts it', async (t) => {
  const { env } = fixture()
  const bodies = mockFetch(t, [
    () => new Response('<!DOCTYPE html><html><title>Error 502</title></html>', { status: 502 }),
    () => new Response('The request was aborted because there was no available instance.', { status: 500 }),
    (b) => Response.json({ status: 'spawned', run_id: b.run_id, function_call_id: 'fc-1' }),
  ])
  const summary = await runFinLabV4Backfill(env, '2026-10-22', false, daily)
  assert.equal(bodies.length, 3)
  assert.deepEqual(new Set(bodies.map((b) => b.run_id)), new Set([daily.runId]))
  assert.equal(classifySchedulerSummary(summary), 'triggered')
  assert.match(summary, /function_call_id=fc-1/)
})

test('controller app 5xx reached the non-idempotent spawn and is never resent', async (t) => {
  for (const response of [
    () => Response.json({ detail: 'spawn failed' }, { status: 500 }),
    () => new Response('Internal Server Error', { status: 500 }),
  ]) {
    const { env } = fixture()
    const bodies = mockFetch(t, [response])
    const summary = await runFinLabV4Backfill(env, '2026-10-22', false, daily)
    assert.equal(bodies.length, 1)
    assert.equal(classifySchedulerSummary(summary), 'error')
    t.mock.restoreAll()
  }
})

test('evening dispatch timeout leaves a pending reservation for the watchdog instead of a root error', async (t) => {
  const scope = { lanes: 'daily_price', reuseSuccessfulArtifacts: false }
  {
    const { env, finlabLog } = fixture()
    const bodies = mockFetch(t, [() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') }])
    const result = await dispatchEveningFinLabRefresh(env, '2026-10-22', false, scope)
    assert.equal(result.startObserved, false)
    assert.equal(classifySchedulerSummary(result.summary), 'triggered')
    assert.match(result.summary, new RegExp(`dispatch_unconfirmed run_id=${bodies[0].run_id} function_call_id=unknown dispatch_attempt=1`))
    // Reservation is what runFinLabBackfillWatchdog resends after FINLAB_PENDING_WATCHDOG_STALE_MS.
    assert.equal(finlabLog().status, 'triggered')
    assert.equal(finlabLog().run_id, bodies[0].run_id)
    // The watchdog must resend without a supersede target; `unknown` would fail the controller's cancel.
    assert.equal(finLabSupersedeCallId(finlabLog()), null)
    assert.equal(finLabSupersedeCallId({ summary: 'triggered finlab-v4-backfill function_call_id=fc-1 dispatch_attempt=1' }), 'fc-1')
    t.mock.restoreAll()
  }
  {
    // Modal's start heartbeat arrived while the HTTP request was timing out.
    const { env, store, finlabLog } = fixture()
    mockFetch(t, [(b) => {
      store.set('scheduler:run:finlab-v4-backfill:2026-10-22', JSON.stringify({
        task: 'finlab-v4-backfill', status: 'running', run_id: b.run_id, run_date: '2026-10-22', summary: 'running' }))
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }])
    const result = await dispatchEveningFinLabRefresh(env, '2026-10-22', false, scope)
    assert.equal(result.startObserved, true)
    assert.equal(finlabLog().status, 'running')
    t.mock.restoreAll()
  }
  {
    // Deterministic dispatch errors still fail the root and clear the reservation.
    const { env, finlabLog } = fixture()
    ;(env as any).FINLAB_BACKFILL_MODAL_TRIGGER_ENABLED = 'false'
    mockFetch(t, [])
    await assert.rejects(dispatchEveningFinLabRefresh(env, '2026-10-22', false, scope), /not enabled/)
    assert.equal(finlabLog().status, 'error')
  }
})
