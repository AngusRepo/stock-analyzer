import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifySchedulerSummary } from './schedulerRunLogger'
import { dispatchIndependentOpbReplay, opbIndependentReplayKey, opbReplayInFlightKey, IN_FLIGHT_TTL_SECONDS,
  OPB_REPLAY_DISPATCH_TIMEOUT_MS, OPB_REPLAY_BUSY_PERSISTENT_MS, opbReplayBusySinceKey,
  opbReplayBusyClearedKey } from './opbIndependentReplay'

// The controller owns the per-business-date cap (l4_opb_replay_dispatch.MAX_EXECUTIONS_PER_BUSINESS_DATE).
const CONTROLLER_CAP = 4
const noWorkerCount = (kv: Map<string, string>) => assert.ok(![...kv.keys()].some(k => /spawn/.test(k)), 'no Worker count')

type Receipt = { status: string; complete: number; progress: number; failed_dates_json: string; deferred_dates_json: string;
  rejected_dates_json: string; missing_price_dates_json: string; finished_at: string }

function harness(respond: (body: any) => Response | Promise<Response>) {
  const kv = new Map<string, string>()
  const ttl = new Map<string, number>()
  const bodies: any[] = []
  const logs: unknown[][] = []
  const state: { receipt: Receipt | null; receiptReads: string[] } = { receipt: null, receiptReads: [] }
  const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({
    run: async () => { logs.push(args); return {} },
    first: async () => {
      assert.match(sql, /FROM l4_opb_arm_replay_runs_v1\s+WHERE business_date=\? ORDER BY finished_at DESC LIMIT 1/)
      state.receiptReads.push(String(args[0]))
      return state.receipt
    } }) }) }
  const env = { DB: db, OPS_DB: db, LEARNING_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops', ML_CONTROLLER_URL: 'https://controller.invalid',
    KV: { get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string, options: { expirationTtl?: number }) => {
        assert.ok(Number(options.expirationTtl) > 0, 'markers expire'); kv.set(key, value); ttl.set(key, Number(options.expirationTtl)) },
      delete: async (key: string) => { kv.delete(key); ttl.delete(key) } } } as any
  globalThis.fetch = async (url: any, init: any) => {
    assert.match(String(url), /\/l4_distribution\/opb-arm-replay$/)
    const body = JSON.parse(init.body)
    bodies.push(body)
    return respond(body)
  }
  return { env, kv, ttl, bodies, logs, state }
}

const receipt = (over: Partial<Receipt> = {}): Receipt => ({ status: 'ok', complete: 1, progress: 0, failed_dates_json: '[]',
  deferred_dates_json: '[]', rejected_dates_json: '[]', missing_price_dates_json: '[]', finished_at: '2026-11-19T18:05:00Z', ...over })

test('one tick starts the job and returns; a later tick reads its receipt and marks the date', async () => {
  const original = globalThis.fetch
  try {
    const h = harness(() => Response.json({ status: 'spawned', execution_id: 'exec-1' }))
    assert.equal(await dispatchIndependentOpbReplay(h.env, '2026-11-19'), 'opb_replay=spawned')
    assert.deepEqual(h.bodies, [{ business_date: '2026-11-19' }])
    assert.equal(h.ttl.get(opbReplayInFlightKey('2026-11-19')), IN_FLIGHT_TTL_SECONDS)
    assert.equal(await dispatchIndependentOpbReplay(h.env, '2026-11-19'), 'opb_replay=in_flight')
    h.state.receipt = receipt()                     // the job finished
    assert.equal(await dispatchIndependentOpbReplay(h.env, '2026-11-19'), 'opb_replay=ok')
    assert.ok(h.kv.has(opbIndependentReplayKey('2026-11-19')))
    assert.equal(await dispatchIndependentOpbReplay(h.env, '2026-11-19'), 'opb_replay=already_done')
    assert.equal(h.bodies.length, 1, 'one execution for the night')
    assert.equal(h.state.receiptReads.length, 3, 'the marker ends receipt reads')
  } finally { globalThis.fetch = original }
})

