const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const marketScreener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
const twseApi = fs.readFileSync('src/lib/twseApi.ts', 'utf8')
const wranglerToml = fs.readFileSync('wrangler.toml', 'utf8')

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
  twseApi.includes('assertBulkPriceSourceReady') &&
    twseApi.includes('MIN_TWSE_BULK_PRICE_ROWS = 900') &&
    twseApi.includes('MIN_TPEX_BULK_PRICE_ROWS = 700') &&
    twseApi.includes('Bulk price source incomplete'),
  'bulk price fetch must fail before D1 writes when TWSE/TPEX source rows are incomplete',
)

assert(
  updateOrchestrator.includes('bulk fetch failed before indicator queue') &&
    updateOrchestrator.includes("logSchedulerResult(env.KV, 'evening-chain'"),
  'bulk fetch failures must be visible in evening-chain scheduler logs before queue starts',
)

assert(
  updateOrchestrator.includes('Number(stock.in_current_watchlist ?? 0) === 1') &&
    updateOrchestrator.includes("type: 'news_batch'") &&
    updateOrchestrator.includes('crawlAndStoreNews(env.DB, stock)'),
  'news crawling should stay limited to selected watchlist stocks and run outside the price/indicator hot path',
)

assert(
  updateOrchestrator.includes('env.NEWS_QUEUE.send') &&
    !updateOrchestrator.includes('NEWS_QUEUE ?? env.UPDATE_QUEUE'),
  'news crawl must use the dedicated NEWS_QUEUE instead of falling back to update queue',
)

assert(
  wranglerToml.includes('binding = "NEWS_QUEUE"') &&
    wranglerToml.includes('queue = "stockvision-news-queue"') &&
    wranglerToml.includes('dead_letter_queue = "stockvision-news-queue-dlq"'),
  'wrangler must provision a dedicated news queue producer/consumer and DLQ',
)

assert(
  updateOrchestrator.includes('loadPriceMetadataForBatch') &&
    updateOrchestrator.includes('GROUP BY stock_id'),
  'queue update must batch price-count metadata instead of counting per stock',
)

assert(
  updateOrchestrator.includes('INDICATOR_BATCH_CONCURRENCY') &&
    updateOrchestrator.includes('runBounded(currentBatch, INDICATOR_BATCH_CONCURRENCY'),
  'indicator compute must use bounded concurrency to avoid D1 write bursts',
)

assert(
  updateOrchestrator.includes('runMLAndRiskV2(env, triggerTime)'),
  'event-driven ML trigger after queue update must preserve the requested update date',
)

assert(
  !updateOrchestrator.includes('triggerTime !== today'),
  'queue update must allow historical backfill dates instead of skipping non-today triggerTime',
)

assert(
  marketScreener.includes('selection history flags reused from candidate-pool superset') &&
    !marketScreener.includes('const refreshedFlags = await loadSelectionHistoryFlags'),
  'screener should reuse the selection-flag superset instead of re-querying final candidates',
)
