import { DEFAULT_STRATEGY_SPECS } from './strategySpec'
import {
  DEFAULT_STRATEGY_CANDIDATE_POOL_POLICY,
  buildStrategyCandidatePools,
  mergeStrategyCandidatePools,
  planStrategyFirstCandidateSelection,
  resolveStrategyCapacityBudget,
} from './strategyCandidatePool'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const candidates = Array.from({ length: 90 }, (_, index) => {
  const n = index + 1
  return {
    symbol: `${2300 + n}`,
    name: `Stock ${n}`,
    industry: index % 3 === 0 ? 'Semiconductor' : index % 3 === 1 ? 'Network' : 'Other',
    score: 72 - index * 0.15,
    chip_score: index % 4 === 0 ? 24 : 19,
    tech_score: 24 - (index % 5),
    momentum_score: 12 - (index % 3),
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