test('an incomplete or failed run, a busy job or an unreachable controller is retried and never throws', async () => {
  const original = globalThis.fetch
  try {
    const cases: [() => Response, Receipt | null][] = [
      [() => Response.json({ status: 'spawned', execution_id: 'e' }), receipt({ complete: 0, deferred_dates_json: '["2026-11-10"]' })],
      [() => Response.json({ status: 'spawned', execution_id: 'e' }), receipt({ status: 'failed', complete: 0, failed_dates_json: '["2026-11-18"]' })],
      [() => Response.json({ status: 'busy', active_execution: 'oof-1' }), null],
      [() => new Response('boom', { status: 503 }), null],
      [() => { throw new Error('network down') }, null]]
    for (const [respond, incomplete] of cases) {
      const h = harness(respond)
      h.state.receipt = incomplete
      const first = await dispatchIndependentOpbReplay(h.env, '2026-11-19')
      assert.ok(['opb_replay=spawned', 'opb_replay=busy attention=opb_replay_busy',
        'opb_replay=dispatch_failed attention=opb_replay_dispatch_failed'].includes(first), first)
      assert.ok(!h.kv.has(opbIndependentReplayKey('2026-11-19')), 'not marked complete')
      h.kv.delete(opbReplayInFlightKey('2026-11-19'))   // the in-flight window expired
      await dispatchIndependentOpbReplay(h.env, '2026-11-19')
      assert.equal(h.bodies.length, 2, 'the next tick after the window asks again')
    }
  } finally { globalThis.fetch = original }
})

test('rejected days complete the date but carry an attention mark on every tick, never a failure status', async () => {
  const original = globalThis.fetch
  try {
    const h = harness(() => { throw new Error('must not dispatch a completed date') })
    h.state.receipt = receipt({ rejected_dates_json: '["2026-11-12","2026-11-13"]' })
    const summary = await dispatchIndependentOpbReplay(h.env, '2026-11-19')
    assert.equal(summary, 'opb_replay=ok rejected=2 attention=opb_replay_rejected:2')
    assert.equal(await dispatchIndependentOpbReplay(h.env, '2026-11-19'), 'opb_replay=already_done attention=opb_replay_rejected:2')
    assert.equal(h.bodies.length, 0)
    const [level, , , meta] = h.logs[0] as [string, string, string, string]
    assert.equal(level, 'warn')
    assert.deepEqual(JSON.parse(meta).rejected_dates, ['2026-11-12', '2026-11-13'])
    // The mark must not turn a waiting/skipped lifecycle into blocked or error.
    for (const base of ['active8_oof_lifecycle status=pending reason=awaiting_premarket job_dispatched=false',
      'active8_oof_lifecycle status=skipped reason=awaiting_pipeline job_dispatched=false']) {
      assert.equal(classifySchedulerSummary(base + ' signal_date=2026-11-19 attention=opb_replay_rejected:2'),
        classifySchedulerSummary(base + ' signal_date=2026-11-19'))
    }
    assert.equal(classifySchedulerSummary('opb_replay=ok rejected=2 attention=opb_replay_rejected:2'), 'success')
  } finally { globalThis.fetch = original }
})

test('the dispatch call is short: the replay runs in a Cloud Run Job, not in the Scheduler delivery', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../infra/gcp-scheduler-jobs.json', import.meta.url), 'utf8'))
  const fallback = manifest.governance.defaults.attemptDeadline as string
  const jobs = (manifest.jobs as { id: string; task: string; attemptDeadline?: string }[])
    .filter(job => job.task === 'active8-oof-daily')
  assert.ok(jobs.length >= 2, 'daily root and watchdog')
  for (const job of jobs) {
    const deadlineMs = Number((job.attemptDeadline ?? fallback).replace(/s$/, '')) * 1000
    assert.ok(OPB_REPLAY_DISPATCH_TIMEOUT_MS + 60_000 <= deadlineMs / 2, `${job.id}: ${deadlineMs} ms`)
  }
  const route = readFileSync(new URL('../../../ml-controller/routers/l4_distribution.py', import.meta.url), 'utf8')
  const handler = route.slice(route.indexOf("'/opb-arm-replay'"))
  assert.match(handler, /dispatch_independent_replay/)
  assert.doesNotMatch(handler, /import independent_replay/)
  // The in-flight window ends before the next 30 min watchdog tick.
  assert.ok(IN_FLIGHT_TTL_SECONDS < 30 * 60)
})

