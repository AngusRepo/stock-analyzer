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

{
  const quote = normalizeShioajiSnapshot({
    last: 135.9,
    low: 134.5,
    high: 136.5,
  })
  assert(quote === null, 'snapshot should reject non-executable TW tick prices')
}

{
  const quote = normalizeShioajiSnapshot({
    last: 136,
    bid_prices: [{ volume: 7 }],
    ask_prices: [{ volume: 8 }],
    bid_volumes: [{ volume: 7 }],
    ask_volumes: [{ volume: 8 }],
  })
  assert(quote?.bid == null, 'volume-only bid objects must not become bid prices')
  assert(quote?.ask == null, 'volume-only ask objects must not become ask prices')
  assert(quote?.bidVolume === 7, 'volume-only bid objects should still populate bid volume')
  assert(quote?.askVolume === 8, 'volume-only ask objects should still populate ask volume')
}

async function runAsyncTests(): Promise<void> {
  {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/orderbooks')) {
        return {
          ok: true,
          json: async () => ({
            status: 'ok',
            data: {
              '6861': {
                status: 'ok',
                price: 304.75,
                bid_prices: [304.5],
                ask_prices: [305],
                bid_volumes: [10],
                ask_volumes: [12],
                source_time: '2026-05-05T09:30:00+08:00',
              },
            },
            errors: {},
          }),
        } as Response
      }
      if (url.endsWith('/snapshots')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              '6861': {
                last: 305,
                bid_price: 303,
                ask_price: 309,
                bid_volume: 1,
                ask_volume: 1,
                low: 305,
                high: 305,
                total_volume: 1000,
              },
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
      assert(calls[0]?.endsWith('/orderbooks'), 'broker-required quotes must fetch fresh batch orderbooks before snapshots')
      assert(!calls.some((url) => url.endsWith('/orderbook/6861')), 'fresh batch orderbook should avoid per-symbol fallback calls')
      assert(quote?.bid === 304.5, 'orderbook bid should be the executable quote')
      assert(quote?.ask === 305, 'orderbook ask should be the executable quote')
      assert(quote?.bidVolume === 10 && quote.askVolume === 12, 'orderbook best volumes should be executable volumes')
      assert(quote?.low === 305 && quote.high === 305 && quote.totalVolume === 1000, 'snapshot may only enrich OHLC/volume context')
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  {
    const originalFetch = globalThis.fetch
    const originalWarn = console.warn
    const warnings: string[] = []
    globalThis.fetch = (async (input: any) => {
      const url = String(input)
      if (url.endsWith('/orderbooks')) {
        return {
          ok: true,
          json: async () => ({
            status: 'empty',
            data: {},
            errors: {
              '9914': {
                status: 'stale_depth',
                symbol: '9914',
                source_time: '2026-07-01T10:12:03+08:00',
                quote_age_ms: 5333318,
                max_quote_age_ms: 3000,
                bid_levels: 5,
                ask_levels: 5,
              },
            },
          }),
        } as Response
      }
      if (url.endsWith('/snapshots')) {
        return {
          ok: true,
          json: async () => ({
            data: {
              '9914': {
                last: 77.3,
                bid_price: 76.9,
                ask_price: 77.1,
                low: 76.8,
                high: 78.1,
                total_volume: 3000,
              },
            },
          }),
        } as Response
      }
      return { ok: false, status: 404, text: async () => '' } as Response
    }) as any
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }

    try {
      const quotes = await batchGetIntradayOHLC(['9914'], {
        SHIOAJI_PROXY_URL: 'https://shioaji.local',
        requireBrokerQuote: true,
      })
      const quote = quotes.get('9914')
      assert(quote == null, 'stale orderbook must fail closed instead of falling back to snapshot ask')
      assert(
        warnings.some((line) => line.includes('stale_depth') && line.includes('age=5333318') && line.includes('source_time=2026-07-01T10:12:03+08:00')),
        'stale orderbook diagnostics must be surfaced in logs',
      )
    } finally {
      console.warn = originalWarn
      globalThis.fetch = originalFetch
    }
  }
}

void runAsyncTests().catch((error) => {
  console.error(error)
  process.exit(1)
})
