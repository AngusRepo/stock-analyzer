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

import { Hono, type Context } from 'hono'
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

/**
 * P1#13: Enhanced slippage model with volume consideration
 * 台股 tick size: <10→0.01, <50→0.05, <100→0.1, <500→0.5, <1000→1, ≥1000→5
 * Small cap (daily turnover < 50M) → extra slippage 1-2%
 */
function getTickSize(price: number): number {
  return price < 10 ? 0.01 : price < 50 ? 0.05 : price < 100 ? 0.1 : price < 500 ? 0.5 : price < 1000 ? 1 : 5
}
function applySlippage(price: number, side: 'buy' | 'sell', ticks = 1, dailyTurnover?: number): number {
  const tickSize = getTickSize(price)
  // P1#13: Volume-based extra slippage for low-liquidity stocks
  let extraTicks = 0
  if (dailyTurnover != null && dailyTurnover > 0) {
    if (dailyTurnover < 10_000_000) extraTicks = 3      // < 1千萬: +3 ticks (very illiquid)
    else if (dailyTurnover < 50_000_000) extraTicks = 1  // < 5千萬: +1 tick
  }
  const slippage = tickSize * (ticks + extraTicks)
  return side === 'buy' ? price + slippage : Math.max(price - slippage, tickSize)
}

/**
 * P1#13: Partial fill simulation — order > 5% of daily volume → partial fill
 */
function applyPartialFill(shares: number, price: number, dailyVolume: number): number {
  if (dailyVolume <= 0) return shares
  const orderVolume = shares * price
  const dailyValue = dailyVolume * price
  const pctOfDaily = orderVolume / dailyValue
  if (pctOfDaily > 0.05) {
    // Fill only 80% of shares that exceed 5% threshold
    const maxFillValue = dailyValue * 0.05
    const excessShares = Math.max(0, shares - Math.floor(maxFillValue / price))
    const filledShares = shares - Math.floor(excessShares * 0.2)
    console.log(`[PartialFill] Order ${shares} shares = ${(pctOfDaily*100).toFixed(1)}% of daily vol → filled ${filledShares}`)
    return Math.max(1, filledShares)
  }
  return shares
}

/**
 * P1#13: Limit-down lock detection — can't exit if stock is locked limit-down
 * Drop >= 9.5% + volume < 10% of yesterday → locked, can't sell
 */
function isLimitDownLocked(currentPrice: number, prevClose: number, volume: number, prevVolume: number): boolean {
  if (prevClose <= 0) return false
  const dropPct = (currentPrice - prevClose) / prevClose
  const volRatio = prevVolume > 0 ? volume / prevVolume : 1
  return dropPct <= -0.095 && volRatio < 0.1
}
function calcTax(value: number, cfg: TradingConfig, isDayTrade = false): number {
  const rate = isDayTrade ? cfg.fees.dayTradeTax : cfg.fees.tax
  return Math.round(value * rate)
}

/**
 * 判斷同日部位是否允許當沖賣出。
 * 規則：(1) 非零股 (2) 當沖標的 (3) 觸發動態停利/止損
 */
async function isDayTradeAllowed(
  symbol: string, shares: number, exitReason: string, kv: KVNamespace,
): Promise<{ allowed: boolean; reason: string }> {
  if (shares % 1000 !== 0) return { allowed: false, reason: '零股不可當沖' }

  const raw = await kv.get('market:daytrade_eligible')
  if (!raw) return { allowed: false, reason: '無當沖標的清單（KV 未載入）' }
  try {
    const eligible = JSON.parse(raw) as string[]
    if (!eligible.includes(symbol)) return { allowed: false, reason: `${symbol} 非當沖標的` }
  } catch { return { allowed: false, reason: '當沖標的 KV 解析失敗' } }

  // 只允許動態停利/止損觸發（不允許 ML SELL、時間止損等）
  const allowedTriggers = ['硬上限止損', 'ATR 初始止損', 'Trailing Stop', 'TP1', 'TP2']
  if (!allowedTriggers.some(t => exitReason.includes(t))) {
    return { allowed: false, reason: `非動態停利/止損（${exitReason}）→ 留到明天正常出場` }
  }

  return { allowed: true, reason: '當沖條件滿足' }
}

async function getLatestPrice(db: D1Database, symbol: string): Promise<number | null> {
  const row = await db.prepare(`
    SELECT COALESCE(sp.avg_price, sp.close) as price FROM stock_prices sp
    JOIN stocks s ON s.id = sp.stock_id
    WHERE s.symbol = ? AND sp.close IS NOT NULL
    ORDER BY sp.date DESC LIMIT 1
  `).bind(symbol).first<any>()
  return row?.price ?? null
}