test('the controller caps the night; the Worker closes it on capped and keeps no count of its own', async () => {
  const original = globalThis.fetch
  try {
    let started = 0
    const h = harness(() => started >= CONTROLLER_CAP ? Response.json({ status: 'capped', executions: started })
      : Response.json({ status: 'spawned', execution_id: `exec-${++started}` }))
    const summaries: string[] = []
    for (let tick = 0; tick < 13; tick++) {             // a whole night of watchdog ticks
      h.state.receipt = tick ? receipt({ status: 'failed', complete: 0, progress: 4, failed_dates_json: '["2026-11-13"]' }) : null
      summaries.push(await dispatchIndependentOpbReplay(h.env, '2026-11-19'))
      h.kv.delete(opbReplayInFlightKey('2026-11-19'))   // each execution ended without completing the night
    }
    assert.equal(started, CONTROLLER_CAP)
    assert.equal(h.bodies.length, CONTROLLER_CAP + 1, 'one request answered capped, then the night is closed')
    assert.equal(summaries[CONTROLLER_CAP], 'opb_replay=capped attention=opb_replay_failed:1,opb_replay_capped')
    assert.ok(summaries.slice(CONTROLLER_CAP + 1).every(s =>
      s === 'opb_replay=already_done attention=opb_replay_failed:1,opb_replay_capped'), summaries.join('|'))
    noWorkerCount(h.kv)
    assert.equal(classifySchedulerSummary('active8_oof_lifecycle status=pending reason=awaiting_premarket'
      + ' attention=opb_replay_failed:1,opb_replay_capped'), classifySchedulerSummary('active8_oof_lifecycle status=pending reason=awaiting_premarket'))
    assert.equal(classifySchedulerSummary(summaries[CONTROLLER_CAP]), 'success')
  } finally { globalThis.fetch = original }
})

test('a run without progress ends the night with what it left in the attention mark', async () => {
  const original = globalThis.fetch
  try {
    const h = harness(() => { throw new Error('must not dispatch after a complete receipt') })
    h.state.receipt = receipt({ status: 'failed', complete: 1, progress: 0, failed_dates_json: '["2026-11-13"]',
      deferred_dates_json: '["2026-09-01","2026-09-02"]', rejected_dates_json: '["2026-11-12"]' })
    const summary = 'opb_replay=failed rejected=1 attention=opb_replay_rejected:1,opb_replay_failed:1,opb_replay_deferred:2'
    assert.equal(await dispatchIndependentOpbReplay(h.env, '2026-11-19'), summary)
    assert.equal(await dispatchIndependentOpbReplay(h.env, '2026-11-19'),
      'opb_replay=already_done attention=opb_replay_rejected:1,opb_replay_failed:1,opb_replay_deferred:2')
    assert.equal(h.bodies.length, 0)
    assert.equal(classifySchedulerSummary(summary), 'success')
  } finally { globalThis.fetch = original }
})

const logged = (h: ReturnType<typeof harness>, text: string) => h.logs.some(args => args.some(a => String(a).includes(text)))

test('a v2 policy is skipped by the controller and closes the night after one request', async () => {
  const original = globalThis.fetch
  try {
    const h = harness(() => Response.json({ status: 'skipped', business_date: '2026-11-19', reason: 'policy_not_v3' }))
    assert.equal(await dispatchIndependentOpbReplay(h.env, '2026-11-19'), 'opb_replay=skipped reason=policy_not_v3')
    assert.ok(logged(h, 'opb_replay=skipped reason=policy_not_v3'), 'the skip is logged')
    assert.equal(JSON.parse(h.kv.get(opbIndependentReplayKey('2026-11-19'))!).reason, 'policy_not_v3')
    for (let tick = 0; tick < 12; tick++) {
      assert.equal(await dispatchIndependentOpbReplay(h.env, '2026-11-19'), 'opb_replay=already_done reason=policy_not_v3')
    }
    assert.equal(h.bodies.length, 1)
    noWorkerCount(h.kv)
    assert.ok(!h.kv.has(opbReplayInFlightKey('2026-11-19')))
  } finally { globalThis.fetch = original }
})

