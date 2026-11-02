import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { getSchedulerStatus, inferShortRunConcern, resolveSchedulerLogStatus } from './schedulerStatus'
import type { CronLogEntry } from './schedulerRunLogger'

// FG-10: should-have-run work must not read as a neutral no-op, and the 7d strip,
// SLO and 24h failure count must see stuck and replay-date failures.
const today = '2026-11-02'
const nowMs = Date.parse('2026-11-02T08:00:00Z')
const ago = (minutes: number) => new Date(nowMs - minutes * 60_000).toISOString()

function fixture() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE pipeline_stage_runs (
    business_date TEXT,stage TEXT,canonical_run_id TEXT,status TEXT,cursor_key TEXT,
    processed_count INTEGER DEFAULT 0,persisted_count INTEGER DEFAULT 0,expected_count INTEGER,
    attempt_count INTEGER DEFAULT 0,queued_at TEXT,started_at TEXT,completed_at TEXT,
    lease_owner TEXT,lease_expires_at TEXT,last_error TEXT,updated_at TEXT,
    PRIMARY KEY(business_date,stage))`)
  sql.exec(fs.readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8'))
  const statement = (query: string, args: any[] = []): any => ({
    bind: (...values: any[]) => statement(query, values),
    all: async () => ({ success: true, results: sql.prepare(query).all(...args) }),
    first: async () => sql.prepare(query).get(...args) ?? null,
    run: async () => ({ success: true, meta: { changes: Number(sql.prepare(query).run(...args).changes) } }),
  })
  const db = { prepare: statement }
  const values = new Map<string, any>()
  const kv = {
    get: async (key: string, type?: string) => values.has(key)
      ? type === 'json' ? values.get(key) : JSON.stringify(values.get(key)) : null,
    put: async (key: string, value: string) => { values.set(key, JSON.parse(value)) },
  }
  const daily = (date: string, entries: Array<Partial<CronLogEntry> & { task: string; status: CronLogEntry['status'] }>) => {
    values.set(`scheduler:run:daily:${date}`, Object.fromEntries(entries.map((entry) => [entry.task, {
      summary: '', duration_ms: 1000, run_date: date, ...entry,
    }])))
  }
  return { sql, env: { DB: db, OPS_DB: db, KV: kv } as any, values, daily }
}

test('U1/U2: a live-canonical task skipped as historical replay is an attention skip with its reason', async () => {
  const f = fixture()
  try {
    f.daily('2026-10-30', [
      { task: 'evening-chain', status: 'success', timestamp: ago(30), run_scope: 'historical_replay' },
      { task: 'adapt', status: 'skipped', duration_ms: 0, timestamp: ago(90), run_scope: 'historical_replay',
        summary: 'skipped non-production-authoritative callback run_date=2026-10-30; adapt is live-canonical only' },
      { task: 'rescore-10', status: 'skipped', timestamp: ago(300), summary: 'No open positions' },
    ])
    const result = await getSchedulerStatus(f.env, today, nowMs)
    const adapt = result.jobs.find((job) => job.id === 'adapt')!
    assert.equal(adapt.lastStatus, 'skip')
    assert.equal(adapt.statusScope, 'historical_replay')
    assert.equal(adapt.statusRunDate, '2026-10-30')
    assert.match(adapt.summary, /adapt is live-canonical only/, 'the reason stays in the summary')
    assert.match(String(adapt.attentionReason), /live-canonical.*2026-10-30/)
    assert.equal(adapt.history7d.at(-4), 'attention', '10/30 cell must not be a neutral skip')
    assert.equal(adapt.rate7d, '0/1', 'a should-have-run skip counts against the SLO')
    const rescore = result.jobs.find((job) => job.id === 'rescore-10')!
    assert.equal(rescore.attentionReason, null, 'a legitimate no-op stays a plain skip')
  } finally { f.sql.close() }
})

test('U3: strategy-learning-watchdog recoverable_run_missing never reads as a success', async () => {
  const f = fixture()
  try {
    f.daily(today, [{
      task: 'strategy-learning-watchdog', status: 'success', duration_ms: 0, timestamp: ago(20),
      run_scope: 'historical_replay', summary: 'SKIPPED strategy-learning recovery recoverable_run_missing',
    }])
    const result = await getSchedulerStatus(f.env, today, nowMs)
    const job = result.jobs.find((row) => row.id === 'strategy-learning-watchdog')!
    assert.notEqual(job.lastStatus, 'success')
    assert.equal(job.lastStatus, 'skip')
    assert.match(String(job.attentionReason), /no strategy-learning run/)
    assert.equal(job.history7d.at(-1), 'attention')
    assert.equal(resolveSchedulerLogStatus({
      task: 'strategy-learning-watchdog', status: 'success', duration_ms: 0, timestamp: ago(1),
      summary: 'success strategy-learning recovery date=2026-10-30 reason=run_success root=closed_success',
    }, { id: 'strategy-learning-watchdog', group: 'pipeline_chain' }, nowMs).status, 'success')
  } finally { f.sql.close() }
})

test('U5/U6/U7/U9/U16: the strip keeps in-flight, blocked, stuck and missing work distinct and counted', async () => {
  const f = fixture()
  try {
    f.daily('2026-10-27', [
      { task: 'evening-chain', status: 'running', timestamp: '2026-10-27T23:34:40Z', summary: 'pipeline serving published' },
    ])
    f.daily('2026-10-28', [
      { task: 'evening-chain', status: 'error', timestamp: '2026-10-29T17:54:00Z', error: 'post verify failed' },
      { task: 'update', status: 'blocked', timestamp: '2026-10-28T14:00:00Z', summary: 'blocked by FinLab' },
      { task: 'verify-v2', status: 'success', timestamp: '2026-10-29T06:20:00Z' },
    ])
    f.daily('2026-10-29', [
      { task: 'evening-chain', status: 'error', timestamp: ago(22 * 60), error: 'post_verify_checkpoint_timeout_unsettled' },
      { task: 'post-verify-chain', status: 'triggered', timestamp: ago(30), run_id: 'pv-1029', summary: 'triggered run_id=pv-1029' },
    ])
    f.daily('2026-10-30', [
      { task: 'evening-chain', status: 'running', timestamp: ago(10), summary: 'root chain running' },
      { task: 'model-ic-rolling', status: 'triggered', timestamp: ago(5), summary: 'callback expected' },
    ])
    f.sql.prepare(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,attempt_count,last_error,updated_at)
      VALUES('2026-10-29','post_verify_chain','pv-1029','error',9,'post_verify_checkpoint_timeout_unsettled',?)`)
      .run(new Date(nowMs - 10 * 60_000).toISOString().replace('T', ' ').slice(0, 19))
    const result = await getSchedulerStatus(f.env, today, nowMs)
    const cells = (id: string) => {
      const job = result.jobs.find((row) => row.id === id)!
      return Object.fromEntries(result.dates.map((date, index) => [date, job.history7d[index]]))
    }
    const root = cells('evening-chain')
    assert.equal(root['2026-10-27'], 'failed', 'a stale running root is stuck, not a skip')
    assert.equal(root['2026-10-28'], 'failed')
    assert.equal(root['2026-10-30'], 'running')
    assert.equal(cells('update')['2026-10-28'], 'blocked')
    assert.equal(cells('model-ic-rolling')['2026-10-30'], 'triggered')
    assert.equal(cells('post-verify-chain')['2026-10-29'], 'failed', 'durable stage error outranks a stale KV triggered')
    assert.equal(cells('verify-v2')['2026-10-27'], 'missing', 'a chain step with no receipt on a stuck chain date did not run')
    assert.equal(cells('verify-v2')['2026-10-28'], 'success')
    assert.equal(cells('verify-v2')['2026-10-30'], 'none', 'an in-flight chain has not reached later steps yet')
    assert.equal(cells('weekly-audit')['2026-10-27'], 'none', 'no receipt for a non-chain job is not a failure')
    const rootJob = result.jobs.find((row) => row.id === 'evening-chain')!
    assert.equal(rootJob.rate7d, '0/3', 'stuck and failed roots count; in-flight does not')
    assert.ok(result.stats.successRate7d < 100, 'SLO cannot be 100% when nothing in the window succeeded cleanly')
    assert.equal(result.stats.failed24h, 2, 'replay-date failures within 24h and stuck roots count by run_date')
  } finally { f.sql.close() }
})

