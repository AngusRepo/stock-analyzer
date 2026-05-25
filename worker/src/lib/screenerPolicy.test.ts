import {
  applyScreenerScoreCalibration,
  resolveScreenerPolicy,
  type ScreenerScoreCandidate,
} from './screenerPolicy'
import { buildPartialScreenerScoreV2 } from './scoreV2Taxonomy'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const policy = resolveScreenerPolicy(
    {
      ...DEFAULT_TRADING_CONFIG,
      screener: {
        ...DEFAULT_TRADING_CONFIG.screener,
        candidatePoolSize: 120,
        mlShortlistSize: 40,
        emergingResearchSize: 24,
      } as typeof DEFAULT_TRADING_CONFIG.screener,
    },
    {
      ...({} as any),
      screener: {
        candidate_pool_delta: -20,
        ml_shortlist_delta: 5,
        emerging_research_delta: 6,
      },
    },
  )

  assert(policy.sizing.candidatePoolSize === 100, 'candidate pool size should accept adaptive delta')
  assert(policy.sizing.mlShortlistSize === 45, 'ML shortlist size should accept adaptive delta')
  assert(policy.sizing.emergingResearchSize === 30, 'emerging research size should accept adaptive delta')
}

{
  const candidates: ScreenerScoreCandidate[] = Array.from({ length: 40 }, (_, i) => ({
    score: 70,
    chip_score: 36,
    tech_score: i < 20 ? 30 : 26,
    momentum_score: i < 20 ? 18 : 14,
    score_components: JSON.stringify(buildPartialScreenerScoreV2({
      chipScore40: 36,
      techScore30: i < 20 ? 30 : 26,
      momentumScore20: i < 20 ? 18 : 14,
    })),
    reason: 'test',
  }))

  applyScreenerScoreCalibration(candidates, {
    enabled: true,
    method: 'percentile_zscore',
    minCrossSectionSize: 30,
    percentileWeight: 0.65,
    zScoreWeight: 0.35,
  })

  assert(candidates.some(c => c.chip_score < 36), 'calibration should reduce crowded chip scores')
  assert(candidates.some(c => c.tech_score < 30), 'calibration should reduce crowded technical scores')
  assert(candidates.some(c => (c.momentum_score ?? 0) < 18), 'calibration should reduce crowded momentum scores')
  assert(candidates.every(c => c.chip_score <= 36 && c.tech_score <= 30 && (c.momentum_score ?? 0) <= 18), 'calibration must not inflate raw factor scores')
  for (const candidate of candidates) {
    const synced = JSON.parse(candidate.score_components ?? '{}')
    const expected = buildPartialScreenerScoreV2({
      chipScore40: candidate.chip_score,
      techScore30: candidate.tech_score,
      momentumScore20: candidate.momentum_score ?? 0,
      reasons: candidate.reason ? [candidate.reason] : [],
    })
    assert(synced.version === 'score_v2', 'calibration should preserve canonical Score V2 payload')
    assert(synced.total === expected.total, 'calibration must keep score_components synced with calibrated screener seeds')
    assert(synced.components.chipFlow === expected.components.chipFlow, 'calibration must sync chipFlow into Score V2 payload')
    assert(synced.components.technicalStructure === expected.components.technicalStructure, 'calibration must sync technicalStructure into Score V2 payload')
    assert(candidate.score === expected.total, 'calibration must keep candidate.score on Score V2 total')
  }
}

{
  const candidates: ScreenerScoreCandidate[] = [
    ...Array.from({ length: 35 }, (_, i) => ({
      score: 80,
      chip_score: 38,
      tech_score: i < 20 ? 29 : 27,
      momentum_score: 18,
      market_segment: 'listed_otc',
      reason: 'listed',
    })),
    ...Array.from({ length: 4 }, () => ({
      score: 40,
      chip_score: 2,
      tech_score: 6,
      momentum_score: 5,
      market_segment: 'emerging',
      reason: 'emerging',
    })),
  ]

  applyScreenerScoreCalibration(candidates, {
    enabled: true,
    method: 'percentile_zscore',
    minCrossSectionSize: 30,
    percentileWeight: 0.65,
    zScoreWeight: 0.35,
  })

  const emerging = candidates.filter(c => c.market_segment === 'emerging')
  assert(
    emerging.every(c => c.chip_score === 2 && c.tech_score === 6 && c.momentum_score === 5 && c.score === 40),
    'small emerging pools must not borrow listed/OTC distributions for calibration',
  )
}
