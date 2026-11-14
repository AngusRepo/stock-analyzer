import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  hasStrategyLearningSuccessReceipt,
  isStrategyLearningRecoveryWindowDate,
  runStrategyLearningRecoveryWatchdog,
  strategyLearningDeferredBackoffMinutes,
  strategyLearningDeferredRetryGate,
  strategyLearningRecoveryDecision,
  type StrategyLearningRecoveryRow,
} from './strategyLearningRecoveryWatchdog'
import { classifySchedulerSummary } from './schedulerRunLogger'

const base: StrategyLearningRecoveryRow = {
  business_date: '2026-08-31',
  canonical_run_id: 'pipeline-dispatch:2026-08-31:canonical',
  status: 'running',
  cursor_symbol: '9958',
  expected_candidates: 830,
  processed_candidates: 830,
  expected_decision_rows: 21580,
  persisted_decision_rows: 21580,
  lease_owner: 'expired-owner',
  lease_expires_at: '2026-08-31 16:39:11',
  attempt_count: 38,
  last_error: null,
  updated_at: '2026-08-31 16:38:28',
  production_authority_intent: 1,
  policy_closure_status: 'pending',
  completed_at: null,
  policy_closure_completed_at: null,
}

assert.deepEqual(
  strategyLearningRecoveryDecision(base, Date.parse('2026-08-31T16:40:00Z')),
  { resume: true, reason: 'lease_expired' },
)
assert.deepEqual(
  strategyLearningRecoveryDecision(base, Date.parse('2026-08-31T16:38:00Z')),
  { resume: false, reason: 'active_lease' },
)
assert.deepEqual(
  strategyLearningRecoveryDecision({ ...base, status: 'queued', lease_owner: null, lease_expires_at: null }),
  { resume: true, reason: 'queued_without_lease' },
)
assert.deepEqual(
  strategyLearningRecoveryDecision({
    ...base,
    status: 'queued',
    cursor_symbol: null,
    processed_candidates: 0,
    persisted_decision_rows: 0,
    lease_owner: null,
    lease_expires_at: null,
  }),
  { resume: true, reason: 'queued_without_lease' },
)
assert.equal(
  strategyLearningRecoveryDecision({ ...base, status: 'error', last_error: 'real_data_blocker' }).resume,
  false,
)
assert.equal(
  strategyLearningRecoveryDecision({ ...base, persisted_decision_rows: -1 }).reason,
  'recoverable_progress_invalid',
)

const successfulRun: StrategyLearningRecoveryRow = {
  ...base,
  status: 'success',
  policy_closure_status: 'materialized',
  completed_at: '2026-08-31 17:40:53',
  policy_closure_completed_at: '2026-08-31 17:40:52',
}
assert.equal(hasStrategyLearningSuccessReceipt(successfulRun), true)
assert.equal(hasStrategyLearningSuccessReceipt({ ...successfulRun, completed_at: null }), false)
assert.equal(hasStrategyLearningSuccessReceipt({ ...successfulRun, persisted_decision_rows: 21579 }), false)
assert.equal(hasStrategyLearningSuccessReceipt({ ...successfulRun, policy_closure_status: 'pending' }), false)
assert.equal(hasStrategyLearningSuccessReceipt({ ...successfulRun, policy_closure_status: 'evidence_only' }), false)
assert.equal(hasStrategyLearningSuccessReceipt({ ...successfulRun, production_authority_intent: 0, policy_closure_status: 'evidence_only' }), true)

