import {
  DEFAULT_STRATEGY_SPECS,
  assessCandidateAgainstStrategySpecs,
  deriveStrategyRawSignals,
  deriveStrategyThresholdScores,
  validateStrategySpec,
} from './strategySpec'
import type { StrategySpec } from './strategySpec'
import { assertOwnerCanOwn, ownerOwns } from './strategyOwnerFreeze'
import { annotateCandidateWithStrategySpecs } from './screenerStrategyConsumer'
import { dryRunStrategySpec, listStrategySpecs } from './strategyLab'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const BASE_RUNTIME_STRATEGY_IDS = [
  'trend_following_seed_v1',
  'breakout_vol_expansion_seed_v1',
  'defensive_accumulation_seed_v1',
  'finlab_ai_skill_quality_trend_v1',
  'finlab_ai_skill_reversion_value_v1',
  'finlab_ai_skill_revenue_revision_breakout_v1',
  'finlab_ai_skill_broker_accumulation_reclaim_v1',
  'alphabuilders_multifactor_revenue_quality_momentum_v1',
] as const

const ACTIVE_PRODUCTION_STRATEGY_IDS = [
  'trend_following_seed_v1',
  'breakout_vol_expansion_seed_v1',
  'defensive_accumulation_seed_v1',
  'finlab_ai_skill_broker_accumulation_reclaim_v1',
  'alphabuilders_multifactor_revenue_quality_momentum_v1',
] as const

const CANDIDATE_STRATEGY_IDS = [
  'finlab_ai_skill_quality_trend_v1',
  'finlab_ai_skill_reversion_value_v1',
  'finlab_ai_skill_revenue_revision_breakout_v1',
] as const

const legacyScoreThresholdKeys = ['minSeedScore', 'minChipScore', 'minTechScore', 'minMomentumScore'] as const

