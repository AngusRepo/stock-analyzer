/**
 * twseApi.ts — TWSE/TPEX 官方 API bulk fetcher
 *
 * 替代 FinMind 逐股 API：一次 request 取全市場資料
 * - 三大法人: TWSE T86 + TPEX 3itrade
 * - 融資融券: TWSE MI_MARGN + TPEX openapi margin_balance
 *
 * 全部免費、無配額限制。
 */

// ─── Retry wrapper ───────────────────────────────────────────────────────────
async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: { maxRetries?: number; baseDelay?: number; label?: string } = {},
): Promise<Response> {
  const { maxRetries = 3, baseDelay = 2000, label = url.slice(0, 60) } = opts
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init)
      if (res.status === 429 || res.status === 503) {
        if (attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1)
          console.warn(`[twseApi] ${label} → ${res.status}, retry ${attempt}/${maxRetries} in ${delay}ms`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }
      }
      return res
    } catch (e: any) {
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1)
        console.warn(`[twseApi] ${label} → ${e.message ?? e}, retry ${attempt}/${maxRetries} in ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
      } else {
        throw e
      }
    }
  }
  throw new Error(`[twseApi] ${label} → max retries exceeded`)
}

const TWSE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
export const MIN_TWSE_BULK_PRICE_ROWS = 900
export const MIN_TPEX_BULK_PRICE_ROWS = 700

type TpexStockDayAllOptions = {
  date?: string
  minRows?: number
  maxReadinessAttempts?: number
  readinessDelayMs?: number
  fetcher?: typeof fetchWithRetry
  fallbackFetcher?: typeof fetchWithRetry
}

async function fetchTpexStockDayAllViaController(
  date: string,
  controllerUrl?: string,
  controllerSecret?: string,
): Promise<StockDayAllRow[]> {
  if (!controllerUrl) return []
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (controllerSecret) headers['X-Controller-Token'] = controllerSecret
  const res = await fetch(`${controllerUrl}/tpex-prices`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ date }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`Controller /tpex-prices HTTP ${res.status}`)
  const data = await res.json() as any
  const rows = Array.isArray(data?.prices) ? data.prices : []
  return rows
    .filter((r: any) => isCommonStockCode(String(r?.symbol ?? '')))
    .map((r: any) => ({
      symbol: String(r.symbol).trim(),
      open: typeof r.open === 'number' ? r.open : null,
      high: typeof r.high === 'number' ? r.high : null,
      low: typeof r.low === 'number' ? r.low : null,
      close: typeof r.close === 'number' ? r.close : null,
      volume: typeof r.volume === 'number' ? r.volume : null,
      avg_price: typeof r.avg_price === 'number' ? r.avg_price : null,
    }))
}

async function fetchTwseStockDayAllViaController(
  date: string,
  controllerUrl?: string,
  controllerSecret?: string,
): Promise<{ reportDate: string | null; rows: StockDayAllRow[] }> {
  if (!controllerUrl) return { reportDate: null, rows: [] }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (controllerSecret) headers['X-Controller-Token'] = controllerSecret
  const res = await fetch(`${controllerUrl}/twse-prices`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ date }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) throw new Error(`Controller /twse-prices HTTP ${res.status}`)
  const data = await res.json() as any
  const rows = Array.isArray(data?.prices) ? data.prices : []
  return {
    reportDate: typeof data?.report_date === 'string' ? data.report_date : null,
    rows: rows
      .filter((r: any) => isCommonStockCode(String(r?.symbol ?? '')))
      .map((r: any) => ({
        symbol: String(r.symbol).trim(),
        open: typeof r.open === 'number' ? r.open : null,
        high: typeof r.high === 'number' ? r.high : null,
        low: typeof r.low === 'number' ? r.low : null,
        close: typeof r.close === 'number' ? r.close : null,
        volume: typeof r.volume === 'number' ? r.volume : null,
      })),
  }
}

export function assertBulkPriceSourceReady(input: {
  date: string
  twseRows: number
  tpexRows: number
  twseOk: boolean
  tpexOk: boolean
}): void {
  const problems: string[] = []
  if (!input.twseOk) problems.push('TWSE source failed')
  if (!input.tpexOk) problems.push('TPEX source failed')
  if (input.twseRows < MIN_TWSE_BULK_PRICE_ROWS) {
    problems.push(`TWSE price rows=${input.twseRows}/${MIN_TWSE_BULK_PRICE_ROWS}`)
  }
  if (input.tpexRows < MIN_TPEX_BULK_PRICE_ROWS) {
    problems.push(`TPEX price rows=${input.tpexRows}/${MIN_TPEX_BULK_PRICE_ROWS}`)
  }
  if (problems.length > 0) {
    throw new Error(`Bulk price source incomplete for ${input.date}: ${problems.join('; ')}`)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseTwNum(s: string): number {
  if (!s || s.trim() === '' || s.trim() === '-' || s.trim() === '--') return 0
  return parseInt(s.replace(/,/g, '').trim()) || 0
}

function twseDate(isoDate: string): string {
  return isoDate.replace(/-/g, '')
}

function rocDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-')
  return `${parseInt(y) - 1911}/${m}/${d}`
}

function rocCompactDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-')
  return `${parseInt(y) - 1911}${m}${d}`
}

function isStockCode(s: string): boolean {
  return /^\d{4,6}$/.test(s.trim())
}

function isCommonStockCode(s: string): boolean {
  return /^\d{4}$/.test(s.trim())
}

function parseOpenApiArray(text: string): any[] {
  const normalized = text.replace(/^\uFEFF/, '').trimStart()
  if (!normalized.startsWith('[')) return []
  const body = JSON.parse(normalized)
  return Array.isArray(body) ? body : []
}

function parseJsonObject(text: string): any {
  const normalized = text.replace(/^\uFEFF/, '').trimStart()
  if (!normalized.startsWith('{')) return {}
  return JSON.parse(normalized)
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (ch === ',' && !quoted) {
      fields.push(current)
      current = ''
      continue
    }
    current += ch
  }
  fields.push(current)
  return fields.map(v => v.trim())
}

function parseTwFloat(value: string | null | undefined): number | null {
  const text = String(value ?? '').replace(/,/g, '').trim()
  if (!text || text === '--') return null
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : null
}

function parseTwseReportDateValue(value: string | null | undefined): string | null {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (/^\d{8}$/.test(digits)) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
  }
  if (/^\d{7}$/.test(digits)) {
    const year = Number(digits.slice(0, 3)) + 1911
    return `${year}-${digits.slice(3, 5)}-${digits.slice(5, 7)}`
  }
  return null
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BulkChipRow {
  symbol: string
  foreign_buy: number   // 股
  foreign_sell: number
  foreign_net: number
  trust_buy: number
  trust_sell: number
  trust_net: number
  dealer_buy: number
  dealer_sell: number
  dealer_net: number
}

export function parseTwseChipRows(rows: string[][]): BulkChipRow[] {
  return rows
    .filter((r: string[]) => isStockCode(r[0]))
    .map((r: string[]) => ({
      symbol: r[0].trim(),
      foreign_buy:  parseTwNum(r[2]),
      foreign_sell: parseTwNum(r[3]),
      foreign_net:  parseTwNum(r[4]),
      trust_buy:    parseTwNum(r[8]),
      trust_sell:   parseTwNum(r[9]),
      trust_net:    parseTwNum(r[10]),
      dealer_buy:   parseTwNum(r[12]) + parseTwNum(r[15]),
      dealer_sell:  parseTwNum(r[13]) + parseTwNum(r[16]),
      dealer_net:   parseTwNum(r[11]),
    }))
}

export function parseTpexChipRows(rows: string[][]): BulkChipRow[] {
  return rows
    .filter((r: string[]) => isStockCode(r[0]))
    .map((r: string[]) => ({
      symbol: r[0].trim(),
      foreign_buy:  parseTwNum(r[2]),
      foreign_sell: parseTwNum(r[3]),
      foreign_net:  parseTwNum(r[4]),
      trust_buy:    parseTwNum(r[11]),
      trust_sell:   parseTwNum(r[12]),
      trust_net:    parseTwNum(r[13]),
      dealer_buy:   parseTwNum(r[20]),
      dealer_sell:  parseTwNum(r[21]),
      dealer_net:   parseTwNum(r[22]),
    }))
}

export interface BulkMarginRow {
  symbol: string
  margin_balance: number    // 融資今日餘額（張）
  short_balance: number     // 融券今日餘額（張）
  margin_buy: number
  margin_sell: number
  short_buy: number
  short_sell: number
}

// ─── 除權除息預告 ─────────────────────────────────────────────────────────────

export interface ExDividendRow {
  symbol: string
  ex_date: string     // ISO date
  type: 'cash' | 'stock' | 'both'
  cash_dividend: number | null
  stock_dividend: number | null
}

export async function fetchExDividendForecast(): Promise<ExDividendRow[]> {
  const fetchTwse = async (): Promise<ExDividendRow[]> => {
    try {
      const res = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/TWT48U', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return []
      const body = await res.json() as any[]
      if (!Array.isArray(body)) return []
      return body
        .filter(r => isStockCode(r['證券代號'] ?? ''))
        .map(r => {
          const typeStr = (r['除權息類別'] ?? '').trim()
          const hasCash = typeStr.includes('息')
          const hasStock = typeStr.includes('權')
          const type: 'cash' | 'stock' | 'both' = hasCash && hasStock ? 'both' : hasStock ? 'stock' : 'cash'
          const rawDate = (r['除權息日期'] ?? '').trim()  // 民國 "115/04/10" or "1150410"
          let exDate = ''
          if (rawDate.includes('/')) {
            const parts = rawDate.split('/')
            const y = parseInt(parts[0]) + 1911
            exDate = `${y}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`
          } else if (rawDate.length >= 7) {
            const y = parseInt(rawDate.slice(0, 3)) + 1911
            exDate = `${y}-${rawDate.slice(3, 5)}-${rawDate.slice(5, 7)}`
          }
          const cashDiv = r['現金股利'] ? parseFloat(String(r['現金股利']).replace(/,/g, '')) || null : null
          const stockDiv = r['無償配股率'] ? parseFloat(String(r['無償配股率']).replace(/,/g, '')) || null : null
          return {
            symbol: (r['證券代號'] ?? '').trim(),
            ex_date: exDate,
            type,
            cash_dividend: cashDiv,
            stock_dividend: stockDiv,
          }
        })
        .filter(r => r.ex_date)
    } catch (e) {
      console.warn('[ExDiv] TWSE fetch failed:', e)
      return []
    }
  }

  const fetchTpex = async (): Promise<ExDividendRow[]> => {
    try {
      const res = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_ex_dividend_forecast', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return []
      const text = await res.text()
      if (!text.startsWith('[')) return []
      const body = JSON.parse(text) as any[]
      if (!Array.isArray(body)) return []
      return body
        .filter(r => isStockCode(r.SecuritiesCompanyCode ?? r['證券代號'] ?? ''))
        .map(r => {
          const sym = (r.SecuritiesCompanyCode ?? r['證券代號'] ?? '').trim()
          const typeStr = (r.ExDividendType ?? r['除權息類別'] ?? '').trim()
          const hasCash = typeStr.includes('息') || typeStr.toLowerCase().includes('cash')
          const hasStock = typeStr.includes('權') || typeStr.toLowerCase().includes('stock')
          const type: 'cash' | 'stock' | 'both' = hasCash && hasStock ? 'both' : hasStock ? 'stock' : 'cash'
          const rawDate = (r.ExDividendDate ?? r['除權息日期'] ?? '').trim()
          let exDate = ''
          if (rawDate.includes('/')) {
            const parts = rawDate.split('/')
            const y = parseInt(parts[0]) + 1911
            exDate = `${y}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`
          } else if (rawDate.length >= 7) {
            const y = parseInt(rawDate.slice(0, 3)) + 1911
            exDate = `${y}-${rawDate.slice(3, 5)}-${rawDate.slice(5, 7)}`
          }
          const cashDiv = r.CashDividend ?? r['現金股利']
          const stockDiv = r.StockDividend ?? r['無償配股率']
          return {
            symbol: sym,
            ex_date: exDate,
            type,
            cash_dividend: cashDiv ? parseFloat(String(cashDiv).replace(/,/g, '')) || null : null,
            stock_dividend: stockDiv ? parseFloat(String(stockDiv).replace(/,/g, '')) || null : null,
          }
        })
        .filter(r => r.ex_date)
    } catch (e) {
      console.warn('[ExDiv] TPEX fetch failed:', e)
      return []
    }
  }

  const [twse, tpex] = await Promise.allSettled([fetchTwse(), fetchTpex()])
  return [
    ...(twse.status === 'fulfilled' ? twse.value : []),
    ...(tpex.status === 'fulfilled' ? tpex.value : []),
  ]
}

// ─── TWSE 處置股 + 注意股 ────────────────────────────────────────────────────

export async function fetchAttentionStocks(): Promise<string[]> {
  try {
    const res = await fetch('https://www.twse.com.tw/rwd/zh/announcement/notice?response=json', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const body = await res.json() as any
    if (body.stat !== 'OK' || !body.data) return []
    // data: [序號, 日期, 代號, 名稱, ...]
    return body.data
      .map((r: any[]) => String(r[2]).trim())
      .filter((s: string) => isStockCode(s))
  } catch (e) {
    console.warn('[Attention] TWSE fetch failed:', e)
    return []
  }
}

export async function fetchPunishedStocks(): Promise<string[]> {
  const res = await fetch('https://www.twse.com.tw/rwd/zh/announcement/punish?response=json', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return []
  const body = await res.json() as any
  if (body.stat !== 'OK' || !body.data) return []
  // data: [序號, 日期, 代號, 名稱, ...]
  return body.data
    .map((r: any[]) => String(r[2]).trim())
    .filter((s: string) => /^\d{4,6}$/.test(s))
}

// ─── TWSE 當沖標的 ──────────────────────────────────────────────────────────

export async function fetchDayTradeEligible(): Promise<string[]> {
  try {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '')
    const url = `https://www.twse.com.tw/exchangeReport/TWTB4U?response=json&date=${today}&selectType=All`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const body = await res.json() as any
    if (body.stat !== 'OK' || !body.tables?.[1]?.data) return []
    // tables[1].data: [證券代號, 證券名稱, 暫停註記, ...]
    return body.tables[1].data
      .map((r: any[]) => String(r[0]).trim())
      .filter((s: string) => /^\d{4,6}$/.test(s))
  } catch (e) {
    console.warn('[DayTrade] TWSE TWTB4U fetch failed:', e)
    return []
  }
}

