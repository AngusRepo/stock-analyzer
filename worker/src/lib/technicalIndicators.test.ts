import { computeAndStoreIndicators, computeTechnicalIndicators } from './technicalIndicators'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function testComputeTechnicalIndicators(): void {
  const closes = Array.from({ length: 70 }, (_, i) => 100 + i)
  const highs = closes.map((close) => close + 1)
  const lows = closes.map((close) => close - 1)
  const indicators = computeTechnicalIndicators(closes, highs, lows)

  assert(indicators.ma5 === 167, 'ma5 should be computed from the latest 5 closes')
  assert(indicators.ma20 === 159.5, 'ma20 should be computed from the latest 20 closes')
  assert(indicators.rsi14 === 100, 'steady uptrend should produce max RSI')
  assert(indicators.atr14 === 2, 'constant high/low range should produce stable ATR')
  assert(indicators.bbUpper != null && indicators.bbLower != null, 'bollinger bands should be present with 20 closes')
}

testComputeTechnicalIndicators()

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
  assert(executed[0].args[1] === '2026-04-25', 'indicator date must use latest price <= asOfDate')
  assert(executed[0].args[4] === 114.5, 'ma20 must not use future 2026-05-04 price')
}

void testComputeAndStoreIndicatorsAsOfDate()
