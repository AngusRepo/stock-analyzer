import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { CANONICAL_TWII_SESSION_SQL, fetchTwseSessionTwiiClose, resolveSessionTwiiClose } from './paperTwiiMark'
import { withPaperExecutionScope } from './paperExecutionScope'

function sqliteD1(sql: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      let args: unknown[] = []
      const stmt = {
        bind(...values: unknown[]) { args = values; return stmt },
        async first() { return sql.prepare(query).get(...(args as any[])) ?? null },
      }
      return stmt
    },
  } as unknown as D1Database
}

function fixture() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(readFileSync('domain-schemas/core.sql', 'utf8'))
  sql.exec(readFileSync('domain-schemas/market.sql', 'utf8'))
  // No active domains: every domain reads the legacy DB binding, here one database with both schemas.
  return { sql, env: { DB: sqliteD1(sql) } as any }
}

const twse = (rows: Array<[string, string]>) => async (input: RequestInfo | URL) => {
  assert.match(String(input), /MI_5MINS_HIST\?date=20261125&response=json$/)
  return new Response(JSON.stringify({ data: rows.map(([date, close]) => [date, '0', '0', '0', close]) }), { status: 200 })
}
const noNetwork = async () => { throw new Error('unexpected_network') }

test('market_risk of the exact session wins; another day never stands in', async () => {
  const f = fixture()
  try {
    f.sql.exec("INSERT INTO market_risk(date, twii_close, risk_score, risk_level) VALUES ('2026-11-24', 27000, 10, 'green')")
    // 11-24 exists, 11-25 does not: before 10/29 this returned 11-24's close under 11-25.
    assert.deepEqual(await resolveSessionTwiiClose(f.env, '2026-11-25', { allowNetwork: false }), { value: null, source: null })
    f.sql.exec("INSERT INTO market_risk(date, twii_close, risk_score, risk_level) VALUES ('2026-11-25', 27123.5, 10, 'green')")
    assert.deepEqual(await resolveSessionTwiiClose(f.env, '2026-11-25', { fetchImpl: noNetwork as any }), { value: 27123.5, source: 'market_risk' })
  } finally { f.sql.close() }
})

test('canonical index of the exact session is used before the network, FinLab total index first', async () => {
  const f = fixture()
  try {
    const insert = f.sql.prepare(`INSERT INTO canonical_market_index_daily(symbol, date, close, source, lineage_json, as_of_date) VALUES (?, ?, ?, ?, '{}', ?)`)
    insert.run('TWII', '2026-11-24', 26990, 'finlab.taiex_total_index', '2026-11-24')
    insert.run('TWII', '2026-11-25', 27100, 'twse.mi_5mins_hist.official', '2026-11-25')
    insert.run('TAIEX', '2026-11-25', 27101, 'finlab.taiex_total_index', '2026-11-25')
    insert.run('TWII', '2026-11-25', 1.02, 'finlab.benchmark_return', '2026-11-25')
    assert.deepEqual(await resolveSessionTwiiClose(f.env, '2026-11-25', { fetchImpl: noNetwork as any }), {
      value: 27101, source: 'canonical_market_index_daily', canonical_source: 'finlab.taiex_total_index',
    })
  } finally { f.sql.close() }
})

test('TWSE official close is taken only for the session row of the month', async () => {
  const f = fixture()
  try {
    const fetchImpl = twse([['115/11/24', '26,990.12'], ['115/11/25', '27,088.45']]) as any
    assert.deepEqual(await resolveSessionTwiiClose(f.env, '2026-11-25', { fetchImpl, allowNetwork: true }), {
      value: 27088.45, source: 'twse.mi_5mins_hist.official',
    })
    // Published month without the session yet (14:20 before TWSE posts): stays missing.
    assert.equal(await fetchTwseSessionTwiiClose('2026-11-25', twse([['115/11/24', '26,990.12']]) as any), null)
    assert.equal(await fetchTwseSessionTwiiClose('2026-11-25', (async () => new Response('', { status: 503 })) as any), null)
    assert.equal(await fetchTwseSessionTwiiClose('2026-11-25', noNetwork as any), null)
  } finally { f.sql.close() }
})

test('inside a paper execution scope the network step is skipped', async () => {
  const f = fixture()
  try {
    let fetched = 0
    const db = f.env.DB
    const ports = {
      environment: f.env, accountId: 1, nowMs: Date.parse('2026-11-25T10:00:00Z'),
      databases: { core: db, market: db }, fetchFrozen: async () => { throw new Error('sealed') },
    } as any
    const mark = await withPaperExecutionScope(ports, () => resolveSessionTwiiClose(f.env, '2026-11-25', {
      fetchImpl: (async () => { fetched += 1; return new Response('{}') }) as any,
    }))
    assert.deepEqual(mark.result, { value: null, source: null })
    assert.equal(fetched, 0)
  } finally { f.sql.close() }
})

test('canonical session lookup seeks (symbol, date); later runs never erase a stored session close', () => {
  const f = fixture()
  try {
    const plan = f.sql.prepare(`EXPLAIN QUERY PLAN ${CANONICAL_TWII_SESSION_SQL}`).all('2026-11-25').map((row) => String(row.detail))
    assert.ok(plan.some((d) => /^SEARCH canonical_market_index_daily USING (COVERING )?INDEX \w+ \(symbol=\? AND date=\?\)/.test(d)), plan.join(' | '))
    assert.ok(!plan.some((d) => /^SCAN canonical_market_index_daily/.test(d)), plan.join(' | '))
  } finally { f.sql.close() }
  const writer = readFileSync('src/lib/paperWorkerTasks.ts', 'utf8')
  assert.match(writer, /twii_value=COALESCE\(excluded\.twii_value, paper_daily_snapshots\.twii_value\)/)
  assert.match(writer, /resolveSessionTwiiClose\(env, valuationSession\)/)
  assert.doesNotMatch(writer, /FROM market_risk WHERE date <= \?/)
})
