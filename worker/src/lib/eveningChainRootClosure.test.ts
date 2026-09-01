import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Miniflare } from 'miniflare'
import { closeEveningChainRootIfComplete } from './eveningChainRootClosure'
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
        completed_at TEXT
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
    const closed = await closeEveningChainRootIfComplete(db, { businessDate, canonicalRunId })
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
