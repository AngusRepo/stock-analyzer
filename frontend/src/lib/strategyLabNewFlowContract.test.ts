import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = process.cwd()
const appPath = path.join(root, 'src', 'App.tsx')
const pagePath = path.join(root, 'src', 'pages', 'StrategyLearningPage.tsx')

assert(fs.existsSync(pagePath), 'Strategy Lab should have a dedicated Learning + Reward Ledger page')

const app = fs.readFileSync(appPath, 'utf8')
const page = fs.readFileSync(pagePath, 'utf8')

assert(app.includes("import('./pages/StrategyLearningPage')"), '/strategy-lab should route to the focused learning page')
assert(page.includes('Learning + Reward Ledger'), 'Strategy Lab should expose only the learning and reward ledger mission')
assert(page.includes('Active strategies'), 'Strategy Lab should separate currently active strategies')
assert(page.includes('Learning + shadowing strategies'), 'Strategy Lab should separate research, shadow, and candidate strategies')
assert(page.includes("row.status === 'active'"), 'Active strategy grouping must use the canonical active status')
assert(page.includes("row.status === 'research' || row.status === 'shadow' || row.status === 'candidate'"), 'Learning/shadowing grouping must use canonical lifecycle statuses')
assert(page.includes("row.status !== 'retired'"), 'Retired strategies should stay outside both primary groups')
assert(page.includes('strategyLabApi.learning()'), 'The focused page should load the canonical reward ledger response')
assert(page.includes('Promise.allSettled') && page.includes('strategyLabApi.specs()') && page.includes('registryLearningRow'), 'Strategy Lab must keep registry rows visible when the reward-ledger endpoint is unavailable')
assert(page.includes('xl:grid-cols-2 xl:items-start'), 'Active and learning/shadowing strategy groups must share one desktop row')
assert(page.includes('grid grid-cols-1 gap-px bg-slate-900 xl:grid-cols-2'), 'each strategy group must render two strategy cards per desktop row')
assert(!page.includes('StrategyLifecycleSwimlane'), 'The focused page should not repeat lifecycle experiment navigation')
assert(!page.includes('MetaLearningDecisionDesk'), 'The focused page should not repeat meta-learning experiment controls')
assert(!page.includes('ModelUpgradeLaunchpad'), 'Model research controls belong in Model Pool, not the reward ledger page')
assert(!page.includes('Pre-trade Spec + Dry-run'), 'Strategy Lab should not repeat pre-trade spec/dry-run UI')
assert(page.includes('production effect false'), 'Adaptive policy should remain explicitly shadow-only')

console.log('strategyLabNewFlowContract: OK')
