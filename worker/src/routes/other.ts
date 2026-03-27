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
import { rateLimitMiddleware } from '../lib/rateLimit'
import { withCache, TTL } from '../lib/cache'
import { fetchAndStoreStockData, computeAndStoreIndicators } from './stocks'
import {
  generateTechnicalAnalysis,
  generateTradingAdvice,
  generateAnalystSummary,
  answerStockQuestion,
} from '../lib/llm'

// ════════════════════════════════════════════════════════════════════════════
// MARKET routes
// ════════════════════════════════════════════════════════════════════════════
export const market = new Hono<{ Bindings: Bindings; Variables: Variables }>()

market.get('/indices', async (c) => {
  const data = await withCache(c.env.KV, 'market:indices', async () => {
    const fetchIdx = async (symbol: string, name: string) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
        const json = await res.json() as any
        const result = json.chart?.result?.[0]
        if (!result) return null
        const meta   = result.meta ?? {}
        const closes = (result.indicators?.quote?.[0]?.close ?? []).filter((v: any) => v != null)
        const curr   = meta.regularMarketPrice ?? closes[closes.length - 1] ?? 0
        const prev   = closes.length >= 2 ? closes[closes.length - 2] : (meta.chartPreviousClose ?? curr)
        const change = curr - prev, changePct = prev ? (change / prev) * 100 : 0
        return { symbol, name, current: Math.round(curr * 100) / 100, change: Math.round(change * 100) / 100, changePct: Math.round(changePct * 100) / 100 }
      } catch (e) { console.error(`[market] fetchIdx ${symbol} failed:`, e); return null }
    }
    const [twii, twoii] = await Promise.all([fetchIdx('^TWII', '加權指數'), fetchIdx('^TWOII', '櫃買指數')])
    return { twii, twoii, updatedAt: new Date().toISOString() }
  }, TTL.MARKET)
  return c.json(data)
})

// ════════════════════════════════════════════════════════════════════════════
// LLM routes
// ════════════════════════════════════════════════════════════════════════════
export const llm = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// LLM 費用最貴，全部端點限速（10次/分鐘/IP）並要求登入
llm.use('/*', rateLimitMiddleware('llm'))

// Helper: build snapshot + rich context from DB
async function buildSnapshot(db: D1Database, stockId: number) {
  const [stock, latestPrice, latestInd, prediction, factor, risk,
         recentNews, marketRisk, modelAccuracy, stockMemories, recentPredictions] = await Promise.all([
    db.prepare('SELECT * FROM stocks WHERE id=?').bind(stockId).first<any>(),
    db.prepare('SELECT * FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 1').bind(stockId).first<any>(),
    db.prepare('SELECT * FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 1').bind(stockId).first<any>(),
    db.prepare('SELECT * FROM predictions WHERE stock_id=? ORDER BY generated_at DESC LIMIT 1').bind(stockId).first<any>(),
    db.prepare('SELECT * FROM factor_scores WHERE stock_id=? ORDER BY date DESC LIMIT 1').bind(stockId).first<any>(),
    db.prepare("SELECT * FROM risk_metrics WHERE stock_id=? AND period='1y' ORDER BY calculated_at DESC LIMIT 1").bind(stockId).first<any>(),
    // rich context
    db.prepare("SELECT title, sentiment, published_at FROM news WHERE stock_id=? ORDER BY published_at DESC LIMIT 7").bind(stockId).all<any>(),
    db.prepare("SELECT risk_level, risk_score, risk_summary FROM market_risk ORDER BY date DESC LIMIT 1").all<any>(),
    db.prepare("SELECT model_name, accuracy, total_count, period FROM model_accuracy WHERE stock_id=? AND period IN ('30d','all') ORDER BY period, model_name").bind(stockId).all<any>(),
    db.prepare("SELECT memory_type, content FROM stock_memories WHERE stock_id=? ORDER BY updated_at DESC LIMIT 5").bind(stockId).all<any>(),
    db.prepare("SELECT trade_signal as signal, direction_correct, generated_at FROM predictions WHERE stock_id=? ORDER BY generated_at DESC LIMIT 5").bind(stockId).all<any>(),
  ])

  if (!stock) return null

  const rich = {
    recentNews: recentNews?.results?.map((n: any) => ({
      title: n.title, sentiment: n.sentiment, publishedAt: n.published_at,
    })) ?? null,
    marketRisk: marketRisk?.results?.[0] ? {
      riskLevel: marketRisk.results[0].risk_level,
      riskScore: marketRisk.results[0].risk_score,
      riskSummary: marketRisk.results[0].risk_summary,
    } : null,
    modelAccuracy: modelAccuracy?.results?.map((a: any) => ({
      modelName: a.model_name, accuracy: a.accuracy,
      totalCount: a.total_count, period: a.period,
    })) ?? null,
    stockMemories: stockMemories?.results?.map((m: any) => ({
      memoryType: m.memory_type, content: m.content,
    })) ?? null,
    recentPredictions: recentPredictions?.results?.map((p: any) => ({
      signal: p.signal, direction_correct: p.direction_correct, generatedAt: p.generated_at,
    })) ?? null,
  }

  return {
    stock, rich, snapshot: {
      symbol: stock.symbol, name: stock.name,
      currentPrice: latestPrice?.close ?? 0,
      ma5: latestInd?.ma5, ma10: latestInd?.ma10, ma20: latestInd?.ma20, ma60: latestInd?.ma60,
      rsi14: latestInd?.rsi14, macd: latestInd?.macd, macdSignal: latestInd?.macd_signal, macdHist: latestInd?.macd_hist,
      bbUpper: latestInd?.bb_upper, bbMid: latestInd?.bb_mid, bbLower: latestInd?.bb_lower, atr14: latestInd?.atr14,
      compositeScore: factor?.composite_score, quantile: factor?.quantile,
      zMomentum: factor?.z_momentum, zValue: factor?.z_value, zQuality: factor?.z_quality,
      sharpeRatio: risk?.sharpe_ratio, maxDrawdown: risk?.max_drawdown, beta: risk?.beta, var95: risk?.var95,
      tradeSignal: prediction?.trade_signal, entryPrice: prediction?.entry_price,
      stopLoss: prediction?.stop_loss, target1: prediction?.target1, target2: prediction?.target2,
    }
  }
}