test('a skip keeps the reason and what the last receipt left; outside_window ends only tonight (r13 P3-4)', async () => {
  const original = globalThis.fetch
  const lifecycle = 'active8_oof_lifecycle status=pending reason=awaiting_premarket job_dispatched=false signal_date=2026-11-19'
  try {
    let reply: Record<string, unknown> = { status: 'skipped', business_date: '2026-11-19', reason: 'outside_window' }
    const h = harness(() => Response.json(reply))
    // An earlier execution left one failed and two deferred days and did not complete the date.
    h.state.receipt = receipt({ status: 'ok', complete: 0, progress: 3, failed_dates_json: '["2026-11-12"]',
      deferred_dates_json: '["2026-11-13","2026-11-14"]' })
    const left = ' attention=opb_replay_failed:1,opb_replay_deferred:2'
    const closed = 'opb_replay=skipped reason=outside_window' + left
    assert.equal(await dispatchIndependentOpbReplay(h.env, '2026-11-19'), closed)
    assert.ok(logged(h, closed), 'the skip is logged with its reason and attention')
    const marker = JSON.parse(h.kv.get(opbIndependentReplayKey('2026-11-19'))!)
    assert.deepEqual([marker.status, marker.reason, marker.failed_dates, marker.deferred_dates],
      ['skipped', 'outside_window', ['2026-11-12'], ['2026-11-13', '2026-11-14']])
    // Not terminal: the next tick (and the next night of the same business date) asks again.
    assert.equal(await dispatchIndependentOpbReplay(h.env, '2026-11-19'), closed)
    assert.equal(h.bodies.length, 2)
    assert.equal(classifySchedulerSummary(lifecycle + / attention=\S+/.exec(closed)![0]), classifySchedulerSummary(lifecycle))
    reply = { status: 'spawned', business_date: '2026-11-19', execution_id: 'opb-2' }
    assert.equal(await dispatchIndependentOpbReplay(h.env, '2026-11-19'), 'opb_replay=spawned')
    assert.equal(h.bodies.length, 3)
    // A v2 skip after a partial v3 night keeps naming the outstanding days on every later tick.
    const v2 = harness(() => Response.json({ status: 'skipped', business_date: '2026-11-19', reason: 'policy_not_v3' }))
    v2.state.receipt = receipt({ status: 'failed', complete: 0, failed_dates_json: '["2026-11-12"]',
      deferred_dates_json: '["2026-11-13"]' })
    const attention = ' attention=opb_replay_failed:1,opb_replay_deferred:1'
    assert.equal(await dispatchIndependentOpbReplay(v2.env, '2026-11-19'), 'opb_replay=skipped reason=policy_not_v3' + attention)
    assert.equal(await dispatchIndependentOpbReplay(v2.env, '2026-11-19'), 'opb_replay=already_done reason=policy_not_v3' + attention)
    assert.equal(v2.bodies.length, 1)
    // An unexpected reason is carried as one token, never splitting the summary.
    const odd = harness(() => Response.json({ status: 'skipped', reason: 'two words attention=x' }))
    assert.equal(await dispatchIndependentOpbReplay(odd.env, '2026-11-19'), 'opb_replay=skipped reason=two_words_attention_x')
    const none = harness(() => Response.json({ status: 'skipped' }))
    assert.equal(await dispatchIndependentOpbReplay(none.env, '2026-11-19'), 'opb_replay=skipped reason=unspecified')
  } finally { globalThis.fetch = original }
})

