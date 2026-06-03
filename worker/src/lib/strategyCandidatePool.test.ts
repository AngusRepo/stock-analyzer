import { DEFAULT_STRATEGY_SPECS, STRATEGY_SPEC_VERSION } from './strategySpec'
import {
  DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY,
  buildLayer1StrategyBreadthPlan,
  buildStrategyCandidatePools,
  mergeStrategyCandidatePools,
  passesLayer1TopUpQualityGuard,
  planStrategyFirstCandidateSelection,
  resolveStrategyCapacityBudget,
  type StrategyCandidatePoolCandidate,
} from './strategyCandidatePool'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function scoreV2Payload(input: {
  finalScore?: number
  chipFlow: number
  technicalStructure: number
  momentumScore: number
  mlEdge?: number
  fundamentalQuality?: number
  newsTheme?: number
}): string {
  const payload: Record<string, unknown> = {
    version: 'score_v2',
    components: {
      mlEdge: input.mlEdge ?? 12,
      chipFlow: input.chipFlow,
      technicalStructure: input.technicalStructure,
      fundamentalQuality: input.fundamentalQuality ?? 10,
      newsTheme: input.newsTheme ?? 2,
    },
    technicalBreakdown: {
      trendStructure: 6,
      volatilityStructure: 4,
      reversalExtreme: 4,
      volumeConfirmation: Math.min(6, input.momentumScore),
      executionRisk: 1,
    },
    seedComponents: {
      screenerMomentumSeed20: input.momentumScore,
    },
  }
  if (input.finalScore != null) payload.finalScore = input.finalScore
  return JSON.stringify(payload)
}

function rawSignalPayload(input: {
  close?: number
  closeAboveMa20Pct?: number
  closeAboveMa60Pct?: number
  volumeExpansion20?: number
  return20d?: number
  foreignTrustNet5d?: number
  brokerNetAmount5d?: number
  brokerCount?: number
  brokerConcentration?: number
  revenueGrowthYoY?: number
  monthlyRevenueYoY?: number
  roe?: number
  eps?: number
  pe?: number
  pb?: number
} = {}) {
  return {
    close: input.close ?? 50,
    closeAboveMa20Pct: input.closeAboveMa20Pct ?? 0.03,
    closeAboveMa60Pct: input.closeAboveMa60Pct ?? 0.01,
    volumeExpansion20: input.volumeExpansion20 ?? 1.25,
    return20d: input.return20d ?? 0.06,
    foreignTrustNet5d: input.foreignTrustNet5d ?? 1200,
    brokerNetAmount5d: input.brokerNetAmount5d ?? 10_000_000,
    brokerCount: input.brokerCount ?? 8,
    brokerConcentration: input.brokerConcentration ?? 0.4,
    revenueGrowthYoY: input.revenueGrowthYoY ?? 8,
    monthlyRevenueYoY: input.monthlyRevenueYoY ?? 10,
    roe: input.roe ?? 12,
    eps: input.eps ?? 1.8,
    pe: input.pe ?? 18,
    pb: input.pb ?? 2,
  }
}

const candidates: StrategyCandidatePoolCandidate[] = Array.from({ length: 90 }, (_, index) => {
  const n = index + 1
  const finalScore = 72 - index * 0.15
  const chipFlow = index % 4 === 0 ? 24 : 19
  const technicalStructure = 24 - (index % 5)
  const momentumScore = 12 - (index % 3)
  return {
    symbol: `${2300 + n}`,
    name: `Stock ${n}`,
    industry: index % 3 === 0 ? 'Semiconductor' : index % 3 === 1 ? 'Network' : 'Other',
    score_components: scoreV2Payload({ finalScore, chipFlow, technicalStructure, momentumScore }),
    raw_signals: rawSignalPayload({
      closeAboveMa20Pct: 0.01 + (index % 5) * 0.01,
      volumeExpansion20: 0.95 + (index % 6) * 0.08,
      return20d: 0.01 + (index % 4) * 0.02,
      foreignTrustNet5d: index % 4 === 0 ? 2200 : 500,
      brokerCount: 4 + (index % 8),
      brokerConcentration: 0.25 + (index % 4) * 0.08,
    }),
    current_price: 30 + index,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
  }
})

