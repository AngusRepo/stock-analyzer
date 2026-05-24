import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const page = readFileSync('src/pages/ModelPoolPage.tsx', 'utf8')

assert(page.includes('promotionDecisionDisplay'), 'Model Pool should map promotion decisions before rendering')
assert(page.includes('候選保留，暫不升 champion'), 'Blocked multi-evidence candidates should render as shadow/adaptive hold, not MC failure')
assert(page.includes('模型 artifact DSR/MC 未齊'), 'Missing DSR/MC evidence should be scoped to the model artifact lane')
assert(page.includes('這不是 parameter candidate chain'), 'Model artifact DSR/MC copy must not imply parameter candidate validation did not run')
assert(!page.includes('{row.promotion_decision}'), 'Promotion queue should not show raw backend decision codes')
assert(!page.includes('promotion is blocked'), 'Promotion queue should not show raw blocker prose')
assert(!page.includes('{blocker.code}</div>'), 'Promotion queue should not expose blocker machine codes in the UI')
