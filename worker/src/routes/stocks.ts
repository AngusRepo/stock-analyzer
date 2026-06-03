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
import {
  appendUniqueWatchPoint,
  buildMarketStructureWatchPoint,
  buildMlVoteSummary,
  buildMlVoteWatchPoint,
  parsePredictionForecastData,
} from '../lib/recommendationContext'
import { computeAndStoreIndicators } from '../lib/technicalIndicators'
import { readScoreV2Snapshot, serializeScoreV2Snapshot, type ScoreV2StorageRow } from '../lib/scoreV2Taxonomy'

const stocks = new Hono<{ Bindings: Bindings; Variables: Variables }>()

type StockAiRecommendationRow = ScoreV2StorageRow & {
  date: string
  symbol: string
  name: string
  sector: string | null
  rank: number | null
  signal: string | null
  confidence: number | null
  reason: string | null
  watch_points: string | null
  current_price: number | null
  alpha_context: string | null
  alpha_allocation: string | null
  ml_vote_summary: string | null
}

function shapeStockAiRecommendation(row: StockAiRecommendationRow, extra: Record<string, unknown> = {}) {
  const snapshot = readScoreV2Snapshot(row)
  const scoreV2 = snapshot ? serializeScoreV2Snapshot(snapshot) : null
  return {
    date: row.date,
    symbol: row.symbol,
    name: row.name,
    sector: row.sector,
    rank: row.rank,
    signal: row.signal,
    confidence: row.confidence,
    reason: row.reason,
    watch_points: row.watch_points,
    current_price: row.current_price,
    score: scoreV2?.finalScore ?? null,
    score_v2: scoreV2,
    alpha_context: row.alpha_context,
    alpha_allocation: row.alpha_allocation,
    ml_vote_summary: row.ml_vote_summary,
    ...extra,
  }
}

async function latestStockChipDate(db: D1Database, symbol: string): Promise<string | null> {
  const canonical = await db.prepare(
    'SELECT date FROM canonical_chip_daily WHERE stock_id=? ORDER BY date DESC LIMIT 1',
  ).bind(symbol).first<{ date: string }>().catch(() => null)
  if (canonical?.date) return canonical.date
  const legacy = await db.prepare(
    'SELECT date FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 1',
  ).bind(symbol).first<{ date: string }>().catch(() => null)
  return legacy?.date ?? null
}

async function loadCanonicalStockFundamentals(db: D1Database, symbol: string, limit: number): Promise<any[]> {
  const { results } = await db.prepare(`
    SELECT stock_id AS symbol,
           period,
           market_segment,
           report_date,
           available_date,
           revenue_growth_yoy,
           gross_margin,
           operating_margin,
           roe,
           eps,
           pe,
           pb,
           dividend_yield,
           debt_ratio,
           current_ratio,
           operating_cash_flow,
           industry_quality_percentile,
           source,
           as_of_date
      FROM canonical_fundamental_features
     WHERE stock_id=?
       AND source='finlab.fundamental_factor_diversity'
     ORDER BY available_date DESC, period DESC
     LIMIT ?
  `).bind(symbol, limit).all<any>()
  return results ?? []
}

async function loadCanonicalStockChips(db: D1Database, symbol: string, since: string): Promise<any[]> {
  const { results } = await db.prepare(`
    SELECT date,
           stock_id AS symbol,
           foreign_net,
           trust_net,
           dealer_net,
           margin_balance,
           short_balance,
           source,
           as_of_date,
           'canonical-first' AS source_path,
           NULL AS fallback_reason
      FROM canonical_chip_daily
     WHERE stock_id=?
       AND date>=?
     ORDER BY date
  `).bind(symbol, since).all<any>()
  return results ?? []
}

