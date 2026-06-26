import {
  buildFinLabL5MarketDataDetail,
  evaluateL5OrderBookPersistence,
  fetchFinLabL5MarketDataSnapshot,
  fetchFinLabL5MarketDataQuotes,
  normalizeFinLabL5Quote,
  quoteQualityFromL5,
} from './finlabL5MarketData'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const quote = normalizeFinLabL5Quote('2330', {
    provider: 'finlab_sinopac',
    price: 100,
    bid_prices: [99.9, 99.8, 99.7, 99.6, 99.5],
    ask_prices: [100.1, 100.2, 100.3, 100.4, 100.5],
    bid_volumes: [12, 10, 8, 6, 4],
    ask_volumes: [8, 7, 6, 5, 4],
    received_at: '2026-05-28T01:00:10Z',
    source_time: '2026-05-28T01:00:09Z',
  }, new Date('2026-05-28T01:00:10Z'))

  assert(quote?.symbol === '2330', 'normalized L5 quote should preserve symbol')
  assert(quote?.bestBid === 99.9, 'normalized L5 quote should expose best bid')
  assert(quote?.bestAsk === 100.1, 'normalized L5 quote should expose best ask')
  assert(quote?.spreadPct === 0.002, 'spread percentage should be ask-bid over mid')
  assert(quote?.orderBookImbalance != null && quote.orderBookImbalance > 0, 'bid-heavy book should have positive imbalance')
  assert(quote?.quoteAgeMs === 1000, 'quote age should be measured from source time')
}

{
  const quote = normalizeFinLabL5Quote('2330', {
    price: 100,
    bid_prices: [99.9],
    ask_prices: [100.1],
    bid_volumes: [12],
    ask_volumes: [8],
  }, new Date('2026-05-28T01:00:10Z'))

  const quality = quoteQualityFromL5(quote, {
    maxQuoteAgeMs: 3000,
    maxSpreadPct: 0.003,
    minDepthLevels: 5,
    minTopAskVolume: 5,
    minOrderBookImbalance: -0.4,
  })
  assert(quality.status === 'degraded', 'missing five-depth levels should degrade but not block by itself')
  assert(quality.reasons.includes('l5_depth_incomplete'), 'quality should explain incomplete L5 depth')
}

{
  const quote = normalizeFinLabL5Quote('2330', {
    price: 100,
    bid_prices: [99],
    ask_prices: [101],
    bid_volumes: [1, 1, 1, 1, 1],
    ask_volumes: [30, 30, 30, 30, 30],
    source_time: '2026-05-28T01:00:00Z',
  }, new Date('2026-05-28T01:00:10Z'))

  const quality = quoteQualityFromL5(quote, {
    maxQuoteAgeMs: 3000,
    maxSpreadPct: 0.003,
    minDepthLevels: 5,
    minTopAskVolume: 5,
    minOrderBookImbalance: -0.4,
  })
  assert(quality.status === 'blocked', 'stale wide ask-heavy L5 quote must block execution')
  assert(quality.reasons.includes('stale_l5_quote'), 'quality should block stale L5 quote')
  assert(quality.reasons.includes('wide_l5_spread'), 'quality should block wide L5 spread')
  assert(quality.reasons.includes('weak_l5_imbalance'), 'quality should block weak order-book imbalance')
}

{
  const quote = normalizeFinLabL5Quote('2330', {
    price: 100,
    bid_prices: [99.9, 99.8, 99.7, 99.6, 99.5],
    ask_prices: [100.1, 100.2, 100.3, 100.4, 100.5],
    bid_volumes: [12, 10, 8, 6, 4],
    ask_volumes: [8, 7, 6, 5, 4],
  }, new Date('2026-05-28T01:00:10Z'))
  const detail = buildFinLabL5MarketDataDetail(quote)
  assert(detail.provider === 'finlab_sinopac', 'audit detail should default to FinLab/Sinopac provider')
  assert(detail.l5_depth_levels === 5, 'audit detail should expose observed L5 depth')
  assert(detail.live_submit_enabled === false, 'market-data detail must make live submit disabled explicit')
}

