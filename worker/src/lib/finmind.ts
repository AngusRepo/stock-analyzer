/**
 * finmind.ts — FinMind API v4 client
 * 文件：https://finmind.github.io/
 * 免費額度：600 req/hr（需 token），300 req/hr（無 token）
 *
 * 台股資料涵蓋：股價、三大法人、融資券、財報、EPS、殖利率
 * 美股：FinMind 有 US stock price，但本專案美股仍走 Yahoo（較穩定）
 */

const BASE = 'https://api.finmindtrade.com/api/v4/data'

// ─── 通用請求 ──────────────────────────────────────────────────────────────────
async function fm<T = any>(
  token: string,
  dataset: string,
  params: Record<string, string>,
): Promise<T[]> {
  const qs = new URLSearchParams({ dataset, ...params })
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res = await fetch(`${BASE}?${qs}`, { headers })

  // 402 = 付費額度用完 → fallback 不帶 token（免費 300 req/hr）
  if (res.status === 402 && token) {
    console.warn(`[FinMind] ${dataset} 402 → fallback without token`)
    const fallbackHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
    res = await fetch(`${BASE}?${qs}`, { headers: fallbackHeaders })
  }

  if (!res.ok) throw new Error(`FinMind ${dataset} HTTP ${res.status}`)

  const json = await res.json() as any
  if (json.status !== 200) throw new Error(`FinMind ${dataset}: ${json.msg}`)
  return json.data ?? []
}

// ─── 1. 台股每日股價  TaiwanStockPrice ────────────────────────────────────────
export interface FMStockPrice {
  date: string        // "2024-01-02"
  stock_id: string    // "2330"
  Trading_Volume: number
  Trading_money: number
  open: number
  max: number         // high
  min: number         // low
  close: number
  spread: number      // 漲跌
  Trading_turnover: number
}

export async function fetchTWPrice(
  token: string, stockId: string, startDate: string,
): Promise<FMStockPrice[]> {
  return fm<FMStockPrice>(token, 'TaiwanStockPrice', {
    data_id: stockId,
    start_date: startDate,
  })
}

// ─── 2. 三大法人買賣  TaiwanStockInstitutionalInvestorsBuySell ────────────────
export interface FMChip {
  date: string
  stock_id: string
  name: string        // 外資、投信、自營商
  buy: number
  sell: number
}

export async function fetchTWChips(
  token: string, stockId: string, startDate: string,
): Promise<FMChip[]> {
  return fm<FMChip>(token, 'TaiwanStockInstitutionalInvestorsBuySell', {
    data_id: stockId,
    start_date: startDate,
  })
}

// ─── 3. 融資融券  TaiwanStockMarginPurchaseShortSale ─────────────────────────
export interface FMMargin {
  date: string
  stock_id: string
  MarginPurchaseBuy: number         // 融資買入
  MarginPurchaseSell: number        // 融資賣出
  MarginPurchaseCashRepayment: number
  MarginPurchaseYesterdayBalance: number
  MarginPurchaseTodayBalance: number  // 融資餘額
  ShortSaleBuy: number
  ShortSaleSell: number             // 融券賣出
  ShortSaleCashRepayment: number
  ShortSaleYesterdayBalance: number
  ShortSaleTodayBalance: number     // 融券餘額
}

export async function fetchTWMargin(
  token: string, stockId: string, startDate: string,
): Promise<FMMargin[]> {
  return fm<FMMargin>(token, 'TaiwanStockMarginPurchaseShortSale', {
    data_id: stockId,
    start_date: startDate,
  })
}

// ─── 4. 綜合損益表  TaiwanStockFinancialStatements ───────────────────────────
export interface FMFinancial {
  date: string        // "2024-Q1" style
  stock_id: string
  type: string        // 綜合損益
  value: number
  origin_name: string // 欄位名稱（每股盈餘、營業收入...）
}

