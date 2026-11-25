import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { markPipelineStageFenced } from './pipelineStageLease'
import {
  failStrategyLearningRun,
  propagateStrategyLearningFailureAfterWaiting,
  propagateStrategyLearningTerminalFailure,
} from './strategyLearningRunState'
import { seedDefaultStrategySpecRegistry } from './strategyLearning'
import { processUpdateBatch } from './updateOrchestrator'

const date = '2026-11-17', run = 'run-A'
const opsSchema = fs.readFileSync('domain-schemas/ops.sql', 'utf8')
const learningSchema = fs.readFileSync('domain-schemas/learning.sql', 'utf8')

function d1(sqlite: DatabaseSync, hook: (sql: string) => void = () => {}) {
  const statement = (sql: string, args: any[] = []) => {
    const st = {
      bind(...values: any[]) { return statement(sql, values) },
      async first() { hook(sql); return sqlite.prepare(sql).get(...args) ?? null },
      async all() { hook(sql); return { results: sqlite.prepare(sql).all(...args), success: true, meta: {} } },
      async run() { hook(sql); return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } } },
      async raw() { hook(sql); return sqlite.prepare(sql).all(...args).map((row: any) => Object.values(row)) },
    }
    return st
  }
  return {
    prepare: (sql: string) => statement(sql),
    async batch(list: any[]) { const out = []; for (const item of list) out.push(await item.run()); return out },
    async exec(sql: string) { hook(sql); sqlite.exec(sql); return { count: 1, duration: 0 } },
  } as any
}

function opsFixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(opsSchema)
  sqlite.prepare(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,lease_owner,lease_expires_at)
    VALUES(?,'post_verify_chain',?,'running','pv-lease',datetime('now','+900 seconds'))`).run(date, run)
  sqlite.prepare(`INSERT INTO strategy_learning_runs(business_date,canonical_run_id,producer_run_id,status,cursor_symbol,
      expected_candidates,processed_candidates,strategy_count,expected_decision_rows,persisted_decision_rows,lease_owner,lease_expires_at)
    VALUES(?,?,'producer-A','running','1101',10,4,1,10,4,'sl-lease',datetime('now','+900 seconds'))`).run(date, run)
  return { sqlite, db: d1(sqlite) }
}

const postVerify = (sqlite: DatabaseSync) => sqlite.prepare(
  `SELECT status,last_error,lease_owner FROM pipeline_stage_runs WHERE stage='post_verify_chain'`,
).get() as { status: string; last_error: string | null; lease_owner: string | null }

test('learning error while post-verify holds its lease: post-verify ends error, not waiting', async () => {
  const f = opsFixture()
  assert.equal(await failStrategyLearningRun(f.db, {
    businessDate: date, canonicalRunId: run, leaseOwner: 'sl-lease', error: 'D1_ERROR: D1 DB is overloaded',
  }), true)
  // The materialize consumer's propagation lands while post-verify is still running with a lease (11/17, 11/18).
  await propagateStrategyLearningTerminalFailure(f.db, { businessDate: date, canonicalRunId: run })
  assert.equal(postVerify(f.sqlite).status, 'running')
  assert.equal(await markPipelineStageFenced(f.db, {
    businessDate: date, stage: 'post_verify_chain', canonicalRunId: run, leaseOwner: 'pv-lease', status: 'waiting',
  }), true)
  const closed = await propagateStrategyLearningFailureAfterWaiting(f.db, { businessDate: date, canonicalRunId: run })
  assert.equal(closed, 'D1_ERROR: D1 DB is overloaded')
  assert.deepEqual({ ...postVerify(f.sqlite) }, { status: 'error', last_error: 'D1_ERROR: D1 DB is overloaded', lease_owner: null })
  f.sqlite.close()
})

test('learning error after post-verify waits: the consumer propagation closes it and the waiting check is a no-op', async () => {
  const f = opsFixture()
  await markPipelineStageFenced(f.db, {
    businessDate: date, stage: 'post_verify_chain', canonicalRunId: run, leaseOwner: 'pv-lease', status: 'waiting',
  })
  assert.equal(await propagateStrategyLearningFailureAfterWaiting(f.db, { businessDate: date, canonicalRunId: run }), null)
  assert.equal(postVerify(f.sqlite).status, 'waiting')
  await failStrategyLearningRun(f.db, { businessDate: date, canonicalRunId: run, leaseOwner: 'sl-lease', error: 'boom' })
  await propagateStrategyLearningTerminalFailure(f.db, { businessDate: date, canonicalRunId: run })
  assert.equal(postVerify(f.sqlite).status, 'error')
  f.sqlite.close()
})

test('a learning error of another canonical run does not close this post-verify', async () => {
  const f = opsFixture()
  f.sqlite.prepare(`UPDATE strategy_learning_runs SET status='error',canonical_run_id='run-old',lease_owner=NULL,lease_expires_at=NULL`).run()
  await markPipelineStageFenced(f.db, {
    businessDate: date, stage: 'post_verify_chain', canonicalRunId: run, leaseOwner: 'pv-lease', status: 'waiting',
  })
  assert.equal(await propagateStrategyLearningFailureAfterWaiting(f.db, { businessDate: date, canonicalRunId: run }), null)
  assert.equal(postVerify(f.sqlite).status, 'waiting')
  f.sqlite.close()
})

test('the post-verify handler checks the learning run right after its waiting write, before root telemetry', () => {
  const source = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
  const handler = source.slice(source.indexOf("if (msg.type === 'post_verify_chain') {"), source.indexOf("if (msg.type === 'strategy_learning_materialize') {"))
  const finalize = handler.indexOf("await heartbeat.assertActive('post-verify:before_finalize')")
  const check = handler.indexOf('propagateStrategyLearningFailureAfterWaiting(', finalize)
  const guard = handler.slice(finalize, check)
  // Exactly the waiting outcome, closed by the helper's result (not a dead or inverted branch).
  assert.match(guard, /\n\s*if \(status === 'waiting'\) \{\n[^\n]*\n\s*const \{ propagateStrategyLearningFailureAfterWaiting \} = await import\('\.\/strategyLearningRunState'\)\n\s*const learningError = await $/)
  assert.match(handler.slice(check), /^propagateStrategyLearningFailureAfterWaiting\(databaseForDataDomain\(env, 'ops'\), \{\n\s*businessDate: triggerTime, canonicalRunId: runId,\n\s*\}, env\.KV, \{ postVerifyEntryWrittenByCaller: true \}\)\n\s*if \(learningError\) \{[\s\S]*?\n\s*return\n/)
  const telemetry = handler.indexOf("logSchedulerResult(env.KV, 'evening-chain'", finalize)
  assert.ok(finalize > 0 && check > finalize && check < telemetry)
})

async function materializeFixture() {
  const ops = new DatabaseSync(':memory:'), learning = new DatabaseSync(':memory:'), core = new DatabaseSync(':memory:')
  ops.exec(opsSchema)
  learning.exec(learningSchema)
  ops.prepare(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status) VALUES(?,'post_verify_chain',?,'waiting')`).run(date, run)
  ops.prepare(`INSERT INTO canonical_run_heads(logical_run_key,run_id,promoted_at) VALUES(?, 'producer-A', CURRENT_TIMESTAMP)`)
    .run(`screener:${date}:TW:production:market_screener`)
  ops.prepare(`INSERT INTO strategy_learning_runs(business_date,canonical_run_id,producer_run_id,status,cursor_symbol,
      expected_candidates,processed_candidates,strategy_count,expected_decision_rows,persisted_decision_rows)
    VALUES(?,?,'producer-A','queued','1101',1,0,0,0,0)`).run(date, run)
  // Only what the universe count reads: the page read is the overloaded query (or, without the
  // overload, fails deterministically on its missing columns).
  learning.exec(`DROP TABLE selection_reference_snapshots_v1;
    CREATE TABLE selection_reference_snapshots_v1(signal_date TEXT, symbol TEXT, producer_run_id TEXT,
      hard_gate_passed INTEGER, strategy_labeled INTEGER, strategy_matrix_status TEXT)`)
  learning.prepare(`INSERT INTO selection_reference_snapshots_v1 VALUES(?,'2330','producer-A',1,1,'ready')`).run(date)
  let overloaded = false
  const control = { overload: true }
  const opsDb = d1(ops, (sql) => { if (control.overload && /SET status='running', lease_owner=\?/.test(sql)) overloaded = true })
  const learningDb = d1(learning, (sql) => {
    if (overloaded && /selection_reference_snapshots_v1/.test(sql) && !/COUNT\(\*\)/.test(sql)) {
      overloaded = false
      throw new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.')
    }
  })
  await seedDefaultStrategySpecRegistry(learningDb)
  const kvValues = new Map<string, string>()
  const sent: { message: any; options: any }[] = []
  const env = {
    DB: d1(core), OPS_DB: opsDb, LEARNING_DB: learningDb, MULTI_D1_ACTIVE_DOMAINS: 'ops,learning',
    KV: {
      get: async (key: string, type?: unknown) => {
        const value = kvValues.get(key) ?? null
        return value != null && type === 'json' ? JSON.parse(value) : value
      },
      put: async (key: string, value: string) => { kvValues.set(key, value) },
      delete: async (key: string) => { kvValues.delete(key) },
      list: async () => ({ keys: [], list_complete: true }),
    },
    UPDATE_QUEUE: { send: async (message: any, options?: any) => { sent.push({ message, options }) } },
  } as any
  const message = () => ({
    type: 'strategy_learning_materialize', cursor: 0, cursorKey: '1101', triggerTime: date, runId: run, leaseRetryAttempt: 0,
  }) as any
  return { ops, learning, core, env, sent, kvValues, message, control }
}

