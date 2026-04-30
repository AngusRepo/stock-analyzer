import {
  applyScreenerScoreCalibration,
  resolveScreenerPolicy,
  type ScreenerScoreCandidate,
} from './screenerPolicy'
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
    momentum_score: 4,
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
  assert(candidates.every(c => c.chip_score <= 36 && c.tech_score <= 30), 'calibration must not inflate raw factor scores')
}