{
  const fragileNoSupport: StrategyCandidatePoolCandidate = {
    symbol: '1215',
    name: 'Fragile No Support',
    industry: 'Food',
    score: 5.8,
    chip_score: 0,
    tech_score: 9,
    current_price: 125,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
    raw_signals: {
      close: 125,
      closeAboveMa20Pct: -0.092,
      closeAboveMa60Pct: -0.092,
      volumeExpansion20: 1.56,
      foreignTrustNet5d: -1_574_161,
      brokerNetAmount5d: 0,
      brokerCount: null,
      monthlyRevenueYoY: 7.54,
      roe: 3.38,
      eps: 1.26,
      technicalIndicators: { rsi14: 36.7 },
      factorSignals: { rsi14: 36.7, foreignTrustNet5d: -1_574_161, brokerNetAmount5d: 0, brokerCount: null },
    },
  }
  const constructiveTopUp: StrategyCandidatePoolCandidate = {
    ...fragileNoSupport,
    symbol: '8998',
    name: 'Constructive Top Up',
    chip_score: 12,
    tech_score: 17,
    raw_signals: rawSignalPayload({
      closeAboveMa20Pct: -0.01,
      closeAboveMa60Pct: 0.02,
      volumeExpansion20: 1.25,
      foreignTrustNet5d: 1500,
      brokerNetAmount5d: 8_000_000,
      brokerCount: 5,
      brokerConcentration: 0.4,
    }),
  }

  assert(!passesLayer1TopUpQualityGuard(fragileNoSupport), 'fragile technicals plus unsupported chip flow must not enter L1 through top-up')
  assert(passesLayer1TopUpQualityGuard(constructiveTopUp), 'constructive raw technical/chip evidence should remain eligible for qualified L1 top-up')
}

{
  const lowScoreDiverseCandidate: StrategyCandidatePoolCandidate = {
    symbol: '8999',
    name: 'Low Score Strategy Fit',
    industry: 'Niche',
    score: 1,
    score_components: scoreV2Payload({
      finalScore: 76,
      chipFlow: 25,
      technicalStructure: 24,
      momentumScore: 12,
    }),
    raw_signals: rawSignalPayload({ closeAboveMa20Pct: 0.06, volumeExpansion20: 1.45, return20d: 0.1 }),
    market_segment: 'LISTED',
    eligible_for_ml: 1,
  }
  const scoreCrowd: StrategyCandidatePoolCandidate[] = Array.from({ length: 40 }, (_, index) => ({
    symbol: `${5000 + index}`,
    name: `Score Crowd ${index}`,
    industry: 'Crowded',
    score: 100 - index,
    score_components: scoreV2Payload({
      finalScore: 42,
      chipFlow: 8,
      technicalStructure: 8,
      momentumScore: 2,
    }),
    raw_signals: rawSignalPayload({ closeAboveMa20Pct: -0.08, volumeExpansion20: 0.6, return20d: -0.1 }),
    current_price: 40,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
  }))
  const nicheSpec = {
    id: 'niche_strategy_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Niche strategy',
    status: 'active' as const,
    owner: 'strategy' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Niche strategy should source L1 breadth directly from full feature-enriched universe.',
    thresholds: { minCloseAboveMa20Pct: 0.03, minVolumeExpansion20: 1.2, minReturn20d: 0.03, includeIndustries: ['Niche'], minPrice: 10 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const oldTopScoreSymbols = new Set(
    [...scoreCrowd, lowScoreDiverseCandidate]
      .sort((a, b) => Number((b as any).score ?? 0) - Number((a as any).score ?? 0))
      .slice(0, 20)
      .map((candidate) => candidate.symbol),
  )

  const plan = buildLayer1StrategyBreadthPlan(
    [...scoreCrowd, lowScoreDiverseCandidate],
    [nicheSpec],
    {
      targetSize: 20,
      coarseMlQueueSize: 8,
      regime: 'bull',
    },
  )

  assert(!oldTopScoreSymbols.has('8999'), 'test fixture must keep niche candidate outside old score-top pool')
  assert(plan.breadthPool.some((candidate) => candidate.symbol === '8999'), 'L1 breadth pool should include raw-signal priced strategy fit outside old score-top pool')
  assert(plan.telemetry.selection_order === 'full_feature_enriched_universe_strategy_only_with_raw_signal_observe', 'L1 selection order must keep raw-signal top-up in observe-only evidence')
  assert(plan.coarseQueue.length <= 8, 'Layer2 coarse queue should be sliced from formal strategy hits only')
  assert(plan.coarseQueue.every((candidate: any) => candidate.strategy_pool_fallback_source !== 'raw_signal_top_up'), 'raw-signal top-up must not enter formal L2 coarse queue')
}

{
  const pools = buildStrategyCandidatePools(candidates, DEFAULT_STRATEGY_SPECS, { regime: 'bull' })
  assert(pools.length === DEFAULT_STRATEGY_SPECS.length, 'planner should create one pool per non-retired strategy')
  assert(pools.some((pool) => pool.candidates.length > 0), 'at least one strategy should propose candidates before global merge')
  assert(pools.every((pool) => pool.quota >= 8 && pool.quota <= 20), 'strategy pool quota should be bounded to 8-20')
}

{
  const legacyScoreV2Spec = {
    ...DEFAULT_STRATEGY_SPECS[0],
    id: 'legacy_score_v2_compat_test_v1',
    thresholds: { minSeedScore: 58, minTechScore: 18, minMomentumScore: 6, minPrice: 10 },
  }
  const scoreV2Only = {
    symbol: '2330',
    name: 'Score V2 Seed',
    industry: 'Semiconductor',
    score: 8,
    chip_score: 1,
    tech_score: 1,
    momentum_score: 1,
    current_price: 900,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
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
      seedComponents: {
        screenerMomentumSeed20: 10,
      },
    }),
  }
  const pools = buildStrategyCandidatePools([scoreV2Only], [legacyScoreV2Spec], { regime: 'bull' })
  assert(pools[0].candidates.length === 1, 'candidate pool should rank by canonical Score V2 for legacy registry specs only')
  assert(pools[0].candidates[0].raw_score === 70, 'candidate pool raw score should expose canonical strategy seed score')
}