// ─── TWSE PER/PBR/殖利率（全市場）────────────────────────────────────────────

export interface BulkValuationRow {
  symbol: string
  dividend_yield: number | null
  pe: number | null
  pb: number | null
}

export async function fetchTwseValuation(date: string): Promise<BulkValuationRow[]> {
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_ALL?date=${twseDate(date)}&response=json`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) return []
  const body = await res.json() as any
  if (body.stat !== 'OK' || !body.data) return []
  // [代號, 名稱, 殖利率, PER, PBR]
  return body.data
    .filter((r: string[]) => isStockCode(r[0]))
    .map((r: string[]) => ({
      symbol: r[0].trim(),
      dividend_yield: r[2] && r[2] !== '-' ? parseFloat(r[2]) : null,
      pe: r[3] && r[3] !== '-' ? parseFloat(r[3]) : null,
      pb: r[4] && r[4] !== '-' ? parseFloat(r[4]) : null,
    }))
}

// ─── TWSE 月營收（opendata）──────────────────────────────────────────────────

export interface MonthlyRevenueRow {
  symbol: string
  year_month: string     // "2026-02"
  revenue: number        // 千元
  revenue_yoy: number | null  // %
  revenue_mom: number | null  // %
}

export async function fetchTwseMonthlyRevenue(): Promise<MonthlyRevenueRow[]> {
  const res = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap05_L', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) return []
  const body = await res.json() as any[]
  if (!Array.isArray(body)) return []

  return body
    .filter(r => isStockCode(r['公司代號'] ?? ''))
    .map(r => {
      const ym = r['資料年月'] ?? ''  // "11502" (民國年月)
      const rocYear = parseInt(ym.slice(0, -2)) || 0
      const month = parseInt(ym.slice(-2)) || 0
      const isoYM = rocYear > 0 ? `${rocYear + 1911}-${String(month).padStart(2, '0')}` : ''
      const rev = parseInt((r['營業收入-當月營收'] ?? '0').replace(/,/g, '')) || 0
      const prevRev = parseInt((r['營業收入-上月營收'] ?? '0').replace(/,/g, '')) || 0
      const lastYearRev = parseInt((r['營業收入-去年當月營收'] ?? '0').replace(/,/g, '')) || 0
      return {
        symbol: (r['公司代號'] ?? '').trim(),
        year_month: isoYM,
        revenue: rev,
        revenue_yoy: lastYearRev > 0 ? (rev - lastYearRev) / lastYearRev * 100 : null,
        revenue_mom: prevRev > 0 ? (rev - prevRev) / prevRev * 100 : null,
      }
    })
    .filter(r => r.year_month)
}

// ─── TPEX 月營收（openapi）────────────────────────────────────────────────────

export async function fetchTpexMonthlyRevenue(): Promise<MonthlyRevenueRow[]> {
  const res = await fetch('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) return []
  const text = await res.text()
  if (!text.startsWith('[')) return []
  const body = JSON.parse(text) as any[]
  if (!Array.isArray(body)) return []

  return body
    .filter(r => isStockCode(r['公司代號'] ?? ''))
    .map(r => {
      const ym = r['資料年月'] ?? ''
      const rocYear = parseInt(ym.slice(0, -2)) || 0
      const month = parseInt(ym.slice(-2)) || 0
      const isoYM = rocYear > 0 ? `${rocYear + 1911}-${String(month).padStart(2, '0')}` : ''
      const rev = parseInt((r['營業收入-當月營收'] ?? '0').toString().replace(/,/g, '')) || 0
      const prevRev = parseInt((r['營業收入-上月營收'] ?? '0').toString().replace(/,/g, '')) || 0
      const lastYearRev = parseInt((r['營業收入-去年當月營收'] ?? '0').toString().replace(/,/g, '')) || 0
      return {
        symbol: (r['公司代號'] ?? '').trim(),
        year_month: isoYM,
        revenue: rev,
        revenue_yoy: lastYearRev > 0 ? (rev - lastYearRev) / lastYearRev * 100 : null,
        revenue_mom: prevRev > 0 ? (rev - prevRev) / prevRev * 100 : null,
      }
    })
    .filter(r => r.year_month)
}

// ─── TPEX 財報（openapi EPS + ROE）─────────────────────────────────────────

export async function fetchTpexFinancials(): Promise<BulkFinancialRow[]> {
  const incomeUrls = [
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O',     // 一般業
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_Obasi', // 金融業
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_Oins',  // 保險業
  ]
  const bsUrls = [
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap07_O',
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap07_Obasi',
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap07_Oins',
  ]

  const fetchJson = async (url: string) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) return []
      const text = await res.text()
      if (!text.startsWith('[')) return []
      return JSON.parse(text) as any[]
    } catch { return [] }
  }

  const [incomeResults, bsResults] = await Promise.all([
    Promise.all(incomeUrls.map(fetchJson)),
    Promise.all(bsUrls.map(fetchJson)),
  ])

  const incomeRows = incomeResults.flat()
  const bsRows = bsResults.flat()

  const bsMap = new Map<string, { equity: number; total_assets: number | null; total_liabilities: number | null }>()
  for (const r of bsRows) {
    const sym = (r['公司代號'] ?? '').trim()
    if (!isStockCode(sym)) continue
    const keys = Object.keys(r)
    const equity = parseInt((r['權益總額'] ?? '0').toString().replace(/,/g, '')) || 0
    const taKey = keys.find(k => k === '資產總計' || k === '資產總額')
    const totalAssets = taKey ? (parseFloat((r[taKey] ?? '0').toString().replace(/,/g, '')) || null) : null
    const tlKey = keys.find(k => k === '負債總計' || k === '負債總額')
    const totalLiabilities = tlKey ? (parseFloat((r[tlKey] ?? '0').toString().replace(/,/g, '')) || null) : null
    if (equity > 0) bsMap.set(sym, { equity, total_assets: totalAssets, total_liabilities: totalLiabilities })
  }

  const results: BulkFinancialRow[] = []
  for (const r of incomeRows) {
    const sym = (r['公司代號'] ?? '').trim()
    if (!isStockCode(sym)) continue

    const rocYear = parseInt(r['年度'] ?? '0') || 0
    const quarter = (r['季別'] ?? '').trim()
    const year = rocYear > 0 ? String(rocYear + 1911) : ''
    if (!year || !quarter) continue

    const keys = Object.keys(r)
    const epsKey = keys.find(k => k.includes('每股') && k.includes('盈餘')) ?? keys[keys.length - 1]
    const eps = parseFloat(r[epsKey] ?? '0') || null

    const revenueKey = keys.find(k => k === '營業收入' || (k.includes('營業') && k.includes('收入')))
    const revenue = revenueKey ? (parseFloat((r[revenueKey] ?? '0').toString().replace(/,/g, '')) || null) : null

    const opIncKey = keys.find(k => k === '營業利益' || (k.includes('營業') && k.includes('利益')) || (k.includes('營業') && k.includes('淨利')))
    const operatingIncome = opIncKey ? (parseFloat((r[opIncKey] ?? '0').toString().replace(/,/g, '')) || null) : null

    const netIncomeKey = keys.find(k => (k.includes('本期') && k.includes('淨利')) || (k.includes('稅後') && k.includes('淨利')))
    const netIncome = netIncomeKey ? (parseFloat((r[netIncomeKey] ?? '0').toString().replace(/,/g, '')) || null) : null

    const bs = bsMap.get(sym)
    const equity = bs?.equity ?? null
    const roe = netIncome && equity && equity > 0 ? (netIncome / equity * 100) : null

    results.push({
      symbol: sym, year, quarter, eps, revenue,
      operating_income: operatingIncome,
      net_income: netIncome,
      total_assets: bs?.total_assets ?? null,
      total_liabilities: bs?.total_liabilities ?? null,
      equity, roe: roe ? Math.round(roe * 100) / 100 : null,
    })
  }

  return results
}

// ─── TPEX PER/PBR/殖利率（全市場）────────────────────────────────────────────

export async function fetchTpexValuation(): Promise<BulkValuationRow[]> {
  const res = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) return []
  const text = await res.text()
  if (!text.startsWith('[')) return []
  const body = JSON.parse(text) as any[]
  if (!Array.isArray(body)) return []

  return body
    .filter(r => isStockCode(r.SecuritiesCompanyCode ?? ''))
    .map(r => ({
      symbol: (r.SecuritiesCompanyCode ?? '').trim(),
      dividend_yield: r.DividendYield ? parseFloat(r.DividendYield) || null : null,
      pe: r.PriceEarningRatio ? parseFloat(r.PriceEarningRatio) || null : null,
      pb: r.PriceBookRatio ? parseFloat(r.PriceBookRatio) || null : null,
    }))
}

// ─── TWSE 大盤廣度（漲跌家數）───────────────────────────────────────────────

export interface MarketBreadthData {
  date: string
  advance_count: number
  decline_count: number
  unchanged_count: number
  advance_ratio: number
}

export async function fetchMarketBreadth(): Promise<MarketBreadthData | null> {
  const res = await fetch('https://openapi.twse.com.tw/v1/opendata/twtazu_od', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return null
  const body = await res.json() as any[]
  if (!Array.isArray(body) || !body.length) return null

  // 找上市(非興櫃)那筆
  const row = body.find((r: any) => (r['市場'] ?? '').includes('上市')) ?? body[0]
  const adv = parseInt(row['上漲'] ?? '0') || 0
  const dec = parseInt(row['下跌'] ?? '0') || 0
  const unc = parseInt(row['持平'] ?? '0') || 0
  const total = adv + dec + unc
  const rocDate = (row['出表日期'] ?? '').trim()  // "1150324"
  const y = parseInt(rocDate.slice(0, 3)) + 1911
  const m = rocDate.slice(3, 5)
  const d = rocDate.slice(5, 7)
  return {
    date: `${y}-${m}-${d}`,
    advance_count: adv,
    decline_count: dec,
    unchanged_count: unc,
    advance_ratio: total > 0 ? adv / total : 0.5,
  }
}

// ─── TWSE 財報（EPS + ROE，替代 FinMind）─────────────────────────────────────

export interface BulkFinancialRow {
  symbol: string
  year: string          // 西元年
  quarter: string       // "1"~"4"
  eps: number | null
  revenue: number | null            // 千元
  operating_income: number | null   // 千元 — 營業利益
  net_income: number | null         // 千元 — 本期淨利（算 ROE 用）
  total_assets: number | null       // 千元 — 資產總計
  total_liabilities: number | null  // 千元 — 負債總計
  equity: number | null             // 千元（算 ROE 用）
  roe: number | null                // %
}

export async function fetchTwseFinancials(): Promise<BulkFinancialRow[]> {
  // 並行抓損益表 + 資產負債表（一般業 + 金融業 + 保險業）
  const incomeUrls = [
    'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci',   // 一般業
    'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_basi', // 金融業
    'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ins',  // 保險業
    'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_fh',   // 金控業
  ]
  const bsUrls = [
    'https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ci',
    'https://openapi.twse.com.tw/v1/opendata/t187ap07_L_basi',
    'https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ins',
    'https://openapi.twse.com.tw/v1/opendata/t187ap07_L_fh',
  ]

  const fetchJson = async (url: string) => {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) return []
      return await res.json() as any[]
    } catch { return [] }
  }

  const [incomeResults, bsResults] = await Promise.all([
    Promise.all(incomeUrls.map(fetchJson)),
    Promise.all(bsUrls.map(fetchJson)),
  ])

  const incomeRows = incomeResults.flat()
  const bsRows = bsResults.flat()

  // 資產負債表 → symbol → { equity, total_assets, total_liabilities }
  const bsMap = new Map<string, { equity: number; total_assets: number | null; total_liabilities: number | null }>()
  for (const r of bsRows) {
    const sym = (r['公司代號'] ?? '').trim()
    if (!isStockCode(sym)) continue
    const keys = Object.keys(r)
    const equity = parseInt((r['權益總額'] ?? '0').toString().replace(/,/g, '')) || 0
    // 資產總計
    const taKey = keys.find(k => k === '資產總計' || k === '資產總額')
    const totalAssets = taKey ? (parseFloat((r[taKey] ?? '0').toString().replace(/,/g, '')) || null) : null
    // 負債總計
    const tlKey = keys.find(k => k === '負債總計' || k === '負債總額')
    const totalLiabilities = tlKey ? (parseFloat((r[tlKey] ?? '0').toString().replace(/,/g, '')) || null) : null
    if (equity > 0) bsMap.set(sym, { equity, total_assets: totalAssets, total_liabilities: totalLiabilities })
  }

  // 損益表 → EPS + revenue + operating_income + net_income
  const results: BulkFinancialRow[] = []
  for (const r of incomeRows) {
    const sym = (r['公司代號'] ?? '').trim()
    if (!isStockCode(sym)) continue

    const rocYear = parseInt(r['年度'] ?? '0') || 0
    const quarter = (r['季別'] ?? '').trim()
    const year = rocYear > 0 ? String(rocYear + 1911) : ''
    if (!year || !quarter) continue

    // 最後一個 key 通常是 EPS（基本每股盈餘）
    const keys = Object.keys(r)
    const epsKey = keys.find(k => k.includes('每股') && k.includes('盈餘')) ?? keys[keys.length - 1]
    const eps = parseFloat(r[epsKey] ?? '0') || null

    const revenueKey = keys.find(k => k === '營業收入' || (k.includes('營業') && k.includes('收入')))
    const revenue = revenueKey ? (parseFloat((r[revenueKey] ?? '0').toString().replace(/,/g, '')) || null) : null

    // 營業利益
    const opIncKey = keys.find(k => k === '營業利益' || (k.includes('營業') && k.includes('利益')) || (k.includes('營業') && k.includes('淨利')))
    const operatingIncome = opIncKey ? (parseFloat((r[opIncKey] ?? '0').toString().replace(/,/g, '')) || null) : null

    const netIncomeKey = keys.find(k => (k.includes('本期') && k.includes('淨利')) || (k.includes('稅後') && k.includes('淨利')))
    const netIncome = netIncomeKey ? (parseFloat((r[netIncomeKey] ?? '0').toString().replace(/,/g, '')) || null) : null

    const bs = bsMap.get(sym)
    const equity = bs?.equity ?? null
    const roe = netIncome && equity && equity > 0 ? (netIncome / equity * 100) : null

    results.push({
      symbol: sym, year, quarter, eps, revenue,
      operating_income: operatingIncome,
      net_income: netIncome,
      total_assets: bs?.total_assets ?? null,
      total_liabilities: bs?.total_liabilities ?? null,
      equity, roe: roe ? Math.round(roe * 100) / 100 : null,
    })
  }

  return results
}

// ─── TWSE T86: 上市三大法人 ──────────────────────────────────────────────────

export async function fetchTwseChips(date: string): Promise<BulkChipRow[]> {
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${twseDate(date)}&selectType=ALL&response=json`
  const res = await fetchWithRetry(url, {
    headers: TWSE_HEADERS,
    signal: AbortSignal.timeout(30000),
  }, { label: 'TWSE_T86' })
  if (!res.ok) throw new Error(`TWSE T86 HTTP ${res.status}`)
  const body = await res.json() as any
  if (body.stat !== 'OK' || !body.data) return []
  return parseTwseChipRows(body.data)
}

