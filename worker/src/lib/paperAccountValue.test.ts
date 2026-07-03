import { computePaperPositionValuation, computePaperTotalValue } from './paperAccountValue'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const value = computePaperTotalValue({
    settledCash: 1_000_000,
    positionsValue: 46_110,
    netUnsettledSettlement: -46_176,
  })
  assert(value === 999_934, 'unsettled buy payable must offset newly opened position value')
}

{
  const value = computePaperTotalValue({
    settledCash: 1_000_000,
    positionsValue: 0,
    netUnsettledSettlement: 111_504,
  })
  assert(value === 1_111_504, 'unsettled sell receivable should count in economic account value')
}

{
  const valuation = computePaperPositionValuation({
    positions: [
      { symbol: '2404', shares: 85 },
      { symbol: '6691', shares: 144 },
      { symbol: 'MISSING', shares: 1000 },
    ],
    quotePrices: new Map([['2404', 1385]]),
    fallbackPrices: new Map([['6691', 766]]),
  })
  assert(valuation.positionsValue === 228_029, 'position valuation should include quote and fallback prices')
  assert(valuation.symbolPrices.get('2404') === 1385, 'quote price should be preferred')
  assert(valuation.symbolPrices.get('6691') === 766, 'fallback close should price quote-missing holdings')
  assert(valuation.quoteSymbols.join(',') === '2404', 'quote-sourced symbols should be exposed')
  assert(valuation.fallbackSymbols.join(',') === '6691', 'fallback-sourced symbols should be exposed')
  assert(valuation.missingSymbols.join(',') === 'MISSING', 'unpriced holdings should be explicit instead of silently zeroed')
}
