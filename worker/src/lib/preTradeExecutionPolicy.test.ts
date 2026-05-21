import { evaluatePreTradeExecution } from './preTradeExecutionPolicy'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function baseInput(overrides: Partial<Parameters<typeof evaluatePreTradeExecution>[0]> = {}) {
  return {
    symbol: '2330',
    currentPrice: 100,
    entryPrice: 100,
    stopLoss: 92,
    originalEntry: 100,
    retryCount: 0,
    previousClose: 98,
    quoteSource: 'shioaji' as const,
    marketRiskLevel: 'low',
    momentum: {
      volumeRatio: 1.2,
      minVolumeRatio: 0.8,
      slope5min: 0.01,
      rangePosition: 0.5,
      minRangePosition: 0.3,
    },
    policy: {
      limitUpPct: 0.095,
      requoteDeviationMax: 0.05,
      requoteDiscount: 0.985,
      requoteStopFallback: 0.92,
    },
    ...overrides,
  }
}

{
  const decision = evaluatePreTradeExecution(baseInput({ marketRiskLevel: 'unknown' }))
  assert(decision.action === 'DEFER', 'unknown market risk must fail closed')
}

{
  const decision = evaluatePreTradeExecution(baseInput({ marketRiskLevel: 'high' }))
  assert(decision.action === 'REQUOTE', 'high market risk should requote instead of buying')
  assert(decision.nextEntryPrice === 98.5, 'requote should lower entry by configured discount')
}

{
  const decision = evaluatePreTradeExecution(baseInput({ momentum: { error: 'trend unavailable' } }))
  assert(decision.action === 'DEFER', 'momentum errors must not proceed with buy')
}

{
  const decision = evaluatePreTradeExecution(baseInput({ quoteSource: 'yahoo' }))
  assert(decision.action === 'DEFER', 'yahoo fallback quotes must not trigger buy')
}

{
  const decision = evaluatePreTradeExecution(baseInput({
    quoteAgeMs: 20_000,
    policy: {
      limitUpPct: 0.095,
      requoteDeviationMax: 0.05,
      requoteDiscount: 0.985,
      requoteStopFallback: 0.92,
      maxQuoteAgeMs: 10_000,
    },
  }))
  assert(decision.action === 'DEFER', 'stale broker quotes must fail closed')
  assert(decision.reason === 'stale_quote:20s', 'stale quote reason should be readable')
}

{
  const decision = evaluatePreTradeExecution(baseInput({ currentPrice: 109.6, previousClose: 100 }))
  assert(decision.action === 'SKIP', 'limit-up chase must be skipped')
}

{
  const decision = evaluatePreTradeExecution(baseInput())
  assert(decision.action === 'BUY_AT', 'clean pre-trade context should allow buy')
  assert(decision.limitPrice === 100, 'buy limit should remain at entry price')
}