// ─── TPEX 3itrade: 上櫃三大法人 ─────────────────────────────────────────────

export async function fetchTpexChips(date: string): Promise<BulkChipRow[]> {
  const url = `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&d=${rocDate(date)}&t=D&o=json`
  const res = await fetchWithRetry(url, {
    headers: TWSE_HEADERS,
    signal: AbortSignal.timeout(30000),
  }, { label: 'TPEX_3ITRADE' })
  if (!res.ok) throw new Error(`TPEX 3itrade HTTP ${res.status}`)
  const text = await res.text()
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
    throw new Error('TPEX returned HTML instead of JSON (data not ready)')
  }
  const body = JSON.parse(text) as any
  if (body.stat !== 'ok' || !body.tables?.[0]?.data) return []
  return parseTpexChipRows(body.tables[0].data)
}

// ─── TWSE MI_MARGN: 上市融資融券 ────────────────────────────────────────────

export async function fetchTwseMargin(date: string): Promise<BulkMarginRow[]> {
  const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${twseDate(date)}&selectType=ALL&response=json`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`TWSE MI_MARGN HTTP ${res.status}`)
  const body = await res.json() as any
  if (body.stat !== 'OK' || !body.tables?.[1]?.data) return []

  // tables[1] = 個股融資融券 (16 fields)
  // [0]代號 [1]名稱 [2]融資買 [3]融資賣 [4]融資現償 [5]前餘 [6]今餘 [7]限額
  // [8]融券買 [9]融券賣 [10]融券現償 [11]前餘 [12]今餘 [13]限額 [14]資券互抵
  return body.tables[1].data
    .filter((r: string[]) => isStockCode(r[0]))
    .map((r: string[]) => ({
      symbol: r[0].trim(),
      margin_buy:     parseTwNum(r[2]),
      margin_sell:    parseTwNum(r[3]),
      margin_balance: parseTwNum(r[6]),   // 融資今日餘額
      short_buy:      parseTwNum(r[8]),
      short_sell:     parseTwNum(r[9]),
      short_balance:  parseTwNum(r[12]),  // 融券今日餘額
    }))
}

// ─── TPEX Margin: 上櫃融資融券 ──────────────────────────────────────────────

export async function fetchTpexMargin(_date: string): Promise<BulkMarginRow[]> {
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance'
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`TPEX margin HTTP ${res.status}`)
  const text = await res.text()
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html') || !text.startsWith('[')) {
    throw new Error('TPEX margin returned non-JSON')
  }
  const body = JSON.parse(text) as any[]
  if (!Array.isArray(body)) return []

  return body
    .filter(r => isStockCode(r.SecuritiesCompanyCode ?? ''))
    .map(r => ({
      symbol: (r.SecuritiesCompanyCode ?? '').trim(),
      margin_buy:     parseInt(r.MarginPurchase ?? '0') || 0,
      margin_sell:    parseInt(r.MarginSales ?? '0') || 0,
      margin_balance: parseInt(r.MarginPurchaseBalance ?? '0') || 0,
      short_buy:      parseInt(r.ShortBuy ?? r.ShortCovering ?? '0') || 0,
      short_sell:     parseInt(r.ShortSale ?? '0') || 0,
      short_balance:  parseInt(r.ShortSaleBalance ?? '0') || 0,
    }))
}

// ─── Bulk fetch + write to D1 ───────────────────────────────────────────────

export async function bulkFetchAndStoreChipData(
  db: D1Database,
  date: string,
  controllerUrl?: string,
  controllerSecret?: string,
): Promise<{ chipCount: number; marginCount: number }> {
  console.log(`[BulkChip] Fetching TWSE/TPEX chips + margins for ${date}...`)

  // TWSE + TPEX 都擋 CF Workers IP → 全部透過 Controller proxy
  const viaController = async (endpoint: string): Promise<{ chips: BulkChipRow[]; margins: BulkMarginRow[] }> => {
    if (!controllerUrl) return { chips: [], margins: [] }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (controllerSecret) headers['X-Controller-Token'] = controllerSecret
    const res = await fetch(`${controllerUrl}/${endpoint}`, {
      method: 'POST', headers,
      body: JSON.stringify({ date }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) throw new Error(`Controller /${endpoint} HTTP ${res.status}`)
    const data = await res.json() as any
    const chips: BulkChipRow[] = (data.chips ?? []).map((c: any) => ({
      symbol: c.symbol, foreign_buy: c.foreign_buy, foreign_sell: c.foreign_sell,
      foreign_net: c.foreign_net, trust_buy: c.trust_buy, trust_sell: c.trust_sell,
      trust_net: c.trust_net, dealer_buy: c.dealer_buy, dealer_sell: c.dealer_sell,
      dealer_net: c.dealer_net,
    }))
    const margins: BulkMarginRow[] = (data.margins ?? []).map((m: any) => ({
      symbol: m.symbol, margin_buy: m.margin_buy, margin_sell: m.margin_sell,
      margin_balance: m.margin_balance, short_buy: m.short_buy,
      short_sell: m.short_sell, short_balance: m.short_balance,
    }))
    return { chips, margins }
  }

  const [twseResult, tpexResult] = await Promise.allSettled([
    viaController('twse-chips'),
    viaController('tpex-chips'),
  ])

  const twseChips = twseResult.status === 'fulfilled' ? twseResult.value.chips : []
  const twseMargin = twseResult.status === 'fulfilled' ? twseResult.value.margins : []
  const tpexChips = tpexResult.status === 'fulfilled' ? tpexResult.value.chips : []
  const tpexMargin = tpexResult.status === 'fulfilled' ? tpexResult.value.margins : []

  const allChips = [...twseChips, ...tpexChips]
  const allMargin = [...twseMargin, ...tpexMargin]

  if (twseResult.status === 'rejected') console.warn('[BulkChip] TWSE proxy failed:', twseResult.reason)
  if (tpexResult.status === 'rejected') console.warn('[BulkChip] TPEX proxy failed:', tpexResult.reason)

  console.log(`[BulkChip] Fetched: ${allChips.length} chips, ${allMargin.length} margins`)

  if (!allChips.length) return { chipCount: 0, marginCount: 0 }

  // Build margin lookup
  const marginMap = new Map(allMargin.map(m => [m.symbol, m]))

  // 批次寫入 chip_data（直接用 symbol，不需 idMap 過濾）
  // Schema 已改為 chip_data(symbol, date) — 不再依賴 stocks 表 FK
  const WRITE_BATCH = 50
  let chipCount = 0
  for (let i = 0; i < allChips.length; i += WRITE_BATCH) {
    const chunk = allChips.slice(i, i + WRITE_BATCH)
    const stmts = chunk.map(c => {
      const m = marginMap.get(c.symbol)
      return db.prepare(`
        INSERT OR REPLACE INTO chip_data
          (symbol, date, foreign_buy, foreign_sell, foreign_net,
           trust_buy, trust_sell, trust_net, dealer_buy, dealer_sell, dealer_net,
           margin_balance, short_balance)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).bind(
        c.symbol, date,
        c.foreign_buy, c.foreign_sell, c.foreign_net,
        c.trust_buy, c.trust_sell, c.trust_net,
        c.dealer_buy, c.dealer_sell, c.dealer_net,
        m?.margin_balance ?? null, m?.short_balance ?? null,
      )
    })
    if (stmts.length) {
      await db.batch(stmts)
      chipCount += stmts.length
    }
  }

  // 寫入 margin_data（仍用 stock_id FK，需要 idMap）
  const idMap = new Map<string, number>()
  const { results: allStocksRows } = await db.prepare('SELECT id, symbol FROM stocks').all<{ id: number; symbol: string }>()
  for (const r of allStocksRows ?? []) idMap.set(r.symbol, r.id)

  let marginCount = 0
  for (let i = 0; i < allMargin.length; i += WRITE_BATCH) {
    const chunk = allMargin.slice(i, i + WRITE_BATCH)
    const stmts = chunk
      .filter(m => idMap.has(m.symbol))
      .map(m => {
        const stockId = idMap.get(m.symbol)!
        const shortRatio = m.margin_balance > 0 ? m.short_balance / m.margin_balance : null
        return db.prepare(`
          INSERT INTO margin_data
            (stock_id, date, margin_buy, margin_sell, margin_balance,
             short_buy, short_sell, short_balance, short_ratio)
          VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(stock_id, date) DO UPDATE SET
            margin_buy=excluded.margin_buy, margin_sell=excluded.margin_sell,
            margin_balance=excluded.margin_balance,
            short_buy=excluded.short_buy, short_sell=excluded.short_sell,
            short_balance=excluded.short_balance, short_ratio=excluded.short_ratio
        `).bind(
          stockId, date,
          m.margin_buy, m.margin_sell, m.margin_balance,
          m.short_buy, m.short_sell, m.short_balance, shortRatio,
        )
      })
    if (stmts.length) {
      await db.batch(stmts)
      marginCount += stmts.length
    }
  }

  console.log(`[BulkChip] Written: ${chipCount} chip_data + ${marginCount} margin_data rows`)
  return { chipCount, marginCount }
}