export async function fetchTWFinancials(
  token: string, stockId: string, startDate: string,
): Promise<FMFinancial[]> {
  return fm<FMFinancial>(token, 'TaiwanStockFinancialStatements', {
    data_id: stockId,
    start_date: startDate,
  })
}

// ─── 5. 股利政策表  TaiwanStockDividend ──────────────────────────────────────
export interface FMDividend {
  date: string
  stock_id: string
  StockEarningsDistribution: number   // 股票股利
  StockStatutoryReserveTransfer: number
  StockCapitalReserveTransfer: number
  StockTotal: number
  CashEarningsDistribution: number    // 現金股利
  CashStatutoryReserveTransfer: number
  CashCapitalReserveTransfer: number
  CashTotal: number                   // 現金股利合計（用於殖利率）
  CashDividendYield: number           // 殖利率 %
}

export async function fetchTWDividend(
  token: string, stockId: string,
): Promise<FMDividend[]> {
  // 取近3年
  const startDate = new Date(Date.now() - 3 * 365 * 86400000).toISOString().split('T')[0]
  return fm<FMDividend>(token, 'TaiwanStockDividend', {
    data_id: stockId,
    start_date: startDate,
  })
}

// ─── 6. PER/PBR/殖利率 TaiwanStockPER ────────────────────────────────────────
export interface FMPER {
  date: string
  stock_id: string
  PER: number        // 本益比
  PBR: number        // 股價淨值比
  dividend_yield: number  // 殖利率 %
}

export async function fetchTWPER(
  token: string, stockId: string, startDate: string,
): Promise<FMPER[]> {
  return fm<FMPER>(token, 'TaiwanStockPER', {
    data_id: stockId,
    start_date: startDate,
  })
}

// ─── 7. 即時報價（用於警報）TaiwanStockPriceAdj ──────────────────────────────
export async function fetchTWCurrentPrice(
  token: string, stockId: string,
): Promise<number | null> {
  try {
    // 取最近1天股價
    const yesterday = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0]
    const rows = await fetchTWPrice(token, stockId, yesterday)
    if (!rows.length) return null
    return rows[rows.length - 1].close
  } catch {
    return null
  }
}

// ─── Bulk API：全市場批次抓取（不帶 data_id → 回傳所有股票）─────────────────

/** 全市場股價（不帶 stock_id） */
export async function fetchBulkTWPrice(
  token: string, startDate: string, endDate: string,
): Promise<FMStockPrice[]> {
  return fm<FMStockPrice>(token, 'TaiwanStockPrice', {
    start_date: startDate,
    end_date: endDate,
  })
}

/** 全市場三大法人買賣（不帶 stock_id） */
export async function fetchBulkTWChips(
  token: string, startDate: string, endDate: string,
): Promise<FMChip[]> {
  return fm<FMChip>(token, 'TaiwanStockInstitutionalInvestorsBuySell', {
    start_date: startDate,
    end_date: endDate,
  })
}

/** 台股基本資訊（股票代號、名稱、產業別） */
export interface FMStockInfo {
  stock_id: string
  stock_name: string
  industry_category: string
  type: string          // 'twse' | 'otc'
  date: string
}

export async function fetchTWStockInfo(
  token: string,
): Promise<FMStockInfo[]> {
  return fm<FMStockInfo>(token, 'TaiwanStockInfo', {})
}

// ─── 8. 分點資料（券商買賣）TaiwanStockSecuritiesLending ────────────────────
// Phase 5: 主力波動指標 — Top 15 買/賣比的 10 日均值/標準差
export interface FMBrokerTransaction {
  date: string
  stock_id: string
  broker_id: string
  broker_name: string
  buy: number
  sell: number
}

export async function fetchTWBrokerTransaction(
  token: string, stockId: string, startDate: string,
): Promise<FMBrokerTransaction[]> {
  // FinMind dataset: TaiwanStockSecuritiesLending（借券）或
  // TaiwanStockWarrantTradingDailyReport 不適合
  // 正確: TaiwanStockTradingDailyReport（個股分點資料）
  // 注意：此 API 可能需要 VIP 帳號，免費帳號可能受限
  try {
    return await fm<FMBrokerTransaction>(token, 'TaiwanStockTradingDailyReport', {
      data_id: stockId,
      start_date: startDate,
    })
  } catch {
    // Fallback: 如果 API 不可用，回傳空陣列
    return []
  }
}

