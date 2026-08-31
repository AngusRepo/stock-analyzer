const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const readSource = (path: string): string =>
  fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n')

const updateOrchestrator = readSource('src/lib/updateOrchestrator.ts')
const marketScreener = readSource('src/lib/marketScreener.ts')
const twseApi = readSource('src/lib/twseApi.ts')
const officialMarketSummaryRefresh = readSource('src/lib/officialMarketSummaryRefresh.ts')
const otherRoutes = readSource('src/routes/other.ts')
const wranglerToml = readSource('wrangler.toml')

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
  updateOrchestrator.includes("computeAndStoreIndicators(databaseForDataDomain(env, 'market'), stock.id)"),
  'market data queue must compute indicators for the update universe',
)

assert(
  updateOrchestrator.includes('assertMarketDataReady(env, twDate, { requireIndicators: false, requireMargin: true })'),
  'bulk fetch readiness must require broad same-day margin coverage before the indicator queue has run',
)

assert(
  twseApi.includes("canonicalMarginSource = 'twse.tpex.official_margin_fallback'") &&
    twseApi.includes("schema_version: 'official-margin-fallback-v1'") &&
    twseApi.includes('INSERT INTO canonical_chip_daily') &&
    twseApi.includes('canonicalMarginCount'),
  'official TWSE/TPEX margin fallback must write canonical per-symbol lineage rather than only a legacy serving row',
)

assert(
  twseApi.includes('assertBulkPriceSourceReady') &&
    twseApi.includes('MIN_TWSE_BULK_PRICE_ROWS = 900') &&
    twseApi.includes('MIN_TPEX_BULK_PRICE_ROWS = 700') &&
    twseApi.includes('Bulk price source incomplete'),
  'bulk price fetch must fail before D1 writes when TWSE/TPEX source rows are incomplete',
)

assert(
  officialMarketSummaryRefresh.includes("const marketDb = databaseForDataDomain(env, 'market')") &&
    officialMarketSummaryRefresh.includes('deriveOtcSummaryFromCanonicalChip(\n    marketDb,') &&
    officialMarketSummaryRefresh.includes('upsertMarketSummaryRows(marketDb, rows)') &&
    !officialMarketSummaryRefresh.includes('upsertMarketSummaryRows(env.DB, rows)'),
  'official market summary must read canonical chip and write summary through the Market D1 owner',
)

assert(
  updateOrchestrator.includes('TWSE/TPEX supplemental fetch failed before indicator queue') &&
    updateOrchestrator.includes("logSchedulerResult(env.KV, 'evening-chain'"),
  'TWSE/TPEX supplemental fetch failures must be visible in evening-chain scheduler logs before queue starts',
)

assert(
  updateOrchestrator.includes('FinLab primary canonical ready') &&
    updateOrchestrator.includes("sourceRole: 'finlab_primary_canonical_mirror'") &&
    updateOrchestrator.includes('source_role=${mirror.sourceRole}') &&
    !updateOrchestrator.includes('before legacy fallback + indicator queue'),
  'FinLab canonical must remain primary while TWSE/TPEX refresh is documented as supplemental, not legacy owner fallback',
)

assert(
  updateOrchestrator.includes('Number(stock.in_current_watchlist ?? 0) === 1') &&
    updateOrchestrator.includes("type: 'news_batch'") &&
    updateOrchestrator.includes("crawlAndStoreNews(databaseForDataDomain(env, 'market'), stock)"),
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
  updateOrchestrator.includes('runMLAndRiskV2(env, triggerTime, { prevalidatedEventChain: true })'),
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

assert(
  otherRoutes.includes('refusing stale fallback') &&
    otherRoutes.includes('stale_preview_count') &&
    otherRoutes.includes('stocks: []'),
  'sector-flow stock details must not silently fallback to stale MAX(date) rows',
)

assert(
  twseApi.includes('identityDb: D1Database') &&
    twseApi.includes("identityDb.prepare('SELECT id, symbol FROM stocks')") &&
    !twseApi.includes("db.prepare('SELECT id, symbol FROM stocks')"),
  'chip supplemental writes must resolve stock identities from Core D1 instead of querying the Market D1 owner',
)

assert(
  updateOrchestrator.includes(`bulkFetchAndStoreChipData(
        databaseForDataDomain(env, 'market'),
        databaseForDataDomain(env, 'core'),`) &&
    updateOrchestrator.includes(`bulkFetchAndStorePrices(
        databaseForDataDomain(env, 'market'),
        databaseForDataDomain(env, 'core'),`),
  'both chip and price bulk refresh must receive separate Market storage and Core identity databases',
)