llm.post('/technical-analysis', authMiddleware, async (c) => {
  const { stockId } = await c.req.json()
  const result = await buildSnapshot(c.env.DB, stockId)
  if (!result) return c.json({ error: '股票不存在' }, 404)
  const analysis = await generateTechnicalAnalysis(c.env.ANTHROPIC_API_KEY, result.snapshot, result.rich)
  return c.json({ analysis })
})

llm.post('/trading-advice', authMiddleware, async (c) => {
  const { stockId } = await c.req.json()
  const result = await buildSnapshot(c.env.DB, stockId)
  if (!result) return c.json({ error: '股票不存在' }, 404)
  const advice = await generateTradingAdvice(c.env.ANTHROPIC_API_KEY, result.snapshot, result.rich)
  return c.json({ advice })
})

llm.post('/analyst-summary', authMiddleware, async (c) => {
  const { stockId } = await c.req.json()
  const result = await buildSnapshot(c.env.DB, stockId)
  if (!result) return c.json({ error: '股票不存在' }, 404)

  const [latestFin, latestChip] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM financials WHERE stock_id=? ORDER BY period DESC LIMIT 1').bind(stockId).first<any>(),
    c.env.DB.prepare('SELECT * FROM chip_data WHERE stock_id=? ORDER BY date DESC LIMIT 1').bind(stockId).first<any>(),
  ])

  const financials = latestFin ? { eps: latestFin.eps, pe: latestFin.pe, pb: latestFin.pb, roe: latestFin.roe, dividendYield: latestFin.dividend_yield, revenueGrowth: latestFin.revenue_growth_yoy ? latestFin.revenue_growth_yoy / 100 : null } : null
  const chipData   = latestChip ? { foreignNetBuy: latestChip.foreign_net, investmentTrustNetBuy: latestChip.trust_net, dealerNetBuy: latestChip.dealer_net, marginBalance: latestChip.margin_balance } : null

  const summary = await generateAnalystSummary(c.env.ANTHROPIC_API_KEY, { snapshot: result.snapshot, financials, chipData, rich: result.rich })
  return c.json({ summary })
})

llm.post('/ask', authMiddleware, async (c) => {
  const { stockId, question, conversationHistory } = await c.req.json()
  if (!question?.trim()) return c.json({ error: '請輸入問題' }, 400)

  const result = await buildSnapshot(c.env.DB, stockId)
  if (!result) return c.json({ error: '股票不存在' }, 404)

  const [latestFin, latestChip] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM financials WHERE stock_id=? ORDER BY period DESC LIMIT 1').bind(stockId).first<any>(),
    c.env.DB.prepare('SELECT * FROM chip_data WHERE stock_id=? ORDER BY date DESC LIMIT 1').bind(stockId).first<any>(),
  ])

  const answer = await answerStockQuestion(c.env.ANTHROPIC_API_KEY, {
    question,
    snapshot: result.snapshot,
    financials: latestFin ? { eps: latestFin.eps, pe: latestFin.pe, dividendYield: latestFin.dividend_yield, roe: latestFin.roe } : null,
    chipData: latestChip ? { foreignNetBuy: latestChip.foreign_net, marginBalance: latestChip.margin_balance } : null,
    conversationHistory,
  })
  return c.json({ answer })
})

// ════════════════════════════════════════════════════════════════════════════
// WATCHLIST routes
// ════════════════════════════════════════════════════════════════════════════
export const watchlist = new Hono<{ Bindings: Bindings; Variables: Variables }>()
watchlist.use('*', authMiddleware)

// GET /api/watchlist — 回傳用戶追蹤清單（含股票基本資訊 + 最新報價）
watchlist.get('/', async (c) => {
  const userId = c.get('userId')
  const { results } = await c.env.DB.prepare(`
    SELECT w.stock_id, w.cost_price, w.shares, w.note,
           s.symbol, s.name, s.market, s.sector,
           p.close, p.open, p.high, p.low, p.volume,
           ROUND((p.close - p2.close) / p2.close * 100, 2) as change_pct
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    LEFT JOIN (SELECT stock_id, close, open, high, low, volume FROM stock_prices
               WHERE (stock_id, date) IN (SELECT stock_id, MAX(date) FROM stock_prices GROUP BY stock_id)) p
      ON p.stock_id = w.stock_id
    LEFT JOIN (SELECT stock_id, close, date FROM stock_prices
               WHERE (stock_id, date) IN (
                 SELECT stock_id, MAX(date) FROM stock_prices
                 WHERE date < (SELECT MAX(date) FROM stock_prices sp2 WHERE sp2.stock_id = stock_prices.stock_id)
                 GROUP BY stock_id
               )) p2 ON p2.stock_id = w.stock_id
    WHERE w.user_id = ?
    ORDER BY w.created_at DESC
  `).bind(userId).all()
  return c.json(results ?? [])
})

watchlist.get('/:stockId', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT * FROM watchlist WHERE user_id=? AND stock_id=?'
  ).bind(c.get('userId'), parseInt(c.req.param('stockId'))).first()
  return c.json(row ?? null)
})

