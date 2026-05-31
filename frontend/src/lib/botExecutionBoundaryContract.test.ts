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

assert(!bot.includes('FallbackRecommendations'), 'Bot should not render daily fallback recommendation component')
assert(!bot.includes('bot-fallback-recommendations'), 'Bot should not expose fallback daily recommendation markup')
assert(!bot.includes('splitRecommendationLanes'), 'Bot should not split daily recommendation lanes for fallback rendering')
assert(!bot.includes('AI 候選清單'), 'Bot should not label staging as a generic AI recommendation list')

assert(botPrefetch.includes('paperApi.pendingBuys'), 'Bot prefetch should keep pending-buy context warm')
assert(botPrefetch.includes('paperApi.account'), 'Bot prefetch should keep account context warm')
assert(botPrefetch.includes('recommendationDailyKey(date)'), 'Bot prefetch should warm private pre-debate candidate staging')
assert(botPrefetch.includes("recommendationsApi.daily(undefined, { view: 'card' })"), 'Bot prefetch should use canonical card-view daily recommendations for staging')
