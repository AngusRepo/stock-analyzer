import assert from 'node:assert/strict'
import {
  deriveStockTechnicalDailyFeatures,
  materializeStockTechnicalStrategyScores,
} from './stockTechnicalStrategyMaterialization'
import {
  assessCandidateAgainstStrategySpecs,
  explainStrategyEvaluability,
  STRATEGY_SPEC_VERSION,
  type StrategySpec,
} from './strategySpec'

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
      all: [{ signal: 'technicalIndicators.stockTechS01Admission', op: '==', value: 1 }],
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
  assert(features.stockTechMom12_1 != null, 'S2 momentum should use a 252-bar fallback instead of staying null')
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
    stockTechReturn126: 0.7,
    stockTechReturn63: 0.3,
    stockTechReturn60: 0.3,
    stockTechReturn63Prev1: 0.28,
    stockTechMom12_1: 0.6,
    stockTechVr20: 2.1,
    stockTechNatr20: 0.02,
    stockTechDeduct20Raw: 10,
    stockTechDeduct20Prev: -1,
    stockTechStretchHh20Atr: 0.2,
  })
  const nearMiss = candidate('9994', {
    stockTechHistoryDays: 260,
    stockTechLatestClose: 125,
    stockTechTurnover20: 900_000,
    stockTechMa50: 100,
    stockTechMa100: 90,
    stockTechMa200: 80,
    stockTechMa50Ago20: 90,
    stockTechHhPrev55: 130,
    stockTechHighPos252: 0.96,
    stockTechReturn126: 0.58,
    stockTechReturn63: 0.35,
    stockTechReturn60: 0.35,
    stockTechReturn63Prev1: 0.32,
    stockTechMom12_1: 0.48,
    stockTechVr20: 2.2,
    stockTechNatr20: 0.015,
    stockTechDeduct20Raw: 8,
    stockTechDeduct20Prev: 1,
    stockTechStretchHh20Atr: 0.15,
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

  const telemetry = materializeStockTechnicalStrategyScores([winner, nearMiss, mid, low], {
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
  assert(telemetry.admissionCoverage.stockTechS01Admission >= 1)
  assert.equal(winner.raw_signals.technicalIndicators.stockTechS01Signal, 1)
  assert.equal(winner.raw_signals.technicalIndicators.stockTechS01Admission, 1)
  assert.equal(nearMiss.raw_signals.technicalIndicators.stockTechS01Signal, 0)
  assert.equal(nearMiss.raw_signals.technicalIndicators.stockTechS01Admission, 1)
  assert.equal(winner.raw_signals.technicalIndicators.stockTechS02Signal, 1)
  assert(winner.raw_signals.technicalIndicators.stockTechS02Score != null)
  assert.equal(winner.raw_signals.technicalIndicators.stockTechS02Admission, 1)
  assert(winner.raw_signals.technicalIndicators.stockTechS01Score != null)
  assert(winner.raw_signals.technicalIndicators.stockTechS01Score <= 1)
  assert.equal(mid.raw_signals.technicalIndicators.stockTechS01Signal, 0)

  const assessment = assessCandidateAgainstStrategySpecs(winner, [baseSpec])
  assert(
    assessment.matches.some((match) => match.specId === 'stock_tech_s01_55d_trend_volume_breakout_v1'),
    'stock technical StrategySpec should match on materialized adaptive admission, not a fixed score>=1 or hard signal-only gate',
  )
}

{
  const suffixes = ['03', '05', '07', '08', '09', '10'] as const
  const dailyCandidates = Array.from({ length: 4 }, (_, variant) => {
    const bars = Array.from({ length: 280 }, (_, index) => {
      const trend = 45 + index * (0.10 + variant * 0.015)
      const cycle = Math.sin(index / (5 + variant)) * (1.2 + variant * 0.25)
      const close = trend + cycle
      const open = close - Math.cos(index / 4) * 0.35
      const high = Math.max(open, close) + 0.55
      const low = Math.min(open, close) - 0.55
      return {
        date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
        open,
        high,
        low,
        close,
        volume: 1_000 + variant * 200 + (index % (9 + variant)) * 35,
      }
    })
    return candidate(`88${variant}`, deriveStockTechnicalDailyFeatures(bars))
  })

  const telemetry = materializeStockTechnicalStrategyScores(dailyCandidates, {
    marketRegime: {
      source: 'equal_weight_close_return_proxy',
      latestDate: '2026-07-29',
      mkt1: true,
      mkt2: true,
      marketRet63: 0.02,
      marketRet126: 0.05,
      marketRet252: 0.08,
    },
  })

  assert.equal(telemetry.method, 'stock_technical_strategy12_daily_materialization_v2')
  for (const suffix of suffixes) {
    const scoreKey = `stockTechS${suffix}Score`
    const signalKey = `stockTechS${suffix}Signal`
    assert.equal(
      telemetry.scoreCoverage[scoreKey],
      dailyCandidates.length,
      `${scoreKey} must be materially non-null for every eligible daily candidate`,
    )
    for (const row of dailyCandidates) {
      const scoreValue = row.raw_signals.technicalIndicators[scoreKey]
      const signalValue = row.raw_signals.technicalIndicators[signalKey]
      assert.equal(typeof scoreValue, 'number', `${scoreKey} must be continuous learning evidence`)
      assert(signalValue === 0 || signalValue === 1, `${signalKey} must be an explicit boolean observation`)
      const spec: StrategySpec = {
        ...baseSpec,
        id: `stock_tech_s${suffix}_producer_contract_v1`,
        status: 'candidate',
        promotionStatus: 'candidate',
        thresholds: {
          minPrice: 10,
          dsl: { all: [{ signal: `technicalIndicators.${signalKey}`, op: '==', value: 1 }] },
        },
      }
      const diagnostics = explainStrategyEvaluability(row, spec)
      assert.equal(diagnostics.evaluable, true, `${signalKey} must close the learning evaluability contract`)
      assert.deepEqual(diagnostics.missing_required_signal_refs, [])
    }
  }
}
{
  const triggerWinner = candidate('9900', {
    stockTechHistoryDays: 280,
    stockTechLatestOpen: 122,
    stockTechLatestClose: 130,
    stockTechTurnover20: 2_000_000,
    stockTechMa20: 110,
    stockTechMa50: 100,
    stockTechMa150: 90,
    stockTechMa200: 80,
    stockTechMa200Ago20: 75,
    stockTechHighPos252: 0.96,
    stockTechReturn63: 0.45,
    stockTechReturn126: 0.80,
    stockTechRangePrev10: 0.03,
    stockTechRangePrev20: 0.05,
    stockTechRangePrev60: 0.15,
    stockTechContract10_20: 0.40,
    stockTechContract20_60: 0.67,
    stockTechDryup10_50: 0.50,
    stockTechVmaPrev10: 50,
    stockTechVmaPrev50: 100,
    stockTechHhPrev20: 125,
    stockTechVr20: 2.0,
    stockTechClv: 0.90,
    stockTechS05DaysSinceBreakout: 5,
    stockTechS05PullbackDd: -0.06,
    stockTechS05PullbackQuality: 1,
    stockTechS05DryupQuality: 0.50,
    stockTechS05PullbackVolRatio: 0.50,
    stockTechS05DistMa20Atr: 0.25,
    stockTechS05PathOk: 1,
    stockTechS05Trigger: 1,
    stockTechPrev2Close: 90,
    stockTechPrevClose: 67,
    stockTechPrevHigh: 68,
    stockTechPrevLow: 65,
    stockTechS07Support20Shift2: 70,
    stockTechS07BreakDepth: 0.50,
    stockTechS07CloseBreakDepth: 0.30,
    stockTechS07ReclaimStrength: 2.0,
    stockTechS07Ma200Shift2: 80,
    stockTechS07Ma200Shift22: 75,
    stockTechVr20Prev: 2.0,
    stockTechRsi2Prev: 5,
    stockTechRsi2: 3,
    stockTechS08Ma5DistanceAtr: 0.80,
    stockTechS09BaseTop: 125,
    stockTechS09BaseWidth: 0.10,
    stockTechS09ThreeCandles: 1,
    stockTechS09OpensInside: 1,
    stockTechS09Ret3: 0.08,
    stockTechS09Vol3Ratio: 1.50,
    stockTechS09HeatQuality: 0.70,
    stockTechMa50Ago10: 95,
    stockTechS10GapUpAtr: 0.40,
    stockTechS10PreDecline: 0.15,
    stockTechS10Trigger: 1,
  })
  const peers = Array.from({ length: 3 }, (_, index) => candidate(`990${index + 1}`, {
    stockTechHistoryDays: 280,
    stockTechLatestOpen: 80,
    stockTechLatestClose: 79,
    stockTechTurnover20: 500_000 + index * 100_000,
    stockTechReturn63: -0.10 + index * 0.01,
    stockTechReturn126: -0.15 + index * 0.01,
    stockTechContract10_20: 0.05 + index * 0.01,
    stockTechContract20_60: 0.05 + index * 0.01,
    stockTechDryup10_50: 0.05 + index * 0.01,
    stockTechVr20: 0.70 + index * 0.05,
    stockTechClv: 0.30,
    stockTechS05PullbackQuality: 0.10,
    stockTechS05DryupQuality: 0.10,
    stockTechS07ReclaimStrength: -0.20 + index * 0.02,
    stockTechVr20Prev: 0.60 + index * 0.05,
    stockTechRsi2Prev: 60 + index,
    stockTechRsi2: 55 + index,
    stockTechS09BaseWidth: 0.30 + index * 0.01,
    stockTechS09Vol3Ratio: 0.70 + index * 0.05,
    stockTechS09HeatQuality: 0.20,
    stockTechS10GapUpAtr: 0.05 + index * 0.01,
    stockTechS10PreDecline: 0.02 + index * 0.01,
  }))
  materializeStockTechnicalStrategyScores([triggerWinner, ...peers], {
    marketRegime: {
      source: 'equal_weight_close_return_proxy',
      latestDate: '2026-07-29',
      mkt1: true,
      mkt2: true,
      marketRet63: 0,
      marketRet126: 0,
      marketRet252: 0,
    },
  })
  for (const suffix of ['03', '05', '07', '08', '10']) {
    assert.equal(
      triggerWinner.raw_signals.technicalIndicators[`stockTechS${suffix}Signal`],
      1,
      `S${suffix} producer must be capable of emitting a real hit when its PIT gates pass`,
    )
  }

  const s9Winner = candidate('9910', {
    ...triggerWinner.raw_signals.technicalIndicators,
    stockTechPrev2Close: 124,
    stockTechPrevClose: 127,
  })
  materializeStockTechnicalStrategyScores([s9Winner, ...peers], {
    marketRegime: {
      source: 'equal_weight_close_return_proxy',
      latestDate: '2026-07-29',
      mkt1: true,
      mkt2: true,
      marketRet63: 0,
      marketRet126: 0,
      marketRet252: 0,
    },
  })
  assert.equal(
    s9Winner.raw_signals.technicalIndicators.stockTechS09Signal,
    1,
    'S09 producer must emit a real hit when its three-soldiers PIT gates pass',
  )
}

{
  const bars = Array.from({ length: 280 }, (_, index) => {
    const close = 50 + index * 0.145
    return {
      date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
      open: close - 0.20,
      high: close + 0.55,
      low: close - 0.55,
      close,
      volume: 1_000,
    }
  })
  const overrides = [
    { close: 93, open: 91.5, high: 95, low: 91, volume: 1_600 },
    { close: 91.5, open: 92, high: 92.5, low: 91, volume: 400 },
    { close: 90.5, open: 91, high: 91.4, low: 90, volume: 400 },
    { close: 89.5, open: 90, high: 90.4, low: 89, volume: 400 },
    { close: 88, open: 89, high: 89.2, low: 87.5, volume: 400 },
    { close: 89.5, open: 88, high: 89.8, low: 87.8, volume: 1_200 },
  ]
  for (let offset = 0; offset < overrides.length; offset += 1) Object.assign(bars[274 + offset], overrides[offset])
  const features = deriveStockTechnicalDailyFeatures(bars)
  assert.equal(features.stockTechS05DaysSinceBreakout, 5)
  assert.equal(features.stockTechS05PathOk, 1)
  assert.equal(features.stockTechS05Trigger, 1)
  assert((features.stockTechS05PullbackDd ?? 0) >= -0.12)
  assert((features.stockTechS05PullbackDd ?? 0) <= -0.03)
}
{
  const bars = Array.from({ length: 280 }, (_, index) => {
    const close = index < 250 ? 100 + index * 0.05 : 112.5 - (index - 249) * 0.83
    return {
      date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
      open: close + 0.20,
      high: close + 0.70,
      low: close - 0.70,
      close,
      volume: 1_000,
    }
  })
  Object.assign(bars[275], { open: 91, high: 92, low: 89.5, close: 90, volume: 1_100 })
  Object.assign(bars[276], { open: 87, high: 88, low: 85, close: 86, volume: 1_100 })
  Object.assign(bars[277], { open: 86, high: 87, low: 84, close: 85, volume: 900 })
  Object.assign(bars[278], { open: 86, high: 88, low: 85, close: 87, volume: 900 })
  Object.assign(bars[279], { open: 89.2, high: 91.3, low: 89, close: 91.2, volume: 2_000 })
  const features = deriveStockTechnicalDailyFeatures(bars)
  assert.equal(features.stockTechS10Trigger, 1)
  assert((features.stockTechS10GapUpAtr ?? 0) >= 0.10)
  assert((features.stockTechS10PreDecline ?? 0) >= 0.08)
}