// ─── Batch Price Fetch（N+1 修復）────────────────────────────────────────────
// 取多支股票的最新收盤價，一次 query 完成，避免 for loop 中逐一查詢
async function batchGetLatestPrices(db: D1Database, symbols: string[]): Promise<Map<string, number>> {
  if (symbols.length === 0) return new Map()
  const placeholders = symbols.map(() => '?').join(',')
  const { results } = await db.prepare(`
    SELECT s.symbol, COALESCE(sp.avg_price, sp.close) as price
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
    if (row.price != null) map.set(row.symbol, row.price)
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

    // P1-9: MDD-based 動態部位管理（FinLab 槓桿調控公式）
    // M(k) = gamma * (epsilon_bar - mdd(k)) / (1 - mdd(k))
    // gamma=1（無槓桿），epsilon_bar=drawdownHalt（最大容忍回撤）
    // 效果：MDD 增加 → 逐步縮減 maxPositionPct，接近上限時幾乎清倉
    if (drawdown > cc.drawdownHalt) {
      console.warn(`[CircuitBreaker] Layer1 HALT: drawdown ${(drawdown * 100).toFixed(1)}% > ${(cc.drawdownHalt * 100).toFixed(0)}%`)
      return { halt: true, reason: `30日回撤 ${(drawdown * 100).toFixed(1)}% 超過 ${(cc.drawdownHalt * 100).toFixed(0)}% 上限`, maxPositionPct: 0, buyConfThreshold: cc.drawdownRaisedConf, sellConfThreshold: cc.drawdownRaisedConf }
    } else if (drawdown > 0.03) {
      // 連續調控：drawdown 3%~15% 之間逐步縮減部位
      const mddMultiplier = Math.max(0.2, (cc.drawdownHalt - drawdown) / (1 - drawdown))
      const adjustedPosPct = cc.maxPositionPct * mddMultiplier
      const adjustedConf = drawdown > cc.drawdownHalt * 0.5
        ? cc.drawdownRaisedConf  // 回撤超過一半上限 → 提高信心門檻
        : cc.buyConfThreshold
      console.log(`[CircuitBreaker] Layer1 SCALE: drawdown ${(drawdown * 100).toFixed(1)}% → posPct ${(adjustedPosPct * 100).toFixed(1)}% (mult=${mddMultiplier.toFixed(2)})`)
      return { ...defaults, maxPositionPct: adjustedPosPct, buyConfThreshold: adjustedConf, reason: `MDD ${(drawdown * 100).toFixed(1)}% 動態縮減` }
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

  // Layer 5: 連續虧損暫停（nofx SafetyMode）— 最近 5 筆平倉中 >= 3 筆虧損 → 暫停 1 天
  try {
    const { results: recentSells } = await db.prepare(
      `SELECT price, note FROM paper_orders WHERE account_id=? AND side='sell' ORDER BY id DESC LIMIT 5`
    ).bind(ACCOUNT_ID).all<any>()
    if (recentSells && recentSells.length >= 3) {
      let lossCount = 0
      for (const s of recentSells) {
        try {
          const n = typeof s.note === 'string' ? JSON.parse(s.note) : s.note
          const entry = n?.entry_price ?? s.price
          if (s.price < entry) lossCount++
        } catch { /* skip */ }
      }
      if (lossCount >= 3) {
        console.warn(`[CircuitBreaker] Layer5 HALT: ${lossCount}/${recentSells.length} 近期交易虧損，暫停掛單`)
        return { halt: true, reason: `連續 ${lossCount} 筆虧損（SafetyMode）`, ...defaults }
      }
    }
  } catch (e) {
    console.warn('[CircuitBreaker] Layer5 check failed (non-fatal):', e)
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
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
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
      entry_price:      pos.entry_price ? Math.round(pos.entry_price * 100) / 100 : null,
      entry_date:       pos.entry_date,
      current_price:    currentPrice,
      market_value:     Math.round(marketValue),
      unrealized_pnl:   Math.round(unrealizedPnl),
      unrealized_pnl_pct: Math.round(unrealizedPnlPct * 100) / 100,
      price_source:     intradayMap.has(pos.symbol) ? 'intraday' as const : 'eod' as const,
      // 動態停利/停損（盤中每分鐘更新）
      initial_stop:     pos.initial_stop ? Math.round(pos.initial_stop * 10) / 10 : null,
      trailing_stop:    pos.trailing_stop ? Math.round(pos.trailing_stop * 10) / 10 : null,
      tp1_price:        pos.tp1_price ? Math.round(pos.tp1_price * 10) / 10 : null,
      tp2_price:        pos.tp2_price ? Math.round(pos.tp2_price * 10) / 10 : null,
      tp1_hit:          !!pos.tp1_hit,
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
    'SELECT date, total_value, pnl, pnl_pct, benchmark_value, twii_value, max_drawdown_to_date, sharpe_30d, sortino_30d, calmar, cagr FROM paper_daily_snapshots WHERE account_id=? ORDER BY date ASC'
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

// ─── GET /api/paper/quadrant-filter — T2 過濾紀錄（Bot Dashboard 用）────────

paper.get('/quadrant-filter', async (c) => {
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const raw = await c.env.KV.get(`paper:quadrant_filter:${date}`, 'json')
  return c.json({ date, filters: raw ?? [] })
})

// ─── GET /api/paper/pending-buys — T2 過濾後的今日掛單（Bot Dashboard 用）────
paper.get('/pending-buys', async (c) => {
  // 先查今天，沒有則查上一個有掛單的日期
  const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  let raw = await c.env.KV.get(`paper:pending_buys:${twToday}`, 'json') as any[] | null
  let date = twToday
  if (!raw || !Array.isArray(raw) || raw.length === 0) {
    // 往回找最近 4 天
    for (let d = 1; d <= 4; d++) {
      const prev = new Date(Date.now() + 8 * 3600_000 - d * 86400_000).toISOString().slice(0, 10)
      raw = await c.env.KV.get(`paper:pending_buys:${prev}`, 'json') as any[] | null
      if (raw && Array.isArray(raw) && raw.length > 0) { date = prev; break }
    }
  }
  return c.json({ date, pendingBuys: raw ?? [] })
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
  chip_score: number | null
  tech_score: number | null
  ml_score: number | null
  score: number | null
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
           dr.chip_score, dr.tech_score, dr.ml_score, dr.score,
           p.entry_price AS ml_entry_price, p.stop_loss AS ml_stop_loss,
           p.target1 AS ml_target1, p.target2 AS ml_target2
    FROM daily_recommendations dr
    LEFT JOIN stocks s ON s.symbol = dr.symbol
    LEFT JOIN predictions p ON p.stock_id = s.id
      AND p.generated_at = (SELECT MAX(p2.generated_at) FROM predictions p2 WHERE p2.stock_id = s.id)
    WHERE dr.date=? AND dr.has_buy_signal=1 AND dr.confidence >= ?
    ORDER BY dr.score DESC, dr.confidence DESC
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

  // 台指期夜盤 context（07:15 時夜盤已收盤，取最後成交資料）
  const { fetchTaifexNightClose } = await import('../lib/twseApi')
  const taifex = await fetchTaifexNightClose().catch(e => {
    console.warn('[MorningSetup] TAIFEX night session fetch failed:', e)
    return null
  })
  const taifexContextStr = taifex
    ? `收盤 ${taifex.lastPrice.toLocaleString()}（${taifex.changePct >= 0 ? '+' : ''}${taifex.changePct.toFixed(2)}%，${taifex.changePoints >= 0 ? '+' : ''}${taifex.changePoints.toFixed(0)} 點）`
    : undefined
  if (taifexContextStr) console.log(`[MorningSetup] 台指期夜盤: ${taifexContextStr}`)

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

  // 處置股排除（KV 每日由 screener 更新）
  let punishedSet = new Set<string>()
  try {
    const raw = await env.KV.get('market:punished_stocks', 'json') as string[] | null
    if (raw) punishedSet = new Set(raw)
  } catch { /* ignore */ }

  // ── T2 精篩：RRG Quadrant Filter ────────────────────────────────────────
  // 查每個候選股的概念 quadrant，做第二層過濾
  const quadrantFilterLog: { symbol: string; name: string; theme: string; quadrant: string; action: string; momentum_dir?: string }[] = []
  const symbolQuadrantMap = new Map<string, { theme: string; quadrant: string; rs_ratio: number; rs_momentum: number }>()
  try {
    const buySymbols = buyRecs.map((r: any) => r.symbol)
    if (buySymbols.length > 0) {
      // 查每個股票的 top tag
      const tagPlaceholders = buySymbols.map(() => '?').join(',')
      const { results: tagRows } = await env.DB.prepare(
        `SELECT symbol, tag FROM stock_tags WHERE symbol IN (${tagPlaceholders}) ORDER BY symbol, weight DESC`
      ).bind(...buySymbols).all<any>()
      const symbolTopTag = new Map<string, string>()
      for (const r of tagRows ?? []) {
        if (!symbolTopTag.has(r.symbol)) symbolTopTag.set(r.symbol, r.tag)
      }
      // 查最新 sector_flow quadrant
      const { results: qRows } = await env.DB.prepare(
        `SELECT sector, rs_ratio, rs_momentum, quadrant FROM sector_flow
         WHERE classification = 'theme' AND quadrant IS NOT NULL
           AND date = (SELECT MAX(date) FROM sector_flow WHERE classification = 'theme' AND quadrant IS NOT NULL)`
      ).all<any>()
      const quadrantMap = new Map<string, { quadrant: string; rs_ratio: number; rs_momentum: number }>()
      for (const r of qRows ?? []) {
        quadrantMap.set(r.sector, { quadrant: r.quadrant, rs_ratio: r.rs_ratio, rs_momentum: r.rs_momentum })
      }
      // 建立 symbol → quadrant mapping
      for (const sym of buySymbols) {
        const tag = symbolTopTag.get(sym)
        if (tag) {
          const q = quadrantMap.get(tag)
          if (q) symbolQuadrantMap.set(sym, { theme: tag, ...q })
        }
      }
    }
  } catch (e) {
    console.warn('[MorningSetup] Quadrant query failed (non-fatal):', e)
  }

  // Debate 篩選（含 T2 Quadrant Filter）
  const pendingBuys: PendingBuy[] = []
  for (const rec of buyRecs) {
    if (punishedSet.has(rec.symbol)) {
      console.log(`[MorningSetup] ${rec.symbol} 處置股，跳過`)
      continue
    }

    // T2 Quadrant Filter
    const qInfo = symbolQuadrantMap.get(rec.symbol)
    if (qInfo) {
      if (qInfo.quadrant === 'Lagging') {
        console.log(`[T2 Filter] ${rec.symbol} REJECT — ${qInfo.theme} 在 Lagging 象限（RS ${qInfo.rs_ratio}）`)
        quadrantFilterLog.push({ symbol: rec.symbol, name: rec.name ?? rec.symbol, theme: qInfo.theme, quadrant: qInfo.quadrant, action: 'REJECT' })
        continue
      }
      if (qInfo.quadrant === 'Weakening') {
        console.log(`[T2 Filter] ${rec.symbol} DOWNGRADE — ${qInfo.theme} 在 Weakening 象限（RS ${qInfo.rs_ratio}, Mom ${qInfo.rs_momentum}）`)
        quadrantFilterLog.push({ symbol: rec.symbol, name: rec.name ?? rec.symbol, theme: qInfo.theme, quadrant: qInfo.quadrant, action: 'DOWNGRADE' })
      } else {
        // PASS — 記錄 momentum 方向供前端顯示
        const momDir = qInfo.rs_momentum >= 0 ? 'up' : 'down'
        quadrantFilterLog.push({ symbol: rec.symbol, name: rec.name ?? rec.symbol, theme: qInfo.theme, quadrant: qInfo.quadrant, action: 'PASS', momentum_dir: momDir })
      }
    }

    let debateVerdict = 'APPROVE'
    let riskPct = calcRiskPct(rec.signal, rec.confidence)
    // Weakening 象限 → 強制半倉（不進 Debate，直接 DOWNGRADE）
    if (qInfo?.quadrant === 'Weakening') {
      debateVerdict = 'DOWNGRADE'
      riskPct *= 0.5
      console.log(`[T2 Filter] ${rec.symbol} 直接 DOWNGRADE（Weakening 象限），跳過 Debate`)
    } else if ((env as any).LOCAL_TUNNEL_URL || (env as any).AI || env.ANTHROPIC_API_KEY) {
      // 正常 Debate 流程（Leading / Improving 象限）
      // Phase 4.5: 雙因子微調 — 象限 + Momentum 方向影響 confidence
      let confidenceAdj = 0
      if (qInfo) {
        if (qInfo.quadrant === 'Leading' && qInfo.rs_momentum < 0) {
          confidenceAdj = -0.03 // Leading 但動能轉弱 → 追高風險
        } else if (qInfo.quadrant === 'Improving') {
          confidenceAdj = -0.02 // 方向對但趨勢未確立
        }
        // Leading+Mom≥0 → 0.00（最佳，基準）
        if (confidenceAdj !== 0) {
          console.log(`[T2 Adj] ${rec.symbol} ${qInfo.quadrant} mom=${qInfo.rs_momentum} → conf ${confidenceAdj > 0 ? '+' : ''}${confidenceAdj}`)
        }
      }
      const adjustedConfidence = Math.max(0, rec.confidence + confidenceAdj)

      // M9 教訓：同一天同一支 debate 結果鎖定，重跑不重新 LLM 判斷
      const debateCacheKey = `paper:debate:${rec.symbol}:${today}`
      const cachedDebate = await env.KV.get(debateCacheKey, 'json') as { verdict: string; summary: string } | null
      if (cachedDebate) {
        debateVerdict = cachedDebate.verdict
        console.log(`[Debate] ${rec.symbol} cached → ${debateVerdict}`)
      } else {
        try {
          const debate = await runBuyDebate(
            rec.symbol, rec.name ?? rec.symbol,
            rec.signal, adjustedConfidence,
            rec.reason ?? 'ML ensemble signal',
            { LOCAL_TUNNEL_URL: (env as any).LOCAL_TUNNEL_URL, AI: (env as any).AI, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, KV: env.KV },
            usContextStr,
            profileMap.get(rec.symbol),
            taifexContextStr,
          )
          debateVerdict = debate.verdict
          // conviction score 影響 riskPct：低信念度 → 進一步縮減倉位
          if (debate.convictionScore < 50) {
            riskPct *= debate.convictionScore / 50  // conv=25 → riskPct × 0.5
            console.log(`[Debate] ${rec.symbol} low conviction ${debate.convictionScore} → riskPct × ${(debate.convictionScore / 50).toFixed(2)}`)
          }
          // 快取 24h
          await env.KV.put(debateCacheKey, JSON.stringify({ verdict: debate.verdict, summary: debate.summary, convictionScore: debate.convictionScore }), { expirationTtl: 86400 })
        } catch (e) {
          console.warn(`[Debate] ${rec.symbol} failed: ${e}`)
        }
      }
      if (debateVerdict === 'REJECT') {
        console.log(`[MorningSetup] ${rec.symbol} REJECTED by debate`)
        continue
      }
      if (debateVerdict === 'DOWNGRADE') riskPct *= 0.5
    }

    if (!rec.ml_entry_price || rec.ml_entry_price <= 0) {
      console.log(`[MorningSetup] ${rec.symbol} 無 ML entry_price，跳過`)
      continue
    }

    // ── Risk Gate: 台指期夜盤 + conviction 聯合調整 entry_price ──
    // Why: 盤前 ML 設的 entry_price 沒考慮隔夜期貨市場變化
    let adjustedEntry = rec.ml_entry_price
    let adjustedStop = rec.ml_stop_loss
    const originalEntry = rec.ml_entry_price

    // 夜盤大跌 + conviction 不高 → 下修 entry_price（要求更低價才買）
    const nightDropPct = taifex ? taifex.changePct : 0
    if (nightDropPct < -1.5 && debateVerdict === 'DOWNGRADE') {
      // 夜盤跌 >1.5% + DOWNGRADE → entry 下修 2%
      adjustedEntry = Math.round(rec.ml_entry_price * 0.98 * 100) / 100
      adjustedStop = Math.round(rec.ml_stop_loss * 0.98 * 100) / 100
      console.log(`[RiskGate] ${rec.symbol} 夜盤 ${nightDropPct.toFixed(1)}% + DOWNGRADE → entry ${rec.ml_entry_price} → ${adjustedEntry}`)
    } else if (nightDropPct < -0.8 && debateVerdict !== 'APPROVE') {
      // 夜盤跌 >0.8% + 非 APPROVE → entry 下修 1%
      adjustedEntry = Math.round(rec.ml_entry_price * 0.99 * 100) / 100
      adjustedStop = Math.round(rec.ml_stop_loss * 0.99 * 100) / 100
      console.log(`[RiskGate] ${rec.symbol} 夜盤 ${nightDropPct.toFixed(1)}% → entry ${rec.ml_entry_price} → ${adjustedEntry}`)
    }

    pendingBuys.push({
      symbol: rec.symbol,
      name: rec.name ?? rec.symbol,
      signal: rec.signal,
      confidence: rec.confidence,
      ml_entry_price: adjustedEntry,
      ml_stop_loss: adjustedStop,
      ml_target1: rec.ml_target1,
      ml_target2: rec.ml_target2,
      reason: rec.reason ?? '',
      debate_verdict: debateVerdict,
      risk_pct: riskPct,
      chip_score: rec.chip_score ?? null,
      tech_score: rec.tech_score ?? null,
      ml_score: rec.ml_score ?? null,
      score: rec.score ?? null,
    })
  }

  await env.KV.put(`paper:pending_buys:${today}`, JSON.stringify(pendingBuys), { expirationTtl: 86400 })

  // T2 Quadrant filter log（Bot Dashboard 顯示用）
  if (quadrantFilterLog.length > 0) {
    await env.KV.put(`paper:quadrant_filter:${today}`, JSON.stringify(quadrantFilterLog), { expirationTtl: 7 * 86400 })
  }

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

  // 極端行情二次 poll：market_risk >= orange 時，30 秒後再檢查一次
  // Why: 急跌行情 1 分鐘可能太慢，30 秒內股價可能跌穿止損
  const riskRaw = await env.KV.get('market:risk_level')
  if (riskRaw && ['orange', 'red', 'black'].includes(riskRaw)) {
    await new Promise(r => setTimeout(r, 30_000))  // 等 30 秒
    await pollIntradayStopLoss(env)
  }

  // ── B. 13:25 收盤前處理 ────────────────────────────────────────────────
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  if (twHour === 13 && twMin >= 25) {
    // B1: 強制平倉已觸發出場條件的同日當沖部位
    await forceDayTradeClose(env, cfg, today)

    // B2: 取消未成交掛單（ROD）
    const pendingJson = await env.KV.get(`paper:pending_buys:${today}`)
    if (pendingJson) {
      const pendingBuys: PendingBuy[] = JSON.parse(pendingJson)
      if (pendingBuys.length > 0) {
        const cancelled = pendingBuys.map(b => b.symbol).join(', ')
        console.log(`[Intraday] ROD 取消未成交：${cancelled}`)
        void sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
          `⏰ **收盤前取消未成交掛單**\n${pendingBuys.map(b => `• ${b.symbol} ${b.name}（限價 $${b.ml_entry_price}）`).join('\n')}`)
        await env.KV.put(`paper:pending_buys:${today}`, '[]', { expirationTtl: 86400 })
      }
    }
    return
  }

  // ── C. 待買限價檢查 ────────────────────────────────────────────────────
  const pendingJson = await env.KV.get(`paper:pending_buys:${today}`)
  if (!pendingJson) return

  let pendingBuys: PendingBuy[] = JSON.parse(pendingJson)
  if (pendingBuys.length === 0) return

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
  const currentPositionCount = (positions ?? []).length

  // P1#12: maxPositions check — if at cap, evaluate replacement before proceeding
  const maxPos = cfg.position.maxPositions ?? 5
  let dailySwaps = 0
  const maxSwaps = cfg.position.maxDailySwaps ?? 1

  if (currentPositionCount >= maxPos && pendingBuys.length > 0) {
    console.log(`[Intraday] Position cap ${currentPositionCount}/${maxPos} reached, evaluating replacements...`)

    // Load full position data for weakness scoring
    const { results: fullPositions } = await env.DB.prepare(`
      SELECT symbol, shares, avg_cost, entry_date, entry_price,
             initial_stop, tp1_price, tp1_hit, highest_since_entry
      FROM paper_positions WHERE account_id=? AND shares>0
    `).bind(ACCOUNT_ID).all<any>()

    // Calculate weakness score for each position
    const weaknessScores: { symbol: string; score: number }[] = []
    for (const pos of (fullPositions ?? [])) {
      const px = posValueMap.get(pos.symbol) ?? pos.avg_cost
      const pnlPct = pos.avg_cost > 0 ? (px - pos.avg_cost) / pos.avg_cost : 0
      const daysHeld = pos.entry_date
        ? Math.floor((Date.now() + 8 * 3600_000 - new Date(pos.entry_date + 'T00:00:00+08:00').getTime()) / 86400_000)
        : 0
      const timeRatio = Math.min(1, daysHeld / (cfg.exit.timeStopDays ?? 20))

      // Weakness = weighted sum (higher = weaker)
      const pnlScore = Math.max(0, -pnlPct * 100)   // more loss = weaker (0-12 range for -12%)
      const timeScore = timeRatio * 100               // closer to time stop = weaker
      const score = pnlScore * 0.35 + timeScore * 0.25 + (1 - (pos.tp1_hit ? 0.5 : 0)) * 40 * 0.20 + (pnlPct < 0 ? 20 : 0) * 0.20
      weaknessScores.push({ symbol: pos.symbol, score })
    }
    weaknessScores.sort((a, b) => b.score - a.score) // weakest first

    // Try to replace weakest with each pending buy (max 1 swap/day)
    const swapThreshold = cfg.position.swapThreshold ?? 1.15
    const minHoldDays = cfg.position.swapMinHoldDays ?? 3

    for (const pending of [...pendingBuys]) {
      if (dailySwaps >= maxSwaps) break
      if (weaknessScores.length === 0) break

      const weakest = weaknessScores[0]
      const weakPos = (fullPositions ?? []).find((p: any) => p.symbol === weakest.symbol)
      if (!weakPos) continue

      const daysHeld = weakPos.entry_date
        ? Math.floor((Date.now() + 8 * 3600_000 - new Date(weakPos.entry_date).getTime()) / 86400_000)
        : 0
      if (daysHeld < minHoldDays) {
        console.log(`[Swap] ${weakest.symbol} held only ${daysHeld}d < ${minHoldDays}d, skip swap`)
        continue
      }

      // Check if new stock is meaningfully better
      // newScore = quality (higher = better), weakest.score = weakness (higher = weaker)
      // Swap if: new quality is high AND weakest is sufficiently weak
      const newQuality = (pending.confidence ?? 0.6) * 100
      const weaknessThreshold = 100 / swapThreshold  // e.g. 1.15 → ~87: weakness must exceed this
      if (weakest.score < weaknessThreshold || newQuality < 55) {
        console.log(`[Swap] ${weakest.symbol}(weakness=${weakest.score.toFixed(0)}) not weak enough (need>${weaknessThreshold.toFixed(0)}) or ${pending.symbol}(quality=${newQuality.toFixed(0)}) not strong enough, skip`)
        continue
      }

      // Near TP1 check: don't swap out if close to profit target
      const weakPx = posValueMap.get(weakest.symbol) ?? weakPos.avg_cost
      if (weakPos.tp1_price && weakPx >= weakPos.tp1_price * 0.97) {
        console.log(`[Swap] ${weakest.symbol} near TP1 (${weakPx}/${weakPos.tp1_price}), skip swap`)
        continue
      }

      // Execute swap: sell weakest position
      const sellPrice = weakPx
      if (!sellPrice || sellPrice <= 0) {
        console.warn(`[Swap] ${weakest.symbol} has no valid price (${sellPrice}), skip swap`)
        continue
      }
      console.log(`[Swap] Replacing ${weakest.symbol}(weakness=${weakest.score.toFixed(1)}) with ${pending.symbol}(quality=${newQuality.toFixed(1)})`)
      const sellValue = sellPrice * weakPos.shares
      const sellTax = sellValue * 0.003
      const sellComm = sellValue * 0.001425
      const sellProceeds = sellValue - sellTax - sellComm

      // VULN-28 fix: batch all swap DB operations for atomicity
      await env.DB.batch([
        env.DB.prepare('UPDATE paper_accounts SET cash = cash + ?, updated_at=datetime(\'now\') WHERE id=?')
          .bind(sellProceeds, ACCOUNT_ID),
        env.DB.prepare(`
          INSERT INTO paper_orders (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, note, created_at)
          VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, 'auto_swap', ?, datetime('now'))
        `).bind(
          ACCOUNT_ID, weakest.symbol, weakPos.name ?? weakest.symbol,
          weakPos.shares, sellPrice, sellComm, sellTax, -sellProceeds,
          `SWAP_OUT: weakness=${weakest.score.toFixed(1)}, replaced by ${pending.symbol}`,
        ),
        env.DB.prepare('DELETE FROM paper_positions WHERE account_id=? AND symbol=?')
          .bind(ACCOUNT_ID, weakest.symbol),
      ])
      acc.cash += sellProceeds

      weaknessScores.shift() // remove swapped position
      dailySwaps++
    }
  }

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

  // #4 Trading Rules: 即時讀取處置股/注意股/衰退風險 KV（screener 到成交間可能新增）
  const [punishedRaw, attentionRaw, delistingRaw] = await Promise.all([
    env.KV.get('market:punished_stocks'),
    env.KV.get('market:attention_stocks'),
    env.KV.get('market:delisting_risk'),
  ])

  // 漲跌停鎖死偵測：取前日收盤價，計算漲停/跌停價
  // Why: 漲停鎖死時買不到，跌停鎖死時賣不掉，paper trade 不應模擬成交
  const prevCloseMap = new Map<string, number>()
  if (pendingSymbols.length > 0) {
    const ph = pendingSymbols.map(() => '?').join(',')
    const { results: prevRows } = await env.DB.prepare(`
      SELECT s.symbol, sp.close FROM stock_prices sp
      JOIN stocks s ON s.id = sp.stock_id
      WHERE s.symbol IN (${ph})
        AND sp.date < ?
      ORDER BY sp.date DESC
    `).bind(...pendingSymbols, today).all<{ symbol: string; close: number }>()
    // 每支取最新一筆（已 ORDER BY date DESC）
    for (const r of (prevRows ?? [])) {
      if (!prevCloseMap.has(r.symbol)) prevCloseMap.set(r.symbol, r.close)
    }
  }
  const blockedSymbols = new Set<string>()
  if (punishedRaw) {
    try { for (const s of JSON.parse(punishedRaw)) blockedSymbols.add(typeof s === 'string' ? s : s.symbol ?? s.code) } catch {}
  }
  if (attentionRaw) {
    try { for (const s of JSON.parse(attentionRaw)) blockedSymbols.add(typeof s === 'string' ? s : s.symbol ?? s.code) } catch {}
  }
  if (delistingRaw) {
    try { for (const s of JSON.parse(delistingRaw)) blockedSymbols.add(typeof s === 'string' ? s : s.symbol ?? s.code) } catch {}
  }

  // ── Market Risk Gate（盤中即時大盤風險）──────────────────────────────────
  // 觸價前先檢查大盤環境，高風險時下修 entry_price 或放棄
  let marketRisk: { risk_level: string; change_rate?: number; risk_reasons?: string[] } = { risk_level: 'low' }
  if ((env as any).SHIOAJI_PROXY_URL) {
    try {
      const mrRes = await fetch(`${(env as any).SHIOAJI_PROXY_URL}/market-risk`, {
        headers: { 'Authorization': `Bearer ${(env as any).PROXY_SERVICE_TOKEN ?? ''}` },
        signal: AbortSignal.timeout(5000),
      })
      if (mrRes.ok) {
        marketRisk = await mrRes.json() as any
        if (marketRisk.risk_level !== 'low') {
          console.log(`[RiskGate] 大盤風險: ${marketRisk.risk_level} (${marketRisk.change_rate ?? 0}%) — ${(marketRisk.risk_reasons ?? []).join(', ')}`)
        }
      }
    } catch (e) {
      console.warn('[RiskGate] market-risk fetch failed (fallback to low):', e)
    }
  }

  let filled = false
  for (const pending of [...pendingBuys]) {
    const price = priceMap.get(pending.symbol)
    if (!price) continue

    // Trading Rules: 處置股/注意股即時排除
    if (blockedSymbols.has(pending.symbol)) {
      console.warn(`[Intraday] ⛔ ${pending.symbol} 為處置/注意股，取消掛單`)
      pendingBuys = pendingBuys.filter(b => b.symbol !== pending.symbol)
      filled = true  // trigger KV write
      continue
    }

    // ── Pre-Order Reviewer: 大盤高風險時下修 entry 或放棄 ──
    if (marketRisk.risk_level === 'high' && price <= pending.ml_entry_price) {
      const retryCount = (pending as any).retry_count ?? 0
      const originalEntry = (pending as any).original_entry ?? pending.ml_entry_price

      if (retryCount >= 3) {
        // 重試 3 次上限 → 本日放棄
        console.log(`[RiskGate] 🚫 ${pending.symbol} 重試 ${retryCount}/3 上限，本日放棄`)
        void sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
          `🚫 **Risk Gate 放棄** ${pending.symbol} ${pending.name}：大盤高風險重試 ${retryCount} 次已達上限`)
        pendingBuys = pendingBuys.filter(b => b.symbol !== pending.symbol)
        filled = true
        continue
      }

      const deviationPct = Math.abs(pending.ml_entry_price - originalEntry) / originalEntry
      if (deviationPct > 0.05) {
        // 偏離原始 ML 價 > 5% → 放棄
        console.log(`[RiskGate] 🚫 ${pending.symbol} 偏離 ${(deviationPct * 100).toFixed(1)}% > 5%，本日放棄`)
        void sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
          `🚫 **Risk Gate 放棄** ${pending.symbol} ${pending.name}：entry 已偏離原始 ML 價 ${(deviationPct * 100).toFixed(1)}%`)
        pendingBuys = pendingBuys.filter(b => b.symbol !== pending.symbol)
        filled = true
        continue
      }

      // 下修 entry_price 1.5%
      const newEntry = Math.round(pending.ml_entry_price * 0.985 * 100) / 100
      console.log(`[RiskGate] ⚠️ ${pending.symbol} 大盤高風險 → entry ${pending.ml_entry_price} → ${newEntry}（重試 ${retryCount + 1}/3）`)
      void sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
        `⚠️ **Risk Gate** ${pending.symbol} ${pending.name}：大盤 ${marketRisk.change_rate ?? 0}%，entry 下修 $${pending.ml_entry_price} → $${newEntry}（重試 ${retryCount + 1}/3）`)

      // 更新 pending_buy
      const idx = pendingBuys.findIndex(b => b.symbol === pending.symbol)
      if (idx >= 0) {
        (pendingBuys[idx] as any).original_entry = originalEntry
        ;(pendingBuys[idx] as any).retry_count = retryCount + 1
        pendingBuys[idx].ml_entry_price = newEntry
        pendingBuys[idx].ml_stop_loss = Math.round((pending.ml_stop_loss ?? newEntry * 0.92) * 0.985 * 100) / 100
      }
      filled = true
      continue  // 本輪不買，等下次 cron 用新 entry 重新判斷
    }

    // 限價檢查：即時價 ≤ ML entry_price 才成交
    if (price > pending.ml_entry_price) continue

    // 漲停鎖死檢查：價格接近漲停（≥+9.5%）時，真實市場買不到
    // Why: 一字漲停委買爆量但無成交，paper trade 不應模擬成交
    const prevClose = prevCloseMap.get(pending.symbol)
    if (prevClose && prevClose > 0) {
      const changePct = (price - prevClose) / prevClose
      if (changePct >= 0.095) {
        console.log(`[Intraday] ⛔ ${pending.symbol} 疑似漲停鎖死（${(changePct * 100).toFixed(1)}%），不模擬成交`)
        continue
      }
    }

    // P1#12: Position count check (including any swaps done above)
    const currentCount = await env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM paper_positions WHERE account_id=? AND shares>0'
    ).bind(ACCOUNT_ID).first<any>()
    if ((currentCount?.cnt ?? 0) >= maxPos) {
      console.log(`[Intraday] ${pending.symbol}: position cap (${maxPos}) reached, skip`)
      continue
    }

    // 額度檢查
    if (dailyBuyTotal >= DAILY_BUY_LIMIT) break
    if (acc.cash < cfg.position.minCashToTrade) break

    // 族群檢查
    const recSector = (await env.DB.prepare('SELECT sector FROM stocks WHERE symbol=?').bind(pending.symbol).first<any>())?.sector ?? '未分類'
    if ((sectorCountMap.get(recSector) ?? 0) >= 2) {
      console.log(`[Intraday] ${pending.symbol} 同族群已滿，跳過`)
      continue
    }

    // Position sizing（medium risk → 倉位減半）
    const riskPctAdj = marketRisk.risk_level === 'medium' ? pending.risk_pct * 0.5 : pending.risk_pct
    const atr14 = atrMap.get(pending.symbol) ?? price * cfg.exit.fallbackAtrPct
    const stopPct = Math.max(cfg.position.minStopPct, (atr14 * 2) / price)
    const riskBudget = totalPortfolio * riskPctAdj / stopPct
    const dailyRemaining = DAILY_BUY_LIMIT - dailyBuyTotal
    const budget = Math.min(riskBudget, totalPortfolio * cfg.position.maxPctOfPortfolio, acc.cash * cfg.position.maxPctOfCash, dailyRemaining)

    // 滑價模擬：買到偏貴 +1 tick（更真實的 paper trade）
    const fillPrice = applySlippage(price, 'buy', 1)

    const fullLots = Math.floor(budget / (fillPrice * 1000))
    let shares: number, isOddLot = false
    if (fullLots >= 1) { shares = fullLots * 1000 }
    else { shares = Math.floor(budget / fillPrice); isOddLot = true; if (shares < 1) { console.log(`[Intraday] ${pending.symbol}: shares<1, skip`); continue } }

    const txValue = fillPrice * shares
    // P1#12: minPositionValue guard
    const minPosVal = cfg.position.minPositionValue ?? 30_000
    if (txValue < minPosVal) { console.log(`[Intraday] ${pending.symbol}: txValue ${txValue} < min ${minPosVal}, skip`); continue }
    const commission = calcCommission(txValue, cfg)
    const totalCost = txValue + commission
    if (totalCost > acc.cash || dailyBuyTotal + totalCost > DAILY_BUY_LIMIT) continue

    // 出場參數（基於 fillPrice — 含滑價）
    const volPct = atr14 / fillPrice
    const slMult = volPct < 0.015 ? 1.5 : volPct < 0.03 ? 2.0 : 2.5
    const initialStop = fillPrice - atr14 * slMult
    const tp1Price = fillPrice + atr14 * 1.5
    const tp2Price = fillPrice + atr14 * 3.0

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
              fillPrice, today, initialStop, initialStop, fillPrice, slMult, tp1Price, tp2Price, shares),
      env.DB.prepare(`
        INSERT INTO paper_orders
          (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
        VALUES (?, ?, ?, 'buy', ?, ?, ?, 0, ?, 'auto_ml', ?, ?, ?)
      `).bind(ACCOUNT_ID, pending.symbol, pending.name, shares, fillPrice, commission, totalCost, pending.signal, pending.confidence,
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
                slippage_ticks: 1,
                market_price: price,
              })),
    ])

    ;(acc as any).cash -= totalCost
    dailyBuyTotal += totalCost
    sectorCountMap.set(recSector, (sectorCountMap.get(recSector) ?? 0) + 1)

    const lotTag = isOddLot ? ' [零股]' : ''
    console.log(`[Intraday] ✅ 成交 ${pending.symbol} ${shares}股${lotTag} @ ${fillPrice}（市價${price} +滑價）`)
    void sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
      `✅ **限價成交** ${pending.symbol} ${pending.name}\n` +
      `• ${shares}股${lotTag} @ $${fillPrice}（市價$${price} +1tick滑價）\n` +
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
// ─── 13:25 強制平倉：同日進場 + 當沖標的 + 已觸發動態停利/止損 ──────────────

async function forceDayTradeClose(env: Bindings, cfg: TradingConfig, today: string): Promise<void> {
  const { results: sameDayPos } = await env.DB.prepare(
    'SELECT * FROM paper_positions WHERE account_id=? AND shares>0 AND entry_date=?'
  ).bind(ACCOUNT_ID, today).all<any>()
  if (!sameDayPos?.length) return

  const symbols = sameDayPos.map((p: any) => p.symbol)
  const priceMap = await batchGetIntradayPrices(symbols, { SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL })
  const atrMap = await batchGetATR(env.DB, symbols)

  for (const pos of sameDayPos) {
    const price = priceMap.get(pos.symbol)
    if (!price) continue
    const atr = atrMap.get(pos.symbol) ?? price * cfg.exit.fallbackAtrPct

    // P1#13: Limit-down lock detection — can't exit if stock is locked
    // Only check if we have a meaningful intraday volume (skip if unknown)
    const prevCloseRow = await env.DB.prepare(
      'SELECT close, volume FROM stock_prices WHERE stock_id=(SELECT id FROM stocks WHERE symbol=?) ORDER BY date DESC LIMIT 1'
    ).bind(pos.symbol).first<any>()
    if (prevCloseRow && prevCloseRow.close > 0) {
      const dropPct = (price - prevCloseRow.close) / prevCloseRow.close
      // Only block if we can confirm limit-down (price drop >= 9.5%)
      // Volume check skipped here since we don't have intraday volume
      if (dropPct <= -0.095) {
        console.log(`[Exit] ${pos.symbol} at limit-down (${(dropPct*100).toFixed(1)}%), sell may not execute`)
      }
    }

    const decision = checkExitConditions(pos, price, atr, false, false, cfg)
    if (decision.action === 'hold') continue

    const dtCheck = await isDayTradeAllowed(pos.symbol, pos.shares, decision.reason, env.KV)
    if (!dtCheck.allowed) continue

    // 強制平倉（當沖稅率 0.15%）
    const shares = pos.shares
    const txValue = price * shares
    const commission = calcCommission(txValue, cfg)
    const tax = calcTax(txValue, cfg, true)
    const proceeds = txValue - commission - tax

    await env.DB.batch([
      env.DB.prepare("UPDATE paper_accounts SET cash=cash+?, updated_at=datetime('now') WHERE id=?").bind(proceeds, ACCOUNT_ID),
      env.DB.prepare('DELETE FROM paper_positions WHERE account_id=? AND symbol=?').bind(ACCOUNT_ID, pos.symbol),
      env.DB.prepare(`
        INSERT INTO paper_orders
          (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
        VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, 'daytrade_force_close', 'EXIT', ?, ?)
      `).bind(ACCOUNT_ID, pos.symbol, pos.name, shares, price, commission, tax, proceeds,
              null, JSON.stringify({ reason: `[13:25 當沖強制平倉] ${decision.reason}`, entry_price: pos.entry_price ?? pos.avg_cost, entry_date: pos.entry_date })),
    ])
    const pnl = (price - (pos.entry_price ?? pos.avg_cost)) / (pos.entry_price ?? pos.avg_cost)
    console.log(`[DayTrade] 13:25 強制平倉 ${pos.symbol} ${shares}股 @ ${price}（${(pnl * 100).toFixed(1)}%）`)
    void sendDiscordNotification((env as any).DISCORD_WEBHOOK_URL,
      formatTradeNotification('sell', pos.symbol, pos.name, shares, price,
        `⚡13:25 當沖強制平倉 — ${decision.reason}`, pnl))
  }
}

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

  // 當沖判斷：同日進場部位需確認是否為當沖標的 + 是否觸發動態停利/止損
  const eodToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  for (const pos of exitPositions) {
    const currentPrice = exitPriceMap.get(pos.symbol)
    if (!currentPrice) continue

    const atr14 = exitAtrMap.get(pos.symbol) ?? currentPrice * cfg.exit.fallbackAtrPct
    const decision = checkExitConditions(pos, currentPrice, atr14, sellRecMap.has(pos.symbol), true, cfg)

    // 當沖判斷：同日進場 → 查當沖標的 + 動態觸發條件
    let dayTradeSell = false
    if (pos.entry_date === eodToday && decision.action !== 'hold') {
      const dtCheck = await isDayTradeAllowed(pos.symbol, pos.shares, decision.reason, env.KV)
      if (!dtCheck.allowed) {
        console.log(`[EODExit] 當沖防護：${pos.symbol} ${dtCheck.reason}，留到明天`)
        continue
      }
      console.log(`[EODExit] 當沖出場 ${pos.symbol}（${dtCheck.reason}）— 稅率 0.15%`)
      dayTradeSell = true
    }

    if (decision.action === 'full_sell') {
      const shares = pos.shares
      const txValue = currentPrice * shares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
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
      const tax = calcTax(txValue, cfg, dayTradeSell)
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

  // benchmark: 0050 當日收盤 + TWII 大盤收盤
  const [benchRow, twiiRow] = await Promise.all([
    env.DB.prepare(`
      SELECT sp.close FROM stock_prices sp JOIN stocks s ON s.id = sp.stock_id
      WHERE s.symbol = '0050' AND sp.date <= ? AND sp.close IS NOT NULL ORDER BY sp.date DESC LIMIT 1
    `).bind(today).first<any>(),
    env.DB.prepare(`SELECT twii_close FROM market_risk WHERE date <= ? ORDER BY date DESC LIMIT 1`).bind(today).first<any>(),
  ])
  const benchmarkValue: number | null = benchRow?.close ?? null
  const twiiValue: number | null = twiiRow?.twii_close ?? null

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

  // ── Sharpe / Sortino 30d + CAGR + Calmar ───────────────────────────────────
  let sharpe30d: number | null = null
  let sortino30d: number | null = null
  let cagr: number | null = null
  let calmar: number | null = null

  const { results: recent30 } = await env.DB.prepare(
    'SELECT total_value FROM paper_daily_snapshots WHERE account_id=? ORDER BY date DESC LIMIT 31'
  ).bind(ACCOUNT_ID).all<any>()
  if (recent30 && recent30.length >= 10) {
    const vals = recent30.map((s: any) => s.total_value as number).reverse()
    const returns: number[] = []
    for (let i = 1; i < vals.length; i++) { if (vals[i-1] > 0) returns.push((vals[i] - vals[i-1]) / vals[i-1]) }
    if (returns.length >= 5) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length
      const n = returns.length
      const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))  // sample stddev (N-1)
      sharpe30d = std > 0 ? (mean / std) * Math.sqrt(252) : null

      // P0#7 Sortino: downside deviation (square negative returns, divide by total N)
      const downStd = Math.sqrt(returns.reduce((a, r) => a + (r < 0 ? r ** 2 : 0), 0) / n)
      sortino30d = downStd > 0 ? (mean / downStd) * Math.sqrt(252) : null
    }
  }

  // P0#7 CAGR: annualized compound return from inception
  const firstSnapshot = await env.DB.prepare(
    'SELECT date FROM paper_daily_snapshots WHERE account_id=? ORDER BY date ASC LIMIT 1'
  ).bind(ACCOUNT_ID).first<any>()
  if (firstSnapshot?.date && updatedAcc.initial_cash > 0 && tv > 0) {
    const d0 = new Date(firstSnapshot.date)
    const d1 = new Date(today)
    const years = Math.max((d1.getTime() - d0.getTime()) / (365.25 * 86400_000), 0.01)
    cagr = Math.pow(tv / updatedAcc.initial_cash, 1 / years) - 1
  }

  // P0#7 Calmar: CAGR / MDD
  if (cagr != null && maxDrawdownToDate != null && maxDrawdownToDate > 0) {
    calmar = cagr / maxDrawdownToDate
  }

  await env.DB.prepare(`
    INSERT INTO paper_daily_snapshots
      (account_id, date, cash, positions_value, total_value, pnl, pnl_pct,
       benchmark_value, twii_value, max_drawdown_to_date, sharpe_30d,
       sortino_30d, calmar, cagr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, date) DO UPDATE SET
      cash=excluded.cash, positions_value=excluded.positions_value,
      total_value=excluded.total_value, pnl=excluded.pnl, pnl_pct=excluded.pnl_pct,
      benchmark_value=excluded.benchmark_value, twii_value=excluded.twii_value,
      max_drawdown_to_date=excluded.max_drawdown_to_date,
      sharpe_30d=excluded.sharpe_30d,
      sortino_30d=excluded.sortino_30d, calmar=excluded.calmar, cagr=excluded.cagr
  `).bind(ACCOUNT_ID, today, updatedAcc.cash, finalPosValue, tv, pnl, pnlP,
           benchmarkValue, twiiValue, maxDrawdownToDate, sharpe30d,
           sortino30d, calmar, cagr).run()

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

  // 跌停鎖死偵測：取前日收盤價
  // Why: 跌停鎖死時賣不掉，停損單不應模擬成交，虧損繼續累積到隔天
  const intradayToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const prevCloseMapSell = new Map<string, number>()
  if (symbols.length > 0) {
    const ph = symbols.map(() => '?').join(',')
    const { results: prevRows } = await env.DB.prepare(`
      SELECT s.symbol, sp.close FROM stock_prices sp
      JOIN stocks s ON s.id = sp.stock_id
      WHERE s.symbol IN (${ph}) AND sp.date < ?
      ORDER BY sp.date DESC
    `).bind(...symbols, intradayToday).all<{ symbol: string; close: number }>()
    for (const r of (prevRows ?? [])) {
      if (!prevCloseMapSell.has(r.symbol)) prevCloseMapSell.set(r.symbol, r.close)
    }
  }

  for (const pos of positions) {
    const currentPrice = priceMap.get(pos.symbol)
    if (!currentPrice) continue

    const atr14 = atrMap.get(pos.symbol) ?? currentPrice * cfg.exit.fallbackAtrPct
    const decision = checkExitConditions(pos, currentPrice, atr14, false, false, cfg)  // isEOD=false, no ML signal

    // 跌停鎖死檢查：價格接近跌停（≤-9.5%）時，真實市場賣不掉
    // 停損單不成交，虧損繼續累積（更真實的 paper trade）
    if (decision.action !== 'hold') {
      const prevC = prevCloseMapSell.get(pos.symbol)
      if (prevC && prevC > 0) {
        const changePct = (currentPrice - prevC) / prevC
        if (changePct <= -0.095) {
          console.warn(`[Intraday] ⛔ ${pos.symbol} 疑似跌停鎖死（${(changePct * 100).toFixed(1)}%），停損單無法成交`)
          continue
        }
      }
    }

    // 當沖判斷：同日進場 → 查當沖標的 + 動態觸發條件
    let dayTradeSell = false
    if (pos.entry_date === intradayToday && decision.action !== 'hold') {
      const dtCheck = await isDayTradeAllowed(pos.symbol, pos.shares, decision.reason, env.KV)
      if (!dtCheck.allowed) {
        if (new Date().getUTCMinutes() % 10 === 0)
          console.log(`[Intraday] 當沖防護：${pos.symbol} ${dtCheck.reason}`)
        continue
      }
      dayTradeSell = true
    }

    if (decision.action === 'full_sell') {
      const shares = pos.shares
      const sellFillPrice = applySlippage(currentPrice, 'sell', 1)  // 賣到偏便宜 -1 tick
      const txValue = sellFillPrice * shares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
      const proceeds = txValue - commission - tax

      await env.DB.batch([
        env.DB.prepare("UPDATE paper_accounts SET cash=cash+?, updated_at=datetime('now') WHERE id=?").bind(proceeds, ACCOUNT_ID),
        env.DB.prepare('DELETE FROM paper_positions WHERE account_id=? AND symbol=?').bind(ACCOUNT_ID, pos.symbol),
        env.DB.prepare(`
          INSERT INTO paper_orders
            (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
          VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, 'intraday_exit', 'EXIT', ?, ?)
        `).bind(ACCOUNT_ID, pos.symbol, pos.name, shares, sellFillPrice, commission, tax, proceeds,
                null, JSON.stringify({ reason: `[盤中] ${decision.reason} (市價${currentPrice} -1tick滑價)`, entry_price: pos.entry_price ?? pos.avg_cost, entry_date: pos.entry_date })),
      ])
      console.warn(`[Intraday] 出場 ${pos.symbol} ${shares}股 @ ${sellFillPrice}（市價${currentPrice}） — ${decision.reason}`)
      const intradayPnl = (sellFillPrice - (pos.entry_price ?? pos.avg_cost)) / (pos.entry_price ?? pos.avg_cost)
      void sendDiscordNotification(env.DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, shares, currentPrice,
          `⚡盤中 ${decision.reason}`, intradayPnl))

    } else if (decision.action === 'partial_sell' && decision.sellShares) {
      const sellShares = decision.sellShares
      const txValue = currentPrice * sellShares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
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
                null, JSON.stringify({ reason: `[盤中] ${decision.reason}`, entry_price: pos.entry_price ?? pos.avg_cost, entry_date: pos.entry_date })),
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
