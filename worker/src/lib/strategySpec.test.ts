import {
  DEFAULT_STRATEGY_SPECS,
  assessCandidateAgainstStrategySpecs,
  deriveStrategyThresholdScores,
  validateStrategySpec,
} from './strategySpec'
import { assertOwnerCanOwn, ownerOwns } from './strategyOwnerFreeze'
import { annotateCandidateWithStrategySpecs } from './screenerStrategyConsumer'
import { dryRunStrategySpec, listStrategySpecs } from './strategyLab'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  for (const spec of DEFAULT_STRATEGY_SPECS) {
    const validation = validateStrategySpec(spec)
    assert(validation.ok, `${spec.id} should be valid: ${validation.errors.join(',')}`)
    assert(spec.candidatePolicy?.poolQuota != null, `${spec.id} should define strategy-first pool quota`)
    assert((spec.candidatePolicy?.evidenceRequirements ?? []).length > 0, `${spec.id} should define evidence requirements`)
  }
}

{
  const candidate = {
    symbol: '2330',
    score: 66,
    chip_score: 24,
    tech_score: 22,
    momentum_score: 10,
    current_price: 900,
  }
  const assessment = assessCandidateAgainstStrategySpecs(candidate, DEFAULT_STRATEGY_SPECS)
  assert(assessment.matches.length >= 1, 'strong seed should match at least one strategy spec')
  assert(assessment.tags.some((tag) => tag.startsWith('strategy:')), 'strategy tags should be emitted')
}

{
  const candidate = {
    symbol: '2330',
    score: 10,
    chip_score: 1,
    tech_score: 1,
    momentum_score: 1,
    current_price: 900,
    score_components: JSON.stringify({
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
      legacyComponents: {
        screenerMomentum: 10,
      },
    }),
  }
  const scores = deriveStrategyThresholdScores(candidate)
  const assessment = assessCandidateAgainstStrategySpecs(candidate, DEFAULT_STRATEGY_SPECS)
  assert(scores.source === 'score_v2', 'strategy thresholds should prefer canonical Score V2 components')
  assert(scores.seedScore === 70, 'strategy seed score should use canonical finalScore')
  assert(assessment.matches.length >= 1, 'Score V2 seed should match even when legacy score fields are stale')
}

{
  const weak = annotateCandidateWithStrategySpecs({
    symbol: '9999',
    score: 30,
    chip_score: 2,
    tech_score: 2,
    momentum_score: 1,
    current_price: 20,
  })
  assert(weak.strategy_matches?.length === 0, 'weak seed should not match strategy spec')
  assert(weak.strategy_watch_points?.includes('strategy_spec:no_match'), 'weak seed should expose no-match watch point')
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
    { symbol: '2330', score: 70, chip_score: 25, tech_score: 24, momentum_score: 12, current_price: 900 },
    { symbol: '0000', score: 20, chip_score: 1, tech_score: 1, momentum_score: 1, current_price: 12 },
  ])
  assert(result.valid, 'dry-run spec should be valid')
  assert(result.sampleSize === 2, 'dry-run should report sample size')
  assert(result.matched >= 1, 'dry-run should count matches')
}
