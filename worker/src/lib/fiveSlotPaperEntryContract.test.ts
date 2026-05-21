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
assert(!source.includes('weaknessThreshold = 100 / swapThreshold'), 'legacy standalone weakness threshold must not own replacement decisions')
