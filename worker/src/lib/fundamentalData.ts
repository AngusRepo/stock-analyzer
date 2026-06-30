export type FundamentalRowsOptions = {
  limit?: number
  asOf?: string | null
}

export type FundamentalSnapshot = Record<string, any>
export type MonthlyRevenueSnapshot = {
  date: string | null
  revenue: number | null
  revenue_mom: number | null
  revenue_yoy: number | null
  source: string | null
  as_of_date: string | null
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function firstFinite(rows: Record<string, any>[], key: string, opts: { skipZero?: boolean } = {}): number | null {
  for (const row of rows) {
    const value = finiteNumber(row[key])
    if (opts.skipZero && value === 0) continue
    if (value != null) return value
  }
  return null
}

function normalizePercentUnit(value: unknown, maxAbs = 300): number | null {
  const n = finiteNumber(value)
  if (n == null) return null
  const normalized = Math.abs(n) <= 1 ? n * 100 : n
  return Math.abs(normalized) > maxAbs ? null : normalized
}

function operatingMarginFromFinancial(row: Record<string, any> | null | undefined): number | null {
  const revenue = finiteNumber(row?.revenue)
  const operatingIncome = finiteNumber(row?.operating_income)
  if (revenue == null || operatingIncome == null || revenue === 0) return null
  return (operatingIncome / revenue) * 100
}

function netProfitMarginFromFinancial(row: Record<string, any> | null | undefined): number | null {
  const revenue = finiteNumber(row?.revenue)
  const netIncome = finiteNumber(row?.net_income)
  if (revenue == null || netIncome == null || revenue === 0) return null
  return (netIncome / revenue) * 100
}

function normalizeQuarterPeriod(period: unknown): string {
  const raw = String(period ?? '').trim()
  const quarterMatch = raw.match(/^(\d{4})Q([1-4])$/i)
  if (quarterMatch) return `${quarterMatch[1]}Q${quarterMatch[2]}`
  const dateMatch = raw.match(/^(\d{4})-(\d{2})-\d{2}$/)
  if (!dateMatch) return raw
  const month = Number(dateMatch[2])
  if (!Number.isFinite(month) || month < 1 || month > 12) return raw
  return `${dateMatch[1]}Q${Math.floor((month - 1) / 3) + 1}`
}

function buildEpsTrend(
  financialRows: Record<string, any>[],
  canonicalRows: Record<string, any>[],
  limit: number,
): Array<{ period: string; eps: number; source: string }> {
  const byPeriod = new Map<string, { period: string; eps: number; source: string }>()
  const add = (row: Record<string, any>, source: string) => {
    const period = normalizeQuarterPeriod(row.period)
    const eps = finiteNumber(row.eps)
    if (!period || eps == null) return
    if (!byPeriod.has(period)) byPeriod.set(period, { period, eps, source })
  }
  for (const row of financialRows) add(row, 'financials')
  for (const row of canonicalRows) add(row, 'canonical_fundamental_features')
  return [...byPeriod.values()]
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, limit)
}

function firstMarkdownMetricValue(lines: unknown, label: string): number | null {
  if (!Array.isArray(lines)) return null
  const line = lines.find((item) => typeof item === 'string' && item.includes(label))
  if (typeof line !== 'string') return null
  const cells = line
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean)
  for (const cell of cells.slice(1)) {
    const value = finiteNumber(cell.replace(/,/g, ''))
    if (value != null) return value
  }
  return null
}

function extractProfileMargins(raw: unknown): { grossMargin: number | null; operatingMargin: number | null; source: string | null } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { grossMargin: null, operatingMargin: null, source: null }
  }
  try {
    const parsed = JSON.parse(raw)
    for (const key of ['quarterly', 'annual']) {
      const grossMargin = normalizePercentUnit(firstMarkdownMetricValue(parsed?.[key], 'Gross Margin'), 100)
      const operatingMargin = normalizePercentUnit(firstMarkdownMetricValue(parsed?.[key], 'Operating Margin'), 100)
      if (grossMargin != null || operatingMargin != null) {
        return {
          grossMargin,
          operatingMargin,
          source: `stock_profiles.financials_summary.${key}`,
        }
      }
    }
  } catch {
    return { grossMargin: null, operatingMargin: null, source: null }
  }
  return { grossMargin: null, operatingMargin: null, source: null }
}