{
  const quotes = [
    normalizeFinLabL5Quote('2330', {
      bid_prices: [99.9, 99.8, 99.7, 99.6, 99.5],
      ask_prices: [100.1, 100.2, 100.3, 100.4, 100.5],
      bid_volumes: [14, 12, 10, 8, 6],
      ask_volumes: [10, 9, 8, 7, 6],
    }, new Date('2026-05-28T01:00:00Z')),
    normalizeFinLabL5Quote('2330', {
      bid_prices: [99.92, 99.9, 99.8, 99.7, 99.6],
      ask_prices: [100.1, 100.12, 100.2, 100.3, 100.4],
      bid_volumes: [18, 14, 12, 10, 8],
      ask_volumes: [7, 7, 6, 5, 4],
    }, new Date('2026-05-28T01:00:01Z')),
    normalizeFinLabL5Quote('2330', {
      bid_prices: [99.95, 99.92, 99.9, 99.8, 99.7],
      ask_prices: [100.1, 100.12, 100.14, 100.2, 100.3],
      bid_volumes: [22, 16, 14, 12, 10],
      ask_volumes: [4, 5, 4, 4, 3],
    }, new Date('2026-05-28T01:00:02Z')),
  ]
  const persistence = evaluateL5OrderBookPersistence(quotes, {
    minSamples: 3,
    minPositiveImbalanceRatio: 0.8,
    minAverageImbalance: 0.1,
    minTopAskVolumeDropRatio: 0.3,
  })
  assert(persistence.status === 'boost', 'persistent bid support should boost entry confidence')
  assert(persistence.reasons.includes('l5_persistent_bid_support'), 'persistence should explain bid support')
  assert(persistence.metrics.bestAskConsumedCount >= 1, 'persistence should count visible ask absorption')
  assert((persistence.metrics.spreadCompressionPct ?? 0) > 0, 'persistence should measure spread compression')
}

{
  const quotes = [
    normalizeFinLabL5Quote('2330', {
      bid_prices: [99.9, 99.8, 99.7, 99.6, 99.5],
      ask_prices: [100.1, 100.2, 100.3, 100.4, 100.5],
      bid_volumes: [2, 2, 2, 2, 2],
      ask_volumes: [18, 18, 18, 18, 18],
    }, new Date('2026-05-28T01:00:00Z')),
    normalizeFinLabL5Quote('2330', {
      bid_prices: [99.9, 99.8, 99.7, 99.6, 99.5],
      ask_prices: [100.1, 100.2, 100.3, 100.4, 100.5],
      bid_volumes: [3, 2, 2, 2, 2],
      ask_volumes: [22, 20, 18, 18, 18],
    }, new Date('2026-05-28T01:00:01Z')),
    normalizeFinLabL5Quote('2330', {
      bid_prices: [99.9, 99.8, 99.7, 99.6, 99.5],
      ask_prices: [100.1, 100.2, 100.3, 100.4, 100.5],
      bid_volumes: [2, 2, 2, 2, 2],
      ask_volumes: [24, 22, 20, 20, 18],
    }, new Date('2026-05-28T01:00:02Z')),
  ]
  const persistence = evaluateL5OrderBookPersistence(quotes, {
    minSamples: 3,
    minAverageImbalance: 0.05,
  })
  assert(persistence.status === 'degraded', 'persistent ask-heavy book should degrade entry confidence')
  assert(persistence.reasons.includes('l5_average_imbalance_weak'), 'persistence should explain weak average imbalance')
}

;(async () => {
  const originalFetch = globalThis.fetch
  let body: any = null
  let url = ''
  globalThis.fetch = (async (input: any, init?: any) => {
    url = String(input)
    body = JSON.parse(String(init?.body ?? '{}'))
    return {
      ok: true,
      json: async () => ({
        status: 'pass',
        can_submit_real_order: false,
        quotes: {
          '2330': {
            provider: 'finlab_sinopac',
            price: 100,
            bid_prices: [99.9, 99.8, 99.7, 99.6, 99.5],
            ask_prices: [100.1, 100.2, 100.3, 100.4, 100.5],
            bid_volumes: [12, 10, 8, 6, 4],
            ask_volumes: [8, 7, 6, 5, 4],
          },
        },
      }),
    } as Response
  }) as any

  try {
    const quotes = await fetchFinLabL5MarketDataQuotes({
      ML_CONTROLLER_URL: 'https://controller.example',
      ML_CONTROLLER_SECRET: 'secret',
      FINLAB_L5_MARKET_DATA_ENABLED: '1',
      FINLAB_L5_MARKET_DATA_ALLOW_BROKER_LOGIN: '1',
    }, ['2330'])
    assert(url.endsWith('/finlab/execution/l5-market-data'), 'production-grade L5 fetch should call market-data route')
    assert(body.allow_broker_login === true, 'market-data fetch should require explicit broker-login flag')
    assert(body.symbols[0] === '2330', 'market-data fetch should send requested symbols')
    assert(quotes.get('2330')?.bestAsk === 100.1, 'market-data fetch should normalize controller L5 quotes')
  } finally {
    globalThis.fetch = originalFetch
  }
})()

