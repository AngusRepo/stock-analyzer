import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertMarketDataReady, evaluateMarketDataReadiness, type MarketDataReadinessStats } from './marketDataReadiness'

const READY: MarketDataReadinessStats = {
  targetDate: '2026-10-28',
  priceLatestDate: '2026-10-28',
  priceRowsOnLatest: 2203,
  priceTwseRowsOnLatest: 1100,
  priceOtcRowsOnLatest: 1000,
  priceBaselineDate: '2026-10-27',
  priceRowsOnBaseline: 2204,
  chipLatestDate: '2026-10-28',
  chipRowsOnLatest: 2300,
  marginLatestDate: '2026-10-28',
  marginRowsOnLatest: 2102,
}

test('HL1-4#c: partial price ingestion above the row floors passes but is reported', () => {
  const full = evaluateMarketDataReadiness(READY, { requireIndicators: false, requireMargin: true })
  assert.equal(full.ok, true)
  assert.deepEqual(full.warnings, [])
  assert.doesNotMatch(full.summary, /coverage_warn/)

  const partial = evaluateMarketDataReadiness(
    { ...READY, priceRowsOnLatest: 1700, priceTwseRowsOnLatest: 950, priceOtcRowsOnLatest: 750 },
    { requireIndicators: false, requireMargin: true },
  )
  assert.equal(partial.ok, true, 'coverage is warn-only and never blocks the chain')
  assert.deepEqual(partial.errors, [])
  assert.equal(partial.warnings.length, 1)
  assert.match(partial.summary, /coverage_warn: price coverage=1700\/2204 \(0\.771 < 0\.98\) 2026-10-28 vs 2026-10-27/)

  // The threshold is an option, not a constant.
  assert.deepEqual(evaluateMarketDataReadiness(
    { ...READY, priceRowsOnLatest: 1700, priceTwseRowsOnLatest: 950, priceOtcRowsOnLatest: 750 },
    { requireIndicators: false, minPriceCoverageRatio: 0.7 },
  ).warnings, [])
  // No baseline session: nothing to compare.
  assert.deepEqual(evaluateMarketDataReadiness({ ...READY, priceRowsOnLatest: 1700, priceRowsOnBaseline: 0 },
    { requireIndicators: false }).warnings, [])
  assert.deepEqual(evaluateMarketDataReadiness({ ...READY, priceRowsOnLatest: 1700, priceBaselineDate: undefined },
    { requireIndicators: false }).warnings, [])
})

test('HL1-4#c: a not-ready summary keeps its exact failure text', () => {
  const stale = evaluateMarketDataReadiness(
    { ...READY, priceRowsOnLatest: 900, priceTwseRowsOnLatest: 900, priceOtcRowsOnLatest: 0 },
    { requireIndicators: false },
  )
  assert.equal(stale.ok, false)
  assert.equal(stale.summary, 'market data not ready: price rows=900/1000; OTC price rows=0/700')
  assert.equal(stale.warnings.length, 1, 'the warning is still returned to callers')
})

type Counts = { prices: Record<string, number>; margin: Record<string, number> }

function fakeEnv(counts: Counts, extra: Record<string, unknown> = {}, failBaseline = false, failLog = false) {
  const store = new Map<string, string>()
  const logs: { level: string; cron: string; message: string; meta: any }[] = []
  const tableCounts = (sql: string) => /margin_data/.test(sql) ? counts.margin : /stock_prices/.test(sql) ? counts.prices : {}
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = []
      const statement = {
        bind(...values: unknown[]) { binds = values; return statement },
        async run() {
          if (!/INSERT INTO system_logs/.test(sql)) throw new Error(`unexpected run(): ${sql}`)
          if (failLog) throw new Error('D1_ERROR: system_logs insert')
          logs.push({ level: String(binds[0]), cron: String(binds[1]), message: String(binds[2]), meta: JSON.parse(String(binds[3])) })
          return { success: true }
        },
        async first() {
          const rows = tableCounts(sql)
          if (/WHERE date IN \(SELECT DISTINCT date/.test(sql)) {
            if (failBaseline) throw new Error('D1_ERROR: baseline lookup')
            const window = Object.keys(rows).filter((date) => date < String(binds[0])).sort().slice(-Number(binds[1]))
            const best = window.sort((a, b) => rows[b] - rows[a] || b.localeCompare(a))[0]
            return best ? { date: best, count: rows[best] } : null
          }
          if (/SELECT MAX\(date\)/.test(sql)) return { latest_date: Object.keys(rows).sort().at(-1) ?? null }
          if (/COUNT\(\*\)/.test(sql)) return { count: rows[String(binds[0])] ?? (/chip_data|technical/.test(sql) ? 2300 : 0) }
          throw new Error(`unexpected first(): ${sql}`)
        },
        async all() {
          if (/FROM stock_prices/.test(sql)) {
            const n = counts.prices[String(binds[0])] ?? 0
            return { results: Array.from({ length: n }, (_, i) => ({ stock_id: i + 1 })) }
          }
          if (/FROM stocks/.test(sql)) {
            return { results: binds.map((id) => ({ id, symbol: String(id), market: Number(id) % 2 ? 'TWSE' : 'OTC' })) }
          }
          throw new Error(`unexpected all(): ${sql}`)
        },
      }
      return statement
    },
  }
  return {
    store,
    logs,
    env: {
      DB: db,
      KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v) } },
      ...extra,
    } as any,
  }
}

