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
assert(source.includes("replacementDecision?.action !== 'replace'"), 'auto-swap must require an allocator replace decision')
assert(source.includes('allocator_replace_requires_sell_first'), 'paper entry must not buy a sixth slot before replacement sell completes')
assert(!source.includes('weaknessThreshold = 100 / swapThreshold'), 'legacy standalone weakness threshold must not own replacement decisions')
assert(source.includes('function activeStatusForUnfilledBuy'), 'unfilled buy outcomes must be classified before updating card telemetry')
assert(source.includes("reason === 'missing_best_ask'"), 'missing best ask must be treated as quote unavailable, not submitted')
assert(source.includes("reason.startsWith('broker_quote_required:')"), 'missing broker quote must be treated as quote unavailable')
assert(source.includes('activeStatusForUnfilledBuy(fill.reason)'), 'failed limit buy fills must not persist submitted status')
assert(source.includes("reason: 'auto_swap_replacement_not_executable'"), 'replacement buy failure must remain visible as an auto-swap event')
assert(source.includes("activeStatusForUnfilledBuy(fillReason)"), 'auto-swap replacement failures must update active pending-buy telemetry')
assert(
  !source.includes("recordActiveExecutionStatus(\n        pending.symbol,\n        'submitted',\n        fill.reason"),
  'unfilled buy path must not mark the card as submitted before an order exists',
)
