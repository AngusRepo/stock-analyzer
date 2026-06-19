import {
  DEFAULT_STRATEGY_SPECS,
  assessCandidateAgainstStrategySpecs,
  deriveStrategyRawSignals,
  deriveStrategyThresholdScores,
  validateStrategySpec,
} from './strategySpec'
import { assertOwnerCanOwn, ownerOwns } from './strategyOwnerFreeze'
import { annotateCandidateWithStrategySpecs } from './screenerStrategyConsumer'
import { dryRunStrategySpec, listStrategySpecs } from './strategyLab'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const ACTIVE_PRODUCTION_STRATEGY_IDS = [
  'trend_following_seed_v1',
  'breakout_vol_expansion_seed_v1',
  'defensive_accumulation_seed_v1',
  'finlab_ai_skill_quality_trend_v1',
  'finlab_ai_skill_reversion_value_v1',
  'finlab_ai_skill_revenue_revision_breakout_v1',
  'finlab_ai_skill_broker_accumulation_reclaim_v1',
  'alphabuilders_multifactor_revenue_quality_momentum_v1',
] as const

const legacyScoreThresholdKeys = ['minSeedScore', 'minChipScore', 'minTechScore', 'minMomentumScore'] as const

{
  const ids = DEFAULT_STRATEGY_SPECS.map((spec) => spec.id)
  assert(DEFAULT_STRATEGY_SPECS.length === 8, 'bootstrap manifest should expose exactly 8 base production strategies')
  assert(
    JSON.stringify(ids) === JSON.stringify(ACTIVE_PRODUCTION_STRATEGY_IDS),
    `bootstrap manifest ids changed unexpectedly: ${ids.join(',')}`,
  )
  assert(DEFAULT_STRATEGY_SPECS.every((spec) => spec.status === 'active'), 'bootstrap manifest must not contain retired/research/shadow strategies')
  assert(DEFAULT_STRATEGY_SPECS.every((spec) => spec.ownerType === 'strategy'), 'all bootstrap specs should be owned by strategy')
  assert(DEFAULT_STRATEGY_SPECS.every((spec) => spec.promotionStatus === 'production'), 'all bootstrap specs should be production promotion status')
  assert(ids.every((id) => ACTIVE_PRODUCTION_STRATEGY_IDS.includes(id as typeof ACTIVE_PRODUCTION_STRATEGY_IDS[number])), 'bootstrap manifest must only contain the approved 8 base strategy ids')
}

{
  for (const spec of DEFAULT_STRATEGY_SPECS) {
    const validation = validateStrategySpec(spec)
    assert(validation.ok, `${spec.id} should be valid: ${validation.errors.join(',')}`)
    assert(spec.candidatePolicy?.poolQuota != null, `${spec.id} should define strategy-first pool quota`)
    assert((spec.candidatePolicy?.evidenceRequirements ?? []).length > 0, `${spec.id} should define evidence requirements`)
    assert(spec.familyId != null, `${spec.id} should declare a strategy family`)
    assert(spec.variantId != null, `${spec.id} should declare a strategy variant`)
    for (const key of legacyScoreThresholdKeys) {
      assert(spec.thresholds[key] == null, `${spec.id} must not use legacy Score V2 threshold ${key} in L1 strategy specs`)
    }
  }
}

{
  const activeIds = new Set(DEFAULT_STRATEGY_SPECS.map((spec) => spec.id))
  assert([...activeIds].filter((id) => id.startsWith('alpha_miner_pymoo_nsga3_novelty_')).length === 0, 'mined strategies must live in D1 strategy_spec_registry, not TS bootstrap defaults')
  assert([...activeIds].filter((id) => id.startsWith('alphabuilders_multifactor_')).length === 1, 'only one AlphaBuilders strategy should remain production active')
}

