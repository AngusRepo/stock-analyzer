import assert from 'node:assert/strict'
import fs from 'node:fs'
import { afterEach, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import type { Bindings } from '../types'
import {
  DAILY_READINESS_STAGE_CATALOG,
  dailyReadinessStage,
  stageExpectedByUtc,
} from './opsChainStageCatalog'
import {
  CHAIN_STAGE_SQL,
  chainStageTransitionAllowed,
  precreateDailyReadinessChain,
  precreateDailyReadinessChainForDate,
  recordChainStage,
  writeChainStageState,
} from './opsChainStageState'
import { bindOpsRuntimeRootTicket, opsCorrelationHeaders, opsRuntimeTicket, setOpsRuntimeTicket, withOpsRuntimeScope } from './opsRuntimeScope'
import { logSchedulerRunResult } from './schedulerRunLogger'

const migration = fs.readFileSync('domain-migrations/ops/0025_ops_chain_stage_state.sql', 'utf8')
const ticketsMigration = fs.readFileSync('domain-migrations/ops/0011_scheduler_execution_tickets.sql', 'utf8')
const FRIDAY = '2026-11-20'
const MONDAY = '2026-11-23'

function sqliteOps(options: { fail?: boolean } = {}) {
  const sql = new DatabaseSync(':memory:')
  sql.exec(migration)
  sql.exec(ticketsMigration)
  const statement = (query: string) => {
    let args: any[] = []
    const guard = () => { if (options.fail) throw new Error('D1_ERROR: simulated outage') }
    const self = {
      query,
      bind(...values: any[]) { args = values; return self },
      async first() { guard(); return (sql.prepare(query).get(...args) as any) ?? null },
      async all() { guard(); return { results: sql.prepare(query).all(...args), meta: {} } },
      async run() { guard(); return { success: true, meta: { changes: Number(sql.prepare(query).run(...args).changes) } } },
    }
    return self
  }
  const db = {
    prepare: statement,
    async batch(statements: Array<ReturnType<typeof statement>>) {
      if (options.fail) throw new Error('D1_ERROR: simulated outage')
      sql.exec('BEGIN')
      try {
        const out = []
        for (const s of statements) out.push(await s.run())
        sql.exec('COMMIT')
        return out
      } catch (error) { sql.exec('ROLLBACK'); throw error }
    },
  } as unknown as D1Database
  const written = () => Number((sql.prepare('SELECT total_changes() AS n').get() as any).n)
  const row = (date: string, stage: string) => sql.prepare(
    'SELECT * FROM ops_chain_stage_state_v1 WHERE business_date=? AND chain_id=? AND stage_id=?',
  ).get(date, 'daily_readiness', stage) as Record<string, any> | undefined
  const transitions = (date: string, stage: string) => sql.prepare(
    'SELECT * FROM ops_chain_stage_transitions_v1 WHERE business_date=? AND stage_id=? ORDER BY transition_at, to_status',
  ).all(date, stage) as Array<Record<string, any>>
  return { sql, db, written, row, transitions }
}

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    async get(key: string, type?: string) {
      const value = store.get(key)
      if (value == null) return null
      return type === 'json' ? JSON.parse(value) : value
    },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  } as unknown as KVNamespace & { store: Map<string, string> }
}

/** A trading-day calendar in KV only: no TWSE fetch is reachable from these tests. */
function tradingKv(extra: Record<string, string> = {}) {
  const schedule = JSON.stringify({ schemaVersion: 'twse-holiday-schedule-v2', dates: [], loadedAt: '', source: 'test' })
  const seed: Record<string, string> = { 'market:twse_holiday_schedule:v2:2026': schedule, ...extra }
  for (const date of ['2026-11-19', FRIDAY, MONDAY, '2026-11-24', '2026-11-25']) seed[`market:twse_adhoc_closure_check:v1:${date}`] = 'open'
  return memoryKv(seed)
}

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
function forbidNetwork() {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return calls
}

const T0 = Date.parse(`${FRIDAY}T18:00:00+08:00`)

// ── catalog ───────────────────────────────────────────────────────────────────