{
  const legacyScoreV2Spec = {
    ...DEFAULT_STRATEGY_SPECS[0],
    id: 'legacy_score_v2_total_compat_test_v1',
    thresholds: { minSeedScore: 58, minTechScore: 18, minMomentumScore: 6, minPrice: 10 },
  }
  const scoreV2TotalOnly = {
    symbol: '2454',
    name: 'Score V2 Total Seed',
    industry: 'Semiconductor',
    score: 8,
    chip_score: 1,
    tech_score: 1,
    momentum_score: 1,
    current_price: 900,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
    score_components: scoreV2Payload({
      chipFlow: 24,
      technicalStructure: 22,
      momentumScore: 10,
      mlEdge: 14,
      fundamentalQuality: 8,
      newsTheme: 2,
    }),
  }
  const pools = buildStrategyCandidatePools([scoreV2TotalOnly], [legacyScoreV2Spec], { regime: 'bull' })
  assert(pools[0].candidates.length === 1, 'legacy registry specs can still use Score V2 total when finalScore is absent')
  assert(pools[0].candidates[0].raw_score === 70, 'candidate pool must not use stale scalar score when Score V2 total is canonical')
}

{
  const capacity = resolveStrategyCapacityBudget()
  assert(capacity.mode === 'base', 'default strategy budget should stay base')
  assert(capacity.totalCap === 64, 'base total budget should remain 64')
  const expanded = resolveStrategyCapacityBudget({ requestedMode: 'normal', observedPipelineMinutes: 9 })
  assert(expanded.mode === 'normal' && expanded.totalCap === 96, 'normal cap should require runtime telemetry')
  const blocked = resolveStrategyCapacityBudget({ requestedMode: 'low_load', observedPipelineMinutes: 12 })
  assert(blocked.mode === 'base' && blocked.totalCap === 64, 'low-load cap should not activate without good telemetry')
}

{
  const selection = planStrategyFirstCandidateSelection(candidates, DEFAULT_STRATEGY_SPECS, {
    regime: 'bull',
    mlQueueCapOverride: 24,
  })
  assert(selection.mlQueue.length <= 24, 'ML queue should obey caller cap')
  assert(selection.telemetry.deduped_symbols >= selection.mlQueue.length, 'merge should dedupe symbols before queueing')
  assert(selection.telemetry.estimated_batch_chunks === Math.ceil(selection.mlQueue.length / 40), 'batch chunk telemetry should match ML queue size')
  const maxPerStrategy = Math.floor(24 * DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY.maxOneStrategyShare)
  for (const count of Object.values(selection.telemetry.strategy_usage)) {
    assert(count <= maxPerStrategy, 'single strategy should not dominate the ML queue')
  }
}