{
  const raw = deriveStrategyRawSignals({
    symbol: '3034',
    current_price: 80,
    raw_signals: {
      ma10Bias: 0.03,
      return5d: 0.04,
      marginBalance: 1_200_000,
      factorSignals: {
        KLOW2: 0.74,
        advance_ratio: 0.61,
        CNTD_20: 0.66,
        KSFT: 0.69,
        finlabRevenueAcceleration: 1.4,
      },
      technicalIndicators: {
        rsi14: 58,
        macdHistogramSlope: 0.12,
      },
    },
  })
  assert(raw.factorSignals?.KLOW2 === 0.74, 'raw parser should preserve mined feature_ref factor values')
  assert(raw.factorSignals?.ma10_bias === 0.03, 'raw parser should expose ma10Bias alias for mined strategies')
  assert(raw.factorSignals?.return_5d === 0.04, 'raw parser should expose return5d alias for mined strategies')
  assert(raw.factorSignals?.margin_balance === 1_200_000, 'raw parser should expose margin balance evidence')
  assert(raw.factorSignals?.finlabRevenueAcceleration === 1.4, 'raw parser should preserve discovered factor signals')
  assert(raw.technicalIndicators?.rsi14 === 58, 'raw parser should preserve discovered technical indicators')
}

{
  const assessment = assessCandidateAgainstStrategySpecs({
    symbol: '3034',
    current_price: 85,
    raw_signals: {
      volumeExpansion20: 0.9,
      factorSignals: {
        KLOW2: 0.9,
        advance_ratio: 0.7,
        CNTD_20: 0.8,
        KSFT: 0.8,
      },
    },
  }, [{
    ...DEFAULT_STRATEGY_SPECS[0],
    id: 'alpha_miner_pymoo_nsga3_novelty_0081',
    thresholds: {
      minPrice: 10,
      minVolumeExpansion20: 0.7,
      featureRefs: {
        weightedScore: {
          min: 0.62,
          terms: [
            { featureRef: 'KLOW2', signal: 'factorSignals.KLOW2', weight: 0.415128 },
            { featureRef: 'advance_ratio', signal: 'factorSignals.advance_ratio', weight: 0.117772 },
            { featureRef: 'CNTD_20', signal: 'factorSignals.CNTD_20', weight: 0.20684 },
            { featureRef: 'KSFT', signal: 'factorSignals.KSFT', weight: 0.260259 },
          ],
        },
      },
    },
  }])
  assert(
    assessment.matches.some((match) => match.specId === 'alpha_miner_pymoo_nsga3_novelty_0081'),
    'mined strategy should match through formal featureRefs, not alphaMiner composite score',
  )
}

{
  const assessment = assessCandidateAgainstStrategySpecs({
    symbol: '2330',
    current_price: 900,
    raw_signals: {
      closeAboveMa20Pct: 0.03,
      closeAboveMa60Pct: 0.02,
      volumeExpansion20: 1.25,
      return20d: 0.06,
      technicalIndicators: { macdHist: 0.1, adx14: 23, diTrend: 5 },
    },
  }, DEFAULT_STRATEGY_SPECS)
  assert(assessment.matches.some((match) => match.specId === 'trend_following_seed_v1'), 'trend seed should match raw trend evidence')
}

{
  const assessment = assessCandidateAgainstStrategySpecs({
    symbol: '3034',
    current_price: 85,
    raw_signals: {
      closeAboveMa20Pct: 0.025,
      volumeExpansion20: 1.18,
      return20d: 0.04,
      revenueGrowthYoY: 9,
      monthlyRevenueYoY: 14,
      monthlyRevenueMoM: 2,
      roe: 13,
      eps: 1.6,
      technicalIndicators: {
        rsi14: 56,
        volumeExpansion20: 1.18,
        closeAboveMa20Pct: 0.025,
      },
      factorSignals: {
        monthlyRevenueYoY: 14,
        monthlyRevenueMoM: 2,
        revenueGrowthYoY: 9,
      },
    },
  }, DEFAULT_STRATEGY_SPECS)
  assert(
    assessment.matches.some((match) => match.specId === 'finlab_ai_skill_revenue_revision_breakout_v1'),
    'revenue revision strategy should match raw mined revenue factors directly in production',
  )
}

{
  const assessment = assessCandidateAgainstStrategySpecs({
    symbol: '1216',
    current_price: 78,
    raw_signals: {
      closeAboveMa20Pct: -0.01,
      volumeExpansion20: 0.95,
      foreignTrustNet5d: 1200,
    },
  }, DEFAULT_STRATEGY_SPECS)
  assert(
    assessment.matches.some((match) => match.specId === 'defensive_accumulation_seed_v1'),
    'defensive accumulation should not require brokerCount coverage',
  )
}

