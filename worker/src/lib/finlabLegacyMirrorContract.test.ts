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
  source.includes('FROM canonical_market_daily c') &&
    source.includes('INSERT INTO stock_prices'),
  'FinLab canonical market rows must mirror into legacy stock_prices serving table',
)
assert(
  source.includes('COALESCE(c.adj_close, c.close)'),
  'legacy stock_prices.adj_close must use FinLab canonical adj_close when available',
)
assert(
  source.includes('c.avg_price'),
  'legacy stock_prices.avg_price must use FinLab canonical avg_price when available',
)
assert(
  source.includes('FROM canonical_chip_daily c') &&
    source.includes('INSERT INTO chip_data') &&
    source.includes('INSERT INTO margin_data'),
  'FinLab canonical chip rows must mirror into legacy chip_data and margin_data serving tables',
)
assert(
  source.includes('MAX(c.foreign_buy)') &&
    source.includes('MAX(c.trust_buy)') &&
    source.includes('MAX(c.dealer_buy)'),
  'legacy chip_data buy/sell columns must use FinLab canonical institutional gross-flow columns',
)
assert(
  source.includes('export async function syncMarketBreadthFromFinLabCanonical') &&
    source.includes('INSERT INTO market_breadth') &&
    source.includes('FROM canonical_market_daily c'),
  'FinLab canonical market rows must derive legacy market_breadth before official fallback',
)
assert(
  source.includes('export async function syncLegacyRevenueFromFinLabCanonical') &&
    source.includes('FROM canonical_revenue_monthly r') &&
    source.includes('INSERT INTO monthly_revenue'),
  'FinLab canonical revenue rows must mirror into legacy monthly_revenue',
)
assert(
  source.includes('export async function syncLegacyFinancialsFromFinLabCanonical') &&
    source.includes('FROM canonical_fundamental_features f') &&
    source.includes('INSERT INTO financials'),
  'FinLab canonical fundamentals must mirror into legacy financials',
)
assert(
  source.includes("TWSE/TPEX supplemental bulk fetch skipped") &&
    source.includes('source_role=${mirror.sourceRole}'),
  'bulk fetch should skip official supplemental writes once FinLab mirror readiness passes',
)
assert(
  source.includes('finlab_probe_mirror=') &&
    source.includes('official_supplemental_fetch=disabled'),
  'source-readiness probe must retry FinLab mirror and honor disabled official supplemental fetch mode before TWSE/TPEX fallback',
)

const bulkStart = source.indexOf('export async function runBulkFetch')
const bulkTwseImport = source.indexOf("await import('./twseApi')", bulkStart)
const bulkMirror = source.indexOf('syncLegacyMarketDataFromFinLabCanonical(env.DB, twDate)', bulkStart)
assert(bulkStart >= 0 && bulkMirror > bulkStart, 'runBulkFetch must attempt FinLab mirror')
assert(
  bulkTwseImport < 0 || bulkMirror < bulkTwseImport,
  'runBulkFetch must attempt FinLab mirror before importing TWSE/TPEX official fetchers',
)

const marketCloseStart = source.indexOf('export async function runMarketCloseRefresh')
const marketCloseMirror = source.indexOf('syncLegacyMarketDataFromFinLabCanonical(env.DB, twDate)', marketCloseStart)
const marketCloseOfficial = source.indexOf('bulkFetchAndStorePrices', marketCloseStart)
assert(marketCloseMirror > marketCloseStart, 'market-close refresh must attempt FinLab mirror')
assert(
  marketCloseOfficial < 0 || marketCloseMirror < marketCloseOfficial,
  'market-close refresh must attempt FinLab mirror before official price fetch',
)

const wave2Start = source.indexOf('export async function fetchWave2Data')
const wave2Breadth = source.indexOf('syncMarketBreadthFromFinLabCanonical(env.DB, today)', wave2Start)
const officialBreadth = source.indexOf('fetchMarketBreadth()', wave2Start)
const wave2Revenue = source.indexOf('syncLegacyRevenueFromFinLabCanonical(env.DB, today)', wave2Start)
const officialRevenue = source.indexOf('fetchTwseMonthlyRevenue()', wave2Start)
const wave2Financials = source.indexOf('syncLegacyFinancialsFromFinLabCanonical(env.DB, today)', wave2Start)
const officialFinancials = source.indexOf('fetchTwseFinancials()', wave2Start)
assert(wave2Breadth > wave2Start && wave2Breadth < officialBreadth, 'Wave2 must derive breadth from FinLab before official breadth')
assert(wave2Revenue > wave2Start && wave2Revenue < officialRevenue, 'Wave2 must mirror FinLab revenue before official revenue')
assert(wave2Financials > wave2Start && wave2Financials < officialFinancials, 'Wave2 must mirror FinLab financials before official financials')

const readinessStart = source.indexOf('export async function runSourceReadinessProbe')
const readinessFinlabProbe = source.indexOf('syncLegacyMarketDataFromFinLabCanonical(env.DB, twDate)', readinessStart)
const readinessOfficialImport = source.indexOf("await import('./twseApi')", readinessStart)
assert(readinessFinlabProbe > readinessStart, 'source-readiness probe must retry FinLab supplemental mirror')
assert(
  readinessOfficialImport < 0 || readinessFinlabProbe < readinessOfficialImport,
  'source-readiness probe must retry FinLab mirror before importing official TWSE/TPEX fetchers',
)

console.log('finlabLegacyMirrorContract.test.ts passed')
