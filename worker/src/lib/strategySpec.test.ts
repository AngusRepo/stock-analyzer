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

const legacyScoreThresholdKeys = ['minSeedScore', 'minChipScore', 'minTechScore', 'minMomentumScore'] as const

{
  for (const spec of DEFAULT_STRATEGY_SPECS) {
    const validation = validateStrategySpec(spec)
    assert(validation.ok, `${spec.id} should be valid: ${validation.errors.join(',')}`)
    assert(spec.candidatePolicy?.poolQuota != null, `${spec.id} should define strategy-first pool quota`)
    assert((spec.candidatePolicy?.evidenceRequirements ?? []).length > 0, `${spec.id} should define evidence requirements`)
  }
}

{
  const productionSpecs = DEFAULT_STRATEGY_SPECS.filter((spec) => spec.status === 'active' || spec.id === 'finlab_ai_skill_discovery_v1')
  for (const spec of productionSpecs) {
    for (const key of legacyScoreThresholdKeys) {
      assert(spec.thresholds[key] == null, `${spec.id} must not use legacy Score V2 threshold ${key} in L1 strategy specs`)
    }
  }
}

{
  const finlabDiscovery = DEFAULT_STRATEGY_SPECS.find((spec) => spec.id === 'finlab_ai_skill_discovery_v1')
  assert(finlabDiscovery?.status === 'research', 'FinLab AI Skill should be an active research discovery lane')
  assert(finlabDiscovery?.candidatePolicy?.maxMlShare === 0, 'FinLab AI Skill discovery lane must not enter ML queue directly')
  assert(
    finlabDiscovery?.candidatePolicy?.evidenceRequirements?.includes('strategy_hypothesis'),
    'FinLab AI Skill discovery lane should require strategy hypothesis evidence',
  )
  assert(
    finlabDiscovery?.candidatePolicy?.evidenceRequirements?.includes('raw_factor_mining'),
    'FinLab AI Skill discovery lane should preserve factor-mining evidence',
  )
  assert(
    finlabDiscovery?.candidatePolicy?.evidenceRequirements?.includes('raw_technical_indicator_mining'),
    'FinLab AI Skill discovery lane should preserve technical-indicator mining evidence',
  )
}

{
  for (const id of ['trend_following_seed_v1', 'breakout_vol_expansion_seed_v1', 'defensive_accumulation_seed_v1']) {
    const spec = DEFAULT_STRATEGY_SPECS.find((row) => row.id === id)
    assert(spec?.status === 'active', `${id} should be an active production seed strategy`)
  }
}

{
  const activeFinLabSpecs = DEFAULT_STRATEGY_SPECS.filter((spec) => spec.id.startsWith('finlab_ai_skill_') && spec.status === 'active')
  assert(activeFinLabSpecs.length >= 8, 'FinLab AI Skill production specs should widen L1 diversity beyond the first seeded batch')
  assert(
    activeFinLabSpecs.every((spec) => (spec.candidatePolicy?.maxMlShare ?? 1) > 0),
    'active FinLab AI Skill specs must be eligible for the L2 coarse ML queue',
  )
  assert(
    activeFinLabSpecs.every((spec) => spec.thresholds.minSeedScore == null && spec.thresholds.minChipScore == null && spec.thresholds.minTechScore == null && spec.thresholds.minMomentumScore == null),
    'active FinLab AI Skill specs must use raw row signals, not Score V2/chip/technical proxy thresholds',
  )
  assert(
    activeFinLabSpecs.every((spec) => !(spec.candidatePolicy?.evidenceRequirements ?? []).includes('score_v2')),
    'active FinLab AI Skill specs must not require score_v2 evidence',
  )
  assert(
    activeFinLabSpecs
      .filter((spec) => spec.id.includes('factor') || spec.id.includes('revision') || spec.id.includes('reclaim') || spec.id.includes('broker'))
      .every((spec) => (spec.candidatePolicy?.evidenceRequirements ?? []).some((item) => item.includes('raw_factor') || item.includes('raw_technical_indicator'))),
    'new FinLab AI Skill production specs should be generated from raw factor/technical-indicator mining evidence',
  )
  assert(
    activeFinLabSpecs.every((spec) => spec.riskNotes.some((note) => note.includes('future FinLab AI discoveries') || note.includes('Active breadth strategy') || note.includes('L2/L3') || note.includes('Mean-reversion'))),
    'active FinLab AI Skill specs should document that only this seeded batch bypasses the discovery lane',
  )
}

{
  const candidate = {
    symbol: '2454',
    raw_signals: {
      close: 120,
      closeAboveMa20Pct: 0.03,
      closeAboveMa60Pct: 0.02,
      volumeExpansion20: 1.35,
      return20d: 0.08,
      revenueGrowthYoY: 12,
      monthlyRevenueYoY: 16,
      roe: 15,
      eps: 2.4,
      pe: 18,
      pb: 2,
      foreignTrustNet5d: 1500,
      brokerNetAmount5d: 20_000_000,
      brokerCount: 12,
      brokerConcentration: 0.35,
    },
  }
  const assessment = assessCandidateAgainstStrategySpecs(candidate, DEFAULT_STRATEGY_SPECS)
  assert(
    assessment.matches.some((match) => match.specId.startsWith('finlab_ai_skill_')),
    'raw row indicators should be sufficient for active FinLab AI Skill strategy matches without Score V2 or current_price',
  )
}

