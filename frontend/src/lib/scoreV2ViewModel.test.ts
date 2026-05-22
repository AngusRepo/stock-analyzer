import { buildScoreBreakdownViewModel } from './scoreV2ViewModel.ts'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const vm = buildScoreBreakdownViewModel({
    score: 67,
    alpha_context: { score_adjustment: 2 },
    score_v2: JSON.stringify({
      version: 'score_v2',
      total: 65,
      weights: {
        mlEdge: 25,
        chipFlow: 25,
        technicalStructure: 25,
        fundamentalQuality: 20,
        newsTheme: 5,
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
        executionRisk: 1,
      },
      technicalSignals: {
        plusDi14: 31.2,
        minusDi14: 16.4,
        adx14: 28.5,
        cci20: 64.3,
        volumeWeightedRsi14: 67.1,
        volumeMomentumDivergence132710: 245.5,
      },
      riskFlags: ['LOW_LIQUIDITY'],
    }),
  })
  assert(vm.source === 'score_v2', 'Score V2 payload should be detected')
  assert(vm.rows.length === 5, 'Score V2 should expose five score dimensions')
  assert(vm.rows.some((row) => row.key === 'fundamentalQuality' && row.max === 20), 'fundamental row should use 20-point max')
  assert(vm.rows.some((row) => row.key === 'newsTheme' && row.max === 5), 'news/theme row should use 5-point max')
  assert(vm.rows.some((row) => row.key === 'mlEdge' && row.max === 25), 'ML row should use 25-point Score V2 max')
  assert(vm.rows.some((row) => row.key === 'chipFlow' && row.label === '籌碼流'), 'chip row should use readable Score V2 label')
  assert(vm.rows.some((row) => row.key === 'technicalStructure' && row.label === '技術結構'), 'technical row should use readable Score V2 label')
  assert(vm.rows.some((row) => row.key === 'fundamentalQuality' && row.label === '基本面'), 'fundamental row should use readable Score V2 label')
  assert(vm.rows.some((row) => row.key === 'newsTheme' && row.label === '新聞題材'), 'news/theme row should use readable Score V2 label')
  assert(vm.technicalRows.some((row) => row.key === 'volatilityStructure' && row.max === 5), 'technical breakdown should use Score V2 volatility max')
  assert(vm.technicalRows.some((row) => row.key === 'trendStructure' && row.label === '趨勢結構'), 'technical detail should use readable trend label')
  assert(vm.technicalRows.some((row) => row.key === 'volumeConfirmation' && row.value === 4), 'technical breakdown should include volume confirmation')
  assert(vm.technicalRows.every((row) => row.explanation && !row.explanation.includes('公式')), 'technical details should carry plain-language explanations')
  assert(vm.technicalRows.some((row) => row.key === 'trendStructure' && row.explanation?.includes('+DI 31.2 高於 -DI 16.4')), 'trend detail should explain the actual directional evidence')
  assert(vm.technicalRows.some((row) => row.key === 'volumeConfirmation' && row.explanation?.includes('量能動能為正')), 'volume detail should explain the actual volume evidence')
  assert(vm.technicalRows.some((row) => row.key === 'executionRisk' && row.explanation?.includes('低流動性')), 'execution detail should mention liquidity risk flags when present')
  assert(vm.baseScore === 65 && vm.finalScore === 67 && vm.residual === 0, 'formula should account for alpha adjustment')
  assert(vm.riskFlags[0] === 'LOW_LIQUIDITY', 'risk flags should be preserved')
}

{
  const vm = buildScoreBreakdownViewModel({
    score_components: JSON.stringify({
      version: 'score_v2',
      total: 65,
      finalScore: 67,
      components: {
        mlEdge: 20,
        chipFlow: 18,
        technicalStructure: 17,
        fundamentalQuality: 8,
        newsTheme: 2,
      },
    }),
  })
  assert(vm.source === 'missing_score_v2', 'frontend must not read Score V2 from legacy score_components')
  assert(vm.finalScore === 0, 'legacy score_components should not create a frontend score even when it contains score_v2')
}

{
  const vm = buildScoreBreakdownViewModel({
    score: 10,
    score_v2: {
      version: 'score_v2',
      source: 'score_v2',
      total: 58,
      finalScore: 61,
      alphaAdjustment: 3,
      components: {
        mlEdge: 21,
        chipFlow: 14,
        technicalStructure: 13,
        fundamentalQuality: 7,
        newsTheme: 3,
      },
    },
  })
  assert(vm.source === 'score_v2', 'Score V2 summary payload should be detected from score_v2')
  assert(vm.finalScore === 61, 'score_v2 summary finalScore should override stale scalar score')
  assert(vm.rows.find(row => row.key === 'chipFlow')?.value === 14, 'score_v2 summary should expose chipFlow component')
}

{
  const vm = buildScoreBreakdownViewModel({
    score: 66,
    chip_score: 30,
    tech_score: 20,
    ml_score: 15,
  })
  assert(vm.source === 'missing_score_v2', 'frontend must not project legacy score fields into Score V2')
  assert(vm.rows.length === 5, 'missing Score V2 payload should still expose the five-dimension shell')
  assert(vm.finalScore === 0, 'missing Score V2 payload should not reuse stale scalar score')
  assert(vm.rows.every((row) => row.value === 0), 'missing Score V2 payload should not synthesize component values')
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
  assert(vm.source === 'missing_score_v2', 'frontend must not project legacy score_components into Score V2')
  assert(vm.finalScore === 0, 'legacy score_components should not create a frontend score')
  assert(vm.riskFlags.length === 0, 'legacy risk flags should not be treated as canonical Score V2 risk flags')
}
