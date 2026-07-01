import {
  SCORE_V2_VERSION,
  SCORE_V2_WEIGHTS,
  buildPartialScreenerScoreV2,
  buildScoreV2Components,
  readScoreV2Snapshot,
  scoreV2ComponentPercentages,
  serializeScoreV2Snapshot,
} from './scoreV2Taxonomy'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

{
  assert(SCORE_V2_VERSION === 'score_v2', 'Score V2 version should be explicit')
  assert(SCORE_V2_WEIGHTS.mlEdge === 25, 'ML edge should be 25 points')
  assert(SCORE_V2_WEIGHTS.chipFlow === 25, 'chip flow should be 25 points')
  assert(SCORE_V2_WEIGHTS.technicalStructure === 25, 'technical structure should be 25 points')
  assert(SCORE_V2_WEIGHTS.fundamentalQuality === 25, 'fundamental quality should be 25 points')
  assert(SCORE_V2_WEIGHTS.newsTheme === 0, 'news/theme should not add Score V2 points')
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
  assert(score.components.newsTheme === 0, 'news/theme should clamp to 0')
  assert(score.total === 89.6, 'total should sum clamped V2 components')
  assert(score.technicalBreakdown?.volumeConfirmation === 6, 'technical breakdown should preserve volume confirmation')
  assert(score.technicalBreakdown?.volatilityStructure === 5, 'volatility structure should clamp to 5-point bucket')
  assert(score.technicalBreakdown?.executionRisk === 2, 'execution risk should clamp to 2-point bucket')
  assert(score.riskFlags.includes('major_negative_news'), 'risk flags should be carried outside additive news score')

  assert(score.finalScore == null, 'base Score V2 payload should not invent alpha-adjusted finalScore')
}

{
  const screener = buildPartialScreenerScoreV2({
    chipScore40: 40,
    techScore30: 30,
    momentumScore20: 20,
    reasons: ['legacy screener inputs'],
  })
  assert(screener.components.chipFlow === 25, 'screener chip seed should rescale to 25-point chip flow')
  assert(screener.components.technicalStructure === 25, 'screener technical plus volume seed should rescale to 25-point technical structure')
  assert(screener.total === 50, 'partial screener score should not invent ML/fundamental/news points')
  assert(screener.technicalBreakdown?.volumeConfirmation === 6, 'screener volume seed should map to technical volume confirmation')
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
  })

  assert(snapshot.source === 'score_v2', 'downstream readers should prefer canonical Score V2 payload')
  assert(snapshot.components.mlEdge === 20, 'Score V2 mlEdge should come from canonical payload')
  assert(snapshot.components.chipFlow === 16, 'Score V2 chipFlow should come from canonical payload')
  assert(snapshot.components.technicalStructure === 12, 'Score V2 technicalStructure should come from canonical payload')
  assert(snapshot.total === 56, 'Score V2 total should come from canonical components')
  assert(snapshot.finalScore === 56, 'Score V2 finalScore should default to canonical total when no alpha adjustment exists')

  const pct = scoreV2ComponentPercentages(snapshot)
  assert(pct.mlPct === 0.36, 'ML percent should be derived from Score V2 total')
  assert(pct.chipPct === 0.29, 'chip percent should be derived from Score V2 total')
  assert(pct.technicalPct === 0.21, 'technical percent should be derived from Score V2 total')
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
    technicalSignals: { adx14: 28.4, volumeMomentumDivergence132710: 120.5 },
    alphaReason: { bucket: 'breakout_vol_expansion' },
    chipEvidence: { source: 'canonical_chip_daily' },
    reasonVariants: {
      breeze2: {
        source: 'breeze2_generation_shadow',
        decision_effect: 'advisory_only',
        reason: 'Breeze2：量能需確認。',
      },
    },
  }
  const snapshot = readScoreV2Snapshot({
    score_components: JSON.stringify(canonical),
  })
  assert(snapshot.source === 'score_v2', 'final score reader should prefer canonical Score V2 payload')
  assert(snapshot.total === 56, 'base total should remain the additive component sum')
  assert(snapshot.finalScore === 61.5, 'final score should preserve canonical alpha-adjusted score')
  assert(snapshot.alphaAdjustment === 2.5, 'alpha adjustment should be exposed to downstream readers')
  assert(snapshot.payload.technicalSignals?.adx14 === 28.4, 'technical signals should survive Score V2 serialization')
  assert(snapshot.payload.reasonVariants?.breeze2?.reason === 'Breeze2：量能需確認。', 'Breeze2 reason variant should survive Score V2 serialization')
  const summary = serializeScoreV2Snapshot(snapshot)
  assert(summary.technicalSignals?.adx14 === 28.4, 'API Score V2 summary should include technical signals for frontend explanations')
  assert(summary.reasonVariants?.breeze2?.reason === 'Breeze2：量能需確認。', 'API Score V2 summary should include Breeze2 reason variants')
}

{
  const snapshot = readScoreV2Snapshot({
    score_components: null,
  })

  assert(snapshot === null, 'missing Score V2 payload must not be projected')
}