/**
 * 計算主力波動指標（FinLab 獨家方法）
 * Buy/Sell Ratio = Top 15 券商買 / Top 15 券商賣
 * 主力波動 = 10日 ratio 均值 / 10日 ratio 標準差
 * 高值 + 低波動 = 主力穩定吸籌
 */
export function calcBrokerVolatilityIndex(rows: FMBrokerTransaction[]): {
  latestRatio: number | null
  ratio10dMean: number | null
  ratio10dStd: number | null
  brokerVolIndex: number | null  // mean/std，越高=主力越穩定
} {
  if (!rows.length) return { latestRatio: null, ratio10dMean: null, ratio10dStd: null, brokerVolIndex: null }

  // 按日期分組
  const byDate: Record<string, FMBrokerTransaction[]> = {}
  for (const r of rows) {
    if (!byDate[r.date]) byDate[r.date] = []
    byDate[r.date].push(r)
  }

  const dates = Object.keys(byDate).sort()
  const ratios: number[] = []

  for (const d of dates) {
    const dayRows = byDate[d]
    // 排序找 top 15 買方 和 top 15 賣方
    const sorted = [...dayRows].sort((a, b) => b.buy - a.buy)
    const top15Buy = sorted.slice(0, 15).reduce((s, r) => s + r.buy, 0)
    const sortedSell = [...dayRows].sort((a, b) => b.sell - a.sell)
    const top15Sell = sortedSell.slice(0, 15).reduce((s, r) => s + r.sell, 0)

    const ratio = top15Sell > 0 ? top15Buy / top15Sell : 1.0
    ratios.push(ratio)
  }

  if (ratios.length < 2) return { latestRatio: ratios[0] ?? null, ratio10dMean: null, ratio10dStd: null, brokerVolIndex: null }

  const recent10 = ratios.slice(-10)
  const mean = recent10.reduce((a, b) => a + b, 0) / recent10.length
  const variance = recent10.reduce((a, r) => a + (r - mean) ** 2, 0) / recent10.length
  const std = Math.sqrt(variance)

  return {
    latestRatio: Math.round(ratios[ratios.length - 1] * 1000) / 1000,
    ratio10dMean: Math.round(mean * 1000) / 1000,
    ratio10dStd: Math.round(std * 1000) / 1000,
    brokerVolIndex: std > 0 ? Math.round((mean / std) * 1000) / 1000 : null,
  }
}

// ─── 月營收 TaiwanStockMonthRevenue ──────────────────────────────────────────

export interface FMMonthlyRevenue {
  date: string          // "2026-02-01"
  stock_id: string      // "2330"
  country: string
  revenue: number       // 當月營收（千元）
  revenue_month: number // 月份
  revenue_year: number  // 年份
}

export async function fetchTWMonthlyRevenue(
  token: string, stockId: string, startDate: string,
): Promise<FMMonthlyRevenue[]> {
  return fm<FMMonthlyRevenue>(token, 'TaiwanStockMonthRevenue', {
    data_id: stockId,
    start_date: startDate,
  })
}

/** 批次抓全市場月營收（不指定 stock_id） */
export async function fetchBulkMonthlyRevenue(
  token: string, date: string,
): Promise<FMMonthlyRevenue[]> {
  return fm<FMMonthlyRevenue>(token, 'TaiwanStockMonthRevenue', {
    start_date: date,
  })
}

// ─── 大盤廣度：漲跌家數 TaiwanStockStatisticsOfOrderBookAndTrade ────────────

