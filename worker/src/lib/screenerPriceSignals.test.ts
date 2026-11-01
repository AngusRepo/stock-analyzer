import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveScreenerStrategyRawSignals } from './marketScreener'
import type { CanonicalScreenerPrice } from './screenerMarketData'
import { deriveStockTechnicalDailyFeatures } from './stockTechnicalStrategyMaterialization'
import { volaCv90dFromCloses } from './screenerPriceSignals'

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
