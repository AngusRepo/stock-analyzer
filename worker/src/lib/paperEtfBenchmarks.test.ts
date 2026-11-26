import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { PAPER_CLOSURE_LOOKUP_CAP, PAPER_ETF_BENCHMARK_SQL, loadPaperEtfBenchmarks, paperValuationSessions, resetPaperValuationSessionMemory } from './paperEtfBenchmarks'

function sqliteD1(sql: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      let args: unknown[] = []
      const stmt = {
        bind(...values: unknown[]) { args = values; return stmt },
        async all() { return { results: sql.prepare(query).all(...(args as any[])) } },
      }
      return stmt
    },
  } as unknown as D1Database
}

function open(domain: 'core' | 'market'): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(`domain-schemas/${domain}.sql`, 'utf8'))
  return db
}

test('00631L 1:22 split reads as a continuous adjusted series, not -93%', async () => {
  const core = open('core')
  const market = open('market')
  try {
    core.exec(`INSERT INTO stocks(id, symbol, name) VALUES (734, '0050', '元大台灣50'), (9528, '00631L', '元大台灣50正2'), (9530, '00981A', 'x')`)
    market.exec(`
      INSERT INTO stock_prices(stock_id, date, close, adj_close) VALUES
        (9528, '2026-03-24', 443.15, 443.15),
        (9528, '2026-03-31', 19.26, 423.72),
        (9528, '2026-11-12', 30.99, 681.78),
        (9528, '2026-11-13', 31.20, NULL),
        (734, '2026-03-24', 70.0, 68.0),
        (734, '2026-11-12', 90.0, 90.0),
        (9530, '2026-03-24', 10.0, NULL),
        (9530, '2026-03-31', 11.0, NULL);
    `)
    const marks = await loadPaperEtfBenchmarks(sqliteD1(core), sqliteD1(market), ['2026-03-24', '2026-03-27', '2026-03-31', '2026-11-12', '2026-11-13', 'bad'])
    const lev = ['2026-03-24', '2026-03-31', '2026-11-12'].map((date) => marks[date]['00631L'])
    assert.deepEqual(lev, [443.15, 423.72, 681.78])
    // Only the date's own adj_close: a halt day and a day whose adj_close is not in yet stay
    // missing instead of showing an earlier mark as that day's.
    assert.equal(marks['2026-03-27']?.['00631L'], undefined)
    assert.equal(marks['2026-11-13']?.['00631L'], undefined)
    // Across the split the daily move stays within a normal range (raw close would be -95.7%).
    assert.ok(Math.abs(lev[1] / lev[0] - 1) < 0.10)
    assert.ok(lev[2] / lev[0] - 1 > 0.5)
    // 0050 is on the same adjusted basis.
    assert.equal(marks['2026-03-24']['0050'], 68.0)
    // A missing adj_close stays missing: no fallback to the raw close scale.
    assert.equal(marks['2026-03-24']['00981A'], undefined)
    assert.equal(marks['2026-03-31']?.['00981A'], undefined)
  } finally {
    core.close()
    market.close()
  }
})

test('benchmark marks are one (stock_id, date) lookup per pair and never scan stock_prices', () => {
  const market = open('market')
  try {
    const details = market.prepare(`EXPLAIN QUERY PLAN ${PAPER_ETF_BENCHMARK_SQL(3, 4)}`)
      .all('2026-03-24', '2026-03-31', '2026-11-12', 734, 9528, 9530, 9527).map((row) => String(row.detail))
    const text = details.join(' | ')
    assert.ok(details.some((d) => /^SEARCH sp USING INDEX (idx_prices_stock_date|sqlite_autoindex_stock_prices_1) \(stock_id=\? AND date=\?\)/.test(d)), text)
    assert.ok(!details.some((d) => /^SCAN (sp|stock_prices)\b|TEMP B-TREE FOR ORDER BY.*sp|AUTOMATIC/.test(d)), text)
  } finally {
    market.close()
  }
})