{
  const nearMatchSpecs = [{
    id: 'near_match_spec_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Near match test',
    status: 'shadow' as const,
    owner: 'strategy' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Exercise adaptive near-match pool when strict thresholds are empty.',
    thresholds: { minCloseAboveMa20Pct: 0.025, minVolumeExpansion20: 1.38, minReturn20d: 0.03, minPrice: 10 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }]
  const pools = buildStrategyCandidatePools(candidates.slice(0, 12), nearMatchSpecs, { regime: 'bull' })
  assert(pools[0].status === 'adaptive_near_match', 'empty strict pool should expose adaptive near-match status')
  assert(pools[0].missing_evidence.includes('strict_threshold_match_empty'), 'adaptive near-match should be explicit evidence, not silent fallback')
  assert(
    pools[0].candidates[0]?.reason.startsWith('adaptive_near_match:'),
    'pool candidate reason should explain which thresholds were near misses',
  )
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 8 }))
  assert(selection.mlQueue.length > 0, 'adaptive near-match candidates should be able to enter shadow ML queue')
  const firstNearMatch = selection.mlQueue[0] as any
  assert(
    String(firstNearMatch.strategy_pool_reason || '').length > 0,
    'merged candidate should preserve a strategy pool reason',
  )
}

{
  const activeNoMatchSpec = {
    id: 'active_no_full_universe_spec_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Active no full-universe fill test',
    status: 'active' as const,
    owner: 'strategy' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Active production strategies must not emit full-universe fill candidates when strict and near-match evidence is empty.',
    thresholds: { minCloseAboveMa20Pct: 0.4, minVolumeExpansion20: 3, minReturn20d: 0.5, minPrice: 10 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const pools = buildStrategyCandidatePools(candidates.slice(0, 12), [activeNoMatchSpec], { regime: 'bull' })
  assert(pools[0].candidates.length === 0, 'active production strategies should not produce adaptive empty-pool garbage')
}

{
  const restricted = [
    { ...candidates[0], symbol: '9991', restricted: true, raw_signals: rawSignalPayload({ closeAboveMa20Pct: 0.08, volumeExpansion20: 1.5, return20d: 0.12 }) },
    { ...candidates[1], symbol: '9992', market_segment: 'EMERGING', eligible_for_ml: 0, raw_signals: rawSignalPayload({ closeAboveMa20Pct: 0.07, volumeExpansion20: 1.45, return20d: 0.1 }) },
    ...candidates.slice(2, 20),
  ]
  const pools = buildStrategyCandidatePools(restricted, DEFAULT_STRATEGY_SPECS, { regime: 'bull' })
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 10 }))
  const researchSymbols = new Set(selection.researchOnlyQueue.map((candidate) => candidate.symbol))
  assert(researchSymbols.has('9991') || researchSymbols.has('9992'), 'restricted or non-ML segment candidates should route to research-only queue')
}

{
  const finlabDiscovery = DEFAULT_STRATEGY_SPECS.find((spec) => spec.id === 'finlab_ai_skill_discovery_v1')
  assert(finlabDiscovery, 'FinLab AI Skill discovery spec should exist')
  const pools = buildStrategyCandidatePools(candidates.slice(0, 20), [finlabDiscovery!], { regime: 'bull' })
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 8 }))
  assert(selection.mlQueue.length === 0, 'FinLab AI Skill discovery lane must not enter ML queue directly')
  assert(selection.researchOnlyQueue.length > 0, 'FinLab AI Skill discovery lane should preserve research candidates')
  assert(
    selection.researchOnlyQueue.every((candidate) => candidate.strategy_pool_reason === 'strategy_research_discovery_lane_only'),
    'FinLab AI Skill candidates should explain research-discovery routing',
  )
}

