import { Hono } from 'hono'

// ── 安全的 ID 解析（parseInt NaN 防護）─────────────────────────────────────
function parseId(s: string | undefined | null): number | null {
  const n = parseInt(s ?? '')
  return isNaN(n) || n <= 0 ? null : n
}
function parsePosInt(s: string | undefined | null, fallback: number): number {
  const n = parseInt(s ?? '')
  return isNaN(n) || n <= 0 ? fallback : n
}

import type { Bindings, Variables } from '../types'
import { authMiddleware, adminMiddleware } from '../lib/auth'
import { withCache, TTL } from '../lib/cache'
import { rateLimitMiddleware } from '../lib/rateLimit'

const stocks = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ─── GET /api/stocks  →  list all active stocks ───────────────────────────────
stocks.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM stocks WHERE is_active=1 ORDER BY symbol'
  ).all()
  return c.json(results)
})

// ─── GET /api/stocks/search?q=xxx ────────────────────────────────────────────
stocks.get('/search', async (c) => {
  const q     = c.req.query('q') ?? ''
  const limit = parsePosInt(c.req.query('limit'), 20)
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM stocks WHERE (symbol LIKE ? OR name LIKE ?) ORDER BY is_active DESC, symbol LIMIT ?`
  ).bind(`%${q}%`, `%${q}%`, limit).all()
  return c.json(results)
})

// ─── GET /api/stocks/:id ──────────────────────────────────────────────────────
stocks.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const row = await c.env.DB.prepare('SELECT * FROM stocks WHERE id=?').bind(id).first<any>()
  if (!row) return c.json({ error: '股票不存在' }, 404)

  // 附帶各資料表最新日期（讓前端顯示更新狀態）
  const [latestPrice, latestChip, latestPred] = await Promise.all([
    c.env.DB.prepare('SELECT date FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 1').bind(id).first<any>(),
    c.env.DB.prepare('SELECT date FROM chip_data    WHERE symbol=? ORDER BY date DESC LIMIT 1').bind(row.symbol).first<any>(),
    c.env.DB.prepare('SELECT generated_at FROM predictions WHERE stock_id=? ORDER BY generated_at DESC LIMIT 1').bind(id).first<any>(),
  ])

  return c.json({
    ...row,
    latestPriceDate:      latestPrice?.date ?? null,
    latestChipDate:       latestChip?.date ?? null,
    latestPredictionDate: latestPred?.generated_at ?? null,
  })
})

// ─── POST /api/stocks  →  add stock (admin only) ─────────────────────────────
// [CODE-REVIEW-FIX] 2026-03-23: 全域 stocks 表，非 admin 不應新增
// 加 rate limiting 防止 admin 腳本誤觸浪費 D1 寫入額度
stocks.post('/', rateLimitMiddleware('api'), authMiddleware, adminMiddleware, async (c) => {
  const { symbol, name, market = 'TWSE', sector } = await c.req.json()
  if (!symbol || !name) return c.json({ error: '請提供 symbol 與 name' }, 400)

  const sym = symbol.toUpperCase()
  const existing = await c.env.DB.prepare(
    'SELECT id, is_active FROM stocks WHERE symbol=?'
  ).bind(sym).first<{ id: number; is_active: number }>()

  if (existing?.is_active) return c.json({ error: '股票已存在' }, 409)

  if (existing) {
    await c.env.DB.prepare('UPDATE stocks SET is_active=1, name=?, sector=? WHERE id=?')
      .bind(name, sector ?? null, existing.id).run()
    const row = await c.env.DB.prepare('SELECT * FROM stocks WHERE id=?').bind(existing.id).first()
    return c.json(row, 201)
  }

  const result = await c.env.DB.prepare(
    'INSERT INTO stocks (symbol, name, market, sector) VALUES (?,?,?,?) RETURNING id'
  ).bind(sym, name, market, sector ?? null).first<{ id: number }>()

  if (!result) return c.json({ error: '新增失敗' }, 500)

  const row = await c.env.DB.prepare('SELECT * FROM stocks WHERE id=?').bind(result.id).first()
  return c.json(row, 201)
})

// ─── DELETE /api/stocks/:id (admin only) ─────────────────────────────────────
// [CODE-REVIEW-FIX] 2026-03-23: 全域 stocks 表，非 admin 不應刪除
stocks.delete('/:id', authMiddleware, adminMiddleware, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  await c.env.DB.prepare('UPDATE stocks SET is_active=0 WHERE id=?').bind(id).run()
  return c.json({ success: true })
})

// ─── GET /api/stocks/:id/prices?days=365 ─────────────────────────────────────
stocks.get('/:id/prices', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const days = parsePosInt(c.req.query('days'), 365)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM stock_prices WHERE stock_id=? AND date>=? ORDER BY date'
  ).bind(id, since).all()
  return c.json(results)
})

// ─── GET /api/stocks/:id/indicators?days=365 ─────────────────────────────────
stocks.get('/:id/indicators', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const days = parsePosInt(c.req.query('days'), 365)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

  let { results } = await c.env.DB.prepare(
    'SELECT * FROM technical_indicators WHERE stock_id=? AND date>=? ORDER BY date'
  ).bind(id, since).all()

  // On-demand: 若無指標資料，自動計算（支援興櫃等非 active 股票）
  if (!results?.length) {
    try {
      await computeAndStoreIndicators(c.env.DB, id)
      const retry = await c.env.DB.prepare(
        'SELECT * FROM technical_indicators WHERE stock_id=? AND date>=? ORDER BY date'
      ).bind(id, since).all()
      results = retry.results
    } catch (e) {
      console.warn(`[Indicators] On-demand compute failed for stock_id=${id}:`, e)
    }
  }

  return c.json(results ?? [])
})

// ─── GET /api/stocks/:id/financials?limit=12 ─────────────────────────────────
stocks.get('/:id/financials', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const limit = parsePosInt(c.req.query('limit'), 12)

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM financials WHERE stock_id=? ORDER BY period DESC LIMIT ?'
  ).bind(id, limit).all()
  return c.json(results)
})

// ─── GET /api/stocks/:id/monthly-revenue?months=12 ──────────────────────────
stocks.get('/:id/monthly-revenue', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const months = parsePosInt(c.req.query('months'), 12)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM monthly_revenue WHERE stock_id=? ORDER BY date DESC LIMIT ?'
  ).bind(id, months).all()
  return c.json(results ?? [])
})

// ─── GET /api/stocks/:id/chips?days=60 ───────────────────────────────────────
stocks.get('/:id/chips', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const stock = await c.env.DB.prepare('SELECT symbol FROM stocks WHERE id=?').bind(id).first<any>()
  if (!stock) return c.json({ error: '股票不存在' }, 404)
  const days = parsePosInt(c.req.query('days'), 60)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM chip_data WHERE symbol=? AND date>=? ORDER BY date'
  ).bind(stock.symbol, since).all()
  return c.json(results)
})

// ─── GET /api/stocks/:id/news?days=30 ────────────────────────────────────────
stocks.get('/:id/news', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const days = parsePosInt(c.req.query('days'), 30)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM news WHERE stock_id=? AND published_at>=? ORDER BY published_at DESC LIMIT 50'
  ).bind(id, since).all()
  return c.json(results)
})

// ─── GET /api/stocks/:id/predictions ─────────────────────────────────────────
stocks.get('/:id/predictions', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM predictions WHERE stock_id=? ORDER BY generated_at DESC LIMIT 10'
  ).bind(id).all()
  return c.json(results)
})

// ─── GET /api/stocks/:id/factors ─────────────────────────────────────────────
stocks.get('/:id/factors', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const row = await c.env.DB.prepare(
    'SELECT * FROM factor_scores WHERE stock_id=? ORDER BY date DESC LIMIT 1'
  ).bind(id).first()
  if (!row) {
    const priceCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM stock_prices WHERE stock_id=?'
    ).bind(id).first<{ cnt: number }>()
    return c.json({ empty: true, reason: (priceCount?.cnt ?? 0) < 60
      ? '歷史價格資料不足 60 筆，無法計算多因子分析'
      : '此股票尚未納入排程計算，資料待下次排程更新' })
  }
  return c.json(row)
})

// ─── GET /api/stocks/:id/risk?period=1y ──────────────────────────────────────
stocks.get('/:id/risk', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const period = c.req.query('period') ?? '1y'
  const row    = await c.env.DB.prepare(
    'SELECT * FROM risk_metrics WHERE stock_id=? AND period=? ORDER BY calculated_at DESC LIMIT 1'
  ).bind(id, period).first()
  if (!row) {
    const priceCount = await c.env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM stock_prices WHERE stock_id=?'
    ).bind(id).first<{ cnt: number }>()
    return c.json({ empty: true, reason: (priceCount?.cnt ?? 0) < 60
      ? '歷史價格資料不足 60 筆，無法計算風險指標'
      : '此股票尚未納入排程計算，資料待下次排程更新' })
  }
  return c.json(row)
})

// ─── GET /api/stocks/:id/valuations ──────────────────────────────────────────
stocks.get('/:id/valuations', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const stock = await c.env.DB.prepare('SELECT * FROM stocks WHERE id=?').bind(id).first<any>()
  if (!stock) return c.json({ error: '股票不存在' }, 404)

  const [current, history] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM financials WHERE stock_id=? AND period_type='quarterly' ORDER BY period DESC LIMIT 1"
    ).bind(id).first(),
    c.env.DB.prepare(
      "SELECT * FROM financials WHERE stock_id=? AND period_type='quarterly' ORDER BY period DESC LIMIT 8"
    ).bind(id).all().then(r => r.results),
  ])

  return c.json({ stock, current, history })
})

// ─── POST /api/stocks/:id/refresh (admin only) ────────────────────────────────
// [CODE-REVIEW-FIX] 2026-03-23: 加回 adminMiddleware，防止非 admin 觸發 FinMind API 配額消耗
stocks.post('/:id/refresh', authMiddleware, adminMiddleware, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const stock = await c.env.DB.prepare('SELECT * FROM stocks WHERE id=?').bind(id).first<any>()
  if (!stock) return c.json({ error: '股票不存在' }, 404)

  // Fetch from Yahoo Finance
  await fetchAndStoreStockData(c.env.DB, c.env.KV, stock, c.env.FINMIND_TOKEN)
  return c.json({ success: true, message: `已更新 ${stock.symbol}` })
})

// ─── 資料更新總入口：Yahoo Finance（台股 + 美股）─────────────────────────────
// 台股每日收盤股價已由 bulkFetchAndStorePrices (TWSE STOCK_DAY_ALL) 寫入；
// Queue per-stock 呼叫此函式補充 Yahoo 歷史 + 觸發指標計算。
// 籌碼：bulkFetchAndStoreChipData (TWSE/TPEX)
// 財報：Wave2 bulk TWSE opendata
export async function fetchAndStoreStockData(
  db: D1Database, kv: KVNamespace, stock: any, _finmindToken?: string,
) {
  await fetchAndStoreYahoo(db, stock)
}

// ─── Yahoo Finance：美股（或 token 未設定時的 fallback）─────────────────────
async function fetchAndStoreYahoo(db: D1Database, stock: any) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(stock.symbol)}?interval=1d&range=1y`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return

    const data  = await res.json() as any
    const result = data.chart?.result?.[0]
    if (!result) return

    const timestamps: number[] = result.timestamp ?? []
    const q = result.indicators?.quote?.[0]
    if (!q || !timestamps.length) return

    const batch: D1PreparedStatement[] = []
    for (let i = 0; i < timestamps.length; i++) {
      const date = new Date(timestamps[i] * 1000).toISOString().split('T')[0]
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], cl = q.close?.[i], v = q.volume?.[i]
      if (cl == null) continue
      batch.push(db.prepare(
        `INSERT OR REPLACE INTO stock_prices (stock_id, date, open, high, low, close, adj_close, volume)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(stock.id, date, o??null, h??null, l??null, cl, cl, v??null))
    }
    if (batch.length) await db.batch(batch)
    // 指標計算已移至 computeAndStoreIndicators()，由 Queue consumer 呼叫（SRP）
  } catch (e) {
    console.error(`[Yahoo] Failed for ${stock.symbol}:`, e)
  }
}

// ─── 獨立的指標計算入口（由 Queue consumer 在 fetchAndStore 之後呼叫）─────────
// Why: SRP — fetch/store raw prices 與 compute derived indicators 是兩個不同的 pipeline stage
export async function computeAndStoreIndicators(db: D1Database, stockId: number): Promise<void> {
  try {
    const recentPrices = await db.prepare(
      'SELECT close, high, low FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 70'
    ).bind(stockId).all<{ close: number; high: number; low: number }>()

    const closes = recentPrices.results.map(p => p.close).reverse()
    if (closes.length < 20) return

    const today = new Date().toISOString().split('T')[0]
    const ind   = computeIndicators(
      closes,
      recentPrices.results.map(p => p.high).reverse(),
      recentPrices.results.map(p => p.low).reverse(),
    )
    await db.prepare(
      `INSERT OR REPLACE INTO technical_indicators
         (stock_id, date, ma5, ma10, ma20, ma60, rsi14, macd, macd_signal, macd_hist, bb_upper, bb_mid, bb_lower, atr14)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      stockId, today,
      ind.ma5, ind.ma10, ind.ma20, ind.ma60,
      ind.rsi14, ind.macd, ind.macdSignal, ind.macdHist,
      ind.bbUpper, ind.bbMid, ind.bbLower, ind.atr14,
    ).run()
  } catch (e) {
    console.error(`[Indicators] Failed for stock_id=${stockId}:`, e)
  }
}

// ─── Technical Indicator Computation ─────────────────────────────────────────
function sma(arr: number[], n: number): number | null {
  if (arr.length < n) return null
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n
}

function ema(arr: number[], n: number): number[] {
  const k = 2 / (n + 1); const r = [arr[0]]
  for (let i = 1; i < arr.length; i++) r.push(arr[i] * k + r[i-1] * (1-k))
  return r
}

function computeIndicators(closes: number[], highs: number[], lows: number[]) {
  const ma5  = sma(closes, 5)
  const ma10 = sma(closes, 10)
  const ma20 = sma(closes, 20)
  const ma60 = sma(closes, 60)

  // RSI
  let gains = 0, losses = 0, rsi14 = null
  const period = 14
  if (closes.length >= period + 1) {
    for (let i = closes.length - period; i < closes.length; i++) {
      const d = closes[i] - closes[i-1]
      if (d > 0) gains += d; else losses -= d
    }
    const avgG = gains / period, avgL = losses / period
    rsi14 = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)
  }

  // MACD
  let macd = null, macdSignal = null, macdHist = null
  if (closes.length >= 35) {
    const ema12 = ema(closes, 12), ema26 = ema(closes, 26)
    const macdLine = ema12.map((v, i) => v - ema26[i]).slice(25)
    const signalLine = ema(macdLine, 9)
    macd       = macdLine[macdLine.length - 1]
    macdSignal = signalLine[signalLine.length - 1]
    macdHist   = macd - macdSignal
  }

  // Bollinger Bands
  let bbUpper = null, bbMid = null, bbLower = null
  if (closes.length >= 20) {
    const slice = closes.slice(-20)
    const mean  = slice.reduce((a,b) => a+b,0) / 20
    const std   = Math.sqrt(slice.reduce((a,b) => a + (b-mean)**2, 0) / 20)
    bbMid = mean; bbUpper = mean + 2*std; bbLower = mean - 2*std
  }

  // ATR
  let atr14 = null
  if (highs.length >= 15) {
    const trs = []
    for (let i = highs.length - 14; i < highs.length; i++) {
      trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])))
    }
    atr14 = trs.reduce((a,b) => a+b, 0) / 14
  }

  return { ma5, ma10, ma20, ma60, rsi14, macd, macdSignal, macdHist, bbUpper, bbMid, bbLower, atr14 }
}

