import {
  loadScreenerPriceRowsPaged,
  splitPriceRowsByBoard,
  type ScreenerPriceRow,
} from './screenerMarketData'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const rows: ScreenerPriceRow[] = [
  {
    symbol: '3585',
    market: 'OTC',
    date: '2026-04-30',
    open: null,
    high: 146.5,
    low: 113.5,
    close: 122.5,
    volume: 8119423,
    avg_price: 126.56,
  },
  {
    symbol: '7820',
    market: 'OTC',
    date: '2026-04-24',
    open: null,
    high: 180,
    low: 150,
    close: 183,
    volume: 1000,
    avg_price: 170,
  },
  {
    symbol: '7820',
    market: 'OTC',
    date: '2026-05-04',
    open: 144,
    high: 154.5,
    low: 144,
    close: 152,
    volume: 541991,
    avg_price: null,
  },
]

const result = splitPriceRowsByBoard(rows)

assert(
  !result.emergingResearchPrices.some((row) => row.stock_id === '3585'),
  '3585 latest avg-price-only row should not consume emerging research capacity',
)
assert(
  !result.allPrices.some((row) => row.stock_id === '3585'),
  '3585 must not enter tradable lane when latest row is emerging-style',
)
assert(
  result.allPrices.filter((row) => row.stock_id === '7820').length === 2,
  '7820 should keep its full price history in tradable lane after latest row becomes executable OTC',
)
assert(
  !result.emergingResearchPrices.some((row) => row.stock_id === '7820'),
  '7820 historical emerging-style rows must not leak into emerging lane after OTC listing',
)
assert(result.laneCounts.tradable === 1, 'only 7820 should count as tradable')
assert(result.laneCounts.emerging_watchlist === 0, 'emerging research lane should stay disabled')
assert(result.laneCounts.research_only === 1, '3585 should count as research-only after emerging retirement')

const staleMisclassifiedEmerging = splitPriceRowsByBoard([
  {
    symbol: '3184',
    market: 'OTC',
    date: '2026-07-01',
    open: 16,
    high: 16.5,
    low: 15.8,
    close: 16.1,
    volume: 100000,
    avg_price: 16.1,
  },
  {
    symbol: '2330',
    market: 'TWSE',
    date: '2026-08-04',
    open: 1200,
    high: 1210,
    low: 1190,
    close: 1205,
    volume: 1000000,
    avg_price: 1203,
  },
  {
    symbol: '2330',
    market: 'TWSE',
    date: '2026-08-05',
    open: 1205,
    high: 1220,
    low: 1200,
    close: 1215,
    volume: 1200000,
    avg_price: 1212,
  },
], '2026-08-05')

assert(!staleMisclassifiedEmerging.allPrices.some((row) => row.stock_id === '3184'), 'stale 7/1 symbol must not enter the 8/5 L0 universe even when stocks.market says OTC')
assert(staleMisclassifiedEmerging.allPrices.filter((row) => row.stock_id === '2330').length === 2, 'fresh symbols should retain their PIT history after the latest-date gate')
assert(staleMisclassifiedEmerging.laneCounts.stale_excluded === 1, 'stale symbol exclusion must be explicit telemetry')

async function assertPagedPriceLoader(): Promise<void> {
  const calls: Array<[string, string]> = []
  let firstAttempt = true
  let activeCalls = 0
  let maxActiveCalls = 0
  const marketDb = {
    prepare: () => ({
      bind: (minDate: string, maxDate: string) => ({
        all: async () => {
          calls.push([minDate, maxDate])
          activeCalls += 1
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
          await new Promise((resolve) => setTimeout(resolve, 5))
          activeCalls -= 1
          if (firstAttempt) {
            firstAttempt = false
            throw new Error('HTTP 504')
          }
          return {
            results: [{
              stock_id: 1,
              date: maxDate,
              open: 1,
              high: 1,
              low: 1,
              close: 1,
              volume: 1,
              avg_price: 1,
            }],
          }
        },
      }),
    }),
  } as unknown as D1Database
  const coreDb = {
    prepare: () => ({
      bind: (...ids: number[]) => ({
        all: async () => ({
          results: ids.map((id) => ({ id, symbol: `TEST-${id}`, name: `Test ${id}`, market: 'TWSE', sector: 'Test' })),
        }),
      }),
    }),
  } as unknown as D1Database
  const fakeEnv = {
    DB: coreDb,
    CORE_DB: coreDb,
    MARKET_DB: marketDb,
    MULTI_D1_ACTIVE_DOMAINS: 'core,market',
    MULTI_D1_STRICT: 'true',
  }
  const dates = Array.from({ length: 12 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')}`)
  const paged = await loadScreenerPriceRowsPaged(fakeEnv, dates)
  assert(paged.length === 3, 'twelve trading dates must load through three bounded pages')
  assert(calls.length === 4, 'one transient page failure must retry without replaying completed pages')
  assert(maxActiveCalls === 3, 'price pages must use bounded concurrency of three')
  const callCounts = new Map<string, number>()
  for (const [minDate, maxDate] of calls) {
    const key = `${minDate}|${maxDate}`
    callCounts.set(key, (callCounts.get(key) ?? 0) + 1)
  }
  assert(callCounts.get('2026-08-01|2026-08-05') === 2, 'failed first page must retry exactly once')
  assert(callCounts.get('2026-08-06|2026-08-10') === 1, 'completed middle page must not replay')
  assert(callCounts.get('2026-08-11|2026-08-12') === 1, 'remaining dates must load once')
}

assertPagedPriceLoader().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