test('D1 overload on a materialize page is released and requeued with backoff, then terminal after the cap', async () => {
  const f = await materializeFixture()
  const oldNow = Date.now
  // Inside the watchdog lookback (the next TW day), so the terminal failure is acknowledged, not redelivered.
  Date.now = () => Date.parse(`${date}T12:00:00Z`)
  try {
    const delays: number[] = []
    for (let retry = 1; retry <= 6; retry += 1) {
      await processUpdateBatch(f.message(), f.env, {} as any)
      const row = f.ops.prepare(`SELECT status,cursor_symbol,lease_owner,processed_candidates,last_error FROM strategy_learning_runs`).get() as any
      assert.equal(row.status, 'queued')
      assert.equal(row.cursor_symbol, '1101')
      assert.equal(row.lease_owner, null)
      assert.equal(row.processed_candidates, 0)
      assert.match(row.last_error, new RegExp(`^strategy_learning_materialize_transient_retry:${retry}/6:at=\\d+:D1_ERROR: D1 DB is overloaded`))
      assert.equal(f.kvValues.get(`strategy-learning:materialize-transient-retries:${date}:${run}`), String(retry))
      assert.equal(f.sent.length, retry)
      assert.equal(f.sent[retry - 1].message.cursorKey, '1101')
      delays.push(f.sent[retry - 1].options.delaySeconds)
      assert.equal((f.ops.prepare(`SELECT status FROM pipeline_stage_runs WHERE stage='post_verify_chain'`).get() as any).status, 'waiting')
    }
    assert.deepEqual(delays, [60, 1200, 2400, 4800, 9600, 9600])
    await processUpdateBatch(f.message(), f.env, {} as any)
    const failed = f.ops.prepare(`SELECT status,last_error FROM strategy_learning_runs`).get() as any
    assert.equal(failed.status, 'error')
    assert.match(failed.last_error, /^strategy_learning_materialize_transient_exhausted:retries=6:D1_ERROR: D1 DB is overloaded/)
    assert.equal(f.sent.length, 6, 'no requeue after the cap')
    assert.equal((f.ops.prepare(`SELECT status FROM pipeline_stage_runs WHERE stage='post_verify_chain'`).get() as any).status, 'error')
  } finally {
    Date.now = oldNow
    f.ops.close(); f.learning.close(); f.core.close()
  }
})

test('a non-transient materialize error stays terminal on the first failure', async () => {
  const f = await materializeFixture()
  f.control.overload = false
  const oldNow = Date.now
  Date.now = () => Date.parse(`${date}T12:00:00Z`)
  try {
    await processUpdateBatch(f.message(), f.env, {} as any)
    const row = f.ops.prepare(`SELECT status,last_error FROM strategy_learning_runs`).get() as any
    assert.equal(row.status, 'error')
    assert.doesNotMatch(row.last_error, /transient/)
    assert.equal(f.sent.length, 0)
  } finally {
    Date.now = oldNow
    f.ops.close(); f.learning.close(); f.core.close()
  }
})

