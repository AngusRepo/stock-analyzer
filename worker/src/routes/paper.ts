/**
 * paper.ts — 模擬交易（Paper Trading）API
 *
 * 固定帳戶 ID=1，初始資金 NT$1,000,000
 * 台股手續費：買賣各 0.1425%（最低 20 元），賣出加收 0.3% 交易稅
 *
 * Auth：
 *   - Bearer <STOCKVISION_AUTH_TOKEN>  ← AI Team / Cron 服務間呼叫
 *   - Bearer <JWT>                     ← 前端已登入用戶（任何 approved 用戶）
 */

import { Hono }       from 'hono'
import { verifyJWT }  from '../lib/auth'
import { runBuyDebate, type DebateResult, type StockProfile } from '../lib/debateTrader'
import { sendDiscordNotification, formatTradeNotification, formatDailySummary } from '../lib/notify'
import { getTradingConfig, type TradingConfig } from '../lib/tradingConfig'
import type { Bindings, Variables } from '../types'

const paper = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const ACCOUNT_ID = 1

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcCommission(value: number, cfg: TradingConfig): number {
  return Math.max(Math.round(value * cfg.fees.commission), cfg.fees.minCommission)
}
function calcTax(value: number, cfg: TradingConfig): number {
  return Math.round(value * cfg.fees.tax)
}

async function getLatestPrice(db: D1Database, symbol: string): Promise<number | null> {
  const row = await db.prepare(`
    SELECT sp.close FROM stock_prices sp
    JOIN stocks s ON s.id = sp.stock_id
    WHERE s.symbol = ? AND sp.close IS NOT NULL
    ORDER BY sp.date DESC LIMIT 1
  `).bind(symbol).first<any>()
  return row?.close ?? null
}

// ─── Batch Price Fetch（N+1 修復）────────────────────────────────────────────
// 取多支股票的最新收盤價，一次 query 完成，避免 for loop 中逐一查詢
async function batchGetLatestPrices(db: D1Database, symbols: string[]): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map()
  const placeholders = symbols.map(() => '?').join(',')
  const { results } = await db.prepare(`
    SELECT s.symbol, sp.close
    FROM stocks s
    JOIN stock_prices sp ON sp.stock_id = s.id
    INNER JOIN (
      SELECT stock_id, MAX(date) as max_date
      FROM stock_prices
      WHERE close IS NOT NULL
      GROUP BY stock_id
    ) latest ON sp.stock_id = latest.stock_id AND sp.date = latest.max_date
    WHERE s.symbol IN (${placeholders})
  `).bind(...symbols).all<any>()

  const map = new Map<string, number>()
  for (const row of (results ?? [])) {
    if (row.close != null) map.set(row.symbol, row.close)
  }
  return map
}

// ─── Circuit Breaker（三層風控）─────────────────────────────────────────────

interface CircuitBreakerState {
  halt: boolean
  reason?: string
  maxPositionPct: number         // 8% 正常，4% 高波動縮減
  buyConfThreshold: number       // 0.60 正常，0.70 低準確率時提高
  sellConfThreshold: number      // 0.65 正常，0.70 低準確率時提高
}

async function checkCircuitBreakers(db: D1Database, cfg: TradingConfig): Promise<CircuitBreakerState> {
  const cc = cfg.circuit
  const defaults: CircuitBreakerState = {
    halt: false,
    maxPositionPct: cc.maxPositionPct,
    buyConfThreshold: cc.buyConfThreshold,
    sellConfThreshold: cc.sellConfThreshold,
  }

  // Layer 1: 30 日滾動回撤 > drawdownHalt → 暫停自動交易
  const { results: snapshots } = await db.prepare(
    'SELECT total_value FROM paper_daily_snapshots WHERE account_id=? ORDER BY date DESC LIMIT 30'
  ).bind(ACCOUNT_ID).all<any>()

  if (snapshots && snapshots.length >= 3) {
    const values = snapshots.map((s: any) => s.total_value as number)
    const current  = values[0]
    const maxValue = Math.max(...values)
    const drawdown = maxValue > 0 ? (maxValue - current) / maxValue : 0
    if (drawdown > cc.drawdownHalt) {
      console.warn(`[CircuitBreaker] Layer1 HALT: drawdown ${(drawdown * 100).toFixed(1)}% > ${(cc.drawdownHalt * 100).toFixed(0)}%`)
      return { halt: true, reason: `30日回撤 ${(drawdown * 100).toFixed(1)}% 超過 ${(cc.drawdownHalt * 100).toFixed(0)}% 上限`, maxPositionPct: cc.drawdownReducedPosPct, buyConfThreshold: cc.drawdownRaisedConf, sellConfThreshold: cc.drawdownRaisedConf }
    }
  }

  // Layer 2: 模型近期準確率 < lowAccuracyThreshold → 提高信心門檻
  const accuracyRow = await db.prepare(`
    SELECT AVG(CASE WHEN direction_correct=1 THEN 1.0 ELSE 0.0 END) as acc
    FROM predictions
    WHERE generated_at >= datetime('now', '-20 days')
    AND direction_correct IS NOT NULL
  `).first<any>()

  const recentAcc = accuracyRow?.acc ?? 0.5
  if (recentAcc < cc.lowAccuracyThreshold) {
    console.warn(`[CircuitBreaker] Layer2: model accuracy ${(recentAcc * 100).toFixed(1)}% < ${(cc.lowAccuracyThreshold * 100).toFixed(0)}%, raising threshold`)
    return { ...defaults, buyConfThreshold: cc.drawdownRaisedConf, sellConfThreshold: cc.drawdownRaisedConf, reason: `模型近期準確率 ${(recentAcc * 100).toFixed(1)}%` }
  }

  // Layer 3: 大盤風險 HIGH/VERY_HIGH → 縮減最大部位
  const marketRisk = await db.prepare(
    'SELECT risk_level FROM market_risk ORDER BY date DESC LIMIT 1'
  ).first<any>()

  const isHighVol = marketRisk?.risk_level === 'HIGH' || marketRisk?.risk_level === 'VERY_HIGH'
  if (isHighVol) {
    console.warn(`[CircuitBreaker] Layer3: market risk ${marketRisk?.risk_level}, reducing max position to ${(cc.highVolReducedPosPct * 100).toFixed(0)}%`)
    return { ...defaults, maxPositionPct: cc.highVolReducedPosPct }
  }

  // Layer 4: 大盤廣度 — 多頭排列 < 20% → 空頭擴散，縮減倉位
  const breadth = await db.prepare(
    'SELECT bull_alignment_pct, advance_ratio FROM market_breadth ORDER BY date DESC LIMIT 1'
  ).first<any>()
  if (breadth?.bull_alignment_pct != null && breadth.bull_alignment_pct < 20) {
    console.warn(`[CircuitBreaker] Layer4: bull alignment ${breadth.bull_alignment_pct}% < 20%, reducing position`)
    return { ...defaults, maxPositionPct: cc.highVolReducedPosPct }
  }

  return defaults
}

async function getStockName(db: D1Database, symbol: string): Promise<string> {
  const row = await db.prepare('SELECT name FROM stocks WHERE symbol=? LIMIT 1').bind(symbol).first<any>()
  return row?.name ?? symbol
}

// ─── 動態出場決策引擎 ────────────────────────────────────────────────────────

interface ExitDecision {
  action: 'full_sell' | 'partial_sell' | 'hold'
  reason: string
  sellShares?: number        // partial_sell 時的賣出股數
  newTrailingStop?: number   // 需更新的 trailing stop
  newHighest?: number        // 需更新的 highest_since_entry
  moveStopToEntry?: boolean  // TP1 後止損移到 entry
}

