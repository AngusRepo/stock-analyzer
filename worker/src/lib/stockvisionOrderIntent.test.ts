import { buildStockVisionOrderIntent } from './stockvisionOrderIntent'

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
  assert(intent.maxBudget === 100000, 'intent should preserve max budget')
  assert(intent.liveSubmitRequested === false, 'intent must not request live submit pre-pilot')
  assert(intent.riskContext.marketRiskLevel === 'low', 'intent should carry market risk')
  assert(intent.executionConstraints.quoteSource === 'shioaji', 'intent should carry broker quote source')
  assert(intent.executionConstraints.maxEntryChasePct === 0.003, 'intent should carry adaptive chase cap')
}