{
  const candidate = {
    symbol: '3034',
    current_price: 85,
    raw_signals: {
      closeAboveMa20Pct: 0.025,
      closeAboveMa60Pct: 0.01,
      volumeExpansion20: 1.18,
      return20d: 0.04,
      revenueGrowthYoY: 9,
      monthlyRevenueYoY: 14,
      monthlyRevenueMoM: 2,
      roe: 13,
      eps: 1.6,
      pe: 22,
      pb: 2.4,
      foreignTrustNet5d: 600,
      brokerNetAmount5d: 8_000_000,
      brokerCount: 7,
      brokerConcentration: 0.45,
      technicalIndicators: {
        rsi14: 56,
        volumeExpansion20: 1.18,
        closeAboveMa20Pct: 0.025,
      },
      factorSignals: {
        monthlyRevenueYoY: 14,
        monthlyRevenueMoM: 2,
        revenueGrowthYoY: 9,
        brokerNetAmount5d: 8_000_000,
        brokerCount: 7,
        roe: 13,
        eps: 1.6,
      },
    },
  }
  const assessment = assessCandidateAgainstStrategySpecs(candidate, DEFAULT_STRATEGY_SPECS)
  assert(
    assessment.matches.some((match) => match.specId === 'finlab_ai_skill_revenue_revision_breakout_v1'),
    'new FinLab AI Skill revenue revision strategy should match raw mined factors directly in production',
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
      technicalIndicators: {
        rsi14: 48,
      },
    },
  }, DEFAULT_STRATEGY_SPECS)
  assert(
    assessment.matches.some((match) => match.specId === 'defensive_accumulation_seed_v1' || match.specId === 'finlab_ai_skill_chip_accumulation_v1'),
    'listed/OTC accumulation strategies should not require ROTC-only brokerCount coverage',
  )
}

{
  const raw = deriveStrategyRawSignals({
    symbol: '3034',
    current_price: 80,
    raw_signals: {
      closeAboveMa20Pct: 0.04,
      volumeExpansion20: 1.25,
      factorSignals: {
        finlabRevenueAcceleration: 1.4,
        brokerAccumulationPersistence: 0.7,
      },
      technicalIndicators: {
        rsi14: 58,
        macdHistogramSlope: 0.12,
      },
    },
  })
  assert(raw.factorSignals?.finlabRevenueAcceleration === 1.4, 'raw parser should preserve FinLab-discovered factor signals')
  assert(raw.technicalIndicators?.rsi14 === 58, 'raw parser should preserve FinLab-discovered technical indicators')

  const assessment = assessCandidateAgainstStrategySpecs({
    symbol: '3034',
    current_price: 80,
    raw_signals: raw,
  }, [{
    ...DEFAULT_STRATEGY_SPECS[0],
    id: 'finlab_dynamic_factor_threshold_test_v1',
    thresholds: {
      minPrice: 10,
      minFactorSignals: { finlabRevenueAcceleration: 1 },
      minTechnicalIndicators: { rsi14: 50, macdHistogramSlope: 0 },
    },
  }])
  assert(assessment.matches.length === 1, 'strategy specs should support discovered factor and technical-indicator thresholds')
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
      finalScore: 66,
      components: {
        mlEdge: 10,
        chipFlow: 24,
        technicalStructure: 22,
        fundamentalQuality: 8,
        newsTheme: 2,
      },
      technicalBreakdown: {
        volumeConfirmation: 4,
      },
    }),
  }
  const assessment = assessCandidateAgainstStrategySpecs(candidate, DEFAULT_STRATEGY_SPECS)
  assert(
    assessment.matches.every((match) => match.status !== 'active'),
    'Score V2 alone must not match active L1 strategies after raw-signal migration',
  )
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
      technicalBreakdown: {
        trendStructure: 6,
        volatilityStructure: 4,
        reversalExtreme: 4,
        volumeConfirmation: 3,
        executionRisk: 1,
      },
      seedComponents: {
        screenerMomentumSeed20: 10,
      },
    }),
  }
  const scores = deriveStrategyThresholdScores(candidate)
  const assessment = assessCandidateAgainstStrategySpecs(candidate, DEFAULT_STRATEGY_SPECS)
  assert(scores.source === 'score_v2', 'strategy thresholds should prefer canonical Score V2 components')
  assert(scores.seedScore === 70, 'strategy seed score should use canonical finalScore')
  assert(
    assessment.matches.every((match) => match.status !== 'active'),
    'Score V2 compatibility parser must not make default L1 baseline match old proxy thresholds',
  )
}

{
  const weak = annotateCandidateWithStrategySpecs({
    symbol: '9999',
    current_price: 20,
  })
  assert(
    weak.strategy_matches?.every((match) => match.status !== 'active'),
    'weak seed should not match active production strategy specs',
  )
}

{
  const legacyOnly = deriveStrategyThresholdScores({
    symbol: '2330',
    current_price: 900,
  })
  assert(legacyOnly.source === 'missing_score_v2', 'strategy thresholds must not project legacy score fields into Score V2')
  assert(legacyOnly.seedScore === 0, 'legacy-only strategy candidate should not pass seed thresholds')
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
  const specs = listStrategySpecs()
  const result = dryRunStrategySpec(specs[0], [
    {
      symbol: '2330',
      current_price: 900,
      raw_signals: {
        closeAboveMa20Pct: 0.03,
        closeAboveMa60Pct: 0.02,
        volumeExpansion20: 1.25,
        return20d: 0.06,
      },
    },
    { symbol: '0000', current_price: 12 },
  ])
  assert(result.valid, 'dry-run spec should be valid')
  assert(result.sampleSize === 2, 'dry-run should report sample size')
  assert(result.matched >= 1, 'dry-run should count matches')
}
