import {
  SCORE_V2_VERSION,
  SCORE_V2_WEIGHTS,
  buildPartialScreenerScoreV2,
  buildScoreV2Components,
  projectScoreV2ToLegacy,
  readScoreV2Snapshot,
  scoreV2ComponentPercentages,
} from './scoreV2Taxonomy'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  assert(SCORE_V2_VERSION === 'score_v2', 'Score V2 version should be explicit')
  assert(SCORE_V2_WEIGHTS.mlEdge === 25, 'ML edge should be 25 points')
  assert(SCORE_V2_WEIGHTS.chipFlow === 25, 'chip flow should be 25 points')
  assert(SCORE_V2_WEIGHTS.technicalStructure === 25, 'technical structure should be 25 points')
  assert(SCORE_V2_WEIGHTS.fundamentalQuality === 20, 'fundamental quality should be 20 points')
  assert(SCORE_V2_WEIGHTS.newsTheme === 5, 'news/theme should be 5 points')
  const total = Object.values(SCORE_V2_WEIGHTS).reduce((sum, value) => sum + value, 0)
  assert(total === 100, 'Score V2 weights should sum to 100')
}

{
  const score = buildScoreV2Components({
    mlEdge: 40,
    chipFlow: 24,
    technicalStructure: 22.4,
    fundamentalQuality: 18.2,
    newsTheme: 8,
    technicalBreakdown: {
      trendStructure: 7,
      volatilityStructure: 9,
      reversalExtreme: 5,
      volumeConfirmation: 6,
      executionRisk: 4,
    },
    riskFlags: ['major_negative_news'],
  })

  assert(score.version === SCORE_V2_VERSION, 'score component payload should expose version')
  assert(score.components.mlEdge === 25, 'ML edge should clamp to 25')
  assert(score.components.newsTheme === 5, 'news/theme should clamp to 5')
  assert(score.total === 94.6, 'total should sum clamped V2 components')
  assert(score.technicalBreakdown?.volumeConfirmation === 6, 'technical breakdown should preserve volume confirmation')
  assert(score.technicalBreakdown?.volatilityStructure === 5, 'volatility structure should clamp to 5-point bucket')
  assert(score.technicalBreakdown?.executionRisk === 2, 'execution risk should clamp to 2-point bucket')
  assert(score.riskFlags.includes('major_negative_news'), 'risk flags should be carried outside additive news score')

  const legacy = projectScoreV2ToLegacy(score)
  assert(legacy.score === 94.6, 'legacy score projection should use V2 total')
  assert(legacy.ml_score === 25, 'legacy ml_score should project from mlEdge')
  assert(legacy.chip_score === 24, 'legacy chip_score should project from chipFlow')
  assert(legacy.tech_score === 22.4, 'legacy tech_score should project from technicalStructure')
  assert(legacy.momentum_score === 6, 'legacy momentum_score should be compatibility-only volume confirmation')
  assert(JSON.parse(legacy.score_components).version === SCORE_V2_VERSION, 'legacy score_components should serialize Score V2 payload')
}

{
  const screener = buildPartialScreenerScoreV2({
    chipScore40: 40,
    techScore30: 30,
    momentumScore20: 20,
    reasons: ['legacy screener inputs'],
  })
  const legacy = projectScoreV2ToLegacy(screener)

  assert(screener.components.chipFlow === 25, 'legacy 40-point chip score should rescale to 25-point chip flow')
  assert(screener.components.technicalStructure === 25, 'legacy technical plus momentum should rescale to 25-point technical structure')
  assert(screener.total === 50, 'partial screener score should not invent ML/fundamental/news points')
  assert(screener.technicalBreakdown?.volumeConfirmation === 6, 'legacy 20-point momentum should project to technical volume confirmation')
  assert(legacy.score === 50, 'legacy score projection should follow partial Score V2 total')
}

{
  const canonical = buildScoreV2Components({
    mlEdge: 20,
    chipFlow: 16,
    technicalStructure: 12,
    fundamentalQuality: 8,
    newsTheme: 3,
  })
  const snapshot = readScoreV2Snapshot({
    score_components: JSON.stringify(canonical),
    chip_score: 40,
    tech_score: 30,
    momentum_score: 20,
    ml_score: 30,
    score: 100,
  })

  assert(snapshot.source === 'score_v2', 'downstream readers should prefer canonical Score V2 payload')
  assert(snapshot.components.mlEdge === 20, 'Score V2 mlEdge should not be overwritten by legacy ml_score')
  assert(snapshot.components.chipFlow === 16, 'Score V2 chipFlow should not be overwritten by legacy chip_score')
  assert(snapshot.components.technicalStructure === 12, 'Score V2 technicalStructure should not be overwritten by legacy tech_score')
  assert(snapshot.total === 59, 'Score V2 total should come from canonical components')
  assert(snapshot.finalScore === 59, 'Score V2 finalScore should default to canonical total when no alpha adjustment exists')

  const pct = scoreV2ComponentPercentages(snapshot)
  assert(pct.mlPct === 0.34, 'ML percent should be derived from Score V2 total')
  assert(pct.chipPct === 0.27, 'chip percent should be derived from Score V2 total')
  assert(pct.technicalPct === 0.2, 'technical percent should be derived from Score V2 total')
}

{
  const canonical = {
    ...buildScoreV2Components({
      mlEdge: 20,
      chipFlow: 16,
      technicalStructure: 12,
      fundamentalQuality: 8,
      newsTheme: 3,
    }),
    alphaAdjustment: 2.5,
    finalScore: 61.5,
  }
  const snapshot = readScoreV2Snapshot({
    score_components: JSON.stringify(canonical),
    score: 10,
  })
  const legacy = projectScoreV2ToLegacy(snapshot.payload)

  assert(snapshot.source === 'score_v2', 'final score reader should prefer canonical Score V2 payload')
  assert(snapshot.total === 59, 'base total should remain the additive component sum')
  assert(snapshot.finalScore === 61.5, 'final score should preserve canonical alpha-adjusted score')
  assert(snapshot.alphaAdjustment === 2.5, 'alpha adjustment should be exposed to downstream readers')
  assert(legacy.score === 61.5, 'legacy projection should use canonical finalScore when present')
}

{
  const snapshot = readScoreV2Snapshot({
    score_components: null,
    chip_score: 40,
    tech_score: 30,
    momentum_score: 20,
    ml_score: 30,
    score: 100,
  })

  assert(snapshot.source === 'storage_projection', 'missing Score V2 payload should fall back to storage projection only')
  assert(snapshot.components.mlEdge === 25, 'legacy 30-point ML storage projection should rescale to 25')
  assert(snapshot.components.chipFlow === 25, 'legacy 40-point chip storage projection should rescale to 25')
  assert(snapshot.components.technicalStructure === 25, 'legacy tech plus momentum storage projection should rescale to 25')
  assert(snapshot.total === 75, 'storage projection should not invent fundamental/news points')
  assert(snapshot.finalScore === 100, 'storage projection should preserve scalar score only as missing-payload final score')
}
