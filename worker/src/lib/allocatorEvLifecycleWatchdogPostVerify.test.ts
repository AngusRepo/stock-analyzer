import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { runAllocatorEvLifecycleWatchdog } from './allocatorEvDailyLifecycle'
import { classifySchedulerRunSummary } from './schedulerRunLogger'

const date = '2026-10-16', run = 'canonical-A'

function fixture(postVerify?: { status: string; leaseExpiresAt?: string; lastError?: string }) {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`CREATE TABLE allocator_ev_daily_lifecycle(business_date TEXT PRIMARY KEY,state TEXT,native_lineage_rows INTEGER,
      snapshot_run_id TEXT,snapshot_rows INTEGER,replay_rows INTEGER,replay_maturity_as_of_date TEXT,upstream_run_id TEXT,
      attempt_count INTEGER DEFAULT 0,last_error TEXT,updated_at TEXT);
    CREATE TABLE pipeline_stage_runs(business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,
      lease_owner TEXT,lease_expires_at TEXT,cursor_key TEXT,processed_count INTEGER DEFAULT 0,expected_count INTEGER,
      persisted_count INTEGER DEFAULT 0,attempt_count INTEGER DEFAULT 0,queued_at TEXT,started_at TEXT,completed_at TEXT,
      last_error TEXT,updated_at TEXT,PRIMARY KEY(business_date,stage));
    CREATE TABLE strategy_learning_runs(business_date TEXT,canonical_run_id TEXT,status TEXT,lease_owner TEXT,lease_expires_at TEXT);`)
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
  const env = { DB: db, UPDATE_QUEUE: { send: async (value: any) => { enqueued.push(value) } } } as any
  return { sqlite, env, enqueued }
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
