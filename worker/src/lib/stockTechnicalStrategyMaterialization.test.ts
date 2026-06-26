import assert from 'node:assert/strict'
import {
  deriveStockTechnicalDailyFeatures,
  materializeStockTechnicalStrategyScores,
} from './stockTechnicalStrategyMaterialization'
import { assessCandidateAgainstStrategySpecs, STRATEGY_SPEC_VERSION, type StrategySpec } from './strategySpec'

function candidate(symbol: string, technicalIndicators: Record<string, number | null>) {
  return {
    symbol,
    current_price: technicalIndicators.stockTechLatestClose ?? 120,
    raw_signals: {
      close: technicalIndicators.stockTechLatestClose ?? 120,
      technicalIndicators,
      factorSignals: {},
    },
  }
}

const baseSpec: StrategySpec = {
  id: 'stock_tech_s01_55d_trend_volume_breakout_v1',
  version: STRATEGY_SPEC_VERSION,
  name: 'S1 55d trend volume breakout',
  status: 'active',
  owner: 'strategy',
  familyId: 'TREND_RECLAIM_CONTINUATION',
  variantId: 's01_55d_trend_volume_breakout_v1',
  ownerType: 'strategy',
  promotionStatus: 'production',
  alphaBucket: 'breakout_vol_expansion',
  supportedRegimes: ['bull', 'volatile'],
  thesis: 'test',
  thresholds: {
    minPrice: 10,
    dsl: {
      all: [{ signal: 'technicalIndicators.stockTechS01Signal', op: '==', value: 1 }],
    },
  },
  candidatePolicy: { poolQuota: 10, costBudget: 12, maxMlShare: 0 },
  riskNotes: [],
  createdBy: 'p5_strategy_governance',
}

{
  const bars = Array.from({ length: 260 }, (_, index) => {
    const close = 50 + index * 0.2
    return {
      date: `2025-01-${String((index % 28) + 1).padStart(2, '0')}`,
      open: close - 0.2,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1000 + index,
    }
  }).map((row, index) => ({
    ...row,
    date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
  }))
  const features = deriveStockTechnicalDailyFeatures(bars)
  assert.equal(features.stockTechHistoryDays, 260)
  assert(features.stockTechMa200 != null, 'daily feature materializer should compute long MA features')
  assert(features.stockTechHighPos252 != null, 'daily feature materializer should compute 52w high position')
  assert(features.stockTechVr20 != null, 'daily feature materializer should compute current volume expansion')
}

{
  const winner = candidate('9991', {
    stockTechHistoryDays: 260,
    stockTechLatestClose: 130,
    stockTechTurnover20: 1_000_000,
    stockTechMa50: 100,
    stockTechMa100: 90,
    stockTechMa200: 80,
    stockTechMa50Ago20: 90,
    stockTechHhPrev55: 120,
    stockTechHighPos252: 0.96,
    stockTechReturn126: 0.55,
    stockTechReturn63: 0.3,
    stockTechReturn60: 0.3,
    stockTechReturn63Prev1: 0.28,
    stockTechMom12_1: 0.45,
    stockTechVr20: 2.1,
    stockTechNatr20: 0.02,
    stockTechDeduct20Raw: 10,
    stockTechDeduct20Prev: -1,
    stockTechStretchHh20Atr: 0.2,
  })
  const mid = candidate('9992', {
    stockTechHistoryDays: 260,
    stockTechLatestClose: 90,
    stockTechTurnover20: 700_000,
    stockTechMa50: 95,
    stockTechMa100: 95,
    stockTechMa200: 92,
    stockTechMa50Ago20: 95,
    stockTechHhPrev55: 100,
    stockTechHighPos252: 0.75,
    stockTechReturn126: 0.1,
    stockTechReturn63: 0.05,
    stockTechReturn63Prev1: 0.05,
    stockTechMom12_1: 0.05,
    stockTechVr20: 0.8,
    stockTechNatr20: 0.05,
  })
  const low = candidate('9993', {
    stockTechHistoryDays: 260,
    stockTechLatestClose: 70,
    stockTechTurnover20: 100_000,
    stockTechReturn126: -0.05,
    stockTechReturn63: -0.02,
    stockTechReturn63Prev1: -0.02,
    stockTechMom12_1: -0.05,
    stockTechVr20: 0.5,
    stockTechNatr20: 0.08,
  })

  const telemetry = materializeStockTechnicalStrategyScores([winner, mid, low], {
    marketRegime: {
      source: 'equal_weight_close_return_proxy',
      latestDate: '2026-06-25',
      mkt1: true,
      mkt2: true,
      marketRet63: 0,
      marketRet126: 0,
      marketRet252: 0,
    },
  })

  assert.equal(telemetry.signalCoverage.stockTechS01Signal, 1)
  assert.equal(winner.raw_signals.technicalIndicators.stockTechS01Signal, 1)
  assert.equal(winner.raw_signals.technicalIndicators.stockTechS02Signal, 1)
  assert(winner.raw_signals.technicalIndicators.stockTechS01Score != null)
  assert(winner.raw_signals.technicalIndicators.stockTechS01Score <= 1)
  assert.equal(mid.raw_signals.technicalIndicators.stockTechS01Signal, 0)

  const assessment = assessCandidateAgainstStrategySpecs(winner, [baseSpec])
  assert(
    assessment.matches.some((match) => match.specId === 'stock_tech_s01_55d_trend_volume_breakout_v1'),
    'stock technical StrategySpec should match on materialized signal gate, not a fixed score>=1 gate',
  )
}
