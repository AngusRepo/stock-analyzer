import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scoreMultiFactor } from './marketScreener'
import type { CanonicalScreenerPrice } from './screenerMarketData'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const prices: CanonicalScreenerPrice[] = Array.from({ length: 30 }, (_, index) => {
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
  const legacySeed = Math.round((result.chip_score + result.tech_score + result.momentum_score) * 10) / 10
  assert(
    result.base_score === (scoreComponents.finalScore ?? scoreComponents.total),
    'base_score should project canonical Score V2 screener total',
  )
  assert(result.base_score !== legacySeed, 'base_score must not keep the legacy chip+tech+momentum owner')
  assert(scoreComponents.version === 'score_v2', 'score_components should expose Score V2 payload')
  assert(scoreComponents.components.chipFlow <= 25, 'Score V2 chipFlow should use 25-point scale')
  assert(scoreComponents.components.technicalStructure <= 25, 'Score V2 technicalStructure should use 25-point scale')
  assert(scoreComponents.total <= 50, 'partial screener Score V2 should not invent ML/fundamental points')
}

{
  const neutralChipDates = new Map<string, any>()
  const brokerBuyDates = new Map<string, any>()
  const brokerSellDates = new Map<string, any>()
  for (let index = 0; index < 5; index++) {
    const date = `2026-04-${String(26 + index).padStart(2, '0')}`
    neutralChipDates.set(date, { foreign: 0, trust: 0, dealer: 0 })
    brokerBuyDates.set(date, {
      foreign: 0,
      trust: 0,
      dealer: 0,
      brokerProxy: 80_000,
      estimatedAmount: 8_000_000,
      brokerCount: 12,
      concentration: 0.25,
      source: 'finlab.rotc_broker_transactions',
    })
    brokerSellDates.set(date, {
      foreign: 0,
      trust: 0,
      dealer: 0,
      brokerProxy: -80_000,
      estimatedAmount: -8_000_000,
      brokerCount: 12,
      concentration: 0.25,
      source: 'finlab.rotc_broker_transactions',
    })
  }

  const neutral = scoreMultiFactor(prices, neutralChipDates, 0.02, prices[prices.length - 1].close)
  const bullish = scoreMultiFactor(prices, brokerBuyDates, 0.02, prices[prices.length - 1].close)
  const bearish = scoreMultiFactor(prices, brokerSellDates, 0.02, prices[prices.length - 1].close)
  assert(bullish.chip_score > neutral.chip_score, 'bullish broker flow should raise continuous signed chip score')
  assert(bearish.chip_score < neutral.chip_score, 'bearish broker flow should lower continuous signed chip score')
  assert(bearish.reasons.some((reason) => reason.includes('broker_flow_5d_sell')), 'bearish broker flow should be visible in reasons')
}

{
  const percentUsageDates = new Map<string, any>()
  const supportiveDates = new Map<string, any>()
  const legacyLotBrokerDates = new Map<string, any>()
  for (let index = 0; index < 5; index++) {
    const date = `2026-04-${String(26 + index).padStart(2, '0')}`
    percentUsageDates.set(date, {
      foreign: 0,
      trust: 0,
      dealer: 0,
      marginBalance: 1000,
      shortBalance: 100,
      marginUsageRatio: 19.8,
      shortUsageRatio: 21.0,
    })
    supportiveDates.set(date, {
      foreign: 500_000,
      trust: 0,
      dealer: 0,
    })
    legacyLotBrokerDates.set(date, {
      foreign: 500_000,
      trust: 0,
      dealer: 0,
      brokerFlow: -100,
      estimatedAmount: -10_000,
      brokerCount: 10,
      concentration: 0.2,
      source: 'finlab.broker_transactions',
    })
  }

  const usage = scoreMultiFactor(prices, percentUsageDates, 0.02, prices[prices.length - 1].close)
  assert(
    !usage.reasons.some((reason) => reason.includes('usage_crowded')),
    'margin/short usage stored as percent must be normalized before crowded thresholds',
  )

  const supportive = scoreMultiFactor(prices, supportiveDates, 0.02, prices[prices.length - 1].close)
  const legacyLotSell = scoreMultiFactor(prices, legacyLotBrokerDates, 0.02, prices[prices.length - 1].close)
  assert(
    legacyLotSell.chip_score < supportive.chip_score,
    'legacy broker estimated_amount stored as lots*price must be converted to TWD before scoring',
  )
}

{
  const tradingConfigSource = readFileSync(join(process.cwd(), 'src/lib/tradingConfig.ts'), 'utf8')
  const markerIndex = tradingConfigSource.indexOf('screenerDenominator')
  assert(markerIndex >= 0, 'tradingConfig should keep screenerDenominator only as deprecated compatibility')
  const markerWindow = tradingConfigSource.slice(Math.max(0, markerIndex - 240), markerIndex + 240)
  assert(
    /deprecated compatibility only/i.test(markerWindow),
    'screenerDenominator must be documented as deprecated compatibility',
  )

  const marketScreenerSource = readFileSync(join(process.cwd(), 'src/lib/marketScreener.ts'), 'utf8')
  assert(!marketScreenerSource.includes('screenerDenominator'), 'marketScreener must not use legacy denominator')
  assert(
    marketScreenerSource.includes('const base_score = scoreV2.finalScore ?? scoreV2.total'),
    'marketScreener base_score must project Score V2 finalScore',
  )
  assert(
    !marketScreenerSource.includes('chip_score + tech_score + momentum_score'),
    'marketScreener must not restore legacy chip+tech+momentum score owner',
  )
  assert(
    marketScreenerSource.includes('if (riskAdjustment === 0) return 0'),
    'positive news/theme buzz must not add Score V2 points',
  )
  assert(
    !marketScreenerSource.includes('c.score += buzzBonus'),
    'news/theme buzz must not bypass Score V2 components',
  )
}
