import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { claimPipelineStage, requeuePipelineStageFenced } from './pipelineStageLease'

// EC-F: after a heavy producer the queue consumer hands its live lease back and sends a continuation;
// the next delivery claims the stage like any queued run.
const date = '2026-11-02', run = 'finlab-A', stage = 'post_verify_chain'

function fixture() {
  const sql = new DatabaseSync(':memory:')
  const baseline = readFileSync('domain-migrations/ops/0001_ops_baseline.sql', 'utf8')
  const table = baseline.match(/CREATE TABLE IF NOT EXISTS pipeline_stage_runs \([\s\S]*?\n\);/)
  assert.ok(table)
  sql.exec(table[0])
  sql.prepare(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,queued_at,updated_at)
    VALUES(?,?,?,'queued',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(date, stage, run)
  const db = { prepare(query: string) {
    let values: any[] = []
    const st = { bind(...args: any[]) { values = args; return st },
      async first() { return sql.prepare(query).get(...values) ?? null } }
    return st
  } } as any
  const row = () => sql.prepare('SELECT status,lease_owner,lease_expires_at,attempt_count FROM pipeline_stage_runs').get() as any
  return { sql, db, row }
}

test('the live owner requeues its stage without counting the hop as an attempt', async () => {
  const f = fixture()
  assert.ok(await claimPipelineStage(f.db, { businessDate: date, stage, ownerId: 'owner-1', canonicalRunId: run }))
  assert.equal(f.row().attempt_count, 1)
  assert.equal(await requeuePipelineStageFenced(f.db, { businessDate: date, stage, canonicalRunId: run, leaseOwner: 'owner-1' }), true)
  assert.deepEqual({ ...f.row() }, { status: 'queued', lease_owner: null, lease_expires_at: null, attempt_count: 0 })
  // The continuation delivery claims it as a queued stage.
  assert.ok(await claimPipelineStage(f.db, { businessDate: date, stage, ownerId: 'owner-2', canonicalRunId: run }))
  assert.equal(f.row().attempt_count, 1)
  f.sql.close()
})

test('counter: a stale owner, an expired lease or another canonical run cannot requeue', async () => {
  const f = fixture()
  await claimPipelineStage(f.db, { businessDate: date, stage, ownerId: 'owner-1', canonicalRunId: run })
  assert.equal(await requeuePipelineStageFenced(f.db, { businessDate: date, stage, canonicalRunId: run, leaseOwner: 'owner-0' }), false)
  assert.equal(await requeuePipelineStageFenced(f.db, { businessDate: date, stage, canonicalRunId: 'finlab-B', leaseOwner: 'owner-1' }), false)
  f.sql.exec(`UPDATE pipeline_stage_runs SET lease_expires_at=datetime('now','-1 seconds')`)
  assert.equal(await requeuePipelineStageFenced(f.db, { businessDate: date, stage, canonicalRunId: run, leaseOwner: 'owner-1' }), false)
  assert.equal(f.row().status, 'running')
  assert.equal(f.row().attempt_count, 1)
  f.sql.close()
})

test('the queue consumer requeues before sending and lets a failed send redeliver', () => {
  const source = readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
  const block = source.slice(source.indexOf("if (msg.type === 'post_verify_chain')"),
    source.indexOf("if (msg.type === 'allocator_ev_lifecycle_recovery')"))
  const continueBranch = block.slice(block.indexOf("if (status === 'continue')"), block.indexOf("if (status === 'error')"))
  const order = ["assertActive('post-verify:before_continuation')", 'requeuePipelineStageFenced(',
    "UPDATE_QUEUE.send({ type: 'post_verify_chain'", 'postVerifyHop: Math.max(0, Number(msg.postVerifyHop ?? 0)) + 1',
    'continuationSendError = error', "expectedStatus: 'queued'", '.catch(markError', 'throw error']
  order.reduce((previous, marker) => {
    const at = continueBranch.indexOf(marker)
    assert.ok(at > previous, marker)
    return at
  }, -1)
  assert.ok(block.includes('{ hop: msg.postVerifyHop }'), 'the hop bound reaches the chain')
  // The continuation never writes root telemetry: the root stays running until the chain finishes.
  assert.ok(!continueBranch.includes('logSchedulerResult'))
  const catchBlock = block.slice(block.indexOf('} catch (error) {\n      // The lease was handed back'))
  assert.ok(catchBlock.indexOf('if (error === continuationSendError) throw error') < catchBlock.indexOf('isPipelineStageLeaseLost(error)'))
})
