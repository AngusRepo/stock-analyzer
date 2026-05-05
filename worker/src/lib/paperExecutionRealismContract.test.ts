import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const exitTasks = readFileSync('src/lib/paperExitTasks.ts', 'utf8')
const entryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const workerTasks = readFileSync('src/lib/paperWorkerTasks.ts', 'utf8')
const cronOrchestrator = readFileSync('src/lib/cronOrchestrator.ts', 'utf8')
const intradayData = readFileSync('src/lib/paperIntradayData.ts', 'utf8')

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
  workerTasks.includes('resolveMarketSellFill'),
  'rescore sell execution must use the shared bid-aware fill policy',
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
  exitTasks.includes('requireBestBid: true') && workerTasks.includes('requireBestBid: true') && entryTasks.includes('requireBestBid: true'),
  'all automatic sell execution paths must require executable best bid',
)
assert(
  intradayData.includes('/orderbook/${symbol}') && intradayData.includes('enrichMissingOrderbookQuotes'),
  'broker snapshots missing bid/ask must be enriched from Shioaji orderbook before execution',
)
assert(
  !entryTasks.includes('remaining_order_policy_pending'),
  'partial fill remaining orders must not be left as passive placeholder notes',
)
assert(
  /else\s*{\s*recordExecutionEvent\(pending\.symbol,\s*'filled',\s*'paper_order_created'\)/m.test(entryTasks),
  'full filled pending-buy terminal event must only run in the non-partial branch',
)