test('catalog is exactly the Daily readiness nodes of ExecutionChainPanel with its optional flags', () => {
  const panel = fs.readFileSync('../frontend/src/components/observability/ExecutionChainPanel.tsx', 'utf8')
  const scope = panel.slice(panel.indexOf("id: 'daily_readiness',"), panel.indexOf("id: 'intraday',"))
  const columnIds = [...scope.matchAll(/\[((?:\s*'[a-z0-9-]+',?)+)\s*\]/g)]
    .flatMap(match => [...match[1].matchAll(/'([^']+)'/g)].map(id => id[1]))
  assert.deepEqual(DAILY_READINESS_STAGE_CATALOG.map(entry => entry.stageId).sort(), [...new Set(columnIds)].sort())
  assert.equal(DAILY_READINESS_STAGE_CATALOG.length, 33)
  const optionalInPanel = new Set([...panel.matchAll(/'([a-z0-9-]+)': \{ id: '[a-z0-9-]+',[^}]*optional: true/g)].map(m => m[1]))
  for (const entry of DAILY_READINESS_STAGE_CATALOG) {
    assert.equal(entry.optional, optionalInPanel.has(entry.stageId), entry.stageId)
    // Optional stages are never judged overdue; every required stage has a deadline.
    assert.equal(entry.expectedBy === null, entry.optional, entry.stageId)
  }
  assert.equal(DAILY_READINESS_STAGE_CATALOG.filter(entry => !entry.optional).length, 26)
})

test('expected_by: business-day and next-trading-day anchors, UTC day crossing, no deadline without a calendar', () => {
  const close = dailyReadinessStage('market-close-refresh')!
  assert.equal(stageExpectedByUtc(FRIDAY, close, MONDAY), '2026-11-20T10:30:00.000Z')
  // Friday's chain expects us-leading on Monday 07:00 TW = Sunday 23:00 UTC (crosses the UTC day).
  const us = dailyReadinessStage('us-leading')!
  assert.equal(stageExpectedByUtc(FRIDAY, us, MONDAY), '2026-11-22T23:00:00.000Z')
  assert.equal(stageExpectedByUtc(FRIDAY, us, null), null)
  // A calendar dayOffset rolls into the next TW day: 23:30 + 1 day.
  assert.equal(stageExpectedByUtc(FRIDAY, { expectedBy: { dayOffset: 1, tw: '01:30' } }), '2026-11-20T17:30:00.000Z')
  assert.equal(stageExpectedByUtc(FRIDAY, dailyReadinessStage('strategy-learning')!, MONDAY), null)
  assert.equal(stageExpectedByUtc('bad', close, MONDAY), null)
  assert.equal(stageExpectedByUtc(FRIDAY, { expectedBy: { dayOffset: 0, tw: '25:00' } }), null)
})

// ── EXPLAIN: every statement is a primary-key seek, never a SCAN ─────────────

test('EXPLAIN QUERY PLAN of every chain stage statement has no SCAN', () => {
  const { sql } = sqliteOps()
  for (const [name, query] of Object.entries(CHAIN_STAGE_SQL)) {
    const numbered = [...query.matchAll(/\?(\d+)/g)].map(m => Number(m[1]))
    const count = numbered.length ? Math.max(...numbered) : (query.match(/\?/g) ?? []).length
    const plan = sql.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...Array(count).fill('2026-11-20')) as Array<{ detail: string }>
    const details = plan.map(row => row.detail)
    assert.ok(details.every(detail => !/\bSCAN\b/.test(detail)), `${name}: ${details.join(' | ')}`)
    assert.ok(!details.some(detail => /TEMP B-TREE/.test(detail)), `${name}: ${details.join(' | ')}`)
  }
  // bindOpsRuntimeRootTicket reuses loadLatestSchedulerRootTicket: an index seek on (job, date, updated_at).
  const rootPlan = (sql.prepare(`EXPLAIN QUERY PLAN SELECT * FROM scheduler_execution_tickets_v1
     WHERE scheduler_job_id=? AND business_date=? AND ticket_kind='physical_root'
     ORDER BY updated_at DESC, ticket_id DESC LIMIT 1`).all('evening-chain', '2026-11-20') as Array<{ detail: string }>).map(r => r.detail)
  assert.ok(rootPlan.some(d => /SEARCH .*idx_scheduler_execution_tickets_job_date/.test(d)), rootPlan.join(' | '))
  assert.ok(rootPlan.every(d => !/\bSCAN\b/.test(d)), rootPlan.join(' | '))
})

// ── transition rules ──────────────────────────────────────────────────────────

test('transition rule: no regression, retry only on a higher attempt, success is sticky', () => {
  const prev = (status: any, attempt = 1, run_id: string | null = 'r1') => ({ status, attempt, run_id })
  assert.equal(chainStageTransitionAllowed(prev('pending', 0), { status: 'running', attempt: 0 }), true)
  assert.equal(chainStageTransitionAllowed(prev('running'), { status: 'success', attempt: 0 }), true)
  assert.equal(chainStageTransitionAllowed(prev('success'), { status: 'running', attempt: 1 }), false)
  assert.equal(chainStageTransitionAllowed(prev('error'), { status: 'running', attempt: 1 }), false)
  assert.equal(chainStageTransitionAllowed(prev('error'), { status: 'running', attempt: 2 }), true)
  assert.equal(chainStageTransitionAllowed(prev('success'), { status: 'skipped', attempt: 5 }), false)
  assert.equal(chainStageTransitionAllowed(prev('success'), { status: 'error', attempt: 1, runId: 'r1' }), false)
  assert.equal(chainStageTransitionAllowed(prev('success'), { status: 'error', attempt: 1, runId: 'r2' }), true)
  assert.equal(chainStageTransitionAllowed(prev('error'), { status: 'success', attempt: 0 }), true)
  assert.equal(chainStageTransitionAllowed(prev('error'), { status: 'skipped', attempt: 1 }), false)
  assert.equal(chainStageTransitionAllowed(prev('skipped'), { status: 'success', attempt: 0 }), true)
  assert.equal(chainStageTransitionAllowed(prev('running'), { status: 'pending', attempt: 9 }), false)
  // The same terminal status refreshes only from a newer attempt or run.
  assert.equal(chainStageTransitionAllowed(prev('error'), { status: 'error', attempt: 1, runId: 'r1' }), false)
  assert.equal(chainStageTransitionAllowed(prev('error'), { status: 'error', attempt: 2 }), true)
  assert.equal(chainStageTransitionAllowed(prev('success'), { status: 'success', attempt: 1, runId: 'r2' }), true)
  assert.equal(chainStageTransitionAllowed(prev('running'), { status: 'running', attempt: 5 }), false)
})

