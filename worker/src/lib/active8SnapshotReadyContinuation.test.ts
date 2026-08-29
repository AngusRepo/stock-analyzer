import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Miniflare } from 'miniflare'
import type { Bindings, UpdateQueueMsg } from '../types'
import { enqueueActive8AfterDatasetSnapshot } from './active8SnapshotReadyContinuation'
import {
  admitSchedulerExecutionTicket,
  loadLatestSchedulerChildTicket,
  schedulerDeliveryIdentity,
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
    d1Databases: ['OPS', 'LEARNING'],
  })
  try {
    const opsDb = await mf.getD1Database('OPS')
    const learningDb = await mf.getD1Database('LEARNING')
    await applySql(opsDb, opsMigration)
    await learningDb.prepare(`
      CREATE TABLE dataset_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        business_date TEXT NOT NULL,
        kind TEXT NOT NULL,
        access_tier TEXT NOT NULL,
        status TEXT NOT NULL
      )
    `).run()
    const businessDate = '2026-08-28'
    const snapshotId = 'backtest_dataset:2026-08-28:pipeline:snapshot'
    await learningDb.prepare(`
      INSERT INTO dataset_snapshots (snapshot_id, business_date, kind, access_tier, status)
      VALUES (?, ?, 'backtest_dataset', 'compute', 'ready')
    `).bind(snapshotId, businessDate).run()

    const root = await admitSchedulerExecutionTicket(opsDb, {
      identity: schedulerDeliveryIdentity(new Headers({
        'X-CloudScheduler-JobName': 'projects/p/locations/asia-east1/jobs/evening-chain',
        'X-CloudScheduler-ScheduleTime': '2026-08-28T13:00:00Z',
      })),
      task: 'evening-chain',
      requestedRunDate: businessDate,
      proposedRunId: 'evening-chain-2026-08-28',
    })
    assert.equal(root.shouldExecute, true)

    const sent: UpdateQueueMsg[] = []
    const env = {
      DB: opsDb,
      OPS_DB: opsDb,
      LEARNING_DB: learningDb,
      MULTI_D1_ACTIVE_DOMAINS: 'ops,learning',
      MULTI_D1_STRICT: 'true',
      UPDATE_QUEUE: {
        send: async (message: UpdateQueueMsg) => { sent.push(message) },
      },
    } as unknown as Bindings
    const summary = `run_id=pipeline:snapshot backtest=${snapshotId} rows=2545370 price=price rows=1`
    const first = await enqueueActive8AfterDatasetSnapshot(env, {
      businessDate,
      snapshotRunId: 'pipeline:snapshot',
      summary,
    })
    assert.equal(first.queued, true)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'active8_oof_after_snapshot')
    assert.equal(sent[0].active8SnapshotId, snapshotId)

    const duplicate = await enqueueActive8AfterDatasetSnapshot(env, {
      businessDate,
      snapshotRunId: 'pipeline:snapshot',
      summary,
    })
    assert.equal(duplicate.queued, false)
    assert.equal(duplicate.reason, 'duplicate_queued')
    assert.equal(sent.length, 1)

    const child = await loadLatestSchedulerChildTicket(opsDb, {
      task: 'active8-oof-daily',
      businessDate,
      origin: 'dataset_snapshot_ready',
    })
    const snapshotChild = await loadLatestSchedulerChildTicket(opsDb, {
      task: 'dataset-snapshot-export',
      businessDate,
      origin: 'dataset_snapshot_ready',
    })
    assert.equal(child?.root_ticket_id, root.ticket.ticket_id)
    assert.equal(child?.parent_ticket_id, snapshotChild?.ticket_id)
    assert.equal(snapshotChild?.status, 'success')
    assert.equal(child?.status, 'queued')
    assert.equal(JSON.parse(child?.metadata_json ?? '{}').snapshot_id, snapshotId)
    console.log('active8 snapshot-ready D1/queue integration passed')
  } finally {
    await mf.dispose()
  }
}

void main().catch((error) => { throw error })
