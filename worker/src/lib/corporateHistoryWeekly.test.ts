import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { adminControlRoutes } from '../routes/adminControlRoutes'
import {
  buildCorporateHistoryWeeklyRunId,
  CORPORATE_HISTORY_WEEKLY_RUN_ID_PATTERN,
  runCorporateHistoryWeeklyExport,
} from './corporateHistoryWeekly'
import { classifySchedulerRunSummary } from './schedulerRunLogger'
import { schedulerHttpResultTicketStatus } from './schedulerExecutionTickets'
import { schedulerSummaryZh } from './schedulerSummaryZh'
import { TASK_POLICIES } from './schedulerPolicy'

const CONTROLLER = 'https://controller.test'
const RUN_DATE = '2026-11-28'
const TOKEN = 'isolated-corporate-history-token'

type Call = { url: string; method?: string; body: any; headers: Record<string, string> }

async function withController(
  respond: (call: Call) => Response | Promise<Response>,
  run: (calls: Call[]) => Promise<void>,
) {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    return respond(call)
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

const env = { ML_CONTROLLER_URL: CONTROLLER, ML_CONTROLLER_SECRET: 'controller-secret' } as any
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})

test('run_id matches the controller request model (prefix, date, 8-32 hex, 44-72 chars)', () => {
  const runId = buildCorporateHistoryWeeklyRunId(RUN_DATE)
  assert.match(runId, CORPORATE_HISTORY_WEEKLY_RUN_ID_PATTERN)
  assert.ok(runId.startsWith(`corporate-history-weekly-${RUN_DATE}-`))
  assert.ok(runId.length >= 44 && runId.length <= 72, `length ${runId.length}`)
  assert.notEqual(buildCorporateHistoryWeeklyRunId(RUN_DATE), runId, 'each dispatch gets fresh entropy')
  assert.throws(() => buildCorporateHistoryWeeklyRunId(RUN_DATE, 'abc'), /invalid/)
  assert.throws(() => buildCorporateHistoryWeeklyRunId(RUN_DATE, 'NOT-HEX!'), /invalid/)
})

test('dispatch posts run_date/run_id/dry_run to the controller and waits for the callback', async () => {
  await withController((call) => json(200, {
    status: 'dispatched', execution_id: 'dataset-snapshot-export-abc12', run_date: call.body.run_date, run_id: call.body.run_id,
  }), async (calls) => {
    const summary = await runCorporateHistoryWeeklyExport(env, RUN_DATE)
    assert.equal(calls.length, 1)
    const [call] = calls
    assert.equal(call.url, `${CONTROLLER}/datasets/corporate-history/weekly`)
    assert.equal(call.method, 'POST')
    assert.equal(call.headers['X-Controller-Token'], 'controller-secret')
    assert.deepEqual(Object.keys(call.body).sort(), ['dry_run', 'run_date', 'run_id'])
    assert.equal(call.body.run_date, RUN_DATE)
    assert.equal(call.body.dry_run, false)
    assert.match(call.body.run_id, CORPORATE_HISTORY_WEEKLY_RUN_ID_PATTERN)
    assert.ok(call.body.run_id.startsWith(`corporate-history-weekly-${RUN_DATE}-`))
    assert.equal(summary,
      `triggered corporate-history-weekly run_id=${call.body.run_id} execution_id=dataset-snapshot-export-abc12 callback expected`)
    // Worker's existing async convention: run log `triggered`, ticket `triggered` until the Job's callback.
    assert.equal(classifySchedulerRunSummary(summary), 'triggered')
    assert.equal(schedulerHttpResultTicketStatus('corporate-history-weekly', 'triggered'), 'triggered')
    assert.equal(schedulerSummaryZh('corporate-history-weekly', summary), '已觸發，等待完成回呼')
  })
})

test('409 already-running, 422 identity mismatch and 5xx dispatch failures return failed:', async () => {
  const cases: Array<[Response, RegExp, string]> = [
    [json(409, { detail: { error: 'corporate_history_weekly_execution_already_running', execution_id: 'e-1' } }),
      /^failed: corporate-history-weekly execution already running run_id=\S+ reason=corporate_history_weekly_execution_already_running$/,
      '已有匯出工作在執行中'],
    [json(422, { detail: { error: 'corporate_history_weekly_run_id_date_mismatch', run_date: RUN_DATE } }),
      /^failed: corporate-history-weekly run identity rejected HTTP 422 .*corporate_history_weekly_run_id_date_mismatch$/,
      '拒絕執行識別碼'],
    [json(502, { detail: { error: 'corporate_history_weekly_dispatch_failed', message: 'boom' } }),
      /^failed: corporate-history-weekly controller dispatch HTTP 502 .*corporate_history_weekly_dispatch_failed$/,
      'HTTP 502'],
    [new Response('<html>Service Unavailable</html>', { status: 503 }),
      /^failed: corporate-history-weekly controller dispatch HTTP 503 .*Service Unavailable/,
      'HTTP 503'],
  ]
  for (const [response, expected, zh] of cases) {
    await withController(() => response, async () => {
      const summary = await runCorporateHistoryWeeklyExport(env, RUN_DATE)
      assert.match(summary, expected)
      assert.equal(classifySchedulerRunSummary(summary), 'error', summary)
      assert.ok(schedulerSummaryZh('corporate-history-weekly', summary)?.includes(zh), summary)
    })
  }
})

