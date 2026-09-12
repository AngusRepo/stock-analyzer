import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { Miniflare } from 'miniflare'
import { processUpdateBatch } from './updateOrchestrator'
import { adminControlRoutes } from '../routes/adminControlRoutes'
import { processActive8AfterDatasetSnapshot, settleActive8SnapshotContinuationTicket } from './active8SnapshotReadyContinuation'
import { admitSchedulerExecutionTicket, admitSchedulerChildTicket, schedulerDeliveryIdentity,
  updateSchedulerExecutionTicket } from './schedulerExecutionTickets'

// Only the upstream stage summaries are fixture inputs. Ticket admissions,
// callback handling, CAS settlement, root closure and KV logging are original.
// No NAV verdict, model promotion, production I/O or return claim is involved.
async function fixture(run: (value: any) => Promise<void>) {
  const mf = new Miniflare({ modules: true,
    script: 'export default { fetch() { return new Response("isolated") } }',
    d1Databases: ['OPS', 'LEARNING'], kvNamespaces: ['NAV'] })
  try {
    const ops = await mf.getD1Database('OPS')
    const learning = await mf.getD1Database('LEARNING')
    const kv = await mf.getKVNamespace('NAV')
    for (const [db, file] of [[ops, 'domain-migrations/ops/0011_scheduler_execution_tickets.sql'],
      [learning, 'migrations/0102_active8_oof_freshness_sla.sql']] as const) {
      for (const sql of fs.readFileSync(file, 'utf8').replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) {
        await db.prepare(sql).run()
      }
    }
    await ops.prepare(`CREATE TABLE pipeline_stage_runs (business_date TEXT,stage TEXT,canonical_run_id TEXT,
      status TEXT,cursor_key TEXT,PRIMARY KEY(business_date,stage))`).run()
    await ops.prepare(`CREATE TABLE strategy_learning_runs (business_date TEXT PRIMARY KEY,canonical_run_id TEXT,
      producer_run_id TEXT,status TEXT,expected_candidates INTEGER,processed_candidates INTEGER,
      expected_decision_rows INTEGER,persisted_decision_rows INTEGER,production_authority_intent INTEGER,
      policy_closure_status TEXT,policy_closure_reason TEXT,completed_at TEXT)`).run()
    const day = '2026-09-09'
    const canonical = `pipeline:${day}:fixture`
    for (const stage of ['pipeline_execution', 'post_pipeline_chain', 'verify_v2', 'screener_v2', 'post_verify_chain']) {
      await ops.prepare('INSERT INTO pipeline_stage_runs VALUES(?,?,?,?,?)')
        .bind(day, stage, canonical, 'success', stage === 'screener_v2' ? 'fixture-screener' : null).run()
    }
    await ops.prepare(`INSERT INTO strategy_learning_runs VALUES(?,?,?,'success',1,1,1,1,0,'evidence_only',NULL,CURRENT_TIMESTAMP)`)
      .bind(day, canonical, 'fixture-screener').run()
    const admitted = await admitSchedulerExecutionTicket(ops as any, {
      identity: schedulerDeliveryIdentity(new Headers({
        'X-CloudScheduler-JobName': 'projects/local/locations/asia-east1/jobs/evening-chain',
        'X-CloudScheduler-ScheduleTime': `${day}T13:00:00Z`,
      })), task: 'evening-chain', requestedRunDate: day, proposedRunId: `evening-chain:${day}` })
    const root = admitted.ticket
    await updateSchedulerExecutionTicket(ops as any, { ticketId: root.ticket_id, runId: root.run_id,
      status: 'triggered', authority: 'scheduler_http', summary: 'fixture stages pending child' })
    const snapshot = await admitSchedulerChildTicket(ops as any, { rootTicketId: root.ticket_id,
      parentTicketId: root.ticket_id, childKey: 'snapshot', task: 'dataset-snapshot-export', businessDate: day,
      runId: `${canonical}:snapshot`, metadata: { origin: 'dataset_snapshot_ready' } })
    await updateSchedulerExecutionTicket(ops as any, { ticketId: snapshot.ticket_id, runId: snapshot.run_id,
      status: 'success', authority: 'logical_child', summary: 'fixture snapshot ready' })
    const callbackRunId = `active8-oof-daily:${day}:resolve-after-prep`
    const child = await admitSchedulerChildTicket(ops as any, { rootTicketId: root.ticket_id,
      parentTicketId: snapshot.ticket_id, childKey: 'active8', task: 'active8-oof-daily', businessDate: day,
      runId: `${snapshot.run_id}:active8`, metadata: { origin: 'dataset_snapshot_ready',
        snapshot_run_id: snapshot.run_id, active8_callback_run_id: callbackRunId } })
    const env = { DB: ops, OPS_DB: ops, LEARNING_DB: learning, KV: kv,
      MULTI_D1_ACTIVE_DOMAINS: 'ops,learning', MULTI_D1_STRICT: 'true',
      STOCKVISION_AUTH_TOKEN: 'isolated-nav-token', UPDATE_QUEUE: {
        send: async () => { throw new Error('terminal callback cannot queue') },
      } } as any
    const row = async (id: string) => ops.prepare('SELECT * FROM scheduler_execution_tickets_v1 WHERE ticket_id=?').bind(id).first()
    const settle = (status: 'success' | 'error' | 'skipped', runId = callbackRunId) =>
      settleActive8SnapshotContinuationTicket(env, { businessDate: day, callbackRunId: runId,
        status, summary: `fixture terminal ${status}`, error: status === 'error' ? 'nav_failed' : undefined })
    const terminalChild = (status: 'success' | 'error') => updateSchedulerExecutionTicket(ops as any, {
      ticketId: child.ticket_id, runId: child.run_id, status, authority: 'scheduler_http', summary: `fixture ${status}` })
    const postError = () => adminControlRoutes.request('https://local.test/api/admin/cron-callback', {
      method: 'POST', headers: { Authorization: 'Bearer isolated-nav-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'active8-oof-daily', status: 'error', run_date: day, run_id: callbackRunId,
        attempt_id: 'fixture-exhausted', scheduler_ticket_id: child.ticket_id, scheduler_run_id: child.run_id,
        summary: 'NAV incomplete', error: 'paired_nav_daily_closure_incomplete',
        metadata: { cadence: 'daily', lifecycle_status: 'pending', continuation_attempt: 12,
          continuation_max_attempts: 12, nav_retry_required: true } }),
    }, env)
    await run({ ops, learning, kv, env, day, canonical, root, snapshot, callbackRunId, child, row, settle, terminalChild, postError })
  } finally { await mf.dispose() }
}