const source = fs.readFileSync('src/lib/strategyLearningRecoveryWatchdog.ts', 'utf8')
const tasks = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const scheduler = fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')
const schedulerPolicy = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
assert(source.includes("status IN ('queued','running')"), 'watchdog must not auto-retry terminal error runs')
assert(source.includes('business_date BETWEEN date(?, ?) AND ?'), 'watchdog must resolve the latest cross-midnight incomplete run')
assert(source.includes("status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=CURRENT_TIMESTAMP)"), 'an active newer run must not starve an older expired recovery')
assert(source.includes("stage='post_verify_chain'"), 'watchdog must require post-verify authority')
assert(source.includes('authority?.canonical_run_id !== row.canonical_run_id'), 'watchdog must fence canonical lineage')
assert(source.includes('productionAuthorityIntent: Number(row.production_authority_intent ?? 0) === 1'), 'watchdog must preserve durable live authority intent')
assert(source.includes('authority=revalidate_at_finalizer'), 'watchdog must defer current authority validation to the canonical finalizer')
assert(source.includes('strategy-learning:watchdog-dispatch:'), 'watchdog must fence duplicate queue dispatches')
assert(source.includes('DISPATCH_FENCE_TTL_SECONDS'), 'dispatch fence must expire for bounded retry')
assert(tasks.includes("'strategy-learning-watchdog'"), 'admin task map must expose the dedicated watchdog')
assert(tasks.includes('runStrategyLearningRecoveryWatchdog'), 'scheduled screener watchdog must drain post-verify strategy recovery')
assert(tasks.includes('status=${compositeStatus}'), 'composite watchdog must preserve triggered/running state instead of false-green success')
assert(schedulerPolicy.includes("'screener-v2-watchdog': { kind: 'maintenance', holidayGated: false"), 'cross-midnight parent watchdog must not be Saturday-gated')
assert(schedulerPolicy.includes("'strategy-learning-watchdog': { kind: 'maintenance', holidayGated: false"), 'cross-midnight learning watchdog must rely on canonical authority instead of calendar-day gating')
assert(scheduler.includes('strategy-learning expired-lease recovery'), 'scheduler source must document composite recovery ownership')


// Deferred finalizer failures: backoff 0/20/40/80/160/160 minutes after the last deferral, cap 6.
assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(strategyLearningDeferredBackoffMinutes), [0, 20, 40, 80, 160, 160, 160])
const deferredRow: StrategyLearningRecoveryRow = {
  ...base, status: 'queued', lease_owner: null, lease_expires_at: null,
  last_error: 'strategy_learning_finalizer_stage_failed:before_promotion:D1 DB is overloaded',
  updated_at: '2026-08-31 16:00:00',
}
const deferredAt = Date.parse('2026-08-31T16:00:00Z')
assert.deepEqual(strategyLearningDeferredRetryGate(deferredRow, 0, deferredAt), { action: 'dispatch' })
assert.deepEqual(strategyLearningDeferredRetryGate(deferredRow, 1, deferredAt + 19 * 60_000), { action: 'backoff', nextDueMs: deferredAt + 20 * 60_000 })
assert.deepEqual(strategyLearningDeferredRetryGate(deferredRow, 1, deferredAt + 20 * 60_000), { action: 'dispatch' })
assert.deepEqual(strategyLearningDeferredRetryGate(deferredRow, 4, deferredAt + 159 * 60_000), { action: 'backoff', nextDueMs: deferredAt + 160 * 60_000 })
assert.deepEqual(strategyLearningDeferredRetryGate(deferredRow, 5, deferredAt + 160 * 60_000), { action: 'dispatch' })
assert.deepEqual(strategyLearningDeferredRetryGate(deferredRow, 6, deferredAt + 86_400_000), { action: 'exhausted' })

const opsSchema = fs.readFileSync('domain-schemas/ops.sql', 'utf8')
const learningSchema = fs.readFileSync('domain-schemas/learning.sql', 'utf8')
const ddl = (schema: string, table: string, index: string) => [
  schema.slice(schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`), schema.indexOf(');', schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`)) + 2),
  schema.slice(schema.indexOf(`CREATE INDEX IF NOT EXISTS ${index}`), schema.indexOf(';', schema.indexOf(`CREATE INDEX IF NOT EXISTS ${index}`)) + 1),
].join('\n')

