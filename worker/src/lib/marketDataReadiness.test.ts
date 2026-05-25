import { evaluateMarketDataReadiness, loadMarketDataReadinessStats } from './marketDataReadiness'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

class FakeStatement {
  private params: any[] = []

  constructor(
    private sql: string,
    private db: FakeD1,
  ) {}

  bind(...params: any[]) {
    this.params = params
    return this
  }

  async first() {
    const maxDateTable = this.sql.match(/SELECT MAX\(date\) AS latest_date FROM (\w+)/)?.[1]
    if (maxDateTable) return { latest_date: this.db.latestDates[maxDateTable] ?? null }

    const countTable = this.sql.match(/SELECT COUNT\(\*\) AS count FROM (\w+) WHERE date = \?/)?.[1]
    if (countTable) {
      const date = String(this.params[0] ?? '')
      return { count: this.db.counts[`${countTable}:${date}`] ?? 0 }
    }

    if (this.sql.includes('FROM stock_prices sp')) {
      const date = String(this.params[0] ?? '')
      return this.db.priceSegments[date] ?? { twse_rows: 0, otc_rows: 0 }
    }

    throw new Error(`unexpected fake D1 query: ${this.sql}`)
  }
}

class FakeD1 {
  latestDates: Record<string, string | null> = {}
  counts: Record<string, number> = {}
  priceSegments: Record<string, { twse_rows: number; otc_rows: number }> = {}

  prepare(sql: string) {
    return new FakeStatement(sql, this)
  }
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-04-29',
    priceRowsOnLatest: 2283,
    chipLatestDate: '2026-04-27',
    chipRowsOnLatest: 5100,
  })
  assert(!result.ok, 'stale price/chip dates must block EOD pipeline')
  assert(result.summary.includes('price latest=2026-04-29 expected=2026-04-30'), 'price date mismatch must be explicit')
  assert(result.summary.includes('chip latest=2026-04-27 expected=2026-04-30'), 'chip date mismatch must be explicit')
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-05-04',
    priceRowsOnLatest: 2283,
    priceTwseRowsOnLatest: 1085,
    priceOtcRowsOnLatest: 1198,
    chipLatestDate: '2026-05-04',
    chipRowsOnLatest: 5100,
    indicatorLatestDate: '2026-05-04',
    indicatorRowsOnLatest: 2283,
  })
  assert(!result.ok, 'newer latest date must not pass regular same-day readiness')
  assert(result.summary.includes('price latest=2026-05-04 expected=2026-04-30'), 'default latest-date mismatch must remain explicit')
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-05-04',
    priceRowsOnLatest: 2283,
    priceTwseRowsOnLatest: 1085,
    priceOtcRowsOnLatest: 1198,
    chipLatestDate: '2026-05-04',
    chipRowsOnLatest: 5100,
    indicatorLatestDate: '2026-05-04',
    indicatorRowsOnLatest: 2283,
  }, { allowHistoricalLatestAfterTarget: true })
  assert(result.ok, 'historical reruns may accept archive latest dates after target when target rows pass')
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-05-04',
    priceRowsOnLatest: 32,
    priceTwseRowsOnLatest: 20,
    priceOtcRowsOnLatest: 12,
    chipLatestDate: '2026-05-04',
    chipRowsOnLatest: 5100,
    indicatorLatestDate: '2026-05-04',
    indicatorRowsOnLatest: 2283,
  }, { allowHistoricalLatestAfterTarget: true })
  assert(!result.ok, 'historical reruns must still enforce target-date row floors')
  assert(result.summary.includes('price rows=32/1000'), 'historical row-count failure must remain explicit')
}