// ─── TWSE STOCK_DAY_ALL: 全市場每日股價（替代 FinMind per-stock fetchTWPrice）──

export interface StockDayAllRow {
  symbol: string
  open:   number | null
  high:   number | null
  low:    number | null
  close:  number | null
  volume: number | null
  avg_price?: number | null  // 興櫃股的成交均價（漲跌幅基準）
}

/** TWSE 全市場今日收盤（含量）。非交易日或盤後未公布時回 []。*/
/**
 * 2026-04-09: return shape 從 `StockDayAllRow[]` 改 `{ reportDate, rows }`，解決 M3
 * stale data bug — TWSE 對盤前/假日 query 會回最近一個交易日的資料且 body.date 會帶正確
 * 的 report date。caller 原本把 request date 硬壓進 stock_prices 造成髒資料。
 * 現在 caller 必須用 reportDate（response 回的真實 date）做 INSERT 的 date 欄位。
 * body.date 格式是 "YYYYMMDD"，轉成 "YYYY-MM-DD"。
 */
export async function fetchTwseStockDayAll(
  date: string,
): Promise<{ reportDate: string | null; rows: StockDayAllRow[] }> {
  // 不帶 date → TWSE 回最新交易日；帶 date 指定特定日期
  const url = `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY_ALL?date=${twseDate(date)}&response=json`
  const res = await fetchWithRetry(url, {
    headers: TWSE_HEADERS,
    signal: AbortSignal.timeout(30000),
  }, { label: 'TWSE_STOCK_DAY_ALL' })
  if (!res.ok) return { reportDate: null, rows: [] }
  const text = await res.text()
  const body = parseJsonObject(text)
  if (body.stat !== 'OK' || !body.data) {
    const csv = parseTwseStockDayAllCsv(text, date)
    if (csv.rows.length > 0) return csv
    return { reportDate: null, rows: [] }
  }

  // Parse body.date "YYYYMMDD" → "YYYY-MM-DD"
  let reportDate: string | null = null
  if (typeof body.date === 'string' && /^\d{8}$/.test(body.date)) {
    reportDate = `${body.date.slice(0, 4)}-${body.date.slice(4, 6)}-${body.date.slice(6, 8)}`
    if (reportDate !== date) {
      console.warn(
        `[TWSE_STOCK_DAY_ALL] stale redirect: requested ${date} → got ${reportDate} ` +
        `(TWSE 通常對非交易日回最近一個交易日)`
      )
    }
  }

  // fields: [代號, 名稱, 成交股數, 成交金額, 開盤價, 最高價, 最低價, 收盤價, 漲跌價差, 成交筆數]
  const rows = body.data
    .filter((r: string[]) => isStockCode(r[0]))
    .map((r: string[]) => ({
      symbol: r[0].trim(),
      open:   r[4] && r[4] !== '--' ? parseFloat(r[4].replace(/,/g, '')) || null : null,
      high:   r[5] && r[5] !== '--' ? parseFloat(r[5].replace(/,/g, '')) || null : null,
      low:    r[6] && r[6] !== '--' ? parseFloat(r[6].replace(/,/g, '')) || null : null,
      close:  r[7] && r[7] !== '--' ? parseFloat(r[7].replace(/,/g, '')) || null : null,
      volume: r[2] ? parseTwNum(r[2]) : null,
    }))
  return { reportDate, rows }
}