test('writes: status change only, no regression in D1, retry with a higher attempt, transitions appended', async () => {
  const f = sqliteOps()
  await precreateDailyReadinessChain(f.db, { businessDate: FRIDAY, nextTradingDate: MONDAY, nowMs: T0 })
  let tick = T0
  const write = (status: any, extra: Record<string, unknown> = {}, nowMs = (tick += 1000)) =>
    writeChainStageState(f.db, { businessDate: FRIDAY, stageId: 'update', status, nowMs, ...extra })
  assert.equal(await write('running', { attempt: 1, runId: 'run-a', rootTicketId: 'root-1' }), 'written')
  assert.equal(await write('running', { attempt: 1 }), 'unchanged')
  assert.equal(await write('error', { attempt: 1, error: 'boom' }), 'written')
  assert.equal(await write('running', { attempt: 1 }), 'rejected', 'same attempt cannot reopen a failed stage')
  assert.equal(await write('running', { attempt: 2 }, (tick = T0 + 120_000)), 'written', 'retry')
  assert.equal(await write('success', { summary: 'done' }, (tick = T0 + 180_000)), 'written')
  assert.equal(await write('skipped', { attempt: 9 }), 'rejected', 'success is never replaced by skipped')
  assert.equal(await write('running', { attempt: 2 }), 'rejected')
  const row = f.row(FRIDAY, 'update')!
  assert.equal(row.status, 'success')
  assert.equal(row.attempt, 2)
  assert.equal(row.root_ticket_id, null, 'the retry does not inherit the failed attempt\'s ids')
  assert.equal(row.run_id, null)
  assert.equal(row.error, null)
  assert.equal(row.started_at, new Date(T0 + 120_000).toISOString())
  assert.equal(row.completed_at, new Date(T0 + 180_000).toISOString())
  assert.deepEqual(f.transitions(FRIDAY, 'update').map(t => `${t.from_status}>${t.to_status}`),
    ['pending>running', 'running>error', 'error>running', 'running>success'])
  // A stage of a chain that was never pre-created (holiday) is not inserted.
  assert.equal(await writeChainStageState(f.db, { businessDate: '2026-11-21', stageId: 'update', status: 'success' }), 'not_precreated')
  assert.equal(f.row('2026-11-21', 'update'), undefined)
  // Compare-and-set: a row that changed after the read is not overwritten.
  const { sql } = f
  const original = sql.prepare.bind(sql)
  let raced = false
  ;(sql as any).prepare = (query: string) => {
    if (!raced && query === CHAIN_STAGE_SQL.upsert) {
      raced = true
      original(`UPDATE ops_chain_stage_state_v1 SET status='success' WHERE business_date=? AND stage_id='screener'`).run(FRIDAY)
    }
    return original(query)
  }
  // The lost race re-reads and re-decides: success from another writer is not replaced by error.
  assert.equal(await writeChainStageState(f.db, { businessDate: FRIDAY, stageId: 'screener', status: 'error', nowMs: T0 }), 'rejected')
  assert.equal(f.row(FRIDAY, 'screener')!.status, 'success')
  // A terminal write that loses to a running write is retried and lands.
  raced = false
  ;(sql as any).prepare = (query: string) => {
    if (!raced && query === CHAIN_STAGE_SQL.upsert) {
      raced = true
      original(`UPDATE ops_chain_stage_state_v1 SET status='running' WHERE business_date=? AND stage_id='verify-v2'`).run(FRIDAY)
    }
    return original(query)
  }
  assert.equal(await writeChainStageState(f.db, { businessDate: FRIDAY, stageId: 'verify-v2', status: 'success', nowMs: T0 }), 'written')
  assert.equal(f.row(FRIDAY, 'verify-v2')!.status, 'success')
  // Always losing: bounded retries, then 'conflict'.
  ;(sql as any).prepare = (query: string) => {
    if (query === CHAIN_STAGE_SQL.upsert) {
      original(`UPDATE ops_chain_stage_state_v1 SET attempt=attempt+1 WHERE business_date=? AND stage_id='adapt'`).run(FRIDAY)
    }
    return original(query)
  }
  assert.equal(await writeChainStageState(f.db, { businessDate: FRIDAY, stageId: 'adapt', status: 'running', nowMs: T0 }), 'conflict')
  ;(sql as any).prepare = original
})

