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

import type { Bindings, Variables } from '../types'
import { authMiddleware, adminMiddleware } from '../lib/auth'
import { withCache, TTL } from '../lib/cache'
import { rateLimitMiddleware } from '../lib/rateLimit'
import {
  appendUniqueWatchPoint,
  buildMarketStructureWatchPoint,
  buildMlVoteSummary,
  buildMlVoteWatchPoint,
  parsePredictionForecastData,
} from '../lib/recommendationContext'
import { computeAndStoreIndicators } from '../lib/technicalIndicators'

const stocks = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ─── GET /api/stocks  →  list all active stocks ───────────────────────────────
stocks.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM stocks WHERE in_current_watchlist=1 ORDER BY symbol'
  ).all()
  return c.json(results)
})

// ─── GET /api/stocks/search?q=xxx ────────────────────────────────────────────
stocks.get('/search', async (c) => {
  const q     = c.req.query('q') ?? ''
  const limit = parsePosInt(c.req.query('limit'), 20)
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM stocks WHERE (symbol LIKE ? OR name LIKE ?) ORDER BY in_current_watchlist DESC, symbol LIMIT ?`
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
    'SELECT id, in_current_watchlist FROM stocks WHERE symbol=?'
  ).bind(sym).first<{ id: number; in_current_watchlist: number }>()

  if (existing?.in_current_watchlist) return c.json({ error: '股票已存在' }, 409)

  if (existing) {
    await c.env.DB.prepare('UPDATE stocks SET in_current_watchlist=1, name=?, sector=? WHERE id=?')
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
  await c.env.DB.prepare('UPDATE stocks SET in_current_watchlist=0 WHERE id=?').bind(id).run()
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

  const stock = await c.env.DB.prepare('SELECT id, symbol FROM stocks WHERE id=?').bind(id).first<any>()
  if (!stock) return c.json({ error: '股票不存在' }, 404)
  const symbol = String(stock.symbol ?? '').trim()

  const [financialResult, canonicalResult, revenueRow, epsTrendResult, profileRow] = await Promise.all([
    c.env.DB.prepare(
      'SELECT * FROM financials WHERE stock_id=? ORDER BY period DESC LIMIT ?'
    ).bind(id, limit).all<any>(),
    c.env.DB.prepare(`
      SELECT period, gross_margin, operating_margin, roe, eps, pe, pb,
             dividend_yield, debt_ratio, current_ratio, operating_cash_flow,
             roa, free_cash_flow, capital_amount, common_stock_capital,
             preferred_stock_capital, total_assets, total_liabilities,
             equity_parent, source, as_of_date
        FROM canonical_fundamental_features
       WHERE stock_id = ?
       ORDER BY period DESC, as_of_date DESC
       LIMIT 180
    `).bind(symbol).all<any>().catch(() => ({ results: [] as any[] })),
    c.env.DB.prepare(
      'SELECT date, revenue, revenue_mom, revenue_yoy FROM monthly_revenue WHERE stock_id=? ORDER BY date DESC LIMIT 1'
    ).bind(id).first<any>().catch(() => null),
    c.env.DB.prepare(
      "SELECT period, eps FROM financials WHERE stock_id=? AND eps IS NOT NULL AND period LIKE '%Q%' ORDER BY period DESC LIMIT 4"
    ).bind(id).all<any>().catch(() => ({ results: [] as any[] })),
    c.env.DB.prepare(
      'SELECT financials_summary FROM stock_profiles WHERE symbol=? LIMIT 1'
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
    ? 'finlab.financial_statement.股本'
    : null
  const canonicalSource = canonicalRows.find((row: any) => (
    row.pe != null || row.pb != null || row.dividend_yield != null ||
    row.gross_margin != null || row.operating_margin != null ||
    row.capital_amount != null
  ))?.source ?? null
  const epsTrend = (epsTrendResult.results ?? [])
    .map((row: any) => ({
      period: row.period,
      eps: finiteNumber(row.eps),
    }))
    .filter((row: any) => row.eps != null)

  const baseRows = financialRows.length
    ? financialRows
    : [{
        stock_id: id,
        period: canonicalRows[0]?.period ?? revenueRow?.date ?? null,
        eps: null,
        roe: null,
        pe: null,
        pb: null,
        dividend_yield: null,
        revenue_growth_yoy: null,
        revenue: null,
        operating_income: null,
      }]

  const enriched = baseRows.map((row: any, index: number) => {
    const operatingMargin = operatingMarginFallback ?? operatingMarginFromFinancial(row)
    return {
      ...row,
      eps: index === 0 ? (canonicalEps ?? row.eps ?? null) : row.eps,
      roe: index === 0 ? normalizePercentUnit(canonicalRoe ?? row.roe) : normalizePercentUnit(row.roe),
      pe: index === 0 ? (canonicalPe ?? row.pe ?? null) : row.pe,
      pb: index === 0 ? (canonicalPb ?? row.pb ?? null) : row.pb,
      dividend_yield: index === 0
        ? (canonicalDividendYield ?? normalizePercentUnit(row.dividend_yield, 30))
        : normalizePercentUnit(row.dividend_yield, 30),
      gross_margin: grossMarginFallback,
      operating_margin: operatingMargin,
      revenue_mom: finiteNumber(revenueRow?.revenue_mom),
      revenue_yoy: finiteNumber(revenueRow?.revenue_yoy ?? row.revenue_growth_yoy),
      revenue_month: revenueRow?.date ?? null,
      eps_trend: epsTrend,
      capital_amount: canonicalCapitalAmount,
      capital_source: capitalSource,
      fundamental_source: {
        quarterly: 'financials',
        valuation: canonicalSource ?? 'financials',
        monthly_revenue: revenueRow ? 'monthly_revenue' : null,
        profile: profileMargins.source,
        capital: capitalSource,
      },
      missing_fields: {
        gross_margin: grossMarginFallback == null,
        capital_amount: canonicalCapitalAmount == null,
      },
    }
  })

  return c.json(enriched)
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

  let recommendation = recRow
  if (recRow) {
    const [ensembleRow, perModelRows] = await Promise.all([
      c.env.DB.prepare(`
        SELECT forecast_data
         FROM predictions
         WHERE stock_id = ?
           AND model_name = 'ensemble'
           AND prediction_date = ?
         ORDER BY generated_at DESC, id DESC
         LIMIT 1
      `).bind(id, recRow.date).first<any>().catch(() => null),
      c.env.DB.prepare(`
        SELECT stock_id, model_name, signal_raw, direction_accuracy, forecast_data
          FROM predictions
         WHERE stock_id = ?
           AND model_name != 'ensemble'
           AND model_name NOT LIKE '%::challenger'
           AND prediction_date = ?
         ORDER BY model_name
      `).bind(id, recRow.date).all<any>().then((r) => r.results ?? []).catch(() => []),
    ])
    const forecastData = parsePredictionForecastData(ensembleRow?.forecast_data) ?? {}
    const mlVoteSummary = buildMlVoteSummary(forecastData, perModelRows)
    const watchPoints = (() => {
      try {
        return JSON.parse(recRow.watch_points ?? '[]')
      } catch {
        return []
      }
    })()
    const marketWatchPoint = buildMarketStructureWatchPoint(forecastData.alpha_context)
    const mlWatchPoint = buildMlVoteWatchPoint(mlVoteSummary)
    const enrichedWatchPoints = appendUniqueWatchPoint(
      appendUniqueWatchPoint(Array.isArray(watchPoints) ? watchPoints : [], marketWatchPoint),
      mlWatchPoint,
    )
    recommendation = {
      ...recRow,
      prediction_forecast_data: ensembleRow?.forecast_data ?? null,
      alpha_context: forecastData.alpha_context ?? null,
      alpha_allocation: forecastData.alpha_allocation ?? null,
      ml_vote_summary: mlVoteSummary,
      watch_points: enrichedWatchPoints,
    }
  }

  return c.json({
    symbol: stock.symbol,
    name: stock.name,
    sector: stock.sector,
    market: stock.market,
    recommendation,
    tags: tagsRows,
    chip5d: chipRows,
    profile: profileRow,
    financials: finRow,
  })
})

export { stocks }