{
  const assessment = assessCandidateAgainstStrategySpecs({
    symbol: '2454',
    current_price: 120,
    raw_signals: {
      volumeExpansion20: 0.9,
      monthlyRevenueYoY: 12,
      monthlyRevenueMoM: 3,
      closeAboveMa20Pct: -0.01,
      factorSignals: { monthlyRevenueYoY: 12, monthlyRevenueMoM: 3 },
    },
  }, DEFAULT_STRATEGY_SPECS)
  assert(
    assessment.matches.some((match) => match.specId === 'alphabuilders_multifactor_revenue_quality_momentum_v1'),
    'retained AlphaBuilders revenue-quality strategy should match revenue plus price evidence',
  )
}

{
  const validation = validateStrategySpec({
    ...DEFAULT_STRATEGY_SPECS[0],
    thresholds: {
      ...DEFAULT_STRATEGY_SPECS[0].thresholds,
      score: 60,
      chip_score: 24,
      techScore: 20,
      momentum_score: 8,
    } as any,
  })
  assert(!validation.ok, 'strategy specs must reject legacy scalar score threshold keys')
  for (const key of ['thresholds.score', 'thresholds.chip_score', 'thresholds.techScore', 'thresholds.momentum_score']) {
    assert(validation.errors.includes(`forbidden_key:${key}`), `strategy spec should reject ${key}`)
  }
}

{
  const candidate = {
    symbol: '2330',
    current_price: 900,
    score_v2: JSON.stringify({
      version: 'score_v2',
      finalScore: 70,
      components: {
        mlEdge: 12,
        chipFlow: 24,
        technicalStructure: 22,
        fundamentalQuality: 10,
        newsTheme: 2,
      },
      technicalBreakdown: { trendStructure: 6, volatilityStructure: 4, reversalExtreme: 4, volumeConfirmation: 3, executionRisk: 1 },
      seedComponents: { screenerMomentumSeed20: 10 },
    }),
  }
  const scores = deriveStrategyThresholdScores(candidate)
  const assessment = assessCandidateAgainstStrategySpecs(candidate, DEFAULT_STRATEGY_SPECS)
  assert(scores.source === 'score_v2', 'strategy thresholds should prefer canonical Score V2 components')
  assert(scores.seedScore === 70, 'strategy seed score should use canonical finalScore')
  assert(
    assessment.matches.every((match) => match.status !== 'active'),
    'Score V2 compatibility parser must not make default L1 baseline match old thresholds',
  )
}

{
  const weak = annotateCandidateWithStrategySpecs({ symbol: '9999', current_price: 20 }, DEFAULT_STRATEGY_SPECS)
  assert(
    weak.strategy_matches?.every((match) => match.status !== 'active'),
    'weak seed should not match active production strategy specs',
  )
}

{
  const missingScore = deriveStrategyThresholdScores({ symbol: '2330', current_price: 900 })
  assert(missingScore.source === 'missing_score_v2', 'strategy thresholds must not project legacy score fields into Score V2')
  assert(missingScore.seedScore === 0, 'candidate without Score V2 should not receive synthetic score threshold values')
}

{
  assert(ownerOwns('strategy', 'strategy_spec'), 'strategy owner should own strategy spec')
  assert(ownerOwns('screener', 'candidate_discovery'), 'screener owner should own candidate discovery')
  let threw = false
  try {
    assertOwnerCanOwn('strategy', 'order_fill')
  } catch {
    threw = true
  }
  assert(threw, 'strategy owner must not own order fill')
}

{
  const specs = listStrategySpecs(DEFAULT_STRATEGY_SPECS)
  const result = dryRunStrategySpec(specs[0], [
    {
      symbol: '2330',
      current_price: 900,
      raw_signals: {
        closeAboveMa20Pct: 0.03,
        closeAboveMa60Pct: 0.02,
        volumeExpansion20: 1.25,
        return20d: 0.06,
        technicalIndicators: { macdHist: 0.1 },
      },
    },
    { symbol: '0000', current_price: 12 },
  ])
  assert(result.valid, 'dry-run spec should be valid')
  assert(result.sampleSize === 2, 'dry-run should report sample size')
  assert(result.matched >= 1, 'dry-run should count matches')
}
