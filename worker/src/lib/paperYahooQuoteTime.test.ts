import { batchGetIntradayOHLC, parseYahooChartQuote } from './paperIntradayData'
import { refreshOpenPositionPostClosePriceCache } from './paperIntradayPriceCache'
import { sessionMarkDateIssues } from './paperValuationDate'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const SESSION = '2026-11-27'
const SAME_DAY_CLOSE = Date.parse('2026-11-27T13:30:00+08:00') / 1000
const PREVIOUS_DAY_CLOSE = Date.parse('2026-11-26T13:30:00+08:00') / 1000

class FakeKV {
  store = new Map<string, string>()
  async put(key: string, value: string): Promise<void> { this.store.set(key, value) }
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null }
}

const fakeDb = {
  prepare(sql: string) {
    assert(sql.includes('paper_positions'), 'post-close refresh reads open positions')
    return { bind: () => ({ all: async () => ({ results: [{ symbol: '2072' }] }) }) }
  },
}

const isYahoo = (url: string) => new URL(url).hostname === 'query1.finance.yahoo.com'

function yahooBody(regularMarketTime: unknown) {
  const meta: Record<string, unknown> = { regularMarketPrice: 72.6 }
  if (regularMarketTime !== undefined) meta.regularMarketTime = regularMarketTime
  return { chart: { result: [{ meta }] } }
}

/** Cold Shioaji proxy after the close: both endpoints answer 200 with no data, so Yahoo is the fallback. */
async function withFetch<T>(regularMarketTime: unknown, run: () => Promise<T>): Promise<{ result: T; urls: string[] }> {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: any) => {
    const url = String(input?.url ?? input)
    urls.push(url)
    if (isYahoo(url)) return new Response(JSON.stringify(yahooBody(regularMarketTime)), { status: 200 })
    return new Response(JSON.stringify({ data: {} }), { status: 200 })
  }) as typeof fetch
  try {
    return { result: await run(), urls }
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function postCloseIssues(regularMarketTime: unknown) {
  const kv = new FakeKV()
  const { result: refresh, urls } = await withFetch(regularMarketTime, () => refreshOpenPositionPostClosePriceCache(
    { DB: fakeDb, KV: kv, SHIOAJI_PROXY_URL: 'https://proxy.test' } as any, { tradeDate: SESSION }))
  assert(urls.some(url => isYahoo(url)), 'empty Shioaji answers must fall back to Yahoo')
  const quote = refresh.prices.get('2072')
  // Same evidence shape paperWorkerTasks builds for the daily snapshot.
  const evidence = quote ? { '2072': { price: quote.price, price_date: quote.trade_date, source: quote.source, quote_time: quote.quote_time } } : {}
  return { refresh, kv, issues: sessionMarkDateIssues(['2072'], evidence, SESSION, refresh.rejected) }
}

;(async () => {
  {
    const parsed = parseYahooChartQuote(yahooBody(SAME_DAY_CLOSE))
    assert(parsed?.price === 72.6, 'Yahoo price is kept')
    assert(parsed?.quoteTime === '2026-11-27T05:30:00.000Z', 'regularMarketTime epoch seconds becomes an ISO quote time')
    assert(parseYahooChartQuote(yahooBody(undefined))?.quoteTime === undefined, 'no regularMarketTime means no quote time')
    assert(parseYahooChartQuote(yahooBody('1764221400'))?.quoteTime === undefined, 'a non-numeric time is not date evidence')
    assert(parseYahooChartQuote(yahooBody(0))?.quoteTime === undefined, 'a zero time is not date evidence')
    assert(parseYahooChartQuote(yahooBody(Number.NaN))?.quoteTime === undefined, 'a NaN time is not date evidence')
    assert(parseYahooChartQuote(yahooBody(1e15))?.quoteTime === undefined, 'an out-of-range time is not date evidence')
    assert(parseYahooChartQuote({ chart: { result: [{ meta: { regularMarketPrice: 0 } }] } }) === null, 'a non-positive price is no quote')
    assert(parseYahooChartQuote({}) === null, 'a malformed chart is no quote')
  }

  {
    const { refresh, kv, issues } = await postCloseIssues(SAME_DAY_CLOSE)
    assert(issues.length === 0, `same-session Yahoo quote must pass the O04 mark-date check: ${JSON.stringify(issues)}`)
    assert(refresh.rejected.size === 0, 'same-session Yahoo quote is not rejected')
    assert(refresh.prices.get('2072')?.source === 'post_close_yahoo', 'source stays auditable as Yahoo')
    assert(refresh.prices.get('2072')?.quote_time === '2026-11-27T05:30:00.000Z', 'the Yahoo quote time is persisted')
    assert(kv.store.has('postclose:price:2072'), 'the dated Yahoo close is cached as post-close price')
  }

  {
    const { refresh, issues } = await postCloseIssues(PREVIOUS_DAY_CLOSE)
    assert(refresh.prices.size === 0, 'previous-session Yahoo quote must not become a post-close price')
    assert(issues.length === 1 && issues[0].issue === 'stale' && issues[0].price_date === '2026-11-26',
      `previous-session Yahoo quote must be refused as stale: ${JSON.stringify(issues)}`)
  }

  {
    const { refresh, issues } = await postCloseIssues(undefined)
    assert(refresh.prices.size === 0, 'undated Yahoo quote must not become a post-close price')
    assert(refresh.rejected.get('2072')?.quote_time === null, 'the refused quote records no time')
    assert(issues.length === 1 && issues[0].issue === 'undated', `undated Yahoo quote must stay refused: ${JSON.stringify(issues)}`)
  }

  {
    const { result: noProxy } = await withFetch(SAME_DAY_CLOSE, () => batchGetIntradayOHLC(['2072']))
    assert(noProxy.get('2072')?.quoteTime === '2026-11-27T05:30:00.000Z', 'the no-proxy Yahoo path also carries the quote time')
    assert(noProxy.get('2072')?.source === 'yahoo' && noProxy.get('2072')?.bid === undefined, 'Yahoo quotes still carry no executable book')
    const { result: broker, urls } = await withFetch(SAME_DAY_CLOSE, () => batchGetIntradayOHLC(['2072'], { requireBrokerQuote: true }))
    assert(broker.size === 0 && !urls.some(url => isYahoo(url)), 'broker-required callers never reach Yahoo')
  }

  console.log('paperYahooQuoteTime tests passed')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
