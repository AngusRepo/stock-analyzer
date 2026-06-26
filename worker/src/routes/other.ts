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
import { fetchAndStoreStockData } from './stocks'
import { computeAndStoreIndicators } from '../lib/technicalIndicators'
import {
  generateTechnicalAnalysis,
  generateTradingAdvice,
  generateAnalystSummary,
  answerStockQuestion,
} from '../lib/llm'
import {
  buildHardGateSummary,
  buildSparseAllocationSummary,
  buildMlDiagnostics,
  buildMlVoteSummary,
  compactRecommendationForCard,
  DIRECT_ALPHA_VOTE_MODEL_NAMES,
  parsePredictionForecastData,
} from '../lib/recommendationContext'
import { getTradingConfig } from '../lib/tradingConfig'
import { classifyBoard, resolveRecommendationGovernance } from '../lib/boardTradability'
import { summarizeScreenerFunnelRows, summarizeStrategyPortfolioIntelligenceHealth } from '../lib/screenerFunnelEvidence'
import { readMarketRegimeState } from '../lib/marketRegimeState'
import {
  buildMarketRegimeFactorPacket,
  loadMarketRegimeFactorPacket,
  upsertMarketRegimeFactorPacket,
} from '../lib/marketRegimeFactorPacket'
import { buildMarketOptimisticOutlook } from '../lib/marketOutlook'
import { loadRecommendationEvidenceLinks } from '../lib/recommendationEvidenceLinks'
import { SCORE_V2_VERSION } from '../lib/scoreV2Taxonomy'
import { getAdaptiveParamsForRegime } from '../lib/adaptiveConfig'

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

// ── LLM KV 快取：同一天同一支股票不重複打 Anthropic API ──────────────────────
const llmCacheKey = (type: string, stockId: number) => {
  const twDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  return `llm:${type}:${stockId}:${twDate}`
}

llm.post('/technical-analysis', authMiddleware, async (c) => {
  const { stockId } = await c.req.json()
  const cacheKey = llmCacheKey('tech', stockId)
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json({ analysis: cached, cached: true })

  const result = await buildSnapshot(c.env.DB, stockId)
  if (!result) return c.json({ error: '股票不存在' }, 404)
  const analysis = await generateTechnicalAnalysis(c.env.ANTHROPIC_API_KEY, result.snapshot, result.rich)
  await c.env.KV.put(cacheKey, analysis, { expirationTtl: 86400 })
  return c.json({ analysis })
})

llm.post('/trading-advice', authMiddleware, async (c) => {
  const { stockId } = await c.req.json()
  const cacheKey = llmCacheKey('trade', stockId)
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json({ advice: cached, cached: true })

  const result = await buildSnapshot(c.env.DB, stockId)
  if (!result) return c.json({ error: '股票不存在' }, 404)
  const advice = await generateTradingAdvice(c.env.ANTHROPIC_API_KEY, result.snapshot, result.rich)
  await c.env.KV.put(cacheKey, advice, { expirationTtl: 86400 })
  return c.json({ advice })
})

llm.post('/analyst-summary', authMiddleware, async (c) => {
  const { stockId } = await c.req.json()
  const cacheKey = llmCacheKey('summary', stockId)
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json({ summary: cached, cached: true })

  const result = await buildSnapshot(c.env.DB, stockId)
  if (!result) return c.json({ error: '股票不存在' }, 404)

  const [latestFin, latestChip] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM financials WHERE stock_id=? ORDER BY period DESC LIMIT 1').bind(stockId).first<any>(),
    c.env.DB.prepare('SELECT * FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 1').bind(result.stock.symbol).first<any>(),
  ])

  const financials = latestFin ? { eps: latestFin.eps, pe: latestFin.pe, pb: latestFin.pb, roe: latestFin.roe, dividendYield: latestFin.dividend_yield, revenueGrowth: latestFin.revenue_growth_yoy ? latestFin.revenue_growth_yoy / 100 : null } : null
  const chipData   = latestChip ? { foreignNetBuy: latestChip.foreign_net, investmentTrustNetBuy: latestChip.trust_net, dealerNetBuy: latestChip.dealer_net, marginBalance: latestChip.margin_balance } : null

  const summary = await generateAnalystSummary(c.env.ANTHROPIC_API_KEY, { snapshot: result.snapshot, financials, chipData, rich: result.rich })
  await c.env.KV.put(cacheKey, summary, { expirationTtl: 86400 })
  return c.json({ summary })
})