test('setup failures, missing prices, busy ticks and dispatch failures all reach the task attention', async () => {
  const original = globalThis.fetch
  const lifecycle = 'active8_oof_lifecycle status=pending reason=awaiting_premarket job_dispatched=false signal_date=2026-11-19'
  try {
    // A run that failed before any day (config, D1): failed, complete, no failed dates.
    const setup = harness(() => { throw new Error('must not dispatch a completed date') })
    setup.state.receipt = receipt({ status: 'failed', complete: 1, progress: 0 })
    assert.equal(await dispatchIndependentOpbReplay(setup.env, '2026-11-19'), 'opb_replay=failed attention=opb_replay_run_failed')
    assert.equal(await dispatchIndependentOpbReplay(setup.env, '2026-11-19'), 'opb_replay=already_done attention=opb_replay_run_failed')
    // Held names without prices: named on their own, not only as deferred days.
    const missing = harness(() => { throw new Error('must not dispatch a completed date') })
    missing.state.receipt = receipt({ complete: 1, missing_price_dates_json: '["2026-11-12","2026-11-13"]',
      deferred_dates_json: '["2026-10-01"]' })
    assert.equal(await dispatchIndependentOpbReplay(missing.env, '2026-11-19'),
      'opb_replay=ok attention=opb_replay_missing_price:2,opb_replay_deferred:1')
    // A job busy all night: every tick says so.
    const busy = harness(() => Response.json({ status: 'busy', active_execution: 'oof-1' }))
    for (let tick = 0; tick < 3; tick++) {
      assert.equal(await dispatchIndependentOpbReplay(busy.env, '2026-11-19'), 'opb_replay=busy attention=opb_replay_busy')
    }
    noWorkerCount(busy.kv)
    const down = harness(() => new Response('boom', { status: 503 }))
    const failed = await dispatchIndependentOpbReplay(down.env, '2026-11-19')
    assert.equal(failed, 'opb_replay=dispatch_failed attention=opb_replay_dispatch_failed')
    const odd = harness(() => Response.json({ status: 'surprise' }))
    assert.equal(await dispatchIndependentOpbReplay(odd.env, '2026-11-19'), 'opb_replay=surprise attention=opb_replay_dispatch_failed')
    // What the task summary carries (controllerResearchWorkflows takes the first ` attention=` token),
    // and the classification it keeps.
    for (const summary of ['opb_replay=failed attention=opb_replay_run_failed', failed, 'opb_replay=busy attention=opb_replay_busy',
      'opb_replay=ok attention=opb_replay_missing_price:2,opb_replay_deferred:1']) {
      const token = / attention=\S+/.exec(summary)?.[0] ?? ''
      assert.ok(token.length > ' attention='.length, summary)
      assert.equal(classifySchedulerSummary(lifecycle + token), classifySchedulerSummary(lifecycle))
      assert.equal(classifySchedulerSummary(lifecycle.replace('status=pending', 'status=skipped') + token), 'skipped')
    }
  } finally { globalThis.fetch = original }
})

test('two concurrent entries for eight rounds start at most the controller cap (r8 probe_count_race)', async () => {
  const original = globalThis.fetch
  try {
    // A watchdog tick and a parked continuation enter together each round; KV is slow, the
    // controller (GCS claim, then RunJob) starts one and refuses the other,
    // and the started execution dies without a receipt (OOM, timeout).
    const kv = new Map<string, string>()
    const tick = () => new Promise((r) => setTimeout(r, 1))
    const db = { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null }) }) }
    const env = { DB: db, OPS_DB: db, LEARNING_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops', ML_CONTROLLER_URL: 'https://controller.invalid',
      KV: { get: async (k: string) => { await tick(); return kv.get(k) ?? null },
        put: async (k: string, v: string) => { await tick(); kv.set(k, v) },
        delete: async (k: string) => { await tick(); kv.delete(k) } } } as any
    let started = 0, running = false, requests = 0
    globalThis.fetch = (async () => {
      requests++
      if (started >= CONTROLLER_CAP) return Response.json({ status: 'capped', executions: started })
      if (running) { await tick(); return Response.json({ status: 'busy', active_execution: 'x' }) }
      running = true; await new Promise((r) => setTimeout(r, 20)); started++
      return Response.json({ status: 'spawned', execution_id: `e${started}` })
    }) as any
    const rounds: string[][] = []
    for (let round = 0; round < 8; round++) {
      running = false; kv.delete(opbReplayInFlightKey('2026-11-19'))   // previous execution died, in-flight expired
      rounds.push((await Promise.all([dispatchIndependentOpbReplay(env, '2026-11-19'),
        dispatchIndependentOpbReplay(env, '2026-11-19')])).sort())
    }
    assert.ok(started <= CONTROLLER_CAP, `started=${started}`)
    assert.deepEqual(rounds.slice(0, CONTROLLER_CAP), Array(CONTROLLER_CAP).fill(['opb_replay=busy attention=opb_replay_busy', 'opb_replay=spawned']))
    assert.ok(rounds[CONTROLLER_CAP].every(s => s === 'opb_replay=capped attention=opb_replay_capped'), rounds[CONTROLLER_CAP].join('|'))
    assert.ok(rounds.slice(CONTROLLER_CAP + 1).flat().every(s => s === 'opb_replay=already_done attention=opb_replay_capped'))
    assert.ok(requests <= 2 * (CONTROLLER_CAP + 1))
    noWorkerCount(kv)
  } finally { globalThis.fetch = original }
})

