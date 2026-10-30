import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import worker from '../index'
import { PIPELINE_STAGE_BUSY_RETRY_MARGIN_SECONDS, PIPELINE_STAGE_LEASE_SECONDS, pipelineStageBusyRetryDelaySeconds } from './pipelineStageLease'

// NEW-1030-22 (3): a post_verify_chain delivery that finds another owner's live stage lease is retried after
// that lease (lease remaining + 30 s) instead of being acknowledged; nothing else redrives the stage when that
// owner has died (10/29: acked at 06:25:41, lease ran out at 06:39:34, nothing ran again).
const date = '2026-10-29', run = 'finlab-A'

function fixture(lease: { status: string; owner: string | null; expiresInSeconds: number | null; canonical?: string },
  options: { claimFails?: boolean; onClaim?: (sql: DatabaseSync) => void } = {}) {
  const sql = new DatabaseSync(':memory:')
  const baseline = readFileSync('domain-migrations/ops/0001_ops_baseline.sql', 'utf8')
  for (const table of ['pipeline_stage_runs', 'strategy_learning_runs']) {
    const match = baseline.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))
    assert.ok(match, table); sql.exec(match[0])
  }
  sql.prepare(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,lease_owner,lease_expires_at,queued_at,updated_at)
    VALUES(?,?,?,?,?,${lease.expiresInSeconds === null ? 'NULL' : `datetime('now','${lease.expiresInSeconds >= 0 ? '+' : ''}${lease.expiresInSeconds} seconds')`},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .run(date, 'post_verify_chain', lease.canonical ?? run, lease.status, lease.owner)
  const db = { prepare(query: string) {
    let values: any[] = []
    const claim = /SET status='running', lease_owner=\?/.test(query)
    const st = { bind(...args: any[]) { values = args; return st },
      async first() { if (claim) options.onClaim?.(sql); if (claim && options.claimFails) return null; return sql.prepare(query).get(...values) ?? null },
      async all() { return { success: true, results: sql.prepare(query).all(...values) } },
      async run() { const out = sql.prepare(query).run(...values); return { success: true, meta: { changes: Number(out.changes) } } } }
    return st
  } }
  const kv = new Map<string, string>()
  const env = { DB: db, OPS_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'ops',
    KV: { get: async (key: string) => kv.get(key) ?? null, put: async (key: string, value: string) => { kv.set(key, value) }, delete: async (key: string) => { kv.delete(key) } },
    UPDATE_QUEUE: { send: async () => { throw new Error('unexpected send') } } } as any
  const calls: string[] = []
  const message = { id: 'm-1', attempts: 2, body: { type: 'post_verify_chain', triggerTime: date, runId: run, cursor: 0 },
    ack: () => { calls.push('ack') }, retry: (options?: { delaySeconds?: number }) => { calls.push(`retry:${options?.delaySeconds ?? 'default'}`) } }
  const deliver = () => worker.queue({ messages: [message] } as any, env, {} as any)
  return { sql, calls, deliver }
}

test('delay is the lease remaining plus the queue retry_delay margin, bounded by one lease', () => {
  assert.equal(PIPELINE_STAGE_BUSY_RETRY_MARGIN_SECONDS, 30)
  assert.equal(pipelineStageBusyRetryDelaySeconds(833), 863)
  assert.equal(pipelineStageBusyRetryDelaySeconds(0.2), 31)
  assert.equal(pipelineStageBusyRetryDelaySeconds(-5), 30)
  assert.equal(pipelineStageBusyRetryDelaySeconds(5_000), PIPELINE_STAGE_LEASE_SECONDS + 30)
})

test('another owner\'s live lease: the delivery is retried after it, never acknowledged', async () => {
  const f = fixture({ status: 'running', owner: `${run}:post-verify:other`, expiresInSeconds: 600 })
  await f.deliver()
  assert.equal(f.calls.length, 1)
  const [kind, delay] = f.calls[0].split(':')
  assert.equal(kind, 'retry')
  // 600 s left (± one second of D1/test clock) + 30 s margin.
  assert.ok(Math.abs(Number(delay) - 630) <= 1, f.calls[0])
  // The holder keeps its lease: the blocked delivery changed nothing.
  const row = f.sql.prepare('SELECT lease_owner,attempt_count FROM pipeline_stage_runs').get() as any
  assert.equal(row.lease_owner, `${run}:post-verify:other`)
  assert.equal(row.attempt_count, 0)
  f.sql.close()
})

test('a lease that expires between the failed claim and the readback is retried after the margin, not acked', async () => {
  // The claim lost to a live lease (forced here), which then ran out before the handler read the row.
  const expired = fixture({ status: 'running', owner: `${run}:post-verify:dead`, expiresInSeconds: 600 }, { claimFails: true,
    onClaim: sql => { sql.exec(`UPDATE pipeline_stage_runs SET lease_expires_at=datetime('now','-1 seconds')`) } })
  await expired.deliver()
  assert.deepEqual(expired.calls, [`retry:${PIPELINE_STAGE_BUSY_RETRY_MARGIN_SECONDS}`])
  expired.sql.close()
})

test('counter: a closed stage, or a stage adopted by another canonical run, keeps the acknowledged skip', async () => {
  const closed = fixture({ status: 'success', owner: null, expiresInSeconds: null })
  await closed.deliver()
  assert.deepEqual(closed.calls, ['ack'])
  // Another canonical run adopted the stage between this delivery's enqueue check and its claim: the
  // delivery is stale, and waiting would never make it claimable.
  const adopted = fixture({ status: 'running', owner: `${run}:post-verify:other`, expiresInSeconds: 600 }, {
    onClaim: sql => { sql.exec(`UPDATE pipeline_stage_runs SET canonical_run_id='finlab-B', lease_owner='finlab-B:post-verify:other'`) } })
  await adopted.deliver()
  assert.deepEqual(adopted.calls, ['ack'])
  closed.sql.close(); adopted.sql.close()
})