test('HL1-4#c: readiness alerts a shrunken price session once per date and never blocks', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }))
  const { env, store, logs } = fakeEnv({ prices: { '2026-10-27': 2204, '2026-10-28': 1900 }, margin: { '2026-10-28': 2102 } })
  const first = await assertMarketDataReady(env, '2026-10-28', { requireIndicators: false })
  assert.equal(first.ok, true)
  assert.equal(first.stats.priceRowsOnBaseline, 2204)
  assert.match(first.summary, /coverage_warn: price coverage=1900\/2204/)
  await assertMarketDataReady(env, '2026-10-28', { requireIndicators: false })
  assert.equal(logs.length, 1, 'evening readiness, bulk fetch and ML trigger share one alert per date')
  assert.match(logs[0].message, /price coverage=1900\/2204/)
  assert.equal(store.has('cron:alert:market-data-coverage:2026-10-28:price'), true)
  assert.equal(fetchMock.mock.callCount(), 0, 'no notify channel is called')

  const { env: tuned } = fakeEnv({ prices: { '2026-10-27': 2204, '2026-10-28': 1900 }, margin: {} },
    { MARKET_DATA_PRICE_COVERAGE_MIN_RATIO: '0.7' })
  assert.deepEqual((await assertMarketDataReady(tuned, '2026-10-28', { requireIndicators: false })).warnings, [])

  // A failed system_logs insert never blocks readiness.
  const { env: down } = fakeEnv({ prices: { '2026-10-27': 2204, '2026-10-28': 1900 }, margin: {} }, {}, false, true)
  assert.equal((await assertMarketDataReady(down, '2026-10-28', { requireIndicators: false })).ok, true)
})

test('DQ alerts leave a system_logs record and call no notify channel', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }))
  const { env, logs, store } = fakeEnv(
    { prices: { '2026-10-27': 2204, '2026-10-28': 1900 }, margin: { '2026-10-28': 2102 } },
  )
  const result = await assertMarketDataReady(env, '2026-10-28', { requireIndicators: false, requireMargin: true })
  assert.equal(result.ok, true)
  assert.equal(fetchMock.mock.callCount(), 0, 'nothing is sent anywhere')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].level, 'warn')
  assert.equal(logs[0].cron, 'market-data-coverage')
  assert.match(logs[0].message, /price coverage=1900\/2204/)
  assert.deepEqual(logs[0].meta, { target_date: '2026-10-28', warnings: result.warnings, blocking: false })
  assert.equal(store.has('cron:alert:market-data-coverage:2026-10-28:price'), true)
  await assertMarketDataReady(env, '2026-10-28', { requireIndicators: false, requireMargin: true })
  assert.equal(logs.length, 1, 'repeat readiness calls of the same date and kind are not re-recorded')
  // Without KV there is no dedup, so every trigger is recorded.
  const { env: noKv, logs: noKvLogs } = fakeEnv(
    { prices: { '2026-10-27': 2204, '2026-10-28': 1900 }, margin: {} }, { KV: undefined })
  await assertMarketDataReady(noKv, '2026-10-28', { requireIndicators: false })
  await assertMarketDataReady(noKv, '2026-10-28', { requireIndicators: false })
  assert.equal(noKvLogs.length, 2)
  // A failing KV read, rejected or thrown synchronously, still leaves the record and never blocks.
  for (const get of [async () => { throw new Error('KV down') }, () => { throw new Error('KV down') }]) {
    const { env: kvDown, logs: kvDownLogs } = fakeEnv({ prices: { '2026-10-27': 2204, '2026-10-28': 1900 }, margin: {} },
      { KV: { get, put: () => { throw new Error('KV down') } } })
    assert.equal((await assertMarketDataReady(kvDown, '2026-10-28', { requireIndicators: false })).ok, true)
    assert.equal(kvDownLogs.length, 1)
  }
})

test('HL1-4#c: a loss that persists keeps warning against the fullest recent session', async () => {
  const prices = { '2026-10-22': 2191, '2026-10-27': 2204, '2026-10-28': 1900, '2026-10-29': 1902 }
  const { env } = fakeEnv({ prices, margin: {} })
  const second = await assertMarketDataReady(env, '2026-10-29', { requireIndicators: false })
  assert.equal(second.stats.priceBaselineDate, '2026-10-27', 'the shrunken day before is not the baseline')
  assert.match(second.summary, /price coverage=1902\/2204/)
  // The window is configurable: with one session the shrunken day becomes the baseline.
  const { env: oneSession } = fakeEnv({ prices, margin: {} },
    { MARKET_DATA_COVERAGE_BASELINE_SESSIONS: '1' })
  assert.deepEqual((await assertMarketDataReady(oneSession, '2026-10-29', { requireIndicators: false })).warnings, [])
})

test('HL1-4#c: a failed baseline lookup gives no warning and never blocks readiness', async () => {
  const { env, logs } = fakeEnv({ prices: { '2026-10-27': 2204, '2026-10-28': 1900 }, margin: {} }, {}, true)
  const result = await assertMarketDataReady(env, '2026-10-28', { requireIndicators: false })
  assert.equal(result.ok, true)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.stats.priceRowsOnBaseline, 0)
  assert.equal(logs.length, 0)
})
