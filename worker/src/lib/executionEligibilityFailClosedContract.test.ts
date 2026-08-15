import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd(), 'src/lib')
const screener = readFileSync(resolve(root, 'marketScreener.ts'), 'utf8')
const pendingBuy = readFileSync(resolve(root, 'pendingBuyOrchestrator.ts'), 'utf8')
const postExit = readFileSync(resolve(root, 'postExit.ts'), 'utf8')
const entryReplay = readFileSync(resolve(root, 'entryModelReplay.ts'), 'utf8')

assert.match(screener, /hasPositiveStrategyAllocation\([\s\S]*?runtimeStrategyAllocationWeights/)
assert.match(pendingBuy, /dr\.eligible_for_pending_buy = 1/)
assert.match(postExit, /dr\.eligible_for_pending_buy = 1/)
assert.match(entryReplay, /dr\.eligible_for_pending_buy = 1/)

for (const source of [pendingBuy, postExit, entryReplay]) {
  assert.doesNotMatch(source, /COALESCE\(dr\.eligible_for_pending_buy,\s*1\)/)
}

console.log('execution eligibility fail-closed contract tests passed')
