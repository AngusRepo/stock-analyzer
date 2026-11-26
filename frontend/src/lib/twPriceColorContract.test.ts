import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

// Signed market figures follow the Taiwan convention used by the index tiles: positive red, negative green.
const root = process.cwd()
const read = (...parts: string[]) => fs.readFileSync(path.join(root, 'src', ...parts), 'utf8')
const pipeline = read('components', 'PipelineMaturityContribution.tsx')
const futures = read('components', 'MarketRiskDetailBreakdown.tsx')
const home = read('pages', 'MarketHomePage.tsx')

assert(!pipeline.includes('正綠'), 'Pipeline evidence must not describe a positive-green convention')
assert(pipeline.includes("return value > 0 ? 'text-rose-300' : 'text-emerald-300'"), 'Pipeline signed metrics must render positive red, negative green')
assert(futures.includes("return n > 0 ? 'rose' : 'emerald'"), 'Futures institutional net positions must render net long red, net short green')
assert(!home.includes("colors={['#22c55e', '#ef4444', '#14b8a6']}"), 'Institutional flow split bar must not paint categories in up/down colors')
assert(home.includes("return value >= 0 ? 'red' : 'green'"), 'Homepage signed tones must stay positive red, negative green')

console.log('twPriceColorContract: OK')
