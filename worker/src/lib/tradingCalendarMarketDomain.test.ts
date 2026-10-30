import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runAllocatorEvFeatureSnapshotBackfill } from './controllerResearchWorkflows'
import { inspectAllocatorSnapshotClosure } from './allocatorEvDailyLifecycle'
import { resolveEveningChainRunAuthority } from './eveningChainRunAuthority'
import { readFileSync } from 'node:fs'
import type { Bindings } from '../types'

// NEW-84: past sessions are confirmed from canonical_market_daily, which only the Market D1 keeps current.
const businessDate = '2026-09-04' // Friday; the next session is Monday 2026-09-07.
const sessionSql = /FROM canonical_market_daily/

function sessionDb(hasSession: boolean, binds: unknown[][] = []) {
  const db: any = {
    prepare(sql: string) {
      let args: unknown[] = []
      const statement: any = {
        bind(...values: unknown[]) { args = values; binds.push(values); return statement },
        async first() { return sessionSql.test(sql) && hasSession && args[0] === '2026-09-07' ? { present: 1 } : null },
        async all() { return { success: true, results: [] } },
        async run() { return { success: true, meta: { changes: 0 } } },
      }
      return statement
    },
    async batch() { return [] },
  }
  return db as D1Database
}

const kv = {
  async get(key: string, type?: string) {
    if (key.startsWith('market:twse_holiday_schedule:v2:')) {
      const schedule = { schemaVersion: 'twse-holiday-schedule-v2', dates: [] }
      return type === 'json' ? schedule : JSON.stringify(schedule)
    }
    return null
  },
} as unknown as KVNamespace

test('NEW-84: feature snapshot backfill resolves the next session from the Market D1', async (t) => {
  const bodies: Record<string, unknown>[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(JSON.stringify({ snapshots_built: 1, written: 0 }), { status: 200 })
  })
  const env = {
    ML_CONTROLLER_URL: 'https://controller.invalid',
    MULTI_D1_ACTIVE_DOMAINS: 'market',
    KV: kv,
    DB: sessionDb(false), // legacy DB stopped at 08-21
    MARKET_DB: sessionDb(true),
  } as unknown as Bindings
  await runAllocatorEvFeatureSnapshotBackfill(env, { startDate: businessDate, endDate: businessDate, dryRun: true })
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].next_session_date, '2026-09-07')
})

test('NEW-84: allocator snapshot closure bounds causal predictions by the Market D1 next session', async () => {
  const learningBinds: unknown[][] = []
  const empty = sessionDb(false)
  await inspectAllocatorSnapshotClosure(sessionDb(false), businessDate, {
    learningDb: sessionDb(false, learningBinds),
    opsDb: empty,
    coreDb: empty,
    marketDb: sessionDb(true),
    kv,
    nowMs: Date.parse('2026-10-29T12:00:00+08:00'),
  })
  assert.ok(learningBinds.some((args) => args.includes('2026-09-07T01:00:00.000Z')),
    'predictions query must receive the Market D1 next-session open')
})

test('NEW-84: every allocator snapshot closure caller passes the Market D1', () => {
  for (const file of ['allocatorEvDailyLifecycle.ts', 'controllerResearchWorkflows.ts', 'postMarketChain.ts']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    const calls = source.split('inspectAllocatorSnapshotClosure(env.DB,').slice(1)
    assert.ok(calls.length > 0, file)
    for (const call of calls) {
      assert.match(call.slice(0, call.indexOf('})')), /marketDb: databaseForDataDomain\(env, 'market'\)/, file)
    }
  }
})

test('NEW-84: evening-chain run authority reads the historical lineage window from the Market D1', async (t) => {
  // Thursday 2026-09-03 replayed at 01:00 TW Monday 09-07: Friday 09-04 already traded, so the
  // write window closed at its open. The legacy DB has no Friday row and would move it to Monday.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-06T17:00:00.000Z') })
  const runId = 'verify-2026-09-03-canonical'
  const db = (nextSession: string | null) => ({
    prepare(sql: string) {
      const statement: any = {
        bind() { return statement },
        async first() {
          if (sql.includes('pipeline_stage_runs')) return { queued_at: '2026-09-03 13:25:36', queued_taipei_date: '2026-09-03' }
          if (sql.includes('canonical_market_daily')) return nextSession ? { next_session_date: nextSession, present: 1 } : null
          return null
        },
      }
      return statement
    },
  }) as unknown as D1Database
  const env = {
    MULTI_D1_ACTIVE_DOMAINS: 'market,ops',
    KV: kv,
    DB: db(null), // legacy DB stopped at 08-21
    OPS_DB: db(null),
    MARKET_DB: db('2026-09-04'),
  } as unknown as Bindings
  try {
    const authority = await resolveEveningChainRunAuthority(env, { businessDate: '2026-09-03', canonicalRunId: runId })
    assert.equal(authority.nextSessionOpenUtc, '2026-09-04T01:00:00.000Z')
    assert.equal(authority.allowed, false)
  } finally { t.mock.timers.reset() }
})

test('NEW-84: the allocator EV repair window reads historical lineage from the Market D1', () => {
  const source = readFileSync(new URL('./allocatorEvDailyLifecycle.ts', import.meta.url), 'utf8')
  const calls = source.split('historicalLearningLineageDecision(').slice(1)
  assert.ok(calls.length > 0)
  for (const call of calls) assert.ok(call.startsWith("databaseForDataDomain(env, 'market'),"), call.slice(0, 60))
})
