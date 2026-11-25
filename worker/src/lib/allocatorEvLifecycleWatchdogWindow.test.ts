import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { runAllocatorEvLifecycleWatchdog } from './allocatorEvDailyLifecycle'
import { inspectL4DistributionClosure } from './l4DistributionClosure'
import { runPostPipelineCallbackChain } from './postMarketChain'
import { classifySchedulerRunSummary } from './schedulerRunLogger'

// 2026-11-24 (Tue) 22:00 TW: the window is the four trading days before it, 11-18..11-24.
const NOW = Date.parse('2026-11-24T14:00:00Z')
const id = (c: string) => c.repeat(64)
const P1120 = id('2'), P1123 = id('3'), SNAPSHOT = id('c')
const run = (day: string) => `pipeline-dispatch:${day}:run`

/** Each domain is its own D1 built from the real migrations, so indexes and EXPLAIN plans are real. */
function domainDb(domain: string, files?: (name: string) => boolean) {
  const sqlite = new DatabaseSync(':memory:')
  const dir = new URL(`../../domain-migrations/${domain}/`, import.meta.url)
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql') && (files?.(name) ?? true)).sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), 'utf8'))
  }
  const statements: string[] = []
  const db = { prepare(sql: string) {
    statements.push(sql)
    let args: any[] = []
    const statement = { bind(...values: any[]) { args = values; return statement },
      async first() { return sqlite.prepare(sql).get(...args) ?? null },
      async all() { return { results: sqlite.prepare(sql).all(...args), success: true } },
      async run() { return { success: true, meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } } } }
    return statement
  } }
  return { sqlite, db, statements }
}

function plan(planId: string, signalDate: string, targets: Record<string, number | null>) {
  return { schema_version: 'l4-portfolio-plan-v1', owner: 'l4_distribution', parent_plan_id: null, plan_id: planId, signal_date: signalDate,
    account_anchor: { order_watermark: 0, cash: 1e6, positions: [], settlement: { unsettledBuyAmount: 0, unsettledSellAmount: 0 } },
    policy_identity: id('a'), model_checksum: id('b'), account_id: 1, nav_at_decision: 1e6,
    l3_identity: { artifact_id: 'l3-A', cohort_id: 'cohort-A', payload_checksum: id('d'), base_artifact_set_checksum: id('e') },
    weights: Object.fromEntries(Object.keys(targets).map(symbol => [symbol, 0])),
    targets: Object.fromEntries(Object.entries(targets).map(([symbol, er]) =>
      [symbol, { weight: 0, current_weight: 0, locked: false, expected_return_gross: er }])),
    constraints: { exposure_cap: .8, name_cap: .3, min_weight: .03, max_positions: 2 },
    proof: { within_tolerance: true, absolute_objective_gap: 1e-10, tolerance: 1e-8, evaluated_candidate_count: Object.keys(targets).length, preselection: false },
    prediction_coverage: { available: Object.values(targets).filter(er => er !== null).length, candidate_count: Object.keys(targets).length, unavailable: {} },
    opb: { enabled: false, status: 'fixed_policy', arm_id: 'base' } }
}

const UNSCORED_3718 = { engine: 'sparse_tangent_inverse_risk', expected_return_owner: 'l4_distribution', expected_return: null,
  selected: false, allocation_weight: 0, selection_reason: 'l3_evidence_unavailable', prediction_blockers: ['r33_unscored:no_model_available'], plan_id: P1123 }

