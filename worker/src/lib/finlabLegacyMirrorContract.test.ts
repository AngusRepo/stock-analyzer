import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync('src/lib/updateOrchestrator.ts', 'utf8')

assert(
  source.includes('export async function syncLegacyMarketDataFromFinLabCanonical'),
  'FinLab canonical mirror helper must be exported for source-policy tests',
)
assert(
  source.includes('FROM canonical_market_daily') &&
    source.includes('INSERT INTO stock_prices'),
  'FinLab canonical market rows must mirror into legacy stock_prices serving table',
)
assert(
  source.includes('row.adj_close ?? row.close'),
  'legacy stock_prices.adj_close must use FinLab canonical adj_close when available',
)
assert(
  source.includes('row.avg_price'),
  'legacy stock_prices.avg_price must use FinLab canonical avg_price when available',
)
assert(
  source.includes('FROM canonical_chip_daily') &&
    source.includes('INSERT INTO chip_data') &&
    source.includes('INSERT INTO margin_data'),
  'FinLab canonical chip rows must mirror into legacy chip_data and margin_data serving tables',
)
assert(
  source.includes('MAX(foreign_buy)') &&
    source.includes('MAX(trust_buy)') &&
    source.includes('MAX(dealer_buy)'),
  'legacy chip_data buy/sell columns must use FinLab canonical institutional gross-flow columns',
)
assert(
  source.includes('export async function syncMarketBreadthFromFinLabCanonical') &&
    source.includes('INSERT INTO market_breadth') &&
    source.includes('FROM canonical_market_daily'),
  'FinLab canonical market rows must derive legacy market_breadth before official fallback',
)
assert(
  source.includes('export async function syncLegacyRevenueFromFinLabCanonical') &&
    source.includes('FROM canonical_revenue_monthly') &&
    source.includes('INSERT INTO monthly_revenue'),
  'FinLab canonical revenue rows must mirror into legacy monthly_revenue',
)
assert(
  source.includes('export async function syncLegacyFinancialsFromFinLabCanonical') &&
    source.includes('FROM canonical_fundamental_features') &&
    source.includes('INSERT INTO financials'),
  'FinLab canonical fundamentals must mirror into legacy financials',
)
assert(
  source.includes("TWSE/TPEX supplemental bulk fetch skipped") &&
    source.includes('source_role=${mirror.sourceRole}'),
  'bulk fetch should skip official supplemental writes once FinLab mirror readiness passes',
)
assert(
  source.includes("TWSE/TPEX supplemental bulk fetch skipped") &&
    source.includes('officialSupplementalFetchMode'),
  'bulk fetch must prefer FinLab mirror and honor official supplemental fetch mode before TWSE/TPEX fallback',
)

const bulkStart = source.indexOf('export async function runBulkFetch')
const bulkTwseImport = source.indexOf("await import('./twseApi')", bulkStart)
const bulkMirror = source.indexOf('syncLegacyMarketDataFromFinLabCanonical(env, twDate)', bulkStart)
assert(bulkStart >= 0 && bulkMirror > bulkStart, 'runBulkFetch must attempt FinLab mirror')
assert(
  bulkTwseImport < 0 || bulkMirror < bulkTwseImport,
  'runBulkFetch must attempt FinLab mirror before importing TWSE/TPEX official fetchers',
)

const marketCloseStart = source.indexOf('export async function runMarketCloseRefresh')
const marketCloseEnd = source.indexOf('export async function runDailyUpdate', marketCloseStart)
const marketCloseBody = source.slice(marketCloseStart, marketCloseEnd)
assert(
  marketCloseBody.includes('bulkFetchAndStorePrices') &&
    marketCloseBody.includes('fetchWave2Data(env, twDate, { finLabMirror: false })') &&
    !marketCloseBody.includes('syncLegacyMarketDataFromFinLabCanonical(env, twDate)') &&
    !marketCloseBody.includes('skipped_finlab_primary'),
  'market-close refresh must use official close-data refresh directly and must not attempt pre-backfill FinLab mirror',
)

const wave2Start = source.indexOf('export async function fetchWave2Data')
const wave2End = source.indexOf('async function refreshOfficialMarketSummaryIfMissing', wave2Start)
const wave2Body = source.slice(wave2Start, wave2End)
const wave2Breadth = source.indexOf('syncMarketBreadthFromFinLabCanonical(env, today)', wave2Start)
const wave2Revenue = source.indexOf('syncLegacyRevenueFromFinLabCanonical(env, today)', wave2Start)
const officialRevenue = source.indexOf('fetchTwseMonthlyRevenue()', wave2Start)
const wave2Financials = source.indexOf('syncLegacyFinancialsFromFinLabCanonical(env, today)', wave2Start)
const officialFinancials = source.indexOf('fetchTwseFinancials()', wave2Start)
assert(
  wave2Body.includes('const useFinLabMirror = options.finLabMirror !== false') &&
    wave2Body.includes('if (useFinLabMirror)') &&
    wave2Breadth > wave2Start,
  'Wave2 must keep FinLab breadth mirror behind an explicit finLabMirror gate',
)
assert(wave2Revenue > wave2Start && wave2Revenue < officialRevenue, 'Wave2 must mirror FinLab revenue before official revenue')
assert(wave2Financials > wave2Start && wave2Financials < officialFinancials, 'Wave2 must mirror FinLab financials before official financials')

console.log('finlabLegacyMirrorContract.test.ts passed')
