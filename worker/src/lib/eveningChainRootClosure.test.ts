import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import {
  closeEveningChainRootAndLog,
  closeEveningChainRootIfComplete,
  runEveningChainRootDeadlineSweepOnce,
  sweepExpiredEveningChainRoots,
} from './eveningChainRootClosure'
import {
  admitSchedulerChildTicket,
  admitSchedulerExecutionTicket,
  loadLatestSchedulerRootTicket,
  schedulerDeliveryIdentity,
  updateSchedulerExecutionTicket,
} from './schedulerExecutionTickets'

const opsMigration = fs.readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8')

async function applySql(db: D1Database, sql: string): Promise<void> {
  for (const statement of sql.replace(/^--.*$/gm, '').split(';').map((value) => value.trim()).filter(Boolean)) {
    await db.prepare(statement).run()
  }
}

async function main(): Promise<void> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['OPS'],
  })
  try {
    const db = await mf.getD1Database('OPS')
    await applySql(db, opsMigration)
    await db.prepare(`
      CREATE TABLE pipeline_stage_runs (
        business_date TEXT NOT NULL, stage TEXT NOT NULL, canonical_run_id TEXT NOT NULL,
        status TEXT NOT NULL, cursor_key TEXT, PRIMARY KEY (business_date, stage)
      )
    `).run()
    await db.prepare(`
      CREATE TABLE strategy_learning_runs (
        business_date TEXT PRIMARY KEY, canonical_run_id TEXT NOT NULL,
        producer_run_id TEXT, status TEXT NOT NULL,
        expected_candidates INTEGER NOT NULL, processed_candidates INTEGER NOT NULL,
        expected_decision_rows INTEGER NOT NULL, persisted_decision_rows INTEGER NOT NULL,
        production_authority_intent INTEGER NOT NULL, policy_closure_status TEXT NOT NULL,
        completed_at TEXT, policy_closure_reason TEXT
      )
    `).run()
    const businessDate = '2026-08-31'
    const canonicalRunId = 'pipeline:2026-08-31:canonical'
    const root = await admitSchedulerExecutionTicket(db, {
      identity: schedulerDeliveryIdentity(new Headers({
        'X-CloudScheduler-JobName': 'projects/p/locations/asia-east1/jobs/evening-chain',
        'X-CloudScheduler-ScheduleTime': '2026-08-31T13:00:00Z',
      })),
      task: 'evening-chain',
      requestedRunDate: businessDate,
      proposedRunId: 'evening-chain:2026-08-31',
    })
    await updateSchedulerExecutionTicket(db, {
      ticketId: root.ticket.ticket_id,
      runId: root.ticket.run_id,
      status: 'triggered',
      authority: 'scheduler_http',
      summary: 'pipeline triggered',
    })
    // Early inference failure has no post-verify or Active-8 child yet. It must
    // still close the physical root as error, not leave it triggered forever.
    await db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status)
      VALUES (?,'pipeline_execution',?,'error')`).bind(businessDate, canonicalRunId).run()
    const early = await closeEveningChainRootIfComplete(db, { businessDate })
    assert.equal(early.status, 'closed_error')
    assert(early.blockers.includes('pipeline_execution:error'))
    const failedRoot = await loadLatestSchedulerRootTicket(db, { schedulerJobId: 'evening-chain', businessDate })
    assert.equal(failedRoot?.status, 'error')
    assert(failedRoot?.completed_at)
    const stale = await closeEveningChainRootIfComplete(db, { businessDate, canonicalRunId: 'old-pipeline' })
    assert.equal(stale.status, 'pending')
    assert.deepEqual(stale.blockers, ['pipeline_execution:canonical_run_id_mismatch'])
    await assert.rejects(updateSchedulerExecutionTicket(db, {
      ticketId: root.ticket.ticket_id, runId: root.ticket.run_id,
      status: 'error', authority: 'logical_child', expectedPipelineCanonicalRunId: 'old-pipeline',
    }), /transition rejected/)
    await db.prepare("UPDATE pipeline_stage_runs SET status='running' WHERE business_date=? AND stage='pipeline_execution'")
      .bind(businessDate).run()
    await db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status)
      VALUES (?,'post_pipeline_chain','old-pipeline','error')`).bind(businessDate).run()
    const retryPending = await closeEveningChainRootIfComplete(db, { businessDate })
    assert.equal(retryPending.status, 'pending')
    assert(retryPending.blockers.includes('post_pipeline_chain:canonical_run_id_mismatch'))
    await db.prepare("DELETE FROM pipeline_stage_runs WHERE business_date=? AND stage='post_pipeline_chain'")
      .bind(businessDate).run()
    await db.prepare("DELETE FROM pipeline_stage_runs WHERE business_date=? AND stage='pipeline_execution'")
      .bind(businessDate).run()
    for (const stage of ['pipeline_execution', 'post_pipeline_chain', 'verify_v2', 'screener_v2', 'post_verify_chain']) {
      await db.prepare(`
        INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,cursor_key)
        VALUES (?,?,?,'success',?)
      `).bind(
        businessDate,
        stage,
        stage === 'screener_v2' ? 'indicator-run:2026-08-31' : canonicalRunId,
        stage === 'screener_v2' ? 'screener:2026-08-31' : null,
      ).run()
    }
    await db.prepare(`
      INSERT INTO strategy_learning_runs (
        business_date,canonical_run_id,producer_run_id,status,
        expected_candidates,processed_candidates,expected_decision_rows,persisted_decision_rows,
        production_authority_intent,policy_closure_status,completed_at
      ) VALUES (?,?,?,'success',830,830,21580,21580,1,'materialized',CURRENT_TIMESTAMP)
    `).bind(businessDate, canonicalRunId, 'screener:2026-08-31').run()
    const snapshot = await admitSchedulerChildTicket(db, {
      rootTicketId: root.ticket.root_ticket_id,
      parentTicketId: root.ticket.ticket_id,
      childKey: 'snapshot',
      task: 'dataset-snapshot-export',
      businessDate,
      runId: `${canonicalRunId}:snapshot`,
      metadata: { origin: 'dataset_snapshot_ready' },
    })
    await updateSchedulerExecutionTicket(db, {
      ticketId: snapshot.ticket_id,
      runId: snapshot.run_id,
      status: 'success',
      authority: 'logical_child',
      summary: 'snapshot ready',
    })
    const active8 = await admitSchedulerChildTicket(db, {
      rootTicketId: root.ticket.root_ticket_id,
      parentTicketId: snapshot.ticket_id,
      childKey: 'active8',
      task: 'active8-oof-daily',
      businessDate,
      runId: `${canonicalRunId}:snapshot:active8-oof-daily`,
      metadata: {
        origin: 'dataset_snapshot_ready',
        snapshot_run_id: snapshot.run_id,
      },
    })
    const pending = await closeEveningChainRootIfComplete(db, { businessDate, canonicalRunId })
    assert.equal(pending.status, 'pending')
    assert.deepEqual(pending.blockers, ['active8_oof_daily:accepted'])

    await updateSchedulerExecutionTicket(db, {
      ticketId: root.ticket.ticket_id,
      runId: root.ticket.run_id,
      status: 'error',
      authority: 'logical_child',
      summary: 'transient downstream closure failure',
      error: 'post_verify_chain:error,strategy_learning:missing',
    })
    await updateSchedulerExecutionTicket(db, {
      ticketId: active8.ticket_id,
      runId: active8.run_id,
      status: 'success',
      authority: 'logical_child',
      summary: 'active8 exact daily closure',
    })
    await db.prepare(`
      UPDATE strategy_learning_runs
         SET policy_closure_status='evidence_only'
       WHERE business_date=? AND canonical_run_id=?
    `).bind(businessDate, canonicalRunId).run()
    const policyPending = await closeEveningChainRootIfComplete(db, { businessDate, canonicalRunId })
    assert.equal(policyPending.status, 'pending')
    assert.deepEqual(policyPending.blockers, ['strategy_learning:policy_closure_invalid'])

    await db.prepare(`
      UPDATE strategy_learning_runs
         SET policy_closure_status='materialized'
       WHERE business_date=? AND canonical_run_id=?
    `).bind(businessDate, canonicalRunId).run()
    // The final Active-8 callback only supplies businessDate. Recovery must use
    // the actual canonical stage plus CAS, not require a caller-invented run ID.
    const closed = await closeEveningChainRootIfComplete(db, { businessDate })
    assert.equal(closed.status, 'closed_success')
    assert.deepEqual(closed.blockers, [])
    const durableRoot = await loadLatestSchedulerRootTicket(db, {
      schedulerJobId: 'evening-chain',
      businessDate,
    })
    assert.equal(durableRoot?.status, 'success')
    assert.match(durableRoot?.last_summary ?? '', /durable DAG complete/)
    console.log('evening-chain durable root DAG closure passed')
  } finally {
    await mf.dispose()
  }
}

