import { buildScoreBreakdownViewModel, buildScoreV2PayloadFromProjectedScores } from './scoreV2ViewModel.ts'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const vm = buildScoreBreakdownViewModel({
    score: 67,
    alpha_context: { score_adjustment: 2 },
    score_components: JSON.stringify({
      version: 'score_v2',
      total: 65,
      weights: {
        mlEdge: 25,
        chipFlow: 25,
        technicalStructure: 25,
        fundamentalQuality: 25,
        newsTheme: 0,
      },
      components: {
        mlEdge: 20,
        chipFlow: 18,
        technicalStructure: 17,
        fundamentalQuality: 8,
        newsTheme: 2,
      },
      technicalBreakdown: {
        trendStructure: 5,
        volatilityStructure: 3,
        volumeConfirmation: 4,
      },
      riskFlags: ['LOW_LIQUIDITY'],
    }),
  })
  assert(vm.source === 'score_v2', 'Score V2 payload should be detected')
  assert(vm.rows.length === 4, 'Score V2 should expose four additive score dimensions')
  assert(vm.rows.some((row) => row.key === 'fundamentalQuality' && row.max === 25), 'fundamental row should use 25-point max')
  assert(!vm.rows.some((row) => row.key === 'newsTheme'), 'news/theme should not render as an additive score row')
  assert(vm.rows.some((row) => row.key === 'mlEdge' && row.max === 25), 'ML row should use 25-point Score V2 max')
  assert(vm.rows.some((row) => row.key === 'chipFlow' && row.label === '籌碼流'), 'chip row should use readable Score V2 label')
  assert(vm.rows.some((row) => row.key === 'technicalStructure' && row.label === '技術結構'), 'technical row should use readable Score V2 label')
  assert(vm.rows.some((row) => row.key === 'fundamentalQuality' && row.label === '基本面品質'), 'fundamental row should use readable Score V2 label')
  assert(vm.technicalRows.some((row) => row.key === 'volatilityStructure' && row.max === 5), 'technical breakdown should use Score V2 volatility max')
  assert(vm.technicalRows.some((row) => row.key === 'trendStructure' && row.label === '趨勢結構'), 'technical detail should use readable trend label')
  assert(vm.technicalRows.some((row) => row.key === 'volumeConfirmation' && row.value === 4), 'technical breakdown should include volume confirmation')
  assert(vm.baseScore === 65 && vm.finalScore === 67 && vm.residual === 0, 'formula should account for alpha adjustment')
  assert(vm.riskFlags[0] === 'LOW_LIQUIDITY', 'risk flags should be preserved')
}

{
  const vm = buildScoreBreakdownViewModel({
    score_components: {
      version: 'score_v2',
      scoreScale: 'normalized_0_1',
      total: 0.64,
      finalScore: 0.67,
      alphaAdjustment: 0.03,
      weights: {
        mlEdge: 25,
        chipFlow: 25,
        technicalStructure: 25,
        fundamentalQuality: 25,
        newsTheme: 0,
      },
      components: {
        mlEdge: 0.8,
        chipFlow: 0.2,
        technicalStructure: 0.6,
        fundamentalQuality: 0.5,
        newsTheme: 0,
      },
      technicalBreakdown: {
        trendStructure: 0.7,
        volatilityStructure: 0.4,
        volumeConfirmation: 0.5,
      },
    },
  })
  assert(vm.source === 'score_v2', 'normalized Score V2 payload should be detected')
  assert(vm.rows.some((row) => row.key === 'mlEdge' && row.value === 20 && row.max === 25), 'normalized ML component should scale to weighted Score V2 points')
  assert(vm.rows.some((row) => row.key === 'chipFlow' && row.value === 5 && row.max === 25), 'normalized chip component should scale to weighted Score V2 points')
  assert(vm.rows.some((row) => row.key === 'fundamentalQuality' && row.value === 12.5 && row.max === 25), 'normalized fundamental component should scale to weighted Score V2 points')
  assert(vm.technicalRows.some((row) => row.key === 'trendStructure' && row.value === 4.9 && row.max === 7), 'normalized technical breakdown should scale to its own max')
  assert(vm.baseScore === 64 && vm.finalScore === 67 && vm.alphaAdjustment === 3, 'normalized total/final/alpha should scale to 100-point backend semantics')
}