/** TPEX 全市場今日收盤（openapi）*/
export function parseTwseStockDayAllCsv(
  text: string,
  requestedDate: string,
): { reportDate: string | null; rows: StockDayAllRow[] } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim().length > 0)
  let reportDate: string | null = null
  const rows: StockDayAllRow[] = []
  for (const line of lines) {
    const r = parseCsvLine(line)
    if (r.length < 9 || !isStockCode(r[1])) continue
    reportDate = reportDate ?? parseTwseReportDateValue(r[0])
    rows.push({
      symbol: r[1].trim(),
      open: parseTwFloat(r[5]),
      high: parseTwFloat(r[6]),
      low: parseTwFloat(r[7]),
      close: parseTwFloat(r[8]),
      volume: r[3] ? parseTwNum(r[3]) : null,
    })
  }
  if (reportDate && reportDate !== requestedDate) {
    console.warn(`[TWSE_STOCK_DAY_ALL] stale redirect: requested ${requestedDate} ??got ${reportDate}`)
  }
  return { reportDate, rows }
}

export function parseTpexDailyQuoteRows(body: any[]): StockDayAllRow[] {
  // fields vary, common keys: SecuritiesCompanyCode, Open, High, Low, Close, TradingShares
  return body
    .filter(r => isCommonStockCode(r.SecuritiesCompanyCode ?? r.Code ?? ''))
    .map(r => {
      const sym = (r.SecuritiesCompanyCode ?? r.Code ?? '').trim()
      const pf = (v: any) => v && v !== '--' ? parseFloat(String(v).replace(/,/g, '')) || null : null
      return {
        symbol: sym,
        open:   pf(r.Open ?? r.OpeningPrice),
        high:   pf(r.High ?? r.HighestPrice),
        low:    pf(r.Low  ?? r.LowestPrice),
        close:  pf(r.Close ?? r.ClosingPrice),
        volume: r.TradingShares ? parseTwNum(String(r.TradingShares)) : null,
      }
    })
}

