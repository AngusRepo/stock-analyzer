import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bindings } from '../types'
import { runActive8OofLifecycle } from './controllerResearchWorkflows'
import { processUpdateBatch } from './updateOrchestrator'

test('daily dispatch does not require OOF snapshot or trust an old OOF ticket before NAV', async () => {
  const requests: Array<{url: string; body: Record<string, unknown>}> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    requests.push({url: String(input), body: JSON.parse(String(init?.body))})
    return new Response(JSON.stringify({status: 'spawned', promoted: false}), {status: 200})
  }
  // No D1 bindings: any old snapshot/ticket preflight would fail this test.
  const env = {ML_CONTROLLER_URL: 'https://isolated-controller.invalid'} as Bindings
  try {
    const result = await runActive8OofLifecycle(env, '2026-09-09', 'daily')
    assert.match(result, /status=spawned/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://isolated-controller.invalid/walk_forward/oof/lifecycle')
    assert.equal(requests[0].body.end_date, '2026-09-09')
    assert.equal(requests[0].body.cadence, 'daily')
    assert.equal(requests[0].body.dry_run, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('daily NAV dispatch still fails visibly on controller rejection', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('fixture unavailable', {status: 503})
  try {
    await assert.rejects(runActive8OofLifecycle(
      {ML_CONTROLLER_URL: 'https://isolated-controller.invalid'} as Bindings,
      '2026-09-09', 'daily'), /HTTP503/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OOF-only synchronous daily results cannot certify the original NAV callback closure', async () => {
  const previousFetch = globalThis.fetch
  try {
    for (const status of ['idempotent_complete', 'materialized', 'shadow_evaluated', 'skipped']) {
      globalThis.fetch = async () => Response.json({ status, cohort_id: 'old-oof-only', promoted: false })
      await assert.rejects(runActive8OofLifecycle(
        { ML_CONTROLLER_URL: 'https://isolated-controller.invalid' } as Bindings,
        '2026-09-09', 'daily'), /active8_daily_completion_requires_original_job_callback/)
    }
  } finally { globalThis.fetch = previousFetch }
})

test('incomplete continuation identity must fail before dispatching a job', async () => {
  const previousFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({ status: 'spawned', promoted: false }) }
  try {
    for (const identity of [{ schedulerTicketId: 'ticket-only' }, { schedulerRunId: 'run-only' }]) {
      await assert.rejects(processUpdateBatch({ type: 'active8_oof_continuation', cursor: 0,
        triggerTime: '2026-09-09', oofCadence: 'daily', oofContinuationAttempt: 1, ...identity },
        { ML_CONTROLLER_URL: 'https://isolated-controller.invalid' } as Bindings, {} as any),
      /active8_oof_continuation_scheduler_identity_incomplete/)
      assert.equal(calls, 0, 'bad identity must never start a durable job')
    }
  } finally { globalThis.fetch = previousFetch }
})


test('long-running exact cohort preserves its attempt beyond the former twelve-poll cap', async () => {
  const previousFetch = globalThis.fetch
  let request: any
  globalThis.fetch = async (_input, init) => {
    request = JSON.parse(String(init?.body))
    return Response.json({ status: 'spawned', promoted: false })
  }
  try {
    await runActive8OofLifecycle({ ML_CONTROLLER_URL: 'https://isolated-controller.invalid' } as Bindings,
      '2026-09-18', 'weekly', { continuationAttempt: 13, continuationOnly: true, expectedCohortId: 'immutable-B' })
    assert.equal(request.continuation_attempt, 13)
    assert.equal(request.expected_cohort_id, 'immutable-B')
    assert.equal(request.continuation_only, true)
    assert.equal(request.promote, false)
  } finally { globalThis.fetch = previousFetch }
})


test('delayed continuations cannot reopen any terminal owner ticket', async () => {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => { calls++; throw new Error('must not dispatch') }
  try {
    for (const status of ['success', 'error', 'blocked', 'skipped']) {
      const db = { prepare: () => ({ bind: () => ({ first: async () => ({ ticket_id: 'ticket', status }) }) }) }
      await processUpdateBatch({ type: 'active8_oof_continuation', cursor: 0,
        triggerTime: '2026-10-02', oofCadence: 'daily', oofContinuationAttempt: 13,
        schedulerTicketId: 'ticket', schedulerRunId: 'run' },
        { DB: db, OPS_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops', ML_CONTROLLER_URL: 'https://controller.invalid' } as any, {} as any)
    }
    assert.equal(calls, 0)
  } finally { globalThis.fetch = original }
})

test('plan blocked response remains visibly failed and never queues a retry', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({status: 'blocked', job_dispatched: false,
    reason: 'l4_daily_plan_pending_for_signal_date'})
  try {
    await assert.rejects(runActive8OofLifecycle({ ML_CONTROLLER_URL: 'https://controller.invalid',
      UPDATE_QUEUE: {send: async () => {throw new Error('must not retry')}} } as any,
      '2026-10-02', 'daily', {schedulerTicketId: 'ticket', schedulerRunId: 'run'}),
      /active8_daily_blocked:l4_daily_plan_pending_for_signal_date:awaiting=paper_plan_activation/)
  } finally { globalThis.fetch = original }
})

test('sealed nightly phase blocks watchdog before Cloud Run and resumes after publication', async () => {
  let calls = 0, published = false
  const original = globalThis.fetch
  globalThis.fetch = async () => { calls++; return Response.json({ status: 'spawned' }) }
  const db = { prepare: () => ({ bind: (date: string) => {
    assert.equal(date, '2026-10-02')
    return { first: async () => ({ status: published ? 'success' : 'waiting', last_error: published ? null : 'awaiting_premarket' }) }
  } }) }
  const env = { DB: db, OPS_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops',
    PAPER_DAILY_PLAN_OWNER: 'premarket_once_v1', ML_CONTROLLER_URL: 'https://controller.invalid' } as any
  try {
    for (let tick = 0; tick < 12; tick++) {
      await assert.rejects(runActive8OofLifecycle(env, '2026-10-02', 'daily'), /active8_daily_blocked:awaiting_premarket/)
    }
    assert.equal(calls, 0)
    published = true
    assert.match(await runActive8OofLifecycle(env, '2026-10-02', 'daily'), /status=spawned/)
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})