for (const status of ['success', 'error'] as const) {
  test(`matching already-${status} child must finish its pending root`, async () => fixture(async f => {
    await f.terminalChild(status)
    const childBefore = await f.row(f.child.ticket_id)
    assert.equal(await f.settle(status), true)
    assert.deepEqual(await f.row(f.child.ticket_id), childBefore, 'replay must not rewrite terminal child')
    assert.equal((await f.row(f.root.ticket_id)).status, status)
    assert.equal((await f.kv.get(`scheduler:run:evening-chain:${f.day}`, 'json')).status, status)
    assert.equal(await f.settle(status), true, 'repeated root/log reconciliation remains possible')
    assert.equal((await f.kv.get(`scheduler:run:evening-chain:${f.day}`, 'json')).run_id, f.canonical,
      'root replay must preserve the canonical pipeline run, not substitute the callback run')
  }))
}

test('actual callback ticket pre-settlement must not skip root error closure', async () => fixture(async f => {
  const response = await f.postError()
  assert.equal(response.status, 200, await response.text())
  assert.equal((await f.row(f.child.ticket_id)).status, 'error')
  assert.equal((await f.row(f.root.ticket_id)).status, 'error')
}))

test('child commit then root write failure must recover on the same callback', async () => fixture(async f => {
  await f.ops.prepare(`CREATE TRIGGER fixture_root_write_down BEFORE UPDATE ON scheduler_execution_tickets_v1
    WHEN OLD.task='evening-chain' BEGIN SELECT RAISE(ABORT,'fixture_root_write_down'); END`).run()
  const failed = await f.postError()
  assert.equal(failed.status, 503)
  assert.equal((await f.row(f.child.ticket_id)).status, 'error')
  assert.equal((await f.row(f.root.ticket_id)).status, 'triggered')
  await f.ops.prepare('DROP TRIGGER fixture_root_write_down').run()
  const retry = await f.postError()
  assert.equal(retry.status, 200, await retry.text())
  assert.equal((await f.row(f.root.ticket_id)).status, 'error')
}))