test('the Worker never caps on its own: failed dispatches are asked again; an in-flight KV failure keeps spawned', async () => {
  const original = globalThis.fetch
  try {
    const down = harness(() => { throw new Error('timeout') })
    for (let tick = 0; tick < 13; tick++) {
      assert.equal(await dispatchIndependentOpbReplay(down.env, '2026-11-19'), 'opb_replay=dispatch_failed attention=opb_replay_dispatch_failed')
    }
    assert.equal(down.bodies.length, 13, 'the controller decides capped under its claim')
    // The controller could not list executions (fail closed): nothing started, retried next tick.
    const blind = harness(() => Response.json({ status: 'dispatch_failed', reason: 'execution_dispatch_failed:RuntimeError' }))
    assert.equal(await dispatchIndependentOpbReplay(blind.env, '2026-11-19'), 'opb_replay=dispatch_failed attention=opb_replay_dispatch_failed')
    assert.ok(!blind.kv.has(opbIndependentReplayKey('2026-11-19')))
    const flaky = harness(() => Response.json({ status: 'spawned', execution_id: 'e' }))
    const put = flaky.env.KV.put
    flaky.env.KV.put = async (key: string, value: string, options: { expirationTtl?: number }) => {
      if (key === opbReplayInFlightKey('2026-11-19')) throw new Error('kv down')
      return put(key, value, options)
    }
    assert.equal(await dispatchIndependentOpbReplay(flaky.env, '2026-11-19'), 'opb_replay=spawned')
    noWorkerCount(down.kv); noWorkerCount(flaky.kv)
  } finally { globalThis.fetch = original }
})

const levelOf = (h: ReturnType<typeof harness>, message: string) =>
  h.logs.filter(args => String(args[2]).endsWith(message)).map(args => String(args[0]))

test('skip log levels: a clean v2 skip is info; one that leaves days, or a closed window, is warn (r14 f)', async () => {
  const original = globalThis.fetch
  try {
    const clean = harness(() => Response.json({ status: 'skipped', reason: 'policy_not_v3' }))
    await dispatchIndependentOpbReplay(clean.env, '2026-11-19')
    assert.deepEqual(levelOf(clean, 'opb_replay=skipped reason=policy_not_v3'), ['info'])
    const left = harness(() => Response.json({ status: 'skipped', reason: 'policy_not_v3' }))
    left.state.receipt = receipt({ complete: 0, deferred_dates_json: '["2026-11-13"]' })
    await dispatchIndependentOpbReplay(left.env, '2026-11-19')
    assert.deepEqual(levelOf(left, 'opb_replay=skipped reason=policy_not_v3 attention=opb_replay_deferred:1'), ['warn'])
    for (const job_running of [false, null]) {
      const closed = harness(() => Response.json({ status: 'skipped', reason: 'outside_window', job_running }))
      await dispatchIndependentOpbReplay(closed.env, '2026-11-19')
      assert.deepEqual(levelOf(closed, 'opb_replay=skipped reason=outside_window'), ['warn'], String(job_running))
    }
    const busy = harness(() => Response.json({ status: 'skipped', reason: 'outside_window', job_running: true, active_execution: 'x' }))
    await dispatchIndependentOpbReplay(busy.env, '2026-11-19')
    assert.deepEqual(levelOf(busy, 'opb_replay=skipped reason=outside_window attention=opb_replay_busy'), ['warn'])
    assert.equal(JSON.parse(String(busy.logs.find(a => String(a[2]).includes('outside_window'))![3])).job_running, true)
  } finally { globalThis.fetch = original }
})