{
  const vm = buildScoreBreakdownViewModel({
    score: 66,
    chip_score: 30,
    tech_score: 20,
    ml_score: 15,
  })
  assert(vm.source === 'storage_projection', 'old columns should only be exposed as Score V2 storage projection')
  assert(vm.rows.length === 4, 'storage projection should expose four additive Score V2 dimensions')
  assert(vm.rows.some((row) => row.key === 'chipFlow' && row.max === 25 && row.value === 18.8), 'chip storage projection should rescale to 25-point V2')
  assert(vm.rows.some((row) => row.key === 'technicalStructure' && row.max === 25 && row.value === 10), 'technical storage projection should rescale to 25-point V2')
  assert(vm.rows.some((row) => row.key === 'mlEdge' && row.max === 25 && row.value === 12.5), 'ML storage projection should rescale to 25-point V2')
  assert(vm.baseScore === 41.3 && vm.finalScore === 41.3 && vm.residual === 0, 'storage projection should not reuse legacy total score')
}

{
  const vm = buildScoreBreakdownViewModel({
    score: 0.52,
    chip_score: 0.75,
    tech_score: 0.4,
    ml_score: 0.6,
  })
  assert(vm.source === 'storage_projection', 'normalized storage columns should still be treated as storage projection')
  assert(vm.rows.some((row) => row.key === 'chipFlow' && row.value === 18.8), 'normalized chip storage score should scale directly to 25-point V2')
  assert(vm.rows.some((row) => row.key === 'technicalStructure' && row.value === 10), 'normalized technical storage score should scale directly to 25-point V2')
  assert(vm.rows.some((row) => row.key === 'mlEdge' && row.value === 15), 'normalized ML storage score should scale directly to 25-point V2')
  assert(vm.finalScore === 43.8, 'normalized storage projection should sum scaled V2 rows')
}

{
  const vm = buildScoreBreakdownViewModel({
    score_components: {
      chip: 24,
      tech: 22,
      screenerMomentum: 6,
      ml: 21,
      rawScore: 73,
      finalScore: 70,
      alphaAdjustment: -3,
      alphaReason: { riskFlags: ['OVERHEATED'] },
    },
  })
  assert(vm.source === 'storage_projection', 'old backend score_components should be projected into Score V2')
  assert(vm.rows.length === 4, 'old backend score_components should still render through four additive V2 dimensions')
  assert(vm.rows.some((row) => row.key === 'technicalStructure' && row.max === 25 && row.value === 14), 'legacy tech plus momentum should project into V2 technical structure')
  assert(vm.baseScore === 46.5 && vm.finalScore === 43.5 && vm.alphaAdjustment === -3, 'storage projection should recompute the V2 formula')
  assert(vm.riskFlags[0] === 'OVERHEATED', 'legacy risk flags should be preserved')
}

{
  const payload = buildScoreV2PayloadFromProjectedScores({
    score: 50,
    chip_score: 20,
    tech_score: 18,
    ml_score: 12,
  })
  const vm = buildScoreBreakdownViewModel({ score_components: payload })
  assert(vm.source === 'score_v2', 'projected pending-buy scores should re-enter UI as canonical Score V2')
  assert(vm.rows.some((row) => row.key === 'chipFlow' && row.value === 20 && row.max === 25), 'projected chipFlow should not be rescaled twice')
  assert(vm.rows.some((row) => row.key === 'technicalStructure' && row.value === 18 && row.max === 25), 'projected technicalStructure should not be rescaled twice')
  assert(vm.rows.some((row) => row.key === 'mlEdge' && row.value === 12 && row.max === 25), 'projected mlEdge should not be rescaled twice')
  assert(vm.baseScore === 50, 'projected total should remain canonical Score V2 total')
}
