import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync('src/pages/BotDashboard.tsx', 'utf8')

assert(!page.includes('StrategyAbRecommendations'), 'A/B research comparison lives in NavTradingRoom, not the paper execution room')
assert(page.includes('visiblePendingBuys(pbData)') && !page.includes("['APPROVE', 'DOWNGRADE'].includes(verdict)"),
  'debate is advisory: the execution pool is never filtered by debate verdict')
assert(!page.includes('BUY label only {scoreOnlyRecs.length}'))
assert(!page.includes('rows={scoreOnlyRecs}'))
console.log('BotDashboard execution separation contracts passed')
