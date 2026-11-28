import assert from 'node:assert/strict'
import { classifySchedulerSummary } from './schedulerRunLogger'
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
  const env = {KV: {get: async () => null}, ML_CONTROLLER_URL: 'https://isolated-controller.invalid'} as unknown as Bindings
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
      {KV: {get: async () => null}, ML_CONTROLLER_URL: 'https://isolated-controller.invalid'} as unknown as Bindings,
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
        { KV: {get: async () => null}, ML_CONTROLLER_URL: 'https://isolated-controller.invalid' } as unknown as Bindings,
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
        { KV: {get: async () => null}, ML_CONTROLLER_URL: 'https://isolated-controller.invalid' } as unknown as Bindings, {} as any),
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
    await runActive8OofLifecycle({ KV: {get: async () => null}, ML_CONTROLLER_URL: 'https://isolated-controller.invalid' } as unknown as Bindings,
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
        { DB: db, OPS_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops', KV: {get: async () => null}, ML_CONTROLLER_URL: 'https://controller.invalid' } as any, {} as any)
    }
    assert.equal(calls, 0)
  } finally { globalThis.fetch = original }
})

test('plan blocked response remains visibly failed and never queues a retry', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({status: 'blocked', job_dispatched: false,
    reason: 'l4_daily_plan_pending_for_signal_date'})
  try {
    await assert.rejects(runActive8OofLifecycle({ KV: {get: async () => null}, ML_CONTROLLER_URL: 'https://controller.invalid',
      UPDATE_QUEUE: {send: async () => {throw new Error('must not retry')}} } as any,
      '2026-10-02', 'daily', {schedulerTicketId: 'ticket', schedulerRunId: 'run'}),
      /active8_daily_blocked:l4_daily_plan_pending_for_signal_date:awaiting=paper_plan_activation/)
  } finally { globalThis.fetch = original }
})

test('a pipeline that has not succeeded parks the daily job instead of dispatching it into a locked day', async () => {
  let calls = 0, replays = 0
  const original = globalThis.fetch
  globalThis.fetch = async (url: any) => {
    // The OPB arm replay is booked on its own when the job is not dispatched (2026-11-19).
    if (String(url).endsWith('/l4_distribution/opb-arm-replay')) { replays++; return Response.json({ status: 'spawned', execution_id: 'r' }) }
    calls++; return Response.json({ status: 'spawned' })
  }
  let stage: {status: string; last_error: string | null} | null = null
  // The replay run receipt (learning) is absent: every gate entry starts the replay job.
  const db = { prepare: (sql: string) => ({ bind: () => ({ all: async () => ({ results: [] }),
    first: async () => sql.includes('l4_opb_arm_replay_runs_v1') ? null : stage }) }) }
  const env = { DB: db, OPS_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops',
    PAPER_DAILY_PLAN_OWNER: 'premarket_once_v1', KV: {get: async () => null}, ML_CONTROLLER_URL: 'https://controller.invalid' } as any
  try {
    for (const [value, label] of [[null, 'missing'], [{status: 'error', last_error: 'timexer_gpu_unavailable'}, 'error'],
      [{status: 'running', last_error: null}, 'running'], [{status: 'queued', last_error: null}, 'queued'],
      [{status: 'waiting', last_error: null}, 'waiting']] as const) {
      stage = value
      assert.equal(await runActive8OofLifecycle(env, '2026-10-29', 'daily'),
        `active8_oof_lifecycle status=skipped reason=awaiting_pipeline job_dispatched=false signal_date=2026-10-29 pipeline_status=${label}`)
    }
    assert.equal(calls, 0)
    assert.equal(replays, 5)
    stage = {status: 'success', last_error: null}
    assert.match(await runActive8OofLifecycle(env, '2026-10-29', 'daily'), /status=spawned/)
    assert.equal(calls, 1)
    assert.equal(replays, 5, 'the dispatched job owns the replay')
  } finally { globalThis.fetch = original }
})

test('sealed nightly phase blocks watchdog before Cloud Run and resumes after publication', async () => {
  let calls = 0, replays = 0, published = false
  const kv = new Map<string, string>()
  const original = globalThis.fetch
  globalThis.fetch = async (url: any) => {
    if (String(url).endsWith('/l4_distribution/opb-arm-replay')) {
      replays++
      // The job finishes after this tick returns and leaves its run receipt.
      runReceipt = { status: 'ok', complete: 1, failed_dates_json: '[]', deferred_dates_json: '[]',
        rejected_dates_json: '["2026-09-24"]', finished_at: '2026-10-02T18:10:00Z' }
      return Response.json({ status: 'spawned', execution_id: 'r' })
    }
    calls++; return Response.json({ status: 'spawned' })
  }
  let runReceipt: Record<string, unknown> | null = null
  const db = { prepare: (sql: string) => ({ bind: (date: string) => {
    assert.equal(date, '2026-10-02')
    return { all: async () => ({ results: [] }), first: async () => sql.includes('l4_opb_arm_replay_runs_v1') ? runReceipt
      : ({ status: published ? 'success' : 'waiting', last_error: published ? null : 'awaiting_premarket' }), run: async () => ({}) }
  } }) }
  const env = { DB: db, OPS_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops',
    PAPER_DAILY_PLAN_OWNER: 'premarket_once_v1', KV: {get: async (key: string, type?: string) => kv.has(key) ? (type === 'json' ? JSON.parse(kv.get(key)!) : kv.get(key)) : null,
      put: async (key: string, value: string) => { kv.set(key, value) }}, ML_CONTROLLER_URL: 'https://controller.invalid' } as any
  try {
    const summaries: string[] = []
    for (let tick = 0; tick < 12; tick++) {
      const summary = await runActive8OofLifecycle(env, '2026-10-02', 'daily')
      assert.match(summary, /reason=awaiting_premarket job_dispatched=false/)
      summaries.push(summary)
    }
    assert.equal(calls, 0)
    assert.equal(replays, 1, 'one independent replay execution per business date, not one per watchdog tick')
    // A terminal rejection is visible on the task summary without changing its status class.
    assert.doesNotMatch(summaries[0], /attention=/)
    for (const summary of summaries.slice(1)) {
      assert.match(summary, / attention=opb_replay_rejected:1$/)
      assert.equal(classifySchedulerSummary(summary), classifySchedulerSummary(summaries[0]))
    }
    published = true
    assert.match(await runActive8OofLifecycle(env, '2026-10-02', 'daily'), /status=spawned/)
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})