function watchdogFixture() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(ddl(opsSchema, 'strategy_learning_runs', 'idx_strategy_learning_runs_status'))
  sql.exec(ddl(learningSchema, 'strategy_redundancy_artifacts_v1', 'idx_strategy_redundancy_artifacts_v1_date'))
  sql.exec('CREATE TABLE pipeline_stage_runs (business_date TEXT, stage TEXT, canonical_run_id TEXT, status TEXT)')
  const db = {
    prepare: (query: string) => ({
      bind: (...params: unknown[]) => ({
        first: async () => sql.prepare(query).get(...(params as any[])) ?? null,
        all: async () => ({ results: sql.prepare(query).all(...(params as any[])) }),
        run: async () => sql.prepare(query).run(...(params as any[])),
      }),
    }),
  }
  const values = new Map<string, string>()
  const kv = {
    get: async (key: string, type?: unknown) => {
      const value = values.get(key) ?? null
      return value != null && (type === 'json' || (type as any)?.type === 'json') ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => { values.set(key, value) },
  }
  const sent: any[] = []
  const env = { DB: db, KV: kv, UPDATE_QUEUE: { send: async (message: unknown) => { sent.push(message) } } } as any
  const date = (offsetDays: number) => (sql.prepare(`SELECT date(?, ?) d`).get(
    new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10), `${offsetDays} days`,
  ) as { d: string }).d
  const insertRun = (businessDate: string, fields: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      business_date: businessDate, canonical_run_id: `run-${businessDate}`, producer_run_id: `producer-${businessDate}`,
      status: 'queued', cursor_symbol: '9958', expected_candidates: 830, processed_candidates: 830, strategy_count: 26,
      expected_decision_rows: 21580, persisted_decision_rows: 21580, attempt_count: 3, production_authority_intent: 1,
      last_error: null, ...fields,
    }
    const updatedAgoMinutes = Number(row.updated_ago_minutes ?? 1)
    delete row.updated_ago_minutes
    const columns = Object.keys(row)
    sql.prepare(`INSERT INTO strategy_learning_runs (${columns.join(',')}, updated_at) VALUES (${columns.map(() => '?').join(',')}, datetime('now', ?))`)
      .run(...(Object.values(row) as any[]), `-${updatedAgoMinutes} minutes`)
    sql.prepare(`INSERT INTO pipeline_stage_runs VALUES (?, 'post_verify_chain', ?, 'running')`).run(businessDate, `run-${businessDate}`)
  }
  const countKey = (businessDate: string) => `strategy-learning:watchdog-deferred-dispatches:${businessDate}:run-${businessDate}`
  const logged = (businessDate: string) => JSON.parse(values.get(`scheduler:run:strategy-learning-watchdog:${businessDate}`) ?? 'null')
  return { sql, env, values, sent, date, insertRun, countKey, logged }
}

const STAGE_FAILED = 'strategy_learning_finalizer_stage_failed:before_promotion:D1 DB is overloaded'

test('a queued run without a deferred finalizer failure resumes immediately and is not counted', async () => {
  const f = watchdogFixture()
  const day = f.date(-1)
  f.insertRun(day, { updated_ago_minutes: 0 })
  const summary = await runStrategyLearningRecoveryWatchdog(f.env)
  assert.match(summary, /^triggered strategy-learning recovery .*reason=queued_without_lease/)
  assert.equal(f.sent.length, 1)
  assert.equal(f.values.get(f.countKey(day)), undefined)
  f.sql.close()
})

test('deferred failures: first dispatch is immediate, the next waits 20 minutes after the deferral', async () => {
  const f = watchdogFixture()
  const day = f.date(-1)
  f.insertRun(day, { last_error: STAGE_FAILED, updated_ago_minutes: 1 })
  assert.match(await runStrategyLearningRecoveryWatchdog(f.env), /^triggered .*deferred_dispatch=1\/6/)
  assert.equal(f.values.get(f.countKey(day)), '1')
  assert.equal(f.sent.length, 1)

  f.values.delete(`strategy-learning:watchdog-dispatch:${day}:run-${day}`)
  f.sql.prepare(`UPDATE strategy_learning_runs SET updated_at=datetime('now', '-10 minutes')`).run()
  const waiting = await runStrategyLearningRecoveryWatchdog(f.env)
  assert.match(waiting, /^running strategy-learning recovery .*reason=deferred_backoff next_due=\d{4}-\d{2}-\d{2}T/)
  assert.equal(classifySchedulerSummary(waiting), 'running')
  assert.equal(f.sent.length, 1, 'backoff must not dispatch')
  assert.equal(f.values.get(f.countKey(day)), '1')

  f.sql.prepare(`UPDATE strategy_learning_runs SET updated_at=datetime('now', '-21 minutes')`).run()
  assert.match(await runStrategyLearningRecoveryWatchdog(f.env), /^triggered .*deferred_dispatch=2\/6/)
  assert.equal(f.sent.length, 2)
  assert.equal(f.values.get(f.countKey(day)), '2')
  f.sql.close()
})

