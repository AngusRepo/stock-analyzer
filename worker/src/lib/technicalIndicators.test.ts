import * as fs from 'fs'
import * as path from 'path'

import { computeAndStoreIndicators, computeTechnicalIndicators, type TechnicalIndicatorResult } from './technicalIndicators'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertApprox(actual: number | null, expected: number | null, label: string, tolerance = 1e-6): void {
  if (expected == null) {
    assert(actual == null, `${label} should be null`)
    return
  }
  assert(actual != null, `${label} should be computed`)
  assert(Math.abs(actual - expected) <= tolerance, `${label} mismatch: expected ${expected}, got ${actual}`)
}

type TechnicalIndicatorFixture = {
  caseId: string
  input: {
    closes: number[]
    highs: number[]
    lows: number[]
    volumes: number[]
  }
  expectedIndicators: TechnicalIndicatorResult
}

function loadV2Fixture(): TechnicalIndicatorFixture {
  const fixturePath = path.join(process.cwd(), 'src', 'lib', 'technicalIndicatorsV2.fixture.json')
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as TechnicalIndicatorFixture
}

function testComputeTechnicalIndicators(): void {
  const closes = Array.from({ length: 70 }, (_, i) => 100 + i)
  const highs = closes.map((close) => close + 1)
  const lows = closes.map((close) => close - 1)
  const volumes = closes.map((_, i) => 1000 + i * 25)
  const indicators = computeTechnicalIndicators(closes, highs, lows, volumes)

  assert(indicators.ma5 === 167, 'ma5 should be computed from the latest 5 closes')
  assert(indicators.ma20 === 159.5, 'ma20 should be computed from the latest 20 closes')
  assert(indicators.rsi14 === 100, 'steady uptrend should produce max RSI')
  assert(indicators.atr14 === 2, 'constant high/low range should produce stable ATR')
  assert(indicators.bbUpper != null && indicators.bbLower != null, 'bollinger bands should be present with 20 closes')
  assert(indicators.plusDi14 != null && indicators.plusDi14 > 0, 'uptrend should produce positive +DI')
  assert(indicators.minusDi14 === 0, 'steady uptrend should produce zero -DI')
  assert(indicators.adx14 != null && indicators.adx14 >= 90, 'steady uptrend should produce strong ADX')
  assert(indicators.parabolicSar != null && indicators.parabolicSar < closes[closes.length - 1], 'uptrend SAR should trail below price')
  assert(indicators.cci20 != null && indicators.cci20 > 0, 'steady uptrend should produce positive CCI')
  assert(indicators.volumeWeightedRsi14 === 100, 'volume-weighted RSI should preserve steady uptrend direction')
  assert(indicators.volumeMomentumDivergence132710 != null, 'volume momentum divergence factor should be computed')
  assert(indicators.squeezeOn === 0 || indicators.squeezeOn === 1, 'TTM squeeze state should be encoded as 0/1')
  assert(indicators.squeezeRelease === 0 || indicators.squeezeRelease === 1, 'TTM squeeze release should be encoded as 0/1')
  assert(indicators.squeezeMomentum != null && indicators.squeezeMomentum > 0, 'steady uptrend should produce positive squeeze momentum')
  assert(indicators.obvTemperature60 === 100, 'steady uptrend OBV temperature should reach the top of its 60-bar range')
}

function testAdaptiveRsiUsesInstrumentSpecificBand(): void {
  const closes: number[] = [100]
  for (let i = 1; i < 73; i++) {
    closes.push(closes[i - 1] + (i % 2 === 0 ? 0.12 : -0.12))
  }
  closes.push(closes[closes.length - 1] + 20)
  const highs = closes.map((close) => close + 0.8)
  const lows = closes.map((close) => close - 0.8)
  const volumes = closes.map((_, i) => 1000 + i * 10)

  const indicators = computeTechnicalIndicators(closes, highs, lows, volumes)

  assert(indicators.adaptiveRsiMidline50 != null, 'adaptive RSI midline should be computed with enough RSI history')
  assert(indicators.adaptiveRsiUpper50 != null, 'adaptive RSI upper band should be computed with enough RSI history')
  assert(indicators.adaptiveRsiLower50 != null, 'adaptive RSI lower band should be computed with enough RSI history')
  assert(indicators.adaptiveRsiUpper50 > indicators.adaptiveRsiMidline50, 'adaptive RSI upper band should float above its own midline')
  assert(indicators.adaptiveRsiLower50 < indicators.adaptiveRsiMidline50, 'adaptive RSI lower band should float below its own midline')
  assert(indicators.adaptiveRsiOverbought === 1, 'large stock-specific RSI jump should trigger adaptive overbought')
  assert(indicators.adaptiveRsiOversold === 0, 'large upside jump should not trigger adaptive oversold')
}