function checkExitConditions(
  pos: {
    symbol: string; shares: number; avg_cost: number;
    entry_price: number | null; initial_stop: number | null;
    trailing_stop: number | null; highest_since_entry: number | null;
    tp1_price: number | null; tp2_price: number | null;
    tp1_hit: number; original_shares: number | null;
    entry_date: string | null; stop_multiplier: number | null;
  },
  currentPrice: number,
  atr14: number,
  hasMlSell: boolean,
  isEOD: boolean,
  cfg: TradingConfig,
): ExitDecision {
  const ex = cfg.exit
  const entryPrice = pos.entry_price ?? pos.avg_cost
  const pnlPct = (currentPrice - entryPrice) / entryPrice

  // ❶ 硬上限止損
  if (pnlPct <= ex.hardStopPct) {
    return { action: 'full_sell', reason: `硬上限止損 ${(pnlPct * 100).toFixed(1)}%` }
  }

  // ❷ ATR 初始止損
  const initStop = pos.initial_stop ?? (entryPrice * ex.fallbackInitStopMult)
  if (currentPrice <= initStop) {
    return { action: 'full_sell', reason: `ATR 初始止損 @ ${initStop.toFixed(1)}（${(pnlPct * 100).toFixed(1)}%）` }
  }

  // ❸ ML SELL 訊號（僅 EOD）
  if (isEOD && hasMlSell) {
    return { action: 'full_sell', reason: 'ML SELL 訊號' }
  }

  // ❹ Chandelier Trailing Stop
  const trailingStop = pos.trailing_stop ?? initStop
  if (currentPrice <= trailingStop && trailingStop > initStop) {
    return { action: 'full_sell', reason: `Trailing Stop @ ${trailingStop.toFixed(1)}（${(pnlPct * 100).toFixed(1)}%）` }
  }

  // ❺ TP1：賣 tp1SellRatio（首次觸發）
  const tp1 = pos.tp1_price ?? (entryPrice * ex.fallbackTp1Mult)
  if (currentPrice >= tp1 && !pos.tp1_hit) {
    const sellShares = Math.floor((pos.original_shares ?? pos.shares) * ex.tp1SellRatio / 1000) * 1000
    if (sellShares > 0 && sellShares < pos.shares) {
      return {
        action: 'partial_sell', reason: `TP1 達標 @ ${currentPrice.toFixed(1)}（+${(pnlPct * 100).toFixed(1)}%）`,
        sellShares, moveStopToEntry: true,
      }
    }
    // 單張部位無法拆分 → 直接全出
    return { action: 'full_sell', reason: `TP1 達標（單張全出）@ ${currentPrice.toFixed(1)}（+${(pnlPct * 100).toFixed(1)}%）` }
  }

  // ❻ TP2：賣剩餘（TP1 已觸後）
  const tp2 = pos.tp2_price ?? (entryPrice * ex.fallbackTp2Mult)
  if (currentPrice >= tp2 && pos.tp1_hit) {
    return { action: 'full_sell', reason: `TP2 達標 @ ${currentPrice.toFixed(1)}（+${(pnlPct * 100).toFixed(1)}%）` }
  }

  // ❼ 時間止損（僅 EOD）
  if (isEOD && pos.entry_date) {
    const daysSinceEntry = Math.floor((Date.now() - new Date(pos.entry_date).getTime()) / 86400000)
    if (daysSinceEntry > ex.timeStopDays && pnlPct > ex.timeStopMinProfit) {
      return { action: 'full_sell', reason: `時間止損（${daysSinceEntry} 天，+${(pnlPct * 100).toFixed(1)}%）` }
    }
  }

  // ── Hold：更新 trailing stop + highest ──────────────────────────────────
  const highestSoFar = Math.max(pos.highest_since_entry ?? entryPrice, currentPrice)

  // Profit-lock: 獲利越多 trailing 越緊
  let trailMult = ex.trailMultDefault
  if (pnlPct > 0.08) trailMult = ex.trailMultAt8pct
  else if (pnlPct > 0.03) trailMult = ex.trailMultAt3pct

  const effectiveAtr = atr14 > 0 ? atr14 : currentPrice * ex.fallbackAtrPct
  const newTrailing = highestSoFar - effectiveAtr * trailMult

  // TP1 後止損至少在 entry price（保本）
  const floorStop = pos.tp1_hit ? entryPrice : initStop
  const finalTrailing = Math.max(newTrailing, floorStop)

  // trailing stop 只上移不下移
  const prevTrailing = pos.trailing_stop ?? initStop
  const updatedTrailing = Math.max(finalTrailing, prevTrailing)

  if (updatedTrailing !== prevTrailing || highestSoFar !== (pos.highest_since_entry ?? entryPrice)) {
    return {
      action: 'hold', reason: 'trailing update',
      newTrailingStop: updatedTrailing,
      newHighest: highestSoFar,
    }
  }

  return { action: 'hold', reason: 'no trigger' }
}

// ─── 盤中即時報價（Shioaji Proxy → Yahoo fallback）──────────────────────────

async function getIntradayPrice(symbol: string, env?: { SHIOAJI_PROXY_URL?: string }): Promise<number | null> {
  // Layer 1: Shioaji Proxy（即時報價）
  const proxyUrl = env?.SHIOAJI_PROXY_URL
  if (proxyUrl) {
    try {
      const res = await fetch(`${proxyUrl}/quote/${symbol}`, {
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        const json = await res.json() as any
        return json?.data?.price ?? null
      }
    } catch { /* Shioaji proxy 不通 → fallback */ }
  }

  // Layer 2: Yahoo Finance fallback（15 分鐘延遲）
  try {
    const twSymbol = `${symbol}.TW`
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${twSymbol}?interval=1m&range=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    )
    if (!res.ok) return null
    const json = await res.json() as any
    return json?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null
  } catch { return null }
}