function memoryKv(seed: Record<string, unknown> = {}) {
  const values = new Map<string, string>(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]))
  return {
    values,
    kv: {
      get: async (key: string, type?: string) => { const value = values.get(key) ?? null; return value != null && type === 'json' ? JSON.parse(value) : value },
      put: async (key: string, value: string) => { values.set(key, value) },
      delete: async (key: string) => { values.delete(key) },
      list: async () => ({ keys: [], list_complete: true }),
    } as any,
  }
}

test('terminal failure propagation also settles the post-verify-chain scheduler entry as error', async () => {
  const f = opsFixture()
  const key = `scheduler:run:post-verify-chain:${date}`
  const { values, kv } = memoryKv({ [key]: { task: 'post-verify-chain', status: 'running', run_id: run, run_date: date, attempt_id: 'pv-attempt',
    summary: 'waiting for queued strategy-learning: strategy-learning:triggered' } })
  await markPipelineStageFenced(f.db, {
    businessDate: date, stage: 'post_verify_chain', canonicalRunId: run, leaseOwner: 'pv-lease', status: 'waiting',
  })
  await failStrategyLearningRun(f.db, { businessDate: date, canonicalRunId: run, leaseOwner: 'sl-lease', error: 'strategy_learning_live_policy_closure_missing:x' })
  await propagateStrategyLearningTerminalFailure(f.db, { businessDate: date, canonicalRunId: run }, kv)
  assert.equal(postVerify(f.sqlite).status, 'error')
  const entry = JSON.parse(values.get(key) ?? 'null')
  assert.equal(entry.status, 'error')
  assert.equal(entry.run_id, run)
  assert.equal(entry.error, 'strategy_learning_live_policy_closure_missing:x')
  assert.match(entry.summary, /^status=failed post-verify-chain closed by strategy-learning terminal failure/)
  f.sqlite.close()
})

test('a no-op propagation (post-verify still leased) leaves the post-verify-chain scheduler entry alone', async () => {
  const f = opsFixture()
  const key = `scheduler:run:post-verify-chain:${date}`
  const running = { task: 'post-verify-chain', status: 'running', run_id: run, run_date: date }
  const { values, kv } = memoryKv({ [key]: running })
  await failStrategyLearningRun(f.db, { businessDate: date, canonicalRunId: run, leaseOwner: 'sl-lease', error: 'boom' })
  await propagateStrategyLearningTerminalFailure(f.db, { businessDate: date, canonicalRunId: run }, kv)
  assert.equal(postVerify(f.sqlite).status, 'running')
  assert.deepEqual(JSON.parse(values.get(key) ?? 'null'), running)
  f.sqlite.close()
})

test('a KV outage while settling the post-verify-chain entry does not mask the propagated failure', async () => {
  const f = opsFixture()
  await markPipelineStageFenced(f.db, {
    businessDate: date, stage: 'post_verify_chain', canonicalRunId: run, leaseOwner: 'pv-lease', status: 'waiting',
  })
  await failStrategyLearningRun(f.db, { businessDate: date, canonicalRunId: run, leaseOwner: 'sl-lease', error: 'boom' })
  const { kv } = memoryKv()
  kv.put = async () => { throw new Error('KV PUT failed: 429 Too Many Requests') }
  await propagateStrategyLearningTerminalFailure(f.db, { businessDate: date, canonicalRunId: run }, kv)
  assert.equal(postVerify(f.sqlite).status, 'error')
  f.sqlite.close()
})

test('a caller that writes its own post-verify-chain entry is not double-written (one KV write per key per second)', async () => {
  const f = opsFixture()
  await markPipelineStageFenced(f.db, {
    businessDate: date, stage: 'post_verify_chain', canonicalRunId: run, leaseOwner: 'pv-lease', status: 'waiting',
  })
  await failStrategyLearningRun(f.db, { businessDate: date, canonicalRunId: run, leaseOwner: 'sl-lease', error: 'boom' })
  const { values, kv } = memoryKv()
  await propagateStrategyLearningTerminalFailure(f.db, { businessDate: date, canonicalRunId: run }, kv, { postVerifyEntryWrittenByCaller: true })
  assert.equal(postVerify(f.sqlite).status, 'error')
  assert.equal(values.has(`scheduler:run:post-verify-chain:${date}`), false)
  f.sqlite.close()
})