async function loadCanonicalStockMargin(db: D1Database, symbol: string, limit: number): Promise<any[]> {
  const { results } = await db.prepare(`
    SELECT date,
           NULL AS margin_buy,
           NULL AS margin_sell,
           margin_balance,
           NULL AS short_buy,
           NULL AS short_sell,
           short_balance,
           NULL AS margin_usage_pct,
           CASE
             WHEN margin_balance IS NOT NULL AND margin_balance > 0 AND short_balance IS NOT NULL
             THEN short_balance / margin_balance
             ELSE NULL
           END AS short_ratio,
           source,
           as_of_date,
           'canonical-first' AS source_path,
           NULL AS fallback_reason
      FROM canonical_chip_daily
     WHERE stock_id=?
       AND (margin_balance IS NOT NULL OR short_balance IS NOT NULL)
     ORDER BY date DESC
     LIMIT ?
  `).bind(symbol, limit).all<any>()
  return results ?? []
}

async function loadCanonicalStockChipNetSummary(db: D1Database, symbol: string, limit: number): Promise<any | null> {
  const canonical = await db.prepare(`
    SELECT SUM(foreign_net) AS foreign_net,
           SUM(trust_net) AS trust_net,
           SUM(dealer_net) AS dealer_net,
           'canonical-first' AS source_path
      FROM (
        SELECT foreign_net,
               trust_net,
               dealer_net
          FROM canonical_chip_daily
         WHERE stock_id=?
         ORDER BY date DESC
         LIMIT ?
      )
  `).bind(symbol, limit).first<any>().catch(() => null)
  if (canonical && (canonical.foreign_net != null || canonical.trust_net != null || canonical.dealer_net != null)) {
    return canonical
  }
  return await db.prepare(`
    SELECT SUM(foreign_net) as foreign_net,
           SUM(trust_net) as trust_net,
           SUM(dealer_net) as dealer_net,
           'legacy.chip_data' AS source_path
      FROM (
        SELECT foreign_buy - foreign_sell as foreign_net,
               trust_buy - trust_sell as trust_net,
               dealer_buy - dealer_sell as dealer_net
          FROM chip_data
         WHERE symbol=?
         ORDER BY date DESC
         LIMIT ?
      )
  `).bind(symbol, limit).first<any>().catch(() => null)
}

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
    latestStockChipDate(c.env.DB, row.symbol),
    c.env.DB.prepare('SELECT generated_at FROM predictions WHERE stock_id=? ORDER BY generated_at DESC LIMIT 1').bind(id).first<any>(),
  ])

  return c.json({
    ...row,
    latestPriceDate:      latestPrice?.date ?? null,
    latestChipDate:       latestChip ?? null,
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

  const stock = await c.env.DB.prepare('SELECT symbol FROM stocks WHERE id=?').bind(id).first<{ symbol: string }>()
  if (!stock) return c.json({ error: 'stock_not_found' }, 404)
  return c.json(await loadCanonicalStockFundamentals(c.env.DB, stock.symbol, limit))
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

  const canonical = await loadCanonicalStockChips(c.env.DB, stock.symbol, since).catch(() => [])
  if (canonical.length) return c.json(canonical)

  const { results } = await c.env.DB.prepare(
    `SELECT *,
            'legacy.chip_data' AS source_path,
            'canonical_chip_daily missing for requested stock/date window' AS fallback_reason
       FROM chip_data
      WHERE symbol=? AND date>=?
      ORDER BY date`
  ).bind(stock.symbol, since).all()
  return c.json(results ?? [])
})