function testComputeTechnicalIndicatorsMatchesSharedV2Fixture(): void {
  const fixture = loadV2Fixture()
  const { closes, highs, lows, volumes } = fixture.input
  const indicators = computeTechnicalIndicators(closes, highs, lows, volumes)

  for (const key of Object.keys(fixture.expectedIndicators) as Array<keyof TechnicalIndicatorResult>) {
    assertApprox(indicators[key], fixture.expectedIndicators[key], `${fixture.caseId}.${key}`)
  }
}

testComputeTechnicalIndicators()
testAdaptiveRsiUsesInstrumentSpecificBand()
testComputeTechnicalIndicatorsMatchesSharedV2Fixture()

async function testComputeAndStoreIndicatorsAsOfDate(): Promise<void> {
  const executed: any[] = []
  const priceRows = Array.from({ length: 25 }, (_, i) => ({
    date: `2026-04-${String(i + 1).padStart(2, '0')}`,
    close: 100 + i,
    high: 101 + i,
    low: 99 + i,
  }))
  priceRows.push({ date: '2026-05-04', close: 999, high: 1000, low: 998 })

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async all() {
              const asOf = args[1]
              return {
                results: priceRows
                  .filter((row) => !asOf || row.date <= asOf)
                  .slice()
                  .sort((a, b) => b.date.localeCompare(a.date))
                  .slice(0, 70),
              }
            },
            async run() {
              executed.push({ sql, args })
              return {}
            },
          }
        },
      }
    },
  } as unknown as D1Database

  await computeAndStoreIndicators(db, 1, '2026-04-25')
  assert(executed.length === 1, 'indicator backfill should write one row')
  assert(executed[0].sql.includes('plus_di14'), 'indicator write should persist +DI')
  assert(executed[0].sql.includes('adx14'), 'indicator write should persist full ADX')
  assert(executed[0].sql.includes('parabolic_sar'), 'indicator write should persist Parabolic SAR')
  assert(executed[0].sql.includes('cci20'), 'indicator write should persist CCI')
  assert(executed[0].sql.includes('volume_weighted_rsi14'), 'indicator write should persist volume-weighted RSI')
  assert(executed[0].sql.includes('volume_momentum_divergence_13_27_10'), 'indicator write should persist volume momentum divergence')
  assert(executed[0].sql.includes('squeeze_on'), 'indicator write should persist TTM squeeze state')
  assert(executed[0].sql.includes('squeeze_release'), 'indicator write should persist TTM squeeze release')
  assert(executed[0].sql.includes('squeeze_momentum'), 'indicator write should persist TTM squeeze momentum')
  assert(executed[0].sql.includes('obv_temperature_60'), 'indicator write should persist OBV temperature')
  assert(executed[0].sql.includes('adaptive_rsi_midline_50'), 'indicator write should persist adaptive RSI midline')
  assert(executed[0].sql.includes('adaptive_rsi_upper_50'), 'indicator write should persist adaptive RSI upper band')
  assert(executed[0].sql.includes('adaptive_rsi_lower_50'), 'indicator write should persist adaptive RSI lower band')
  assert(executed[0].sql.includes('adaptive_rsi_overbought'), 'indicator write should persist adaptive RSI overbought flag')
  assert(executed[0].sql.includes('adaptive_rsi_oversold'), 'indicator write should persist adaptive RSI oversold flag')
  assert(executed[0].args[1] === '2026-04-25', 'indicator date must use latest price <= asOfDate')
  assert(executed[0].args[4] === 114.5, 'ma20 must not use future 2026-05-04 price')
  assert(executed[0].args.length === 30, 'indicator write should bind every technical factor column')
}

void testComputeAndStoreIndicatorsAsOfDate()