;(async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      status: 'blocked',
      blocked_reasons: ['SHIOAJI_CERT_PATH', 'SHIOAJI_SECRET_KEY_OR_SHIOAJI_API_SECRET'],
      env_status: {
        ready: false,
        missing: ['SHIOAJI_CERT_PATH', 'SHIOAJI_SECRET_KEY_OR_SHIOAJI_API_SECRET'],
      },
      can_submit_real_order: false,
      live_submit_enabled: false,
      quotes: {},
    }),
  }) as Response) as any

  try {
    const snapshot = await fetchFinLabL5MarketDataSnapshot({
      ML_CONTROLLER_URL: 'https://controller.example',
      FINLAB_L5_MARKET_DATA_ENABLED: '1',
      FINLAB_L5_MARKET_DATA_ALLOW_BROKER_LOGIN: '1',
    }, ['2885'])

    assert(snapshot.status === 'blocked', 'L5 snapshot should preserve controller blocked status')
    assert(snapshot.blockedReasons.includes('SHIOAJI_CERT_PATH'), 'L5 snapshot should preserve missing certificate reason')
    assert(snapshot.envMissing.includes('SHIOAJI_SECRET_KEY_OR_SHIOAJI_API_SECRET'), 'L5 snapshot should preserve env missing reason')
    assert(snapshot.quotes.size === 0, 'blocked L5 snapshot should not fabricate quotes')
  } finally {
    globalThis.fetch = originalFetch
  }
})()

;(async () => {
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  let proxyAuth = ''
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/finlab/execution/l5-market-data')) {
      return {
        ok: true,
        json: async () => ({
          status: 'error',
          can_submit_real_order: false,
          live_submit_enabled: false,
          error_type: 'RuntimeError',
          error: 'finlab_l5_quote_method_unavailable',
          quotes: {},
        }),
      } as Response
    }
    if (url.includes('/orderbook/2885')) {
      proxyAuth = String((init?.headers as Record<string, unknown> | undefined)?.Authorization ?? '')
      return {
        ok: true,
        json: async () => ({
          status: 'ok',
          price: 80,
          bid_prices: [79.9, 79.8, 79.7, 79.6, 79.5],
          ask_prices: [80.1, 80.2, 80.3, 80.4, 80.5],
          bid_volumes: [20, 18, 16, 14, 12],
          ask_volumes: [8, 7, 6, 5, 4],
          updated_at: '2026-06-26T01:00:00Z',
        }),
      } as Response
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as any

  try {
    const snapshot = await fetchFinLabL5MarketDataSnapshot({
      ML_CONTROLLER_URL: 'https://controller.example',
      FINLAB_L5_MARKET_DATA_ENABLED: '1',
      FINLAB_L5_MARKET_DATA_ALLOW_BROKER_LOGIN: '1',
      SHIOAJI_PROXY_URL: 'https://proxy.example',
      PROXY_SERVICE_TOKEN: 'proxy-token',
    }, ['2885'])

    assert(calls.some((url) => url.endsWith('/orderbook/2885')), 'L5 snapshot should fall back to Shioaji proxy orderbook')
    assert(proxyAuth === 'Bearer proxy-token', 'proxy fallback should use service token')
    assert(snapshot.status === 'pass', 'proxy fallback with executable book should repair L5 snapshot status')
    assert(snapshot.quotes.get('2885')?.provider === 'shioaji_proxy_orderbook', 'proxy fallback quote should keep provider')
    assert(snapshot.quotes.get('2885')?.bestAsk === 80.1, 'proxy fallback should normalize executable ask')
    assert(snapshot.raw?.source === 'worker_shioaji_proxy_orderbook_fallback', 'snapshot raw should expose worker fallback source')
    assert(snapshot.raw?.fallback_used === true, 'snapshot raw should expose fallback usage')
    assert(snapshot.raw?.fallback_reason === 'controller_error', 'snapshot raw should explain fallback reason')
  } finally {
    globalThis.fetch = originalFetch
  }
})()