function fixture() {
  const ops = domainDb('ops'), learning = domainDb('learning'), paper = domainDb('paper')
  const core = domainDb('core', name => name.startsWith('0001_'))
  const kv = new Map<string, string>()
  const KV = {
    get: async (key: string, type?: string) => { const value = kv.get(key) ?? null; return value != null && type === 'json' ? JSON.parse(value) : value },
    put: async (key: string, value: string) => { kv.set(key, value) },
    delete: async (key: string) => { kv.delete(key) },
  }
  kv.set('trading:config', JSON.stringify({ l4Distribution: { scope: 'paper' } }))
  const enqueued: any[] = []
  const env = { DB: core.db, CORE_DB: core.db, OPS_DB: ops.db, LEARNING_DB: learning.db, PAPER_DB: paper.db, KV,
    MULTI_D1_ACTIVE_DOMAINS: 'core,ops,learning,paper', MULTI_D1_STRICT: 'true',
    UPDATE_QUEUE: { send: async (value: any) => { enqueued.push(value) } } } as any

  const addPlan = (p: ReturnType<typeof plan>) => {
    paper.sqlite.prepare(`INSERT INTO l4_portfolio_plans_v1(plan_id,account_id,signal_date,policy_identity,activated,allocation_snapshot_id,payload_json)
      VALUES(?,1,?,?,1,?,?)`).run(p.plan_id, p.signal_date, p.policy_identity, SNAPSHOT, JSON.stringify(p))
  }
  addPlan(plan(P1120, '2026-11-20', { A: .02 }))
  addPlan(plan(P1123, '2026-11-23', { A: .02, B: -.001, '3718': null }))
  paper.sqlite.prepare('UPDATE l4_portfolio_head_v1 SET plan_id=? WHERE account_id=1').run(P1123)
  learning.sqlite.prepare(`INSERT INTO paired_nav_frozen_manifests_v1(snapshot_id,signal_date,source_run_id,frozen_at,payload_checksum,part_count,prospective,snapshot_kind)
    VALUES(?,?,?,?,?,1,1,'allocation_context')`).run(SNAPSHOT, '2026-11-23', run('2026-11-23'), '2026-11-24T00:00:00Z', id('f'))
  const recommend = (day: string, symbol: string, owner: string, planId: string, eligible = 0) => core.sqlite.prepare(`
    INSERT INTO daily_recommendations(date,symbol,name,rank,score,reason,alpha_allocation,has_buy_signal,eligible_for_pending_buy)
    VALUES(?,?,?,1,1,'test',?,0,?)`).run(day, symbol, symbol, JSON.stringify({ expected_return_owner: owner, plan_id: planId }), eligible)
  recommend('2026-11-23', 'A', 'l4_distribution', P1123)
  recommend('2026-11-23', 'B', 'l4_distribution', P1123)
  // 3718 has no expected return in the plan: production serves it as an inert weight-0 row of the same plan,
  // with the screener's eligible_for_pending_buy=1 left in place (the 11-23 shape).
  recommend('2026-11-23', '3718', 'l4_distribution', P1123, 1)
  core.sqlite.prepare(`UPDATE daily_recommendations SET alpha_allocation=? WHERE date='2026-11-23' AND symbol='3718'`)
    .run(JSON.stringify(UNSCORED_3718))

  const stage = (day: string, name: string, status: string, extra: Record<string, unknown> = {}) => {
    const row = { business_date: day, stage: name, canonical_run_id: run(day), status, ...extra }
    const keys = Object.keys(row)
    ops.sqlite.prepare(`INSERT INTO pipeline_stage_runs(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
      .run(...Object.values(row) as any[])
  }
  const lifecycle = (day: string, state: string, updatedAt = '2026-11-20 10:00:00') => learning.sqlite.prepare(`
    INSERT INTO allocator_ev_daily_lifecycle(business_date,state,upstream_run_id,attempt_count,updated_at) VALUES(?,?,?,1,?)`)
    .run(day, state, run(day), updatedAt)
  const upstream = (day: string) => {
    kv.set(`scheduler:run:evening-chain:${day}`, JSON.stringify({ status: 'error', run_id: run(day),
      summary: 'root chain stopped in post-pipeline callback chain: l4_distribution_original_plan_closure_incomplete' }))
    kv.set(`scheduler:run:pipeline:${day}`, JSON.stringify({ status: 'success', run_id: run(day), summary: 'ok' }))
    kv.set(`scheduler:run:ml-predict:${day}`, JSON.stringify({ status: 'success', run_id: run(day), summary: 'ok active_model_closure=true' }))
  }
  // 11-18 and 11-20 closed normally; 11-24 has not passed its premarket pipeline execution yet.
  for (const day of ['2026-11-18', '2026-11-20']) {
    stage(day, 'pipeline_execution', 'success'); stage(day, 'post_pipeline_chain', 'success'); lifecycle(day, 'replay_complete')
  }
  stage('2026-11-23', 'pipeline_execution', 'success')
  stage('2026-11-24', 'pipeline_execution', 'waiting', { last_error: 'awaiting_premarket' })
  upstream('2026-11-23')
  const tick = () => runAllocatorEvLifecycleWatchdog(env, undefined, { nowMs: NOW })
  const lifecycleRow = (day: string) => learning.sqlite.prepare('SELECT state, last_error, closed_at FROM allocator_ev_daily_lifecycle WHERE business_date=?').get(day) as any
  const stageRow = (day: string, name: string) => ops.sqlite.prepare('SELECT status, attempt_count FROM pipeline_stage_runs WHERE business_date=? AND stage=?').get(day, name) as any
  return { ops, learning, paper, core, kv, env, enqueued, stage, lifecycle, recommend, tick, lifecycleRow, stageRow }
}

test('(a) a 09-23 post-verify waiting for two months no longer blocks 11-23: same tick dispatches 11-23, 09-23 is reported once', async () => {
  const f = fixture()
  // 09-23: outside the window, verify_triggered with a post-verify waiting >24h (the 11/23 23:50 head-of-line case).
  f.lifecycle('2026-09-23', 'verify_triggered', '2026-09-25 10:00:00')
  f.stage('2026-09-23', 'verify_v2', 'success', { cursor_key: 'verify-cursor' })
  f.ops.sqlite.prepare(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,updated_at)
    VALUES('2026-09-23','post_verify_chain',?,'waiting',datetime('now','-1440 hours'))`).run(run('2026-09-23'))
  // 11-23: post-pipeline failed 9 attempts and has no lifecycle row.
  f.stage('2026-11-23', 'post_pipeline_chain', 'error', { attempt_count: 9, last_error: 'l4_distribution_original_plan_closure_incomplete',
    updated_at: '2026-11-24 06:25:27' })
  // 11-20 (in window): replace its clean close with a post-verify waiting >24h; it stays red but must not block 11-23.
  f.learning.sqlite.prepare(`UPDATE allocator_ev_daily_lifecycle SET state='verify_triggered' WHERE business_date='2026-11-20'`).run()
  f.stage('2026-11-20', 'verify_v2', 'success', { cursor_key: 'verify-cursor' })
  f.ops.sqlite.prepare(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,updated_at)
    VALUES('2026-11-20','post_verify_chain',?,'waiting',datetime('now','-25 hours'))`).run(run('2026-11-20'))

  const first = await f.tick()
  assert.equal(classifySchedulerRunSummary(first), 'error')
  assert.match(first, /^status=failed allocator EV lifecycle window=2026-11-18\.\.2026-11-24 dates=4 incomplete=2 dispatched=2026-11-23 outside_window_new=1 /)
  assert.match(first, /outside_window_unowned=2026-09-23:verify_triggered recovery_dispatch=not_queued/)
  assert.match(first, /2026-11-24=pending_pipeline_execution/)
  assert.match(first, /2026-11-23=failed:.*post-pipeline_dispatch_incomplete.*previous_attempts=9.*l4_distribution_original_plan_closure_incomplete.*recovery_dispatch=post_pipeline_queued/)
  assert.match(first, /2026-11-20=failed:.*waiting_stale/)
  assert.match(first, /2026-11-18=complete/)
  assert.deepEqual(f.enqueued.map(m => [m.type, m.triggerTime, m.runId]), [['post_pipeline_chain', '2026-11-23', run('2026-11-23')]])
  assert.equal(f.stageRow('2026-11-23', 'post_pipeline_chain').status, 'queued')
  assert.equal(f.stageRow('2026-09-23', 'post_verify_chain').status, 'waiting', 'outside the window nothing is re-run')
  assert.equal(f.lifecycleRow('2026-09-23').state, 'verify_triggered')

  const second = await f.tick()
  assert.match(second, /outside_window_new=0 outside_window_known=1;/)
  assert.doesNotMatch(second, /outside_window_unowned/)
  assert.match(second, /2026-11-23=ok:.*recovery_observation=post_pipeline_current.*downstream_status:queued/)
  // 11-20 waiting_stale still reports red every tick.
  assert.match(second, /incomplete=1 .*2026-11-20=failed:.*waiting_stale/)
  assert.equal(f.enqueued.length, 1)

  // Without the in-window stale date the tick is green once the outside date has been reported.
  f.ops.sqlite.prepare(`UPDATE pipeline_stage_runs SET status='success' WHERE business_date='2026-11-20' AND stage='post_verify_chain'`).run()
  const third = await f.tick()
  assert.match(third, /^status=success /)
  assert.equal(classifySchedulerRunSummary(third), 'success')
})

test('(b) 11-12 shape: pipeline succeeded but post-pipeline was never created and no lifecycle row exists → post-pipeline queued', async () => {
  const f = fixture()
  const summary = await f.tick()
  assert.match(summary, /2026-11-23=ok:.*recovery_dispatch=post_pipeline_queued.*run_id=pipeline-dispatch:2026-11-23:run/)
  assert.match(summary, /^status=success .*dispatched=2026-11-23 /)
  assert.deepEqual(f.enqueued.map(m => [m.type, m.triggerTime]), [['post_pipeline_chain', '2026-11-23']])
  assert.deepEqual({ ...f.stageRow('2026-11-23', 'post_pipeline_chain') }, { status: 'queued', attempt_count: 0 })
  // The stage is created only under the pipeline execution's own success authority.
  const g = fixture()
  g.ops.sqlite.prepare(`UPDATE pipeline_stage_runs SET canonical_run_id='pipeline-dispatch:2026-11-23:other' WHERE business_date='2026-11-23'`).run()
  const refused = await g.tick()
  assert.match(refused, /2026-11-23=failed:.*pipeline_stage_authority_rejected/)
  assert.equal(g.enqueued.length, 0)
})

test('(b2) post-pipeline redispatch stops at the cap and one date is dispatched per tick', async () => {
  const f = fixture()
  f.stage('2026-11-23', 'post_pipeline_chain', 'error', { last_error: 'D1_ERROR: overloaded' })
  for (let tick = 1; tick <= 6; tick += 1) {
    assert.match(await f.tick(), /2026-11-23=failed:.*recovery_dispatch=post_pipeline_queued/)
    f.ops.sqlite.prepare(`UPDATE pipeline_stage_runs SET status='error' WHERE business_date='2026-11-23' AND stage='post_pipeline_chain'`).run()
  }
  const exhausted = await f.tick()
  assert.match(exhausted, /2026-11-23=failed:.*post-pipeline_redispatch_exhausted.*redispatches=6.*manual_redispatch_required/)
  assert.equal(f.enqueued.length, 6)

  // Two dates whose post-verify both need a redispatch: only the newest goes this tick.
  const g = fixture()
  for (const day of ['2026-11-20', '2026-11-23']) {
    g.learning.sqlite.prepare(`INSERT INTO allocator_ev_daily_lifecycle(business_date,state,upstream_run_id,attempt_count,updated_at)
      VALUES(?,'verify_triggered',?,1,'2026-11-20 10:00:00') ON CONFLICT(business_date) DO UPDATE SET state='verify_triggered'`).run(day, run(day))
    g.stage(day, 'verify_v2', 'success', { cursor_key: 'verify-cursor' })
    g.ops.sqlite.prepare(`INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,last_error,updated_at)
      VALUES(?,'post_verify_chain',?,'error','D1_ERROR: overloaded',CURRENT_TIMESTAMP)`).run(day, run(day))
  }
  const one = await g.tick()
  assert.match(one, /dispatched=2026-11-23 /)
  assert.match(one, /2026-11-23=failed:.*post-verify_dispatch_incomplete.*recovery_dispatch=post_verify_queued/)
  assert.match(one, /2026-11-20=ok:status:waiting_.*recovery_dispatch=deferred_one_date_per_tick_dispatched_date=2026-11-23/)
  assert.deepEqual(g.enqueued.map(m => [m.type, m.triggerTime]), [['post_verify_chain', '2026-11-23']])
  assert.equal(g.kv.get(`allocator-ev-lifecycle:post-verify-redispatches:2026-11-20:${run('2026-11-20')}`), undefined,
    'a deferred date does not spend its redispatch budget')
})

test('(c) S12 retired: replay_pending_maturity closes as replay_complete and never enqueues the retired chunk', async () => {
  const f = fixture()
  f.learning.sqlite.prepare(`UPDATE allocator_ev_daily_lifecycle SET state='replay_pending_maturity', closed_at=NULL WHERE business_date='2026-11-20'`).run()
  // Outside the window the same state is only reported, not closed.
  f.lifecycle('2026-07-08', 'replay_pending_maturity', '2026-07-20 10:00:00')
  const summary = await f.tick()
  assert.match(summary, /2026-11-20=ok:.*replay_not_applicable=retired_fusion_maturity_backfill_new_l4_active.*lifecycle=replay_complete/)
  assert.match(summary, /outside_window_unowned=2026-07-08:replay_pending_maturity/)
  assert.equal(f.enqueued.filter(m => m.type === 's12_replay_backfill_chunk').length, 0)
  assert.equal(f.lifecycleRow('2026-11-20').state, 'replay_complete')
  assert.ok(f.lifecycleRow('2026-11-20').closed_at)
  assert.equal(f.lifecycleRow('2026-07-08').state, 'replay_pending_maturity')
  // The operator path (explicit date) takes the same close.
  f.learning.sqlite.prepare(`UPDATE allocator_ev_daily_lifecycle SET state='replay_pending_maturity' WHERE business_date='2026-11-18'`).run()
  assert.match(await runAllocatorEvLifecycleWatchdog(f.env, '2026-11-18'), /lifecycle=replay_complete$/)
  assert.equal(f.lifecycleRow('2026-11-18').state, 'replay_complete')
  assert.equal(f.enqueued.length, 1, 'only the 11-23 post-pipeline recovery was enqueued')
})

test('(d) the watchdog reads the same new-L4 closure as the post-pipeline chain and writes no legacy lineage error', async () => {
  const f = fixture()
  assert.equal((await inspectL4DistributionClosure(f.env, '2026-11-23')).ready, true)
  // The chain judges the same 11-23 rows the same way: it gets past the closure gate.
  const passed = await runPostPipelineCallbackChain(f.env, { runDate: '2026-11-23', upstreamRunId: run('2026-11-23') } as any)
    .then(() => 'returned', error => String(error?.message ?? error))
  // The next gate (action authority) needs serving evidence this fixture does not seed.
  assert.equal(passed, 'post_pipeline_l4_paper_plan_missing')
  // An unscored target that carries any buy, weight or selection is not an exclusion.
  f.core.sqlite.prepare(`UPDATE daily_recommendations SET alpha_allocation=? WHERE date='2026-11-23' AND symbol='3718'`)
    .run(JSON.stringify({ ...UNSCORED_3718, selected: true }))
  const closure = await inspectL4DistributionClosure(f.env, '2026-11-23')
  assert.equal(closure.ready, false)
  await assert.rejects(runPostPipelineCallbackChain(f.env, { runDate: '2026-11-23', upstreamRunId: run('2026-11-23') } as any),
    /l4_distribution_original_plan_closure_incomplete/)
  f.stage('2026-11-23', 'post_pipeline_chain', 'error', { attempt_count: 9, last_error: 'l4_distribution_original_plan_closure_incomplete' })
  const summary = await f.tick()
  assert.match(summary, /^status=failed .*dispatched=none /)
  assert.match(summary, /2026-11-23=failed:.*l4_distribution_original_plan_closure_incomplete_date=2026-11-23_recommendations=3_expected=2_matched=2.*post_pipeline_attempts=9.*recovery_dispatch=not_queued/)
  assert.equal(f.enqueued.length, 0, 'redispatching cannot pass the closure the chain checks first')
  assert.equal(f.lifecycleRow('2026-11-23'), undefined, 'no allocator_ev_missing_point_in_time_lineage error under the new L4')
  assert.doesNotMatch(summary, /allocator_ev_missing_point_in_time_lineage|point-in-time/)
  // A closed past date is not re-judged against a head plan that has moved on.
  f.paper.sqlite.prepare('UPDATE l4_portfolio_head_v1 SET plan_id=? WHERE account_id=1').run(P1120)
  assert.equal((await inspectL4DistributionClosure(f.env, '2026-11-20')).ready, false)
  assert.match(await f.tick(), /2026-11-20=complete/)
})

test('(e) every SQL the window tick issues is an index SEARCH, never a SCAN', async () => {
  const f = fixture()
  f.lifecycle('2026-09-23', 'verify_triggered', '2026-09-25 10:00:00')
  f.stage('2026-11-23', 'post_pipeline_chain', 'error', { last_error: 'x' })
  for (const db of [f.ops, f.learning, f.paper, f.core]) db.statements.length = 0
  await f.tick()
  const plans: Array<{ line: string; sql: string }> = []
  for (const [name, db] of Object.entries({ ops: f.ops, learning: f.learning, paper: f.paper, core: f.core })) {
    for (const sql of new Set(db.statements)) {
      const params = (sql.match(/\?/g) ?? []).map(() => '2026-11-23')
      const plan = (db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(row => row.detail)
      const flat = sql.replace(/\s+/g, ' ').trim()
      plans.push({ sql: flat, line: `${name}: ${flat.slice(0, 110)} => ${plan.join(' | ')}` })
      // A one-row singleton (l4_portfolio_head_v1, account_id CHECK=1) has nothing to search.
      const scans = plan.filter(detail => /^SCAN /.test(detail) && !/^SCAN h\b/.test(detail))
      assert.deepEqual(scans, [], `${name} query must not scan: ${sql}`)
    }
  }
  if (process.env.PRINT_EXPLAIN) console.log(plans.map(p => p.line).join('\n'))
  const window = plans.filter(({ sql }) => /stage = 'pipeline_execution' AND status = 'success'|stage = 'post_pipeline_chain' AND status = 'waiting'|FROM allocator_ev_daily_lifecycle WHERE business_date >= \?|WHERE state IN|stage = 'post_pipeline_chain' AND status IN/.test(sql))
  assert.equal(window.length, 5)
  for (const { line } of window) assert.match(line, /SEARCH .* USING (?:COVERING )?INDEX/)
})

test('(f) once the next session plan is the head, an unclosed past date is reported once with its real cause', async () => {
  const f = fixture()
  const P1124 = id('4'), next = plan(P1124, '2026-11-24', { A: .02 })
  f.paper.sqlite.prepare(`INSERT INTO l4_portfolio_plans_v1(plan_id,account_id,signal_date,policy_identity,activated,allocation_snapshot_id,payload_json)
    VALUES(?,1,?,?,1,?,?)`).run(P1124, next.signal_date, next.policy_identity, SNAPSHOT, JSON.stringify(next))
  f.paper.sqlite.prepare('UPDATE l4_portfolio_head_v1 SET plan_id=? WHERE account_id=1').run(P1124)
  f.stage('2026-11-23', 'post_pipeline_chain', 'error', { attempt_count: 2, last_error: 'D1_ERROR: overloaded' })
  const first = await f.tick()
  assert.match(first, /^status=failed /)
  assert.match(first, /2026-11-23=failed:.*unrecoverable_head_advanced.*head_signal_date=2026-11-24.*post_pipeline_error=D1_ERROR:_overloaded.*manual_review_required/)
  assert.doesNotMatch(first, /closure_incomplete/)
  const second = await f.tick()
  assert.match(second, /^status=success /)
  assert.match(second, /2026-11-23=ok:.*head_advanced.*already_reported/)
  assert.equal(f.enqueued.length, 0)
})

test('(g) a date that left the window with an unfinished post-pipeline and no lifecycle row is reported once', async () => {
  const f = fixture()
  f.stage('2026-11-12', 'pipeline_execution', 'success')
  f.stage('2026-11-12', 'post_pipeline_chain', 'error', { last_error: 'x' })
  const first = await f.tick()
  assert.match(first, /outside_window_unowned=2026-11-12:post_pipeline_error /)
  const second = await f.tick()
  assert.doesNotMatch(second, /outside_window_unowned/)
  assert.match(second, /outside_window_known=1/)
})

test('(h) embedded per-date text cannot flip the tick classification, and a KV fence failure keeps the summary', async () => {
  const f = fixture()
  f.stage('2026-11-23', 'post_pipeline_chain', 'error', { last_error: 'notify not_sent: no channel; not delivered: x' })
  const summary = await f.tick()
  assert.equal(classifySchedulerRunSummary(summary), 'error')
  assert.doesNotMatch(summary, /not_sent:|not delivered:/)
  const g = fixture()
  g.lifecycle('2026-09-23', 'verify_triggered', '2026-09-25 10:00:00')
  const put = g.env.KV.put
  g.env.KV.put = async (key: string, value: string) => {
    if (key.includes('outside-window-reported')) throw new Error('KV 429')
    return put(key, value)
  }
  const kept = await g.tick()
  assert.match(kept, /outside_window_fence=unavailable outside_window_unowned=2026-09-23:verify_triggered/)
  assert.match(kept, /2026-11-23=ok:.*post_pipeline_queued/)
})

test('(i) legacy L4: the oldest replay cohort outside the window stays owned (five-session maturity outlives the window)', async () => {
  const f = fixture()
  f.kv.set('trading:config', JSON.stringify({}))
  f.lifecycle('2026-09-10', 'replay_pending_maturity', '2026-09-20 10:00:00')
  f.lifecycle('2026-07-08', 'replay_pending_maturity', '2026-07-20 10:00:00')
  const summary = await f.tick()
  // 07-08 goes through the per-date legacy path; 09-10 is reported once.
  assert.match(summary, /2026-07-08=/)
  assert.match(summary, /outside_window_unowned=2026-09-10:replay_pending_maturity /)
  assert.doesNotMatch(summary, /outside_window_unowned=[^ ]*2026-07-08/)
})