test('a job stuck past the window close still reaches busy_persistent, across nights of the business date (r14 d)', async () => {
  const original = globalThis.fetch
  const realNow = Date.now
  try {
    const base = Date.parse('2026-11-27T21:00:00Z')            // TW 05:00
    let now = base, answer: Record<string, unknown> = {}
    Date.now = () => now
    const h = harness(() => Response.json(answer))
    const key = '2026-11-27'
    const at = async (minutes: number, reply: Record<string, unknown>) => {
      now = base + minutes * 60_000; answer = reply
      return dispatchIndependentOpbReplay(h.env, key)
    }
    const busy = { status: 'busy', active_execution: 'oof-1' }
    const closed = (job_running: boolean | null) => ({ status: 'skipped', business_date: key, reason: 'outside_window',
      job_running, active_execution: job_running ? 'oof-1' : null })
    const skippedBusy = 'opb_replay=skipped reason=outside_window attention=opb_replay_busy'
    for (const minutes of [0, 30, 60]) assert.equal(await at(minutes, busy), 'opb_replay=busy attention=opb_replay_busy')
    // 06:55: the window closed while the job still runs; the streak is kept and keeps growing.
    assert.equal(await at(115, closed(true)), skippedBusy)
    assert.equal(await at(145, closed(true)), skippedBusy + '_persistent:145m')
    // An unreadable job state keeps the streak without counting it.
    assert.equal(await at(175, closed(null)), 'opb_replay=skipped reason=outside_window')
    assert.ok(h.kv.has(opbReplayBusySinceKey(key)))
    // The next night of the same business date (a weekend): still stuck, still persistent.
    assert.equal(await at(1260, closed(true)), skippedBusy + '_persistent:1260m')
    assert.equal(await at(1290, busy), 'opb_replay=busy attention=opb_replay_busy_persistent:1290m')
    // A closed window with the job free ends the streak; a later stuck job starts a new one.
    assert.equal(await at(1700, closed(false)), 'opb_replay=skipped reason=outside_window')
    assert.ok(!h.kv.has(opbReplayBusySinceKey(key)))
    assert.equal(await at(1730, closed(true)), skippedBusy)
    assert.equal(await at(1730 + 120, closed(true)), skippedBusy + '_persistent:120m')
    noWorkerCount(h.kv)
  } finally { globalThis.fetch = original; Date.now = realNow }
})