test('deferred failures stop after six dispatches as an error without throwing; the admin override redispatches', async () => {
  const f = watchdogFixture()
  const day = f.date(-1)
  f.insertRun(day, { last_error: `${STAGE_FAILED} upstream status=success`, updated_ago_minutes: 600 })
  f.values.set(f.countKey(day), '6')
  const exhausted = await runStrategyLearningRecoveryWatchdog(f.env, day)
  assert.match(exhausted, /^error strategy-learning recovery exhausted date=\S+ run_id=\S+ attempts=6 attempt_count=3 last_error=strategy_learning_finalizer_stage_failed:before_promotion:D1_DB_is_overloaded_upstream_status:success /)
  assert.doesNotMatch(exhausted, /status=/, 'a status= inside last_error must not reclassify the summary')
  assert.equal(classifySchedulerSummary(exhausted), 'error')
  assert.equal(f.logged(day).status, 'error')
  assert.equal(f.sent.length, 0)

  const overridden = await runStrategyLearningRecoveryWatchdog(f.env, day, { overrideBackoff: true })
  assert.match(overridden, /^triggered .*override_backoff=true/)
  assert.equal(f.sent.length, 1)
  assert.equal(f.values.get(f.countKey(day)), '7')
  // The override still respects the dispatch fence.
  assert.match(await runStrategyLearningRecoveryWatchdog(f.env, day, { overrideBackoff: true }), /reason=dispatch_fenced/)
  assert.equal(f.sent.length, 1)
  f.sql.close()
})

test('the override also bypasses a pending backoff', async () => {
  const f = watchdogFixture()
  const day = f.date(-1)
  f.insertRun(day, { last_error: STAGE_FAILED, updated_ago_minutes: 1 })
  f.values.set(f.countKey(day), '3')
  assert.match(await runStrategyLearningRecoveryWatchdog(f.env, day), /reason=deferred_backoff/)
  assert.match(await runStrategyLearningRecoveryWatchdog(f.env, day, { overrideBackoff: true }), /^triggered /)
  assert.equal(f.sent.length, 1)
  f.sql.close()
})

test('no date is dispatched while another date holds a live lease, even with the override', async () => {
  const f = watchdogFixture()
  const older = f.date(-2)
  const newer = f.date(-1)
  f.insertRun(older, { last_error: STAGE_FAILED, updated_ago_minutes: 600 })
  f.insertRun(newer, { status: 'running', lease_owner: 'live', last_error: null })
  f.sql.prepare(`UPDATE strategy_learning_runs SET lease_expires_at=datetime('now', '+10 minutes') WHERE business_date=?`).run(newer)
  for (const options of [{}, { overrideBackoff: true }]) {
    const summary = await runStrategyLearningRecoveryWatchdog(f.env, undefined, options)
    assert.equal(summary, `running strategy-learning recovery date=${older} reason=other_date_active:${newer}`)
  }
  assert.equal(f.sent.length, 0)
  assert.equal(f.values.get(f.countKey(older)), undefined)

  // An expired lease is recoverable work, not a live owner.
  f.sql.prepare(`UPDATE strategy_learning_runs SET lease_expires_at=datetime('now', '-1 minutes') WHERE business_date=?`).run(newer)
  assert.match(await runStrategyLearningRecoveryWatchdog(f.env), new RegExp(`^triggered strategy-learning recovery date=${newer} reason=lease_expired`))
  f.sql.close()
})