async function batchGetIntradayPrices(symbols: string[], env?: { SHIOAJI_PROXY_URL?: string }): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  const proxyUrl = env?.SHIOAJI_PROXY_URL

  // Layer 1: Shioaji Proxy 批次 API（一次呼叫）
  if (proxyUrl) {
    try {
      const res = await fetch(`${proxyUrl}/quotes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols }),
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) {
        const json = await res.json() as any
        const data = json?.data ?? {}
        for (const [sym, quote] of Object.entries(data)) {
          const price = (quote as any)?.price
          if (price != null) map.set(sym, price)
        }
        if (map.size > 0) return map
      }
    } catch { /* fallback to Yahoo */ }
  }

  // Layer 2: Yahoo Finance fallback（逐一查）
  const BATCH = 5
  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk = symbols.slice(i, i + BATCH)
    const results = await Promise.allSettled(
      chunk.map(async (s) => ({ symbol: s, price: await getIntradayPrice(s) }))
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.price != null) {
        map.set(r.value.symbol, r.value.price)
      }
    }
  }
  return map
}

// ─── Batch ATR Fetch ────────────────────────────────────────────────────────

async function batchGetATR(db: D1Database, symbols: string[]): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map()
  const placeholders = symbols.map(() => '?').join(',')
  const { results } = await db.prepare(`
    SELECT s.symbol, ti.atr14
    FROM stocks s
    JOIN technical_indicators ti ON ti.stock_id = s.id
    WHERE s.symbol IN (${placeholders})
      AND ti.date = (SELECT MAX(t2.date) FROM technical_indicators t2 WHERE t2.stock_id = s.id)
  `).bind(...symbols).all<any>()
  const map = new Map<string, number>()
  for (const row of (results ?? [])) {
    if (row.atr14 != null) map.set(row.symbol, row.atr14)
  }
  return map
}

// ─── Auth Middleware（服務 token 或 JWT 擇一）────────────────────────────────

const paperAuth = async (
  c: Parameters<Parameters<typeof paper.use>[0]>[0],
  next: () => Promise<void>,
) => {
  const authHeader = c.req.header('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  // Option 1：AI Team / Cron 服務 token（內部呼叫）
  const serviceToken = (c.env as any).STOCKVISION_AUTH_TOKEN as string | undefined
  if (serviceToken && token === serviceToken) {
    await next(); return
  }

  // Option 2：前端 JWT — 僅限 owner（ADMIN_EMAIL）
  const payload = await verifyJWT(token, c.env.JWT_SECRET)
  if (payload) {
    // Paper Trading / Auto Trade 僅限 owner 操作
    const ownerEmail = (c.env as any).ADMIN_EMAIL as string | undefined
    if (ownerEmail && payload.email !== ownerEmail) {
      return c.json({ error: 'Paper Trading 僅限帳戶擁有者操作' }, 403)
    }
    await next(); return
  }

  return c.json({ error: 'Unauthorized' }, 401)
}

paper.use('*', paperAuth)

// ─── GET /api/paper/account — 帳戶概覽 ──────────────────────────────────────

paper.get('/account', async (c) => {
  const acc = await c.env.DB.prepare(
    'SELECT * FROM paper_accounts WHERE id=?'
  ).bind(ACCOUNT_ID).first<any>()

  if (!acc) return c.json({ error: '帳戶不存在，請先執行 migration' }, 404)
  return c.json({ status: 'success', account: acc })
})

// ─── GET /api/paper/positions — 持倉清單（含未實現損益）─────────────────────

paper.get('/positions', async (c) => {
  const acc = await c.env.DB.prepare(
    'SELECT cash, initial_cash FROM paper_accounts WHERE id=?'
  ).bind(ACCOUNT_ID).first<any>()
  if (!acc) return c.json({ error: '帳戶不存在' }, 404)

  const { results: positions } = await c.env.DB.prepare(
    'SELECT * FROM paper_positions WHERE account_id=? AND shares>0 ORDER BY symbol'
  ).bind(ACCOUNT_ID).all<any>()

  // ── 盤中判斷（TW 09:00-13:30）──────────────────────────────────────────
  const twHour = (new Date().getUTCHours() + 8) % 24
  const twMin  = new Date().getUTCMinutes()
  const isMarketOpen = twHour >= 9 && (twHour < 13 || (twHour === 13 && twMin <= 30))

  // ── Tier 1: KV 盤中報價（pollIntradayStopLoss 每分鐘寫入）────────────
  const intradayMap = new Map<string, number>()
  if (isMarketOpen && positions?.length) {
    const kvResults = await Promise.all(
      (positions ?? []).map((p: any) => c.env.KV.get(`intraday:price:${p.symbol}`))
    )
    for (let i = 0; i < (positions ?? []).length; i++) {
      const v = kvResults[i]
      if (v != null) intradayMap.set(positions![i].symbol, parseFloat(v))
    }
  }

  // ── Tier 2: DB EOD（KV 沒有的 symbol fallback）──────────────────────
  let totalPositionValue = 0
  const enriched = await Promise.all((positions ?? []).map(async (pos: any) => {
    const currentPrice = intradayMap.get(pos.symbol) ?? await getLatestPrice(c.env.DB, pos.symbol)
    const marketValue  = currentPrice ? currentPrice * pos.shares : 0
    const costBasis    = pos.avg_cost * pos.shares
    const unrealizedPnl    = marketValue - costBasis
    const unrealizedPnlPct = costBasis > 0 ? (unrealizedPnl / costBasis * 100) : 0
    totalPositionValue += marketValue

    return {
      symbol:           pos.symbol,
      name:             pos.name,
      shares:           pos.shares,
      avg_cost:         Math.round(pos.avg_cost * 100) / 100,
      current_price:    currentPrice,
      market_value:     Math.round(marketValue),
      unrealized_pnl:   Math.round(unrealizedPnl),
      unrealized_pnl_pct: Math.round(unrealizedPnlPct * 100) / 100,
      price_source:     intradayMap.has(pos.symbol) ? 'intraday' as const : 'eod' as const,
    }
  }))

  const totalValue    = acc.cash + totalPositionValue
  const totalPnl      = totalValue - acc.initial_cash
  const totalPnlPct   = acc.initial_cash > 0 ? (totalPnl / acc.initial_cash * 100) : 0

  return c.json({
    status: 'success',
    positions: enriched,
    summary: {
      cash:             Math.round(acc.cash),
      positions_value:  Math.round(totalPositionValue),
      total_value:      Math.round(totalValue),
      initial_cash:     acc.initial_cash,
      total_pnl:        Math.round(totalPnl),
      total_pnl_pct:    Math.round(totalPnlPct * 100) / 100,
    },
  })
})

// ─── GET /api/paper/pnl — 損益摘要（最近 30 日快照）────────────────────────

paper.get('/pnl', async (c) => {
  const acc = await c.env.DB.prepare(
    'SELECT cash, initial_cash FROM paper_accounts WHERE id=?'
  ).bind(ACCOUNT_ID).first<any>()
  if (!acc) return c.json({ error: '帳戶不存在' }, 404)

  const { results: snapshots } = await c.env.DB.prepare(
    'SELECT date, total_value, pnl, pnl_pct, benchmark_value, max_drawdown_to_date, sharpe_30d FROM paper_daily_snapshots WHERE account_id=? ORDER BY date DESC LIMIT 30'
  ).bind(ACCOUNT_ID).all<any>()

  return c.json({
    status: 'success',
    initial_cash: acc.initial_cash,
    current_cash: Math.round(acc.cash),
    snapshots: snapshots ?? [],
  })
})

// ─── GET /api/paper/orders — 交易記錄（最近 50 筆）─────────────────────────

paper.get('/orders', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM paper_orders WHERE account_id=? ORDER BY created_at DESC LIMIT ?'
  ).bind(ACCOUNT_ID, limit).all<any>()

  return c.json({ status: 'success', orders: results ?? [] })
})

// ─── POST /api/paper/buy — 買入 ──────────────────────────────────────────────

paper.post('/buy', async (c) => {
  const cfg = await getTradingConfig(c.env.KV)
  const body = await c.req.json<any>().catch(() => ({}))
  const symbol:  string  = String(body.symbol  ?? '').toUpperCase().trim()
  const sharesRaw        = parseInt(String(body.shares ?? 0))
  const priceOverride    = body.price ? parseFloat(body.price) : null
  const source: string   = body.source ?? 'manual'
  const signal: string | undefined = body.signal
  const confidence: number | undefined = body.confidence ? parseFloat(body.confidence) : undefined
  const note: string | undefined = body.note

  if (!symbol)       return c.json({ error: '缺少 symbol' }, 400)
  if (!sharesRaw || sharesRaw <= 0) return c.json({ error: 'shares 必須為正整數' }, 400)

  const price = priceOverride ?? await getLatestPrice(c.env.DB, symbol)
  if (!price) return c.json({ error: `找不到 ${symbol} 的最新價格，請確認股票已在追蹤清單中` }, 404)

  const name        = await getStockName(c.env.DB, symbol)
  const txValue     = price * sharesRaw
  const commission  = calcCommission(txValue, cfg)
  const totalCost   = txValue + commission   // 買入：支出

  // 檢查資金
  const acc = await c.env.DB.prepare('SELECT cash FROM paper_accounts WHERE id=?').bind(ACCOUNT_ID).first<any>()
  if (!acc) return c.json({ error: '帳戶不存在' }, 404)
  if (acc.cash < totalCost) {
    return c.json({
      error: `現金不足。需要 NT$${Math.round(totalCost).toLocaleString()}，可用 NT$${Math.round(acc.cash).toLocaleString()}`,
    }, 400)
  }

  // 每日買入額度檢查（防違約交割）
  const MANUAL_DAILY_LIMIT = cfg.position.manualDailyLimit
  const todayStr = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const todayBoughtManual = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(total_cost), 0) as total FROM paper_orders WHERE account_id=? AND side='buy' AND created_at >= ?"
  ).bind(ACCOUNT_ID, todayStr).first<any>()
  if ((todayBoughtManual?.total ?? 0) + totalCost > MANUAL_DAILY_LIMIT) {
    return c.json({
      error: `已達每日買入上限 NT$${MANUAL_DAILY_LIMIT.toLocaleString()}（今日已買 NT$${Math.round(todayBoughtManual?.total ?? 0).toLocaleString()}）`,
    }, 400)
  }

  // 計算新平均成本
  const existing = await c.env.DB.prepare(
    'SELECT shares, avg_cost FROM paper_positions WHERE account_id=? AND symbol=?'
  ).bind(ACCOUNT_ID, symbol).first<any>()

  const oldShares  = existing?.shares ?? 0
  const oldCost    = existing?.avg_cost ?? 0
  const newShares  = oldShares + sharesRaw
  // 攤入手續費到平均成本
  const newAvgCost = (oldShares * oldCost + txValue + commission) / newShares

  await c.env.DB.batch([
    // 更新帳戶現金
    c.env.DB.prepare(
      "UPDATE paper_accounts SET cash=cash-?, updated_at=datetime('now') WHERE id=?"
    ).bind(totalCost, ACCOUNT_ID),

    // Upsert 持倉
    c.env.DB.prepare(`
      INSERT INTO paper_positions (account_id, symbol, name, shares, avg_cost, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(account_id, symbol) DO UPDATE SET
        shares    = excluded.shares,
        avg_cost  = excluded.avg_cost,
        name      = excluded.name,
        updated_at = datetime('now')
    `).bind(ACCOUNT_ID, symbol, name, newShares, newAvgCost),

    // 新增委託記錄
    c.env.DB.prepare(`
      INSERT INTO paper_orders
        (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
      VALUES (?, ?, ?, 'buy', ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).bind(ACCOUNT_ID, symbol, name, sharesRaw, price, commission, totalCost, source, signal ?? null, confidence ?? null, note ?? null),
  ])

  return c.json({
    status: 'success',
    action: 'buy',
    symbol, name, shares: sharesRaw,
    price:       Math.round(price * 100) / 100,
    commission,
    total_cost:  Math.round(totalCost),
    new_shares:  newShares,
    new_avg_cost: Math.round(newAvgCost * 100) / 100,
    message: `✅ 買入 ${name}(${symbol}) ${sharesRaw} 股 @ NT$${price}，手續費 NT$${commission}，共 NT$${Math.round(totalCost).toLocaleString()}`,
  })
})

// ─── POST /api/paper/sell — 賣出 ─────────────────────────────────────────────

paper.post('/sell', async (c) => {
  const cfg = await getTradingConfig(c.env.KV)
  const body = await c.req.json<any>().catch(() => ({}))
  const symbol: string  = String(body.symbol ?? '').toUpperCase().trim()
  const sharesRaw       = parseInt(String(body.shares ?? 0))
  const priceOverride   = body.price ? parseFloat(body.price) : null
  const source: string  = body.source ?? 'manual'
  const signal: string | undefined = body.signal
  const confidence: number | undefined = body.confidence ? parseFloat(body.confidence) : undefined
  const note: string | undefined = body.note

  if (!symbol) return c.json({ error: '缺少 symbol' }, 400)
  if (!sharesRaw || sharesRaw <= 0) return c.json({ error: 'shares 必須為正整數' }, 400)

  // 檢查持倉
  const pos = await c.env.DB.prepare(
    'SELECT * FROM paper_positions WHERE account_id=? AND symbol=?'
  ).bind(ACCOUNT_ID, symbol).first<any>()
  if (!pos || pos.shares < sharesRaw) {
    return c.json({
      error: `持倉不足。持有 ${pos?.shares ?? 0} 股，想賣 ${sharesRaw} 股`,
    }, 400)
  }

  const price = priceOverride ?? await getLatestPrice(c.env.DB, symbol)
  if (!price) return c.json({ error: `找不到 ${symbol} 的最新價格` }, 404)

  const name       = pos.name || await getStockName(c.env.DB, symbol)
  const txValue    = price * sharesRaw
  const commission = calcCommission(txValue, cfg)
  const tax        = calcTax(txValue, cfg)
  const proceeds   = txValue - commission - tax  // 賣出：扣費後實收

  const newShares = pos.shares - sharesRaw

  // 計算已實現損益
  const costBasis      = pos.avg_cost * sharesRaw
  const realizedPnl    = proceeds - costBasis
  const realizedPnlPct = costBasis > 0 ? (realizedPnl / costBasis * 100) : 0

  await c.env.DB.batch([
    // 更新帳戶現金（加回賣出所得）
    c.env.DB.prepare(
      "UPDATE paper_accounts SET cash=cash+?, updated_at=datetime('now') WHERE id=?"
    ).bind(proceeds, ACCOUNT_ID),

    // 更新/刪除持倉
    newShares > 0
      ? c.env.DB.prepare(
          "UPDATE paper_positions SET shares=?, updated_at=datetime('now') WHERE account_id=? AND symbol=?"
        ).bind(newShares, ACCOUNT_ID, symbol)
      : c.env.DB.prepare(
          'DELETE FROM paper_positions WHERE account_id=? AND symbol=?'
        ).bind(ACCOUNT_ID, symbol),

    // 新增委託記錄（total_cost 存賣出收入正值，方便加總）
    c.env.DB.prepare(`
      INSERT INTO paper_orders
        (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
      VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(ACCOUNT_ID, symbol, name, sharesRaw, price, commission, tax, proceeds, source, signal ?? null, confidence ?? null, note ?? null),
  ])

  return c.json({
    status: 'success',
    action: 'sell',
    symbol, name, shares: sharesRaw,
    price:           Math.round(price * 100) / 100,
    commission,
    tax,
    proceeds:        Math.round(proceeds),
    realized_pnl:    Math.round(realizedPnl),
    realized_pnl_pct: Math.round(realizedPnlPct * 100) / 100,
    remaining_shares: newShares,
    message: `✅ 賣出 ${name}(${symbol}) ${sharesRaw} 股 @ NT$${price}，實現損益 NT$${Math.round(realizedPnl).toLocaleString()}（${Math.round(realizedPnlPct * 100) / 100}%）`,
  })
})

// ─── POST /api/paper/snapshot — 日終快照（Cron 呼叫）───────────────────────

paper.post('/snapshot', async (c) => {
  const acc = await c.env.DB.prepare(
    'SELECT cash, initial_cash FROM paper_accounts WHERE id=?'
  ).bind(ACCOUNT_ID).first<any>()
  if (!acc) return c.json({ error: '帳戶不存在' }, 404)

  const { results: positions } = await c.env.DB.prepare(
    'SELECT symbol, shares FROM paper_positions WHERE account_id=? AND shares>0'
  ).bind(ACCOUNT_ID).all<any>()

  let positionValue = 0
  for (const pos of (positions ?? [])) {
    const p = await getLatestPrice(c.env.DB, pos.symbol)
    if (p) positionValue += p * pos.shares
  }

  const totalValue = acc.cash + positionValue
  const pnl        = totalValue - acc.initial_cash
  const pnlPct     = acc.initial_cash > 0 ? (pnl / acc.initial_cash * 100) : 0
  const today      = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  await c.env.DB.prepare(`
    INSERT INTO paper_daily_snapshots
      (account_id, date, cash, positions_value, total_value, pnl, pnl_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, date) DO UPDATE SET
      cash=excluded.cash, positions_value=excluded.positions_value,
      total_value=excluded.total_value, pnl=excluded.pnl, pnl_pct=excluded.pnl_pct
  `).bind(ACCOUNT_ID, today, acc.cash, positionValue, totalValue, pnl, pnlPct).run()

  return c.json({
    status: 'success',
    date: today,
    total_value:     Math.round(totalValue),
    pnl:             Math.round(pnl),
    pnl_pct:         Math.round(pnlPct * 100) / 100,
  })
})

// ─── POST /api/paper/reset — 重置帳戶（需 service token）────────────────────

paper.post('/reset', async (c) => {
  // 重置只允許 service token，不允許 JWT
  const authHeader = c.req.header('Authorization') ?? ''
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const serviceToken = (c.env as any).STOCKVISION_AUTH_TOKEN as string | undefined
  if (!serviceToken || token !== serviceToken) {
    return c.json({ error: 'Reset 只允許 service token 執行' }, 403)
  }

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE paper_accounts SET cash=1000000.0, updated_at=datetime('now') WHERE id=?").bind(ACCOUNT_ID),
    c.env.DB.prepare('DELETE FROM paper_positions WHERE account_id=?').bind(ACCOUNT_ID),
    c.env.DB.prepare('DELETE FROM paper_orders WHERE account_id=?').bind(ACCOUNT_ID),
    c.env.DB.prepare('DELETE FROM paper_daily_snapshots WHERE account_id=?').bind(ACCOUNT_ID),
  ])

  return c.json({ status: 'success', message: '模擬帳戶已重置為 NT$1,000,000' })
})

export { paper }

// ─── Risk-Based Position Sizing 輔助函數 ──────────────────────────────
function calcRiskPct(signal: string, confidence: number, debateVerdict?: string): number {
  let base = 0.01
  if (signal.includes('STRONG_BUY') && confidence >= 0.80) base = 0.02
  else if (signal.includes('BUY') && confidence >= 0.70)   base = 0.015
  if (debateVerdict === 'DOWNGRADE') base *= 0.5
  return base
}

// ─── 前一交易日查詢 ──────────────────────────────────────────────────────
async function getPrevTradingDay(db: D1Database): Promise<string> {
  const row = await db.prepare(
    "SELECT date FROM daily_recommendations WHERE date < ? ORDER BY date DESC LIMIT 1"
  ).bind(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)).first<{ date: string }>()
  return row?.date ?? new Date(Date.now() + 8 * 3600_000 - 86400000).toISOString().slice(0, 10)
}

// ─── PendingBuy 型別 ────────────────────────────────────────────────────
interface PendingBuy {
  symbol: string
  name: string
  signal: string
  confidence: number
  ml_entry_price: number
  ml_stop_loss: number | null
  ml_target1: number | null
  ml_target2: number | null
  reason: string
  debate_verdict: string
  risk_pct: number
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Morning Setup（09:00 TW）— 讀前一交易日推薦 + Debate + 寫 KV 待買清單
// ════════════════════════════════════════════════════════════════════════════

export async function setupMorningPendingBuys(env: Bindings): Promise<void> {
  console.log('[MorningSetup] Starting...')
  const cfg = await getTradingConfig(env.KV)

  const cb = await checkCircuitBreakers(env.DB, cfg)
  if (cb.halt) {
    console.warn(`[MorningSetup] HALTED by circuit breaker: ${cb.reason}`)
    return
  }

  const prevDay = await getPrevTradingDay(env.DB)
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  console.log(`[MorningSetup] 讀取 ${prevDay} 推薦，掛單日期 ${today}`)

  const { results: buyRecs } = await env.DB.prepare(`
    SELECT dr.symbol, dr.name, dr.signal, dr.confidence, dr.current_price, dr.reason,
           p.entry_price AS ml_entry_price, p.stop_loss AS ml_stop_loss,
           p.target1 AS ml_target1, p.target2 AS ml_target2
    FROM daily_recommendations dr
    LEFT JOIN stocks s ON s.symbol = dr.symbol
    LEFT JOIN predictions p ON p.stock_id = s.id
      AND p.generated_at = (SELECT MAX(p2.generated_at) FROM predictions p2 WHERE p2.stock_id = s.id)
    WHERE dr.date=? AND dr.has_buy_signal=1 AND dr.confidence >= ?
    ORDER BY dr.confidence DESC, dr.score DESC
    LIMIT 3
  `).bind(prevDay, cb.buyConfThreshold).all<any>()

  if (!buyRecs || buyRecs.length === 0) {
    console.log('[MorningSetup] 無 BUY 推薦，跳過')
    await env.KV.put(`paper:pending_buys:${today}`, '[]', { expirationTtl: 86400 })
    return
  }

  // 美股前夜 context（供 Debate 參考）
  const usSignal = await env.KV.get(`us:leading:${today}`, 'json') as any
  const usContextStr = usSignal
    ? [
        usSignal.sox_return != null ? `SOX ${usSignal.sox_return >= 0 ? '+' : ''}${(usSignal.sox_return * 100).toFixed(1)}%` : null,
        usSignal.gspc_return != null ? `S&P ${usSignal.gspc_return >= 0 ? '+' : ''}${(usSignal.gspc_return * 100).toFixed(1)}%` : null,
        usSignal.vix_close != null ? `VIX ${usSignal.vix_close.toFixed(1)}` : null,
        usSignal.sentiment ? `情緒: ${usSignal.sentiment}` : null,
      ].filter(Boolean).join(' | ')
    : undefined

  // 預先批次查詢 stock_profiles（供 Debate Trader 注入 TimeVerse 資料）
  const buySymbols = buyRecs.map(r => r.symbol)
  const profileMap = new Map<string, StockProfile>()
  if (buySymbols.length > 0) {
    try {
      const placeholders = buySymbols.map(() => '?').join(',')
      const { results: profileRows } = await env.DB.prepare(
        `SELECT symbol, business_desc, key_customers, key_suppliers FROM stock_profiles WHERE symbol IN (${placeholders})`
      ).bind(...buySymbols).all<any>()
      for (const row of profileRows ?? []) {
        profileMap.set(row.symbol, {
          business_desc: row.business_desc,
          key_customers: row.key_customers,
          key_suppliers: row.key_suppliers,
        })
      }
    } catch (e) {
      console.warn('[MorningSetup] stock_profiles query failed:', e)
    }
  }

  // Debate 篩選
  const pendingBuys: PendingBuy[] = []
  for (const rec of buyRecs) {
    let debateVerdict = 'APPROVE'
    let riskPct = calcRiskPct(rec.signal, rec.confidence)

    if ((env as any).LOCAL_TUNNEL_URL || (env as any).AI || env.ANTHROPIC_API_KEY) {
      try {
        const debate = await runBuyDebate(
          rec.symbol, rec.name ?? rec.symbol,
          rec.signal, rec.confidence,
          rec.reason ?? 'ML ensemble signal',
          { LOCAL_TUNNEL_URL: (env as any).LOCAL_TUNNEL_URL, AI: (env as any).AI, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, KV: env.KV },
          usContextStr,
          profileMap.get(rec.symbol),
        )
        debateVerdict = debate.verdict
        if (debate.verdict === 'REJECT') {
          console.log(`[MorningSetup] ${rec.symbol} REJECTED by debate`)
          continue
        }
        if (debate.verdict === 'DOWNGRADE') riskPct *= 0.5
      } catch (e) {
        console.warn(`[Debate] ${rec.symbol} failed: ${e}`)
      }
    }

    if (!rec.ml_entry_price || rec.ml_entry_price <= 0) {
      console.log(`[MorningSetup] ${rec.symbol} 無 ML entry_price，跳過`)
      continue
    }

    pendingBuys.push({
      symbol: rec.symbol,
      name: rec.name ?? rec.symbol,
      signal: rec.signal,
      confidence: rec.confidence,
      ml_entry_price: rec.ml_entry_price,
      ml_stop_loss: rec.ml_stop_loss,
      ml_target1: rec.ml_target1,
      ml_target2: rec.ml_target2,
      reason: rec.reason ?? '',
      debate_verdict: debateVerdict,
      risk_pct: riskPct,
    })
  }

  await env.KV.put(`paper:pending_buys:${today}`, JSON.stringify(pendingBuys), { expirationTtl: 86400 })

  if (pendingBuys.length > 0) {
    const summary = pendingBuys.map(b => `${b.symbol} ≤${b.ml_entry_price}`).join(', ')
    console.log(`[MorningSetup] 掛單 ${pendingBuys.length} 支：${summary}`)
    void sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
      `📋 **今日限價掛單** ${pendingBuys.length} 支\n${pendingBuys.map(b =>
        `• ${b.symbol} ${b.name} — 限價 ≤$${b.ml_entry_price}（${b.signal} ${(b.confidence*100).toFixed(0)}%${b.debate_verdict !== 'APPROVE' ? ` [${b.debate_verdict}]` : ''}）`
      ).join('\n')}`)
  } else {
    console.log('[MorningSetup] 全部被 Debate 過濾或無 entry_price')
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Intraday Check（每分鐘）— 止損停利 + 限價買入檢查
// ════════════════════════════════════════════════════════════════════════════

export async function runIntradayCheck(env: Bindings): Promise<void> {
  const cfg = await getTradingConfig(env.KV)
  const twHour = (new Date().getUTCHours() + 8) % 24
  const twMin  = new Date().getUTCMinutes()
  const isMarketOpen = twHour >= 9 && (twHour < 13 || (twHour === 13 && twMin <= 30))

  if (!isMarketOpen) return

  // ── A. 止損/停利巡檢（原 pollIntradayStopLoss 邏輯）────────────────────
  await pollIntradayStopLoss(env)

  // ── B. 待買限價檢查 ────────────────────────────────────────────────────
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const pendingJson = await env.KV.get(`paper:pending_buys:${today}`)
  if (!pendingJson) return

  let pendingBuys: PendingBuy[] = JSON.parse(pendingJson)
  if (pendingBuys.length === 0) return

  // 13:25 後自動取消未成交掛單（ROD）
  if (twHour === 13 && twMin >= 25) {
    if (pendingBuys.length > 0) {
      const cancelled = pendingBuys.map(b => b.symbol).join(', ')
      console.log(`[Intraday] ROD 取消未成交：${cancelled}`)
      void sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
        `⏰ **收盤前取消未成交掛單**\n${pendingBuys.map(b => `• ${b.symbol} ${b.name}（限價 $${b.ml_entry_price}）`).join('\n')}`)
      await env.KV.put(`paper:pending_buys:${today}`, '[]', { expirationTtl: 86400 })
    }
    return
  }

  // 取即時價格
  const pendingSymbols = pendingBuys.map(b => b.symbol)
  const priceMap = await batchGetIntradayPrices(pendingSymbols, { SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL })
  if (priceMap.size === 0) return

  // 帳戶 + 持倉資訊（for position sizing）
  const acc = await env.DB.prepare('SELECT cash, initial_cash FROM paper_accounts WHERE id=?').bind(ACCOUNT_ID).first<any>()
  if (!acc || acc.cash < cfg.position.minCashToTrade) return

  const { results: positions } = await env.DB.prepare(
    'SELECT symbol, shares FROM paper_positions WHERE account_id=? AND shares>0'
  ).bind(ACCOUNT_ID).all<any>()
  const posSymbols = (positions ?? []).map((p: any) => p.symbol)
  const posValueMap = await batchGetIntradayPrices(posSymbols, { SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL })
  let positionValue = 0
  for (const pos of (positions ?? [])) {
    const p = posValueMap.get(pos.symbol) ?? 0
    positionValue += p * pos.shares
  }
  const totalPortfolio = acc.cash + positionValue

  // ATR batch fetch
  const atrMap = await batchGetATR(env.DB, pendingSymbols)

  // 每日買入額度
  const DAILY_BUY_LIMIT = cfg.position.dailyBuyLimit
  const todayBought = await env.DB.prepare(
    "SELECT COALESCE(SUM(total_cost), 0) as total FROM paper_orders WHERE account_id=? AND side='buy' AND created_at >= ?"
  ).bind(ACCOUNT_ID, today).first<any>()
  let dailyBuyTotal = todayBought?.total ?? 0

  // 族群集中度
  const sectorCountMap = new Map<string, number>()
  if (posSymbols.length > 0) {
    const sectorPlaceholders = posSymbols.map(() => '?').join(',')
    const { results: sectorRows } = await env.DB.prepare(
      `SELECT symbol, sector FROM stocks WHERE symbol IN (${sectorPlaceholders})`
    ).bind(...posSymbols).all<{ symbol: string; sector: string | null }>()
    for (const row of (sectorRows ?? [])) {
      const sec = row.sector ?? '未分類'
      sectorCountMap.set(sec, (sectorCountMap.get(sec) ?? 0) + 1)
    }
  }

  let filled = false
  for (const pending of [...pendingBuys]) {
    const price = priceMap.get(pending.symbol)
    if (!price) continue

    // 限價檢查：即時價 ≤ ML entry_price 才成交
    if (price > pending.ml_entry_price) continue

    // 額度檢查
    if (dailyBuyTotal >= DAILY_BUY_LIMIT) break
    if (acc.cash < cfg.position.minCashToTrade) break

    // 族群檢查
    const recSector = (await env.DB.prepare('SELECT sector FROM stocks WHERE symbol=?').bind(pending.symbol).first<any>())?.sector ?? '未分類'
    if ((sectorCountMap.get(recSector) ?? 0) >= 2) {
      console.log(`[Intraday] ${pending.symbol} 同族群已滿，跳過`)
      continue
    }

    // Position sizing
    const atr14 = atrMap.get(pending.symbol) ?? price * cfg.exit.fallbackAtrPct
    const stopPct = Math.max(cfg.position.minStopPct, (atr14 * 2) / price)
    const riskBudget = totalPortfolio * pending.risk_pct / stopPct
    const dailyRemaining = DAILY_BUY_LIMIT - dailyBuyTotal
    const budget = Math.min(riskBudget, totalPortfolio * cfg.position.maxPctOfPortfolio, acc.cash * cfg.position.maxPctOfCash, dailyRemaining)

    const fullLots = Math.floor(budget / (price * 1000))
    let shares: number, isOddLot = false
    if (fullLots >= 1) { shares = fullLots * 1000 }
    else { shares = Math.floor(budget / price); isOddLot = true; if (shares < 1) { console.log(`[Intraday] ${pending.symbol}: shares<1, skip`); continue } }

    const txValue = price * shares
    const commission = calcCommission(txValue, cfg)
    const totalCost = txValue + commission
    if (totalCost > acc.cash || dailyBuyTotal + totalCost > DAILY_BUY_LIMIT) continue

    // 出場參數
    const volPct = atr14 / price
    const slMult = volPct < 0.015 ? 1.5 : volPct < 0.03 ? 2.0 : 2.5
    const initialStop = price - atr14 * slMult
    const tp1Price = price + atr14 * 1.5
    const tp2Price = price + atr14 * 3.0

    const existing = await env.DB.prepare(
      'SELECT shares, avg_cost FROM paper_positions WHERE account_id=? AND symbol=?'
    ).bind(ACCOUNT_ID, pending.symbol).first<any>()
    const oldShares = existing?.shares ?? 0
    const oldAvgCost = existing?.avg_cost ?? 0
    const updatedShares = oldShares + shares
    const updatedAvgCost = oldShares > 0
      ? (oldShares * oldAvgCost + txValue + commission) / updatedShares
      : totalCost / shares

    await env.DB.batch([
      env.DB.prepare("UPDATE paper_accounts SET cash=cash-?, updated_at=datetime('now') WHERE id=?").bind(totalCost, ACCOUNT_ID),
      env.DB.prepare(`
        INSERT INTO paper_positions (account_id, symbol, name, shares, avg_cost, updated_at,
          entry_price, entry_date, initial_stop, trailing_stop, highest_since_entry,
          stop_multiplier, tp1_price, tp2_price, tp1_hit, original_shares)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(account_id, symbol) DO UPDATE SET
          shares=excluded.shares, avg_cost=excluded.avg_cost, name=excluded.name, updated_at=datetime('now')
      `).bind(ACCOUNT_ID, pending.symbol, pending.name, updatedShares, updatedAvgCost,
              price, today, initialStop, initialStop, price, slMult, tp1Price, tp2Price, shares),
      env.DB.prepare(`
        INSERT INTO paper_orders
          (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
        VALUES (?, ?, ?, 'buy', ?, ?, ?, 0, ?, 'auto_ml', ?, ?, ?)
      `).bind(ACCOUNT_ID, pending.symbol, pending.name, shares, price, commission, totalCost, pending.signal, pending.confidence,
              JSON.stringify({
                debate: pending.debate_verdict,
                ml_entry: pending.ml_entry_price,
                ml_stop: pending.ml_stop_loss,
                ml_t1: pending.ml_target1,
                ml_t2: pending.ml_target2,
                risk_pct: pending.risk_pct,
                stop_pct: stopPct,
                atr14,
                budget: Math.round(budget),
                fill_type: 'limit_intraday',
              })),
    ])

    ;(acc as any).cash -= totalCost
    dailyBuyTotal += totalCost
    sectorCountMap.set(recSector, (sectorCountMap.get(recSector) ?? 0) + 1)

    const lotTag = isOddLot ? ' [零股]' : ''
    console.log(`[Intraday] ✅ 成交 ${pending.symbol} ${shares}股${lotTag} @ ${price}（限價 ${pending.ml_entry_price}）`)
    void sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
      `✅ **限價成交** ${pending.symbol} ${pending.name}\n` +
      `• ${shares}股${lotTag} @ $${price}（限價 ≤$${pending.ml_entry_price}）\n` +
      `• 止損 $${initialStop.toFixed(1)} | TP1 $${tp1Price.toFixed(1)} | TP2 $${tp2Price.toFixed(1)}`)

    // 從待買清單移除
    pendingBuys = pendingBuys.filter(b => b.symbol !== pending.symbol)
    filled = true
  }

  if (filled) {
    await env.KV.put(`paper:pending_buys:${today}`, JSON.stringify(pendingBuys), { expirationTtl: 86400 })
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 3. EOD Exit（14:10 TW）— ML SELL + 時間止損
// ════════════════════════════════════════════════════════════════════════════

export async function runEODExit(env: Bindings): Promise<void> {
  console.log('[EODExit] Starting...')
  const cfg = await getTradingConfig(env.KV)

  const { results: exitPositions } = await env.DB.prepare(
    `SELECT symbol, shares, avg_cost, name, entry_price, entry_date,
            initial_stop, trailing_stop, highest_since_entry, stop_multiplier,
            tp1_price, tp2_price, tp1_hit, original_shares
     FROM paper_positions WHERE account_id=? AND shares>0`
  ).bind(ACCOUNT_ID).all<any>()

  if (!exitPositions || exitPositions.length === 0) { console.log('[EODExit] 無持倉'); return }

  const exitSymbols = exitPositions.map((p: any) => p.symbol)
  const exitPriceMap = await batchGetIntradayPrices(exitSymbols, { SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL })
  const exitAtrMap = await batchGetATR(env.DB, exitSymbols)

  // ML SELL signals（讀前一交易日推薦）
  const prevDay = await getPrevTradingDay(env.DB)
  const cb = await checkCircuitBreakers(env.DB, cfg)
  let sellRecMap = new Map<string, any>()
  if (exitSymbols.length > 0) {
    const placeholders = exitSymbols.map(() => '?').join(',')
    const { results: sellRecs } = await env.DB.prepare(`
      SELECT symbol, signal, confidence FROM daily_recommendations
      WHERE date=? AND symbol IN (${placeholders})
        AND signal IN ('SELL','STRONG_SELL') AND confidence >= ?
    `).bind(prevDay, ...exitSymbols, cb.sellConfThreshold).all<any>()
    for (const r of (sellRecs ?? [])) sellRecMap.set(r.symbol, r)
  }

  for (const pos of exitPositions) {
    const currentPrice = exitPriceMap.get(pos.symbol)
    if (!currentPrice) continue

    const atr14 = exitAtrMap.get(pos.symbol) ?? currentPrice * cfg.exit.fallbackAtrPct
    const decision = checkExitConditions(pos, currentPrice, atr14, sellRecMap.has(pos.symbol), true, cfg)

    if (decision.action === 'full_sell') {
      const shares = pos.shares
      const txValue = currentPrice * shares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg)
      const proceeds = txValue - commission - tax

      await env.DB.batch([
        env.DB.prepare("UPDATE paper_accounts SET cash=cash+?, updated_at=datetime('now') WHERE id=?").bind(proceeds, ACCOUNT_ID),
        env.DB.prepare('DELETE FROM paper_positions WHERE account_id=? AND symbol=?').bind(ACCOUNT_ID, pos.symbol),
        env.DB.prepare(`
          INSERT INTO paper_orders
            (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
          VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, 'eod_exit', ?, ?, ?)
        `).bind(ACCOUNT_ID, pos.symbol, pos.name, shares, currentPrice, commission, tax, proceeds,
                sellRecMap.get(pos.symbol)?.signal ?? 'EXIT', sellRecMap.get(pos.symbol)?.confidence ?? null,
                JSON.stringify({ reason: decision.reason, entry_price: pos.entry_price, entry_date: pos.entry_date,
                  days_held: pos.entry_date ? Math.round((Date.now() - new Date(pos.entry_date).getTime()) / 86400000) : null })),
      ])
      const entryPx = pos.entry_price ?? pos.avg_cost
      const exitPnl = (currentPrice - entryPx) / entryPx
      const daysHeld = pos.entry_date ? Math.round((Date.now() - new Date(pos.entry_date).getTime()) / 86400000) : 0
      console.log(`[EODExit] 出場 ${pos.symbol} ${shares}股 @ ${currentPrice}（進${entryPx} ${daysHeld}天 ${(exitPnl*100).toFixed(1)}%）— ${decision.reason}`)
      void sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, shares, currentPrice,
          `${decision.reason} | 進場${entryPx} 持有${daysHeld}天`, exitPnl))

    } else if (decision.action === 'partial_sell' && decision.sellShares) {
      const sellShares = decision.sellShares
      const txValue = currentPrice * sellShares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg)
      const proceeds = txValue - commission - tax
      const remainingShares = pos.shares - sellShares

      await env.DB.batch([
        env.DB.prepare("UPDATE paper_accounts SET cash=cash+?, updated_at=datetime('now') WHERE id=?").bind(proceeds, ACCOUNT_ID),
        env.DB.prepare(`
          UPDATE paper_positions SET shares=?, tp1_hit=1,
            trailing_stop=CASE WHEN ? > COALESCE(trailing_stop, 0) THEN ? ELSE trailing_stop END,
            updated_at=datetime('now')
          WHERE account_id=? AND symbol=?
        `).bind(remainingShares, pos.entry_price ?? pos.avg_cost, pos.entry_price ?? pos.avg_cost, ACCOUNT_ID, pos.symbol),
        env.DB.prepare(`
          INSERT INTO paper_orders
            (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
          VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, 'eod_tp1', 'TP1', ?, ?)
        `).bind(ACCOUNT_ID, pos.symbol, pos.name, sellShares, currentPrice, commission, tax, proceeds, null, decision.reason),
      ])
      const tp1Pnl = (currentPrice - (pos.entry_price ?? pos.avg_cost)) / (pos.entry_price ?? pos.avg_cost)
      console.log(`[EODExit] TP1 ${pos.symbol} ${sellShares}股 @ ${currentPrice}`)
      void sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, sellShares, currentPrice,
          `TP1 停利（剩 ${remainingShares} 股）`, tp1Pnl))
    }
  }
  console.log('[EODExit] Done.')
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Daily Snapshot（14:20 TW）
// ════════════════════════════════════════════════════════════════════════════

export async function runDailySnapshot(env: Bindings): Promise<void> {
  console.log('[Snapshot] Starting...')
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  const updatedAcc = await env.DB.prepare('SELECT cash, initial_cash FROM paper_accounts WHERE id=?').bind(ACCOUNT_ID).first<any>()
  if (!updatedAcc) return

  const { results: finalPos } = await env.DB.prepare(
    'SELECT symbol, shares FROM paper_positions WHERE account_id=? AND shares>0'
  ).bind(ACCOUNT_ID).all<any>()

  const finalSymbols = (finalPos ?? []).map((p: any) => p.symbol)
  // 嘗試即時價，fallback to D1 close
  let finalPriceMap = await batchGetIntradayPrices(finalSymbols, { SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL })
  if (finalPriceMap.size === 0) finalPriceMap = await batchGetLatestPrices(env.DB, finalSymbols)

  let finalPosValue = 0
  for (const p of (finalPos ?? [])) {
    const px = finalPriceMap.get(p.symbol)
    if (px) finalPosValue += px * p.shares
  }

  const tv = updatedAcc.cash + finalPosValue
  const pnl = tv - updatedAcc.initial_cash
  const pnlP = updatedAcc.initial_cash > 0 ? pnl / updatedAcc.initial_cash * 100 : 0

  // benchmark
  const benchRow = await env.DB.prepare(`
    SELECT sp.close FROM stock_prices sp JOIN stocks s ON s.id = sp.stock_id
    WHERE s.symbol = '0050' AND sp.close IS NOT NULL ORDER BY sp.date DESC LIMIT 1
  `).first<any>()
  const benchmarkValue: number | null = benchRow?.close ?? null

  // max drawdown
  const { results: allSnapshots } = await env.DB.prepare(
    'SELECT total_value FROM paper_daily_snapshots WHERE account_id=? ORDER BY date ASC'
  ).bind(ACCOUNT_ID).all<any>()
  let maxDrawdownToDate: number | null = null
  if (allSnapshots && allSnapshots.length > 0) {
    let peak = updatedAcc.initial_cash, maxDd = 0
    for (const s of allSnapshots) { const v = s.total_value as number; if (v > peak) peak = v; const dd = peak > 0 ? (peak - v) / peak : 0; if (dd > maxDd) maxDd = dd }
    maxDrawdownToDate = Math.max(maxDd, peak > 0 ? (peak - tv) / peak : 0)
  }

  // sharpe 30d
  let sharpe30d: number | null = null
  const { results: recent30 } = await env.DB.prepare(
    'SELECT total_value FROM paper_daily_snapshots WHERE account_id=? ORDER BY date DESC LIMIT 31'
  ).bind(ACCOUNT_ID).all<any>()
  if (recent30 && recent30.length >= 10) {
    const vals = recent30.map((s: any) => s.total_value as number).reverse()
    const returns: number[] = []
    for (let i = 1; i < vals.length; i++) { if (vals[i-1] > 0) returns.push((vals[i] - vals[i-1]) / vals[i-1]) }
    if (returns.length >= 5) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length
      const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length)
      sharpe30d = std > 0 ? (mean / std) * Math.sqrt(252) : null
    }
  }

  await env.DB.prepare(`
    INSERT INTO paper_daily_snapshots
      (account_id, date, cash, positions_value, total_value, pnl, pnl_pct,
       benchmark_value, max_drawdown_to_date, sharpe_30d)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, date) DO UPDATE SET
      cash=excluded.cash, positions_value=excluded.positions_value,
      total_value=excluded.total_value, pnl=excluded.pnl, pnl_pct=excluded.pnl_pct,
      benchmark_value=excluded.benchmark_value, max_drawdown_to_date=excluded.max_drawdown_to_date,
      sharpe_30d=excluded.sharpe_30d
  `).bind(ACCOUNT_ID, today, updatedAcc.cash, finalPosValue, tv, pnl, pnlP,
           benchmarkValue, maxDrawdownToDate, sharpe30d).run()

  console.log(`[Snapshot] 總資產 NT$${Math.round(tv).toLocaleString()}，損益 ${(pnlP).toFixed(2)}%`)

  const todayOrderCount = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM paper_orders WHERE account_id=? AND created_at >= ?"
  ).bind(ACCOUNT_ID, today).first<any>()
  void sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
    formatDailySummary(tv, pnlP / 100, todayOrderCount?.cnt ?? 0, maxDrawdownToDate, sharpe30d))
}

// ─── 保留舊 export（向後兼容 admin trigger）────────────────────────────────
export async function runPaperAutoTrade(env: Bindings): Promise<void> {
  await setupMorningPendingBuys(env)
}

// ─── 盤中 Stop-Loss + TP Polling（每 5 分鐘 Cron 呼叫）─────────────────────
export async function pollIntradayStopLoss(env: Bindings): Promise<void> {
  const cfg = await getTradingConfig(env.KV)
  const { results: positions } = await env.DB.prepare(
    `SELECT symbol, shares, avg_cost, name, entry_price, entry_date,
            initial_stop, trailing_stop, highest_since_entry, stop_multiplier,
            tp1_price, tp2_price, tp1_hit, original_shares
     FROM paper_positions WHERE account_id=? AND shares>0`
  ).bind(ACCOUNT_ID).all<any>()

  if (!positions || positions.length === 0) return

  const symbols = positions.map((p: any) => p.symbol)
  const priceMap = await batchGetIntradayPrices(symbols, { SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL })
  const atrMap = await batchGetATR(env.DB, symbols)

  if (priceMap.size === 0) {
    console.log('[Intraday] 無法取得盤中報價，跳過')
    return
  }

  // 快取盤中報價到 KV（positions endpoint 盤中讀取用，TTL 10 min）
  await Promise.allSettled(
    [...priceMap].map(([symbol, price]) =>
      env.KV.put(`intraday:price:${symbol}`, String(price), { expirationTtl: 600 })
    )
  )

  for (const pos of positions) {
    const currentPrice = priceMap.get(pos.symbol)
    if (!currentPrice) continue

    const atr14 = atrMap.get(pos.symbol) ?? currentPrice * cfg.exit.fallbackAtrPct
    const decision = checkExitConditions(pos, currentPrice, atr14, false, false, cfg)  // isEOD=false, no ML signal

    if (decision.action === 'full_sell') {
      const shares = pos.shares
      const txValue = currentPrice * shares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg)
      const proceeds = txValue - commission - tax

      await env.DB.batch([
        env.DB.prepare("UPDATE paper_accounts SET cash=cash+?, updated_at=datetime('now') WHERE id=?").bind(proceeds, ACCOUNT_ID),
        env.DB.prepare('DELETE FROM paper_positions WHERE account_id=? AND symbol=?').bind(ACCOUNT_ID, pos.symbol),
        env.DB.prepare(`
          INSERT INTO paper_orders
            (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
          VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, 'intraday_exit', 'EXIT', ?, ?)
        `).bind(ACCOUNT_ID, pos.symbol, pos.name, shares, currentPrice, commission, tax, proceeds,
                null, `[盤中] ${decision.reason}`),
      ])
      console.warn(`[Intraday] 出場 ${pos.symbol} ${shares}股 @ ${currentPrice} — ${decision.reason}`)
      const intradayPnl = (currentPrice - (pos.entry_price ?? pos.avg_cost)) / (pos.entry_price ?? pos.avg_cost)
      void sendDiscordNotification(env.DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, shares, currentPrice,
          `⚡盤中 ${decision.reason}`, intradayPnl))

    } else if (decision.action === 'partial_sell' && decision.sellShares) {
      const sellShares = decision.sellShares
      const txValue = currentPrice * sellShares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg)
      const proceeds = txValue - commission - tax
      const remainingShares = pos.shares - sellShares

      await env.DB.batch([
        env.DB.prepare("UPDATE paper_accounts SET cash=cash+?, updated_at=datetime('now') WHERE id=?").bind(proceeds, ACCOUNT_ID),
        env.DB.prepare(`
          UPDATE paper_positions SET shares=?, tp1_hit=1,
            trailing_stop=CASE WHEN ? > COALESCE(trailing_stop, 0) THEN ? ELSE trailing_stop END,
            updated_at=datetime('now')
          WHERE account_id=? AND symbol=?
        `).bind(remainingShares, pos.entry_price ?? pos.avg_cost, pos.entry_price ?? pos.avg_cost, ACCOUNT_ID, pos.symbol),
        env.DB.prepare(`
          INSERT INTO paper_orders
            (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
          VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, 'intraday_tp1', 'TP1', ?, ?)
        `).bind(ACCOUNT_ID, pos.symbol, pos.name, sellShares, currentPrice, commission, tax, proceeds,
                null, `[盤中] ${decision.reason}`),
      ])
      console.log(`[Intraday] TP1 ${pos.symbol} ${sellShares}股 @ ${currentPrice} — ${decision.reason}`)
      const tp1IntradayPnl = (currentPrice - (pos.entry_price ?? pos.avg_cost)) / (pos.entry_price ?? pos.avg_cost)
      void sendDiscordNotification(env.DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, sellShares, currentPrice,
          `⚡盤中 TP1（剩 ${remainingShares} 股）`, tp1IntradayPnl))

    } else if (decision.action === 'hold' && (decision.newTrailingStop || decision.newHighest)) {
      await env.DB.prepare(`
        UPDATE paper_positions SET trailing_stop=?, highest_since_entry=?, updated_at=datetime('now')
        WHERE account_id=? AND symbol=?
      `).bind(
        decision.newTrailingStop ?? pos.trailing_stop,
        decision.newHighest ?? pos.highest_since_entry,
        ACCOUNT_ID, pos.symbol,
      ).run()
    }
  }

  console.log(`[Intraday] 巡檢完成，${positions.length} 持倉，${priceMap.size} 有報價`)
}
