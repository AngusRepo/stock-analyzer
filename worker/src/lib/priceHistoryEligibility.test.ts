import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  evaluatePriceHistoryGate,
  loadPrepPriceHistoryCounts,
  MIN_PRICE_ROWS_FOR_SELECTION,
  PREP_PRICE_HISTORY_SOURCE,
  PRICE_HISTORY_CONTRACT_SCHEMA,
  validatePriceHistoryContract,
} from './priceHistoryEligibility'

const ROOT = new URL('../../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8')
const contract = JSON.parse(read('schemas/price-history-eligibility-v1.json'))

test('ROSTER-PREP-60: the screener minimum is the schemas/ contract value (one owner, not KV)', () => {
  assert.equal(contract.schema_version, PRICE_HISTORY_CONTRACT_SCHEMA)
  assert.equal(MIN_PRICE_ROWS_FOR_SELECTION, contract.min_price_rows)
  assert.equal(MIN_PRICE_ROWS_FOR_SELECTION, 60)
})

test('ROSTER-PREP-60: an invalid contract fails closed instead of selecting every name', () => {
  for (const bad of [null, {}, { schema_version: 'v0', min_price_rows: 60 },
    { schema_version: PRICE_HISTORY_CONTRACT_SCHEMA },
    { schema_version: PRICE_HISTORY_CONTRACT_SCHEMA, min_price_rows: 0 },
    { schema_version: PRICE_HISTORY_CONTRACT_SCHEMA, min_price_rows: -1 },
    { schema_version: PRICE_HISTORY_CONTRACT_SCHEMA, min_price_rows: 59.5 },
    { schema_version: PRICE_HISTORY_CONTRACT_SCHEMA, min_price_rows: '60' },
    { schema_version: PRICE_HISTORY_CONTRACT_SCHEMA, min_price_rows: Number.NaN }]) {
    assert.throws(() => validatePriceHistoryContract(bad), /price_history_contract_/)
  }
  assert.equal(validatePriceHistoryContract({ schema_version: PRICE_HISTORY_CONTRACT_SCHEMA, min_price_rows: 60 }), 60)
})

test('ROSTER-PREP-60: gate drops below the contract on the long window and keeps the minimum', () => {
  const min = MIN_PRICE_ROWS_FOR_SELECTION
  // A new listing: the short scoring window is full enough, the history is one short.
  assert.equal(evaluatePriceHistoryGate(min - 1, min - 1).passed, false)
  assert.equal(evaluatePriceHistoryGate(50, min - 1).passed, false)
  assert.equal(evaluatePriceHistoryGate(50, min).passed, true)
  assert.equal(evaluatePriceHistoryGate(70, 280).passed, true)
  // The old 3-row scoring floor still applies when the history is long (e.g. a long halt).
  assert.equal(evaluatePriceHistoryGate(2, 280).passed, false)
  for (const bad of [Number.NaN, -1, 59.5, Number.POSITIVE_INFINITY]) {
    assert.equal(evaluatePriceHistoryGate(bad, 280).passed, false)
    assert.equal(evaluatePriceHistoryGate(70, bad).passed, false)
  }
  assert.deepEqual(evaluatePriceHistoryGate(40, 41).evidence, {
    price_row_count: 40,
    minimum_required_price_rows: 3,
    history_price_row_count: 41,
    minimum_required_history_price_rows: min,
    history_contract: PRICE_HISTORY_CONTRACT_SCHEMA,
    history_source: PREP_PRICE_HISTORY_SOURCE,
  })
})