test('a missing similarity artifact holds the deferred run without dispatching or counting', async () => {
  const f = watchdogFixture()
  const day = f.date(-1)
  f.insertRun(day, {
    last_error: `strategy_learning_finalizer_stage_failed:before_promotion:evening_chain_similarity_artifact_incomplete:${day}`,
    updated_ago_minutes: 60,
  })
  f.values.set(f.countKey(day), '2')
  const insertArtifact = f.sql.prepare(`INSERT INTO strategy_redundancy_artifacts_v1 (
    artifact_id, as_of_date, status, source_contract, strategy_count, paired_date_count, edge_count, graph_json,
    evidence_artifact_id, created_at
  ) VALUES (?, ?, ?, 'test', 26, 20, 0, '{}', ?, ?)`)
  insertArtifact.run('other-date', f.date(-2), 'pass', 'evidence', '2026-01-01 00:00:00')
  insertArtifact.run('no-evidence', day, 'pass', null, '2026-01-01 00:00:00')
  for (let tick = 0; tick < 2; tick += 1) {
    assert.equal(
      await runStrategyLearningRecoveryWatchdog(f.env, day),
      `running strategy-learning recovery date=${day} reason=awaiting_similarity_artifact attempts=2`,
    )
  }
  assert.equal(f.sent.length, 0)
  assert.equal(f.values.get(f.countKey(day)), '2')

  insertArtifact.run('ready', day, 'pending_maturity', 'evidence', '2026-01-02 00:00:00')
  assert.match(await runStrategyLearningRecoveryWatchdog(f.env, day), /^triggered .*deferred_dispatch=3\/6/)
  assert.equal(f.sent.length, 1)
  assert.equal(f.values.get(f.countKey(day)), '3')
  f.sql.close()
})

test('an expired leftover lease on another date does not block dispatch', async () => {
  const f = watchdogFixture()
  const older = f.date(-2)
  const newer = f.date(-1)
  f.insertRun(older, { updated_ago_minutes: 30 })
  f.insertRun(newer, { lease_owner: 'gone' })
  f.sql.prepare(`UPDATE strategy_learning_runs SET lease_expires_at=datetime('now', '-1 minutes') WHERE business_date=?`).run(newer)
  assert.match(await runStrategyLearningRecoveryWatchdog(f.env), new RegExp(`^triggered strategy-learning recovery date=${older} `))
  f.sql.prepare(`UPDATE strategy_learning_runs SET lease_expires_at=datetime('now', '+5 minutes') WHERE business_date=?`).run(newer)
  f.values.clear()
  assert.equal(await runStrategyLearningRecoveryWatchdog(f.env), `running strategy-learning recovery date=${older} reason=other_date_active:${newer}`)
  assert.equal(f.sent.length, 1)
  f.sql.close()
})

test('a gated newest date does not starve an older recoverable date', async () => {
  for (const [label, fields, count] of [
    ['backing off', { last_error: STAGE_FAILED, updated_ago_minutes: 1 }, '1'],
    ['exhausted', { last_error: STAGE_FAILED, updated_ago_minutes: 600 }, '6'],
    ['awaiting artifact', { last_error: `${STAGE_FAILED}:evening_chain_similarity_artifact_incomplete:x`, updated_ago_minutes: 60 }, '0'],
  ] as const) {
    const f = watchdogFixture()
    const older = f.date(-2)
    const newer = f.date(-1)
    f.insertRun(older, { updated_ago_minutes: 30 })
    f.insertRun(newer, fields)
    f.values.set(f.countKey(newer), count)
    const summary = await runStrategyLearningRecoveryWatchdog(f.env)
    assert.match(summary, new RegExp(`^triggered strategy-learning recovery date=${older} reason=queued_without_lease`), label)
    assert.equal(f.sent.length, 1, label)
    assert.equal(f.sent[0].triggerTime, older, label)
    assert.equal(f.values.get(f.countKey(newer)), count, `${label}: the gated date is not counted`)

    // With the older date fenced, one summary names every candidate; red only when one is exhausted.
    const next = await runStrategyLearningRecoveryWatchdog(f.env)
    assert.equal(f.sent.length, 1, label)
    assert.match(next, new RegExp(`candidates=${newer}:\\S+,${older}:dispatch_fenced$`), label)
    assert.equal(classifySchedulerSummary(next), label === 'exhausted' ? 'error' : 'running', label)
    if (label === 'exhausted') assert.match(next, new RegExp(`^error strategy-learning recovery exhausted date=${newer} `))
    f.sql.close()
  }
})

test('an exhausted older date is the red primary behind a newer backing-off date', async () => {
  const f = watchdogFixture()
  const older = f.date(-2)
  const newer = f.date(-1)
  f.insertRun(older, { last_error: STAGE_FAILED, updated_ago_minutes: 600 })
  f.insertRun(newer, { last_error: STAGE_FAILED, updated_ago_minutes: 1 })
  f.values.set(f.countKey(older), '6')
  f.values.set(f.countKey(newer), '1')
  const summary = await runStrategyLearningRecoveryWatchdog(f.env)
  assert.match(summary, new RegExp(`^error strategy-learning recovery exhausted date=${older} `))
  assert.match(summary, new RegExp(`candidates=${newer}:deferred_backoff,${older}:exhausted$`))
  assert.equal(classifySchedulerSummary(summary), 'error')
  assert.equal(f.logged(older).status, 'error')
  assert.equal(f.sent.length, 0)
  f.sql.close()
})

