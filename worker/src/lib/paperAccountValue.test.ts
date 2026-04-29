import { computePaperTotalValue } from './paperAccountValue'

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