test('ROSTER-PREP-60: the screener universe gate counts the prep source, not stock_prices', () => {
  const source = read('worker/src/lib/marketScreener.ts')
  assert.match(source, /import \{ evaluatePriceHistoryGate, loadPrepPriceHistoryCounts, MIN_PRICE_ROWS_FOR_SELECTION \} from '\.\/priceHistoryEligibility'/)
  assert.match(source, /const prepHistoryCounts = await loadPrepPriceHistoryCounts\(env, \[\.\.\.data\.prices\.keys\(\)\], endDate,\s*historySessions\[historySessions\.length - 1\] \?\? endDate\)/)
  assert.match(source, /const historyGate = evaluatePriceHistoryGate\(prices\.length, prepHistoryCounts\.get\(stockId\) \?\? 0\)/)
  assert.match(source, /if \(!historyGate\.passed\) \{[\s\S]*?evidence: historyGate\.evidence,/)
  assert.ok(source.indexOf('const prepHistoryCounts =') < source.indexOf('const historyGate ='))
  // The 11/24 defect: a stock_prices count (pre-listing emerging bars) is not the prep's count.
  assert.doesNotMatch(source, /evaluatePriceHistoryGate\(prices\.length, \(stockTechnicalLongData/)
  assert.doesNotMatch(source, /if \(prices\.length < 3\) \{\s*skipPriceHistory/)
})

type Bar = { stock_id: string; date: string; close: number | null }
function fakeMarket(bars: Bar[], opts: { fail?: number; sessions?: string[]; canonicalMissing?: boolean } = {}) {
  const calls: { sql: string; params: unknown[] }[] = []
  let failures = opts.fail ?? 0
  const calendar = opts.sessions ?? [...new Set(bars.map((bar) => bar.date))].sort()
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params })
          return {
            async all() {
              if (failures > 0) { failures -= 1; throw new Error('D1_ERROR: overloaded') }
              if (/WITH source AS/.test(sql)) {  // canonicalSessionIntegrity.verifiedCanonicalSessions
                const [start, end] = params as string[]
                return { results: calendar.filter((d) => d >= start && d <= end).map((session_date) => ({
                  session_date, source_count: 2000, price_count: 2000, canonical_count: opts.canonicalMissing ? 0 : 2000 })) }
              }
              if (/FROM finlab_source_sessions_v1/.test(sql)) {
                const [end, limit] = params as [string, number]
                return { results: calendar.filter((d) => d <= end).reverse().slice(0, limit).map((session_date) => ({ session_date })) }
              }
              const ranged = /date >= \?/.test(sql)
              const fixed = ranged ? 2 : 1
              const symbols = params.slice(0, params.length - fixed) as string[]
              const runDate = params[symbols.length] as string
              const fromDate = ranged ? params[symbols.length + 1] as string : null
              const counts = new Map<string, number>()
              for (const bar of bars) {
                if (!symbols.includes(bar.stock_id) || bar.date > runDate || (fromDate && bar.date < fromDate)) continue
                if (!(bar.close !== null && bar.close > 0)) continue
                counts.set(bar.stock_id, (counts.get(bar.stock_id) ?? 0) + 1)
              }
              return { results: [...counts].map(([stock_id, n]) => ({ stock_id, n })) }
            },
          }
        },
      }
    },
  } as unknown as D1Database
  return { env: { DB: db, MARKET_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'market', MULTI_D1_STRICT: 'true' }, calls }
}
const sessions = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10))
const countCalls = (calls: { sql: string; params: unknown[] }[]) => calls.filter((call) => /FROM canonical_market_daily\s+WHERE source = 'finlab\.price' AND stock_id IN/.test(call.sql))