test('an older denied or invalid date is recorded and the walk reaches the next date', async () => {
  for (const label of ['authority denied', 'progress invalid'] as const) {
    const f = watchdogFixture()
    const oldest = f.date(-3)
    const middle = f.date(-2)
    const newest = f.date(-1)
    f.insertRun(oldest, { updated_ago_minutes: 30 })
    f.insertRun(middle, label === 'progress invalid' ? { persisted_decision_rows: 99_999 } : {})
    f.insertRun(newest, { last_error: STAGE_FAILED, updated_ago_minutes: 1 })
    f.values.set(f.countKey(newest), '1')
    if (label === 'authority denied') {
      f.sql.prepare(`UPDATE pipeline_stage_runs SET status='error' WHERE business_date=?`).run(middle)
    }
    const summary = await runStrategyLearningRecoveryWatchdog(f.env)
    assert.match(summary, new RegExp(`^triggered strategy-learning recovery date=${oldest} `), label)
    assert.equal(f.sent.length, 1, label)

    const next = await runStrategyLearningRecoveryWatchdog(f.env)
    const token = label === 'authority denied' ? 'authority_denied' : 'recoverable_progress_invalid'
    assert.match(next, new RegExp(`^error strategy-learning recovery ${label === 'authority denied' ? 'authority denied' : 'blocked'} date=${middle} `), label)
    assert.match(next, new RegExp(`candidates=${newest}:deferred_backoff,${middle}:${token},${oldest}:dispatch_fenced$`), label)
    assert.equal(f.sent.length, 1, label)
    f.sql.close()
  }
  // The newest candidate keeps the hard failure.
  const f = watchdogFixture()
  const day = f.date(-1)
  f.insertRun(f.date(-2), { updated_ago_minutes: 30 })
  f.insertRun(day)
  f.sql.prepare(`UPDATE pipeline_stage_runs SET status='error' WHERE business_date=?`).run(day)
  await assert.rejects(runStrategyLearningRecoveryWatchdog(f.env), new RegExp(`^Error: strategy-learning recovery authority denied date=${day} post_verify_status=error`))
  assert.equal(f.sent.length, 0)
  f.sql.close()
})

test('an explicit date keeps single-date behaviour', async () => {
  const f = watchdogFixture()
  const older = f.date(-2)
  const newer = f.date(-1)
  f.insertRun(older, { updated_ago_minutes: 30 })
  f.insertRun(newer, { last_error: STAGE_FAILED, updated_ago_minutes: 1 })
  f.values.set(f.countKey(newer), '1')
  const summary = await runStrategyLearningRecoveryWatchdog(f.env, newer)
  assert.match(summary, new RegExp(`^running strategy-learning recovery date=${newer} reason=deferred_backoff next_due=\\S+ attempts=1$`))
  assert.equal(f.sent.length, 0)
  f.sql.close()
})

test('a missing similarity artifact turns red after six hours and still blocks the override', async () => {
  const f = watchdogFixture()
  const day = f.date(-1)
  f.insertRun(day, {
    last_error: `${STAGE_FAILED}:evening_chain_similarity_artifact_incomplete:${day}`,
    updated_ago_minutes: 5 * 60 + 59,
  })
  f.values.set(f.countKey(day), '6')
  const held = await runStrategyLearningRecoveryWatchdog(f.env, day, { overrideBackoff: true })
  assert.equal(held, `running strategy-learning recovery date=${day} reason=awaiting_similarity_artifact attempts=6`)
  f.sql.prepare(`UPDATE strategy_learning_runs SET updated_at=datetime('now', '-361 minutes')`).run()
  const overdue = await runStrategyLearningRecoveryWatchdog(f.env, day, { overrideBackoff: true })
  assert.match(overdue, new RegExp(`^error strategy-learning recovery date=${day} reason=awaiting_similarity_artifact_overdue since=\\d{4}-\\d{2}-\\d{2}T\\S+Z attempts=6$`))
  assert.equal(classifySchedulerSummary(overdue), 'error')
  assert.equal(f.logged(day).status, 'error')
  assert.equal(f.sent.length, 0)
  assert.equal(f.values.get(f.countKey(day)), '6')
  f.sql.close()
})

