import fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const types = fs.readFileSync('src/types.ts', 'utf8')
const stocksRoute = fs.readFileSync('src/routes/stocks.ts', 'utf8')
const otherRoute = fs.readFileSync('src/routes/other.ts', 'utf8')
const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')

for (const [name, source] of [
  ['worker types', types],
  ['stocks route', stocksRoute],
  ['other route', otherRoute],
  ['update orchestrator', updateOrchestrator],
] as const) {
  assert(!source.includes('FINMIND_TOKEN'), `${name} must not expose FinMind as a Worker runtime data source`)
  assert(!source.includes('fetchAndStoreStockData'), `${name} must not call the old per-stock fallback fetcher`)
}

assert(!stocksRoute.includes('fetchAndStoreYahoo'), 'stocks route must not keep the old Yahoo price backfill helper')
assert(!stocksRoute.includes('query1.finance.yahoo.com/v8/finance/chart'), 'stocks route must not backfill TW stock prices from Yahoo')
assert(
  stocksRoute.includes('finlab_primary_manual_refresh_disabled'),
  'manual stock refresh must fail closed and point operators to FinLab repair/backfill',
)
assert(
  otherRoute.includes('finlab_primary_price_history_insufficient'),
  'ML predict route must fail visible when FinLab primary price history is insufficient',
)
assert(
  !fs.existsSync('../scripts/backfill.ts') &&
    !fs.existsSync('../scripts/backfill_revenue.py') &&
    !fs.existsSync('../scripts/backfill_yahoo.py'),
  'old FinMind/Yahoo manual backfill scripts must be removed from the tracked project',
)
