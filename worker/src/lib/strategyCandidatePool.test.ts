import { DEFAULT_STRATEGY_SPECS, STRATEGY_SPEC_VERSION } from './strategySpec'
import {
  DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY,
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
    current_price: 30 + index,
    market_segment: 'LISTED',
    eligible_for_ml: 1,
  }
})

{
  const pools = buildStrategyCandidatePools(candidates, DEFAULT_STRATEGY_SPECS, { regime: 'bull' })
  assert(pools.length === DEFAULT_STRATEGY_SPECS.length, 'planner should create one pool per non-retired strategy')
  assert(pools.some((pool) => pool.candidates.length > 0), 'at least one strategy should propose candidates before global merge')
  assert(pools.every((pool) => pool.quota >= 8 && pool.quota <= 20), 'strategy pool quota should be bounded to 8-20')
}

{
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
  const pools = buildStrategyCandidatePools([scoreV2Only], [DEFAULT_STRATEGY_SPECS[0]], { regime: 'bull' })
  assert(pools[0].candidates.length === 1, 'candidate pool should rank by canonical Score V2 when legacy fields are stale')
  assert(pools[0].candidates[0].raw_score === 70, 'candidate pool raw score should expose canonical strategy seed score')
}

{
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
  const pools = buildStrategyCandidatePools([scoreV2TotalOnly], [DEFAULT_STRATEGY_SPECS[0]], { regime: 'bull' })
  assert(pools[0].candidates.length === 1, 'candidate pool should use Score V2 total when finalScore is absent')
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
    thresholds: { minSeedScore: 75, minTechScore: 26, minMomentumScore: 10, minPrice: 10 },
    candidatePolicy: { poolQuota: 8, costBudget: 8 },
    riskNotes: ['test only'],
    createdBy: 'p5_strategy_governance' as const,
  }]
  const pools = buildStrategyCandidatePools(candidates.slice(0, 12), nearMatchSpecs, { regime: 'bull' })
  assert(pools[0].status === 'adaptive_near_match', 'empty strict pool should expose adaptive near-match status')
  assert(pools[0].missing_evidence.includes('strict_threshold_match_empty'), 'adaptive near-match should be explicit evidence, not silent fallback')
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 8 }))
  assert(selection.mlQueue.length > 0, 'adaptive near-match candidates should be able to enter shadow ML queue')
  const firstNearMatch = selection.mlQueue[0] as any
  assert(
    String(firstNearMatch.strategy_pool_reason || '').startsWith('adaptive_near_match:'),
    'candidate reason should explain which thresholds were near misses',
  )
}

{
  const restricted = [
    { ...candidates[0], symbol: '9991', restricted: true },
    { ...candidates[1], symbol: '9992', market_segment: 'EMERGING', eligible_for_ml: 0 },
    ...candidates.slice(2, 20),
  ]
  const pools = buildStrategyCandidatePools(restricted, DEFAULT_STRATEGY_SPECS, { regime: 'bull' })
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 10 }))
  const researchSymbols = new Set(selection.researchOnlyQueue.map((candidate) => candidate.symbol))
  assert(researchSymbols.has('9991') || researchSymbols.has('9992'), 'restricted or non-ML segment candidates should route to research-only queue')
}

{
  const finlabShadow = DEFAULT_STRATEGY_SPECS.find((spec) => spec.id === 'finlab_ai_skill_shadow_v1')
  assert(finlabShadow, 'FinLab AI Skill shadow spec should exist')
  const pools = buildStrategyCandidatePools(candidates.slice(0, 20), [finlabShadow!], { regime: 'bull' })
  const selection = mergeStrategyCandidatePools(pools, resolveStrategyCapacityBudget({ requestedTotalCap: 8 }))
  assert(selection.mlQueue.length === 0, 'FinLab AI Skill shadow lane must not enter ML queue')
  assert(selection.researchOnlyQueue.length > 0, 'FinLab AI Skill shadow lane should still preserve research candidates')
  assert(
    selection.researchOnlyQueue.every((candidate) => candidate.strategy_pool_reason === 'strategy_shadow_lane_only'),
    'FinLab AI Skill shadow candidates should explain research-only routing',
  )
}