test('a retry starts clean: no execution_name / run id from the failed attempt; same status refreshes', async () => {
  const f = sqliteOps()
  await precreateDailyReadinessChain(f.db, { businessDate: FRIDAY, nextTradingDate: MONDAY, nowMs: T0 })
  const at = (minutes: number) => T0 + minutes * 60_000
  const pipe = (status: any, minutes: number, extra: Record<string, unknown> = {}) =>
    writeChainStageState(f.db, { businessDate: FRIDAY, stageId: 'pipeline', status, nowMs: at(minutes), ...extra })
  assert.equal(await pipe('running', 0, { attempt: 1, executionName: 'exec-1', runId: 'run-1' }), 'written')
  assert.equal(await pipe('error', 10, { attempt: 1, error: 'oom' }), 'written')
  assert.equal(f.row(FRIDAY, 'pipeline')!.execution_name, 'exec-1', 'a terminal write keeps the execution it ended')
  assert.equal(await pipe('running', 20, { attempt: 2 }), 'written')
  const retry = f.row(FRIDAY, 'pipeline')!
  assert.equal(retry.execution_name, null)
  assert.equal(retry.run_id, null)
  assert.equal(await pipe('running', 26, { attempt: 2 }), 'heartbeat', 'a retry before Cloud Run dispatch is heartbeat-tracked')
  // error → error from a newer attempt refreshes attempt, error and completed_at.
  assert.equal(await pipe('error', 30, { attempt: 2, error: 'dispatch failed' }), 'written')
  assert.equal(await pipe('error', 31, { attempt: 2, error: 'dispatch failed again' }), 'unchanged')
  assert.equal(await pipe('running', 40, { attempt: 3 }), 'written')
  assert.equal(await pipe('error', 45, { attempt: 3, error: 'third' }), 'written')
  assert.equal(await pipe('error', 50, { attempt: 4, error: 'fourth, no running seen' }), 'written')
  const last = f.row(FRIDAY, 'pipeline')!
  assert.equal(last.attempt, 4)
  assert.equal(last.error, 'fourth, no running seen')
  assert.equal(last.completed_at, new Date(at(50)).toISOString())
  assert.deepEqual(f.transitions(FRIDAY, 'pipeline').map(t => t.to_status).slice(-2), ['error', 'error'])
})

test('heartbeat: running non-Cloud-Run stages only, at most once per 5 minutes, state table only', async () => {
  const f = sqliteOps()
  await precreateDailyReadinessChain(f.db, { businessDate: FRIDAY, nextTradingDate: MONDAY, nowMs: T0 })
  const beat = (stageId: string, minutes: number, extra: Record<string, unknown> = {}) =>
    writeChainStageState(f.db, { businessDate: FRIDAY, stageId, status: 'running', nowMs: T0 + minutes * 60_000, ...extra })
  assert.equal(await beat('indicator-queue', 0), 'written')
  const before = f.written()
  assert.equal(await beat('indicator-queue', 1), 'unchanged')
  assert.equal(await beat('indicator-queue', 4.9), 'unchanged')
  assert.equal(f.written(), before, 'throttled heartbeats write 0 rows')
  assert.equal(await beat('indicator-queue', 5.1), 'heartbeat')
  assert.equal(f.written(), before + 1)
  assert.equal(await beat('indicator-queue', 9), 'unchanged')
  assert.equal(await beat('indicator-queue', 10.2), 'heartbeat')
  assert.equal(f.row(FRIDAY, 'indicator-queue')!.heartbeat_at, new Date(T0 + 10.2 * 60_000).toISOString())
  assert.equal(f.transitions(FRIDAY, 'indicator-queue').length, 1, 'heartbeats never reach the transition log')
  // The SQL guard alone also refuses an early beat.
  const early = await f.db.prepare(CHAIN_STAGE_SQL.heartbeat)
    .bind(FRIDAY, 'daily_readiness', 'indicator-queue', new Date(T0 + 11 * 60_000).toISOString(), new Date(T0 + 6 * 60_000).toISOString()).run()
  assert.equal(early.meta.changes, 0)
  // Cloud Run stage: the execution name is recorded once, then no D1 heartbeat at all.
  assert.equal(await beat('pipeline', 0, { executionName: 'pipeline-v2-abc' }), 'written')
  assert.equal(await beat('pipeline', 30, { executionName: 'pipeline-v2-abc' }), 'unchanged')
  assert.equal(await beat('pipeline', 60), 'unchanged')
  assert.equal(await beat('pipeline', 61, { executionName: 'pipeline-v2-def' }), 'execution_name')
  const pipeline = f.row(FRIDAY, 'pipeline')!
  assert.equal(pipeline.execution_name, 'pipeline-v2-def')
  assert.equal(pipeline.heartbeat_at, null)
  // Stuck-detection inputs (P3): status, started_at, heartbeat_at, execution_name.
  const stuck = f.row(FRIDAY, 'indicator-queue')!
  assert.equal(stuck.status, 'running')
  assert.equal(stuck.started_at, new Date(T0).toISOString())
  assert.ok(stuck.expected_by)
})

