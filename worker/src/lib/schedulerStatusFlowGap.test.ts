import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { getSchedulerStatus, inferShortRunConcern, resolveSchedulerLogStatus } from './schedulerStatus'
import { buildEventsFromScheduler } from './observabilityEvents'
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
    assert.equal(cells('verify-v2')['2026-10-27'], 'none', 'a stuck root has not ended, so later steps are not judged missing')
    assert.equal(cells('verify-v2')['2026-10-29'], 'missing', 'a chain step with no receipt after the root errored did not run')
    assert.equal(cells('verify-v2')['2026-10-28'], 'success')
    assert.equal(cells('verify-v2')['2026-10-30'], 'none', 'an in-flight chain has not reached later steps yet')
    assert.equal(cells('weekly-audit')['2026-10-27'], 'none', 'no receipt for a non-chain job is not a failure')
    const rootJob = result.jobs.find((row) => row.id === 'evening-chain')!
    assert.equal(rootJob.rate7d, '0/3', 'stuck and failed roots count; in-flight does not')
    assert.ok(result.stats.successRate7d < 100, 'SLO cannot be 100% when nothing in the window succeeded cleanly')
    assert.equal(result.stats.failed24h, 2, 'replay-date failures within 24h and stuck roots count by run_date')
  } finally { f.sql.close() }
})

test('M1: a root waiting for the after-close dispatch is not stuck and does not mark later steps missing', async () => {
  const f = fixture()
  try {
    f.daily('2026-11-02', [
      { task: 'evening-chain', status: 'running', timestamp: '2026-11-02T15:30:00Z', run_id: 'r1102',
        summary: 'pipeline serving published; research waits for the after-close dispatch run_id=r1102' },
      { task: 'post-pipeline-chain', status: 'waiting', timestamp: '2026-11-02T15:30:00Z',
        summary: 'Serving published; research and verification wait for the after-close dispatch run_id=r1102' },
    ])
    const status = async (iso: string) => {
      const result = await getSchedulerStatus(f.env, iso.slice(0, 10), Date.parse(iso))
      const cell = (id: string) => result.jobs.find((row) => row.id === id)!.history7d[result.dates.indexOf('2026-11-02')]
      return { result, cell }
    }
    // Tue 11/03 10:00 TW: the 14:20 after-close dispatch has not come yet.
    const morning = await status('2026-11-03T02:00:00Z')
    assert.equal(morning.cell('evening-chain'), 'waiting')
    for (const id of ['verify-v2', 'post-verify-chain', 'strategy-learning']) {
      assert.equal(morning.cell(id), 'none', `${id} has not been reached yet`)
    }
    assert.equal(morning.result.stats.failed24h, 0)
    const root = morning.result.jobs.find((row) => row.id === 'evening-chain')!
    assert.equal(root.lastStatus, 'waiting', 'the root row is waiting for the after-close dispatch, not failed')
    const events = buildEventsFromScheduler({ generatedAt: '2026-11-03T02:00:00Z', jobs: morning.result.jobs as any })
    assert.ok(!events.some((event) => event.evidence.task_id === 'evening-chain' && event.severity === 'error'),
      'OBS does not report the after-close wait as an Evening Chain error')
    // Wed 11/04 10:00 TW: the 11/03 dispatch window plus SLA has passed with no progress.
    const late = await status('2026-11-04T02:00:00Z')
    assert.equal(late.cell('evening-chain'), 'failed', 'a wait that outlives the next dispatch window is stuck')
    assert.equal(late.result.stats.failed24h, 1)
    assert.equal(late.result.jobs.find((row) => row.id === 'evening-chain')!.lastStatus, 'failed')
  } finally { f.sql.close() }
})