void main().catch((error) => { throw error })

class MapKv {
  // An empty cached TWSE schedule keeps the trading calendar offline: weekends and holiday:* keys only.
  readonly values = new Map<string, string>([['market:twse_holiday_schedule:v2:2026',
    JSON.stringify({ schemaVersion: 'twse-holiday-schedule-v2', dates: [], loadedAt: '2026-01-01T00:00:00.000Z' })]])
  async get(key: string, type?: string): Promise<unknown> {
    const value = this.values.get(key)
    if (value == null) return null
    return type === 'json' ? JSON.parse(value) : value
  }
  async put(key: string, value: string): Promise<void> { this.values.set(key, value) }
  receipt(date: string): { status?: string; summary?: string; error?: string; run_scope?: string } | null {
    const value = this.values.get(`scheduler:run:evening-chain:${date}`)
    return value ? JSON.parse(value) : null
  }
}

async function closureFixture() {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['OPS'] })
  const db = await mf.getD1Database('OPS')
  await applySql(db, opsMigration)
  await db.prepare(`CREATE TABLE pipeline_stage_runs (
    business_date TEXT NOT NULL, stage TEXT NOT NULL, canonical_run_id TEXT NOT NULL,
    status TEXT NOT NULL, cursor_key TEXT, lease_owner TEXT, lease_expires_at TEXT,
    PRIMARY KEY (business_date, stage))`).run()
  await db.prepare(`CREATE TABLE strategy_learning_runs (
    business_date TEXT PRIMARY KEY, canonical_run_id TEXT NOT NULL, producer_run_id TEXT, status TEXT NOT NULL,
    expected_candidates INTEGER NOT NULL, processed_candidates INTEGER NOT NULL,
    expected_decision_rows INTEGER NOT NULL, persisted_decision_rows INTEGER NOT NULL,
    production_authority_intent INTEGER NOT NULL, policy_closure_status TEXT NOT NULL,
    completed_at TEXT, policy_closure_reason TEXT)`).run()
  const admitRoot = async (businessDate: string) => {
    const root = await admitSchedulerExecutionTicket(db, {
      identity: schedulerDeliveryIdentity(new Headers({
        'X-CloudScheduler-JobName': 'projects/p/locations/asia-east1/jobs/evening-chain',
        'X-CloudScheduler-ScheduleTime': `${businessDate}T13:45:00Z`,
      })),
      task: 'evening-chain', requestedRunDate: businessDate, proposedRunId: `evening-chain:${businessDate}`,
    })
    await updateSchedulerExecutionTicket(db, {
      ticketId: root.ticket.ticket_id, runId: root.ticket.run_id,
      status: 'triggered', authority: 'scheduler_http', summary: 'pipeline triggered',
    })
    return root.ticket
  }
  // Every stage, strategy learning and the Active-8 child complete for this run, except the stages left out.
  const completeDag = async (businessDate: string, runId: string, rootTicket: { ticket_id: string; root_ticket_id: string },
    omitStages: string[] = [], productionAuthority = 1) => {
    for (const stage of ['pipeline_execution', 'post_pipeline_chain', 'verify_v2', 'screener_v2', 'post_verify_chain']) {
      if (omitStages.includes(stage)) continue
      await db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,cursor_key) VALUES (?,?,?,'success',?)`)
        .bind(businessDate, stage, stage === 'screener_v2' ? `indicator:${businessDate}` : runId,
          stage === 'screener_v2' ? `screener:${businessDate}` : null).run()
    }
    await db.prepare(`INSERT INTO strategy_learning_runs (business_date,canonical_run_id,producer_run_id,status,
      expected_candidates,processed_candidates,expected_decision_rows,persisted_decision_rows,
      production_authority_intent,policy_closure_status,completed_at)
      VALUES (?,?,?,'success',2,2,4,4,?,?,CURRENT_TIMESTAMP)`)
      .bind(businessDate, runId, `screener:${businessDate}`, productionAuthority,
        productionAuthority ? 'materialized' : 'evidence_only').run()
    const snapshot = await admitSchedulerChildTicket(db, {
      rootTicketId: rootTicket.root_ticket_id, parentTicketId: rootTicket.ticket_id, childKey: 'snapshot',
      task: 'dataset-snapshot-export', businessDate, runId: `${runId}:snapshot`, metadata: { origin: 'dataset_snapshot_ready' },
    })
    await updateSchedulerExecutionTicket(db, { ticketId: snapshot.ticket_id, runId: snapshot.run_id, status: 'success', authority: 'logical_child' })
    const active8 = await admitSchedulerChildTicket(db, {
      rootTicketId: rootTicket.root_ticket_id, parentTicketId: snapshot.ticket_id, childKey: 'active8',
      task: 'active8-oof-daily', businessDate, runId: `${runId}:active8`,
      metadata: { origin: 'dataset_snapshot_ready', snapshot_run_id: snapshot.run_id },
    })
    await updateSchedulerExecutionTicket(db, { ticketId: active8.ticket_id, runId: active8.run_id, status: 'success', authority: 'logical_child' })
  }
  const rootOf = (businessDate: string) => loadLatestSchedulerRootTicket(db, { schedulerJobId: 'evening-chain', businessDate })
  return { mf, db, admitRoot, completeDag, rootOf }
}

test('deadline mode closes a root whose stages never started; a later full DAG still recovers it to success', async () => {
  const f = await closureFixture()
  try {
    const kv = new MapKv()
    const day = '2026-10-27'
    await f.admitRoot(day)
    assert.equal((await closeEveningChainRootIfComplete(f.db, { businessDate: day })).status, 'pending')
    const expired = await closeEveningChainRootAndLog(kv as unknown as KVNamespace, f.db, { businessDate: day, deadlineExceeded: true })
    assert.equal(expired.status, 'closed_error')
    assert.deepEqual(expired.blockers, ['pipeline_execution_canonical_run_id_missing'])
    const closed = await f.rootOf(day)
    assert.equal(closed?.status, 'error')
    assert.equal(closed?.last_error, 'root_closure_deadline_exceeded:pipeline_execution_canonical_run_id_missing')
    assert.equal(kv.receipt(day)?.status, 'error')

    // Missing downstream stages of a known run are terminal at the deadline as well.
    const day2 = '2026-10-28'
    const root2 = await f.admitRoot(day2)
    await f.completeDag(day2, 'run-1028', root2, ['post_verify_chain'])
    assert.equal((await closeEveningChainRootIfComplete(f.db, { businessDate: day2 })).status, 'pending')
    const missing = await closeEveningChainRootIfComplete(f.db, { businessDate: day2, deadlineExceeded: true })
    assert.equal(missing.status, 'closed_error')
    assert.match(String((await f.rootOf(day2))?.last_error), /^root_closure_deadline_exceeded:post_verify_chain:missing/)
    await f.db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status) VALUES (?,'post_verify_chain','run-1028','success')`)
      .bind(day2).run()
    const recovered = await closeEveningChainRootAndLog(kv as unknown as KVNamespace, f.db, { businessDate: day2 })
    assert.equal(recovered.status, 'closed_success')
    assert.equal((await f.rootOf(day2))?.status, 'success')
    assert.equal(kv.receipt(day2)?.status, 'success')
  } finally { await f.mf.dispose() }
})

