import { batchGetIntradayOHLC, normalizeShioajiSnapshot } from './paperIntradayData'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const quote = normalizeShioajiSnapshot({
    price: 299.5,
    open: 305,
    high: 305,
    low: 305,
  })
  assert(quote?.last === 305, 'snapshot price below intraday low must not become executable last price')
  assert(quote.low === 305 && quote.high === 305, 'snapshot OHLC should be preserved')
}

{
  const quote = normalizeShioajiSnapshot({
    close: 299.5,
    open: 305,
    high: 305,
    low: 305,
  })
  assert(quote?.last === 305, 'snapshot close below intraday low must be clamped before execution')
}

{
  const quote = normalizeShioajiSnapshot({
    close: 299.5,
    last: 305,
    open: 305,
    high: 306,
    low: 304,
  })
  assert(quote?.last === 305, 'snapshot last should take precedence over close')
}

{
  const quote = normalizeShioajiSnapshot({
    last: 305,
    bid_price: 304.5,
    ask_price: 305.5,
    bid_volume: 17,
    ask_volume: 22,
    total_volume: 1234,
  })
  assert(quote?.bid === 304.5, 'snapshot should preserve best bid for live parity')
  assert(quote?.ask === 305.5, 'snapshot should preserve best ask for buy fill sanity')
  assert(quote?.bidVolume === 17, 'snapshot should preserve best bid volume')
  assert(quote?.askVolume === 22, 'snapshot should preserve best ask volume')
  assert(quote?.totalVolume === 1234, 'snapshot should preserve total volume for partial fill')
}

;(async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/snapshots')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            '6861': {
              last: 305,
              low: 305,
              high: 305,
              total_volume: 1000,
            },
          },
        }),
      } as Response
    }
    if (url.endsWith('/orderbook/6861')) {
      return {
        ok: true,
        json: async () => ({
          status: 'ok',
          data: {
            price: 305,
            bid_prices: [304.5],
            ask_prices: [305],
            bid_volumes: [10],
            ask_volumes: [12],
            updated_at: '2026-05-05T09:30:00+08:00',
          },
        }),
      } as Response
    }
    return { ok: false, json: async () => ({}) } as Response
  }) as any

  try {
    const quotes = await batchGetIntradayOHLC(['6861'], {
      SHIOAJI_PROXY_URL: 'https://shioaji.local',
      requireBrokerQuote: true,
    })
    const quote = quotes.get('6861')
    assert(calls.some((url) => url.endsWith('/orderbook/6861')), 'missing bid/ask snapshots must be enriched from orderbook')
    assert(quote?.bid === 304.5, 'orderbook bid should be merged into executable quote')
    assert(quote?.ask === 305, 'orderbook ask should be merged into executable quote')
    assert(quote?.bidVolume === 10 && quote.askVolume === 12, 'orderbook best volumes should be merged')
  } finally {
    globalThis.fetch = originalFetch
  }
})()
