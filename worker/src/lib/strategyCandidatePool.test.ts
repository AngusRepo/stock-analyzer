import { DEFAULT_STRATEGY_SPECS, STRATEGY_SPEC_VERSION } from './strategySpec'
import {
  DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY,
  buildLayer1StrategyBreadthPlan,
  buildStrategyCandidatePools,
  mergeStrategyCandidatePools,
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
  momentumProxy: number
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
      volumeConfirmation: Math.min(6, input.momentumProxy),
      executionRisk: 1,
    },
    seedComponents: {
      screenerMomentumSeed20: input.momentumProxy,
    },
  }
  if (input.finalScore != null) payload.finalScore = input.finalScore
  return JSON.stringify(payload)
}

function rawSignalPayload(input: {
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
  const momentumProxy = 12 - (index % 3)
  return {
    symbol: `${2300 + n}`,
    name: `Stock ${n}`,
    industry: index % 3 === 0 ? 'Semiconductor' : index % 3 === 1 ? 'Network' : 'Other',
    score_components: scoreV2Payload({ finalScore, chipFlow, technicalStructure, momentumProxy }),
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
  const lowScoreDiverseCandidate: StrategyCandidatePoolCandidate = {
    symbol: '8999',
    name: 'Low Score Strategy Fit',
    industry: 'Niche',
    score: 1,
    score_components: scoreV2Payload({
      finalScore: 76,
      chipFlow: 25,
      technicalStructure: 24,
      momentumProxy: 12,
    }),
    raw_signals: rawSignalPayload({ closeAboveMa20Pct: 0.06, volumeExpansion20: 1.45, return20d: 0.1 }),
    current_price: 55,
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
      momentumProxy: 2,
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
  assert(plan.breadthPool.some((candidate) => candidate.symbol === '8999'), 'L1 breadth pool should include full-universe strategy fit outside old score-top pool')
  assert(plan.telemetry.selection_order === 'full_feature_enriched_universe_strategy_quota_then_raw_signal_top_up', 'L1 selection order must be strategy quota before raw-signal top-up')
  assert(plan.coarseQueue.length <= 8, 'Layer2 coarse queue should be sliced from the L1 breadth pool')
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
      momentumProxy: 10,
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
    id: 'active_no_proxy_spec_v1',
    version: STRATEGY_SPEC_VERSION,
    name: 'Active no proxy test',
    status: 'active' as const,
    owner: 'strategy' as const,
    alphaBucket: 'trend_following' as const,
    supportedRegimes: ['bull' as const],
    thesis: 'Active production strategies must not emit full-universe proxy candidates when strict and near-match evidence is empty.',
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
