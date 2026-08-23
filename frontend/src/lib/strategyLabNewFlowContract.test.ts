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
assert(page.includes('策略學習與報酬帳本'), 'Strategy Lab should expose the production learning and reward-ledger mission')
assert(page.includes('StrategyQueue'), 'Strategy Lab should expose an attention-first strategy queue')
assert(page.includes('StrategyLineageInspector'), 'Strategy Lab should expose a production lineage inspector')
assert(page.includes("useState<StrategyViewFilter>('attention')"), 'Strategy queue should default to actionable exceptions')
assert(page.includes("viewFilter === 'active'") && page.includes("viewFilter === 'learning'"), 'Queue filters must use canonical lifecycle status')
assert(page.includes("row.status !== 'retired'"), 'Retired strategies should stay outside the workspace')
assert(page.includes('rows={[selectedRow]}'), 'The evidence workspace must render one selected strategy instead of every card at once')
assert(page.includes('xl:grid-cols-[260px_minmax(0,1fr)_300px]'), 'Desktop layout must use queue, workspace, and inspector columns')
assert(!page.includes('xl:grid-cols-2 xl:items-start'), 'The old all-strategies two-column wall must not return')
assert(page.includes('row.learning.today_matched'), 'strategy cards must expose daily matched count instead of forcing users to infer it from reward or policy fields')
assert(page.includes('strategyLabApi.learning()'), 'The focused page should load the canonical reward ledger response')
assert(page.includes('Promise.allSettled') && page.includes('strategyLabApi.specs()') && page.includes('strategyLabApi.evidenceProfiles()'), 'Strategy Lab must load all three production read models without making one failure erase the others')
assert(page.includes('registryLearningRow'), 'Strategy Lab must keep registry rows visible when the reward-ledger endpoint is unavailable')
assert(page.includes('gate.strategy_id') && page.includes('profile.strategy_id') && page.includes('strategy_version'), 'All joins must preserve exact id:version identity')
assert(!page.includes('StrategyLifecycleSwimlane'), 'The focused page should not repeat lifecycle experiment navigation')
assert(!page.includes('MetaLearningDecisionDesk'), 'The focused page should not repeat meta-learning experiment controls')
assert(!page.includes('ModelUpgradeLaunchpad'), 'Model research controls belong in Model Pool, not the reward ledger page')
assert(!page.includes('Pre-trade Spec + Dry-run'), 'Strategy Lab should not repeat pre-trade spec/dry-run UI')
assert(page.includes('policy?.evidence.production_effect'), 'Adaptive policy must display its canonical production-effect state')
assert(page.includes('currentDecisionPending'), 'Strategy cards must distinguish a not-yet-produced day from a real 0/0/0 decision batch')
assert(page.includes('StrategyGateDetails'), 'Selected strategy must retain its own readiness thresholds and evidence')
assert(page.includes('replacement_gate'), 'Strategy cards must consume canonical replacement evidence from the API')
assert(page.includes('AtomicReplacementSummary'), 'Cross-family replacement must remain available once in governance details')
assert(page.includes('materializeDecisionLog') && page.includes('refreshStrategyRewardLedger') && page.includes('refreshStrategyPolicyState'), 'Operational actions must survive the readability refactor')

console.log('strategyLabNewFlowContract: OK')