function buildCanonicalQuery(db: D1Database, symbol: string, asOfDate: string | null) {
  const base = `
      SELECT period, gross_margin, operating_margin, roe, eps, pe, pb,
             dividend_yield, debt_ratio, current_ratio, operating_cash_flow,
             roa, free_cash_flow, capital_amount, common_stock_capital,
             preferred_stock_capital, total_assets, total_liabilities,
             equity_parent, source, available_date, as_of_date
        FROM canonical_fundamental_features
       WHERE stock_id = ?
  `
  if (asOfDate) {
    return db.prepare(`${base}
         AND (available_date IS NULL OR available_date <= ?)
       ORDER BY available_date DESC, period DESC, as_of_date DESC
       LIMIT 180
    `).bind(symbol, asOfDate)
  }
  return db.prepare(`${base}
       ORDER BY available_date DESC, period DESC, as_of_date DESC
       LIMIT 180
    `).bind(symbol)
}

async function loadStockSymbol(db: D1Database, stockId: number): Promise<string | null> {
  const stock = await db.prepare('SELECT id, symbol FROM stocks WHERE id=?').bind(stockId).first<any>()
  const symbol = String(stock?.symbol ?? '').trim()
  return symbol || null
}

function buildCanonicalRevenueQuery(db: D1Database, symbol: string, limit: number, asOfDate: string | null) {
  const asOfMonth = asOfDate ? asOfDate.slice(0, 7) : null
  const base = `
      SELECT revenue_month AS date,
             revenue,
             mom AS revenue_mom,
             yoy AS revenue_yoy,
             source,
             as_of_date
        FROM canonical_revenue_monthly
       WHERE stock_id = ?
  `
  if (asOfMonth) {
    return db.prepare(`${base}
         AND revenue_month <= ?
       ORDER BY revenue_month DESC, as_of_date DESC
       LIMIT ?
    `).bind(symbol, asOfMonth, limit)
  }
  return db.prepare(`${base}
       ORDER BY revenue_month DESC, as_of_date DESC
       LIMIT ?
    `).bind(symbol, limit)
}

export async function loadStockMonthlyRevenueRows(
  db: D1Database,
  stockId: number,
  options: { months?: number; asOf?: string | null } = {},
): Promise<MonthlyRevenueSnapshot[]> {
  const limit = Math.max(1, Number(options.months ?? 12) || 12)
  const asOfDate = options.asOf && /^\d{4}-\d{2}-\d{2}$/.test(options.asOf) ? options.asOf : null
  const symbol = await loadStockSymbol(db, stockId)
  if (!symbol) return []
  const result = await buildCanonicalRevenueQuery(db, symbol, limit, asOfDate)
    .all<MonthlyRevenueSnapshot>()
    .catch(() => ({ results: [] as MonthlyRevenueSnapshot[] }))
  return result.results ?? []
}

