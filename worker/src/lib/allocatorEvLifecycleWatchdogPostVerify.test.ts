import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { runAllocatorEvLifecycleWatchdog } from './allocatorEvDailyLifecycle'
import { enqueueS12ReplayBackfillTask } from './postMarketChain'
import { classifySchedulerRunSummary } from './schedulerRunLogger'

const date = '2026-10-16', run = 'canonical-A'

function fixture(postVerify?: { status: string; leaseExpiresAt?: string; lastError?: string }) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE allocator_ev_daily_lifecycle(business_date TEXT PRIMARY KEY,state TEXT,native_lineage_rows INTEGER,
      snapshot_run_id TEXT,snapshot_rows INTEGER,replay_rows INTEGER,replay_maturity_as_of_date TEXT,upstream_run_id TEXT,
      attempt_count INTEGER DEFAULT 0,last_error TEXT,created_at TEXT,updated_at TEXT,closed_at TEXT);
    CREATE TABLE pipeline_stage_runs(business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,
      lease_owner TEXT,lease_expires_at TEXT,cursor_key TEXT,processed_count INTEGER DEFAULT 0,expected_count INTEGER,
      persisted_count INTEGER DEFAULT 0,attempt_count INTEGER DEFAULT 0,queued_at TEXT,started_at TEXT,completed_at TEXT,
      last_error TEXT,updated_at TEXT,PRIMARY KEY(business_date,stage));
    CREATE TABLE strategy_learning_runs(business_date TEXT,canonical_run_id TEXT,status TEXT,lease_owner TEXT,lease_expires_at TEXT,last_error TEXT);`)
  sqlite.exec(readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8'))
  sqlite.prepare(`INSERT INTO allocator_ev_daily_lifecycle(business_date,state,upstream_run_id,attempt_count,updated_at)
    VALUES(?,'verify_triggered',?,1,'2026-10-16 10:00:00')`).run(date, run)
  sqlite.prepare(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,cursor_key)
    VALUES(?,'verify_v2',?,'success','verify-cursor')`).run(date, run)
  if (postVerify) sqlite.prepare(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,lease_owner,
      lease_expires_at,attempt_count,last_error) VALUES(?,'post_verify_chain',?,?,'lease-A',?,3,?)`)
    .run(date, run, postVerify.status, postVerify.leaseExpiresAt ?? null, postVerify.lastError ?? null)
  const db = { prepare(sql: string) {
    let args: any[] = []
    const statement = { bind(...values: any[]) { args = values; return statement },
      async first() { return sqlite.prepare(sql).get(...args) ?? null },
      async all() { return { results: sqlite.prepare(sql).all(...args), success: true } },
      async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } } } }
    return statement
  } }
  const enqueued: any[] = []
  const kv = new Map<string, string>()
  const KV = { get: async (key: string, type?: string) => { const value = kv.get(key) ?? null; return value != null && type === 'json' ? JSON.parse(value) : value },
    put: async (key: string, value: string) => { kv.set(key, value) } }
  const env = { DB: db, KV, UPDATE_QUEUE: { send: async (value: any) => { enqueued.push(value) } } } as any
  return { sqlite, env, enqueued, kv }
}

test('watchdog fails a tick whose previous post-verify dispatch ended in error, while still redispatching', async () => {
  const f = fixture({ status: 'error', lastError: 'post_verify_checkpoint_unsettled_side_effect:price-horizon-projection' })
  const summary = await runAllocatorEvLifecycleWatchdog(f.env, date)
  assert.match(summary, /^status=failed allocator EV lifecycle post-verify dispatch incomplete/)
  assert.match(summary, /previous_status=error previous_attempts=3 previous_error=post_verify_checkpoint_unsettled_side_effect:price-horizon-projection/)
  assert.match(summary, /recovery_dispatch=post_verify_queued/)
  assert.equal(classifySchedulerRunSummary(summary), 'error')
  assert.equal(f.enqueued.length, 1)
  f.sqlite.close()
})

test('watchdog fails a tick whose previous post-verify dispatch lost its lease', async () => {
  const f = fixture({ status: 'running', leaseExpiresAt: '2000-01-01 00:00:00', lastError: 'status=success masked' })
  const summary = await runAllocatorEvLifecycleWatchdog(f.env, date)
  assert.match(summary, /previous_status=running/)
  assert.equal(classifySchedulerRunSummary(summary), 'error')
  f.sqlite.close()
})

test('watchdog first dispatch and a live in-flight dispatch are not failures', async () => {
  const first = fixture()
  const queued = await runAllocatorEvLifecycleWatchdog(first.env, date)
  assert.match(queued, /^status=success allocator EV lifecycle recovery_dispatch=post_verify_queued/)
  assert.equal(first.enqueued.length, 1)
  first.sqlite.close()
  const live = fixture({ status: 'running', leaseExpiresAt: '2099-01-01 00:00:00' })
  const observed = await runAllocatorEvLifecycleWatchdog(live.env, date)
  assert.match(observed, /^status=success allocator EV lifecycle recovery_observation=post_verify_current/)
  assert.equal(live.enqueued.length, 0)
  live.sqlite.close()
})

test('watchdog stops redispatching a failed post-verify after six redispatches', async () => {
  const f = fixture({ status: 'error', lastError: 'D1_ERROR: D1 DB is overloaded' })
  const fail = f.sqlite.prepare(`UPDATE pipeline_stage_runs SET status='error',attempt_count=0 WHERE stage='post_verify_chain'`)
  for (let tick = 1; tick <= 6; tick += 1) {
    assert.match(await runAllocatorEvLifecycleWatchdog(f.env, date), /recovery_dispatch=post_verify_queued/)
    fail.run()
  }
  const exhausted = await runAllocatorEvLifecycleWatchdog(f.env, date)
  assert.match(exhausted, /^status=failed allocator EV lifecycle post-verify redispatch exhausted .*redispatches=6 .*manual_redispatch_required/)
  assert.equal(classifySchedulerRunSummary(exhausted), 'error')
  assert.equal(f.enqueued.length, 6)
  f.sqlite.close()
})

const lifecycleState = (sqlite: DatabaseSync) => sqlite.prepare(
  'SELECT state, closed_at FROM allocator_ev_daily_lifecycle WHERE business_date=?',
).get(date) as { state: string; closed_at: string | null }

test('PV1105: watchdog never re-queues a waiting, successful or queued post-verify of the lifecycle run', async () => {
  for (const status of ['waiting', 'success', 'queued']) {
    const f = fixture({ status })
    const summary = await runAllocatorEvLifecycleWatchdog(f.env, date)
    assert.equal(summary, `status=success allocator EV lifecycle recovery_observation=post_verify_current date=${date} downstream_status=${status}`)
    assert.equal(classifySchedulerRunSummary(summary), 'success')
    assert.equal(f.enqueued.length, 0, status)
    assert.equal(f.kv.size, 0, 'an observation is not counted against the redispatch cap')
    const stage = f.sqlite.prepare(`SELECT status, attempt_count FROM pipeline_stage_runs WHERE stage='post_verify_chain'`).get() as any
    assert.deepEqual({ ...stage }, { status, attempt_count: 3 })
    assert.equal(lifecycleState(f.sqlite).state, 'verify_triggered')
    f.sqlite.close()
  }
})

test('PV1105: with the S12 replay retired a successful post-verify closes the lifecycle instead of re-queueing it', async () => {
  const f = fixture({ status: 'success' })
  f.kv.set('trading:config', JSON.stringify({ l4Distribution: { scope: 'paper' } }))
  const summary = await runAllocatorEvLifecycleWatchdog(f.env, date)
  assert.match(summary, /^status=success allocator EV lifecycle replay_not_applicable=retired_fusion_maturity_backfill_new_l4_active .*lifecycle=replay_complete$/)
  assert.equal(f.enqueued.length, 0)
  const lifecycle = lifecycleState(f.sqlite)
  assert.equal(lifecycle.state, 'replay_complete')
  assert.ok(lifecycle.closed_at)
  f.sqlite.close()
})

test('PV1105: a waiting post-verify is left alone even with the S12 replay retired', async () => {
  const f = fixture({ status: 'waiting' })
  f.kv.set('trading:config', JSON.stringify({ l4Distribution: { scope: 'paper' } }))
  assert.match(await runAllocatorEvLifecycleWatchdog(f.env, date), /recovery_observation=post_verify_current .*downstream_status=waiting/)
  assert.equal(lifecycleState(f.sqlite).state, 'verify_triggered')
  assert.equal(f.enqueued.length, 0)
  f.sqlite.close()
})

test('PV1105: the post-verify s12 task under the new L4 closes the lifecycle under its stage lease', async () => {
  const f = fixture({ status: 'running', leaseExpiresAt: '2099-01-01 00:00:00' })
  f.kv.set('trading:config', JSON.stringify({ l4Distribution: { scope: 'paper' } }))
  const ctx = { runDate: date, upstreamRunId: run, stageLeaseOwner: 'lease-A' }
  assert.equal(await enqueueS12ReplayBackfillTask(f.env, ctx),
    'skipped retired_fusion_maturity_backfill_new_l4_active lifecycle=replay_complete')
  assert.equal(lifecycleState(f.sqlite).state, 'replay_complete')
  assert.equal(f.enqueued.length, 0)
  f.sqlite.close()

  const lost = fixture({ status: 'running', leaseExpiresAt: '2099-01-01 00:00:00' })
  lost.kv.set('trading:config', JSON.stringify({ l4Distribution: { scope: 'paper' } }))
  await assert.rejects(enqueueS12ReplayBackfillTask(lost.env, { ...ctx, stageLeaseOwner: 'lease-B' }),
    new RegExp(`stale_post_verify_lifecycle:${date}:${run}`))
  assert.equal(lifecycleState(lost.sqlite).state, 'verify_triggered')
  lost.sqlite.close()
})

const failLearning = (sqlite: DatabaseSync, canonical = run) => sqlite.prepare(
  `INSERT INTO strategy_learning_runs(business_date,canonical_run_id,status,last_error) VALUES(?,?,'error','D1_ERROR: D1 DB is overloaded')`,
).run(date, canonical)
const postVerifyStatus = (sqlite: DatabaseSync) => (sqlite.prepare(
  `SELECT status FROM pipeline_stage_runs WHERE stage='post_verify_chain'`).get() as { status: string }).status

test('PV1105: a waiting post-verify whose learning run failed is closed as error, not re-queued', async () => {
  const f = fixture({ status: 'waiting' })
  f.sqlite.prepare(`UPDATE pipeline_stage_runs SET lease_owner=NULL WHERE stage='post_verify_chain'`).run()
  failLearning(f.sqlite)
  const summary = await runAllocatorEvLifecycleWatchdog(f.env, date)
  assert.match(summary, /^status=failed allocator EV lifecycle post-verify closed by failed strategy-learning .*learning_error=D1_ERROR:_D1_DB_is_overloaded recovery_dispatch=not_queued$/)
  assert.equal(postVerifyStatus(f.sqlite), 'error')
  assert.equal(f.enqueued.length, 0)
  f.sqlite.close()
})

test('PV1105: a post-verify waiting for a day is reported red without re-queueing', async () => {
  const f = fixture({ status: 'waiting' })
  f.sqlite.prepare(`UPDATE pipeline_stage_runs SET lease_owner=NULL, updated_at=datetime('now','-25 hours') WHERE stage='post_verify_chain'`).run()
  failLearning(f.sqlite, 'run-other')
  const summary = await runAllocatorEvLifecycleWatchdog(f.env, date)
  assert.match(summary, /^status=failed allocator EV lifecycle post-verify waiting_stale .*recovery_dispatch=not_queued/)
  assert.equal(classifySchedulerRunSummary(summary), 'error')
  assert.equal(postVerifyStatus(f.sqlite), 'waiting')
  assert.equal(f.enqueued.length, 0)
  f.sqlite.close()
})

test('PV1105: a post-verify failed by a terminal learning run is not re-run; the retired replay closes the lifecycle', async () => {
  const f = fixture({ status: 'error', lastError: 'D1_ERROR: D1 DB is overloaded' })
  failLearning(f.sqlite)
  const kept = await runAllocatorEvLifecycleWatchdog(f.env, date)
  assert.match(kept, /^status=failed allocator EV lifecycle post-verify blocked by terminal strategy-learning .*lifecycle=unchanged$/)
  assert.equal(f.enqueued.length, 0)
  assert.equal(f.kv.size, 0)
  f.kv.set('trading:config', JSON.stringify({ l4Distribution: { scope: 'paper' } }))
  assert.match(await runAllocatorEvLifecycleWatchdog(f.env, date), /lifecycle=replay_complete$/)
  assert.equal(lifecycleState(f.sqlite).state, 'replay_complete')
  assert.equal(f.enqueued.length, 0)
  f.sqlite.close()
})

test('PV1105: a failed lifecycle write defers the close instead of failing the post-verify task', async () => {
  const f = fixture({ status: 'running', leaseExpiresAt: '2099-01-01 00:00:00' })
  f.kv.set('trading:config', JSON.stringify({ l4Distribution: { scope: 'paper' } }))
  f.sqlite.exec('DROP TABLE allocator_ev_daily_lifecycle')
  assert.equal(await enqueueS12ReplayBackfillTask(f.env, { runDate: date, upstreamRunId: run, stageLeaseOwner: 'lease-A' }),
    'skipped retired_fusion_maturity_backfill_new_l4_active lifecycle=deferred')
  f.sqlite.close()
})
