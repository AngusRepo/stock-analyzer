import * as fs from 'fs'
import * as path from 'path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'paperEntryTasks.ts'), 'utf8')

assert(source.includes('const autoSwapPlan = buildFiveSlotCapitalPlan'), 'auto-swap must be driven by the 5-slot allocator plan')
assert(source.includes('formatFiveSlotDecisionWatchPoint'), 'paper entry must persist structured allocator watch points')
assert(source.includes("replacementDecision?.action !== 'replace'"), 'auto-swap must require an allocator replace decision')
assert(source.includes('allocator_replace_requires_sell_first'), 'paper entry must not buy a sixth slot before replacement sell completes')
assert(source.includes('maxQuoteAgeMs: cfg.position.maxQuoteAgeMs'), 'paper entry quote freshness must be governed by trading config, not a hidden 15s fallback')
assert(source.includes('maxEntryChasePct: cfg.position.maxEntryChasePct'), 'paper entry must pass bounded strong-stock chase policy into pre-trade execution')
assert(!source.includes('weaknessThreshold = 100 / swapThreshold'), 'legacy standalone weakness threshold must not own replacement decisions')
assert(!source.includes('maxQuoteAgeMs ?? 15_000'), 'paper entry must not hard-code a 15s quote expiry gate')