test('a recorded failure is acknowledged only inside the watchdog lookback', () => {
  assert.equal(isStrategyLearningRecoveryWindowDate('2026-11-12', '2026-11-12'), true)
  assert.equal(isStrategyLearningRecoveryWindowDate('2026-11-08', '2026-11-12'), true)
  assert.equal(isStrategyLearningRecoveryWindowDate('2026-11-07', '2026-11-12'), false)
  assert.equal(isStrategyLearningRecoveryWindowDate('2026-11-13', '2026-11-12'), false)
  assert.equal(isStrategyLearningRecoveryWindowDate('2026-02-26', '2026-03-02'), true)
})

test('the candidate and serialization reads are index searches on ops-db', () => {
  const ops = new DatabaseSync(':memory:')
  ops.exec(opsSchema)
  const query = (marker: string) => {
    const start = source.indexOf('SELECT', source.indexOf(marker))
    return source.slice(start, source.indexOf('`)', start)).replace('${RECOVERY_RUN_COLUMNS}', 'business_date')
  }
  const candidates = query('const { results } = await db.prepare(`')
  const leases = query('async function loadActiveLeaseDate')
  assert.match(candidates, /LIMIT \?\s*$/)
  assert.match(leases, /status IN \('queued','running'\)\s+AND lease_expires_at>CURRENT_TIMESTAMP/)
  for (const [sqlText, binds] of [[candidates, ['2026-11-12', '-4 days', '2026-11-12', 5]], [leases, ['2026-11-12', '-4 days', '2026-11-12']]] as const) {
    const plan = (ops.prepare(`EXPLAIN QUERY PLAN ${sqlText}`).all(...binds) as { detail: string }[]).map((row) => row.detail).join(' | ')
    assert.match(plan, /SEARCH strategy_learning_runs USING INDEX idx_strategy_learning_runs_status/, plan)
    assert.doesNotMatch(plan, /SCAN strategy_learning_runs/, plan)
  }
  ops.close()
})

test('the similarity precondition is one index seek on learning-db', () => {
  const f = watchdogFixture()
  const similarityQuery = source.slice(source.indexOf('FROM strategy_redundancy_artifacts_v1') - 60, source.indexOf('LIMIT 1', source.indexOf('FROM strategy_redundancy_artifacts_v1')) + 7)
  const plan = (f.sql.prepare(`EXPLAIN QUERY PLAN ${similarityQuery.slice(similarityQuery.indexOf('SELECT'))}`).all('2026-11-11') as { detail: string }[])
    .map((row) => row.detail).join(' | ')
  assert.match(plan, /SEARCH strategy_redundancy_artifacts_v1 USING INDEX idx_strategy_redundancy_artifacts_v1_date \(as_of_date=\?\)/, plan)
  assert.doesNotMatch(plan, /SCAN strategy_redundancy_artifacts_v1/, plan)
  const closure = fs.readFileSync('src/lib/eveningChainEvidenceClosure.ts', 'utf8')
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
  assert(normalize(closure).includes(normalize(similarityQuery.slice(similarityQuery.indexOf('SELECT')))), 'precondition must read the row the finalizer checks')
  assert(closure.includes("['pass', 'pending_maturity', 'fail'].includes(String(similarity.status))"))
  assert(source.includes("['pass', 'pending_maturity', 'fail'].includes(String(similarity?.status))"))
  f.sql.close()
})

assert(tasks.includes("overrideBackoff: c.req.query('override_backoff') === '1'"), 'only the admin trigger can override deferred backoff')
const compositeWatchdog = tasks.slice(tasks.indexOf("'screener-v2-watchdog': async () =>"), tasks.indexOf("update: () =>"))
assert.doesNotMatch(compositeWatchdog, /overrideBackoff/, 'the scheduled composite watchdog never overrides backoff')

console.log('strategy learning recovery watchdog tests passed')
