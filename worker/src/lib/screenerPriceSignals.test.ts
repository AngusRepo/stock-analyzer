import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveScreenerStrategyRawSignals } from './marketScreener'
import { loadAdjustedGapBars, type CanonicalScreenerPrice } from './screenerMarketData'
import { deriveStockTechnicalDailyFeatures } from './stockTechnicalStrategyMaterialization'
import { adjustedGapDown, volaCv90dFromCloses, type AdjustedGapBar } from './screenerPriceSignals'

function sessionDates(count: number): string[] {
  const dates: string[] = []
  const day = new Date(Date.UTC(2025, 8, 1))
  while (dates.length < count) {
    const weekday = day.getUTCDay()
    if (weekday !== 0 && weekday !== 6) dates.push(day.toISOString().slice(0, 10))
    day.setUTCDate(day.getUTCDate() + 1)
  }
  return dates
}

function bars(count: number, closeAt: (index: number) => number): CanonicalScreenerPrice[] {
  return sessionDates(count).map((date, index) => {
    const close = closeAt(index)
    return {
      date,
      stock_id: '2330',
      Trading_Volume: 1_000_000 + (index % 7) * 50_000,
      Trading_money: close * 1_000_000,
      open: close * 0.995,
      max: close * 1.01,
      min: close * 0.985,
      close,
      spread: 0,
      Trading_turnover: 1_000,
    }
  })
}

const wave = (index: number) => 100 + 8 * Math.sin(index / 6) + index * 0.05

function hand90(closes: number[]): number {
  const window = closes.slice(-90)
  const mean = window.reduce((sum, value) => sum + value, 0) / window.length
  const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (window.length - 1)
  return Math.sqrt(variance) / mean
}

function flatten(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out)
  } else {
    out[prefix] = value
  }
  return out
}

test('volaCv90dFromCloses is std/mean over the last 90 unadjusted closes', () => {
  const closes = Array.from({ length: 120 }, (_, index) => wave(index))
  const value = volaCv90dFromCloses(closes)
  assert.ok(value != null && value > 0)
  assert.ok(Math.abs(value - hand90(closes)) < 1e-12)
  assert.equal(volaCv90dFromCloses(closes.slice(-90)), value)
  assert.equal(volaCv90dFromCloses(closes.slice(-89)), null)
  assert.equal(volaCv90dFromCloses(Array(90).fill(50)), 0)
  assert.equal(volaCv90dFromCloses(Array(90).fill(0)), null)
})

test('volaCv90d uses the sample std (pandas rolling(90).std(), ddof=1)', () => {
  // closes 1..90: mean 45.5, sample variance 90*91/12 = 682.5, population variance (90^2-1)/12 = 674.9166...
  const closes = Array.from({ length: 90 }, (_, index) => index + 1)
  const sample = Math.sqrt(682.5) / 45.5
  const population = Math.sqrt((90 * 90 - 1) / 12) / 45.5
  const value = volaCv90dFromCloses(closes)
  assert.ok(value != null)
  assert.ok(Math.abs(value - sample) < 1e-12, `expected sample-std CV ${sample}, got ${value}`)
  assert.ok(Math.abs(value - population) > 1e-3, 'population std (ddof=0) is not the FinLab reference')
})

test('screener volaCv90d reads 90 sessions from the 280-session history', () => {
  const long = bars(280, wave)
  const primary = long.slice(-70)
  const raw = deriveScreenerStrategyRawSignals(primary, undefined, undefined, undefined, long)
  const expected = hand90(long.map((row) => row.close))
  assert.ok(raw.volaCv90d != null)
  assert.ok(Math.abs(raw.volaCv90d - expected) < 1e-12)
  assert.equal((raw.technicalIndicators as Record<string, unknown>).vola_cv_90d, raw.volaCv90d)
})

test('screener volaCv90d stays null with fewer than 90 sessions', () => {
  const long = bars(89, wave)
  const primary = long.slice(-70)
  assert.equal(deriveScreenerStrategyRawSignals(primary, undefined, undefined, undefined, long).volaCv90d, null)
  assert.equal(deriveScreenerStrategyRawSignals(primary, undefined, undefined, undefined, undefined).volaCv90d, null)
  const exactly90 = bars(90, wave)
  assert.ok(deriveScreenerStrategyRawSignals(exactly90.slice(-70), undefined, undefined, undefined, exactly90).volaCv90d != null)
})

