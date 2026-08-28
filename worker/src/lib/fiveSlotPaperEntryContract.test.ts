import * as fs from 'fs'
import * as path from 'path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'paperEntryTasks.ts'), 'utf8')

assert(source.includes('const autoSwapPlan = buildFiveSlotCapitalPlan'), 'auto-swap must be driven by the 5-slot allocator plan')
assert(source.includes('formatFiveSlotDecisionWatchPoint'), 'paper entry must persist structured allocator watch points')
assert(source.includes('const allocatorMarketContext = {'), 'paper entry should build a market context for continuous 5-slot exposure sizing')
assert(source.includes('marketContext: allocatorMarketContext'), 'paper entry should pass market context into the 5-slot allocator')
assert(source.includes('computePaperPositionValuation'), 'paper entry allocator NAV must use the shared position valuation helper')
assert(
  source.includes('batchGetLatestPricesByDomain(env, quoteMissingPosSymbols, today)') &&
    source.includes('valuation_missing_symbols'),
  'paper entry allocator must fall back quote-missing holdings to EOD prices and expose valuation misses',
)
assert(
  source.includes('safe_buying_power') &&
    source.includes("buying_power_source: 'internal_settlement_ledger'") &&
    source.includes('totalCost > acc.cash'),
  'paper entry must separate NAV sizing from available-cash buying-power hard gates',
)
assert(
  source.includes('nav_slot_floor_budget') &&
    source.includes("sizingMode: 'kelly_cap' | 'risk_parity' | 'l4_sparse_weight' | 'nav_slot_floor'") &&
    source.includes('Math.min(requestedBaseBudget, kellyBudget)') &&
    !source.includes('s12_limited_takeover_reduced_sizing'),
  'paper entry sizing must use NAV slot-floor fusion while preserving a promoted Kelly hard cap',
)
assert(source.includes("replacementDecision?.action !== 'replace'"), 'auto-swap must require an allocator replace decision')
assert(source.includes('allocator_replace_requires_sell_first'), 'paper entry must not buy a sixth slot before replacement sell completes')
assert(!source.includes('weaknessThreshold = 100 / swapThreshold'), 'legacy standalone weakness threshold must not own replacement decisions')
