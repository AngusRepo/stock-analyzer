import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const page = readFileSync('src/pages/ModelPoolPage.tsx', 'utf8')

assert(page.includes('promotionDecisionDisplay'), 'Model Pool should map promotion decisions before rendering')
assert(page.includes('候選保留，暫不升 champion'), 'Blocked multi-evidence candidates should render as shadow/adaptive hold, not MC failure')
assert(page.includes('PromotionEvidenceGateList'), 'Model Pool should render promotion evidence as gate rows, not one vague DSR/MC sentence')
assert(page.includes('DSR / MC / PBO / SPA'), 'Model Health Matrix should show DSR, MC, PBO, and SPA together')
assert(page.includes('Candidate gate / Release gate'), 'Model Health Matrix should separate candidate-specific evidence from release gate')
assert(page.includes('Candidate-specific evidence'), 'Promotion evidence UI should label model-level candidate evidence')
assert(page.includes('Shared weekly release gate'), 'Promotion evidence UI should label shared weekly/global release gate')
assert(page.includes('weekly/global gate 不代替 model-level evidence'), 'UI must state shared gates do not replace candidate-specific evidence')
assert(page.includes('缺 White Reality Check / Hansen SPA'), 'SPA missing reason should be visible when data-snooping guard is absent')
assert(page.includes('actionableRows'), 'Promotion Queue should separate actionable final-compare rows from blocked evidence rows')
assert(page.includes('候選驗證阻塞 / 不在晉級佇列'), 'Blocked candidates should be retained as audit/shadow evidence outside the decision queue')
assert(!page.includes('模型 artifact DSR/MC 未齊'), 'Model Pool should not hide missing promotion evidence behind a vague DSR/MC pill')
assert(!page.includes('這不是 parameter candidate chain'), 'Model Pool should show gate values and reasons instead of explanatory filler')
assert(!page.includes('{row.promotion_decision}'), 'Promotion queue should not show raw backend decision codes')
assert(!page.includes('promotion is blocked'), 'Promotion queue should not show raw blocker prose')
assert(!page.includes('{blocker.code}</div>'), 'Promotion queue should not expose blocker machine codes in the UI')