test('70-session indicators do not depend on history older than the primary window', () => {
  const longA = bars(280, wave)
  // Same last 70 sessions, different earlier 210 sessions.
  const longB = bars(280, (index) => (index < 210 ? wave(index) * 1.7 + 30 : wave(index)))
  const primary = longA.slice(-70)
  assert.deepEqual(longB.slice(-70), primary)
  const a = flatten(deriveScreenerStrategyRawSignals(primary, undefined, undefined, undefined, longA))
  const b = flatten(deriveScreenerStrategyRawSignals(primary, undefined, undefined, undefined, longB))
  const ohlcv = (rows: CanonicalScreenerPrice[]) => rows.map((row) => ({
    date: row.date, open: row.open, high: row.max, low: row.min, close: row.close, volume: row.Trading_Volume,
  }))
  const longFeatureKeys = new Set([
    ...Object.keys(deriveStockTechnicalDailyFeatures(ohlcv(longA))),
    ...Object.keys(deriveStockTechnicalDailyFeatures(ohlcv(longB))),
  ])
  const differing = Object.keys(a).filter((key) => !Object.is(a[key], b[key]))
  assert.ok(differing.includes('volaCv90d'))
  for (const key of differing) {
    const leaf = key.split('.').at(-1)!
    assert.ok(
      leaf === 'volaCv90d' || leaf === 'vola_cv_90d' || longFeatureKeys.has(leaf),
      `70-session indicator ${key} changed with older history`,
    )
  }
  for (const key of ['close', 'ma20', 'ma60', 'techRoc10', 'techGapDown', 'KLOW2', 'CNTD_20', 'VSTD_10', 'vwap5d', 'technicalIndicators.rsi14']) {
    assert.ok(key in a, `expected 70-session field ${key}`)
    assert.ok(Object.is(a[key], b[key]), `70-session field ${key} must not change`)
  }
})

test('screener keeps the 70-session primary window', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/marketScreener.ts'), 'utf8')
  assert.ok(source.includes('loadMarketDataFromD1(env, STOCK_TECHNICAL_HISTORY_PRICE_DAYS, 5, endDate)'))
  assert.ok(/\.sort\(\)\s*\.slice\(-70\)\)\s*allPrices = stockTechnicalLongPrices\.filter/.test(source))
  assert.ok(source.includes('const STOCK_TECHNICAL_HISTORY_PRICE_DAYS = 280'))
})

// Two sessions of 2330: an ex-dividend day where the unadjusted high is below the previous unadjusted low
// (a raw "gap") while the FinLab adjusted bars overlap.
function exDividendPair(): { prices: CanonicalScreenerPrice[]; adjusted: Map<string, AdjustedGapBar> } {
  const prices = bars(70, wave)
  const previous = prices[68]
  const latest = prices[69]
  Object.assign(previous, { open: 100, max: 101, min: 99, close: 100 })
  // 3.5 cash dividend: unadjusted bar opens below the previous low.
  Object.assign(latest, { open: 96.5, max: 97.5, min: 96, close: 97 })
  const adjusted = new Map<string, AdjustedGapBar>([
    [previous.date, { adjHigh: 97.5 * 1.01, adjLow: 96.5 }],
    [latest.date, { adjHigh: 97.5, adjLow: 96 }],
  ])
  return { prices, adjusted }
}

test('techGapDown uses adjusted bars: an ex-dividend drop is not a gap', () => {
  const { prices, adjusted } = exDividendPair()
  const [previous, latest] = prices.slice(-2)
  assert.ok(latest.max < previous.min, 'fixture must be a raw gap')
  const raw = deriveScreenerStrategyRawSignals(prices, undefined, undefined, undefined, prices, undefined, adjusted)
  assert.equal(raw.techGapDown, 0)
  assert.equal((raw.technicalIndicators as Record<string, unknown>).tech_gap_down, 0)
})

test('techGapDown is 1 on a gap in adjusted prices', () => {
  const { prices, adjusted } = exDividendPair()
  const [previous, latest] = prices.slice(-2)
  adjusted.set(previous.date, { adjHigh: 101, adjLow: 99 })
  adjusted.set(latest.date, { adjHigh: 97.5, adjLow: 96 })
  assert.equal(deriveScreenerStrategyRawSignals(prices, undefined, undefined, undefined, prices, undefined, adjusted).techGapDown, 1)
  assert.equal(adjustedGapDown(adjusted, latest.date, previous.date), 1)
})

test('techGapDown is null when an adjusted bar is missing, never the raw value', () => {
  const { prices, adjusted } = exDividendPair()
  const [previous, latest] = prices.slice(-2)
  const derive = (bars?: Map<string, AdjustedGapBar>) =>
    deriveScreenerStrategyRawSignals(prices, undefined, undefined, undefined, prices, undefined, bars).techGapDown
  assert.equal(derive(undefined), null)
  assert.equal(derive(new Map()), null)
  assert.equal(derive(new Map([[latest.date, adjusted.get(latest.date)!]])), null)
  assert.equal(derive(new Map([[previous.date, adjusted.get(previous.date)!]])), null)
  assert.equal(derive(new Map([...adjusted, [latest.date, { adjHigh: null, adjLow: 96 }]])), null)
  assert.equal(derive(new Map([...adjusted, [previous.date, { adjHigh: 99, adjLow: null }]])), null)
  // Adjusted bars for other sessions do not stand in for the stock's own two sessions.
  const shifted = new Map([[prices[66].date, adjusted.get(previous.date)!], [prices[67].date, adjusted.get(latest.date)!]])
  assert.equal(derive(shifted), null)
  assert.equal(adjustedGapDown(adjusted, previous.date, latest.date), null)
  assert.equal(adjustedGapDown(new Map([...adjusted, [latest.date, { adjHigh: 0, adjLow: 0 }]]), latest.date, previous.date), null)
})

