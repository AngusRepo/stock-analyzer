import { scoreMultiFactor } from './marketScreener'
import type { FMStockPrice } from './screenerMarketData'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const prices: FMStockPrice[] = Array.from({ length: 30 }, (_, index) => {
  const close = 100 + index
  return {
    date: `2026-04-${String(index + 1).padStart(2, '0')}`,
    stock_id: '2330',
    Trading_Volume: 2_000_000 + index * 10_000,
    Trading_money: close * (2_000_000 + index * 10_000),
    open: close - 1,
    max: close + 1,
    min: close - 2,
    close,
    spread: 1,
    Trading_turnover: 1000,
  }
})

const chipDates = new Map<string, { foreign: number; trust: number; dealer: number }>()
for (let index = 0; index < 5; index++) {
  chipDates.set(`2026-04-${String(26 + index).padStart(2, '0')}`, {
    foreign: 500_000,
    trust: 50_000,
    dealer: 20_000,
  })
}

{
  const result = scoreMultiFactor(prices, chipDates as any, 0.02, prices[prices.length - 1].close)
  const scoreComponents = JSON.parse(result.score_components)

  assert(result.chip_score <= 40, 'chip_score must stay on legacy 0-40 compatibility scale')
  assert(result.tech_score <= 30, 'tech_score must stay on legacy 0-30 compatibility scale')
  assert(result.momentum_score <= 20, 'momentum_score must stay on legacy 0-20 compatibility scale')
  assert(
    result.base_score === Math.round((result.chip_score + result.tech_score + result.momentum_score) * 10) / 10,
    'base_score should preserve legacy screener ranking semantics',
  )
  assert(scoreComponents.version === 'score_v2', 'score_components should expose Score V2 payload')
  assert(scoreComponents.components.chipFlow <= 25, 'Score V2 chipFlow should use 25-point scale')
  assert(scoreComponents.components.technicalStructure <= 25, 'Score V2 technicalStructure should use 25-point scale')
  assert(scoreComponents.total <= 50, 'partial screener Score V2 should not invent ML/fundamental/news points')
}
