import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function read(root: string, ...parts: string[]) {
  return fs.readFileSync(path.join(root, ...parts), 'utf8')
}

function extractBotPrefetchBlock(source: string): string {
  const marker = "if (href === '/bot' && opts.isAuthenticated)"
  const start = source.indexOf(marker)
  assert(start >= 0, 'queryPolicy should keep a dedicated Bot prefetch branch')
  const end = source.indexOf('\n  }\n', start)
  assert(end > start, 'queryPolicy Bot prefetch branch should be parseable')
  return source.slice(start, end)
}

const root = process.cwd()
const botPath = path.join(root, 'src', 'pages', 'BotDashboard.tsx')
const queryPolicyPath = path.join(root, 'src', 'lib', 'queryPolicy.ts')

assert(fs.existsSync(botPath), 'BotDashboard should exist')

const bot = read(root, 'src', 'pages', 'BotDashboard.tsx')
const queryPolicy = read(root, 'src', 'lib', 'queryPolicy.ts')
const botPrefetch = extractBotPrefetchBlock(queryPolicy)

assert(bot.includes('paperApi.pendingBuys'), 'Bot should keep pending-buy as the private trading-core source')
assert(bot.includes('ExecutionOnlyEmptyState'), 'Bot should render an execution-only empty state when no pending buys exist')
assert(bot.includes('BotExecutionCandidateCard'), 'Bot pending buys should render through an execution candidate card')
assert(bot.includes('BotExecutionLifecycleVisual'), 'Bot should visualize candidate-to-execution lifecycle instead of relying on text badges only')
assert(bot.includes('shouldShowPreDebateStaging'), 'Bot should distinguish pre-debate staging from empty execution state')
assert(bot.includes('PreDebateStagingPool'), 'Bot should render a private pre-debate staging pool when timing is before debate')
assert(bot.includes('const tradableRows = tradable.slice(0, 16)'), 'Bot pre-debate staging should render an explicit tradable section')
assert(bot.includes('const emergingRows = emerging.slice(0, 24)'), 'Bot pre-debate staging should render the emerging watchlist section')
assert(bot.includes('emergingRows.map'), 'Bot pre-debate staging must display emerging watchlist cards, not only the count')
assert(bot.includes('興櫃研究觀察'), 'Bot pre-debate staging should label the emerging watchlist for users')
assert(!bot.includes('const rows = tradable.slice(0, 16)'), 'Bot pre-debate staging must not drop emerging rows by rendering only tradable rows')
assert(bot.includes('sv-content-card-selected'), 'Bot selected/private target cards should consume route-level surface selected tokens')
assert(bot.includes('sv-surface-chip-accent'), 'Bot private ranking chips should consume route-level accent tokens')
assert(!bot.includes('pre-debate-staging-card rounded-xl border bg-[#070a10]'), 'Pre-debate staging cards must not keep fixed dark surface styling')
assert(!bot.includes('bot-execution-candidate-card rounded-xl border bg-[#070a10]'), 'Execution candidate cards must not keep fixed dark surface styling')
assert(bot.includes('bot-position-risk-map'), 'Bot holdings should show a visual position/risk summary before the raw table')
assert(bot.includes('bot-position-table-drilldown'), 'Bot holdings table should be collapsed behind a drilldown disclosure')
assert(bot.includes('bot-order-flow-summary'), 'Bot trade history should show visual order-flow summary before the raw table')
assert(bot.includes('bot-orders-table-drilldown'), 'Bot orders table should be collapsed behind a drilldown disclosure')

assert(!bot.includes('FallbackRecommendations'), 'Bot should not render daily fallback recommendation component')
assert(!bot.includes('bot-fallback-recommendations'), 'Bot should not expose fallback daily recommendation markup')
assert(!bot.includes('splitRecommendationLanes'), 'Bot should not split daily recommendation lanes for fallback rendering')
assert(!bot.includes('AI 候選清單'), 'Bot should not label staging as a generic AI recommendation list')

assert(botPrefetch.includes('paperApi.pendingBuys'), 'Bot prefetch should keep pending-buy context warm')
assert(botPrefetch.includes('paperApi.account'), 'Bot prefetch should keep account context warm')
assert(botPrefetch.includes('recommendationDailyKey(date)'), 'Bot prefetch should warm private pre-debate candidate staging')
assert(botPrefetch.includes("recommendationsApi.daily(undefined, { view: 'card' })"), 'Bot prefetch should use canonical card-view daily recommendations for staging')