export interface FMMarketBreadth {
  date: string
  AdvanceCount: number       // 上漲家數
  DeclineCount: number       // 下跌家數
  UnchangedCount: number     // 平盤家數
  TradingVolume: number      // 成交量
  TradingValue: number       // 成交金額
}

// ─── 集保餘額 TaiwanStockShareholding ────────────────────────────────────────

export interface FMShareholding {
  date: string
  stock_id: string
  HoldingSharesLevel: string    // 持股級距 "1-999", "1000-5000", etc.
  people: number                // 人數
  percent: number               // 占比 %
  unit: number                  // 股數
}

export async function fetchTWShareholding(
  token: string, stockId: string, startDate: string,
): Promise<FMShareholding[]> {
  return fm<FMShareholding>(token, 'TaiwanStockShareholding', {
    data_id: stockId,
    start_date: startDate,
  })
}

export async function fetchTWMarketBreadth(
  token: string, startDate: string,
): Promise<FMMarketBreadth[]> {
  return fm<FMMarketBreadth>(token, 'TaiwanStockStatisticsOfOrderBookAndTrade', {
    start_date: startDate,
  })
}

// ─── 輔助：轉換三大法人資料為每日 net buy ────────────────────────────────────
export function aggregateChips(rows: FMChip[]): Record<string, {
  foreign_net: number; trust_net: number; dealer_net: number
}> {
  const map: Record<string, { foreign_net: number; trust_net: number; dealer_net: number }> = {}

  for (const r of rows) {
    if (!map[r.date]) map[r.date] = { foreign_net: 0, trust_net: 0, dealer_net: 0 }
    const net = r.buy - r.sell
    const n = r.name
    // FinMind v4 英文名稱：Foreign_Investor, Foreign_Dealer_Self, Investment_Trust, Dealer_self, Dealer_Hedging
    // 外資 = Foreign_Investor + Foreign_Dealer_Self
    if (n === 'Foreign_Investor' || n === 'Foreign_Dealer_Self' || n.includes('外資'))
      map[r.date].foreign_net += net
    // 投信
    else if (n === 'Investment_Trust' || n.includes('投信'))
      map[r.date].trust_net += net
    // 自營商 = Dealer_self + Dealer_Hedging
    else if (n === 'Dealer_self' || n === 'Dealer_Hedging' || n.includes('自營'))
      map[r.date].dealer_net += net
  }
  return map
}

// ─── 輔助：從財報陣列提取最近一季關鍵指標 ───────────────────────────────────
export function parseFinancials(rows: FMFinancial[], dividends: FMDividend[]) {
  // 找最新期別
  const dates = [...new Set(rows.map(r => r.date))].sort().reverse()
  if (!dates.length) return null

  const latest = dates[0]
  const period = rows.filter(r => r.date === latest)

  const get = (name: string) =>
    period.find(r => r.origin_name.includes(name))?.value ?? null

  const eps     = get('每股盈餘') ?? get('基本每股盈餘')
  const revenue = get('營業收入')

  // 上一期同期對比（YoY）
  const prevDate = dates.find(d => d.slice(0, 4) < latest.slice(0, 4))
  let revenueGrowthYoy: number | null = null
  if (prevDate && revenue) {
    const prevRevenue = rows
      .filter(r => r.date === prevDate && r.origin_name.includes('營業收入'))
      .find(Boolean)?.value
    if (prevRevenue) revenueGrowthYoy = (revenue - prevRevenue) / Math.abs(prevRevenue)
  }

  // 股利
  const latestDiv = dividends.sort((a, b) => b.date.localeCompare(a.date))[0]
  const dividendYield      = latestDiv?.CashDividendYield ?? null
  const dividendPerShare   = latestDiv?.CashTotal ?? null

  const roe = get('股東權益報酬率') ?? get('ROE')
  const bookValuePerShare = get('每股淨值') ?? get('每股參考淨值')

  return {
    period: latest,
    eps,
    revenue,
    revenueGrowthYoy,
    dividendYield,
    dividendPerShare,
    roe,
    bookValuePerShare,
  }
}