test('closure helper mirrors closed_error to KV evening-chain and annotates a historical replay closure', async () => {
  const f = await closureFixture()
  try {
    const kv = new MapKv()
    const day = '2026-11-02'
    const root = await f.admitRoot(day)
    await f.completeDag(day, 'run-1102', root)
    await f.db.prepare(`UPDATE pipeline_stage_runs SET status='error' WHERE business_date=? AND stage='post_verify_chain'`).bind(day).run()
    kv.values.set(`scheduler:run:evening-chain:${day}`, JSON.stringify({
      task: 'evening-chain', status: 'running', summary: 'root chain waiting for queued strategy-learning',
      duration_ms: 0, run_id: 'run-1102', run_date: day, timestamp: '2026-11-02T15:00:00.000Z',
    }))
    const failed = await closeEveningChainRootAndLog(kv as unknown as KVNamespace, f.db, { businessDate: day, canonicalRunId: 'run-1102' })
    assert.equal(failed.status, 'closed_error')
    assert.equal((await f.rootOf(day))?.status, 'error')
    assert.equal(kv.receipt(day)?.status, 'error', 'KV no longer says running after the durable root failed')
    assert.match(String(kv.receipt(day)?.error), /post_verify_chain:error/)

    const replayDay = '2026-10-30'
    const replayRoot = await f.admitRoot(replayDay)
    await f.completeDag(replayDay, 'run-1030', replayRoot, [], 0)
    const replay = await closeEveningChainRootAndLog(kv as unknown as KVNamespace, f.db, {
      businessDate: replayDay, canonicalRunId: 'run-1030', runScope: 'historical_replay',
    })
    assert.equal(replay.status, 'closed_success')
    assert.match(String((await f.rootOf(replayDay))?.last_summary), /run_scope=historical_replay/)
    assert.equal(kv.receipt(replayDay)?.run_scope, 'historical_replay')
  } finally { await f.mf.dispose() }
})

