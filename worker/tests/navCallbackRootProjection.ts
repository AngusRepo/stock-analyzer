// Actual Python job callbacks and original admission/settlement, shared private
// persisted D1/KV. Upstream stage summaries and OOF are fixtures, not full E2E/ROI.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Miniflare } from 'miniflare'
import { adminControlRoutes } from '../src/routes/adminControlRoutes'
import { processUpdateBatch } from '../src/lib/updateOrchestrator'
import { admitSchedulerExecutionTicket, admitSchedulerChildTicket, schedulerDeliveryIdentity,
  updateSchedulerExecutionTicket } from '../src/lib/schedulerExecutionTickets'

async function main() {
  const [directory, mode, source] = process.argv.slice(2)
  assert(directory && ['prepare', 'verify'].includes(mode))
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("private") } }',
    d1Databases: ['OPS', 'LEARNING', 'MARKET'], kvNamespaces: ['NAV'],
    d1Persist: path.join(directory, 'root-d1'), kvPersist: path.join(directory, 'root-kv') })
  const previousFetch = globalThis.fetch
  const RealDate = globalThis.Date
  try {
    const ops = await mf.getD1Database('OPS'), learning = await mf.getD1Database('LEARNING')
    const market = await mf.getD1Database('MARKET')
    const kv = await mf.getKVNamespace('NAV')
    const day = process.env.NAV_ROOT_TEST_DAY ?? '2026-09-09'
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/)
    if (process.env.NAV_ROOT_TEST_DAY) {
      // Same synthetic clock as the original Python ledger/job; the actual
      // scheduler future-delivery guard stays enabled and executes normally.
      globalThis.Date = class extends RealDate {
        constructor(value?: any) { super(value === undefined ? day + 'T14:00:00Z' : value) }
        static now() { return RealDate.parse(day + 'T14:00:00Z') }
      } as DateConstructor
    }
    const calendar: string[] = []
    for (const cursor = new Date(day + 'T00:00:00Z'); calendar.length < 7; cursor.setUTCDate(cursor.getUTCDate() - 1))
      if (![0, 6].includes(cursor.getUTCDay())) calendar.unshift(cursor.toISOString().slice(0, 10))
    const matureDate = calendar[1] // Synthetic seven-session calendar, original five-session readiness.
    const canonical = `pipeline:${day}:isolated-root`, callbackRunId = `active8-oof-daily:${day}:resolve-after-prep`
    if (mode === 'prepare') {
      for (const [db, file] of [[ops, 'domain-migrations/ops/0011_scheduler_execution_tickets.sql'],
        [learning, 'migrations/0102_active8_oof_freshness_sla.sql']] as const) {
        for (const sql of fs.readFileSync(file, 'utf8').replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean))
          await db.prepare(sql).run()
      }
      await ops.prepare(`CREATE TABLE pipeline_stage_runs(business_date TEXT,stage TEXT,canonical_run_id TEXT,
        status TEXT,cursor_key TEXT,PRIMARY KEY(business_date,stage))`).run()
      await ops.prepare(`CREATE TABLE strategy_learning_runs(business_date TEXT PRIMARY KEY,canonical_run_id TEXT,
        producer_run_id TEXT,status TEXT,expected_candidates INTEGER,processed_candidates INTEGER,
        expected_decision_rows INTEGER,persisted_decision_rows INTEGER,production_authority_intent INTEGER,
        policy_closure_status TEXT,policy_closure_reason TEXT,completed_at TEXT)`).run()
      for (const stage of ['pipeline_execution', 'post_pipeline_chain', 'verify_v2', 'screener_v2', 'post_verify_chain'])
        await ops.prepare('INSERT INTO pipeline_stage_runs VALUES(?,?,?,?,?)')
          .bind(day, stage, canonical, 'success', stage === 'screener_v2' ? 'fixture-screener' : null).run()
      await ops.prepare(`INSERT INTO strategy_learning_runs VALUES(?,?,?,'success',1,1,1,1,0,'evidence_only',NULL,CURRENT_TIMESTAMP)`)
        .bind(day, canonical, 'fixture-screener').run()
      const root = (await admitSchedulerExecutionTicket(ops as any, {
        identity: schedulerDeliveryIdentity(new Headers({ 'X-CloudScheduler-JobName': 'projects/local/locations/asia-east1/jobs/evening-chain',
          'X-CloudScheduler-ScheduleTime': day + 'T13:00:00Z' })),
        task: 'evening-chain', requestedRunDate: day, proposedRunId: `evening-chain:${day}` })).ticket
      await updateSchedulerExecutionTicket(ops as any, { ticketId: root.ticket_id, runId: root.run_id,
        status: 'triggered', authority: 'scheduler_http', summary: 'fixture upstream completed, actual NAV pending' })
      const snapshot = await admitSchedulerChildTicket(ops as any, { rootTicketId: root.ticket_id,
        parentTicketId: root.ticket_id, childKey: 'snapshot', task: 'dataset-snapshot-export', businessDate: day,
        runId: canonical + ':snapshot', metadata: { origin: 'dataset_snapshot_ready' } })
      await updateSchedulerExecutionTicket(ops as any, { ticketId: snapshot.ticket_id, runId: snapshot.run_id,
        status: 'success', authority: 'logical_child', summary: 'fixture snapshot ready' })
      const child = await admitSchedulerChildTicket(ops as any, { rootTicketId: root.ticket_id,
        parentTicketId: snapshot.ticket_id, childKey: 'active8', task: 'active8-oof-daily', businessDate: day,
        runId: snapshot.run_id + ':active8', metadata: { origin: 'dataset_snapshot_ready',
          snapshot_run_id: snapshot.run_id, active8_callback_run_id: callbackRunId } })
      console.log('NAV_ROOT_IDENTITY=' + JSON.stringify({ ticket_id: child.ticket_id, run_id: child.run_id,
        callback_run_id: callbackRunId, root_ticket_id: root.ticket_id }))
      return
    }
    const { identity, callbacks, exhaust_readiness, continuation_request, continuation_dispatch,
      retirement_state } = JSON.parse(fs.readFileSync(source, 'utf8'))
    assert.equal(callbacks.length, 3)
    const row = (id: string) => ops.prepare('SELECT * FROM scheduler_execution_tickets_v1 WHERE ticket_id=?').bind(id).first<any>()
    assert.equal((await row(identity.root_ticket_id)).status, 'triggered')
    for (const callback of callbacks) {
      assert.equal(callback.run_id, callbackRunId)
      assert.equal(callback.scheduler_ticket_id, identity.ticket_id)
      assert.equal(callback.scheduler_run_id, identity.run_id)
      assert.equal(callback.run_date, day)
    }
    const queued: any[] = []
    let queueDown = false, rootKvDown = false, servingKvDown = false, readinessReceiptDown = false
    const env = { DB: ops, OPS_DB: ops, LEARNING_DB: learning, MARKET_DB: market, MULTI_D1_ACTIVE_DOMAINS: 'ops,learning,market',
      MULTI_D1_STRICT: 'true', STOCKVISION_AUTH_TOKEN: 'isolated-nav-root-token',
      ML_CONTROLLER_URL: 'https://private-controller.invalid',
      UPDATE_QUEUE: { send: async (message: any) => { if (queueDown) throw new Error('fixture_queue_down'); queued.push(message) } },
      KV: { get: (...args: any[]) => (kv.get as any)(...args), put: (key: string, ...args: any[]) => {
        if ((servingKvDown && key === 'expected-return:serving-state:v1')
          || (readinessReceiptDown && key.startsWith('scheduler:run:allocator-ev-readiness:')))
          throw new Error('fixture_readiness_projection_down')
        if (rootKvDown && (key.startsWith('scheduler:run:evening-chain:') || key.startsWith('cron:log:evening-chain:')))
          throw new Error('fixture_root_projection_down')
        return (kv.put as any)(key, ...args)
      } } } as any
    let dispatchAllowed = false, dispatchCalls = 0
    globalThis.fetch = async (url, init) => {
      if (!dispatchAllowed) throw new Error('external network forbidden')
      assert.equal(String(url), 'https://private-controller.invalid/walk_forward/oof/lifecycle')
      assert.deepEqual(JSON.parse(String(init?.body)), continuation_request)
      dispatchCalls++
      return Response.json(continuation_dispatch)
    }
    const post = async (callback: any) => {
      const pending: Promise<unknown>[] = []
      const response = await adminControlRoutes.request('https://private.test/api/admin/cron-callback', {
        method: 'POST', headers: { Authorization: 'Bearer isolated-nav-root-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(callback) }, env, { waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        passThroughOnException() {} } as any)
      await Promise.all(pending)
      return response
    }
    assert.equal(callbacks[0].status, 'triggered')
    assert.equal(callbacks[0].metadata.nav_retry_required, true)
    queueDown = true
    assert((await post(callbacks[0])).status >= 500)
    queueDown = false
    assert.equal((await post(callbacks[0])).status, 200)
    assert.equal(queued.length, 1)
    assert.equal(queued[0].schedulerTicketId, identity.ticket_id)
    assert.equal(queued[0].schedulerRunId, identity.run_id)
    assert.equal((await row(identity.root_ticket_id)).status, 'triggered')
    assert.notEqual((await row(identity.ticket_id)).status, 'success')
    assert.equal(await kv.get(`scheduler:run:evening-chain:${day}`), null)
    dispatchAllowed = true
    await processUpdateBatch(queued[0], env, {} as any)
    dispatchAllowed = false
    assert.equal(dispatchCalls, 1, 'the recorded continuation must execute its real queue consumer')
    assert.notEqual((await row(identity.ticket_id)).status, 'success', 'dispatch is not completion')
    assert.equal((await row(identity.root_ticket_id)).status, 'triggered')
    for (const callback of callbacks.slice(1)) {
      assert.equal(callback.status, 'success')
      assert.equal(callback.metadata.nav_retry_required, false)
      if (retirement_state) {
        assert.equal(callback.metadata.paired_nav_maturity.adoption.opb.completion_scope, 'retirement')
        assert.equal(callback.metadata.paired_nav_maturity.adoption.opb.pointer_committed, false)
        assert.match(callback.summary, /nav_retired=opb_arm_prior/)
        assert.match(callback.summary, /nav_committed=none/)
      }
    }
    // Actual source read failure must not be hidden behind a successful NAV
    // callback or an already-closed root; use the existing durable continuation.
    assert.equal((await post(callbacks[1])).status, 200)
    if (exhaust_readiness) {
      assert.equal(callbacks[1].metadata.continuation_attempt, 12)
      assert.equal(queued.length, 1, 'exhausted readiness cannot enqueue again')
      assert.equal((await row(identity.ticket_id)).status, 'error')
      assert.equal((await row(identity.root_ticket_id)).status, 'error')
      const log = await kv.get(`scheduler:run:evening-chain:${day}`, 'json') as any
      assert.equal(log.status, 'error')
      assert.match(log.summary, /active8_oof_daily:error/)
      assert.match((await row(identity.ticket_id)).last_error, /active8_allocator_readiness_incomplete/)
      console.log('NAV_ROOT_RESULT=' + JSON.stringify({ root_status: log.status,
        queue_count: queued.length, dispatch_calls: dispatchCalls, exhausted: true, production_effect: false }))
      return
    }
    assert.equal(queued.length, 2, 'missing readiness source must enqueue continuation')
    assert.equal((await row(identity.root_ticket_id)).status, 'triggered')
    assert.notEqual((await row(identity.ticket_id)).status, 'success')
    assert.equal(await kv.get(`scheduler:run:evening-chain:${day}`), null)
    // Isolated upstream fixture: original readiness queries/evaluator consume
    // safe-abstention owners and finite OOF/calendar data, not a mocked verdict.
    for (const ddl of [
      'CREATE TABLE expected_return_owner_state_v2(owner TEXT,owner_state TEXT,champion_artifact_id TEXT,reason_code TEXT,updated_at TEXT)',
      'CREATE TABLE model_champion_pointers(model_name TEXT,champion_version TEXT,champion_artifact_id TEXT,updated_at TEXT)',
      'CREATE TABLE model_artifact_registry(artifact_id TEXT,model_name TEXT,version TEXT,state TEXT,offline_gate_decision TEXT,offline_gate_failed_gates TEXT,source_run_date TEXT,updated_at TEXT,candidate_type TEXT)',
      'CREATE TABLE expected_return_artifact_payloads(artifact_id TEXT,model_name TEXT,model_version TEXT,artifact_json TEXT,payload_checksum TEXT,serving_mode TEXT)',
      'CREATE TABLE active8_oof_cohorts(cohort_id TEXT,status TEXT)',
      'CREATE TABLE active8_oof_materialized_artifacts(cohort_id TEXT,artifact_kind TEXT,max_date TEXT,updated_at TEXT)',
      'CREATE TABLE active8_oof_forward_extension_coverage(cohort_id TEXT,artifact_kind TEXT,max_date TEXT,date_eligibility_json TEXT,coverage_status TEXT,promotion_eligible INTEGER,training_dispatched INTEGER,policy_version TEXT,knowledge_cutoff_date TEXT,updated_at TEXT)',
      'CREATE TABLE expected_return_forward_guard_state(model_name TEXT,artifact_id TEXT,model_fingerprint TEXT,model_version TEXT,state TEXT,evaluable_date_count INTEGER,degraded_streak INTEGER,recovery_streak INTEGER,last_prediction_date TEXT,evidence_json TEXT,updated_at TEXT)',
    ]) {
      const table = /^CREATE TABLE (\w+)/.exec(ddl)![1]
      if (!retirement_state?.tables[table]) await learning.prepare(ddl).run()
    }
    if (retirement_state) {
      const tables = Object.entries(retirement_state.tables) as [string, any][]
      for (const [, data] of tables) await learning.prepare(data.schema).run()
      // D1 enforces the original FK even though the source fixture used SQLite.
      // Insert both artifact owners before pointer/payload dependants.
      tables.sort(([left], [right]) =>
        Number(!['model_artifact_registry', 'active8_ensemble_artifacts_v1'].includes(left))
        - Number(!['model_artifact_registry', 'active8_ensemble_artifacts_v1'].includes(right)))
      for (const [table, data] of tables) {
        for (const row of data.rows) {
          const fields = Object.keys(row)
          await learning.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`)
            .bind(...fields.map(key => row[key])).run()
        }
      }
      await kv.put('trading:config', JSON.stringify(retirement_state.trading_config))
      await kv.put('trading:risk_config', JSON.stringify(retirement_state.risk_config))
    } else for (const owner of ['l4_alpha_ev', 'allocator_ev_fusion'])
      await learning.prepare("INSERT INTO expected_return_owner_state_v2 VALUES(?,'safe_abstention',NULL,'fixture_not_promoted',?)").bind(owner, day).run()
    await learning.prepare("INSERT INTO active8_oof_cohorts VALUES('fixture','ready')").run()
    for (const kind of ['allocator_ev_snapshots', 'l4_predictions'])
      await learning.prepare("INSERT INTO active8_oof_materialized_artifacts VALUES('fixture',?,?,?)").bind(kind, matureDate, day).run()
    await market.prepare('CREATE TABLE canonical_market_daily(stock_id TEXT,source TEXT,date TEXT)').run()
    for (const date of calendar)
      await market.prepare("INSERT INTO canonical_market_daily VALUES('0050','finlab.price',?)").bind(date).run()
    await learning.prepare("UPDATE active8_oof_materialized_artifacts SET max_date='2026-08-01'").run()
    assert.equal((await post(callbacks[1])).status, 200)
    assert.equal(queued.length, 3, 'real fatal health verdict must continue, not close')
    assert.equal((await row(identity.root_ticket_id)).status, 'triggered')
    await learning.prepare('UPDATE active8_oof_materialized_artifacts SET max_date=?').bind(matureDate).run()
    servingKvDown = true
    assert.equal((await post(callbacks[1])).status, 200)
    assert.equal(queued.length, 4, 'serving consumer write failure must continue')
    assert.equal((await row(identity.root_ticket_id)).status, 'triggered')
    servingKvDown = false
    readinessReceiptDown = true
    assert.equal((await post(callbacks[1])).status, 200)
    assert.equal(queued.length, 5, 'readiness receipt write failure must continue')
    assert.equal((await row(identity.root_ticket_id)).status, 'triggered')
    readinessReceiptDown = false
    rootKvDown = true
    assert.equal((await post(callbacks[1])).status, 503)
    assert.equal((await row(identity.ticket_id)).status, 'success')
    assert.equal((await row(identity.root_ticket_id)).status, 'success')
    assert.equal(await kv.get(`scheduler:run:evening-chain:${day}`), null)
    const committedChild = await row(identity.ticket_id)
    rootKvDown = false
    for (const callback of callbacks.slice(1)) assert.equal((await post(callback)).status, 200)
    assert.deepEqual(await row(identity.ticket_id), committedChild)
    assert.equal(queued.length, 5)
    const log = await kv.get(`scheduler:run:evening-chain:${day}`, 'json') as any
    assert.equal(log.status, 'success')
    assert.equal(log.run_id, canonical)
    const readiness = await kv.get(`scheduler:run:allocator-ev-readiness:${day}`, 'json') as any
    assert.equal(readiness.status, 'success')
    assert.match(readiness.summary, retirement_state ? /readiness_state=(ready|degraded)/ : /readiness_state=safe_abstain/)
    const serving = await kv.get('expected-return:serving-state:v1', 'json') as any
    assert.equal(serving.state, retirement_state ? 'production_primary' : 'no_eligible_owner')
    if (retirement_state) {
      assert.equal(serving.expected_return_owner, 'l4_alpha_ev')
      assert.equal((await learning.prepare("SELECT COUNT(*) n FROM model_champion_pointers WHERE model_name='opb_arm_prior'").first<any>()).n, 0)
      assert.deepEqual(await kv.get('trading:config', 'json'), retirement_state.trading_config)
    }
    const audit = await learning.prepare('SELECT callback_status,status FROM active8_oof_freshness_sla ORDER BY decision_key').all()
    assert.equal(audit.results.length, 3)
    assert.equal(audit.results.filter(r => r.callback_status === 'success' && r.status === 'fresh').length, 2)
    console.log('NAV_ROOT_RESULT=' + JSON.stringify({ queue_count: queued.length, callback_count: callbacks.length,
      dispatch_calls: dispatchCalls,
      child_status: committedChild.status, root_status: log.status, canonical_run_id: log.run_id,
      queue_failure_recovered: true, readiness_failure_recovered: true,
      projection_failure_recovered: true, production_effect: false }))
  } finally { globalThis.fetch = previousFetch; globalThis.Date = RealDate; await mf.dispose() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