test('pre-create: every catalog row pending with its UTC deadline; idempotent; retention trims one oldest date', async () => {
  const f = sqliteOps()
  await precreateDailyReadinessChain(f.db, { businessDate: '2026-10-14', nextTradingDate: '2026-10-15', nowMs: T0 })
  await precreateDailyReadinessChain(f.db, { businessDate: '2026-10-15', nextTradingDate: '2026-10-16', nowMs: T0 })
  f.sql.prepare(`INSERT INTO ops_chain_stage_transitions_v1 (business_date,chain_id,stage_id,transition_at,to_status)
    VALUES ('2026-10-14','daily_readiness','update','x','running')`).run()
  const first = await precreateDailyReadinessChain(f.db, { businessDate: FRIDAY, nextTradingDate: MONDAY, nowMs: T0 })
  assert.equal(first.inserted, 33)
  assert.equal(first.deletedState, 33, 'only the oldest date below the 35-day cutoff')
  assert.equal(first.deletedTransitions, 1)
  const again = await precreateDailyReadinessChain(f.db, { businessDate: FRIDAY, nextTradingDate: MONDAY, nowMs: T0 })
  assert.equal(again.inserted, 0)
  assert.equal(again.deletedState, 33, 'the next run removes the next oldest date')
  const rows = f.sql.prepare(`SELECT stage_id, status, optional, expected_by FROM ops_chain_stage_state_v1 WHERE business_date=?`).all(FRIDAY) as any[]
  assert.equal(rows.length, 33)
  assert.ok(rows.every(row => row.status === 'pending'))
  assert.equal(rows.find(row => row.stage_id === 'morning-setup').expected_by, '2026-11-23T00:50:00.000Z')
  assert.equal(rows.find(row => row.stage_id === 'obsidian-sync').optional, 1)
  assert.equal(rows.find(row => row.stage_id === 'obsidian-sync').expected_by, null)
})

// ── env scope, isolation, holiday, full-day budget, alert path ──────────────

function envFor(db: D1Database, kv: KVNamespace, extra: Partial<Bindings> = {}): Bindings {
  return { KV: kv, OPS_DB: db, ...extra } as unknown as Bindings
}

test('holiday: pre-create and every stage log write 0 rows', async () => {
  const calls = forbidNetwork()
  const f = sqliteOps()
  const kv = tradingKv({ 'holiday:2026-11-24': '1' })
  const env = envFor(f.db, kv)
  const start = f.written()
  assert.match(await precreateDailyReadinessChainForDate(env, '2026-11-21'), /skipped_non_trading:weekend/)
  assert.match(await precreateDailyReadinessChainForDate(env, '2026-11-24'), /skipped_non_trading:holiday_kv/)
  await withOpsRuntimeScope(env, async () => {
    for (const entry of DAILY_READINESS_STAGE_CATALOG) {
      await logSchedulerRunResult(kv, entry.stageId, { status: 'skipped', summary: 'skip: holiday', duration_ms: 0, run_date: '2026-11-24' })
    }
  })
  assert.equal(f.written(), start)
  assert.deepEqual(calls, [])
})

