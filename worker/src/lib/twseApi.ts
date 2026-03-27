/**
 * twseApi.ts — TWSE/TPEX 官方 API bulk fetcher
 *
 * 替代 FinMind 逐股 API：一次 request 取全市場資料
 * - 三大法人: TWSE T86 + TPEX 3itrade
 * - 融資融券: TWSE MI_MARGN + TPEX openapi margin_balance
 *
 * 全部免費、無配額限制。
 */

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

function isStockCode(s: string): boolean {
  return /^\d{4,6}$/.test(s.trim())
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

export interface BulkMarginRow {
  symbol: string
  margin_balance: number    // 融資今日餘額（張）
  short_balance: number     // 融券今日餘額（張）
  margin_buy: number
  margin_sell: number
  short_buy: number
  short_sell: number
}

// ─── TWSE 處置股 + 注意股 ────────────────────────────────────────────────────

export async function fetchPunishedStocks(): Promise<string[]> {
  const res = await fetch('https://www.twse.com.tw/rwd/zh/announcement/punish?response=json', {
    headers: { 'User-Agent': 'StockVision/12.3' },
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
    headers: { 'User-Agent': 'StockVision/12.3' },
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
    headers: { 'User-Agent': 'StockVision/12.3' },
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
    headers: { 'User-Agent': 'StockVision/12.3' },
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

// ─── TWSE T86: 上市三大法人 ──────────────────────────────────────────────────

export async function fetchTwseChips(date: string): Promise<BulkChipRow[]> {
  const url = `https://www.twse.com.tw/rwd/zh/fund/T86?date=${twseDate(date)}&selectType=ALL&response=json`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'StockVision/12.3' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`TWSE T86 HTTP ${res.status}`)
  const body = await res.json() as any
  if (body.stat !== 'OK' || !body.data) return []

  return body.data
    .filter((r: string[]) => isStockCode(r[0]))
    .map((r: string[]) => ({
      symbol: r[0].trim(),
      foreign_buy:  parseTwNum(r[2]),
      foreign_sell: parseTwNum(r[3]),
      foreign_net:  parseTwNum(r[4]),
      trust_buy:    parseTwNum(r[8]),
      trust_sell:   parseTwNum(r[9]),
      trust_net:    parseTwNum(r[10]),
      dealer_buy:   parseTwNum(r[12]),  // 自行買賣
      dealer_sell:  parseTwNum(r[13]),
      dealer_net:   parseTwNum(r[11]),  // 合計淨額
    }))
}

// ─── TPEX 3itrade: 上櫃三大法人 ─────────────────────────────────────────────

export async function fetchTpexChips(date: string): Promise<BulkChipRow[]> {
  const url = `https://www.tpex.org.tw/web/stock/3insti/daily_trade/3itrade_hedge_result.php?l=zh-tw&d=${rocDate(date)}&t=D&o=json`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'StockVision/12.3' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`TPEX 3itrade HTTP ${res.status}`)
  const text = await res.text()
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
    throw new Error('TPEX returned HTML instead of JSON (data not ready)')
  }
  const body = JSON.parse(text) as any
  if (body.stat !== 'ok' || !body.tables?.[0]?.data) return []

  return body.tables[0].data
    .filter((r: string[]) => isStockCode(r[0]))
    .map((r: string[]) => ({
      symbol: r[0].trim(),
      foreign_buy:  parseTwNum(r[2]),
      foreign_sell: parseTwNum(r[3]),
      foreign_net:  parseTwNum(r[4]),
      trust_buy:    parseTwNum(r[8]),
      trust_sell:   parseTwNum(r[9]),
      trust_net:    parseTwNum(r[10]),
      dealer_buy:   parseTwNum(r[12]),
      dealer_sell:  parseTwNum(r[13]),
      dealer_net:   parseTwNum(r[11]),
    }))
}

// ─── TWSE MI_MARGN: 上市融資融券 ────────────────────────────────────────────

export async function fetchTwseMargin(date: string): Promise<BulkMarginRow[]> {
  const url = `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${twseDate(date)}&selectType=ALL&response=json`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'StockVision/12.3' },
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
    headers: { 'User-Agent': 'StockVision/12.3' },
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

  // TWSE 直接呼叫（OK）；TPEX 擋 CF Workers IP → 透過 Controller proxy
  const tpexViaController = async (): Promise<{ chips: BulkChipRow[]; margins: BulkMarginRow[] }> => {
    if (!controllerUrl) return { chips: [], margins: [] }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (controllerSecret) headers['X-Controller-Token'] = controllerSecret
    const res = await fetch(`${controllerUrl}/tpex-chips`, {
      method: 'POST', headers,
      body: JSON.stringify({ date }),
      signal: AbortSignal.timeout(60000),
    })
    if (!res.ok) throw new Error(`Controller /tpex-chips HTTP ${res.status}`)
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

  const [twseChips, tpexResult, twseMargin] = await Promise.allSettled([
    fetchTwseChips(date),
    tpexViaController(),
    fetchTwseMargin(date),
  ])

  const tpexChips = tpexResult.status === 'fulfilled' ? tpexResult.value.chips : []
  const tpexMargin = tpexResult.status === 'fulfilled' ? tpexResult.value.margins : []

  const allChips = [
    ...(twseChips.status === 'fulfilled' ? twseChips.value : []),
    ...tpexChips,
  ]
  const allMargin = [
    ...(twseMargin.status === 'fulfilled' ? twseMargin.value : []),
    ...tpexMargin,
  ]

  if (twseChips.status === 'rejected') console.warn('[BulkChip] TWSE chips failed:', twseChips.reason)
  if (tpexResult.status === 'rejected') console.warn('[BulkChip] TPEX proxy failed:', tpexResult.reason)
  if (twseMargin.status === 'rejected') console.warn('[BulkChip] TWSE margin failed:', twseMargin.reason)

  console.log(`[BulkChip] Fetched: ${allChips.length} chips, ${allMargin.length} margins`)

  if (!allChips.length) return { chipCount: 0, marginCount: 0 }

  // Build margin lookup
  const marginMap = new Map(allMargin.map(m => [m.symbol, m]))

  // symbol → stocks.id mapping（查 D1 全部 stocks，不只 active）
  const idMap = new Map<string, number>()
  const { results: allStocksRows } = await db.prepare(
    'SELECT id, symbol FROM stocks'
  ).all<{ id: number; symbol: string }>()
  for (const r of allStocksRows ?? []) {
    idMap.set(r.symbol, r.id)
  }
  console.log(`[BulkChip] idMap: ${idMap.size} stocks in D1`)

  // 批次寫入 chip_data
  const WRITE_BATCH = 50
  let chipCount = 0
  for (let i = 0; i < allChips.length; i += WRITE_BATCH) {
    const chunk = allChips.slice(i, i + WRITE_BATCH)
    const stmts = chunk
      .filter(c => idMap.has(c.symbol))
      .map(c => {
        const stockId = idMap.get(c.symbol)!
        const m = marginMap.get(c.symbol)
        return db.prepare(`
          INSERT OR REPLACE INTO chip_data
            (stock_id, date, foreign_buy, foreign_sell, foreign_net,
             trust_buy, trust_sell, trust_net, dealer_buy, dealer_sell, dealer_net,
             margin_balance, short_balance)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          stockId, date,
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

  // 寫入 margin_data（詳細融資融券）
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
