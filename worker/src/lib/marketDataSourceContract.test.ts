const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')

assert(
  updateOrchestrator.includes('UPDATE_UNIVERSE_WHERE'),
  'market data queue must define an explicit update universe owner',
)

assert(
  !updateOrchestrator.includes('SELECT id, symbol, market, name FROM stocks WHERE in_current_watchlist=1'),
  'market data queue must not update only the current watchlist',
)

assert(
  updateOrchestrator.includes('full TW market indicator universe'),
  'market data queue log should make the full-market indicator contract explicit',
)

assert(
  updateOrchestrator.includes('computeAndStoreIndicators(env.DB, stock.id)'),
  'market data queue must compute indicators for the update universe',
)

assert(
  updateOrchestrator.includes('assertMarketDataReady(env.DB, twDate, { requireIndicators: false })'),
  'bulk fetch readiness must not require indicators before the indicator queue has run',
)

assert(
  updateOrchestrator.includes('Number(stock.in_current_watchlist ?? 0) === 1') &&
    updateOrchestrator.includes('crawlAndStoreNews(env.DB, stock)'),
  'per-symbol news crawling should stay limited to selected candidates/watchlist to control cost',
)

assert(
  updateOrchestrator.includes('runMLAndRiskV2(env, triggerTime)'),
  'event-driven ML trigger after queue update must preserve the requested update date',
)

assert(
  !updateOrchestrator.includes('triggerTime !== today'),
  'queue update must allow historical backfill dates instead of skipping non-today triggerTime',
)