test('trade-date stages: a holiday-stamped run never lands on the previous chain; closures map by the calendar', async () => {
  forbidNetwork()
  // MONDAY chain expects its next trading day on 11/25; 11/24 is a holiday.
  const f = sqliteOps()
  const kv = tradingKv({ 'holiday:2026-11-24': '1' })
  const env = envFor(f.db, kv)
  await precreateDailyReadinessChain(f.db, { businessDate: MONDAY, nextTradingDate: '2026-11-25', nowMs: T0 })
  const start = f.written()
  await withOpsRuntimeScope(env, async () => {
    for (const stage of ['premarket-evidence-watchdog', 'us-leading', 'morning-setup', 'news-analyst', 'pre-market-warmup']) {
      await logSchedulerRunResult(kv, stage, { status: 'skipped', summary: 'skip: holiday', duration_ms: 0, run_date: '2026-11-24' })
    }
  })
  assert.equal(f.written(), start, 'optional (expected_by NULL) stages included')
  assert.equal(await recordChainStage({ businessDate: '2026-11-25', stageId: 'premarket-evidence-watchdog', dateKind: 'run_date',
    status: 'success' }, env), 'written')
  assert.equal(f.row(MONDAY, 'premarket-evidence-watchdog')!.status, 'success')

  // T+1 unresolved at pre-create (NULL deadlines): Saturday is refused, Monday lands on Friday.
  const g = sqliteOps()
  const kv2 = tradingKv()
  const env2 = envFor(g.db, kv2)
  await precreateDailyReadinessChain(g.db, { businessDate: FRIDAY, nextTradingDate: null, nowMs: T0 })
  assert.equal(await recordChainStage({ businessDate: '2026-11-21', stageId: 'us-leading', dateKind: 'run_date', status: 'skipped' }, env2), 'not_precreated')
  assert.equal(await recordChainStage({ businessDate: MONDAY, stageId: 'us-leading', dateKind: 'run_date', status: 'running' }, env2), 'written')
  assert.equal(g.row(FRIDAY, 'us-leading')!.status, 'running')

  // Unplanned closure: Friday's chain expected Monday, Monday then closed (typhoon); Tuesday lands on Friday.
  const h = sqliteOps()
  const kv3 = tradingKv({ [`holiday:${MONDAY}`]: '1' })
  const env3 = envFor(h.db, kv3)
  await precreateDailyReadinessChain(h.db, { businessDate: FRIDAY, nextTradingDate: MONDAY, nowMs: T0 })
  assert.equal(await recordChainStage({ businessDate: MONDAY, stageId: 'morning-setup', dateKind: 'run_date', status: 'skipped' }, env3), 'not_precreated')
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.equal(await recordChainStage({ businessDate: '2026-11-24', stageId: 'morning-setup', dateKind: 'run_date', status: 'running' }, env3), 'written')
  } finally { console.warn = warn }
  assert.equal(h.row(FRIDAY, 'morning-setup')!.status, 'running')
  // Friday's T+1 deadlines moved from the closed Monday to Tuesday; same-day ones untouched.
  assert.equal(h.row(FRIDAY, 'us-leading')!.expected_by, '2026-11-23T23:00:00.000Z')
  assert.equal(h.row(FRIDAY, 'pipeline')!.expected_by, '2026-11-24T00:00:00.000Z')
  assert.equal(h.row(FRIDAY, 'screener')!.expected_by, '2026-11-20T15:30:00.000Z')
  const settled = h.written()
  assert.equal(await recordChainStage({ businessDate: '2026-11-24', stageId: 'us-leading', dateKind: 'run_date', status: 'running' }, env3), 'written')
  assert.equal(h.written(), settled + 2, 'the next stage maps directly: state + transition only')
  // NULL deadlines (T+1 unresolved at pre-create) are filled the same way.
  assert.equal(g.row(FRIDAY, 'morning-setup')!.expected_by, '2026-11-23T00:50:00.000Z')
})

test('a state write failure never breaks the main flow', async () => {
  const f = sqliteOps({ fail: true })
  const kv = tradingKv()
  const env = envFor(f.db, kv)
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
  try {
    assert.equal(await recordChainStage({ businessDate: FRIDAY, stageId: 'update', status: 'running' }, env), 'failed')
    assert.equal(await precreateDailyReadinessChainForDate(env, FRIDAY), 'chain_state=failed')
    await withOpsRuntimeScope(env, () => logSchedulerRunResult(kv, 'update', {
      status: 'success', summary: 'ok', duration_ms: 1, run_date: FRIDAY, strict: true,
    }))
  } finally { console.warn = warn }
  assert.equal((await kv.get(`scheduler:run:update:${FRIDAY}`, 'json') as any).status, 'success', 'KV receipt still written')
  assert.ok(warnings.some(line => line.includes('[opsChainStageState] write failed (ignored)')))
  // Rollback switch: no D1 access at all.
  const g = sqliteOps()
  await precreateDailyReadinessChain(g.db, { businessDate: FRIDAY, nextTradingDate: MONDAY })
  const before = g.written()
  const off = envFor(g.db, kv, { OPS_CHAIN_STAGE_STATE_WRITES: '0' } as Partial<Bindings>)
  assert.equal(await recordChainStage({ businessDate: FRIDAY, stageId: 'update', status: 'running' }, off), 'disabled')
  assert.equal(await precreateDailyReadinessChainForDate(off, FRIDAY), 'chain_state=disabled')
  assert.equal(g.written(), before)
})