test('ROSTER-PREP-60: prep counts are exact at the minimum, read the finlab source, and skip older rows for full names', async () => {
  const days = sessions(200)
  const runDate = days[199]
  const bars: Bar[] = [
    ...days.map((date) => ({ stock_id: 'OLD', date, close: 10 })),
    // a new listing: one row short of the minimum, plus a later row after the run date
    ...days.slice(200 - (MIN_PRICE_ROWS_FOR_SELECTION - 1)).map((date) => ({ stock_id: 'NEW', date, close: 10 })),
    { stock_id: 'NEW', date: '2026-12-31', close: 10 },
    // a halted name: few recent rows, enough history in total
    ...days.slice(0, 100).map((date) => ({ stock_id: 'HALT', date, close: 10 })),
    // bars without a positive close are not prep rows
    ...days.slice(200 - MIN_PRICE_ROWS_FOR_SELECTION).map((date, i) => ({ stock_id: 'ZERO', date, close: i === 0 ? 0 : 10 })),
  ]
  const { env, calls } = fakeMarket(bars, { sessions: days })
  const counts = await loadPrepPriceHistoryCounts(env as never, ['OLD', 'NEW', 'HALT', 'ZERO', 'NONE', 'OLD'], runDate, runDate)
  assert.equal(counts.get('OLD'), MIN_PRICE_ROWS_FOR_SELECTION)  // lower bound: already enough
  assert.equal(counts.get('NEW'), MIN_PRICE_ROWS_FOR_SELECTION - 1)
  assert.equal(counts.get('HALT'), 100)
  assert.equal(counts.get('ZERO'), MIN_PRICE_ROWS_FOR_SELECTION - 1)
  assert.equal(counts.get('NONE'), 0)
  for (const symbol of ['NEW', 'ZERO', 'NONE']) assert.equal(evaluatePriceHistoryGate(5, counts.get(symbol)!).passed, false)
  for (const symbol of ['OLD', 'HALT']) assert.equal(evaluatePriceHistoryGate(5, counts.get(symbol)!).passed, true)
  const counted = countCalls(calls)
  assert.equal(counted.length, 2)
  for (const call of counted) {
    assert.match(call.sql, /close > 0/)
    assert.doesNotMatch(call.sql, /stock_prices/)
  }
  // The window starts at the minimum-th FinLab session; only the short names get a full count.
  assert.deepEqual(counted[0].params.slice(-2), [runDate, days[200 - MIN_PRICE_ROWS_FOR_SELECTION]])
  assert.deepEqual(counted[1].params, ['HALT', 'NEW', 'NONE', 'ZERO', runDate])
})

test('ROSTER-PREP-60: the window follows the FinLab calendar, not the screener price calendar', async () => {
  // stock_prices may hold a session FinLab never had (or the reverse): the lower-bound window must be
  // the source's own last 60 sessions, or every name falls into a full-history count.
  const finlab = sessions(120).filter((_, i) => i % 7 !== 3)  // the source skips some screener dates
  const bars = finlab.map((date) => ({ stock_id: 'OLD', date, close: 10 }))
  const { env, calls } = fakeMarket(bars, { sessions: finlab })
  const counts = await loadPrepPriceHistoryCounts(env as never, ['OLD'], finlab[finlab.length - 1], finlab[finlab.length - 1])
  assert.equal(counts.get('OLD'), MIN_PRICE_ROWS_FOR_SELECTION)
  assert.equal(countCalls(calls).length, 1)  // no full-history read
})

test('ROSTER-PREP-60: a prep source without the latest session fails the run instead of dropping every name', async () => {
  const days = sessions(80)
  const bars = days.map((date) => ({ stock_id: 'OLD', date, close: 10 }))
  // FinLab has not published the screener's latest session yet.
  const behind = fakeMarket(bars, { sessions: days.slice(0, 79) })
  await assert.rejects(loadPrepPriceHistoryCounts(behind.env as never, ['OLD'], days[79], days[79]),
    /screener_price_history_source_stale:session=.*finlab_source_calendar_missing/)
  assert.equal(countCalls(behind.calls).length, 0)
  // The source session exists but its canonical bars were not written.
  const unwritten = fakeMarket(bars, { sessions: days, canonicalMissing: true })
  await assert.rejects(loadPrepPriceHistoryCounts(unwritten.env as never, ['OLD'], days[79], days[79]),
    /screener_price_history_source_stale:.*canonical_session_gap/)
})