{
  const sharedCandidate = {
    ...candidates[0],
    symbol: '9988',
    raw_signals: rawSignalPayload({
      close: 52,
      closeAboveMa20Pct: 0.05,
      closeAboveMa60Pct: 0.03,
      volumeExpansion20: 1.4,
      return20d: 0.06,
    }),
  }
  const activeSpec = {
    id: 'active_shared_signal_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Active shared signal',
    status: 'active' as const,
    owner: 'strategy' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Active strategy owns the production ML queue evidence.',
    thresholds: { minPrice: 10, minCloseAboveMa20Pct: 0, minVolumeExpansion20: 1.1 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const researchSpec = {
    ...activeSpec,
    id: 'research_shared_signal_v1',
    name: 'Research shared signal',
    status: 'research' as const,
    thesis: 'Research matches must not be reported as production ML queue strategy ids.',
    candidatePolicy: { poolQuota: 8, costBudget: 8, maxMlShare: 0 },
  }
  const pools = buildStrategyCandidatePools([sharedCandidate], [researchSpec, activeSpec], { regime: 'bull' })
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 4 }))
  const selected = selection.mlQueue.find((candidate) => candidate.symbol === '9988')
  assert(selected, 'shared active/research match should enter ML queue through the active strategy')
  assert(selected?.strategy_pool_ids?.includes('active_shared_signal_v1'), 'ML queue evidence should retain the active strategy id')
  assert(!selected?.strategy_pool_ids?.includes('research_shared_signal_v1'), 'ML queue evidence must not leak research strategy ids')
}

{
  const sharedCandidate = {
    ...candidates[0],
    symbol: '9977',
    raw_signals: rawSignalPayload({
      close: 52,
      closeAboveMa20Pct: 0.05,
      closeAboveMa60Pct: 0.03,
      volumeExpansion20: 1.4,
      return20d: 0.06,
      brokerCount: 8,
    }),
  }
  const trendA = {
    id: 'active_trend_a_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Active trend A',
    status: 'active' as const,
    owner: 'strategy' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Trend family A.',
    thresholds: { minPrice: 10, minCloseAboveMa20Pct: 0, minVolumeExpansion20: 1.1 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }
  const trendB = {
    ...trendA,
    id: 'active_trend_b_v1',
    name: 'Active trend B',
    thesis: 'Trend family B duplicate.',
  }
  const meanReversion = {
    ...trendA,
    id: 'active_mean_reversion_v1',
    name: 'Active mean reversion',
    alphaBucket: 'mean_reversion' as const,
    thesis: 'Different family can remain as a second active representative.',
  }
  const researchDuplicate = {
    ...trendA,
    id: 'research_trend_duplicate_v1',
    name: 'Research trend duplicate',
    status: 'research' as const,
    thesis: 'Research duplicate must stay attribution-only.',
    candidatePolicy: { poolQuota: 8, costBudget: 8, maxMlShare: 0 },
  }
  const pools = buildStrategyCandidatePools([sharedCandidate], [trendA, trendB, meanReversion, researchDuplicate], { regime: 'bull' })
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 4 }))
  const selected = selection.mlQueue.find((candidate) => candidate.symbol === '9977') as any
  assert(selected, 'shared duplicate active families should still produce one ML queue candidate')
  const ids = selected.strategy_pool_ids ?? []
  assert(ids.length === 2, 'ML queue evidence should keep only one active representative per alpha bucket')
  assert(ids.filter((id: string) => id.startsWith('active_trend_')).length === 1, 'duplicate active trend strategies must converge to one representative')
  assert(ids.includes('active_mean_reversion_v1'), 'different alpha bucket can remain as a separate representative')
  assert(!ids.includes('research_trend_duplicate_v1'), 'research duplicate must not leak into production strategy ids')
  assert((selected.research_strategy_ids ?? []).includes('research_trend_duplicate_v1'), 'research duplicate should remain visible as attribution')
}

{
  const plan = buildLayer1StrategyBreadthPlan(candidates.slice(0, 12), [], {
    targetSize: 4,
    coarseMlQueueSize: 2,
    regime: 'bull',
  })
  const topUp = plan.breadthPool.find((candidate: any) => candidate.strategy_pool_reason === 'raw_signal_top_up_observe_after_strategy_quota') as any
  assert(topUp, 'empty strategy pools should still expose raw signals as Layer1 observe evidence')
  assert((topUp.strategy_pool_ids ?? []).length === 0, 'raw signal top-up must not masquerade as a registered production strategy id')
  assert(topUp.strategy_pool_fallback_source === 'raw_signal_top_up', 'raw signal top-up source should be explicit outside strategy ids')
  assert(topUp.strategy_pool_decision === 'research_only_queue', 'raw signal top-up must not enter formal production ML queue')
  assert(plan.coarseQueue.length === 0, 'empty strategy pools must not fill formal L2 queue with raw-signal observe candidates')
}
