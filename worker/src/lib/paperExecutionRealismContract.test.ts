import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const exitTasks = readFileSync('src/lib/paperExitTasks.ts', 'utf8')
const entryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const workerTasks = readFileSync('src/lib/paperWorkerTasks.ts', 'utf8')
const cronOrchestrator = readFileSync('src/lib/cronOrchestrator.ts', 'utf8')
const intradayData = readFileSync('src/lib/paperIntradayData.ts', 'utf8')
const intradayPriceCache = readFileSync('src/lib/paperIntradayPriceCache.ts', 'utf8')
const paperRoutes = readFileSync('src/routes/paper.ts', 'utf8')

assert(
  exitTasks.includes('batchGetIntradayOHLC'),
  'paper exit tasks must use OHLC quotes with bid/ask, not last-price-only maps',
)
assert(
  exitTasks.includes('resolveMarketSellFill'),
  'paper exit tasks must resolve market sells through bid-aware fill policy',
)
assert(
  !exitTasks.includes('applySlippage('),
  'paper exit tasks must not synthesize sell fills directly from last price',
)
assert(
  cronOrchestrator.includes('batchGetIntradayOHLC'),
  'intraday rescore must fetch broker OHLC quotes for executable sell decisions',
)
assert(
  !cronOrchestrator.includes('executeRescoreSell('),
  'intraday rescore must not be a second exit owner; it may only emit WARN/EXIT_SIGNAL evidence',
)
assert(
  cronOrchestrator.includes('EXIT_SIGNAL') && cronOrchestrator.includes("execution_policy: 'observe_only'"),
  'intraday rescore EXIT decisions must be persisted as observe-only evidence',
)
assert(
  workerTasks.includes('resolveMarketSellFill'),
  'rescore sell execution must use the shared bid-aware fill policy',
)
assert(
  workerTasks.includes('missingFinalSymbols') &&
    workerTasks.includes('batchGetLatestPrices(env.DB, missingFinalSymbols)') &&
    !workerTasks.includes('if (finalPriceMap.size === 0) finalPriceMap = await batchGetLatestPrices'),
  'daily snapshot must fill missing intraday quotes from EOD prices instead of treating partial intraday coverage as complete',
)
assert(
  workerTasks.includes('options: DailySnapshotOptions = {}') &&
    workerTasks.includes('snapshotDate(options.date)') &&
    workerTasks.includes('date < ? ORDER BY date DESC LIMIT 30'),
  'daily snapshot reruns must support explicit business dates and exclude stale same-date rows from metrics',
)
assert(
  entryTasks.includes('resolveMarketSellFill'),
  'auto-swap sells must use the shared bid-aware fill policy',
)
assert(
  !entryTasks.includes('const sellPrice = weakPx'),
  'auto-swap must not use last/current price directly as sell fill price',
)
assert(
  entryTasks.includes('recordActiveExecutionStatus') && entryTasks.includes("'partially_filled'"),
  'partial buy fills must remain visible as active partially_filled pending-buy state',
)
assert(
  entryTasks.includes('evaluatePartialFillRemainingPolicy'),
  'partial fill remaining orders must be resolved through an explicit policy layer',
)
assert(
  entryTasks.includes('requireBestAsk: true'),
  'auto buy execution must require executable best ask instead of low/high-only inference',
)
assert(
  exitTasks.includes('requireBestBid: !options.allowLastPriceFallback') &&
    exitTasks.includes('allowLastPriceFallback: true') &&
    workerTasks.includes('requireBestBid: true') &&
    entryTasks.includes('requireBestBid: true'),
  'automatic sell execution paths must require executable best bid except explicit intraday TP1 fallback',
)
assert(
  readFileSync('src/lib/paperTradeMath.ts', 'utf8').includes('input.requireBestBid ?? true') &&
    readFileSync('src/lib/paperTradeMath.ts', 'utf8').includes('last_price_fallback_market_sell'),
  'shared market-sell policy must fail closed by default and expose explicit last-price fallback only when best bid is not required',
)
assert(
  intradayData.includes('/orderbook/${symbol}') && intradayData.includes('enrichMissingOrderbookQuotes'),
  'broker snapshots missing bid/ask must be enriched from Shioaji orderbook before execution',
)
assert(
  exitTasks.includes('putIntradayPrice(env.KV, symbol, quote.last)') &&
    intradayPriceCache.includes("INTRADAY_PRICE_PREFIX = 'intraday:price:'") &&
    intradayPriceCache.includes('clearOpenPositionIntradayPriceCache'),
  'intraday price cache must have explicit write/clear ownership instead of ad hoc quote.last KV writes',
)
assert(
  paperRoutes.includes("c.header('Cache-Control', 'no-store, max-age=0')"),
  'paper positions API must be no-store so post-market EOD prices are not masked by stale intraday responses',
)
assert(
  !entryTasks.includes('remaining_order_policy_pending'),
  'partial fill remaining orders must not be left as passive placeholder notes',
)
assert(
  /else\s*{\s*recordExecutionEvent\(pending\.symbol,\s*'filled',\s*'paper_order_created'\)/m.test(entryTasks),
  'full filled pending-buy terminal event must only run in the non-partial branch',
)