test('M2: a stuck run counts toward failed24h only until a later run of the job succeeds', async () => {
  const f = fixture()
  try {
    f.daily('2026-10-28', [
      { task: 'daily-report', status: 'running', timestamp: '2026-10-28T10:00:00Z', summary: 'started (background) run_id=x' },
    ])
    const nowIso = '2026-11-03T02:00:00Z'
    const stuck = await getSchedulerStatus(f.env, '2026-11-03', Date.parse(nowIso))
    assert.equal(stuck.stats.failed24h, 1, 'nothing has replaced the stuck run yet')
    f.daily('2026-11-03', [
      { task: 'daily-report', status: 'success', timestamp: '2026-11-03T01:00:00Z', summary: 'ok' },
    ])
    const replaced = await getSchedulerStatus(f.env, '2026-11-03', Date.parse(nowIso))
    const job = replaced.jobs.find((row) => row.id === 'daily-report')!
    assert.equal(job.history7d[0], 'failed', 'the strip still shows the stuck run')
    assert.equal(replaced.stats.failed24h, 0)
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

test('flow-gap: a parked dispatch-wait root does not hide a watchdog that should have run', async () => {
  const f = fixture()
  try {
    // 10/30 root parked on the 11/02 14:20 dispatch (PR #128); Monday 11/02 has no watchdog receipts.
    f.daily('2026-10-30', [
      { task: 'evening-chain', status: 'running', timestamp: '2026-11-01T23:34:37Z', run_id: 'root', run_date: '2026-10-30',
        summary: 'pipeline serving published; research waits for the after-close dispatch at 2026-11-02 14:20 run_id=root',
        wait_until: '2026-11-02T14:20:00+08:00' } as any,
    ])
    const job = async (iso: string, id: string) => (await getSchedulerStatus(f.env, '2026-11-02', Date.parse(iso)))
      .jobs.find((row) => row.id === id)!
    // 13:00 TW, before the dispatch: the root waits, the evening watchdogs are not in window yet.
    assert.equal((await job('2026-11-02T05:00:00Z', 'evening-chain')).lastStatus, 'waiting')
    assert.equal((await job('2026-11-02T05:00:00Z', 'finlab-backfill-watchdog')).lastStatus, 'sleep')
    const premarket = await job('2026-11-02T05:00:00Z', 'premarket-evidence-watchdog')
    assert.equal(premarket.lastStatus, 'failed', 'the 07:00-08:50 watchdog left no receipt today')
    assert.match(String(premarket.lastError), /no 2026-11-02 receipt since its window opened at 07:00/)
    // 22:30 TW: the evening window opened 90m ago with no receipt.
    const finlab = await job('2026-11-02T14:30:00Z', 'finlab-backfill-watchdog')
    assert.equal(finlab.lastStatus, 'failed')
    assert.match(String(finlab.lastError), /window opened at 21:00/)
    f.daily('2026-11-02', [
      { task: 'finlab-backfill-watchdog', status: 'success', timestamp: '2026-11-02T14:20:00Z', summary: 'no orphaned pending calls' },
    ])
    const ran = await job('2026-11-02T14:30:00Z', 'finlab-backfill-watchdog')
    assert.equal(ran.lastStatus, 'success', `a watchdog that ran shows its run: ${ran.lastError} ${ran.summary}`)
    // A concurrent tick overwrote the daily aggregate; the canonical per-task key still proves the run.
    f.values.set('scheduler:run:screener-v2-watchdog:2026-11-02', { task: 'screener-v2-watchdog', status: 'skipped',
      summary: 'screener callback present', duration_ms: 800, timestamp: '2026-11-02T14:10:00Z', run_date: '2026-11-02' })
    const direct = await job('2026-11-02T14:30:00Z', 'screener-v2-watchdog')
    assert.equal(direct.lastStatus, 'skip', `the canonical key decides before a miss is declared: ${direct.lastError}`)
    assert.equal((await job('2026-11-02T14:30:00Z', 'indicator-queue-watchdog')).lastStatus, 'failed', 'still missed without either record')
    f.values.set('holiday:2026-11-02', 'TWSE holiday')
    assert.equal((await job('2026-11-02T14:30:00Z', 'indicator-queue-watchdog')).lastStatus, 'sleep', 'a holiday is not in window')
    assert.equal((await job('2026-11-02T05:00:00Z', 'premarket-evidence-watchdog')).lastStatus, 'sleep')
  } finally { f.sql.close() }
})

test('review M-1: a cross-midnight tick on today\'s key does not hide tonight\'s missed window', async () => {
  const f = fixture()
  try {
    // Tue 11/03 22:30 TW: the allocator watchdog's only 11/03 receipt is the 01:50 tick of Monday night's window.
    f.daily('2026-11-03', [{ task: 'allocator-ev-lifecycle-watchdog', status: 'skipped', duration_ms: 500,
      timestamp: '2026-11-02T17:50:00Z', summary: 'no incomplete lifecycle' }])
    // The 01:50 tick's ticket was settled in the same second as its receipt.
    f.sql.prepare(`INSERT INTO scheduler_execution_tickets_v1 (ticket_id,dedupe_key,root_ticket_id,scheduler_job_id,task,business_date,
      run_id,attempt_id,ticket_kind,status,status_authority,payload_checksum,last_summary,updated_at)
      VALUES ('t1','d1','t1','allocator-ev-lifecycle-watchdog','allocator-ev-lifecycle-watchdog','2026-11-03','r1','a1',
      'physical_root','skipped','scheduler_http','x','no incomplete lifecycle','2026-11-02 17:50:00')`).run()
    const result = await getSchedulerStatus(f.env, '2026-11-03', Date.parse('2026-11-03T14:30:00Z'))
    const job = result.jobs.find((row) => row.id === 'allocator-ev-lifecycle-watchdog')!
    assert.equal(job.lastStatus, 'failed', `got ${job.lastStatus} ${job.lastError}`)
    assert.match(String(job.lastError), /no 2026-11-03 receipt since its window opened at 21:00/)
    f.daily('2026-11-03', [{ task: 'allocator-ev-lifecycle-watchdog', status: 'success', duration_ms: 800,
      timestamp: '2026-11-03T14:20:00Z', summary: 'recovered nothing' }])
    const ran = (await getSchedulerStatus(f.env, '2026-11-03', Date.parse('2026-11-03T14:30:00Z')))
      .jobs.find((row) => row.id === 'allocator-ev-lifecycle-watchdog')!
    assert.equal(ran.lastStatus, 'success')
  } finally { f.sql.close() }
})

test('review: the holiday and canonical-key reads happen only once a weekday window is due', async () => {
  const f = fixture()
  try {
    const reads: string[] = []
    const get = f.env.KV.get
    f.env.KV.get = async (key: string, type?: string) => { reads.push(key); return get(key, type) }
    const extra = () => reads.filter((key) => key.startsWith('holiday:') || /^scheduler:run:[a-z0-9-]+-watchdog:/.test(key))
    await getSchedulerStatus(f.env, '2026-11-07', Date.parse('2026-11-07T14:30:00Z'))
    assert.deepEqual(extra(), [], 'Saturday: no window, so no holiday or watchdog key read')
    reads.length = 0
    await getSchedulerStatus(f.env, '2026-11-02', Date.parse('2026-11-01T22:00:00Z'))
    assert.deepEqual(extra(), [], 'Monday 06:00 TW: no window has opened yet')
    reads.length = 0
    await getSchedulerStatus(f.env, '2026-11-02', Date.parse('2026-11-01T23:05:00Z'))
    assert.deepEqual(extra(), ['holiday:2026-11-02'], 'Monday 07:05 TW: holiday checked once, canonical key waits out the grace')
    reads.length = 0
    await getSchedulerStatus(f.env, '2026-11-02', Date.parse('2026-11-02T14:30:00Z'))
    assert.equal(extra().filter((key) => key.startsWith('holiday:')).length, 1, 'one holiday read per request')
    assert.equal(extra().filter((key) => key.startsWith('scheduler:run:')).length, 5, 'one canonical key per due watchdog')
  } finally { f.sql.close() }
})

test('review: a failed holiday read counts as a trading day so the miss stays visible', async () => {
  const f = fixture()
  try {
    const get = f.env.KV.get
    f.env.KV.get = async (key: string, type?: string) => {
      if (key.startsWith('holiday:')) throw new Error('kv unavailable')
      return get(key, type)
    }
    const job = (await getSchedulerStatus(f.env, '2026-11-02', Date.parse('2026-11-02T14:30:00Z')))
      .jobs.find((row) => row.id === 'finlab-backfill-watchdog')!
    assert.equal(job.lastStatus, 'failed')
  } finally { f.sql.close() }
})

test('review2: an older premarket "pending" receipt cannot turn today\'s missed window back into waiting', async () => {
  const f = fixture()
  try {
    // Mon 11/02 08:50 TW left a triggered pending-chain receipt; on Tue 11/03 the 07:00 window never ran.
    f.daily('2026-11-02', [{ task: 'premarket-evidence-watchdog', status: 'triggered', timestamp: '2026-11-02T00:50:00Z',
      summary: 'status=pending premarket_event_chain stage=x' }])
    const job = (await getSchedulerStatus(f.env, '2026-11-03', Date.parse('2026-11-03T01:44:00Z')))
      .jobs.find((row) => row.id === 'premarket-evidence-watchdog')!
    assert.equal(job.lastStatus, 'failed', `got ${job.lastStatus}: ${job.summary}`)
    assert.match(String(job.lastError), /no 2026-11-03 receipt since its window opened at 07:00/)
    assert.doesNotMatch(job.summary, /本次盤前鏈檢查已完成/)
  } finally { f.sql.close() }
})

test('review2: a receipt stamped exactly at the window open belongs to the window', async () => {
  const f = fixture()
  try {
    const reads: string[] = []
    const get = f.env.KV.get
    f.env.KV.get = async (key: string, type?: string) => { reads.push(key); return get(key, type) }
    const direct = () => reads.filter((key) => /^scheduler:run:[a-z0-9-]+-watchdog:/.test(key))
    const at = async (timestamp: string) => {
      f.daily('2026-11-03', [{ task: 'allocator-ev-lifecycle-watchdog', status: 'success', timestamp, summary: 'ok' }])
      reads.length = 0
      return (await getSchedulerStatus(f.env, '2026-11-03', Date.parse('2026-11-03T14:30:00Z')))
        .jobs.find((row) => row.id === 'allocator-ev-lifecycle-watchdog')!
    }
    const onOpen = await at('2026-11-03T13:00:00.000Z')
    assert.equal(onOpen.lastStatus, 'success', 'the 21:00:00 tick is inside the window')
    assert.ok(!direct().includes('scheduler:run:allocator-ev-lifecycle-watchdog:2026-11-03'), 'and needs no canonical-key check')
    const before = await at('2026-11-03T12:59:59.999Z')
    assert.equal(before.lastStatus, 'failed', 'a tick a millisecond before 21:00 is last night\'s')
    assert.ok(direct().includes('scheduler:run:allocator-ev-lifecycle-watchdog:2026-11-03'))
  } finally { f.sql.close() }
})

test('Q38: a missed watchdog is today\'s missing cell and missed24h, while the deploy gate keeps failed24h', async () => {
  const f = fixture()
  try {
    const status = await getSchedulerStatus(f.env, '2026-11-03', Date.parse('2026-11-03T14:30:00Z'))
    const missed = status.jobs.filter((row) => row.missedWindow)
    assert.deepEqual(missed.map((row) => row.id).sort(), ['allocator-ev-lifecycle-watchdog', 'finlab-backfill-watchdog',
      'indicator-queue-watchdog', 'premarket-evidence-watchdog', 'screener-v2-watchdog'])
    for (const row of missed) {
      assert.equal(row.history7d.at(-1), 'missing', `${row.id}: today's cell`)
      assert.equal(row.rate7d, '0/1', `${row.id}: the miss counts against the SLO`)
    }
    assert.equal(status.stats.missed24h, 5)
    assert.equal(status.stats.failed24h, 0, 'failed24h does not include missed windows')
    const { schedulerFailedGateCheck } = await import('./deployGate')
    const gate = schedulerFailedGateCheck(status)
    assert.equal(gate.status, 'ok', 'five missed watchdogs do not fail the deploy gate')
    assert.equal(gate.summary, 'failed24h=0')
  } finally { f.sql.close() }
})

// Q41: the deploy gate keeps the PR-base failed24h. Reviewer probes B-F at Tue 11/03 22:30 TW; the base values
// (f63f77d5) are pinned here while the rows still show the enriched truth.
const finlabError = { task: 'finlab-backfill-watchdog', status: 'error' as const, timestamp: '2026-11-03T14:20:00Z',
  summary: 'FinLab watchdog terminal callback status=error dispatch_attempt=2', error: 'modal 500' }
const at2230 = async (setup: (f: ReturnType<typeof fixture>) => void) => {
  const f = fixture()
  try {
    setup(f)
    const status = await getSchedulerStatus(f.env, '2026-11-03', Date.parse('2026-11-03T14:30:00Z'))
    const { schedulerFailedGateCheck } = await import('./deployGate')
    return { status, gate: schedulerFailedGateCheck(status), job: (id: string) => status.jobs.find((row) => row.id === id)! }
  } finally { f.sql.close() }
}

test('Q41 probe B: a FinLab watchdog error in the aggregate shows on its row but stays out of the gate', async () => {
  const r = await at2230((f) => f.daily('2026-11-03', [finlabError]))
  assert.equal(r.status.stats.failed24h, 0, 'PR base never read FinLab watchdog receipts')
  assert.equal(r.gate.status, 'ok')
  assert.equal(r.job('finlab-backfill-watchdog').lastStatus, 'failed')
  assert.equal(r.job('finlab-backfill-watchdog').lastError, 'modal 500')
  assert.equal(r.job('finlab-backfill-watchdog').missedWindow, false)
})

test('Q41 probe C: an error only in the canonical key shows on the row but stays out of the gate', async () => {
  const r = await at2230((f) => f.values.set('scheduler:run:finlab-backfill-watchdog:2026-11-03', { ...finlabError, duration_ms: 1, run_date: '2026-11-03', error: 'e' }))
  assert.equal(r.status.stats.failed24h, 0)
  assert.equal(r.job('finlab-backfill-watchdog').lastStatus, 'failed')
  assert.equal(r.job('finlab-backfill-watchdog').lastError, 'e')
})

test('Q41 probe D: a canonical-key success does not clear the 01:50 error the gate counted on base', async () => {
  const r = await at2230((f) => {
    f.daily('2026-11-03', [{ task: 'allocator-ev-lifecycle-watchdog', status: 'error', timestamp: '2026-11-02T17:50:00Z', summary: 'x', error: 'e' }])
    f.values.set('scheduler:run:allocator-ev-lifecycle-watchdog:2026-11-03', { task: 'allocator-ev-lifecycle-watchdog', status: 'success',
      timestamp: '2026-11-03T14:20:00Z', summary: 'ok', duration_ms: 1, run_date: '2026-11-03' })
  })
  assert.equal(r.status.stats.failed24h, 1, 'base counted the aggregate 01:50 error')
  assert.equal(r.gate.status, 'fail')
  assert.equal(r.job('allocator-ev-lifecycle-watchdog').lastStatus, 'success', 'the row shows tonight\'s canonical receipt')
})

test('m-3 probe E: a counted 01:50 error plus tonight\'s miss is one failure, and its failed cell stays', async () => {
  const r = await at2230((f) => f.daily('2026-11-03', [
    { task: 'allocator-ev-lifecycle-watchdog', status: 'error', timestamp: '2026-11-02T17:50:00Z', summary: 'x', error: 'e' }]))
  const allocator = r.job('allocator-ev-lifecycle-watchdog')
  assert.equal(r.status.stats.failed24h, 1)
  assert.equal(allocator.history7d.at(-1), 'failed', 'a failed cell is not overwritten by missing')
  assert.equal(r.status.stats.missed24h, 4, 'the allocator is not counted again as missed')
})

test('m-2 probe F: an in-window ticket error is a real failure, not a miss', async () => {
  const r = await at2230((f) => f.sql.prepare(`INSERT INTO scheduler_execution_tickets_v1 (ticket_id,dedupe_key,root_ticket_id,
    scheduler_job_id,task,business_date,run_id,attempt_id,ticket_kind,status,status_authority,payload_checksum,last_summary,last_error,updated_at)
    VALUES ('t1','d1','t1','allocator-ev-lifecycle-watchdog','allocator-ev-lifecycle-watchdog','2026-11-03','r1','a1',
    'physical_root','error','scheduler_http','x','boom','lifecycle replay crashed','2026-11-03 14:20:00')`).run())
  const allocator = r.job('allocator-ev-lifecycle-watchdog')
  assert.equal(allocator.lastStatus, 'failed')
  assert.equal(allocator.missedWindow, false)
  assert.equal(allocator.lastError, 'lifecycle replay crashed')
  assert.notEqual(allocator.history7d.at(-1), 'missing')
  assert.equal(r.status.stats.missed24h, 4)
})

test('m-4: the scheduler gate check fails on an unreadable status and passes on missing stats', async () => {
  const { schedulerFailedGateCheck, schedulerStatusForGate } = await import('./deployGate')
  assert.deepEqual(schedulerFailedGateCheck({}), { id: 'scheduler_failed_24h', status: 'ok', summary: 'failed24h=0', metrics: { successRate7d: null } })
  assert.equal(schedulerFailedGateCheck({ stats: { failed24h: 2 } }).status, 'fail')
  const broken = { KV: { get: async () => { throw new Error('kv down') } }, DB: undefined, OPS_DB: undefined } as any
  const unreadable = await schedulerStatusForGate(broken)
  assert.equal(unreadable.stats?.failed24h, 1)
  assert.match(String(unreadable.error), /\S/)
  assert.deepEqual(schedulerFailedGateCheck(unreadable), { id: 'scheduler_failed_24h', status: 'fail', summary: 'failed24h=1', metrics: { successRate7d: 0 } })
})

// Round 4: the deploy gate equals origin/main (Wei Q41), which never read wait_until.
test('review4 A: wait_until keeps a holiday-parked root waiting on its row, while the gate counts main\'s stuck root', async () => {
  const f = fixture()
  try {
    f.daily('2026-11-06', [{ task: 'evening-chain', status: 'running', timestamp: '2026-11-06T15:40:00Z', run_id: 'r1106',
      summary: 'pipeline serving published; research waits for the after-close dispatch run_id=r1106',
      wait_until: '2026-11-10T14:20:00+08:00' }])
    f.values.set('holiday:2026-11-09', { name: 'holiday' })
    // Mon 11/09 16:30 TW, a weekday holiday: main's after-close deadline (Mon 14:20 + SLA) has passed.
    const status = await getSchedulerStatus(f.env, '2026-11-09', Date.parse('2026-11-09T08:30:00Z'))
    const root = status.jobs.find((row) => row.id === 'evening-chain')!
    assert.equal(root.lastStatus, 'waiting', 'the row still waits for the Tuesday dispatch')
    assert.equal(root.history7d[status.dates.indexOf('2026-11-06')], 'waiting', 'and so does its strip cell')
    assert.equal(status.stats.failed24h, 1, 'main counts the root stuck past its after-close deadline')
    const { schedulerFailedGateCheck } = await import('./deployGate')
    assert.equal(schedulerFailedGateCheck(status).status, 'fail')
  } finally { f.sql.close() }
})

test('review4 B: an unreadable or malformed canonical watchdog key leaves the page and the gate on main\'s reading', async () => {
  for (const failure of [new Error('kv down'), new SyntaxError('Unexpected token < in JSON')]) {
    for (const allocatorError of [false, true]) {
      const reads: string[] = []
      const r = await at2230((f) => {
        if (allocatorError) {
          f.daily('2026-11-03', [{ task: 'allocator-ev-lifecycle-watchdog', status: 'error', timestamp: '2026-11-02T17:50:00Z', summary: 'x', error: 'e' }])
        }
        const get = f.env.KV.get
        f.env.KV.get = async (key: string, type?: string) => {
          if (/^scheduler:run:[a-z0-9-]+-watchdog:/.test(key)) { reads.push(key); throw failure }
          return get(key, type)
        }
      })
      const label = `${failure.name} allocatorError=${allocatorError}`
      assert.ok(reads.length >= 4, `${label}: the canonical keys were read`)
      assert.equal(r.status.stats.failed24h, allocatorError ? 1 : 0, label)
      assert.equal(r.gate.status, allocatorError ? 'fail' : 'ok', label)
      assert.equal(r.job('finlab-backfill-watchdog').missedWindow, true, `${label}: the page still renders the miss`)
    }
  }
})

test('review4 M3: a watchdog blocked before its window stays out of the gate even after it misses tonight', async () => {
  const r = await at2230((f) => {
    f.daily('2026-11-02', [{ task: 'allocator-ev-lifecycle-watchdog', status: 'error', timestamp: '2026-11-02T15:00:00Z', summary: 'x', error: 'e' }])
    f.daily('2026-11-03', [{ task: 'allocator-ev-lifecycle-watchdog', status: 'blocked', timestamp: '2026-11-02T17:50:00Z', summary: 'paused' }])
  })
  const allocator = r.job('allocator-ev-lifecycle-watchdog')
  assert.equal(allocator.lastStatus, 'failed', 'the row shows tonight\'s miss')
  assert.equal(allocator.missedWindow, true)
  assert.equal(r.status.stats.failed24h, 0, 'main reads the 01:50 blocked receipt and skips the job, as before')
  assert.equal(r.gate.status, 'ok')
})

test('review4: no watchdog is a chain step, durable job or premarket producer/phase row (the gate view assumes it)', async () => {
  const { CHAIN_STEP_IDS, DURABLE_EVENT_TASK_IDS, DURABLE_STAGE_JOB_IDS, SCHEDULER_STATUS_JOB_DEFS } = await import('./schedulerStatus')
  const { premarketProducerDisplay } = await import('./premarketProducerStatus')
  const { premarketReadinessDisplay, premarketExecutionDisplay } = await import('./schedulerPremarketProgress')
  const { sealedPremarketDisplay } = await import('./schedulerPipelinePhase')
  const date = '2026-11-03'
  const checksum = 'a'.repeat(64)
  const producer = (id: string) => premarketProducerDisplay(id, date, [{ business_date: date, stage: `premarket_v2:${id}`,
    canonical_run_id: `${date}:premarket_v2:${id}`, status: 'success', persisted_count: 1, attempt_count: 1,
    lease_expires_at: null, last_error: null, updated_at: '2026-11-03 00:30:00' }])
  const progress = [
    { stage: 'premarket_v3:publish:0', status: 'success', publication_ready: 1, pending_status: 'ready', updated_at: '2026-11-03 00:40:00' },
    { stage: 'premarket_v3:market-health', status: 'success', updated_at: '2026-11-03 00:41:00' },
    { stage: 'premarket_v3:allocate', status: 'running', updated_at: '2026-11-03 00:30:00' },
  ].map((row) => ({ business_date: date, canonical_run_id: `${date}:premarket-v3`, last_error: null, queued_at: null,
    signal_date: '2026-11-02', l3_run_id: 'l3', l3_checksum: checksum, ...row }))
  const readiness = (id: string) => premarketReadinessDisplay(id, date,
    progress.map((row) => (row.stage === 'premarket_v3:allocate' ? { ...row, status: 'success' } : row)))
  const pipeline = { business_date: '2026-11-02', canonical_run_id: 'l3', status: 'waiting', last_error: 'awaiting_premarket' }
  const execution = (id: string) => premarketExecutionDisplay({ jobId: id, today: date, businessDate: '2026-11-02', rows: progress, pipeline })
  const sealed = (id: string) => sealedPremarketDisplay({ jobId: id, businessDate: '2026-11-02', stage: pipeline,
    log: { run_id: 'l3', run_date: '2026-11-02', status: 'triggered', summary: 'l3_sealed=true cloud_compute_stopped=true' } })
  // Positive controls: each probe does display its own rows.
  assert.ok(producer('news-analyst') && readiness('pre-market-warmup') && execution('pipeline') && sealed('pipeline'))
  const watchdogs = SCHEDULER_STATUS_JOB_DEFS.filter((def) => def.id.endsWith('-watchdog')).map((def) => def.id)
  assert.ok(watchdogs.length >= 6)
  for (const id of watchdogs) {
    assert.ok(!CHAIN_STEP_IDS.includes(id), `${id} is a chain step`)
    assert.ok(!DURABLE_EVENT_TASK_IDS.has(id), `${id} is a durable event task`)
    assert.ok(!Object.values(DURABLE_STAGE_JOB_IDS).includes(id), `${id} owns a durable stage`)
    assert.equal(producer(id), null, `${id}: producer display`)
    assert.equal(readiness(id), null, `${id}: readiness display`)
    assert.equal(execution(id), null, `${id}: execution display`)
    assert.equal(sealed(id), null, `${id}: sealed display`)
  }
})

test('EC-B-2: a gap-filled per-task error shows on the row but the gate keeps main\'s aggregate reading', async () => {
  const f = fixture()
  try {
    // daily-snapshot ran on Friday; today's run is missing from the aggregate (lost update) and errored.
    f.daily('2026-10-30', [{ task: 'daily-snapshot', status: 'success', timestamp: '2026-10-30T06:20:00Z', summary: 'ok' }])
    f.values.set(`scheduler:run:daily-snapshot:${today}`, { task: 'daily-snapshot', status: 'error', timestamp: ago(30),
      summary: 'snapshot failed', error: 'boom', duration_ms: 1, run_date: today })
    const status = await getSchedulerStatus(f.env, today, nowMs)
    assert.equal(status.jobs.find((row) => row.id === 'daily-snapshot')!.lastStatus, 'failed', 'the row shows the direct read')
    assert.equal(status.stats.failed24h, 0, 'main never read the per-task key, so the gate does not count it')
    const { schedulerFailedGateCheck } = await import('./deployGate')
    assert.equal(schedulerFailedGateCheck(status).status, 'ok')
  } finally { f.sql.close() }
})

test('EC-B-2: a gap-filled blocked receipt cannot exclude a stuck run the gate counted on main', async () => {
  const f = fixture()
  try {
    f.daily(today, [{ task: 'daily-snapshot', status: 'running', timestamp: ago(240), summary: 'started' }])
    f.values.set(`scheduler:run:daily-snapshot:${today}`, { task: 'daily-snapshot', status: 'blocked', timestamp: ago(30),
      summary: 'paused', duration_ms: 1, run_date: today })
    const status = await getSchedulerStatus(f.env, today, nowMs)
    assert.equal(status.jobs.find((row) => row.id === 'daily-snapshot')!.lastStatus, 'blocked', 'the row shows the direct read')
    assert.equal(status.stats.failed24h, 1, 'main counts the aggregate run stuck past its SLA')
  } finally { f.sql.close() }
})

test('EC-B-2: at 09:00 jobs not yet due today do not crowd out yesterday\'s lost receipts', async () => {
  const { SCHEDULER_STATUS_JOB_DEFS } = await import('./schedulerStatus')
  const f = fixture()
  try {
    const day = '2026-11-12', yesterday = '2026-11-11'
    const ids = SCHEDULER_STATUS_JOB_DEFS.map((def) => def.id).filter((id) => !id.endsWith('-watchdog'))
    for (const date of ['2026-11-10', yesterday]) {
      f.daily(date, ids.filter((id) => !(date === yesterday && id === 'daily-snapshot'))
        .map((task) => ({ task, status: 'success' as const, timestamp: `${date}T01:00:00Z`, summary: 'ok' })))
    }
    f.values.set(`scheduler:run:daily-snapshot:${yesterday}`, { task: 'daily-snapshot', status: 'error', timestamp: `${yesterday}T06:30:00Z`,
      summary: 'snapshot failed', error: 'boom', duration_ms: 1, run_date: yesterday })
    const reads: string[] = []
    const get = f.env.KV.get
    f.env.KV.get = async (key: string, type?: string) => { reads.push(key); return get(key, type) }
    await getSchedulerStatus(f.env, day, Date.parse('2026-11-12T01:00:00Z'))
    assert.ok(reads.includes(`scheduler:run:daily-snapshot:${yesterday}`), 'yesterday\'s lost receipt is read')
    assert.ok(!reads.includes(`scheduler:run:external-evidence:${day}`), 'a job due at 23:15 tonight is not read at 09:00')
    assert.ok(reads.includes(`scheduler:run:us-leading:${day}`), 'a job due at 06:30 that has no receipt yet is read')
    // Late evening: more jobs are due today than there are slots, and yesterday still goes first.
    reads.length = 0
    await getSchedulerStatus(f.env, day, Date.parse('2026-11-12T15:50:00Z'))
    assert.ok(reads.includes(`scheduler:run:daily-snapshot:${yesterday}`), 'yesterday is read before today\'s gaps')
  } finally { f.sql.close() }
})