export function parseTpexHistoricalDailyQuoteRows(body: any): StockDayAllRow[] {
  const tables = Array.isArray(body?.tables) ? body.tables : []
  const rows = tables.flatMap((table: any) => Array.isArray(table?.data) ? table.data : [])
  return rows
    .filter((r: any[]) => Array.isArray(r) && isCommonStockCode(String(r[0] ?? '')))
    .map((r: any[]) => {
      const pf = (v: any) => v && v !== '--' ? parseFloat(String(v).replace(/,/g, '')) || null : null
      return {
        symbol: String(r[0] ?? '').trim(),
        open: pf(r[4]),
        high: pf(r[5]),
        low: pf(r[6]),
        close: pf(r[2]),
        volume: r[8] ? parseTwNum(String(r[8])) : null,
        avg_price: pf(r[7]),
      }
    })
}

function tpexLatestBodyDate(body: any[]): string | null {
  const firstDated = body.find(row => typeof row?.Date === 'string' && /^\d{7}$/.test(row.Date))
  return firstDated?.Date ?? null
}

async function fetchTpexDateSpecificStockDayAll(
  date: string,
  fetcher: typeof fetchWithRetry,
): Promise<StockDayAllRow[]> {
  const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${date.replace(/-/g, '/')}`
  const res = await fetcher(url, {
    headers: TWSE_HEADERS,
    signal: AbortSignal.timeout(30000),
  }, { label: 'TPEX_DAILY_QUOTES_DATE_SPECIFIC' })
  if (!res.ok) return []
  const body = parseJsonObject(await res.text())
  const reportDate = typeof body?.date === 'string' ? body.date : null
  const requested = twseDate(date)
  if (reportDate && reportDate !== requested) {
    console.warn(`[TPEX_DAILY_QUOTES_DATE_SPECIFIC] stale response: requested ${requested}, got ${reportDate}`)
    return []
  }
  return parseTpexHistoricalDailyQuoteRows(body)
}

export async function fetchTpexStockDayAll(options: TpexStockDayAllOptions = {}): Promise<StockDayAllRow[]> {
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'
  const minRows = options.minRows ?? MIN_TPEX_BULK_PRICE_ROWS
  const maxAttempts = Math.max(1, options.maxReadinessAttempts ?? 4)
  const delayMs = Math.max(0, options.readinessDelayMs ?? 15_000)
  const fetcher = options.fetcher ?? fetchWithRetry
  const fallbackFetcher = options.fallbackFetcher ?? fetcher
  const expectedRocDate = options.date ? rocCompactDate(options.date) : null
  let lastRows: StockDayAllRow[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetcher(url, {
        headers: TWSE_HEADERS,
        signal: AbortSignal.timeout(30000),
      }, { label: 'TPEX_DAILY_QUOTES' })
      if (!res.ok) break
      const text = await res.text()
      const body = parseOpenApiArray(text)
      const bodyDate = tpexLatestBodyDate(body)
      lastRows = parseTpexDailyQuoteRows(body)
      if (expectedRocDate && bodyDate && bodyDate !== expectedRocDate) {
        console.warn(`[TPEX_DAILY_QUOTES] latest feed stale: requested ${expectedRocDate}, got ${bodyDate}; switching to date-specific fallback`)
        break
      }
      if (lastRows.length >= minRows) return lastRows
      if (attempt < maxAttempts) {
        console.warn(`[TPEX_DAILY_QUOTES] partial feed ${lastRows.length}/${minRows}, readiness retry ${attempt}/${maxAttempts}`)
        await new Promise(r => setTimeout(r, delayMs))
      }
    } catch (e) {
      console.warn(`[TPEX_DAILY_QUOTES] latest feed failed; switching to date-specific fallback: ${e instanceof Error ? e.message : String(e)}`)
      break
    }
  }

  if (options.date) {
    const fallbackRows = await fetchTpexDateSpecificStockDayAll(options.date, fallbackFetcher)
    if (fallbackRows.length >= minRows) return fallbackRows
    console.warn(`[TPEX_DAILY_QUOTES_DATE_SPECIFIC] incomplete fallback ${fallbackRows.length}/${minRows} for ${options.date}`)
    if (fallbackRows.length > lastRows.length) return fallbackRows
  }

  return lastRows
}

/** TPEX 興櫃每日行情（含均價 — 興櫃漲跌幅基準是前日均價，非收盤價）*/
export async function fetchEmergingStockDayAll(): Promise<StockDayAllRow[]> {
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics'
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) return []
  const text = await res.text()
  const body = parseOpenApiArray(text)
  return body
    .filter(r => isStockCode(r.SecuritiesCompanyCode ?? ''))
    .map(r => {
      const sym = (r.SecuritiesCompanyCode ?? '').trim()
      const pf = (v: any) => v && v !== '--' && v !== '' ? parseFloat(String(v).replace(/,/g, '')) || null : null
      return {
        symbol: sym,
        open:   null,  // 興櫃 API 無開盤價欄位
        high:   pf(r.Highest),
        low:    pf(r.Lowest),
        close:  pf(r.LatestPrice),
        volume: r.TransactionVolume ? parseTwNum(String(r.TransactionVolume)) : null,
        avg_price: pf(r.Average),  // 成交均價 — 隔日漲跌幅基準
      }
    })
}

/**
 * 每日股價 bulk 寫入（TWSE + TPEX；興櫃已退出 daily pipeline）
 * 在 runDailyUpdate 與 bulkFetchAndStoreChipData 同步呼叫。
 */
export async function bulkFetchAndStorePrices(
  db: D1Database,
  date: string,
  controllerUrl?: string,
  controllerSecret?: string,
): Promise<number> {
  const fetchTwseRows = async (): Promise<{ reportDate: string | null; rows: StockDayAllRow[] }> => {
    let direct: { reportDate: string | null; rows: StockDayAllRow[] } = { reportDate: null, rows: [] }
    try {
      direct = await fetchTwseStockDayAll(date)
      if (direct.rows.length >= MIN_TWSE_BULK_PRICE_ROWS) return direct
    } catch (e) {
      console.warn('[BulkPrice] TWSE direct fetch failed before controller proxy:', e)
    }

    try {
      const proxied = await fetchTwseStockDayAllViaController(date, controllerUrl, controllerSecret)
      if (proxied.rows.length > direct.rows.length) {
        console.warn(`[BulkPrice] TWSE controller proxy recovered ${proxied.rows.length} rows (direct=${direct.rows.length})`)
        return proxied
      }
    } catch (e) {
      console.warn('[BulkPrice] TWSE controller proxy failed:', e)
    }
    return direct
  }

  const fetchTpexRows = async (): Promise<StockDayAllRow[]> => {
    let directRows: StockDayAllRow[] = []
    try {
      directRows = await fetchTpexStockDayAll({ date })
      if (directRows.length >= MIN_TPEX_BULK_PRICE_ROWS) return directRows
    } catch (e) {
      console.warn('[BulkPrice] TPEX direct fetch failed before controller proxy:', e)
    }

    try {
      const proxiedRows = await fetchTpexStockDayAllViaController(date, controllerUrl, controllerSecret)
      if (proxiedRows.length > directRows.length) {
        console.warn(`[BulkPrice] TPEX controller proxy recovered ${proxiedRows.length} rows (direct=${directRows.length})`)
        return proxiedRows
      }
    } catch (e) {
      console.warn('[BulkPrice] TPEX controller proxy failed:', e)
    }
    return directRows
  }

  const [twseResult, tpexRows] = await Promise.allSettled([
    fetchTwseRows(),
    fetchTpexRows(),
  ])

  // 2026-04-09 M3 fix: TWSE 會對盤前/假日 redirect 到最近一個交易日。
  // 改用 reportDate（response 回的真實 date）做 INSERT 的 date，避免把 stale data
  // 硬壓成 request date 造成 stock_prices 髒資料。見 mistake.md M3。
  const twseRows = twseResult.status === 'fulfilled' ? twseResult.value.rows : []
  const twseReportDate = twseResult.status === 'fulfilled' ? twseResult.value.reportDate : null
  const effectiveDate = twseReportDate ?? date
  const tpexQuoteRows = tpexRows.status === 'fulfilled' ? tpexRows.value : []
  assertBulkPriceSourceReady({
    date: effectiveDate,
    twseRows: twseRows.length,
    tpexRows: tpexQuoteRows.length,
    twseOk: twseResult.status === 'fulfilled',
    tpexOk: tpexRows.status === 'fulfilled',
  })
  if (twseReportDate && twseReportDate !== date) {
    console.warn(
      `[BulkPrice] TWSE report date ${twseReportDate} ≠ requested ${date}; ` +
      `writing to stock_prices.date=${effectiveDate} to avoid stale pollution (M3)`
    )
  }

  const allRows: StockDayAllRow[] = [
    ...twseRows,
    ...tpexQuoteRows,
  ]
  if (twseResult.status === 'rejected') console.warn('[BulkPrice] TWSE STOCK_DAY_ALL failed:', twseResult.reason)
  if (tpexRows.status === 'rejected') console.warn('[BulkPrice] TPEX DayAll failed:', tpexRows.reason)

  const validRows = allRows.filter(r => r.close !== null)
  if (!validRows.length) { console.warn('[BulkPrice] No valid price rows'); return 0 }

  // symbol → stocks.id
  const { results: allStocks } = await db.prepare('SELECT id, symbol FROM stocks').all<{ id: number; symbol: string }>()
  const idMap = new Map<string, number>()
  for (const s of allStocks ?? []) idMap.set(s.symbol, s.id)

  const BATCH = 50
  let count = 0
  for (let i = 0; i < validRows.length; i += BATCH) {
    const stmts = validRows.slice(i, i + BATCH)
      .filter(r => idMap.has(r.symbol))
      .map(r => db.prepare(
        `INSERT OR REPLACE INTO stock_prices (stock_id, date, open, high, low, close, adj_close, volume, avg_price)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(idMap.get(r.symbol)!, effectiveDate, r.open, r.high, r.low, r.close, r.close, r.volume, r.avg_price ?? null))
    if (stmts.length) {
      await db.batch(stmts)
      count += stmts.length
    }
  }
  console.log(`[BulkPrice] Written: ${count} stock_prices rows to date=${effectiveDate} (TWSE ${twseRows.length} + TPEX ${tpexRows.status === 'fulfilled' ? tpexRows.value.length : 0}; emerging disabled)`)
  return count
}