test('transport error, dry-run/not_triggered and identity drift in a 200 are not a dispatch', async () => {
  await withController(() => { throw new Error('The operation was aborted due to timeout') }, async () => {
    const summary = await runCorporateHistoryWeeklyExport(env, RUN_DATE)
    assert.match(summary, /^failed: corporate-history-weekly controller dispatch error run_id=\S+: The operation was aborted/)
    assert.equal(classifySchedulerRunSummary(summary), 'error')
  })
  for (const body of [
    (call: Call) => ({ status: 'not_triggered', reason: 'dry_run', run_date: RUN_DATE, run_id: call.body.run_id }),
    (call: Call) => ({ status: 'dispatched', execution_id: 'e-1', run_date: RUN_DATE, run_id: `${call.body.run_id}0` }),
    (call: Call) => ({ status: 'dispatched', execution_id: 'e-1', run_date: '2026-11-21', run_id: call.body.run_id }),
    (call: Call) => ({ status: 'dispatched', run_date: RUN_DATE, run_id: call.body.run_id }),
  ]) {
    await withController((call) => json(200, body(call)), async () => {
      const summary = await runCorporateHistoryWeeklyExport(env, RUN_DATE)
      assert.match(summary, /^failed: corporate-history-weekly dispatch not confirmed /)
      assert.equal(classifySchedulerRunSummary(summary), 'error', summary)
    })
  }
  await withController(() => json(200, {}), async (calls) => {
    assert.match(await runCorporateHistoryWeeklyExport(env, '2026/11/28'), /^failed: .*YYYY-MM-DD/)
    assert.equal(calls.length, 0, 'a malformed date never reaches the controller')
  })
})

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string, type?: string) {
      const value = store.get(key)
      if (value === undefined) return null
      return type === 'json' ? JSON.parse(value) : value
    },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

test('the Job callback closes the triggered run log with its terminal status', async () => {
  for (const status of ['success', 'error'] as const) {
    const kv = memoryKv()
    const runId = buildCorporateHistoryWeeklyRunId(RUN_DATE)
    const logKey = `scheduler:run:corporate-history-weekly:${RUN_DATE}`
    // Dispatch receipt as the sync trigger route writes it (run_id is the scheduler execution id).
    kv.store.set(logKey, JSON.stringify({
      task: 'corporate-history-weekly', status: 'triggered', run_id: 'scheduler-exec-1', run_date: RUN_DATE,
      summary: `triggered corporate-history-weekly run_id=${runId} execution_id=e-1 callback expected`,
    }))
    const summary = status === 'success'
      ? `run_id=${runId} snapshot=corporate_history:${RUN_DATE}:abc history=2016-01-04~2026-11-27 sessions=2650 blocked_issuers=3 max_exclusion=5d:12/1800`
      : `run_id=${runId} RuntimeError: exclusion gate failed`
    const response = await adminControlRoutes.request('https://local.test/api/admin/scheduler-callback', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: 'corporate-history-weekly', status, summary, run_id: runId, run_date: RUN_DATE, duration_ms: 1234,
        ...(status === 'error' ? { error: 'RuntimeError: exclusion gate failed' } : {}),
      }),
    }, { KV: kv, STOCKVISION_AUTH_TOKEN: TOKEN } as any,
    { waitUntil() {}, passThroughOnException() {}, props: {} } as any)
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(await response.json(), { ok: true, task: 'corporate-history-weekly', status })
    const log = JSON.parse(kv.store.get(logKey)!)
    assert.equal(log.status, status)
    assert.equal(log.run_id, runId)
    assert.equal(log.duration_ms, 1234)
    const zh = schedulerSummaryZh('corporate-history-weekly', log.summary)!
    assert.ok(status === 'success'
      ? zh.includes('2016-01-04～2026-11-27') && zh.includes('2,650') && zh.includes('12／1,800')
      : zh.includes('匯出失敗'), zh)
  }
})

test('every controller stop reads as a failed export, including the FinLab SystemExit', () => {
  const runId = buildCorporateHistoryWeeklyRunId(RUN_DATE)
  for (const error of [
    'SystemExit: finlab_token_expired: rerun with a fresh FINLAB_REFRESH_TOKEN / FINLAB_SESSION_ID',
    'CorporateHistoryWeeklyError: corporate_history_exclusion_share_above_limit:365d=900/2000',
    'RuntimeError: corporate_history_weekly_run_identity_invalid',
  ]) {
    assert.equal(schedulerSummaryZh('corporate-history-weekly', `run_id=${runId} ${error}`),
      '研究用公司行為快照匯出失敗（原因見明細）', error)
  }
})

test('registered as a sync research root that weekly-readiness does not require', () => {
  assert.equal(TASK_POLICIES['corporate-history-weekly']?.kind, 'research')
  assert.equal(TASK_POLICIES['corporate-history-weekly']?.holidayGated, false)
  const manifest = JSON.parse(readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')) as {
    jobs: Array<{ id: string; task: string; schedule: string; query?: string; timeZone?: string }>
  }
  const job = manifest.jobs.filter((row) => row.task === 'corporate-history-weekly')
  assert.equal(job.length, 1)
  assert.equal(job[0].id, 'corporate-history-weekly')
  assert.equal(job[0].schedule, '30 9 * * 6', 'Saturday 09:30 UTC = TW 17:30: after the first-Saturday monthly jobs, the day before weekly-backtest')
  assert.equal(job[0].timeZone, undefined, 'manifest default time zone is UTC')
  assert.equal(job[0].query, 'sync=1')
  const triggerRoutes = readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
  assert.match(triggerRoutes.slice(0, triggerRoutes.indexOf('])')), /'corporate-history-weekly'/, 'sync=1 is required')
  const readiness = readFileSync('src/lib/cadenceReadiness.ts', 'utf8')
  assert.doesNotMatch(readiness, /corporate-history-weekly/, 'weekly-backtest freshness already blocks a missed export')
})
