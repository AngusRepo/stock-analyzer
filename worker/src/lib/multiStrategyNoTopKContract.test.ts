import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync(new URL('./multiStrategyPleRouter.ts', import.meta.url), 'utf8')

assert(!source.includes('selectAdaptiveMarginalSlate'), 'L1.5 must not retain a Top-K/greedy slate selector')
assert(!source.includes('marginalUtilityForSlateCandidate'), 'L1.5 must not retain path-dependent marginal candidate admission')
assert(source.includes('continuous_weight_full_active_strategy_universe'), 'L1.5 must preserve the full active strategy universe')
assert(source.includes('context_rank_neutralized: 1'), 'pre-ML L1 context must not own cross-sectional expected-return rank')
assert(source.includes('const prioritized = [...routed]'), 'all routed candidates must remain available for allocator/OPB')

console.log('multi-strategy no-Top-K contract passed')