// ── TWSE 官方產業代碼 → 中文名稱 ─────────────────────────────────────────────
// TWSE openapi t187ap03_L 回傳的 industry code（2026-04-02 用 sample stocks 逐一驗證）
// 驗證方式：每個 code 取前 5 支 symbol，查已知產業歸屬
const TWSE_INDUSTRY_MAP: Record<string, string> = {
  '01': '水泥工業',           // 1101台泥 1102亞泥
  '02': '食品工業',           // 1201味全 1203味王
  '03': '塑膠工業',           // 1301台塑 1303南亞
  '04': '紡織纖維',           // 1402遠東新 1409新纖
  '05': '電機機械',           // 1503士電 1504東元
  '06': '電器電纜',           // 1603華電 1605華新
  '08': '玻璃陶瓷',           // 1802台玻 1806冠軍
  '09': '造紙工業',           // 1903士紙 1904正隆
  '10': '鋼鐵工業',           // 2002中鋼 2006東和鋼鐵
  '11': '橡膠工業',           // 2101南港 2102泰豐
  '12': '汽車工業',           // 1319東陽 1521大億 1524耿鼎
  '14': '建材營造業',         // 1316上曜 1436華友聯
  '15': '航運業',             // 2603長榮 2605新興 2606裕民
  '16': '觀光餐旅',           // 2701萬企 2702華園
  '17': '金融保險業',         // 2801彰銀 2812台中銀 2886兆豐金
  '18': '貿易百貨業',         // 2601益航 2901欣欣 2903遠百
  '20': '其他電子業',         // 1342八貫 1416廣豐
  '21': '化學工業',           // 1708永記 1709和益 1710東聯
  '22': '生技醫療',           // 1707葡萄王 1720生達 1731美吾華
  '23': '油電燃氣業',         // 6505台塑化 9908大台北 9918欣天然
  '24': '半導體業',           // 2302麗正 2303聯電 2330台積電 2344華邦電
  '25': '電腦及週邊設備業',   // 2301光寶 2305全友 2352佳世達
  '26': '光電業',             // 2323中環 2349錸德 2409友達
  '27': '電子零組件業',       // 2314台半 2321東訊 2332友訊
  '28': '其他',               // 1471首利 2308台達電 2313華通
  '29': '通信網路業',         // 2347聯強 2414精技
  '30': '資訊服務業',         // 2427三商電 2453凌群
  '31': '電子通路業',         // 2312金寶 2317鴻海 2354鴻準
  '35': '居家生活',           // 2072南僑 5765丸美
  '36': '數位雲端',           // 3130一零四 6165捷泰
  '37': '綜合',               // 1432大魯閣 1598岱宇
  '38': '電子商務',           // 2062橘焱 3557嘉威
  '91': '存託憑證',           // 9103美德醫
}