test('U15: a success receipt that describes a skipped no-op is a suspicious short run', () => {
  const def = { id: 'allocator-ev-lifecycle-watchdog', group: 'daily' as const, name: '', schedule: '', cron: '' }
  const concern = inferShortRunConcern(def, {
    task: def.id, status: 'success', duration_ms: 0, timestamp: ago(1),
    summary: 'SKIPPED recovery nothing to do run_id=abc',
  })
  assert.equal(concern.durationConcern, 'suspicious_short')
  assert.equal(inferShortRunConcern(def, {
    task: def.id, status: 'success', duration_ms: 300, timestamp: ago(1),
    summary: 'queue accepted run_id=abc',
  }).durationConcern, 'expected_short')
})

test('U3: the watchdog logs recoverable_run_missing as a skip, not a success', async () => {
  const { runStrategyLearningRecoveryWatchdog } = await import('./strategyLearningRecoveryWatchdog')
  const { twToday } = await import('./dateUtils')
  const values = new Map<string, any>()
  const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) }
  const kv = {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, JSON.parse(value)) },
  }
  const summary = await runStrategyLearningRecoveryWatchdog({ DB: db, OPS_DB: db, KV: kv } as any)
  assert.match(summary, /^SKIPPED strategy-learning recovery recoverable_run_missing/)
  const entry = values.get(`scheduler:run:strategy-learning-watchdog:${twToday()}`)
  assert.equal(entry.status, 'skipped')
})