test('wrong callback identity or conflicting terminal result cannot close the root', async () => fixture(async f => {
  await f.terminalChild('error')
  const before = await f.row(f.root.ticket_id)
  assert.equal(await f.settle('error', 'old-run'), false)
  assert.equal(await f.settle('success'), false)
  assert.deepEqual(await f.row(f.root.ticket_id), before)
  assert.equal((await f.row(f.child.ticket_id)).status, 'error')
}))

test('root D1 commit without KV projection is retryable and replays its log', async () => fixture(async f => {
  const originalKv = f.env.KV
  f.env.KV = {
    get: (...args: any[]) => originalKv.get(...args),
    put: (key: string, ...args: any[]) => {
      if (key.startsWith('scheduler:run:evening-chain:') || key.startsWith('cron:log:evening-chain:')) {
        throw new Error('fixture_root_kv_unavailable')
      }
      return originalKv.put(key, ...args)
    },
  }
  const failed = await f.postError()
  assert.equal(failed.status, 503, 'root KV failure must not be acknowledged as complete')
  assert.equal((await f.row(f.child.ticket_id)).status, 'error')
  assert.equal((await f.row(f.root.ticket_id)).status, 'error', 'durable commit is preserved')
  assert.equal(await originalKv.get(`scheduler:run:evening-chain:${f.day}`, 'json'), null)
  f.env.KV = originalKv
  const retry = await f.postError()
  assert.equal(retry.status, 200, await retry.text())
  const log = await originalKv.get(`scheduler:run:evening-chain:${f.day}`, 'json')
  assert.equal(log.status, 'error')
  assert.equal(log.run_id, f.canonical)
}))

test('continuation verifies the original ticket date, task and run before dispatch', async () => fixture(async f => {
  const originalFetch = globalThis.fetch
  let calls = 0
  f.env.ML_CONTROLLER_URL = 'https://isolated-controller.test'
  globalThis.fetch = async () => { calls++; return Response.json({ status: 'spawned' }) }
  const message = { type: 'active8_oof_continuation' as const, cursor: 0,
    triggerTime: f.day, oofCadence: 'daily' as const, oofContinuationAttempt: 1,
    schedulerTicketId: f.child.ticket_id, schedulerRunId: f.child.run_id }
  try {
    for (const wrong of [
      { schedulerTicketId: 'missing-ticket' },
      { schedulerRunId: 'other-run' },
      { triggerTime: '2026-09-08' },
      { schedulerTicketId: f.snapshot.ticket_id, schedulerRunId: f.snapshot.run_id },
      { oofCadence: 'weekly' as const },
    ]) {
      await assert.rejects(processUpdateBatch({ ...message, ...wrong }, f.env, {} as any),
        /active8_oof_continuation_scheduler_identity_mismatch/)
      assert.equal(calls, 0, 'mismatched ownership must not dispatch a durable job')
    }
    await processUpdateBatch(message, f.env, {} as any)
    assert.equal(calls, 1, 'the same admitted ticket can continue normally')
    assert.equal((await f.row(f.root.ticket_id)).status, 'triggered')
  } finally { globalThis.fetch = originalFetch }
}))

for (const status of ['pending', 'spawned']) {
  test(`snapshot child retains scheduler identity through ${status} controller dispatch`, async () => fixture(async f => {
    await f.learning.prepare(`CREATE TABLE dataset_snapshots (snapshot_id TEXT,business_date TEXT,
      kind TEXT,access_tier TEXT,status TEXT)`).run()
    await f.learning.prepare(`INSERT INTO dataset_snapshots VALUES('fixture-snapshot',?,'backtest_dataset','compute','ready')`)
      .bind(f.day).run()
    const sent: any[] = []
    const requests: any[] = []
    f.env.ML_CONTROLLER_URL = 'https://isolated-controller.test'
    f.env.UPDATE_QUEUE.send = async (message: any, options: any) => { sent.push({ message, options }) }
    const oldFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://isolated-controller.test/walk_forward/oof/lifecycle')
      requests.push(JSON.parse(String(init?.body)))
      return Response.json({ status, reason: status === 'pending' ? 'materialization_job_active' : 'durable_job_dispatched',
        cohort_id: 'fixture-cohort' })
    }
    try {
      await processActive8AfterDatasetSnapshot({ type: 'active8_oof_after_snapshot', cursor: 0,
        triggerTime: f.day, runId: f.child.run_id, schedulerTicketId: f.child.ticket_id,
        active8SnapshotId: 'fixture-snapshot' }, f.env)
    } finally { globalThis.fetch = oldFetch }
    assert.equal(requests.length, 1)
    assert.equal(requests[0].scheduler_ticket_id, f.child.ticket_id)
    assert.equal(requests[0].scheduler_run_id, f.child.run_id)
    assert.equal((await f.row(f.child.ticket_id)).status, 'triggered')
    assert.equal((await f.row(f.root.ticket_id)).status, 'triggered')
    assert.equal(sent.length, status === 'pending' ? 1 : 0)
    if (status === 'pending') {
      assert.equal(sent[0].message.type, 'active8_oof_continuation')
      assert.equal(sent[0].message.schedulerTicketId, f.child.ticket_id)
      assert.equal(sent[0].message.schedulerRunId, f.child.run_id)
      assert.equal(sent[0].message.oofExpectedCohortId, 'fixture-cohort')
      assert.equal(sent[0].message.oofContinuationAttempt, 1)
      assert.equal(sent[0].options.delaySeconds, 300)
    }
  }))
}