test('one full trading day of the catalog stays within 500 rows written (heartbeats and retention included)', async () => {
  forbidNetwork()
  const f = sqliteOps()
  const kv = tradingKv()
  const env = envFor(f.db, kv)
  // 35 days of history so the retention step deletes a full day as it would in steady state.
  const old = '2026-10-15'
  await precreateDailyReadinessChain(f.db, { businessDate: old, nextTradingDate: '2026-10-16' })
  for (const entry of DAILY_READINESS_STAGE_CATALOG) {
    for (const status of ['running', 'success'] as const) {
      await writeChainStageState(f.db, { businessDate: old, stageId: entry.stageId, status })
    }
  }
  const start = f.written()
  assert.match(await precreateDailyReadinessChainForDate(env, FRIDAY), /precreated:33 retention_deleted=33\+66/)
  await withOpsRuntimeScope(env, async () => {
    let clock = Date.parse(`${FRIDAY}T18:10:00+08:00`)
    const realNow = Date.now
    Date.now = () => clock
    try {
      for (const entry of DAILY_READINESS_STAGE_CATALOG) {
        const runDate = entry.sourceDate === 'trade_date' ? MONDAY : FRIDAY
        const log = (status: any) => logSchedulerRunResult(kv, entry.stageId, { status, summary: `${status}`, duration_ms: 0, run_date: runDate })
        await log('running')
        // Every stage reports progress every minute for 11 minutes: 33 x 11 min ≈ 6 h of Worker-side
        // running time, the D10 estimate for a trading day (2 heartbeats per stage).
        for (let minute = 1; minute <= 11; minute += 1) { clock += 60_000; await log('running') }
        await log('success')
        await log('success')
      }
    } finally { Date.now = realNow }
  })
  const written = f.written() - start
  assert.ok(written <= 500, `rows written ${written}`)
  const heartbeats = (f.sql.prepare(`SELECT COUNT(*) n FROM ops_chain_stage_state_v1 WHERE business_date=? AND heartbeat_at IS NOT NULL`).get(FRIDAY) as any).n
  assert.equal(heartbeats, 0, 'heartbeat_at is cleared when a stage settles')
  console.log(`[budget] one trading day: ${written} rows written`)
  const states = f.sql.prepare(`SELECT status, COUNT(*) n FROM ops_chain_stage_state_v1 WHERE business_date=? GROUP BY status`).all(FRIDAY) as any[]
  assert.deepEqual(states.map(r => `${r.status}:${r.n}`), ['pending:1', 'success:32'],
    'every scheduler-run-log stage settled (evening-closure comes from the root closure)')
  // Trade-date stages land on Friday's chain, not on Monday.
  assert.equal(f.row(FRIDAY, 'morning-setup')!.status, 'success')
  assert.equal(f.row(MONDAY, 'morning-setup'), undefined)
})

test('logSchedulerRunResult without env alerts a pipeline / morning-setup failure from the request scope', async () => {
  const calls = forbidNetwork()
  const f = sqliteOps()
  const kv = tradingKv()
  const env = envFor(f.db, kv, { DISCORD_WEBHOOK_URL: 'https://discord.test/webhook/x' } as Partial<Bindings>)
  // Outside a scope (unchanged behaviour): no env, no alert.
  await logSchedulerRunResult(kv, 'pipeline', { status: 'error', summary: 'boom', duration_ms: 0, run_date: FRIDAY })
  assert.equal(calls.length, 0)
  await precreateDailyReadinessChain(f.db, { businessDate: FRIDAY, nextTradingDate: MONDAY })
  await withOpsRuntimeScope(env, async () => {
    setOpsRuntimeTicket({ task: 'pipeline', ticketId: 'scheduler-ticket-v1-abc', rootTicketId: 'scheduler-ticket-v1-root', attempt: 1 })
    assert.deepEqual(opsCorrelationHeaders(), { 'X-Root-Ticket-Id': 'scheduler-ticket-v1-root' })
    await logSchedulerRunResult(kv, 'pipeline', { status: 'error', summary: 'boom', duration_ms: 0, run_date: FRIDAY })
    await logSchedulerRunResult(kv, 'morning-setup', { status: 'error', summary: 'setup failed', duration_ms: 0, run_date: MONDAY })
  })
  assert.equal(calls.filter(url => url === 'https://discord.test/webhook/x').length, 2)
  // Newly reachable alert sources are deduped (queue retries, callback retries) and skip replays.
  await withOpsRuntimeScope(env, async () => {
    for (let i = 0; i < 3; i++) await logSchedulerRunResult(kv, 'pipeline', { status: 'error', summary: 'boom again', duration_ms: 0, run_date: FRIDAY })
    await logSchedulerRunResult(kv, 'verify-v2', { status: 'error', summary: 'replay', duration_ms: 0, run_date: FRIDAY, run_scope: 'historical_replay' })
    await logSchedulerRunResult(kv, 'pipeline', { status: 'error', summary: 'new run', duration_ms: 0, run_date: FRIDAY, run_id: 'p-2' })
    await logSchedulerRunResult(kv, 'pipeline', { status: 'error', summary: 'new run', duration_ms: 0, run_date: FRIDAY, run_id: 'p-2' })
  })
  assert.equal(calls.filter(url => url === 'https://discord.test/webhook/x').length, 3, 'one more alert: the distinct run p-2')
  // An explicit env keeps the existing behaviour: critical tasks alert on every error.
  await logSchedulerRunResult(kv, 'pipeline', { status: 'error', summary: 'explicit', duration_ms: 0, run_date: FRIDAY }, env)
  assert.equal(calls.filter(url => url === 'https://discord.test/webhook/x').length, 4)
  const pipeline = f.row(FRIDAY, 'pipeline')!
  assert.equal(pipeline.status, 'error')
  assert.equal(pipeline.root_ticket_id, 'scheduler-ticket-v1-root')
  assert.equal(pipeline.ticket_id, 'scheduler-ticket-v1-abc')
  assert.equal(pipeline.attempt, 1)
  assert.equal(f.row(FRIDAY, 'morning-setup')!.status, 'error')
  assert.equal(f.row(FRIDAY, 'morning-setup')!.ticket_id, null, 'another task does not take this request ticket')
  assert.deepEqual(opsCorrelationHeaders(), {}, 'no scope outside the entrypoint')
})