test('ROSTER-PREP-60: a failed history read fails the screener run instead of passing or dropping names', async () => {
  const days = sessions(80)
  const bars = days.map((date) => ({ stock_id: 'OLD', date, close: 10 }))
  const failing = fakeMarket(bars, { fail: 99 })
  await assert.rejects(loadPrepPriceHistoryCounts(failing.env as never, ['OLD'], days[79], days[79]), /screener_price_history_source_stale/)
  assert.equal(failing.calls.length, 3)  // retried, then thrown
  const retried = fakeMarket(bars, { fail: 2 })
  assert.equal((await loadPrepPriceHistoryCounts(retried.env as never, ['OLD'], days[79], days[79])).get('OLD'), 60)
  // a failure after the freshness check is a load failure
  let n = 0
  const late = fakeMarket(bars)
  const base = (late.env.MARKET_DB as unknown as { prepare(sql: string): unknown }).prepare.bind(late.env.MARKET_DB)
  ;(late.env.MARKET_DB as unknown as { prepare(sql: string): unknown }).prepare = (sql: string) => {
    if (/stock_id IN/.test(sql)) { n += 1; return { bind: () => ({ all: async () => { throw new Error('D1_ERROR: reset') } }) } }
    return base(sql)
  }
  await assert.rejects(loadPrepPriceHistoryCounts(late.env as never, ['OLD'], days[79], days[79]), /screener_price_history_load_failed/)
  assert.equal(n, 3)
})

test('ROSTER-PREP-60: symbols are chunked under the D1 bound-parameter limit', async () => {
  const days = sessions(70)
  const symbols = Array.from({ length: 200 }, (_, i) => String(1000 + i))
  const { env, calls } = fakeMarket(symbols.flatMap((stock_id) => days.map((date) => ({ stock_id, date, close: 1 }))))
  const counts = await loadPrepPriceHistoryCounts(env as never, symbols, days[69], days[69])
  assert.equal(counts.size, 200)
  assert.ok([...counts.values()].every((n) => n === 60))
  assert.ok(calls.every((call) => call.params.length <= 100))
  assert.equal(countCalls(calls).length, 3)
})

test('ROSTER-PREP-60: the image keeps the contract at the depth the compiled screener requires', () => {
  const dockerfile = read('Dockerfile')
  assert.ok(dockerfile.includes('COPY schemas/price-history-eligibility-v1.json /app/schemas/price-history-eligibility-v1.json'))
  const copy = dockerfile.indexOf('COPY schemas/price-history-eligibility-v1.json')
  assert.ok(copy >= 0 && copy < dockerfile.indexOf("require('/app/worker-dist/src/lib/marketScreener.js')"))
})

test('ROSTER-PREP-60: the evening chain certifies the canonical session before it starts the screener', () => {
  const orchestrator = readFileSync(new URL('./updateOrchestrator.ts', import.meta.url), 'utf8')
  const regime = orchestrator.slice(orchestrator.indexOf('async function ensureSameDateRegimeReady('),
    orchestrator.indexOf('async function finalizeUpdateChain('))
  assert.ok(regime.indexOf('await materializeIndicatorSessions(') > 0, 'regime readiness certifies canonical sessions')
  assert.ok(regime.indexOf('await materializeIndicatorSessions(') < regime.indexOf('return summary'))
  assert.match(regime, /catch \(error\) \{[\s\S]*?throw error\s*\}/, 'a session gap stops the finalizer')
  const finalizer = orchestrator.slice(orchestrator.indexOf('async function runFinalizeContinuation('),
    orchestrator.indexOf('async function acquireFinalizeLock('))
  const certified = finalizer.indexOf('await ensureSameDateRegimeReady(env, triggerTime')
  const screener = finalizer.indexOf('await triggerCanonicalScreenerStage(env, {')
  assert.ok(certified > 0 && screener > certified, 'the screener stage starts only after canonical day-t is certified')
  const sessions = readFileSync(new URL('./indicatorSessionPrerequisite.ts', import.meta.url), 'utf8')
  assert.match(sessions, /verifiedCanonicalSessions\(db, start, date\)[\s\S]*?rows\.at\(-1\)\?\.session_date !== date[\s\S]*?throw/)
  // The watchdog only retries a stage the finalizer created; it never starts the first one.
  const watchdog = readFileSync(new URL('./screenerRecoveryWatchdog.ts', import.meta.url), 'utf8')
  assert.match(watchdog, /const canonicalRunId = await loadCanonicalChainRunId\(opsDb, businessDate\)\s*if \(!canonicalRunId\) return screenerRunMissingSummary\(/)
})