test('deadline sweep closes only expired non-terminal roots, once per day', async () => {
  const f = await closureFixture()
  try {
    const kv = new MapKv()
    const today = '2026-11-12'
    for (const day of ['2026-10-01', '2026-11-02', '2026-11-04', '2026-11-10', '2026-11-11']) await f.admitRoot(day)
    const done = await f.admitRoot('2026-11-05')
    await updateSchedulerExecutionTicket(f.db, { ticketId: done.ticket_id, runId: done.run_id, status: 'error', authority: 'logical_child', summary: 'closed' })
    const summary = await runEveningChainRootDeadlineSweepOnce(kv as unknown as KVNamespace, f.db, today)
    assert.match(summary, /closed=2 dates=2026-11-02:closed_error,2026-11-04:closed_error/)
    for (const day of ['2026-11-02', '2026-11-04']) assert.equal((await f.rootOf(day))?.status, 'error')
    for (const day of ['2026-10-01', '2026-11-10', '2026-11-11']) assert.equal((await f.rootOf(day))?.status, 'triggered', `${day} is outside the sweep window`)
    assert.equal((await f.rootOf('2026-11-05'))?.last_summary, 'closed')
    assert.match(await runEveningChainRootDeadlineSweepOnce(kv as unknown as KVNamespace, f.db, today), /^skipped: .*already ran/)
  } finally { await f.mf.dispose() }
})