void (async () => {
  const db = new FakeD1()
  db.latestDates = {
    stock_prices: '2026-05-04',
    canonical_chip_daily: '2026-05-04',
    chip_data: '2026-05-04',
    technical_indicators: '2026-05-04',
  }
  db.counts = {
    'stock_prices:2026-05-04': 2283,
    'stock_prices:2026-04-30': 32,
    'canonical_chip_daily:2026-04-30': 5100,
    'technical_indicators:2026-04-30': 2283,
  }
  db.priceSegments = {
    '2026-05-04': { twse_rows: 1085, otc_rows: 1198 },
    '2026-04-30': { twse_rows: 20, otc_rows: 12 },
  }

  const stats = await loadMarketDataReadinessStats(
    db as unknown as D1Database,
    '2026-04-30',
    { allowHistoricalLatestAfterTarget: true },
  )
  assert(stats.priceLatestDate === '2026-05-04', 'historical stats must preserve global latest date')
  assert(stats.priceRowsOnLatest === 32, 'historical stats must count target-date price rows, not global latest rows')
  assert(stats.priceTwseRowsOnLatest === 20, 'historical stats must count target-date TWSE rows')
  assert(stats.priceOtcRowsOnLatest === 12, 'historical stats must count target-date OTC rows')
})().catch((e) => {
  throw e
})

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-04-30',
    priceRowsOnLatest: 32,
    chipLatestDate: '2026-04-30',
    chipRowsOnLatest: 5100,
  })
  assert(!result.ok, 'too few price rows must block pipeline even when date matches')
  assert(result.summary.includes('price rows=32/1000'), 'price row-count floor must be explicit')
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-04-30',
    priceRowsOnLatest: 1082,
    priceTwseRowsOnLatest: 1068,
    priceOtcRowsOnLatest: 14,
    chipLatestDate: '2026-04-30',
    chipRowsOnLatest: 5100,
  })
  assert(!result.ok, 'partial OTC price rows must block pipeline even when total price rows pass')
  assert(result.summary.includes('OTC price rows=14/700'), 'OTC row-count floor must be explicit')
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-04-30',
    priceRowsOnLatest: 2283,
    priceTwseRowsOnLatest: 1085,
    priceOtcRowsOnLatest: 1198,
    chipLatestDate: '2026-04-30',
    chipRowsOnLatest: 5100,
    indicatorLatestDate: '2026-04-30',
    indicatorRowsOnLatest: 32,
  })
  assert(!result.ok, 'watchlist-only indicators must block pipeline even when price/chip pass')
  assert(result.summary.includes('indicator rows=32/1000'), 'indicator row-count floor must be explicit')
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-04-30',
    priceRowsOnLatest: 2283,
    priceTwseRowsOnLatest: 1085,
    priceOtcRowsOnLatest: 1198,
    chipLatestDate: '2026-04-30',
    chipRowsOnLatest: 5100,
    indicatorLatestDate: '2026-04-29',
    indicatorRowsOnLatest: 2283,
  })
  assert(!result.ok, 'stale indicators must block pipeline even when row count passes')
  assert(result.summary.includes('indicator latest=2026-04-29 expected=2026-04-30'), 'indicator date mismatch must be explicit')
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-04-30',
    priceRowsOnLatest: 2283,
    priceTwseRowsOnLatest: 1085,
    priceOtcRowsOnLatest: 1198,
    chipLatestDate: '2026-04-30',
    chipRowsOnLatest: 5100,
    indicatorLatestDate: '2026-04-29',
    indicatorRowsOnLatest: 32,
  }, { requireIndicators: false })
  assert(result.ok, 'bulk fetch readiness should allow indicator queue to run after price/chip are ready')
}

{
  const result = evaluateMarketDataReadiness({
    targetDate: '2026-04-30',
    priceLatestDate: '2026-04-30',
    priceRowsOnLatest: 2283,
    priceTwseRowsOnLatest: 1085,
    priceOtcRowsOnLatest: 1198,
    chipLatestDate: '2026-04-30',
    chipRowsOnLatest: 5100,
    chipSourceTable: 'canonical_chip_daily',
    indicatorLatestDate: '2026-04-30',
    indicatorRowsOnLatest: 2283,
  })
  assert(result.ok, 'fresh full-market price/chip/indicator data should pass')
  assert(result.summary.includes('source=canonical_chip_daily'), 'readiness summary should expose canonical chip source')
}
