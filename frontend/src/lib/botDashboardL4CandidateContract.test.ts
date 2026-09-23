import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync('src/pages/BotDashboard.tsx', 'utf8')
const comparison = fs.readFileSync('src/components/StrategyAbRecommendations.tsx', 'utf8')

assert(page.includes('<StrategyAbRecommendations'))
assert(comparison.includes("view: 'card'") && comparison.includes('timeoutMs: 15_000'))
assert(comparison.includes("['A', 'B'] as const"))
assert(comparison.includes('pick.weight * 100') && comparison.includes('arm.cash_weight! * 100'))
assert(comparison.includes("arm.status !== 'available'"), 'Missing B must not be rendered as cash')
assert(comparison.includes("data.scope === 'retrospective_research'"))
assert(comparison.includes('不計入原生 NAV 績效') && comparison.includes('不會產生委託'))
assert(comparison.includes('isError') && comparison.includes('refetch()'))
assert(page.includes("status === 'completed' && ['APPROVE', 'DOWNGRADE'].includes(verdict)"),
  'A/B target display must not bypass the existing pending-buy debate view')
assert(!page.includes('BUY label only {scoreOnlyRecs.length}'))
assert(!page.includes('rows={scoreOnlyRecs}'))
console.log('BotDashboard A/B allocation and execution separation contracts passed')
