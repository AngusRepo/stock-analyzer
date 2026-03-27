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
  const body = await res.json() as any
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
  // TPEX openapi 只回傳最新一天（不需 date 參數）
  const url = 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_margin_balance'
  const res = await fetch(url, {
    headers: { 'User-Agent': 'StockVision/12.3' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`TPEX margin HTTP ${res.status}`)
  const body = await res.json() as any[]
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
): Promise<{ chipCount: number; marginCount: number }> {
  console.log(`[BulkChip] Fetching TWSE/TPEX chips + margins for ${date}...`)

  // 並行呼叫 4 個 API
  const [twseChips, tpexChips, twseMargin, tpexMargin] = await Promise.allSettled([
    fetchTwseChips(date),
    fetchTpexChips(date),
    fetchTwseMargin(date),
    fetchTpexMargin(date),
  ])

  const allChips = [
    ...(twseChips.status === 'fulfilled' ? twseChips.value : []),
    ...(tpexChips.status === 'fulfilled' ? tpexChips.value : []),
  ]
  const allMargin = [
    ...(twseMargin.status === 'fulfilled' ? twseMargin.value : []),
    ...(tpexMargin.status === 'fulfilled' ? tpexMargin.value : []),
  ]

  // Log failures
  if (twseChips.status === 'rejected') console.warn('[BulkChip] TWSE chips failed:', twseChips.reason)
  if (tpexChips.status === 'rejected') console.warn('[BulkChip] TPEX chips failed:', tpexChips.reason)
  if (twseMargin.status === 'rejected') console.warn('[BulkChip] TWSE margin failed:', twseMargin.reason)
  if (tpexMargin.status === 'rejected') console.warn('[BulkChip] TPEX margin failed:', tpexMargin.reason)

  console.log(`[BulkChip] Fetched: ${allChips.length} chips, ${allMargin.length} margins`)

  if (!allChips.length) return { chipCount: 0, marginCount: 0 }

  // Build margin lookup
  const marginMap = new Map(allMargin.map(m => [m.symbol, m]))

  // symbol → stocks.id mapping
  const symbols = allChips.map(c => c.symbol)
  const uniqueSymbols = [...new Set(symbols)]
  const idMap = new Map<string, number>()

  // 分批查 stocks.id（D1 bind 限制）
  const QUERY_BATCH = 50
  for (let i = 0; i < uniqueSymbols.length; i += QUERY_BATCH) {
    const batch = uniqueSymbols.slice(i, i + QUERY_BATCH)
    const placeholders = batch.map(() => '?').join(',')
    const { results } = await db.prepare(
      `SELECT id, symbol FROM stocks WHERE symbol IN (${placeholders})`
    ).bind(...batch).all<{ id: number; symbol: string }>()
    for (const r of results ?? []) {
      idMap.set(r.symbol, r.id)
    }
  }

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