test('queue-driven dispatch binds the evening chain root ticket, one message at a time', async () => {
  const f = sqliteOps()
  f.sql.prepare(`INSERT INTO scheduler_execution_tickets_v1 (ticket_id, dedupe_key, root_ticket_id, scheduler_job_id, task,
    business_date, run_id, attempt_id, ticket_kind, status, status_authority, attempt_count, payload_checksum)
    VALUES ('scheduler-ticket-v1-root', 'd1', 'scheduler-ticket-v1-root', 'evening-chain', 'market-close-refresh', ?,
      'run-1', 'scheduler-ticket-v1-root:attempt:1', 'physical_root', 'running', 'scheduler_http', 1, 'x')`).run(FRIDAY)
  const env = envFor(f.db, tradingKv(), { MULTI_D1_ACTIVE_DOMAINS: 'ops' } as Partial<Bindings>)
  await bindOpsRuntimeRootTicket(env, FRIDAY)
  assert.equal(opsRuntimeTicket(), undefined, 'no scope: no-op')
  await withOpsRuntimeScope(env, async () => {
    await bindOpsRuntimeRootTicket(env, FRIDAY)
    assert.deepEqual(opsCorrelationHeaders(), { 'X-Root-Ticket-Id': 'scheduler-ticket-v1-root' })
  })
  await withOpsRuntimeScope(env, async () => {
    assert.deepEqual(opsCorrelationHeaders(), {}, 'the next message starts without it')
    await bindOpsRuntimeRootTicket(env, MONDAY)
    assert.deepEqual(opsCorrelationHeaders(), {}, 'no root for that date')
  })
  const broken = envFor(sqliteOps({ fail: true }).db, tradingKv(), { MULTI_D1_ACTIVE_DOMAINS: 'ops' } as Partial<Bindings>)
  const warn = console.warn
  console.warn = () => {}
  try {
    await withOpsRuntimeScope(broken, () => bindOpsRuntimeRootTicket(broken, FRIDAY))
  } finally { console.warn = warn }
})

test('pipeline log derives ml-predict and recommendation like schedulerStatus does', async () => {
  const f = sqliteOps()
  const kv = tradingKv()
  const env = envFor(f.db, kv)
  await precreateDailyReadinessChain(f.db, { businessDate: FRIDAY, nextTradingDate: MONDAY })
  await withOpsRuntimeScope(env, async () => {
    await logSchedulerRunResult(kv, 'pipeline', { status: 'triggered', run_id: 'p1', duration_ms: 0, run_date: FRIDAY,
      summary: 'l3_sealed=true cloud_compute_stopped=true awaiting premarket' })
  })
  assert.equal(f.row(FRIDAY, 'pipeline')!.status, 'running')
  assert.equal(f.row(FRIDAY, 'ml-predict')!.status, 'success')
  assert.equal(f.row(FRIDAY, 'recommendation')!.status, 'pending')
  await withOpsRuntimeScope(env, async () => {
    await logSchedulerRunResult(kv, 'pipeline', { status: 'success', run_id: 'p1', duration_ms: 0, run_date: FRIDAY,
      summary: 'ml-predict(812 predictions) recommendations_updated=40' })
  })
  assert.equal(f.row(FRIDAY, 'pipeline')!.status, 'success')
  assert.equal(f.row(FRIDAY, 'recommendation')!.status, 'success')
  // Historical replays never touch the live chain.
  await withOpsRuntimeScope(env, async () => {
    await logSchedulerRunResult(kv, 'update', { status: 'error', duration_ms: 0, run_date: FRIDAY, summary: 'x', run_scope: 'historical_replay' })
  })
  assert.equal(f.row(FRIDAY, 'update')!.status, 'pending')
})

test('the writer and scope modules stay out of the native Paper bundle', () => {
  const bundleFiles = ['controllerClient.ts', 'paperExecutionScope.ts', 'notify.ts', 'reportDeliveryChannel.ts']
  for (const file of bundleFiles) {
    const source = fs.readFileSync(`src/lib/${file}`, 'utf8')
    assert.doesNotMatch(source, /opsChainStage|opsRuntimeScope/, file)
  }
})