test('deadline sweep counts TW trading days: Friday\'s root survives Monday night, a holiday span does not count', async () => {
  const f = await closureFixture()
  try {
    const kv = new MapKv()
    const sweep = (today: string) => sweepExpiredEveningChainRoots(kv as unknown as KVNamespace, f.db, today)
    await f.admitRoot('2026-11-06')
    assert.deepEqual(await sweep('2026-11-09'), [], 'Friday root on Monday 21:00 is left to the strategy-learning watchdog')
    assert.deepEqual(await sweep('2026-11-11'), [], 'third trading day after Friday is still inside the deadline')
    assert.deepEqual((await sweep('2026-11-12')).map((row) => row.business_date), ['2026-11-06'], 'a truly stale root closes')
    assert.equal((await f.rootOf('2026-11-06'))?.status, 'error')

    for (const day of ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09']) kv.values.set(`holiday:${day}`, '1')
    await f.admitRoot('2026-11-02')
    assert.deepEqual(await sweep('2026-11-12'), [], 'a five-session closure does not age the root')
    assert.deepEqual((await sweep('2026-11-13')).map((row) => row.business_date), ['2026-11-02'])
  } finally { await f.mf.dispose() }
})

test('deadline sweep leaves a date with a live stage lease, and a waiting pipeline execution for 14 days', async () => {
  const f = await closureFixture()
  try {
    const kv = new MapKv()
    for (const day of ['2026-11-02', '2026-11-03']) await f.admitRoot(day)
    await f.db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status) VALUES ('2026-11-02','pipeline_execution','r1','waiting')`).run()
    await f.db.prepare(`INSERT INTO pipeline_stage_runs (business_date,stage,canonical_run_id,status,lease_owner,lease_expires_at)
      VALUES ('2026-11-03','post_verify_chain','r2','running','owner',datetime('now','+5 minutes'))`).run()
    assert.deepEqual(await sweepExpiredEveningChainRoots(kv as unknown as KVNamespace, f.db, '2026-11-12'), [])
    await f.db.prepare(`UPDATE pipeline_stage_runs SET lease_expires_at=datetime('now','-1 minutes') WHERE business_date='2026-11-03'`).run()
    assert.deepEqual((await sweepExpiredEveningChainRoots(kv as unknown as KVNamespace, f.db, '2026-11-12')).map((row) => row.business_date), ['2026-11-03'])
    // A waiting execution keeps its root open for 14 calendar days only: a callback that never returns is closed.
    assert.deepEqual(await sweepExpiredEveningChainRoots(kv as unknown as KVNamespace, f.db, '2026-11-16'), [], '11-02 is 14 days before 11-16')
    assert.deepEqual((await sweepExpiredEveningChainRoots(kv as unknown as KVNamespace, f.db, '2026-11-17')).map((row) => row.business_date), ['2026-11-02'])
  } finally { await f.mf.dispose() }
})

test('an already-terminal root is not re-sent as error over a same-run success receipt', async () => {
  const f = await closureFixture()
  try {
    const kv = new MapKv()
    const day = '2026-11-05'
    const root = await f.admitRoot(day)
    await updateSchedulerExecutionTicket(f.db, { ticketId: root.ticket_id, runId: root.run_id, status: 'skipped', authority: 'logical_child', summary: 'superseded' })
    const success = { task: 'evening-chain', status: 'success', summary: 'closed', duration_ms: 0, run_id: 'run-1105', run_date: day, timestamp: '2026-11-05T15:00:00.000Z' }
    kv.values.set(`scheduler:run:evening-chain:${day}`, JSON.stringify(success))
    const outcome = await closeEveningChainRootAndLog(kv as unknown as KVNamespace, f.db, { businessDate: day, canonicalRunId: 'run-1105', supersedePrevious: true })
    assert.equal(outcome.status, 'closed_error')
    assert.equal(kv.receipt(day)?.status, 'success')
  } finally { await f.mf.dispose() }
})

test('terminal stage errors close the durable root, a retried throw does not; telemetry no longer skips a historical replay', () => {
  const source = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
  const postPipeline = source.slice(source.indexOf("if (msg.type === 'post_pipeline_chain')"), source.indexOf("if (msg.type === 'post_verify_chain')"))
  const terminal = postPipeline.slice(postPipeline.indexOf('stale post-pipeline finalizer ignored'), postPipeline.indexOf('} catch (error) {', postPipeline.indexOf('stale post-pipeline finalizer ignored')))
  assert.match(terminal, /else if \(status === 'error'\) \{\s*await closeEveningChainRootAfterStageError\(env, triggerTime, runId\)/)
  const pipelineCatch = postPipeline.slice(postPipeline.indexOf('stale post-pipeline error finalizer ignored'))
  assert.ok(!pipelineCatch.slice(0, pipelineCatch.indexOf('throw error')).includes('closeEveningChainRootAfterStageError'),
    'the queue retries a thrown post-pipeline stage, so the root stays open')
  const postVerify = source.slice(source.indexOf("if (msg.type === 'post_verify_chain')"), source.indexOf("if (msg.type === 'allocator_ev_lifecycle_recovery')"))
  const verifyCatch = postVerify.slice(postVerify.indexOf('stale post-verify error telemetry ignored'))
  assert.ok(verifyCatch.indexOf('closeEveningChainRootAfterStageError(env, triggerTime, runId)') > 0
    && verifyCatch.indexOf('closeEveningChainRootAfterStageError(env, triggerTime, runId)') < verifyCatch.indexOf('throw error'))
  const telemetry = fs.readFileSync('src/lib/strategyLearningFinalizedTelemetry.ts', 'utf8')
  assert.ok(!telemetry.includes("if (input.runScope === 'historical_replay') return"))
  assert.ok(telemetry.includes('closeEveningChainRootAndLog(kv, db,'))
  const gcpTasks = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
  const watchdog = gcpTasks.slice(gcpTasks.indexOf("'allocator-ev-lifecycle-watchdog': async () => {"), gcpTasks.indexOf("'paper-active-postmarket'"))
  assert.ok(watchdog.indexOf('runEveningChainRootDeadlineSweepOnce(') < watchdog.indexOf('runAllocatorEvLifecycleWatchdog(c.env'))
})