// ─── GET /api/stocks/:id/broker-flow?days=60 ─────────────────────────────────
stocks.get('/:id/broker-flow', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const stock = await c.env.DB.prepare('SELECT symbol FROM stocks WHERE id=?').bind(id).first<any>()
  if (!stock) return c.json({ error: '股票不存在' }, 404)
  const days = parsePosInt(c.req.query('days'), 60)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT date, market_segment, net_shares, estimated_amount,
              broker_count, concentration, source, as_of_date
         FROM canonical_broker_flow_daily
        WHERE stock_id=? AND date>=?
        ORDER BY date`,
    ).bind(stock.symbol, since).all()
    return c.json(results ?? [])
  } catch (error) {
    console.warn(`[BrokerFlow] optional canonical_broker_flow_daily unavailable for stock_id=${id}:`, error)
    return c.json([])
  }
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

  const history = await loadCanonicalStockFundamentals(c.env.DB, stock.symbol, 8)
  const current = history[0] ?? null

  return c.json({ stock, current, history })
})

// ─── POST /api/stocks/:id/refresh (admin only) ────────────────────────────────
stocks.post('/:id/refresh', authMiddleware, adminMiddleware, async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const stock = await c.env.DB.prepare('SELECT * FROM stocks WHERE id=?').bind(id).first<any>()
  if (!stock) return c.json({ error: '股票不存在' }, 404)

  return c.json({
    error: 'finlab_primary_manual_refresh_disabled',
    message: 'Manual per-stock Yahoo/FinMind refresh is disabled. Use the FinLab daily primary backfill or canonical D1 repair path.',
    symbol: stock.symbol,
  }, 410)
})

// ─── GET /api/stocks/:id/margin?days=60 ─────────────────────────────────────
stocks.get('/:id/margin', async (c) => {
  const id = parseId(c.req.param('id'))
  if (!id) return c.json({ error: '無效 ID' }, 400)
  const days = parsePosInt(c.req.query('days'), 60)
  const stock = await c.env.DB.prepare('SELECT symbol FROM stocks WHERE id=?').bind(id).first<any>()
  if (!stock) return c.json({ error: '找不到股票' }, 404)

  const canonical = await loadCanonicalStockMargin(c.env.DB, stock.symbol, days).catch(() => [])
  if (canonical.length) return c.json(canonical)

  const { results } = await c.env.DB.prepare(
    `SELECT date,
            margin_buy,
            margin_sell,
            margin_balance,
            short_buy,
            short_sell,
            short_balance,
            margin_usage_pct,
            short_ratio,
            'legacy.margin_data' AS source_path,
            'canonical_chip_daily margin/short missing for requested stock/date window' AS fallback_reason
       FROM margin_data
      WHERE stock_id=?
      ORDER BY date DESC
      LIMIT ?`
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
      `SELECT date, symbol, name, sector, rank, signal, confidence, reason,
              watch_points, current_price, alpha_context, alpha_allocation,
              ml_vote_summary, score_components
         FROM daily_recommendations
        WHERE symbol=?
        ORDER BY date DESC
        LIMIT 1`
    ).bind(stock.symbol).first<StockAiRecommendationRow>().catch(() => null),
    // 概念標籤
    c.env.DB.prepare(
      'SELECT tag, weight FROM stock_tags WHERE symbol=? ORDER BY weight DESC'
    ).bind(stock.symbol).all<any>().then(r => r.results ?? []).catch(() => []),
    // 近 5 日法人
    loadCanonicalStockChipNetSummary(c.env.DB, stock.symbol, 5),
    // 公司概況
    c.env.DB.prepare(
      'SELECT business_desc, key_customers, key_suppliers FROM stock_profiles WHERE symbol=?'
    ).bind(stock.symbol).first<any>().catch(() => null),
    // FinLab canonical fundamentals.
    loadCanonicalStockFundamentals(c.env.DB, stock.symbol, 1).then(rows => rows[0] ?? null).catch(() => null),
  ])

  let recommendation = recRow ? shapeStockAiRecommendation(recRow) : null
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
          AND instr(model_name, '::') = 0
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
    recommendation = shapeStockAiRecommendation(recRow, {
      prediction_forecast_data: ensembleRow?.forecast_data ?? null,
      alpha_context: forecastData.alpha_context ?? null,
      alpha_allocation: forecastData.alpha_allocation ?? null,
      ml_vote_summary: mlVoteSummary,
      watch_points: enrichedWatchPoints,
    })
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