watchlist.put('/:stockId', async (c) => {
  const userId  = c.get('userId')
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const { costPrice, shares, note } = await c.req.json()
  await c.env.DB.prepare(
    `INSERT INTO watchlist (user_id, stock_id, cost_price, shares, note)
     VALUES (?,?,?,?,?)
     ON CONFLICT(user_id, stock_id) DO UPDATE SET
       cost_price=excluded.cost_price, shares=excluded.shares,
       note=excluded.note, updated_at=datetime('now')`
  ).bind(userId, stockId, costPrice ?? null, shares ?? null, note ?? null).run()
  return c.json({ success: true })
})

// POST /api/watchlist/:stockId — 快速加入追蹤（不需 body）
watchlist.post('/:stockId', async (c) => {
  const userId  = c.get('userId')
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO watchlist (user_id, stock_id) VALUES (?,?)`
  ).bind(userId, stockId).run()
  return c.json({ success: true })
})

// DELETE /api/watchlist/:stockId — 移除追蹤
watchlist.delete('/:stockId', async (c) => {
  const userId  = c.get('userId')
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  await c.env.DB.prepare(
    'DELETE FROM watchlist WHERE user_id=? AND stock_id=?'
  ).bind(userId, stockId).run()
  return c.json({ success: true })
})

// ════════════════════════════════════════════════════════════════════════════
// ALERTS routes
// ════════════════════════════════════════════════════════════════════════════
export const alerts = new Hono<{ Bindings: Bindings; Variables: Variables }>()
alerts.use('*', authMiddleware)

alerts.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT a.*, s.symbol, s.name FROM alert_rules a JOIN stocks s ON a.stock_id=s.id WHERE a.user_id=? AND a.is_active=1'
  ).bind(c.get('userId')).all()
  return c.json(results)
})

alerts.post('/', async (c) => {
  const userId = c.get('userId')
  const { stockId, ruleType, threshold } = await c.req.json()

  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM alert_rules WHERE user_id=? AND is_active=1'
  ).bind(userId).first<{ cnt: number }>()
  if ((count?.cnt ?? 0) >= 20) return c.json({ error: '最多設定 20 個警報' }, 400)

  await c.env.DB.prepare(
    'INSERT INTO alert_rules (user_id, stock_id, rule_type, threshold) VALUES (?,?,?,?)'
  ).bind(userId, stockId, ruleType, threshold ?? null).run()
  return c.json({ success: true }, 201)
})

alerts.delete('/:id', async (c) => {
  const userId = c.get('userId')
  await c.env.DB.prepare(
    'UPDATE alert_rules SET is_active=0 WHERE id=? AND user_id=?'
  ).bind(parseInt(c.req.param('id')), userId).run()
  return c.json({ success: true })
})

// ════════════════════════════════════════════════════════════════════════════
// NEWS routes
// ════════════════════════════════════════════════════════════════════════════
import { crawlAndStoreNews, extractKeywords } from '../lib/news'
export const news = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// GET /api/news/:stockId/crawl  →  手動觸發爬蟲
news.post('/:stockId/crawl', authMiddleware, async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const stock = await c.env.DB.prepare('SELECT * FROM stocks WHERE id=?').bind(stockId).first<any>()
  if (!stock) return c.json({ error: '股票不存在' }, 404)
  const result = await crawlAndStoreNews(c.env.DB, stock)
  return c.json({ success: true, count: result.count })
})

// GET /api/news/:stockId/sentiment  →  情感統計摘要
news.get('/:stockId/sentiment', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const days = parsePosInt(c.req.query('days'), 30)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

  const { results } = await c.env.DB.prepare(
    `SELECT sentiment, COUNT(*) as count FROM news
     WHERE stock_id=? AND published_at>=? GROUP BY sentiment`
  ).bind(stockId, since).all<any>()

  const summary = { positive: 0, neutral: 0, negative: 0, total: 0 }
  for (const r of results) {
    summary[r.sentiment as keyof typeof summary] = r.count
    summary.total += r.count
  }
  return c.json(summary)
})

// GET /api/news/:stockId/trend  →  30日情感趨勢（每日統計）
news.get('/:stockId/trend', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const days = parsePosInt(c.req.query('days'), 30)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

  const { results } = await c.env.DB.prepare(
    `SELECT date(published_at) as date, sentiment, COUNT(*) as count
     FROM news WHERE stock_id=? AND published_at>=?
     GROUP BY date(published_at), sentiment ORDER BY date`
  ).bind(stockId, since).all<any>()

  // pivot: { date, positive, neutral, negative }
  const byDate = new Map<string, { positive: number; neutral: number; negative: number }>()
  for (const r of results) {
    if (!byDate.has(r.date)) byDate.set(r.date, { positive: 0, neutral: 0, negative: 0 })
    byDate.get(r.date)![r.sentiment as 'positive'|'neutral'|'negative'] = r.count
  }
  const trend = Array.from(byDate.entries()).map(([date, v]) => ({ date, ...v }))
  return c.json(trend)
})

// GET /api/news/:stockId/keywords  →  關鍵字詞頻統計
news.get('/:stockId/keywords', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const days = parsePosInt(c.req.query('days'), 30)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]

  const { results } = await c.env.DB.prepare(
    `SELECT title, summary FROM news WHERE stock_id=? AND published_at>=?`
  ).bind(stockId, since).all<any>()

  const keywords = extractKeywords(results)
  return c.json(keywords)
})

// ════════════════════════════════════════════════════════════════════════════
// ML PREDICTION routes  (proxy → Cloud Run Python)
// ════════════════════════════════════════════════════════════════════════════
export const ml = new Hono<{ Bindings: Bindings; Variables: Variables }>()

ml.use('/*', authMiddleware)

// POST /api/ml/predict/:stockId
ml.post('/predict/:stockId', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const mlUrl = (c.env as any).ML_SERVICE_URL
  if (!mlUrl) return c.json({ error: 'ML service not configured' }, 503)

  // ── Step 1：基礎資料查詢 ──────────────────────────────────────────────────
  const [stock, prices, indicators, chips, news, modelAccRows, marketRiskRow] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM stocks WHERE id=?').bind(stockId).first<any>(),
    c.env.DB.prepare('SELECT date, close, high, low, open, volume FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stockId).all<any>(),
    c.env.DB.prepare('SELECT date, ma5, ma10, ma20, ma60, rsi14, macd_hist as macdHist, bb_upper, bb_lower, atr14 FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stockId).all<any>(),
    c.env.DB.prepare('SELECT date, foreign_net, trust_net, dealer_net FROM chip_data WHERE stock_id=? ORDER BY date DESC LIMIT 200').bind(stockId).all<any>(),
    c.env.DB.prepare('SELECT date(published_at) as date, AVG(CASE sentiment WHEN \'positive\' THEN 1 WHEN \'negative\' THEN -1 ELSE 0 END) as score FROM news WHERE stock_id=? GROUP BY date(published_at) ORDER BY date DESC LIMIT 90').bind(stockId).all<any>(),
    // 各模型 30d 準確率（供 weighted_vote 動態加權）
    c.env.DB.prepare("SELECT model_name, accuracy FROM model_accuracy WHERE stock_id=? AND period='30d'").bind(stockId).all<any>(),
    // 當前市場風險環境（供 HMM Regime / LinUCB bandit context）
    c.env.DB.prepare('SELECT risk_level, risk_score, twii_bias AS twii_bias_20d, twii_close FROM market_risk ORDER BY date DESC LIMIT 1').first<any>(),
  ])

  if (!stock) return c.json({ error: 'Stock not found' }, 404)

  // ── Step 2：新股票自動初始化（資料不足 60 筆時）───────────────────────────
  let priceRows = prices.results ?? []
  let indRows   = indicators.results ?? []

  if (priceRows.length < 60) {
    console.log(`[ML predict] ${stock.symbol} 資料不足（${priceRows.length} 筆），自動觸發初始化...`)
    try {
      // 從 FinMind / Yahoo 抓最近 365 天資料（約 3-5 秒）
      await fetchAndStoreStockData(c.env.DB, c.env.KV, stock, (c.env as any).FINMIND_TOKEN)
      // 計算技術指標（約 1 秒）
      await computeAndStoreIndicators(c.env.DB, stockId)

      // 重新查詢
      const [p2, i2] = await Promise.all([
        c.env.DB.prepare('SELECT date, close, high, low, open, volume FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stockId).all<any>(),
        c.env.DB.prepare('SELECT date, ma5, ma10, ma20, ma60, rsi14, macd_hist as macdHist, bb_upper, bb_lower, atr14 FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stockId).all<any>(),
      ])
      priceRows = p2.results ?? []
      indRows   = i2.results ?? []
    } catch (e) {
      console.error(`[ML predict] 自動初始化失敗 ${stock.symbol}:`, e)
    }

    // 初始化後仍不足，代表市場無此資料或 FinMind 額度耗盡
    if (priceRows.length < 60) {
      return c.json({
        error: `${stock.symbol} 歷史資料不足（取得 ${priceRows.length} 筆，需 60+ 筆）。` +
               `可能原因：股票代碼錯誤、FinMind Token 未設定、或資料來源暫無資料。`,
        symbol: stock.symbol,
        data_count: priceRows.length,
      }, 422)
    }

    // 初始化成功 → 繼續往下執行 ML 預測（不 early return，讓流程一次完成）
    console.log(`[ML predict] ${stock.symbol} 初始化完成（${priceRows.length} 筆），繼續 ML 預測...`)
  }

  // ── Step 3：組裝完整 payload（含動態加權欄位）───────────────────────────────

  // real_accuracies: { "KalmanFilter": 0.65, ... }
  const realAccuracies: Record<string, number> = {}
  for (const row of (modelAccRows.results ?? []) as any[]) {
    if (row.model_name && row.accuracy != null) {
      realAccuracies[row.model_name] = parseFloat(row.accuracy)
    }
  }

  // market_env: 傳入最新市場風險指標，供 HMM Regime 偵測 + LinUCB context
  const marketEnv = marketRiskRow ? {
    risk_level:      marketRiskRow.risk_level,
    risk_score:      marketRiskRow.risk_score,
    twii_bias_20d:   marketRiskRow.twii_bias_20d ?? 0,
  } : null

  const payload = {
    stock_id:         stockId,
    symbol:           stock.symbol,
    prices:           priceRows.slice().reverse(),
    indicators:       indRows.slice().reverse(),
    chips:            (chips.results ?? []).slice().reverse(),
    sentiment_scores: (news.results ?? []).slice().reverse(),
    horizon:          14,
    real_accuracies:  realAccuracies,   // ✅ 動態準確率加權
    market_env:       marketEnv,        // ✅ HMM Regime + LinUCB context
    // model_stats（profit_factor / expectancy）目前 D1 無此欄位，保留空物件
  }

  try {
    const cacheKey = `ml:predict:${stockId}`
    // POST = 用戶主動觸發 → 不讀 cache（GET 才讀 cache）

    const mlHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
    if ((c.env as any).ML_SERVICE_SECRET) mlHeaders['X-Service-Token'] = (c.env as any).ML_SERVICE_SECRET

    const res = await fetch(`${mlUrl}/predict`, {
      method: 'POST',
      headers: mlHeaders,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),  // 90s timeout（Modal cold start 可能需要 30-60s）
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`ML service HTTP ${res.status}: ${errText.slice(0, 200)}`)
    }
    const data = await res.json()

    // 快取 1 小時（供 GET 讀取）
    await c.env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 3600 })

    // 儲存預測結果到 D1
    const d = data as any
    if (d.signal && d.forecasts) {
      await c.env.DB.prepare(
        `INSERT OR REPLACE INTO predictions
         (stock_id, model_name, horizon, direction_accuracy, forecast_data, trade_signal, entry_price, stop_loss, target1, target2, best_model, created_at)
         VALUES (?, 'Ensemble', 14, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`
      ).bind(
        stockId,
        d.confidence ?? 0,
        JSON.stringify({ forecasts: d.forecasts, models: d.models, signal: d.signal }),
        d.signal,
        d.entry_price,
        d.stop_loss,
        d.target1,
        d.target2,
      ).run()
    }

    return c.json(data)
  } catch (e: any) {
    const msg = e?.name === 'AbortError'
      ? `ML 預測逾時（90s），可能是 cold start。請 1 分鐘後重試。`
      : `ML 預測失敗：${e?.message?.slice(0, 200) ?? '未知錯誤'}`
    console.error(`[ML predict] ${stock.symbol}:`, e?.message)
    return c.json({ error: msg, symbol: stock.symbol }, 502)
  }
})

// GET /api/ml/predict/:stockId  →  取最新快取結果
ml.get('/predict/:stockId', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const cached = await c.env.KV.get(`ml:predict:${stockId}`)
  if (cached) return c.json(JSON.parse(cached))

  // 從 D1 取最新儲存的預測（model_name 存入時為 'ensemble' 小寫）
  const row = await c.env.DB.prepare(
    `SELECT * FROM predictions WHERE stock_id=? AND model_name='ensemble' ORDER BY generated_at DESC LIMIT 1`
  ).bind(stockId).first<any>()

  if (!row) return c.json({ error: 'No prediction available' }, 404)
  const fd = JSON.parse(row.forecast_data ?? '{}')
  return c.json({
    signal: row.trade_signal,
    entry_price: parseFloat(row.entry_price),
    stop_loss: parseFloat(row.stop_loss),
    target1: parseFloat(row.target1),
    target2: parseFloat(row.target2),
    confidence: row.direction_accuracy,
    forecasts: fd.forecasts ?? [],
    models: fd.models ?? [],
    reasoning: fd.signal ?? '',
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Market Risk routes
// ════════════════════════════════════════════════════════════════════════════

// GET /api/market/risk — 取最新大盤風險（快取30分鐘）
market.get('/risk', async (c) => {
  const cacheKey = 'market:risk:latest'
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json(JSON.parse(cached))

  // 從 D1 取最新一筆
  const row = await c.env.DB.prepare(
    'SELECT * FROM market_risk ORDER BY date DESC LIMIT 1'
  ).first<any>()

  if (!row) return c.json({ error: '尚無大盤風險資料，請等待排程執行' }, 404)

  const data = {
    date:                   row.date,
    vix:                    row.vix,
    vixLevel:               row.vix_level,
    twiiClose:              row.twii_close,
    twiiVol20:              row.twii_vol20,
    twiiMa20:               row.twii_ma20,
    twiiBias:              row.twii_bias,
    foreignConsecutiveSell: row.foreign_consecutive_sell,
    foreignNet5d:           row.foreign_net_5d,
    marginRatio:            row.margin_ratio,
    limitDownCount:         row.limit_down_count,
    limitDownPct:           row.limit_down_pct,
    riskScore:              row.risk_score,
    riskLevel:              row.risk_level,
    riskSummary:            row.risk_summary,
    calculatedAt:           row.calculated_at,
  }

  await c.env.KV.put(cacheKey, JSON.stringify(data), { expirationTtl: 1800 })
  return c.json(data)
})

// GET /api/market/risk/history?days=30 — 歷史風險趨勢
market.get('/risk/history', async (c) => {
  const days = Math.min(parsePosInt(c.req.query('days'), 30), 90)
  const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]
  const { results } = await c.env.DB.prepare(
    `SELECT date, risk_score, risk_level, vix, twii_close, twii_vol20, twii_bias,
            foreign_consecutive_sell, foreign_net_5d
     FROM market_risk WHERE date >= ? ORDER BY date ASC`
  ).bind(since).all<any>()
  return c.json(results ?? [])
})




// ─── 聊天對話持久化 ────────────────────────────────────────────────────────────
export const chat = new Hono<{ Bindings: Bindings; Variables: Variables }>()
// GET  /api/chat/sessions?stockId=   取對話列表（userId 從 JWT 取，非 query param）
// GET  /api/chat/sessions/:id/messages       取對話訊息
// POST /api/chat/sessions                    建立 session
// POST /api/chat/sessions/:id/messages       新增訊息（user + assistant）
// DELETE /api/chat/sessions/:id              刪除對話

chat.use('/*', authMiddleware)

chat.get('/sessions', async (c) => {
  // Fix: userId 從 JWT 取，不信任 query param
  const userId  = String(c.get('userId'))
  const stockId = c.req.query('stockId')
  const { results } = await c.env.DB.prepare(`
    SELECT cs.*, s.symbol, s.name as stock_name,
           (SELECT content FROM chat_messages WHERE session_id=cs.id ORDER BY created_at DESC LIMIT 1) as last_message
    FROM chat_sessions cs
    LEFT JOIN stocks s ON cs.stock_id = s.id
    WHERE cs.user_id=? ${stockId ? 'AND cs.stock_id=?' : ''}
    ORDER BY cs.updated_at DESC LIMIT 20
  `).bind(...(stockId ? [userId, parseInt(stockId)] : [userId])).all<any>()
  return c.json(results ?? [])
})

chat.get('/sessions/:id/messages', async (c) => {
  const sessionId = parseId(c.req.param('id'))
  if (!sessionId) return c.json({ error: '無效 ID' }, 400)

  // Fix IDOR: 確認 session 屬於當前用戶
  const session = await c.env.DB.prepare(
    'SELECT user_id FROM chat_sessions WHERE id=?'
  ).bind(sessionId).first<{ user_id: string }>()
  if (!session) return c.json({ error: '對話不存在' }, 404)
  if (String(session.user_id) !== String(c.get('userId'))) {
    return c.json({ error: '無權限' }, 403)
  }

  const before = parseId(c.req.query('before'))  // 往前翻頁：載入比此 ID 更早的訊息
  const limit  = Math.min(parsePosInt(c.req.query('limit'), 50), 100)

  const { results } = await c.env.DB.prepare(
    before
      ? 'SELECT id, role, content, created_at FROM chat_messages WHERE session_id=? AND id < ? ORDER BY id DESC LIMIT ?'
      : 'SELECT id, role, content, created_at FROM chat_messages WHERE session_id=? ORDER BY id DESC LIMIT ?'
  ).bind(...(before ? [sessionId, before, limit] : [sessionId, limit])).all<any>()

  // 回傳時反轉為時間正序（前端顯示用）
  return c.json((results ?? []).reverse())
})

chat.post('/sessions', async (c) => {
  // Fix: userId 永遠從 JWT 取
  const userId  = String(c.get('userId'))
  const { stockId, title } = await c.req.json()
  const result = await c.env.DB.prepare(`
    INSERT INTO chat_sessions (user_id, stock_id, title) VALUES (?,?,?)
  `).bind(userId, stockId ?? null, title ?? null).run()
  return c.json({ id: result.meta?.last_row_id, userId, stockId })
})

chat.post('/sessions/:id/messages', async (c) => {
  const sessionId = parseId(c.req.param('id'))
  if (!sessionId) return c.json({ error: '無效 ID' }, 400)

  // Fix IDOR: 確認 session 屬於當前用戶
  const session = await c.env.DB.prepare(
    'SELECT user_id FROM chat_sessions WHERE id=?'
  ).bind(sessionId).first<{ user_id: string }>()
  if (!session) return c.json({ error: '對話不存在' }, 404)
  if (String(session.user_id) !== String(c.get('userId'))) {
    return c.json({ error: '無權限' }, 403)
  }

  const { role, content } = await c.req.json()
  if (!['user', 'assistant'].includes(role) || !content) {
    return c.json({ error: 'invalid role or content' }, 400)
  }

  // Fix: 限制 content 長度，防止超大 payload 塞滿 D1
  const safeContent = typeof content === 'string' ? content.slice(0, 8000) : ''
  if (!safeContent) return c.json({ error: 'content 不可為空' }, 400)

  await c.env.DB.prepare(
    'INSERT INTO chat_messages (session_id, role, content) VALUES (?,?,?)'
  ).bind(sessionId, role, safeContent).run()
  await c.env.DB.prepare(
    "UPDATE chat_sessions SET updated_at=datetime('now') WHERE id=?"
  ).bind(sessionId).run()
  return c.json({ ok: true })
})

chat.delete('/sessions/:id', async (c) => {
  const sessionId = parseId(c.req.param('id'))
  if (!sessionId) return c.json({ error: '無效 ID' }, 400)

  // Fix IDOR: 確認 session 屬於當前用戶（或 admin 可刪任何 session）
  const session = await c.env.DB.prepare(
    'SELECT user_id FROM chat_sessions WHERE id=?'
  ).bind(sessionId).first<{ user_id: string }>()
  if (!session) return c.json({ error: '對話不存在' }, 404)
  const isAdmin = c.get('userRole') === 'admin'
  if (!isAdmin && String(session.user_id) !== String(c.get('userId'))) {
    return c.json({ error: '無權限' }, 403)
  }

  await c.env.DB.prepare('DELETE FROM chat_sessions WHERE id=?').bind(sessionId).run()
  return c.json({ ok: true })
})

// ─── 交易模擬損益查詢 ──────────────────────────────────────────────────────────
ml.use('/trade-performance/*', rateLimitMiddleware('api'))
ml.use('/trade-history/*', rateLimitMiddleware('api'))
// system-logs 只有 admin 能看（包含內部 Cron 錯誤細節）
ml.use('/system-logs*', adminMiddleware)


// GET /api/ml/system-logs
ml.get('/system-logs', async (c) => {
  const limit = parsePosInt(c.req.query('limit'), 50)
  const level = c.req.query('level')  // filter by 'error' | 'warn' | 'info'
  const whereLevel = level ? `AND level=?` : ''
  const params = level ? [limit, level] : [limit]
  const { results } = await c.env.DB.prepare(`
    SELECT * FROM system_logs
    ${level ? 'WHERE level=?' : ''}
    ORDER BY created_at DESC LIMIT ?
  `).bind(...(level ? [level, limit] : [limit])).all<any>()
  return c.json(results ?? [])
})

ml.get('/trade-performance/:stockId', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const { results } = await c.env.DB.prepare(`
    SELECT tp.*,
           ma.accuracy, ma.profit_factor as acc_profit_factor
    FROM trade_performance tp
    LEFT JOIN model_accuracy ma
      ON tp.stock_id = ma.stock_id AND tp.model_name = ma.model_name AND ma.period = tp.period
    WHERE tp.stock_id=?
    ORDER BY tp.period, tp.profit_factor DESC NULLS LAST
  `).bind(stockId).all<any>()
  return c.json(results ?? [])
})

ml.get('/trade-performance/global', async (c) => {
  // 全局績效統計（所有股票加總）
  const { results } = await c.env.DB.prepare(`
    SELECT model_name, period,
           SUM(total_trades)  as total_trades,
           SUM(win_trades)    as win_trades,
           SUM(total_pnl_pct) as total_pnl,
           ROUND(CAST(SUM(win_trades) AS REAL) / SUM(total_trades), 3) as win_rate,
           AVG(profit_factor) as avg_profit_factor,
           AVG(expectancy)    as avg_expectancy,
           AVG(avg_pnl_r)     as avg_r
    FROM trade_performance
    WHERE total_trades >= 5
    GROUP BY model_name, period
    ORDER BY period, avg_profit_factor DESC NULLS LAST
  `).all<any>()
  return c.json(results ?? [])
})

// 某支股票的逐筆模擬交易記錄
ml.get('/trade-history/:stockId', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const limit   = parsePosInt(c.req.query('limit'), 50)
  const { results } = await c.env.DB.prepare(`
    SELECT generated_at, model_name, trade_signal,
           predicted_direction, actual_direction, direction_correct,
           entry_price, stop_loss, target1, target2,
           trade_outcome, trade_pnl_pct, trade_pnl_r,
           max_favorable_pct, max_adverse_pct,
           actual_return_pct, market_risk_level, verified_at
    FROM predictions
    WHERE stock_id=? AND trade_pnl_pct IS NOT NULL
    ORDER BY generated_at DESC
    LIMIT ?
  `).bind(stockId, limit).all<any>()
  return c.json(results ?? [])
})

// ─── ML 準確率查詢 ────────────────────────────────────────────────────────────
ml.get('/accuracy/:stockId', async (c) => {
  const stockId = parseId(c.req.param('stockId'))
  if (!stockId) return c.json({ error: '無效 ID' }, 400)
  const { results } = await c.env.DB.prepare(`
    SELECT model_name, accuracy, total_count, correct_count, avg_price_error, period, last_updated
    FROM model_accuracy
    WHERE stock_id=?
    ORDER BY period, accuracy DESC
  `).bind(stockId).all<any>()
  return c.json(results ?? [])
})

ml.get('/accuracy/global', async (c) => {
  // 跨所有股票的準確率統計
  const { results } = await c.env.DB.prepare(`
    SELECT model_name, period,
           SUM(total_count) as total, SUM(correct_count) as correct,
           ROUND(CAST(SUM(correct_count) AS REAL) / SUM(total_count), 3) as accuracy
    FROM model_accuracy
    WHERE total_count >= 5
    GROUP BY model_name, period
    ORDER BY period, accuracy DESC
  `).all<any>()
  return c.json(results ?? [])
})

// ════════════════════════════════════════════════════════════════════════════
// Notification routes  GET /api/notifications
// ════════════════════════════════════════════════════════════════════════════
export const notifications = new Hono<{ Bindings: Bindings; Variables: Variables }>()
notifications.use('/*', authMiddleware)

// GET /api/notifications — 未讀通知列表
notifications.get('/', async (c) => {
  const userId = c.get('userId')
  const { results } = await c.env.DB.prepare(
    `SELECT id, stock_symbol, rule_type, threshold, triggered_price, created_at
     FROM alert_notifications WHERE user_id=? AND is_read=0
     ORDER BY created_at DESC LIMIT 20`
  ).bind(userId).all<any>()
  return c.json(results ?? [])
})

// GET /api/notifications/count — 未讀數量（badge 用）
notifications.get('/count', async (c) => {
  const userId = c.get('userId')
  const row = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM alert_notifications WHERE user_id=? AND is_read=0'
  ).bind(userId).first<{ cnt: number }>()
  return c.json({ count: row?.cnt ?? 0 })
})

// POST /api/notifications/read-all — 全部標為已讀
notifications.post('/read-all', async (c) => {
  const userId = c.get('userId')
  await c.env.DB.prepare(
    "UPDATE alert_notifications SET is_read=1 WHERE user_id=? AND is_read=0"
  ).bind(userId).run()
  return c.json({ success: true })
})

// ════════════════════════════════════════════════════════════════════════════
// System Status  GET /api/system/status
// ════════════════════════════════════════════════════════════════════════════
export const system = new Hono<{ Bindings: Bindings; Variables: Variables }>()

system.get('/status', async (c) => {
  const db = c.env.DB

  // 查各資料表最新一筆的日期
  const [
    latestPrice,
    latestChip,
    latestNews,
    latestPrediction,
    latestMarketRisk,
    totalStocks,
    totalNews,
    dbSize,
  ] = await Promise.all([
    db.prepare('SELECT MAX(date) as d, COUNT(*) as cnt FROM stock_prices').first<any>(),
    db.prepare('SELECT MAX(date) as d FROM chip_data').first<any>(),
    db.prepare('SELECT MAX(published_at) as d, COUNT(*) as cnt FROM news').first<any>(),
    db.prepare('SELECT MAX(generated_at) as d FROM predictions').first<any>(),
    db.prepare('SELECT date, risk_level, risk_score, calculated_at FROM market_risk ORDER BY date DESC LIMIT 1').first<any>(),
    db.prepare('SELECT COUNT(*) as cnt FROM stocks WHERE is_active=1').first<any>(),
    db.prepare('SELECT COUNT(*) as cnt FROM news').first<any>(),
    db.prepare("SELECT SUM(pgsize * ncell) as sz FROM dbstat").first<any>().catch(() => null),
  ])

  // 判斷各資料是否為今日（台灣交易日）
  const today     = new Date().toISOString().split('T')[0]
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
  const isRecent  = (dateStr: string | null, allowYesterday = true) => {
    if (!dateStr) return false
    const d = dateStr.split('T')[0]
    return d === today || (allowYesterday && d === yesterday)
  }

  const priceDate      = latestPrice?.d ?? null
  const chipDate       = latestChip?.d ?? null
  const newsDate       = latestNews?.d ? latestNews.d.split('T')[0] : null
  const predictionDate = latestPrediction?.d ? latestPrediction.d.split('T')[0] : null
  const riskDate       = latestMarketRisk?.date ?? null

  // 整體狀態：全部都有今日或昨日資料才算 ok
  const priceOk      = isRecent(priceDate)
  const chipOk       = isRecent(chipDate)
  const newsOk       = isRecent(newsDate)
  const predOk       = isRecent(predictionDate)
  const riskOk       = isRecent(riskDate)

  const allOk    = priceOk && chipOk
  const hasWarn  = !priceOk || !chipOk

  return c.json({
    overall: allOk ? 'ok' : hasWarn ? 'warning' : 'stale',
    updatedAt: new Date().toISOString(),
    data: {
      prices: {
        lastDate:  priceDate,
        isRecent:  priceOk,
        rowCount:  latestPrice?.cnt ?? 0,
      },
      chips: {
        lastDate:  chipDate,
        isRecent:  chipOk,
      },
      news: {
        lastDate:  newsDate,
        isRecent:  newsOk,
        rowCount:  totalNews?.cnt ?? 0,
      },
      predictions: {
        lastDate:  predictionDate,
        isRecent:  predOk,
      },
      marketRisk: {
        lastDate:    riskDate,
        isRecent:    riskOk,
        riskLevel:   latestMarketRisk?.risk_level ?? null,
        riskScore:   latestMarketRisk?.risk_score ?? null,
        calculatedAt: latestMarketRisk?.calculated_at ?? null,
      },
    },
    meta: {
      activeStocks: totalStocks?.cnt ?? 0,
      dbSizeBytes:  dbSize?.sz ?? null,
    },
  })
})


// ══════════════════════════════════════════════════════════════════════════════
// 每日選股推薦 & 族群資金流向
// ══════════════════════════════════════════════════════════════════════════════
export const recommendations = new Hono<{ Bindings: Bindings; Variables: Variables }>()

recommendations.use('/*', authMiddleware)

// GET /api/recommendations/daily?date=YYYY-MM-DD
// 取當日（或指定日期）的選股推薦
recommendations.get('/daily', async (c) => {
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) // TW date
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, s.market
    FROM daily_recommendations r
    LEFT JOIN stocks s ON s.id = r.stock_id
    WHERE r.date = ?
    ORDER BY r.rank ASC
    LIMIT 10
  `).bind(date).all<any>()

  // 解析 watch_points JSON
  const recs = (results ?? []).map((r: any) => ({
    ...r,
    watch_points: (() => { try { return JSON.parse(r.watch_points ?? '[]') } catch { return [] } })(),
  }))

  return c.json({
    date,
    recommendations: recs,
    generated_at: recs[0]?.created_at ?? null,
  })
})