export async function loadStockFinancialRows(
  db: D1Database,
  stockId: number,
  options: FundamentalRowsOptions = {},
): Promise<FundamentalSnapshot[]> {
  const limit = Math.max(1, Number(options.limit ?? 12) || 12)
  const asOfDate = options.asOf && /^\d{4}-\d{2}-\d{2}$/.test(options.asOf) ? options.asOf : null

  const symbol = await loadStockSymbol(db, stockId)
  if (!symbol) return []

  const [financialResult, canonicalResult, revenueRow, epsTrendResult, profileRow] = await Promise.all([
    db.prepare(
      'SELECT * FROM financials WHERE stock_id=? ORDER BY period DESC LIMIT ?',
    ).bind(stockId, limit).all<any>(),
    buildCanonicalQuery(db, symbol, asOfDate).all<any>().catch(() => ({ results: [] as any[] })),
    loadStockMonthlyRevenueRows(db, stockId, { months: 1, asOf: asOfDate }).then((rows) => rows[0] ?? null),
    db.prepare(
      "SELECT period, eps FROM financials WHERE stock_id=? AND eps IS NOT NULL AND period LIKE '%Q%' ORDER BY period DESC LIMIT 4",
    ).bind(stockId).all<any>().catch(() => ({ results: [] as any[] })),
    db.prepare(
      'SELECT financials_summary FROM stock_profiles WHERE symbol=? LIMIT 1',
    ).bind(symbol).first<any>().catch(() => null),
  ])

  const financialRows = financialResult.results ?? []
  const canonicalRows = canonicalResult.results ?? []
  const canonicalPe = firstFinite(canonicalRows, 'pe', { skipZero: true })
  const canonicalPb = firstFinite(canonicalRows, 'pb', { skipZero: true })
  const canonicalDividendYield = normalizePercentUnit(firstFinite(canonicalRows, 'dividend_yield'), 30)
  const canonicalRoe = firstFinite(canonicalRows, 'roe', { skipZero: true })
  const canonicalEps = firstFinite(canonicalRows, 'eps', { skipZero: true })
  const profileMargins = extractProfileMargins(profileRow?.financials_summary)
  const canonicalGrossMargin = normalizePercentUnit(firstFinite(canonicalRows, 'gross_margin', { skipZero: true }), 100)
  const canonicalOperatingMargin = normalizePercentUnit(firstFinite(canonicalRows, 'operating_margin', { skipZero: true }), 100)
  const canonicalCapitalAmount = firstFinite(canonicalRows, 'capital_amount', { skipZero: true })
  const grossMarginFallback = canonicalGrossMargin ?? profileMargins.grossMargin
  const operatingMarginFallback = canonicalOperatingMargin ?? profileMargins.operatingMargin
  const capitalSource = canonicalCapitalAmount != null
    ? 'finlab.fundamental_factor_diversity.capital_amount'
    : null
  const canonicalValuationSource = canonicalRows.find((row: any) => (
    row.pe != null || row.pb != null || row.dividend_yield != null
  ))?.source ?? null
  const epsTrend = buildEpsTrend(epsTrendResult.results ?? [], canonicalRows, 4)

  const baseRows = financialRows.length
    ? financialRows
    : [{
        stock_id: stockId,
        period: canonicalRows[0]?.period ?? revenueRow?.date ?? null,
        eps: null,
        roe: null,
        pe: null,
        pb: null,
        dividend_yield: null,
        revenue_growth_yoy: null,
        revenue: null,
        operating_income: null,
        net_income: null,
      }]

  return baseRows.map((row: any, index: number) => {
    const operatingMargin = operatingMarginFallback ?? operatingMarginFromFinancial(row)
    const netProfitMargin = netProfitMarginFromFinancial(row)
    return {
      ...row,
      eps: index === 0 ? (row.eps ?? canonicalEps ?? null) : row.eps,
      roe: index === 0 ? normalizePercentUnit(row.roe ?? canonicalRoe) : normalizePercentUnit(row.roe),
      pe: index === 0 ? (canonicalPe ?? row.pe ?? null) : row.pe,
      pb: index === 0 ? (canonicalPb ?? row.pb ?? null) : row.pb,
      dividend_yield: index === 0
        ? (canonicalDividendYield ?? normalizePercentUnit(row.dividend_yield, 30))
        : normalizePercentUnit(row.dividend_yield, 30),
      gross_margin: grossMarginFallback,
      operating_margin: operatingMargin,
      net_profit_margin: netProfitMargin,
      revenue_mom: finiteNumber(revenueRow?.revenue_mom),
      revenue_yoy: finiteNumber(revenueRow?.revenue_yoy ?? row.revenue_growth_yoy),
      revenue_month: revenueRow?.date ?? null,
      revenue_as_of: asOfDate,
      eps_trend: epsTrend,
      capital_amount: canonicalCapitalAmount,
      capital_source: capitalSource,
      fundamental_source: {
        quarterly: 'financials',
        valuation: canonicalValuationSource ?? 'financials',
        net_profit_margin: netProfitMargin == null ? null : 'financials.net_income/revenue',
        monthly_revenue: revenueRow ? 'canonical_revenue_monthly' : null,
        profile: profileMargins.source,
        capital: capitalSource,
      },
      missing_fields: {
        gross_margin: grossMarginFallback == null,
        capital_amount: canonicalCapitalAmount == null,
      },
    }
  })
}

export async function loadLatestStockFinancialSnapshot(
  db: D1Database,
  stockId: number,
  options: Pick<FundamentalRowsOptions, 'asOf'> = {},
): Promise<FundamentalSnapshot | null> {
  const rows = await loadStockFinancialRows(db, stockId, { limit: 8, asOf: options.asOf })
  return rows[0] ?? null
}

export function toLlmFinancialContext(row: FundamentalSnapshot | null | undefined) {
  if (!row) return null
  const revenueGrowthPct = finiteNumber(row.revenue_yoy ?? row.revenue_growth_yoy)
  return {
    eps: finiteNumber(row.eps),
    pe: finiteNumber(row.pe),
    pb: finiteNumber(row.pb),
    roe: finiteNumber(row.roe),
    dividendYield: finiteNumber(row.dividend_yield),
    revenueGrowth: revenueGrowthPct == null ? null : revenueGrowthPct / 100,
  }
}
