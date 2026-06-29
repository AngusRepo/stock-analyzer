import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

const routeLayer = [
  'src/routes/stocks.ts',
  'src/routes/other.ts',
].map((path) => ({ path, source: read(path) }))

for (const { path, source } of routeLayer) {
  assert(
    !/FROM\s+financials\b/i.test(source),
    `${path} must not query financials directly; use fundamentalData loader`,
  )
  assert(
    !/canonical_fundamental_features/i.test(source),
    `${path} must not query canonical_fundamental_features directly; use fundamentalData loader`,
  )
  assert(
    !/financials_summary/i.test(source),
    `${path} must not parse stock_profiles.financials_summary directly; use fundamentalData loader`,
  )
  assert(
    !/FROM\s+monthly_revenue\b/i.test(source),
    `${path} must not query monthly_revenue directly; use fundamentalData loader`,
  )
}

const fundamentalData = read('src/lib/fundamentalData.ts')
assert(
  /export async function loadStockFinancialRows/.test(fundamentalData),
  'fundamentalData loader must own stock financial row normalization',
)
assert(
  /export async function loadLatestStockFinancialSnapshot/.test(fundamentalData),
  'fundamentalData loader must expose latest stock financial snapshot',
)
assert(
  /export async function loadStockMonthlyRevenueRows/.test(fundamentalData),
  'fundamentalData loader must own monthly revenue normalization',
)
assert(
  /FROM\s+canonical_revenue_monthly\b/i.test(fundamentalData),
  'fundamentalData loader should read canonical_revenue_monthly for revenue snapshots',
)