test('busy_persistent needs 2 h of busy answers; only spawned, capped or skipped end the streak', async () => {
  const original = globalThis.fetch
  const realNow = Date.now
  try {
    const base = Date.parse('2026-11-20T17:55:00Z')
    let now = base, answer: string = 'busy'
    Date.now = () => now
    const h = harness(() => {
      if (answer === 'down') throw new Error('network down')
      return Response.json(answer === 'busy' ? { status: 'busy', active_execution: 'oof-1' }
        : answer === 'failed' ? { status: 'dispatch_failed', reason: 'execution_dispatch_failed:RuntimeError' }
          : { status: answer, execution_id: 'e', executions: 4 })
    })
    const at = async (minutes: number, reply = 'busy') => {
      now = base + minutes * 60_000; answer = reply
      h.kv.delete(opbReplayInFlightKey('2026-11-19')); h.kv.delete(opbIndependentReplayKey('2026-11-19'))
      return dispatchIndependentOpbReplay(h.env, '2026-11-19')
    }
    const plain = 'opb_replay=busy attention=opb_replay_busy'
    for (const minutes of [0, 30, 60, 90]) assert.equal(await at(minutes), plain, String(minutes))
    // dispatch_failed (either form) says nothing about the job: the streak is kept.
    assert.equal(await at(100, 'failed'), 'opb_replay=dispatch_failed attention=opb_replay_dispatch_failed')
    assert.equal(await at(105, 'down'), 'opb_replay=dispatch_failed attention=opb_replay_dispatch_failed')
    assert.equal(await at(120), 'opb_replay=busy attention=opb_replay_busy_persistent:120m')
    assert.equal(await at(150), 'opb_replay=busy attention=opb_replay_busy_persistent:150m')
    // spawned, capped and skipped settle the dispatch: each ends the streak.
    for (const [minutes, reply] of [[160, 'spawned'], [400, 'capped'], [640, 'skipped']] as const) {
      await at(minutes, reply)
      assert.ok(!h.kv.has(opbReplayBusySinceKey('2026-11-19')), reply)
      assert.equal(h.kv.get(opbReplayBusyClearedKey('2026-11-19')), new Date(now).toISOString())
      for (const later of [30, 60, 90]) assert.equal(await at(minutes + later), plain, `${reply}+${later}`)
      assert.equal(await at(minutes + 30 + 120), 'opb_replay=busy attention=opb_replay_busy_persistent:120m', reply)   // first busy at +30
    }
    // A lost delete, or a busy write racing the clear, leaves a streak that started before
    // last_clear_at: it is stale and never escalates.
    await at(900, 'spawned')
    h.kv.set(opbReplayBusySinceKey('2026-11-19'), JSON.stringify({ first_busy_at: new Date(base).toISOString(),
      last_busy_at: new Date(now + 60_000).toISOString() }))
    assert.equal(await at(905), plain)
    // Unreadable or inconsistent marks start a new streak, never a persistent one.
    await at(1000, 'spawned')
    for (const raw of ['not json', JSON.stringify({ first_busy_at: '2026-11-21T09:00:00Z', last_busy_at: '2026-11-21T08:00:00Z' }),
      JSON.stringify({ first_busy_at: new Date(base).toISOString(), last_busy_at: '2099-01-01T00:00:00Z' })]) {
      h.kv.set(opbReplayBusySinceKey('2026-11-19'), raw)
      assert.equal(await at(1200), plain, raw)
    }
    h.kv.set(opbReplayBusyClearedKey('2026-11-19'), 'garbage')       // unreadable clear: also a new streak
    h.kv.set(opbReplayBusySinceKey('2026-11-19'), JSON.stringify({ first_busy_at: new Date(base).toISOString(),
      last_busy_at: new Date(base + 1190 * 60_000).toISOString() }))
    assert.equal(await at(1200), plain)
    assert.equal(OPB_REPLAY_BUSY_PERSISTENT_MS, 2 * 3600_000)
    const lifecycle = 'active8_oof_lifecycle status=pending reason=awaiting_premarket job_dispatched=false'
    assert.equal(classifySchedulerSummary(lifecycle + ' attention=opb_replay_busy_persistent:150m'), classifySchedulerSummary(lifecycle))
  } finally { globalThis.fetch = original; Date.now = realNow }
})

test('the nightly OOF summary keeps its classification with the replay attention token (P3b)', () => {
  // Exactly what oof_materialize_job_main._summary renders (asserted in test_l4_opb_v3_replay.py).
  const token = ' attention=opb_replay_failed:1,opb_replay_missing_price:1,opb_replay_deferred:2'
  for (const status of ['success', 'failed', 'blocked', 'skipped', 'pending']) {
    const nightly = `run_id=run-1 status=${status} cohort=none promoted=False reason=none full_fit=none`
    assert.equal(classifySchedulerSummary(nightly + token), classifySchedulerSummary(nightly), status)
  }
  assert.equal(classifySchedulerSummary('run_id=r status=success attention=opb_replay_run_failed'), 'success')
})