// TPEX openapi mopsfin_t187ap03_O 回傳的 industry code（2026-04-02 驗證）
// TPEX 與 TWSE 使用相同的 code 體系（經比對 sample stocks 確認）
const TPEX_INDUSTRY_MAP: Record<string, string> = {
  '02': '食品工業',           // 1264德麥
  '03': '塑膠工業',           // 4303信立
  '04': '紡織纖維',           // 4401東隆興
  '05': '電機機械',           // 1580新麥
  '06': '電器電纜',           // 2061風青
  '10': '建材營造業',         // 2035千附
  '14': '鋼鐵工業',           // 2596綠意
  '15': '橡膠工業',           // 2641正德
  '16': '觀光餐旅',           // 2719燦星旅 1268漢來美食
  '17': '金融保險業',         // 5864致和 5878台名
  '20': '其他電子業',         // 1584精剛
  '21': '化學工業',           // 1742台蠟
  '22': '生技醫療',           // 1565精華 1777科妍
  '23': '油電燃氣業',         // 8908欣汎 8917明安
  '24': '半導體業',           // 3105穩懋 3141晶宏
  '25': '電腦及週邊設備業',   // 3071協禧 3088艾訊
  '26': '光電業',             // 3066李洲 3128昇銳
  '27': '電子零組件業',       // 3081聯亞 3095明泰
  '28': '其他',               // 1336台翰 1595川寶
  '29': '通信網路業',         // 3224三顧 3232昱捷
  '30': '資訊服務業',         // 3570大塚 4953緯軟
  '31': '電子通路業',         // 1785光洋科 3067全域
  '32': '綠能環保',           // 2926誠品 3064泰偉
  '33': '數位雲端',           // 1240茂生 6508惠光
  '35': '文化創意業',         // 3073志旭 3551世禾
  '36': '農業科技',           // 2640大車隊 2949華航
  '37': '貿易百貨',           // 1593祺驊 5348川湖
  '38': '航運業',             // 2916滿心 2924東凌
}

/**
 * 同步 TWSE + TPEX 官方產業分類到 stock_tags（tag_type='industry'）
 * 每支上市/櫃股票得到 1 個 industry tag — 保底覆蓋，不會像概念標籤一樣有缺漏
 */
export async function syncIndustryTags(db: D1Database, kv?: KVNamespace): Promise<{ synced: number }> {
  // 確保 tag_type 欄位存在（idempotent migration）
  await db.prepare(
    "SELECT tag_type FROM stock_tags LIMIT 1"
  ).first().catch(async () => {
    await db.prepare("ALTER TABLE stock_tags ADD COLUMN tag_type TEXT DEFAULT 'concept'").run()
    console.log('[IndustrySync] Added tag_type column')
  })

  // 標記所有現有 tags 為 concept（如果還沒標）
  await db.prepare("UPDATE stock_tags SET tag_type='concept' WHERE tag_type IS NULL").run()

  // ── 抓 TWSE 上市公司清單 ──
  let twseData: { symbol: string; industry: string }[] = []
  try {
    const res = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000),
    })
    if (res.ok) {
      const body = await res.json() as any[]
      const keys = body.length ? Object.keys(body[0]) : []
      // 產業別 field key varies by encoding — find by position (index 5) or by content pattern
      const codeKey = keys[1]  // 公司代號
      const indKey = keys[5]   // 產業別
      for (const row of body) {
        const sym = String(row[codeKey] ?? '').trim()
        const indCode = String(row[indKey] ?? '').trim()
        if (/^\d{4}$/.test(sym) && TWSE_INDUSTRY_MAP[indCode]) {
          twseData.push({ symbol: sym, industry: TWSE_INDUSTRY_MAP[indCode] })
        }
      }
    }
  } catch (e) { console.warn('[IndustrySync] TWSE fetch failed:', e) }

  // ── 抓 TPEX 上櫃公司清單 ──
  let tpexData: { symbol: string; industry: string }[] = []
  try {
    const res = await fetch('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(30000),
    })
    if (res.ok) {
      const body = await res.json() as any[]
      const keys = body.length ? Object.keys(body[0]) : []
      const codeKey = keys[1]
      const indKey = keys[5]
      for (const row of body) {
        const sym = String(row[codeKey] ?? '').trim()
        const indCode = String(row[indKey] ?? '').trim()
        if (/^\d{4}$/.test(sym) && TPEX_INDUSTRY_MAP[indCode]) {
          tpexData.push({ symbol: sym, industry: TPEX_INDUSTRY_MAP[indCode] })
        }
      }
    }
  } catch (e) { console.warn('[IndustrySync] TPEX fetch failed:', e) }

  const allData = [...twseData, ...tpexData]
  if (!allData.length) {
    console.warn('[IndustrySync] No data fetched')
    return { synced: 0 }
  }

  // ── D9 (M10 fix): collision check — detect tags that exist under a different tag_type ──
  const uniqueTags = [...new Set(allData.map(d => d.industry))]
  if (uniqueTags.length) {
    const ph = uniqueTags.map(() => '?').join(',')
    const { results: collisions } = await db.prepare(
      `SELECT DISTINCT tag, tag_type FROM stock_tags WHERE tag IN (${ph}) AND tag_type != 'industry'`
    ).bind(...uniqueTags).all<{ tag: string; tag_type: string }>()
    if (collisions?.length) {
      console.warn(`[IndustrySync] ⚠️ Tag name collision detected! ${collisions.length} tags exist under different tag_type:`)
      for (const c of collisions) {
        console.warn(`  "${c.tag}" already exists as tag_type="${c.tag_type}" — skipping to avoid M10 clobber`)
      }
      const collisionSet = new Set(collisions.map(c => c.tag))
      const before = allData.length
      const filtered = allData.filter(d => !collisionSet.has(d.industry))
      console.warn(`[IndustrySync] Filtered ${before - filtered.length} rows with colliding tags`)
      allData.length = 0
      allData.push(...filtered)
    }
  }

  // ── Batch upsert into stock_tags ──
  const BATCH = 50
  let synced = 0
  for (let i = 0; i < allData.length; i += BATCH) {
    const stmts = allData.slice(i, i + BATCH).map(d =>
      db.prepare(`
        INSERT INTO stock_tags (symbol, tag, source, weight, tag_type)
        VALUES (?, ?, 'twse', 1.0, 'industry')
        ON CONFLICT(symbol, tag) DO UPDATE SET
          source='twse', weight=1.0, tag_type='industry', updated_at=datetime('now')
      `).bind(d.symbol, d.industry)
    )
    if (stmts.length) {
      await db.batch(stmts)
      synced += stmts.length
    }
  }

  // 清除 KV 快取（讓新 tags 生效）
  if (kv) {
    await kv.delete('screener:sector-map')
    await kv.delete('buzz:keywords')
  }
  console.log(`[IndustrySync] Synced ${synced} industry tags (TWSE ${twseData.length} + TPEX ${tpexData.length})`)
  return { synced }
}

// ── 台指期夜盤收盤資料（TAIFEX MIS API）─────────────────────────────────────
export interface TaifexNightSession {
  lastPrice: number       // 夜盤最後成交價
  refPrice: number        // 前日結算價
  changePoints: number    // 漲跌點數
  changePct: number       // 漲跌幅 %
  date: string            // 資料日期 YYYYMMDD
  time: string            // 最後更新時間
}

/**
 * 從 TAIFEX MIS API 取台指期近月合約的最新報價
 * 07:15 呼叫時會拿到夜盤（15:00~05:00）收盤數據
 * 盤中呼叫則拿到即時報價
 */
export async function fetchTaifexNightClose(): Promise<TaifexNightSession | null> {
  try {
    // TAIFEX MIS API — 不需 auth，POST 取台指期報價
    // SymbolID 格式：TXF{月份}{年份}-F（近月合約），用空 SymbolID 取全部
    const res = await fetch('https://mis.taifex.com.tw/futures/api/getQuoteList', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      body: JSON.stringify({ CID: '', SymbolID: '', MarketType: '0' }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return null
    const body = await res.json() as any
    const quotes = body?.RtData?.QuoteList as any[] | undefined
    if (!quotes?.length) return null

    // 找台指期近月合約（DispCName 包含「臺指期」且為最近月份）
    // 第一筆 TXF-S 是現貨，跳過；找第一個 -F 結尾的才是期貨
    const txf = quotes.find(q =>
      q.SymbolID?.endsWith('-F') &&
      q.DispCName?.includes('臺指期') &&
      q.CLastPrice && q.CLastPrice !== ''
    )
    if (!txf) return null

    const lastPrice = parseFloat(txf.CLastPrice)
    const refPrice = parseFloat(txf.CRefPrice)
    if (isNaN(lastPrice) || isNaN(refPrice) || refPrice === 0) return null

    const changePoints = lastPrice - refPrice
    const changePct = (changePoints / refPrice) * 100

    console.log(`[TAIFEX] ${txf.DispCName}: ${lastPrice} (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%) ref=${refPrice}`)

    return {
      lastPrice,
      refPrice,
      changePoints,
      changePct,
      date: txf.CDate ?? '',
      time: txf.CTime ?? '',
    }
  } catch (e) {
    console.warn('[TAIFEX] fetchTaifexNightClose failed:', e)
    return null
  }
}