llm.post('/ask', authMiddleware, async (c) => {
  const { stockId, question, conversationHistory } = await c.req.json()
  if (!question?.trim()) return c.json({ error: '請輸入問題' }, 400)

  const result = await buildSnapshot(c.env.DB, stockId)
  if (!result) return c.json({ error: '股票不存在' }, 404)

  const [latestFin, latestChip] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM financials WHERE stock_id=? ORDER BY period DESC LIMIT 1').bind(stockId).first<any>(),
    c.env.DB.prepare('SELECT * FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 1').bind(result.stock.symbol).first<any>(),
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
           COALESCE(p.avg_price, p.close) as close, p.open, p.high, p.low, p.volume,
           ROUND((COALESCE(p.avg_price, p.close) - COALESCE(p2.avg_price, p2.close)) / COALESCE(p2.avg_price, p2.close) * 100, 2) as change_pct,
           (SELECT GROUP_CONCAT(tag, ',') FROM (SELECT tag FROM stock_tags WHERE symbol = s.symbol ORDER BY weight DESC LIMIT 3)) as tags
    FROM watchlist w
    JOIN stocks s ON s.id = w.stock_id
    LEFT JOIN (SELECT stock_id, close, open, high, low, volume FROM stock_prices
               WHERE (stock_id, date) IN (SELECT stock_id, MAX(date) FROM stock_prices GROUP BY stock_id)) p
      ON p.stock_id = w.stock_id
    LEFT JOIN (SELECT stock_id, close, avg_price, date FROM stock_prices
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
  const stock = await c.env.DB.prepare('SELECT * FROM stocks WHERE id=?').bind(stockId).first<any>()
  if (!stock) return c.json({ error: 'Stock not found' }, 404)

  const [prices, indicators, chips, news, modelAccRows, marketRiskRow] = await Promise.all([
    c.env.DB.prepare('SELECT date, close, high, low, open, volume FROM stock_prices WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stockId).all<any>(),
    c.env.DB.prepare('SELECT date, ma5, ma10, ma20, ma60, rsi14, macd_hist as macdHist, bb_upper, bb_lower, atr14, plus_di14 as plusDi14, minus_di14 as minusDi14, adx14, parabolic_sar as parabolicSar, cci20, volume_weighted_rsi14 as volumeWeightedRsi14, volume_momentum_divergence_13_27_10 as volumeMomentumDivergence132710 FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stockId).all<any>(),
    c.env.DB.prepare('SELECT date, foreign_net, trust_net, dealer_net FROM chip_data WHERE symbol=? ORDER BY date DESC LIMIT 200').bind(stock.symbol).all<any>(),
    c.env.DB.prepare('SELECT date(published_at) as date, AVG(CASE sentiment WHEN \'positive\' THEN 1 WHEN \'negative\' THEN -1 ELSE 0 END) as score FROM news WHERE stock_id=? GROUP BY date(published_at) ORDER BY date DESC LIMIT 90').bind(stockId).all<any>(),
    // 各模型 30d 準確率（供 weighted_vote 動態加權）
    c.env.DB.prepare("SELECT model_name, accuracy FROM model_accuracy WHERE stock_id=? AND period='30d'").bind(stockId).all<any>(),
    // 當前市場風險環境（供 HMM Regime / LinUCB bandit context）
    c.env.DB.prepare('SELECT risk_level, risk_score, twii_bias AS twii_bias_20d, twii_close FROM market_risk ORDER BY date DESC LIMIT 1').first<any>(),
  ])

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
        c.env.DB.prepare('SELECT date, ma5, ma10, ma20, ma60, rsi14, macd_hist as macdHist, bb_upper, bb_lower, atr14, plus_di14 as plusDi14, minus_di14 as minusDi14, adx14, parabolic_sar as parabolicSar, cci20, volume_weighted_rsi14 as volumeWeightedRsi14, volume_momentum_divergence_13_27_10 as volumeMomentumDivergence132710 FROM technical_indicators WHERE stock_id=? ORDER BY date DESC LIMIT 500').bind(stockId).all<any>(),
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
  const [tradingConfig, adaptiveParams] = await Promise.all([
    getTradingConfig(c.env.KV),
    getAdaptiveParamsForRegime(c.env.KV),
  ])

  const payload = {
    stock_id:         stockId,
    symbol:           stock.symbol,
    prices:           priceRows.slice().reverse(),
    indicators:       indRows.slice().reverse(),
    chips:            (chips.results ?? []).slice().reverse(),
    sentiment_scores: (news.results ?? []).slice().reverse(),
    horizon:          14,
    trading_config:   tradingConfig,
    adaptive_params:  adaptiveParams,
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
  const cacheKey = 'market:risk:latest:v7-market-outlook'
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json(JSON.parse(cached))

  // 從 D1 取最新一筆
  const row = await c.env.DB.prepare(
    'SELECT * FROM market_risk ORDER BY date DESC LIMIT 1'
  ).first<any>()

  if (!row) return c.json({ error: '尚無大盤風險資料，請等待排程執行' }, 404)

  const regimeState = await readMarketRegimeState(c.env.KV).catch(() => null)
  const factor = (
    id: string,
    label: string,
    value: string,
    status: 'ok' | 'warn' | 'error' | 'info' | 'missing',
    source: string,
    detail = '',
  ) => ({ id, label, value, status, source, detail })
  const numberOrNull = (value: unknown): number | null => {
    if (value == null) return null
    if (typeof value === 'string' && value.trim() === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const formatPct = (value: number | null, digits = 2) => value == null ? 'n/a' : `${value.toFixed(digits)}%`
  const formatBillion = (value: number | null) => value == null ? 'n/a' : `${value.toFixed(1)}億`
  const twiiBias = numberOrNull(row.twii_bias)
  const foreignNet5d = numberOrNull(row.foreign_net_5d)
  const marginRatio = numberOrNull(row.margin_ratio)
  const limitDownPct = numberOrNull(row.limit_down_pct)
  const regimeSurface = regimeState?.regime_surface ?? {}
  const monitors = regimeState?.monitors ?? {}
  const transitionGuard = regimeState?.transition_guard ?? {}
  const legacyContextFactors = [
    factor('price_trend', '價格趨勢', formatPct(twiiBias), twiiBias == null ? 'missing' : twiiBias < -3 ? 'error' : twiiBias < -1 ? 'warn' : 'ok', 'market_risk.twii_bias', `TWII close ${row.twii_close ?? 'n/a'} vs MA20 ${row.twii_ma20 ?? 'n/a'}`),
    factor('volatility', '波動', row.vix != null ? `VIX ${Number(row.vix).toFixed(1)}` : `${Number(row.twii_vol20 ?? 0).toFixed(2)}%`, String(row.vix_level ?? '').toLowerCase().includes('high') ? 'warn' : 'info', 'market_risk.vix_twii_vol20'),
    factor('breadth', '市場廣度', formatPct(limitDownPct), limitDownPct == null ? 'missing' : limitDownPct > 3 ? 'error' : limitDownPct > 1 ? 'warn' : 'ok', 'market_risk.limit_down_pct', `limit_down_count=${row.limit_down_count ?? 'n/a'}`),
    factor('chips', '籌碼', formatBillion(foreignNet5d), foreignNet5d == null ? 'missing' : foreignNet5d < 0 ? 'warn' : 'ok', 'market_risk.foreign_net_5d', `foreign_consecutive_sell=${row.foreign_consecutive_sell ?? 0}`),
    factor('leverage', '槓桿', formatPct(marginRatio), marginRatio == null ? 'missing' : marginRatio > 40 ? 'warn' : 'info', 'market_risk.margin_ratio'),
    factor('regime', 'Regime', regimeState?.label ?? 'missing', regimeState ? (regimeState.family === 'bear' ? 'warn' : 'ok') : 'error', regimeState?.source === 'legacy_label' ? 'legacy_regime_fallback' : 'market_regime_state', `run_date=${regimeState?.run_date ?? 'missing'}`),
    factor('global_risk', '全球風險', String((monitors as any).global_event_pressure ?? (regimeSurface as any).global_risk ?? 'context'), (regimeSurface as any).global_risk > 0.6 ? 'warn' : 'info', 'market_regime_state.monitors'),
    factor('lppls', 'LPPLS', String((monitors as any).lppls ?? 'context'), (transitionGuard as any).bubble_risk ? 'warn' : 'info', 'market_regime_state.monitors.lppls'),
    factor('hawkes', 'Hawkes', String((monitors as any).hawkes ?? 'context'), (transitionGuard as any).contagion_risk ? 'warn' : 'info', 'market_regime_state.monitors.hawkes'),
  ]
  let factorPacket = await buildMarketRegimeFactorPacket(c.env.DB, row, regimeState).catch(() => null)
  if (factorPacket) {
    await upsertMarketRegimeFactorPacket(c.env.DB, factorPacket).catch(() => {})
  } else {
    factorPacket = await loadMarketRegimeFactorPacket(c.env.DB, row.date).catch(() => null)
  }
  const contextFactors = factorPacket?.factors ?? legacyContextFactors
  const marketOutlook = buildMarketOptimisticOutlook({
    marketRiskRow: row,
    regimeState,
    factorPacket,
  })
  const packetSummary = factorPacket
    ? `V4 weighted factors: ${factorPacket.factors.map((item) => `${item.label} ${item.value}`).join(' / ')} | ${marketOutlook.summary}`
    : row.risk_summary

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
    riskScore:              factorPacket?.score ?? row.risk_score,
    riskLevel:              factorPacket?.level ?? row.risk_level,
    riskSummary:            packetSummary,
    calculatedAt:           row.calculated_at,
    regimeState: regimeState ? {
      label: regimeState.label,
      family: regimeState.family,
      runDate: regimeState.run_date,
      computedAt: regimeState.computed_at,
      source: regimeState.source,
      regimeSurface: regimeState.regime_surface,
      transitionGuard: regimeState.transition_guard,
      monitors: regimeState.monitors,
    } : null,
    marketOutlook,
    factorPacket,
    contextFactors,
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

// GET /api/market/ex-dividend — 除權除息預告（KV 快取，Wave2 每日更新）
market.get('/ex-dividend', async (c) => {
  const raw = await c.env.KV.get('market:ex_dividend_forecast')
  if (!raw) return c.json([])
  return c.json(JSON.parse(raw))
})

// GET /api/market/attention-stocks — 注意股清單（KV 快取，Wave2 每日更新）
market.get('/attention-stocks', async (c) => {
  const raw = await c.env.KV.get('market:attention_stocks')
  if (!raw) return c.json([])
  return c.json(JSON.parse(raw))
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
    db.prepare('SELECT COUNT(*) as cnt FROM stocks WHERE in_current_watchlist=1').first<any>(),
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

const FINAL_RECOMMENDATION_WHERE = "signal IS NOT NULL AND confidence IS NOT NULL AND score_components LIKE '%score_v2%'"
const FINAL_RECOMMENDATION_ROW_WHERE = "r.signal IS NOT NULL AND r.confidence IS NOT NULL AND r.score_components LIKE '%score_v2%'"

function isEmergingRecommendation(row: Record<string, any>): boolean {
  return String(row.recommendation_lane ?? '').toLowerCase() === 'emerging_watchlist'
    || String(row.market_segment ?? '').toUpperCase() === 'EMERGING'
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

type InstitutionalRawCardRow = {
  key: string
  label: string
  buy_shares: number | null
  sell_shares: number | null
  net_shares: number | null
}

function buildInstitutionalRawToday(row: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!row) return null
  const rows: InstitutionalRawCardRow[] = [
    {
      key: 'foreign',
      label: '外資',
      buy_shares: finiteNumber(row.foreign_buy),
      sell_shares: finiteNumber(row.foreign_sell),
      net_shares: finiteNumber(row.foreign_net),
    },
    {
      key: 'trust',
      label: '投信',
      buy_shares: finiteNumber(row.trust_buy),
      sell_shares: finiteNumber(row.trust_sell),
      net_shares: finiteNumber(row.trust_net),
    },
    {
      key: 'dealer',
      label: '自營商',
      buy_shares: finiteNumber(row.dealer_buy),
      sell_shares: finiteNumber(row.dealer_sell),
      net_shares: finiteNumber(row.dealer_net),
    },
  ]
  const hasData = rows.some((item) => (
    item.buy_shares != null || item.sell_shares != null || item.net_shares != null
  ))
  if (!hasData) return null
  return {
    schema_version: 'institutional_raw_card_v1',
    date: String(row.date ?? ''),
    source: 'chip_data',
    unit: 'shares',
    rows,
    total_net_shares: rows.reduce((sum, item) => sum + (item.net_shares ?? 0), 0),
  }
}

function normalizeBrokerRankRow(row: Record<string, any>): Record<string, any> {
  return {
    rank: finiteNumber(row.rank_no),
    broker_code: row.broker_code == null ? null : String(row.broker_code),
    broker_name: row.broker_name == null ? null : String(row.broker_name),
    buy_lots: finiteNumber(row.buy_lots ?? row.buy_shares),
    sell_lots: finiteNumber(row.sell_lots ?? row.sell_shares),
    net_lots: finiteNumber(row.net_lots ?? row.net_shares),
  }
}

function buildBrokerTopFlowsToday(
  row: Record<string, any> | null | undefined,
  date: string,
  rankRows: Record<string, any>[] = [],
): Record<string, any> {
  const topBuy = rankRows
    .filter((rankRow) => String(rankRow.rank_side ?? '').toLowerCase() === 'buy')
    .sort((a, b) => Number(a.rank_no ?? 999) - Number(b.rank_no ?? 999))
    .slice(0, 3)
    .map(normalizeBrokerRankRow)
  const topSell = rankRows
    .filter((rankRow) => String(rankRow.rank_side ?? '').toLowerCase() === 'sell')
    .sort((a, b) => Number(a.rank_no ?? 999) - Number(b.rank_no ?? 999))
    .slice(0, 3)
    .map(normalizeBrokerRankRow)
  if (!row) {
    return {
      schema_version: 'broker_top_flows_card_v1',
      date,
      source: 'canonical_broker_flow_daily',
      unit: 'lots',
      top_buy: topBuy,
      top_sell: topSell,
      aggregate: null,
      missing_reason: topBuy.length || topSell.length ? null : 'no_canonical_broker_flow_row_for_symbol_date',
      materialization_gap: topBuy.length || topSell.length ? null : 'broker_level_top3_not_materialized_in_d1',
    }
  }
  return {
    schema_version: 'broker_top_flows_card_v1',
    date: String(row.date ?? date),
    source: String(row.source ?? 'canonical_broker_flow_daily'),
    unit: 'lots',
    top_buy: topBuy,
    top_sell: topSell,
    aggregate: {
      market_segment: row.market_segment ?? null,
      buy_lots: finiteNumber(row.buy_shares),
      sell_lots: finiteNumber(row.sell_shares),
      net_lots: finiteNumber(row.net_shares),
      dominant_net_lots: finiteNumber(row.dominant_net_shares),
      gross_imbalance_lots: finiteNumber(row.gross_imbalance_shares),
      estimated_amount: finiteNumber(row.estimated_amount),
      broker_count: finiteNumber(row.broker_count),
      concentration: finiteNumber(row.concentration),
    },
    missing_reason: topBuy.length || topSell.length ? null : 'broker_level_detail_table_missing',
    materialization_gap: topBuy.length || topSell.length
      ? null
      : 'FinLab broker_transactions was compressed into canonical_broker_flow_daily aggregates; broker_code/name top3 rows are not persisted yet.',
  }
}

function formatAbsTwdAmountFromBillion(value: number): string {
  const abs = Math.abs(value)
  if (abs < 0.01 && abs > 0) return `${Math.round(abs * 10_000)}萬`
  return `${abs.toFixed(2)}億`
}

function buildEmergingBrokerEvidence(row: Record<string, any>): Record<string, any> | null {
  if (!isEmergingRecommendation(row)) return null
  const amountBillion = finiteNumber(row.broker_chip_cash_total_5d ?? row.chip_cash_total_5d)
  const netShares = finiteNumber(row.broker_net_shares_5d)
  if ((amountBillion == null || amountBillion === 0) && (netShares == null || netShares === 0)) return null
  const latestAmount = finiteNumber(row.broker_chip_cash_latest)
  const brokerCount = finiteNumber(row.broker_count_latest)
  const concentration = finiteNumber(row.broker_concentration_latest)
  const sourceDate = String(row.broker_flow_source_date ?? row.date ?? '')
  const source = String(row.broker_flow_source ?? 'finlab.rotc_broker_transactions')
  const direction = (amountBillion ?? 0) >= 0 ? '買超' : '賣超'
  const reasonParts = [`券商分點近5日${direction}${formatAbsTwdAmountFromBillion(amountBillion ?? 0)}`]
  if (brokerCount != null) reasonParts.push(`券商數${Math.round(brokerCount)}`)
  if (concentration != null) reasonParts.push(`集中度${concentration.toFixed(2)}`)
  return {
    source,
    source_date: sourceDate,
    broker_net_amount_5d_billion: amountBillion ?? 0,
    broker_net_amount_latest_billion: latestAmount ?? null,
    broker_net_shares_5d: netShares ?? null,
    broker_count_latest: brokerCount ?? null,
    concentration_latest: concentration ?? null,
    reason: reasonParts.join('、'),
  }
}

function isScoreV2Payload(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as any).version === SCORE_V2_VERSION)
}

function normalizeScoreV2ReasonText(reason: unknown): string {
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (!text) return ''
  return text
    .replace(/^【籌碼】[^｜\n]+｜/, '')
    .replace(/【技術】/g, 'Technical:')
    .replace(/【ML】/g, 'ML Edge:')
    .replace(/｜/g, '; ')
    .trim()
}

function mergeEmergingBrokerReason(reason: unknown, evidence: Record<string, any> | null): string | unknown {
  if (!evidence) return reason
  const chipReason = String(evidence.reason ?? '券商分點資料已更新')
  const text = normalizeScoreV2ReasonText(reason)
  if (!text) return `Score V2 Chip Flow evidence: ${chipReason}`
  if (text.includes(chipReason)) return text
  return text.includes('Score V2')
    ? `${text}; Chip Flow evidence: ${chipReason}`
    : `Score V2 Chip Flow evidence: ${chipReason}; ${text}`
}

function mergeEmergingBrokerScoreComponents(scoreComponents: unknown, evidence: Record<string, any> | null): unknown {
  if (!evidence) return scoreComponents
  if (!isScoreV2Payload(scoreComponents)) {
    return scoreComponents ? { ...(scoreComponents as Record<string, any>), chipEvidence: evidence } : null
  }
  const reasons = Array.isArray(scoreComponents.reasons)
    ? scoreComponents.reasons.map(String).filter(Boolean)
    : []
  reasons.push(`chipFlowEvidence:${String(evidence.reason ?? 'broker evidence updated')}`)
  return {
    ...scoreComponents,
    chipEvidence: evidence,
    reasons: Array.from(new Set(reasons)),
  }
}

function mergeEmergingBrokerWatchPoints(points: unknown, evidence: Record<string, any> | null): string[] {
  const list = Array.isArray(points) ? points.map((p) => String(p ?? '')).filter(Boolean) : []
  if (!evidence) return list
  const filtered = list.filter((p) => !p.includes('籌碼資料不足：興櫃或資料源未提供三大法人明細'))
  filtered.push(
    `chip_source=${evidence.source},source_date=${evidence.source_date},broker_net_amount_5d=${evidence.broker_net_amount_5d_billion},broker_net_shares_5d=${evidence.broker_net_shares_5d ?? 'n/a'},broker_count=${evidence.broker_count_latest ?? 'n/a'},concentration=${evidence.concentration_latest ?? 'n/a'}`,
  )
  return Array.from(new Set(filtered))
}

// GET /api/recommendations/daily?date=YYYY-MM-DD
// 不帶 date → 先查今天，沒資料則查上一個交易日（D1 最新有推薦的日期）
recommendations.get('/daily', async (c) => {
  const view = c.req.query('view') === 'card' ? 'card' : 'full'
  let date = c.req.query('date')
  const requestedDate = date
  let resolvedFrom: 'requested' | 'today' | 'fallback_prev' = date ? 'requested' : 'today'
  if (!date) {
    const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    // 先看今天有沒有
    const todayCount = await c.env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM daily_recommendations WHERE date = ? AND ${FINAL_RECOMMENDATION_WHERE}`
    ).bind(twToday).first<{ cnt: number }>()
    if ((todayCount?.cnt ?? 0) > 0) {
      date = twToday
    } else {
      // 沒有 → 查上一個交易日（最新有推薦資料的日期）
      const prev = await c.env.DB.prepare(
        `SELECT date FROM daily_recommendations WHERE date < ? AND ${FINAL_RECOMMENDATION_WHERE} ORDER BY date DESC LIMIT 1`
      ).bind(twToday).first<{ date: string }>()
      date = prev?.date ?? twToday
      if (date !== twToday) resolvedFrom = 'fallback_prev'
    }
  }
  const requestedOrToday = requestedDate ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, s.market, p.forecast_data AS prediction_forecast_data,
           ROUND(COALESCE(r.foreign_net_5d, 0), 6) AS chip_cash_foreign_5d,
           ROUND(COALESCE(r.trust_net_5d, 0), 6) AS chip_cash_trust_5d,
           0 AS dealer_net_5d,
           CASE
             WHEN r.recommendation_lane = 'emerging_watchlist'
               OR UPPER(COALESCE(r.market_segment, '')) = 'EMERGING'
             THEN ROUND(COALESCE((
               SELECT SUM(cbf.estimated_amount)
                 FROM canonical_broker_flow_daily cbf
                WHERE cbf.stock_id = r.symbol
                  AND cbf.date <= r.date
                  AND cbf.date >= date(r.date, '-14 days')
             ), 0) / 100000000.0, 6)
             ELSE ROUND(COALESCE(r.foreign_net_5d, 0) + COALESCE(r.trust_net_5d, 0), 6)
           END AS chip_cash_total_5d,
           ROUND(COALESCE((
             SELECT SUM(cbf.estimated_amount)
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
                AND cbf.date >= date(r.date, '-14 days')
           ), 0) / 100000000.0, 6) AS broker_chip_cash_total_5d,
           ROUND(COALESCE((
             SELECT cbf.estimated_amount
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
              ORDER BY cbf.date DESC
              LIMIT 1
           ), 0) / 100000000.0, 6) AS broker_chip_cash_latest,
           (
             SELECT SUM(cbf.net_shares)
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
                AND cbf.date >= date(r.date, '-14 days')
           ) AS broker_net_shares_5d,
           (
             SELECT cbf.broker_count
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
              ORDER BY cbf.date DESC
              LIMIT 1
           ) AS broker_count_latest,
           (
             SELECT cbf.concentration
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
              ORDER BY cbf.date DESC
              LIMIT 1
           ) AS broker_concentration_latest,
           (
             SELECT cbf.source
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
              ORDER BY cbf.date DESC
              LIMIT 1
           ) AS broker_flow_source,
           (
             SELECT cbf.date
               FROM canonical_broker_flow_daily cbf
              WHERE cbf.stock_id = r.symbol
                AND cbf.date <= r.date
              ORDER BY cbf.date DESC
              LIMIT 1
           ) AS broker_flow_source_date,
           (
             SELECT sp.open
               FROM stock_prices sp
              WHERE sp.stock_id = r.stock_id
                AND sp.date <= r.date
              ORDER BY sp.date DESC
              LIMIT 1
           ) AS latest_open,
           (
             SELECT sp.avg_price
               FROM stock_prices sp
              WHERE sp.stock_id = r.stock_id
                AND sp.date <= r.date
              ORDER BY sp.date DESC
              LIMIT 1
           ) AS latest_avg_price
    FROM daily_recommendations r
    LEFT JOIN stocks s ON s.id = r.stock_id
    LEFT JOIN predictions p ON p.id = (
      SELECT p2.id
        FROM predictions p2
       WHERE p2.stock_id = r.stock_id
         AND p2.model_name = 'ensemble'
         AND p2.prediction_date = r.date
       ORDER BY p2.generated_at DESC, p2.id DESC
       LIMIT 1
    )
    WHERE r.date = ? AND ${FINAL_RECOMMENDATION_ROW_WHERE}
      AND COALESCE(r.recommendation_lane, '') != 'emerging_watchlist'
      AND UPPER(COALESCE(r.market_segment, s.market, '')) NOT IN ('EMERGING', 'ESB', 'ROTC')
    ORDER BY r.rank ASC
    LIMIT 80
  `).bind(date).all<any>()

  const screenerFunnelBySymbol = new Map<string, any>()
  const resultSymbols = [...new Set((results ?? [])
    .map((r: any) => String(r.symbol ?? '').trim())
    .filter(Boolean))]
  const institutionalRawBySymbol = new Map<string, any>()
  const brokerTopFlowsBySymbol = new Map<string, any>()
  const brokerRankRowsBySymbol = new Map<string, any[]>()
  if (resultSymbols.length > 0) {
    const placeholders = resultSymbols.map(() => '?').join(',')
    try {
      const { results: chipRows } = await c.env.DB.prepare(`
        SELECT symbol, date,
               foreign_buy, foreign_sell, foreign_net,
               trust_buy, trust_sell, trust_net,
               dealer_buy, dealer_sell, dealer_net
          FROM chip_data
         WHERE date = ?
           AND symbol IN (${placeholders})
      `).bind(String(date), ...resultSymbols).all<any>()
      for (const row of chipRows ?? []) {
        const payload = buildInstitutionalRawToday(row)
        if (payload) institutionalRawBySymbol.set(String(row.symbol ?? '').trim(), payload)
      }
    } catch (e) {
      console.warn('[recommendations/daily] institutional raw card data unavailable:', e)
    }
    try {
      const rankTable = await c.env.DB.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name = 'canonical_broker_rank_daily'
         LIMIT 1
      `).first<{ name: string }>()
      if (rankTable?.name) {
        const { results: rankRows } = await c.env.DB.prepare(`
          SELECT stock_id, date, market_segment, rank_side, rank_no,
                 broker_code, broker_name, buy_lots, sell_lots, net_lots, source
            FROM canonical_broker_rank_daily
           WHERE date = ?
             AND stock_id IN (${placeholders})
             AND rank_side IN ('buy', 'sell')
           ORDER BY stock_id ASC, rank_side ASC, rank_no ASC
        `).bind(String(date), ...resultSymbols).all<any>()
        for (const row of rankRows ?? []) {
          const symbol = String(row.stock_id ?? '').trim()
          const rows = brokerRankRowsBySymbol.get(symbol) ?? []
          rows.push(row)
          brokerRankRowsBySymbol.set(symbol, rows)
        }
      }
    } catch (e) {
      console.warn('[recommendations/daily] broker top3 rank table unavailable:', e)
    }
    try {
      const { results: brokerRows } = await c.env.DB.prepare(`
        SELECT stock_id, date, market_segment, buy_shares, sell_shares, net_shares,
               dominant_net_shares, gross_imbalance_shares, estimated_amount,
               broker_count, concentration, source
          FROM canonical_broker_flow_daily
         WHERE date = ?
           AND stock_id IN (${placeholders})
      `).bind(String(date), ...resultSymbols).all<any>()
      for (const row of brokerRows ?? []) {
        const symbol = String(row.stock_id ?? '').trim()
        brokerTopFlowsBySymbol.set(
          symbol,
          buildBrokerTopFlowsToday(row, String(date), brokerRankRowsBySymbol.get(symbol) ?? []),
        )
      }
    } catch (e) {
      console.warn('[recommendations/daily] broker flow card data unavailable:', e)
    }
  }
  if (resultSymbols.length > 0) {
    try {
      const placeholders = resultSymbols.map(() => '?').join(',')
      const { results: funnelRows } = await c.env.DB.prepare(`
        WITH latest_screener_run AS (
          SELECT run_id
            FROM screener_funnel_runs
           WHERE date = ?
           ORDER BY created_at DESC
           LIMIT 1
        )
        SELECT symbol, stage, decision, reason_code, score_before, score_after, rank, evidence
          FROM screener_funnel_items
         WHERE run_id = (SELECT run_id FROM latest_screener_run)
           AND symbol IN (${placeholders})
           AND stage IN (
             'universe',
             'scoring',
             'rrg_overlay',
             'buzz_evidence',
             'diversity_cooldown',
             'layer1_strategy_breadth_gate',
             'l15_ml_slate_queue',
             'layer2_timesfm_enrichment',
             'layer2_coarse_ml_gate',
             'layer3_formal_ml_gate',
             'l1_candidate_seed_after_overlay',
             'strategy_pool_ml_queue',
             'strategy_pool_research_only',
             'final_selection'
           )
         ORDER BY symbol ASC, created_at ASC
      `).bind(date, ...resultSymbols).all<any>()
      for (const [symbol, summary] of summarizeScreenerFunnelRows(funnelRows ?? [])) {
        screenerFunnelBySymbol.set(symbol, summary)
      }
    } catch (e) {
      console.warn('[recommendations/daily] screener funnel evidence unavailable:', e)
    }
  }

  const stockIds = [...new Set((results ?? []).map((r: any) => Number(r.stock_id)).filter((id: number) => Number.isFinite(id)))]
  const perModelByStock = new Map<number, any[]>()
  if (stockIds.length > 0) {
    const placeholders = stockIds.map(() => '?').join(',')
    const { results: perModelRows } = await c.env.DB.prepare(`
      SELECT stock_id, model_name, signal_raw, direction_accuracy, forecast_data
        FROM predictions
       WHERE stock_id IN (${placeholders})
         AND model_name != 'ensemble'
         AND model_name NOT LIKE '%::challenger'
         AND prediction_date = ?
       ORDER BY stock_id, model_name
    `).bind(...stockIds, date).all<any>().catch(() => ({ results: [] as any[] }))
    for (const row of perModelRows ?? []) {
      const id = Number(row.stock_id)
      const list = perModelByStock.get(id) ?? []
      list.push(row)
      perModelByStock.set(id, list)
    }
  }

  // 解析 watch_points JSON
  const tradingConfig = await getTradingConfig(c.env.KV)
  const recs = (results ?? []).map((r: any) => {
    const forecastData = parsePredictionForecastData(r.prediction_forecast_data) ?? {}
    const persistedAlphaContext = parsePredictionForecastData(r.alpha_context)
    const persistedAlphaAllocation = parsePredictionForecastData(r.alpha_allocation)
    const alphaAllocation = forecastData?.alpha_allocation ?? persistedAlphaAllocation ?? null
    const l4SparseAllocation = buildSparseAllocationSummary(alphaAllocation)
    const persistedMlVoteSummary = parsePredictionForecastData(r.ml_vote_summary)
    const active8PersistedMlVoteSummary = persistedMlVoteSummary
      && Number(persistedMlVoteSummary.total ?? 0) <= DIRECT_ALPHA_VOTE_MODEL_NAMES.length
      ? persistedMlVoteSummary
      : null
    const persistedScoreComponents = parsePredictionForecastData(r.score_components)
    const screenerFunnel = screenerFunnelBySymbol.get(String(r.symbol ?? '').trim()) ?? null
    const screenerFunnelEvidenceBase = screenerFunnel?.evidence
      ? {
          ...screenerFunnel.evidence,
          ...(l4SparseAllocation ? { layer4_sparse_allocation: l4SparseAllocation } : {}),
        }
      : l4SparseAllocation
        ? { layer4_sparse_allocation: l4SparseAllocation }
        : null
    const perModelRows = perModelByStock.get(Number(r.stock_id)) ?? []
    const parsedWatchPoints = (() => { try { return JSON.parse(r.watch_points ?? '[]') } catch { return [] } })()
    const emergingBrokerEvidence = buildEmergingBrokerEvidence(r)
    const watchPoints = mergeEmergingBrokerWatchPoints(parsedWatchPoints, emergingBrokerEvidence)
    const scoreComponents = mergeEmergingBrokerScoreComponents(persistedScoreComponents, emergingBrokerEvidence)
    const board = classifyBoard({
      market: r.market,
      open: r.latest_open,
      avg_price: r.latest_avg_price,
      symbol: r.symbol,
    })
    const persistedLane = String(r.recommendation_lane || '').trim()
    const governance = resolveRecommendationGovernance(board, {
      recommendationLane: persistedLane,
      eligibleForMl: r.eligible_for_ml,
      eligibleForPendingBuy: r.eligible_for_pending_buy,
    })
    const hardGateSummary = buildHardGateSummary({
      boardType: board.boardType,
      tradabilityTier: board.tradabilityTier,
      recommendationLane: governance.recommendationLane,
      marketSegment: r.market_segment || board.boardType,
      boardReason: board.reason,
      persistedRecommendationLane: persistedLane,
      eligibleForMl: governance.eligibleForMl,
      eligibleForPendingBuy: governance.eligibleForPendingBuy,
    })
    const screenerFunnelEvidence = screenerFunnelEvidenceBase
      ? {
          ...screenerFunnelEvidenceBase,
          layer05_hard_gate: hardGateSummary,
        }
      : { layer05_hard_gate: hardGateSummary }
    return {
      ...r,
      market_segment: r.market_segment || board.boardType,
      board_type: board.boardType,
      tradability_tier: board.tradabilityTier,
      recommendation_lane: governance.recommendationLane,
      eligible_for_ml: governance.eligibleForMl,
      eligible_for_pending_buy: governance.eligibleForPendingBuy,
      board_reason: board.reason,
      l05_hard_gate: hardGateSummary,
      alpha_context: forecastData?.alpha_context ?? persistedAlphaContext ?? null,
      alpha_allocation: alphaAllocation,
      l4_sparse_allocation: l4SparseAllocation,
      ml_vote_summary: buildMlVoteSummary(forecastData, perModelRows, tradingConfig.signal) ?? active8PersistedMlVoteSummary,
      ml_diagnostics: buildMlDiagnostics(forecastData),
      score_components: scoreComponents,
      chip_evidence: emergingBrokerEvidence,
      reason: mergeEmergingBrokerReason(r.reason, emergingBrokerEvidence),
      screener_funnel_rank: screenerFunnel?.rank ?? null,
      screener_funnel_reason: screenerFunnel?.reason_code ?? null,
      screener_funnel_evidence: screenerFunnelEvidence,
      screener_funnel_timeline: screenerFunnel?.timeline ?? [],
      institutional_raw_today: institutionalRawBySymbol.get(String(r.symbol ?? '').trim()) ?? null,
      broker_top_flows_today: brokerTopFlowsBySymbol.get(String(r.symbol ?? '').trim())
        ?? buildBrokerTopFlowsToday(null, String(r.date ?? date), brokerRankRowsBySymbol.get(String(r.symbol ?? '').trim()) ?? []),
      watch_points: watchPoints,
    }
  })
  const evidenceLinksBySymbol = await loadRecommendationEvidenceLinks(
    c.env.DB,
    String(date),
    recs.map((r: any) => ({ symbol: String(r.symbol ?? ''), name: String(r.name ?? '') })),
    3,
  ).catch((e) => {
    console.warn('[recommendations/daily] evidence links unavailable:', e)
    return new Map<string, any[]>()
  })
  for (const rec of recs) {
    rec.evidence_links = evidenceLinksBySymbol.get(String(rec.symbol ?? '').trim()) ?? []
  }
  const tradableRecs = recs.filter((r: any) => r.recommendation_lane === 'tradable')
  const emergingRecs: any[] = []
  const researchOnlyRecs = recs.filter((r: any) => r.recommendation_lane === 'research_only')
  const shape = view === 'card' ? compactRecommendationForCard : (r: Record<string, any>) => r
  const tradablePayload = tradableRecs.map(shape)
  const emergingPayload = emergingRecs.map(shape)
  const researchOnlyPayload = researchOnlyRecs.map(shape)
  const allPayload = recs.map(shape)
  const strategyPortfolioIntelligenceHealth = summarizeStrategyPortfolioIntelligenceHealth(
    screenerFunnelBySymbol.values(),
    recs.length,
  )

  return c.json({
    requested_date: requestedOrToday,
    date,
    is_stale: date !== requestedOrToday,
    resolved_from: resolvedFrom,
    view,
    recommendations: tradablePayload,
    tradable_recommendations: tradablePayload,
    emerging_recommendations: emergingPayload,
    research_only_recommendations: researchOnlyPayload,
    all_recommendations: allPayload,
    lanes: {
      tradable: { count: tradableRecs.length },
      emerging_watchlist: { count: emergingRecs.length },
      research_only: { count: researchOnlyRecs.length },
    },
    strategy_portfolio_intelligence_health: strategyPortfolioIntelligenceHealth,
    generated_at: recs[0]?.created_at ?? null,
  })
})

// GET /api/recommendations/history?days=7
// 近 N 天的推薦歷史（用於追蹤推薦準確率）
recommendations.get('/history', async (c) => {
  const days = Math.min(parsePosInt(c.req.query('days'), 7), 30)
  const { results } = await c.env.DB.prepare(`
    SELECT r.date, r.symbol, r.name, r.sector, r.rank, r.score,
           r.score_components, r.ml_score, r.chip_score, r.tech_score,
           COALESCE(r.momentum_score, 0) AS momentum_score,
           r.signal, r.confidence, r.has_buy_signal,
           r.current_price,
           -- 回測：推薦後實際表現（從 predictions 取）
           p.actual_return_pct, p.direction_correct, p.trade_outcome
    FROM daily_recommendations r
    LEFT JOIN predictions p
      ON p.stock_id = r.stock_id
      AND p.model_name = 'ensemble'
      AND p.prediction_date = r.date
    WHERE r.date >= date('now', '-' || ? || ' days')
    ORDER BY r.date DESC, r.rank ASC
  `).bind(days).all<any>()
  return c.json(results ?? [])
})

// GET /api/recommendations/sector-flow?date=YYYY-MM-DD&type=industry|theme
// 族群資金流向（可指定日期，預設今日；可指定分類，預設全部）
recommendations.get('/sector-flow', async (c) => {
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10) // TW date
  const type = c.req.query('type') // 'industry' | 'theme' | undefined(all)

  const typeFilter = type ? 'AND classification = ?' : ''
  const binds = type ? [date, type] : [date]

  const { results } = await c.env.DB.prepare(`
    SELECT *
    FROM sector_flow
    WHERE date = ? ${typeFilter}
    ORDER BY total_net DESC
  `).bind(...binds).all<any>()

  // 若今天沒資料，取最近一筆
  if (!results?.length) {
    const { results: latest } = await c.env.DB.prepare(`
      SELECT *
      FROM sector_flow
      WHERE date = (SELECT MAX(date) FROM sector_flow WHERE 1=1 ${typeFilter})
      ${typeFilter}
      ORDER BY total_net DESC
    `).bind(...(type ? [type, type] : [])).all<any>()
    const staleDate = latest?.[0]?.date ?? null
    return c.json({
      date,
      requested_date: date,
      stale: Boolean(staleDate),
      stale_date: staleDate,
      flows: latest ?? [],
    })
  }

  return c.json({ date, requested_date: date, stale: false, stale_date: null, flows: results })
})

// GET /api/recommendations/sector-trend?sector=半導體&days=14&type=industry|theme
// 單一族群的資金流向趨勢
recommendations.get('/sector-trend', async (c) => {
  const sector = c.req.query('sector')
  const days   = Math.min(parsePosInt(c.req.query('days'), 14), 60)
  const type   = c.req.query('type')
  if (!sector) return c.json({ error: '請提供 sector 參數' }, 400)

  const typeFilter = type ? 'AND classification = ?' : ''
  const binds = type ? [sector, days, type] : [sector, days]

  const { results } = await c.env.DB.prepare(`
    SELECT date, foreign_net, trust_net, total_net, avg_rsi, avg_momentum_5d, up_count, stock_count,
           classification, turnover_value, turnover_share, turnover_share_delta
    FROM sector_flow
    WHERE sector = ? AND date >= date('now', '-' || ? || ' days') ${typeFilter}
    ORDER BY date ASC
  `).bind(...binds).all<any>()
  return c.json({ sector, days, trend: results ?? [] })
})

// GET /api/recommendations/sector-flow-stocks?date=&theme=&classification=top|dark_horse
// 主題內個股法人買賣超明細
recommendations.get('/sector-flow-stocks', async (c) => {
  const date  = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const theme = c.req.query('theme')
  const cls   = c.req.query('classification')

  let sql = 'SELECT * FROM sector_flow_stocks WHERE date = ?'
  const binds: any[] = [date]

  if (theme) { sql += ' AND theme = ?'; binds.push(theme) }
  if (cls)   { sql += ' AND classification = ?'; binds.push(cls) }
  sql += ' ORDER BY theme, classification, net_amount DESC'

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<any>()

  // 若今天沒資料，fallback 最近一天
  if (!results?.length) {
    let fbSql = 'SELECT * FROM sector_flow_stocks WHERE date = (SELECT MAX(date) FROM sector_flow_stocks)'
    const fbBinds: any[] = []
    if (theme) { fbSql += ' AND theme = ?'; fbBinds.push(theme) }
    if (cls)   { fbSql += ' AND classification = ?'; fbBinds.push(cls) }
    fbSql += ' ORDER BY theme, classification, net_amount DESC'
    const { results: fb } = await c.env.DB.prepare(fbSql).bind(...fbBinds).all<any>()
    const staleDate = fb?.[0]?.date ?? null
    return c.json({
      date,
      requested_date: date,
      stale: Boolean(staleDate),
      stale_date: staleDate,
      stale_reason: staleDate
        ? `sector_flow_stocks has no rows for ${date}; latest detail snapshot is ${staleDate}, refusing stale fallback`
        : `sector_flow_stocks has no rows for ${date}`,
      stocks: [],
      stale_preview_count: fb?.length ?? 0,
    })
  }

  return c.json({ date, requested_date: date, stale: false, stale_date: null, stocks: results })
})

// GET /api/recommendations/daily-report?date=YYYY-MM-DD
// AI 整合報告（持久化版，含大盤/ML/推薦/績效/主題輪動）
recommendations.get('/daily-report', async (c) => {
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  let report = await c.env.DB.prepare(
    'SELECT * FROM stock_analysis_reports WHERE date=? AND report_type=?'
  ).bind(date, 'daily').first<any>().catch(() => null)

  // fallback 最近一筆
  if (!report) {
    report = await c.env.DB.prepare(
      'SELECT * FROM stock_analysis_reports WHERE report_type=? ORDER BY date DESC LIMIT 1'
    ).bind('daily').first<any>().catch(() => null)
  }

  if (!report) return c.json({ report: null, date })

  // parse JSON fields
  const parsed = {
    date: report.date,
    report_type: report.report_type,
    market_summary: safeJSON(report.market_summary),
    ml_overview: safeJSON(report.ml_overview),
    buy_details: safeJSON(report.buy_details),
    sell_alerts: safeJSON(report.sell_alerts),
    recommendations: safeJSON(report.recommendations),
    performance: safeJSON(report.performance),
    theme_flow: safeJSON(report.theme_flow),
    created_at: report.created_at,
  }
  return c.json({ report: parsed, date: report.date })
})

function safeJSON(str: string | null): any {
  if (!str) return null
  try { return JSON.parse(str) } catch { return null }
}
