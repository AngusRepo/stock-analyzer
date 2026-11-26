import * as fs from 'node:fs'
import * as path from 'node:path'
import { priceArrow, priceToneClass } from './colorTokens'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

// Signed market figures follow the Taiwan convention: positive red (--up), negative green (--down).
// 2026-11-26 batch3: the literal rose/emerald classes became the up/down tokens, so this contract now
// checks the token helpers and that each call site routes through them.
const root = process.cwd()
const read = (...parts: string[]) => fs.readFileSync(path.join(root, 'src', ...parts), 'utf8')
const pipeline = read('components', 'PipelineMaturityContribution.tsx')
const futures = read('components', 'MarketRiskDetailBreakdown.tsx')
const home = read('pages', 'MarketHomePage.tsx')

assert(priceToneClass(1.2) === 'text-up' && priceToneClass(-0.4) === 'text-down', 'priceToneClass: positive up (red), negative down (green)')
assert(priceToneClass(0) === 'text-muted-foreground' && priceToneClass(null) === 'text-muted-foreground', 'zero and missing stay neutral')
assert(priceArrow(1) === '▲' && priceArrow(-1) === '▼', 'up/down arrows accompany price color')

assert(!pipeline.includes('正綠'), 'Pipeline evidence must not describe a positive-green convention')
assert(/function returnTone[\s\S]{0,200}priceToneClass\(value\)/.test(pipeline), 'Pipeline signed metrics must use priceToneClass')
assert(futures.includes("return n > 0 ? 'up' : 'down'"), 'Futures institutional net positions must render net long up, net short down')
assert(!home.includes("colors={['#22c55e', '#ef4444', '#14b8a6']}"), 'Institutional flow split bar must not paint categories in up/down colors')
assert(home.includes("return value > 0 ? 'up' : 'down'"), 'Homepage signed tones must stay positive up, negative down')

console.log('twPriceColorContract: OK')