{
  const ids = DEFAULT_STRATEGY_SPECS.map((spec) => spec.id)
  const activeIds = DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'active').map((spec) => spec.id)
  const candidateIds = DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'candidate').map((spec) => spec.id)
  assert(DEFAULT_STRATEGY_SPECS.length === 8, 'bootstrap manifest should expose exactly 8 base runtime strategies')
  assert(
    JSON.stringify(ids) === JSON.stringify(BASE_RUNTIME_STRATEGY_IDS),
    `bootstrap manifest ids changed unexpectedly: ${ids.join(',')}`,
  )
  assert(
    JSON.stringify(activeIds) === JSON.stringify(ACTIVE_PRODUCTION_STRATEGY_IDS),
    `bootstrap active ids changed unexpectedly: ${activeIds.join(',')}`,
  )
  assert(
    JSON.stringify(candidateIds) === JSON.stringify(CANDIDATE_STRATEGY_IDS),
    `bootstrap candidate ids changed unexpectedly: ${candidateIds.join(',')}`,
  )
  assert(DEFAULT_STRATEGY_SPECS.every((spec) => spec.status === 'active' || spec.status === 'candidate'), 'bootstrap manifest must not contain retired/research/shadow strategies')
  assert(DEFAULT_STRATEGY_SPECS.every((spec) => spec.ownerType === 'strategy'), 'all bootstrap specs should be owned by strategy')
  assert(DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'active').every((spec) => spec.promotionStatus === 'production'), 'active bootstrap specs should be production promotion status')
  assert(DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'candidate').every((spec) => spec.promotionStatus === 'candidate'), 'candidate bootstrap specs should be candidate promotion status')
  assert(ids.every((id) => BASE_RUNTIME_STRATEGY_IDS.includes(id as typeof BASE_RUNTIME_STRATEGY_IDS[number])), 'bootstrap manifest must only contain the approved 8 base strategy ids')
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
  const activeIds = new Set(DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'active').map((spec) => spec.id))
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
  const base0081: StrategySpec = {
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
          calibration: {
            schemaVersion: 'strategy-feature-ref-weighted-score-calibration-v1',
            calibrationId: 'alpha_miner_pymoo_nsga3_novelty_0081:formal137-scale:v20260622',
            status: 'active',
            method: 'validation_fold_top_after_base_gates',
            originalMin: 0.62,
            calibratedMin: 0.382732,
            validationFold: { startDate: '2026-06-22', endDate: '2026-06-22', excludedDates: ['2026-06-23'] },
            targetDailyMatches: 16,
            observed: {
              validationRows: 820,
              validationCompleteFeatureRows: 820,
              validationMatchesAtOriginalMin: 0,
              validationMatchesAtCalibratedMin: 16,
              holdoutDate: '2026-06-23',
              holdoutMatchesAtCalibratedMin: 11,
            },
            sourceRefs: ['strategy_decision_log:2026-06-22', 'holdout:2026-06-23'],
            frozenAt: '2026-06-24T00:00:00Z',
          },
        },
      },
    },
  }
  const candidate = {
    symbol: '6274',
    current_price: 85,
    raw_signals: {
      volumeExpansion20: 0.916,
      factorSignals: {
        KLOW2: 0.73,
        advance_ratio: 0.22,
        CNTD_20: 0.20,
        KSFT: 0.05,
      },
    },
  }
  const calibrated = assessCandidateAgainstStrategySpecs(candidate, [base0081])
  assert(
    calibrated.matches.some((match) => match.specId === 'alpha_miner_pymoo_nsga3_novelty_0081'),
    'active 0081 formal137-scale calibration should use calibratedMin while preserving originalMin as evidence',
  )

  const shadowOnly = assessCandidateAgainstStrategySpecs(candidate, [{
    ...base0081,
    thresholds: {
      ...base0081.thresholds,
      featureRefs: {
        weightedScore: {
          ...base0081.thresholds.featureRefs.weightedScore,
          calibration: {
            ...base0081.thresholds.featureRefs.weightedScore.calibration,
            status: 'shadow',
          },
        },
      },
    },
  }])
  assert(!shadowOnly.matches.length, 'shadow 0081 calibration must not affect production matching')
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
    symbol: '3034',
    current_price: 85,
    raw_signals: {
      volumeExpansion20: 0.9,
      factorSignals: {
        KLOW2: 0.9,
        advance_ratio: 0.7,
        CNTD_20: 0.8,
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
  assert(!assessment.matches.length, '0081 must fail closed when any positive-weight formal feature is missing')
  assert(
    assessment.watchPoints.some((point) => point.includes('strategy_spec_missing_required_feature_refs:alpha_miner_pymoo_nsga3_novelty_0081:KSFT')),
    '0081 missing formal feature should be visible in watch points',
  )
}

{
  const assessment = assessCandidateAgainstStrategySpecs({
    symbol: '2303',
    current_price: 42,
    raw_signals: {
      volumeExpansion20: 0.9,
      monthlyRevenueMoM: 0.3,
      ma10Bias: 0.9,
      return5d: 0.9,
      factorSignals: {
        monthlyRevenueMoM: 0.3,
        ma10_bias: 0.9,
        return_5d: 0.9,
      },
    },
  }, [{
    ...DEFAULT_STRATEGY_SPECS[0],
    id: 'alpha_miner_pymoo_nsga3_novelty_0187',
    thresholds: {
      minPrice: 10,
      minVolumeExpansion20: 0.55,
      featureRefs: {
        weightedScore: {
          min: 0.6,
          terms: [
            { featureRef: 'KSFT2', signal: 'factorSignals.KSFT2', weight: 0.31228 },
            { featureRef: 'monthlyRevenueMoM', signal: 'factorSignals.monthlyRevenueMoM', weight: 0.266864 },
            { featureRef: 'CNTN_20', signal: 'factorSignals.CNTN_20', weight: 0.224972 },
            { featureRef: 'ma10_bias', signal: 'factorSignals.ma10_bias', weight: 0.085907 },
            { featureRef: 'return_5d', signal: 'factorSignals.return_5d', weight: 0.109977 },
          ],
        },
      },
    },
  }])
  assert(!assessment.matches.length, '0187 must not match by reweighting partial evidence')
  assert(
    assessment.watchPoints.some((point) => point.includes('KSFT2') && point.includes('CNTN_20')),
    '0187 missing formal features should be visible in watch points',
  )
}

{
  const spec = {
    ...DEFAULT_STRATEGY_SPECS[0],
    id: 'alpha_miner_pymoo_nsga3_novelty_0193',
    thresholds: {
      minPrice: 10,
      minVolumeExpansion20: 0.55,
      featureRefs: {
        weightedScore: {
          min: 0.58,
          terms: [
            { featureRef: 'us_sentiment_score', signal: 'factorSignals.us_sentiment_score', weight: 0.478671 },
            { featureRef: 'margin_balance', signal: 'factorSignals.margin_balance', weight: 0.521329 },
          ],
        },
      },
    },
  }
  const rawOnly = assessCandidateAgainstStrategySpecs({
    symbol: '2884',
    current_price: 30,
    raw_signals: {
      volumeExpansion20: 0.9,
      marginBalance: 68_793,
      factorSignals: {
        us_sentiment_score: 1,
        margin_balance: 68_793,
      },
    },
  }, [spec])
  assert(!rawOnly.matches.length, '0193 must not score raw margin balance as a normalized feature')
  assert(
    rawOnly.watchPoints.some((point) => point.includes('strategy_spec_missing_required_feature_refs:alpha_miner_pymoo_nsga3_novelty_0193:') && point.includes('margin_balance')),
    '0193 should expose missing normalized margin balance evidence',
  )

  const normalizedMarginOnly = assessCandidateAgainstStrategySpecs({
    symbol: '2884',
    current_price: 30,
    raw_signals: {
      volumeExpansion20: 0.9,
      marginBalance: 68_793,
      factorSignals: {
        us_sentiment_score: 1,
        margin_balance: 68_793,
        finlabCsMarginBalanceRank: 0.7,
      },
    },
  }, [spec])
  assert(!normalizedMarginOnly.matches.length, '0193 must not score raw constant us sentiment as stock-selection evidence')
  assert(
    normalizedMarginOnly.watchPoints.some((point) => point.includes('strategy_spec_missing_required_feature_refs:alpha_miner_pymoo_nsga3_novelty_0193:us_sentiment_score')),
    '0193 should expose missing normalized/non-constant us sentiment evidence',
  )

  const normalized = assessCandidateAgainstStrategySpecs({
    symbol: '2884',
    current_price: 30,
    raw_signals: {
      volumeExpansion20: 0.9,
      marginBalance: 68_793,
      factorSignals: {
        us_sentiment_score: 1,
        formal137UsSentimentScoreRank: 0.9,
        margin_balance: 68_793,
        finlabCsMarginBalanceRank: 0.7,
      },
    },
  }, [spec])
  assert(
    normalized.matches.some((match) => match.specId === 'alpha_miner_pymoo_nsga3_novelty_0193'),
    '0193 should match only when normalized margin and normalized/non-constant sentiment evidence are present',
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
    assessment.matches.some((match) => match.specId === 'finlab_ai_skill_revenue_revision_breakout_v1' && match.status === 'candidate'),
    'revenue revision strategy should remain matchable from the candidate pool',
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
  const smrcVwapSpec: StrategySpec = {
    id: 'smrc_vwap_reclaim_v1',
    version: 'strategy-spec-v1',
    name: 'SMRC VWAP daily reclaim',
    status: 'active',
    owner: 'strategy',
    familyId: 'SMC_STRUCTURE_RECLAIM',
    variantId: 'daily_smc_vwap_reclaim_v1',
    ownerType: 'strategy',
    promotionStatus: 'production',
    alphaBucket: 'breakout_vol_expansion',
    supportedRegimes: ['bull', 'sideways', 'volatile'],
    thesis: 'Daily SMC structure reclaim plus VWAP bias setup; intraday S12 remains the execution gate.',
    thresholds: {
      minPrice: 10,
      minVolumeExpansion20: 0.6,
      featureRefs: {
        all: [
          { featureRef: 'vwap_bias', signal: 'factorSignals.vwap_bias', op: '>=', value: -0.005 },
          { featureRef: 'vwap_bias_5d', signal: 'factorSignals.vwap_bias_5d', op: '>=', value: -0.01 },
          { featureRef: 'l1_smcNetScore', signal: 'technicalIndicators.smcNetScore', op: '>=', value: 0 },
        ],
        not: [
          { featureRef: 'smcBiasBearish', signal: 'technicalIndicators.smcBiasBearish', op: '==', value: 1 },
        ],
        weightedScore: {
          min: 0.58,
          terms: [
            { featureRef: 'vwap_bias', signal: 'factorSignals.finlabCsVwapBiasRank', weight: 0.28 },
            { featureRef: 'vwap_bias_5d', signal: 'factorSignals.finlabCsVwapBias5dRank', weight: 0.22 },
            { featureRef: 'l1_bestOrderBlockStrength', signal: 'factorSignals.finlabCsBestOrderBlockStrengthRank', weight: 0.25 },
            { featureRef: 'l1_volumeExpansion20', signal: 'factorSignals.finlabCsVolumeExpansion20Rank', weight: 0.15 },
            { featureRef: 'l1_smcBullishScore', signal: 'technicalIndicators.smcBullishScore', weight: 0.1 },
          ],
          calibration: {
            schemaVersion: 'strategy-feature-ref-weighted-score-calibration-v1',
            calibrationId: 'smrc_vwap_reclaim_v1:threshold-sensitivity:v20260707',
            status: 'active',
            method: 'threshold_sensitivity_backtest',
            originalMin: 0.58,
            calibratedMin: 0.74,
            validationFold: { startDate: '2023-01-01', endDate: '2026-06-15' },
            targetDailyMatches: 160,
            observed: {
              validationRows: 830,
              validationCompleteFeatureRows: 830,
              validationMatchesAtOriginalMin: 301,
              validationMatchesAtCalibratedMin: 135,
              holdoutDate: '2026-06-15',
              holdoutMatchesAtCalibratedMin: 180,
            },
            sourceRefs: [
              'data/strategy_calibrations/smrc_vwap_reclaim_v1_threshold_selection_20260707.json',
              'output/finlab_strategy_backtests_smrc_vwap/finlab_strategy_spec_runtime1_20230101_20260615.csv',
            ],
            frozenAt: '2026-07-07T00:00:00Z',
          },
        },
      },
    },
    candidatePolicy: {
      poolQuota: 8,
      costBudget: 12,
      evidenceRequirements: ['daily_vwap_proxy', 'smc_structure_reclaim', 'finlab_strategy_spec_backtest'],
      maxMlShare: 0.18,
    },
    riskNotes: ['Active daily strategy; daily VWAP setup must not override S12 intraday execution confirmation.'],
    createdBy: 'p5_strategy_governance',
  }

  const matched = assessCandidateAgainstStrategySpecs({
    symbol: '3034',
    current_price: 85,
    raw_signals: {
      volumeExpansion20: 0.9,
      factorSignals: {
        vwap_bias: 0.004,
        vwap_bias_5d: 0.018,
        finlabCsVwapBiasRank: 0.9,
        finlabCsVwapBias5dRank: 0.86,
        finlabCsBestOrderBlockStrengthRank: 0.82,
        finlabCsVolumeExpansion20Rank: 0.8,
      },
      technicalIndicators: {
        smcBullishScore: 0.5,
        smcNetScore: 0.06,
        smcBiasBearish: 0,
        bestOrderBlockStrength: 0.7,
      },
    },
  }, [smrcVwapSpec])
  assert(matched.matches.some((match) => match.specId === 'smrc_vwap_reclaim_v1'), 'SMRC VWAP daily strategy should match daily VWAP + SMC evidence')

  const aboveOriginalBelowCalibration = assessCandidateAgainstStrategySpecs({
    symbol: '3035',
    current_price: 85,
    raw_signals: {
      volumeExpansion20: 0.9,
      factorSignals: {
        vwap_bias: 0.004,
        vwap_bias_5d: 0.018,
        finlabCsVwapBiasRank: 0.62,
        finlabCsVwapBias5dRank: 0.62,
        finlabCsBestOrderBlockStrengthRank: 0.62,
        finlabCsVolumeExpansion20Rank: 0.62,
      },
      technicalIndicators: {
        smcBullishScore: 0.62,
        smcNetScore: 0.06,
        smcBiasBearish: 0,
        bestOrderBlockStrength: 0.7,
      },
    },
  }, [smrcVwapSpec])
  assert(
    !aboveOriginalBelowCalibration.matches.length,
    'SMRC VWAP daily strategy should use calibratedMin=0.74 instead of the original weightedScore.min=0.58',
  )

  const missingVwap = assessCandidateAgainstStrategySpecs({
    symbol: '3034',
    current_price: 85,
    raw_signals: {
      volumeExpansion20: 0.9,
      technicalIndicators: {
        stockTechS12Score: 2,
        smcBullishScore: 0.08,
        smcNetScore: 0.06,
        smcBiasBearish: 0,
      },
    },
  }, [smrcVwapSpec])
  assert(!missingVwap.matches.length, 'SMRC VWAP daily strategy must fail closed when daily VWAP evidence is absent')
  assert(
    missingVwap.watchPoints.some((point) => point.includes('strategy_spec_missing_required_feature_refs:smrc_vwap_reclaim_v1')),
    'SMRC VWAP daily strategy should report missing daily feature refs instead of falling through to intraday S12',
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
