import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = process.cwd()
const pagePath = path.join(root, 'src', 'pages', 'StrategyLabPage.tsx')
const familyWorkbenchName = 'Strategy' + 'FamilyWorkbench'
const experimentTimelineName = 'Strategy' + 'ExperimentTimeline'
const familyWorkbenchPath = path.join(root, 'src', 'components', 'strategy-lab', `${familyWorkbenchName}.tsx`)
const experimentTimelinePath = path.join(root, 'src', 'components', 'charts', `${experimentTimelineName}.tsx`)

const page = fs.readFileSync(pagePath, 'utf8')

assert(!fs.existsSync(familyWorkbenchPath), 'Removed family workbench should stay out of Strategy Lab')
assert(!fs.existsSync(experimentTimelinePath), 'Removed experiment timeline should stay out of Strategy Lab')
assert(!page.includes(familyWorkbenchName), 'StrategyLab page should not import or render the removed family workbench')
assert(!page.includes(experimentTimelineName), 'StrategyLab page should not import or render the removed timeline workbench')

assert(page.includes('StrategyLifecycleSwimlane'), 'Strategy Lab should keep lifecycle evidence in the family workspace')
assert(page.includes('Strategy Family Workspace'), 'Strategy Lab should expose a strategy-family master-detail workspace')
assert(page.includes('selectedStrategyIdIntent') && page.includes("url.searchParams.set('strategy', id)"), 'Strategy selection should be URL-keyed and shareable')
assert(page.includes('唯一下一步'), 'Selected strategy inspector should expose one evidence-driven next action')
assert(page.includes('今日研究焦點') && page.includes('strategyBlockerCount'), 'Strategy Lab should show evidence gaps before dense actions')
assert(page.includes('Model promotion → Model Pool'), 'Strategy Lab should make Model Pool promotion ownership explicit')
assert(page.includes('<details className="group overflow-hidden rounded-2xl') && page.includes('governance only；promotion ownership 在 Model Pool'), 'Model research links should be secondary and collapsed')
assert(page.includes('Action Lanes'), 'Strategy Lab should keep actionable controls grouped in action lanes')
assert(page.includes('Registry / Evidence Inspector'), 'Strategy Lab should keep the right-side registry evidence inspector')
assert(page.includes('Strategy Ops'), 'Strategy Lab should keep the consolidated strategy operations block')
assert(page.includes('Learning + Reward Ledger'), 'Strategy learning panel should focus on reward ledger evidence')
assert(page.includes('Approve shadow'), 'Research Intern Gate UX should expose approve-shadow review action')
assert(page.includes('Request evidence'), 'Research Intern Gate UX should expose request-more-evidence action')
assert(page.includes('Promote paper-active'), 'Research Intern Gate UX should expose paper-active promotion request')

console.log('strategyLabNewFlowContract: OK')
