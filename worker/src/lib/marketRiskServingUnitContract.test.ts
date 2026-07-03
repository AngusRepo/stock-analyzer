import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const route = readFileSync('src/routes/other.ts', 'utf8')

assert(
  route.includes('10000.0 * COALESCE(value, 0)') &&
    route.includes(') / NULLIF(SUM(CASE') &&
    route.includes('THEN COALESCE(value, 0)'),
  'market risk liquidity spread must be turnover-weighted before falling back to a simple average',
)

assert(
  route.includes('100.0 * SUM(COALESCE(margin_balance, 0)) / NULLIF(SUM(COALESCE(margin_limit, 0)), 0)') &&
    route.includes('100.0 * SUM(COALESCE(short_balance, 0)) / NULLIF(SUM(COALESCE(short_limit, 0)), 0)'),
  'market risk chip pressure must use market-weighted credit usage ratios, not a simple average across symbols',
)

assert(
  route.includes('SUM(COALESCE(security_lending_sell_balance, 0)) / 1000.0 AS security_lending_sell_balance'),
  'market risk chip pressure must serve security lending sell balance in lots for the UI',
)

assert(
  route.includes("LOWER(COALESCE(stock_id, '')) NOT IN ('', 'nan', 'none', 'null')") &&
    route.includes("AND stock_id NOT LIKE '%.%'"),
  'market risk chip pressure must exclude invalid stock_id rows from market-wide sums',
)

assert(
    route.includes("SELECT 'dealer' AS participant_id") &&
    route.includes("UNION ALL SELECT 'trust'") &&
    route.includes("UNION ALL SELECT 'foreign'") &&
    route.includes('futuresInstitutionalBreakdown: futuresBreakdown') &&
    route.includes('previous_futures_inst_net_oi_lots') &&
    route.includes('netOiDeltaLots'),
  'market risk futures detail must scope TX rows and serve dealer/trust/foreign/total breakdown with OI delta',
)

assert(
  route.includes('AND date < (SELECT date FROM latest_date)'),
  'market risk world index change must not compare the latest date to itself when only one date is materialized',
)

assert(
  route.includes('derivePutCallOpenInterestRatio') &&
    route.includes('買賣權未平倉量比率') &&
    !route.includes("return derivedContextRow(ratio, '賣買權量比'"),
  'market risk Put/Call must use open-interest ratio instead of volume ratio for hedge sentiment',
)