// GET /api/recommendations/history?days=7
// 近 N 天的推薦歷史（用於追蹤推薦準確率）
recommendations.get('/history', async (c) => {
  const days = Math.min(parsePosInt(c.req.query('days'), 7), 30)
  const { results } = await c.env.DB.prepare(`
    SELECT r.date, r.symbol, r.name, r.sector, r.rank, r.score,
           r.signal, r.confidence, r.has_buy_signal,
           r.current_price,
           -- 回測：推薦後實際表現（從 predictions 取）
           p.actual_return_pct, p.direction_correct, p.trade_outcome
    FROM daily_recommendations r
    LEFT JOIN predictions p
      ON p.stock_id = r.stock_id
      AND p.generated_at >= r.date
      AND p.generated_at < date(r.date, '+1 day')
    WHERE r.date >= date('now', '-' || ? || ' days')
    ORDER BY r.date DESC, r.rank ASC
  `).bind(days).all<any>()
  return c.json(results ?? [])
})

// GET /api/recommendations/sector-flow?date=YYYY-MM-DD
// 族群資金流向（可指定日期，預設今日）
recommendations.get('/sector-flow', async (c) => {
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) // TW date
  const { results } = await c.env.DB.prepare(`
    SELECT *
    FROM sector_flow
    WHERE date = ?
    ORDER BY total_net DESC
    LIMIT 20
  `).bind(date).all<any>()

  // 若今天沒資料，取最近一筆
  if (!results?.length) {
    const { results: latest } = await c.env.DB.prepare(`
      SELECT *
      FROM sector_flow
      WHERE date = (SELECT MAX(date) FROM sector_flow)
      ORDER BY total_net DESC
      LIMIT 20
    `).all<any>()
    return c.json({ date: 'latest', flows: latest ?? [] })
  }

  return c.json({ date, flows: results })
})

// GET /api/recommendations/sector-trend?sector=半導體&days=14
// 單一族群的資金流向趨勢
recommendations.get('/sector-trend', async (c) => {
  const sector = c.req.query('sector')
  const days   = Math.min(parsePosInt(c.req.query('days'), 14), 60)
  if (!sector) return c.json({ error: '請提供 sector 參數' }, 400)

  const { results } = await c.env.DB.prepare(`
    SELECT date, foreign_net, trust_net, total_net, avg_rsi, avg_momentum_5d, up_count, stock_count
    FROM sector_flow
    WHERE sector = ? AND date >= date('now', '-' || ? || ' days')
    ORDER BY date ASC
  `).bind(sector, days).all<any>()
  return c.json({ sector, days, trend: results ?? [] })
})
