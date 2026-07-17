import { strict as assert } from 'node:assert'
import { prewarmHoldingStopWatches } from './preMarketHoldingStopWatches'

void (async () => {
  const calls: Array<{ url: string; body: any }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url, body })
    if (url.endsWith('/execution/stop-watches')) {
      return Response.json({ registered: 1 })
    }
    if (url.endsWith('/execution/stop-breaches')) {
      return Response.json({ data: [] })
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as typeof fetch

  try {
    const result = await prewarmHoldingStopWatches({
      SHIOAJI_PROXY_URL: 'https://hub.example',
      PROXY_SERVICE_TOKEN: 'secret',
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({
              results: [{
                symbol: '2441',
                shares: 2000,
                avg_cost: 142,
                entry_price: 142,
                entry_date: '2026-07-16',
                initial_stop: 140,
                trailing_stop: 143.42,
                trade_lifecycle_json: null,
              }],
            }),
          }),
        }),
      },
    } as any)

    assert.equal(result.status, 'ok')
    assert.equal(result.registered, 1)
    assert.equal(calls[0]?.body?.ttl_seconds, 900)
    assert.equal(calls[0]?.body?.watches?.[0]?.symbol, '2441')
    assert.equal(calls[0]?.body?.watches?.[0]?.stop_price, 143.42)
  } finally {
    globalThis.fetch = originalFetch
  }
})()
