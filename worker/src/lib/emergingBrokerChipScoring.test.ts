import { scoreMultiFactor } from './marketScreener'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const prices = Array.from({ length: 20 }, (_, index) => ({
  date: `2026-05-${String(index + 1).padStart(2, '0')}`,
  stock_id: '7737',
  Trading_Volume: 100_000,
  Trading_money: 5_000_000,
  open: 49,
  max: 51,
  min: 48,
  close: 50,
  spread: 0,
  Trading_turnover: 0,
}))

const smallBrokerFlow = new Map<string, any>([
  ['2026-05-15', {
    foreign: 0,
    trust: 0,
    brokerProxy: 30_000,
    estimatedAmount: 1_500_000,
    brokerCount: 8,
    concentration: 0.31,
    source: 'finlab.rotc_broker_transactions',
    marketSegment: 'EMERGING',
  }],
])

const largeBrokerFlow = new Map<string, any>([
  ['2026-05-15', {
    foreign: 0,
    trust: 0,
    brokerProxy: 250_000,
    estimatedAmount: 12_500_000,
    brokerCount: 45,
    concentration: 0.18,
    source: 'finlab.rotc_broker_transactions',
    marketSegment: 'EMERGING',
  }],
])

const small = scoreMultiFactor(prices, smallBrokerFlow, 0, 50)
const large = scoreMultiFactor(prices, largeBrokerFlow, 0, 50)

assert(small.chip_score < large.chip_score, 'emerging broker proxy score must vary with broker amount/intensity')
assert(small.reasons.some((reason) => reason.includes('券商分點')), 'emerging broker reason should use broker wording')
assert(!small.reasons.some((reason) => reason.includes('法人佔成交')), 'emerging broker reason must not use listed/OTC institution wording')