// ─── GET /api/stocks/:id/margin?days=60 ─────────────────────────────────────
stocks.get('/:id/margin', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const days = parsePosInt(c.req.query('days'), 60)

  const { results } = await c.env.DB.prepare(
    'SELECT date, margin_buy, margin_sell, margin_balance, short_buy, short_sell, short_balance, margin_usage_pct, short_ratio FROM margin_data WHERE stock_id=? ORDER BY date DESC LIMIT ?'
  ).bind(id, days).all()
  return c.json(results ?? [])
})

// ─── GET /api/stocks/:id/ai-summary ─ 個股 AI 摘要（推薦+tags+籌碼+profile）──
stocks.get('/:id/ai-summary', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const stock = await c.env.DB.prepare('SELECT symbol, name, sector, market FROM stocks WHERE id=?').bind(id).first<any>()
  if (!stock) return c.json({ error: '股票不存在' }, 404)

  // 平行查詢
  const [recRow, tagsRows, chipRows, profileRow, finRow] = await Promise.all([
    // 最新推薦
    c.env.DB.prepare(
      'SELECT * FROM daily_recommendations WHERE symbol=? ORDER BY date DESC LIMIT 1'
    ).bind(stock.symbol).first<any>().catch(() => null),
    // 概念標籤
    c.env.DB.prepare(
      'SELECT tag, weight FROM stock_tags WHERE symbol=? ORDER BY weight DESC'
    ).bind(stock.symbol).all<any>().then(r => r.results ?? []).catch(() => []),
    // 近 5 日法人
    c.env.DB.prepare(`
      SELECT SUM(foreign_net) as foreign_net,
             SUM(trust_net) as trust_net,
             SUM(dealer_net) as dealer_net
      FROM (
        SELECT foreign_buy - foreign_sell as foreign_net,
               trust_buy - trust_sell as trust_net,
               dealer_buy - dealer_sell as dealer_net
        FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 5
      )
    `).bind(stock.symbol).first<any>().catch(() => null),
    // 公司概況
    c.env.DB.prepare(
      'SELECT business_desc, key_customers, key_suppliers FROM stock_profiles WHERE symbol=?'
    ).bind(stock.symbol).first<any>().catch(() => null),
    // 最新財報
    c.env.DB.prepare(
      "SELECT period, eps, pe, pb, dividend_yield, roe FROM financials WHERE stock_id=? AND period LIKE '%Q%' ORDER BY period DESC LIMIT 1"
    ).bind(id).first<any>().catch(() => null),
  ])

  return c.json({
    symbol: stock.symbol,
    name: stock.name,
    sector: stock.sector,
    market: stock.market,
    recommendation: recRow,
    tags: tagsRows,
    chip5d: chipRows,
    profile: profileRow,
    financials: finRow,
  })
})

export { stocks }
