import {
  buildFinLabL5MarketDataDetail,
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
    assert(url.endsWith('/finlab/execution/l5-market-data'), 'production-like L5 fetch should call market-data route')
    assert(body.allow_broker_login === true, 'market-data fetch should require explicit broker-login flag')
    assert(body.symbols[0] === '2330', 'market-data fetch should send requested symbols')
    assert(quotes.get('2330')?.bestAsk === 100.1, 'market-data fetch should normalize controller L5 quotes')
  } finally {
    globalThis.fetch = originalFetch
  }
})()

;(async () => {
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input))
    return {
      ok: true,
      json: async () => ({
        status: 'ok',
        provider: 'shioaji_proxy_orderbook',
        symbol: '2330',
        price: 100,
        bid_prices: [99.9, 99.8, 99.7, 99.6, 99.5],
        ask_prices: [100.1, 100.2, 100.3, 100.4, 100.5],
        bid_volumes: [12, 10, 8, 6, 4],
        ask_volumes: [8, 7, 6, 5, 4],
        updated_at: '2026-05-28T01:00:09Z',
      }),
    } as Response
  }) as any

  try {
    const quotes = await fetchFinLabL5MarketDataQuotes({
      ML_CONTROLLER_URL: 'https://controller.example',
      SHIOAJI_PROXY_URL: 'https://proxy.example',
      PROXY_SERVICE_TOKEN: 'proxy-token',
      FINLAB_L5_MARKET_DATA_ENABLED: '1',
    }, ['2330'])
    assert(urls[0]?.endsWith('/orderbook/2330'), 'L5 fetch should prefer Shioaji proxy orderbook')
    assert(!urls.some((item) => item.includes('/finlab/execution/l5-market-data')), 'controller L5 route should not be called when proxy orderbook succeeds')
    assert(quotes.get('2330')?.provider === 'shioaji_proxy_orderbook', 'proxy L5 quote should preserve provider')
    assert(quotes.get('2330')?.bestAsk === 100.1, 'proxy L5 quote should normalize best ask')
  } finally {
    globalThis.fetch = originalFetch
  }
})()
