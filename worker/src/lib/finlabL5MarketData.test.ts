import {
  buildFinLabL5MarketDataDetail,
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
