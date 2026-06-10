import { buildStockVisionOrderIntent, buildStockVisionSellOrderIntent } from './stockvisionOrderIntent'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const intent = buildStockVisionOrderIntent({
    accountId: 1,
    tradeDate: '2026-05-28',
    pending: {
      symbol: '2330',
      confidence: 0.74,
      risk_pct: 0.01,
      kelly_pct: null,
    },
    limitPrice: 100.5,
    currentPrice: 100.4,
    budget: 100_000,
    shares: 995,
    strategyMode: 'pullback',
    marketRiskLevel: 'low',
    quote: {
      bestAsk: 100.5,
      bestBid: 100.3,
      source: 'shioaji',
      quoteAgeMs: 800,
    },
    adaptivePolicy: {
      maxEntryChasePct: 0.003,
      minVolumeRatio: 0.55,
      minRangePosition: 0.12,
    },
  })

  assert(intent.schemaVersion === 'stockvision-order-intent-v1', 'intent schema should be stable')
  assert(intent.symbol === '2330', 'intent should preserve symbol')
  assert(intent.side === 'buy', 'intent side should be buy')
  assert(intent.maxPrice === 100.5, 'intent max price should come from pre-trade executable limit')
  assert(intent.limitPrice === 100.5 && intent.priceRole === 'buy_max', 'buy intent should expose normalized limit price')
  assert(intent.priceTick === 0.5, 'intent should carry TW tick size')
  assert(intent.priceSnapMode === 'floor_to_buy_limit', 'intent should document buy-side price snapping')
  assert(intent.maxBudget === 100000, 'intent should preserve max budget')
  assert(intent.orderLegs.length === 1, '995 shares should be represented as one odd-lot leg')
  assert(intent.orderLegs[0]?.lotType === 'odd_lot', 'sub-1000 share order should be odd-lot')
  assert(intent.orderLegs[0]?.finlabQuantity === 995, 'odd-lot FinLab quantity should be shares')
  assert(intent.liveSubmitRequested === false, 'intent must not request live submit pre-pilot')
  assert(intent.riskContext.marketRiskLevel === 'low', 'intent should carry market risk')
  assert(intent.executionConstraints.quoteSource === 'shioaji', 'intent should carry broker quote source')
  assert(intent.executionConstraints.maxEntryChasePct === 0.003, 'intent should carry adaptive chase cap')
}

{
  const intent = buildStockVisionOrderIntent({
    accountId: 1,
    tradeDate: '2026-06-10',
    pending: {
      symbol: '1808',
      confidence: 0.7,
      risk_pct: 0.01,
    },
    limitPrice: 141.6,
    currentPrice: 141.5,
    budget: 500_000,
    shares: 3209,
    strategyMode: 'trend',
    marketRiskLevel: 'low',
    quote: {
      bestAsk: 141.5,
      bestBid: 141,
      source: 'shioaji',
      quoteAgeMs: 500,
    },
    adaptivePolicy: {
      maxEntryChasePct: 0.003,
    },
  })

  assert(intent.maxPrice === 141.5, 'illegal buy max price should snap down to legal TW tick')
  assert(intent.priceTick === 0.5, '141.5 should use 0.5 tick size')
  assert(intent.requestedShares === 3209, 'intent should preserve requested aggregate shares for accounting')
  assert(intent.orderLegs.length === 2, 'mixed shares should split into board and odd-lot legs')
  assert(intent.orderLegs[0]?.shares === 3000 && intent.orderLegs[0].finlabQuantity === 3, 'board leg should map to 3 lots')
  assert(intent.orderLegs[1]?.shares === 209 && intent.orderLegs[1].oddLot === true, 'odd leg should map to 209 odd-lot shares')
}

{
  const intent = buildStockVisionSellOrderIntent({
    accountId: 1,
    tradeDate: '2026-06-10',
    symbol: '4953',
    limitPrice: 141.6,
    currentPrice: 141.5,
    shares: 3209,
    reason: 'tp1',
    strategyType: 'exit',
    marketRiskLevel: 'low',
    quote: {
      bestBid: 141.5,
      bestAsk: 142,
      source: 'shioaji',
      quoteAgeMs: 500,
    },
  })

  assert(intent.side === 'sell', 'sell intent side should be sell')
  assert(intent.minPrice === 142, 'illegal sell minimum price should snap up to legal TW tick')
  assert(intent.limitPrice === 142 && intent.priceRole === 'sell_min', 'sell intent should expose normalized minimum limit')
  assert(intent.priceSnapMode === 'ceil_to_sell_limit', 'sell intent should document sell-side price snapping')
  assert(intent.orderLegs.length === 2, 'sell mixed shares should split into board and odd-lot legs')
  assert(intent.liveSubmitRequested === false, 'sell intent must keep live submit disabled before explicit approval')
}