test('closure rows read their valuation session, the same one 0050 and TWII are marked on', async () => {
  resetPaperValuationSessionMemory()
  const holidays = new Set(['2026-07-10', '2026-07-09'])
  const gets: string[] = []
  const kv = { get: async (key: string) => { gets.push(key); return holidays.has(key.slice('holiday:'.length)) ? '1' : null } }
  const sessions = await paperValuationSessions(kv as any, ['2026-07-08', '2026-07-10', '2026-07-11', 'bad'])
  assert.equal(sessions.get('2026-07-08'), '2026-07-08')
  assert.equal(sessions.get('2026-07-10'), '2026-07-08', 'holiday row -> previous non-holiday weekday')
  assert.equal(sessions.get('2026-07-11'), '2026-07-08', 'Saturday row walks back past both closures')
  assert.ok(!sessions.has('bad'))
  assert.equal((await paperValuationSessions(null, ['2026-07-10'])).get('2026-07-10'), '2026-07-10')

  const core = open('core')
  const market = open('market')
  try {
    core.exec(`INSERT INTO stocks(id, symbol, name) VALUES (734, '0050', '元大台灣50'), (9528, '00631L', '元大台灣50正2')`)
    market.exec(`
      INSERT INTO stock_prices(stock_id, date, close, adj_close) VALUES
        (734, '2026-07-08', 90.0, 90.0),
        (9528, '2026-07-08', 30.0, 660.0),
        (734, '2026-07-13', 91.0, 91.0),
        (9528, '2026-07-13', 31.0, NULL);
    `)
    resetPaperValuationSessionMemory()
    gets.length = 0
    const marks = await loadPaperEtfBenchmarks(sqliteD1(core), sqliteD1(market), ['2026-07-08', '2026-07-10', '2026-07-13'], ['0050', '00631L'], kv as any)
    assert.deepEqual(marks['2026-07-10'], { '0050': 90.0, '00631L': 660.0 }, 'closure row reads its valuation session, like benchmark_value/twii_value')
    assert.deepEqual(marks['2026-07-08'], { '0050': 90.0, '00631L': 660.0 })
    assert.deepEqual(marks['2026-07-13'], { '0050': 91.0 }, 'a traded row without its own adj_close for one ETF leaves only that ETF missing')
    // Dates with a benchmark price row traded: only 07-10 (and its walk back over 07-09) needs KV.
    assert.deepEqual(gets.sort(), ['holiday:2026-07-09', 'holiday:2026-07-10'])
  } finally {
    core.close()
    market.close()
  }
})

test('a failing holiday lookup never fails /pnl: that date counts as traded and is not remembered', async () => {
  resetPaperValuationSessionMemory()
  let fail = true
  const kv = { get: async () => { if (fail) throw new Error('KV 503'); return '1' } }
  const first = await paperValuationSessions(kv as any, ['2026-07-10'])
  assert.equal(first.get('2026-07-10'), '2026-07-10')
  fail = false
  const second = await paperValuationSessions(kv as any, ['2026-07-10'])
  assert.notEqual(second.get('2026-07-10'), '2026-07-10', 'the failure was not cached; the closure is seen once KV answers')

  const core = open('core')
  const market = open('market')
  try {
    core.exec(`INSERT INTO stocks(id, symbol, name) VALUES (734, '0050', 'x')`)
    market.exec(`INSERT INTO stock_prices(stock_id, date, close, adj_close) VALUES (734, '2026-07-09', 90.0, 90.0)`)
    resetPaperValuationSessionMemory()
    const broken = { get: async () => { throw new Error('KV 503') } }
    const marks = await loadPaperEtfBenchmarks(sqliteD1(core), sqliteD1(market), ['2026-07-09', '2026-07-10'], ['0050'], broken as any)
    assert.deepEqual(marks['2026-07-09'], { '0050': 90.0 })
    assert.equal(marks['2026-07-10'], undefined)
  } finally {
    core.close()
    market.close()
  }
})

test('only recorded closures are remembered; a later holiday key is still seen', async () => {
  resetPaperValuationSessionMemory()
  const store = new Map<string, string>()
  let reads = 0
  const kv = { get: async (key: string) => { reads += 1; return store.get(key) ?? null } }
  assert.equal((await paperValuationSessions(kv as any, ['2026-07-10'])).get('2026-07-10'), '2026-07-10')
  store.set('holiday:2026-07-10', '巴威颱風休市')
  assert.equal((await paperValuationSessions(kv as any, ['2026-07-10'])).get('2026-07-10'), '2026-07-09')
  const before = reads
  await paperValuationSessions(kv as any, ['2026-07-10'])
  assert.equal(reads - before, 1, 'the closure itself is remembered; only its walk-back day (07-09) is read again')
})

test('closure lookups per call are capped', async () => {
  resetPaperValuationSessionMemory()
  let reads = 0
  const kv = { get: async () => { reads += 1; return null } }
  const dates = Array.from({ length: 200 }, (_, i) => new Date(Date.parse('2026-01-05T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10))
  await paperValuationSessions(kv as any, dates)
  assert.equal(reads, PAPER_CLOSURE_LOOKUP_CAP)
})