test('callback for an older exact child cannot settle the newer same-day child', async () => fixture(async f => {
  const newer = await admitSchedulerChildTicket(f.ops, { rootTicketId: f.root.ticket_id,
    parentTicketId: f.snapshot.ticket_id, childKey: 'second-snapshot-child', task: 'active8-oof-daily',
    businessDate: f.day, runId: 'second-child-run', metadata: { origin: 'dataset_snapshot_ready',
      snapshot_run_id: f.snapshot.run_id, active8_callback_run_id: f.callbackRunId } })
  // Deterministic test ordering of same-day ticket deliveries, not market data.
  await f.ops.prepare("UPDATE scheduler_execution_tickets_v1 SET updated_at=datetime('now','+1 second') WHERE ticket_id=?")
    .bind(newer.ticket_id).run()
  const before = await f.row(newer.ticket_id)
  const oldBefore = await f.row(f.child.ticket_id)
  await assert.rejects(f.settle('error'), /active8_snapshot_callback_ticket_ambiguous/)
  assert.deepEqual(await f.row(newer.ticket_id), before)
  assert.deepEqual(await f.row(f.child.ticket_id), oldBefore)
  const response = await f.postError()
  assert.equal(response.status, 200, await response.text())
  assert.equal((await f.row(f.child.ticket_id)).status, 'error')
  assert.deepEqual(await f.row(newer.ticket_id), before, 'old callback must not settle the latest matching-day ticket')
  assert.equal((await f.row(f.root.ticket_id)).status, 'triggered')
}))

for (const missing of ['ticket', 'run']) {
  test(`incomplete callback ${missing} identity performs no settlement`, async () => fixture(async f => {
    const before = (await f.ops.prepare('SELECT * FROM scheduler_execution_tickets_v1 ORDER BY ticket_id').all()).results
    await assert.rejects(settleActive8SnapshotContinuationTicket(f.env, {
      businessDate: f.day, callbackRunId: f.callbackRunId, status: 'error', summary: 'fixture',
      schedulerTicketId: missing === 'ticket' ? undefined : f.child.ticket_id,
      schedulerRunId: missing === 'run' ? undefined : f.child.run_id,
    }), /active8_snapshot_callback_ticket_identity_incomplete/)
    assert.deepEqual((await f.ops.prepare('SELECT * FROM scheduler_execution_tickets_v1 ORDER BY ticket_id').all()).results, before)
  }))
}

test('an old-root child callback cannot reconcile a newer physical root', async () => fixture(async f => {
  const newer = await admitSchedulerExecutionTicket(f.ops, {
    identity: schedulerDeliveryIdentity(new Headers({
      'X-CloudScheduler-JobName': 'projects/local/locations/asia-east1/jobs/evening-chain',
      'X-CloudScheduler-ScheduleTime': `${f.day}T14:00:00Z`,
    })), task: 'evening-chain', requestedRunDate: f.day, proposedRunId: 'new-root-run' })
  await f.ops.prepare("UPDATE scheduler_execution_tickets_v1 SET updated_at=datetime('now','+1 second') WHERE ticket_id=?")
    .bind(newer.ticket.ticket_id).run()
  const before = await f.row(newer.ticket.ticket_id)
  const response = await f.postError()
  assert.equal(response.status, 200, await response.text())
  assert.equal((await f.row(f.child.ticket_id)).status, 'error')
  assert.deepEqual(await f.row(newer.ticket.ticket_id), before)
  assert.equal((await f.row(f.root.ticket_id)).status, 'triggered')
}))