type Prepared = { sql: string; params: unknown[] }

function marketEnv(all: (call: Prepared) => Promise<{ results: unknown[] }>) {
  const calls: Prepared[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const call = { sql, params }
          calls.push(call)
          return { all: () => all(call) }
        },
      }
    },
  } as unknown as D1Database
  return { env: { DB: db, MARKET_DB: db, MULTI_D1_ACTIVE_DOMAINS: 'market', MULTI_D1_STRICT: 'true' }, calls }
}

test('loadAdjustedGapBars reads FinLab adjusted high/low by symbol and date', async () => {
  const { env, calls } = marketEnv(async () => ({
    results: [
      { stock_id: '2330', date: '2026-10-29', adj_high: 1010, adj_low: 990 },
      { stock_id: '2330', date: '2026-10-30', adj_high: 985, adj_low: 970 },
      { stock_id: '1101', date: '2026-10-30', adj_high: null, adj_low: '31.5' },
    ],
  }))
  const load = await loadAdjustedGapBars(env as never, ['2026-10-30', '2026-10-28', '2026-10-29'])
  assert.equal(load.error, null)
  assert.equal(load.rows, 3)
  assert.deepEqual(load.bars.get('2330')?.get('2026-10-30'), { adjHigh: 985, adjLow: 970 })
  assert.deepEqual(load.bars.get('1101')?.get('2026-10-30'), { adjHigh: null, adjLow: 31.5 })
  assert.equal(adjustedGapDown(load.bars.get('2330'), '2026-10-30', '2026-10-29'), 1)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].params, ['2026-10-28', '2026-10-30'])
  assert.match(calls[0].sql, /FROM canonical_market_daily/)
  assert.match(calls[0].sql, /source = 'finlab\.price'/)
  assert.doesNotMatch(calls[0].sql, /stock_prices|adj_close/)
})

test('loadAdjustedGapBars degrades to no bars instead of throwing', async () => {
  const failing = marketEnv(async () => { throw new Error('D1_ERROR: overloaded') })
  const load = await loadAdjustedGapBars(failing.env as never, ['2026-10-30'])
  assert.equal(load.bars.size, 0)
  assert.equal(load.rows, 0)
  assert.match(String(load.error), /overloaded/)
  assert.equal(failing.calls.length, 3)

  const missingBinding = await loadAdjustedGapBars({ DB: undefined, MULTI_D1_ACTIVE_DOMAINS: 'market', MULTI_D1_STRICT: 'true' } as never, ['2026-10-30'])
  assert.equal(missingBinding.bars.size, 0)
  assert.ok(missingBinding.error)

  const empty = marketEnv(async () => ({ results: [] }))
  const emptyLoad = await loadAdjustedGapBars(empty.env as never, ['2026-10-30'])
  assert.deepEqual([emptyLoad.bars.size, emptyLoad.rows, emptyLoad.error], [0, 0, null])
  assert.deepEqual(await loadAdjustedGapBars(empty.env as never, []), { bars: new Map(), rows: 0, error: null })
  assert.equal(empty.calls.length, 1)

  const { prices } = exDividendPair()
  assert.equal(deriveScreenerStrategyRawSignals(prices, undefined, undefined, undefined, prices, undefined, load.bars.get('2330')).techGapDown, null)
})

test('screener loads adjusted bars outside the fatal market-data block and passes them per symbol', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/marketScreener.ts'), 'utf8')
  const fatal = source.indexOf('screener_market_data_load_failed:run_date=')
  const load = source.indexOf('await loadAdjustedGapBars(env, adjustedGapBarDates)')
  assert.ok(fatal > 0 && load > fatal, 'adjusted bar load must sit after the market-data try/catch')
  assert.ok(source.includes('adjustedGapBars.bars.get(stockId),'))
  assert.ok(/if \(adjustedGapBars\.error\) \{\s*console\.warn\(`\[screener\] adjusted_gap_bars_load_failed/.test(source),
    'a failed adjusted bar read must reach console logs, not only the truncated debug_log')
  assert.ok(source.includes('const techGapDown = adjustedGapDown(adjustedGapBars, latestOhlcv?.date, previousOhlcv?.date)'))
  assert.ok(!source.includes('latestOhlcv.high < previousOhlcv.low'))
})
