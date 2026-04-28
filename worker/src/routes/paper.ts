/**
 * paper.ts — Paper Trading API
 *
 * Default paper account:
 * - account_id = 1
 * - initial cash = NT$1,000,000
 * - fees include 0.1425% commission and 0.3% tax on sell orders
 *
 * Auth:
 * - Bearer <STOCKVISION_AUTH_TOKEN>: AI Team / cron / internal automation
 * - Bearer <JWT>: approved end-user session
 */

import { Hono, type Context } from 'hono'
import { verifyJWT }  from '../lib/auth'
import { getTradingConfig } from '../lib/tradingConfig'
import {
  getLatestPrice,
  getStockName,
} from '../lib/paperMarketData'
import {
  calcCommission,
  calcTax,
} from '../lib/paperTradeMath'
import { buildSellOrderNote, estimateSellOrderRealizedPnl, parseSellOrderNote } from '../lib/paperOrderAccounting'
import { recordPaperExecutionEvent } from '../lib/paperExecutionEvents'
import type { RescoreSellParams } from '../lib/paperWorkerTasks'
import { loadPendingBuySnapshot } from '../lib/pendingBuyStore'
import { buildPendingBuyStateSummary } from '../lib/pendingBuyStateSummary'
import type { Bindings, Variables } from '../types'

const paper = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const ACCOUNT_ID = 1

// Market snapshot fetch: Shioaji proxy first, Yahoo fallback second.

// Auth middleware supporting both internal token and approved JWT sessions.

const paperAuth = async (
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: () => Promise<void>,
) => {
  const authHeader = c.req.header('Authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  if (!token) return c.json({ error: 'Unauthorized' }, 401)

// Option 1: AI Team / cron internal token.
  const serviceToken = (c.env as any).STOCKVISION_AUTH_TOKEN as string | undefined
  if (serviceToken && token === serviceToken) {
    await next(); return
  }

// Option 2: approved JWT session owned by the configured admin email.
  const payload = await verifyJWT(token, c.env.JWT_SECRET)
  if (payload) {
    // Paper Trading / Auto Trade owner check.
    const ownerEmail = (c.env as any).ADMIN_EMAIL as string | undefined
    if (ownerEmail && payload.email !== ownerEmail) {
      return c.json({ error: 'Paper Trading 僅限管理員帳號' }, 403)
    }
    await next(); return
  }

  return c.json({ error: 'Unauthorized' }, 401)
}

paper.use('*', paperAuth)

// GET /api/paper/account — account snapshot.

paper.get('/account', async (c) => {
  const acc = await c.env.DB.prepare(
    'SELECT * FROM paper_accounts WHERE id=?'
  ).bind(ACCOUNT_ID).first<any>()

if (!acc) return c.json({ error: '找不到 paper account，請先完成 migration' }, 404)
  return c.json({ status: 'success', account: acc })
})

// GET /api/paper/positions — open positions plus settlement summary.

paper.get('/positions', async (c) => {
  const acc = await c.env.DB.prepare(
    'SELECT cash, initial_cash FROM paper_accounts WHERE id=?'
  ).bind(ACCOUNT_ID).first<any>()
  if (!acc) return c.json({ error: '找不到 paper account' }, 404)

  const { results: positions } = await c.env.DB.prepare(
    'SELECT * FROM paper_positions WHERE account_id=? AND shares>0 ORDER BY symbol'
  ).bind(ACCOUNT_ID).all<any>()

// Intraday pricing ladder during TW market hours (09:00-13:30).
  const twHour = (new Date().getUTCHours() + 8) % 24
  const twMin  = new Date().getUTCMinutes()
  const isMarketOpen = twHour >= 9 && (twHour < 13 || (twHour === 13 && twMin <= 30))

// Tier 1: KV intraday snapshots populated by `pollIntradayStopLoss`.
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

// Tier 2: DB end-of-day OHLCV fallback by symbol.
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
// Refresh stop-loss / take-profit state when a fresher price arrives.
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

// GET /api/paper/pnl — PnL snapshots for the recent window.

paper.get('/pnl', async (c) => {
  const acc = await c.env.DB.prepare(
    'SELECT cash, initial_cash FROM paper_accounts WHERE id=?'
  ).bind(ACCOUNT_ID).first<any>()
  if (!acc) return c.json({ error: '找不到 paper account' }, 404)

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

// GET /api/paper/orders — recent order history, default limit 50.

paper.get('/orders', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50'), 200)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM paper_orders WHERE account_id=? ORDER BY created_at DESC LIMIT ?'
  ).bind(ACCOUNT_ID, limit).all<any>()

  return c.json({ status: 'success', orders: results ?? [] })
})

// GET /api/paper/realized — server-side realized PnL summary.

paper.get('/realized', async (c) => {
  const { results: sells } = await c.env.DB.prepare(
    'SELECT symbol, price, shares, commission, tax, note, created_at FROM paper_orders WHERE account_id=? AND side=? ORDER BY created_at ASC'
  ).bind(ACCOUNT_ID, 'sell').all<any>()

  let totalPnl = 0
  for (const sell of (sells ?? [])) {
    totalPnl += estimateSellOrderRealizedPnl(sell) ?? 0
  }

  return c.json({ status: 'success', totalRealizedPnl: totalPnl, tradeCount: (sells ?? []).length })
})

// GET /api/paper/journal — server-side trade journal with FIFO matching.

paper.get('/journal', async (c) => {
  const { results: allOrders } = await c.env.DB.prepare(
    'SELECT symbol, side, price, shares, commission, tax, note, created_at FROM paper_orders WHERE account_id=? ORDER BY created_at ASC'
  ).bind(ACCOUNT_ID).all<any>()

  if (!allOrders?.length) return c.json({ status: 'success', metrics: null })

  // FIFO matching: per-symbol buy queue
  const buyQueues = new Map<string, { price: number; shares: number; date: string }[]>()
  const trades: { symbol: string; pnl: number; holdDays: number }[] = []

  for (const order of allOrders) {
    if (order.side === 'buy') {
      const q = buyQueues.get(order.symbol) ?? []
      q.push({ price: order.price, shares: order.shares ?? 0, date: order.created_at })
      buyQueues.set(order.symbol, q)
    } else if (order.side === 'sell') {
      let remainShares = order.shares ?? 0
      const q = buyQueues.get(order.symbol) ?? []
      const note = parseSellOrderNote(order.note)
      const realizedPnl = estimateSellOrderRealizedPnl(order)

      if (realizedPnl != null) {
        let holdDays = Number(note.days_held ?? 0)
        while (remainShares > 0 && q.length > 0) {
          const buy = q[0]
          const matched = Math.min(remainShares, buy.shares)
          if (!Number.isFinite(holdDays) || holdDays <= 0) {
            holdDays = Math.max(1, Math.round(
              (new Date(order.created_at).getTime() - new Date(buy.date).getTime()) / 86400000
            ))
          }
          buy.shares -= matched
          remainShares -= matched
          if (buy.shares <= 0) q.shift()
        }
        trades.push({ symbol: order.symbol, pnl: realizedPnl, holdDays: Number.isFinite(holdDays) ? holdDays : 0 })
        continue
      }

      // Try entry_price from note first
      let noteEntry: number | null = null
      if (Number.isFinite(Number(note.entry_price))) noteEntry = Number(note.entry_price)

      while (remainShares > 0 && q.length > 0) {
        const buy = q[0]
        const matched = Math.min(remainShares, buy.shares)
        const entryPrice = noteEntry ?? buy.price
        const pnl = (order.price - entryPrice) * matched
        const holdDays = Math.max(1, Math.round(
          (new Date(order.created_at).getTime() - new Date(buy.date).getTime()) / 86400000
        ))
        trades.push({ symbol: order.symbol, pnl, holdDays })

        buy.shares -= matched
        remainShares -= matched
        if (buy.shares <= 0) q.shift()
      }

      // If no matching buys found, use note entry_price or sell price
      if (remainShares > 0) {
        const entryPrice = noteEntry ?? order.price
        const pnl = (order.price - entryPrice) * remainShares
        trades.push({ symbol: order.symbol, pnl, holdDays: 0 })
      }
    }
  }

  if (!trades.length) return c.json({ status: 'success', metrics: null })

  const wins = trades.filter(t => t.pnl > 0)
  const losses = trades.filter(t => t.pnl <= 0)
  const winRate = trades.length > 0 ? wins.length / trades.length : 0
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0
  const totalWins = wins.reduce((s, t) => s + t.pnl, 0)
  const totalLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0
  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss)
  const validHolds = trades.filter(t => t.holdDays > 0)
  const avgHoldDays = validHolds.length > 0
    ? Math.round(validHolds.reduce((s, t) => s + t.holdDays, 0) / validHolds.length)
    : 0
  const best = trades.reduce((a, b) => a.pnl > b.pnl ? a : b)
  const worst = trades.reduce((a, b) => a.pnl < b.pnl ? a : b)

  return c.json({
    status: 'success',
    metrics: {
      totalTrades: trades.length,
      winRate,
      avgHoldDays,
      avgWin,
      avgLoss,
      profitFactor,
      expectancy,
      best: { symbol: best.symbol, pnl: best.pnl },
      worst: { symbol: worst.symbol, pnl: worst.pnl },
    }
  })
})

// GET /api/paper/quadrant-filter — T2 filter state for Bot Dashboard.

paper.get('/quadrant-filter', async (c) => {
  const date = c.req.query('date') ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const raw = await c.env.KV.get(`paper:quadrant_filter:${date}`, 'json')
  return c.json({ date, filters: raw ?? [] })
})

// GET /api/paper/pending-buys — current pending-buy snapshot for Bot Dashboard.
paper.get('/pending-buys', async (c) => {
  const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const snapshot = await loadPendingBuySnapshot(c.env, twToday, { allowFallbackRecent: true })
  const state = buildPendingBuyStateSummary(snapshot.pendingBuys, snapshot.meta)
  return c.json({
    requested_date: snapshot.requested_date,
    date: snapshot.date,
    is_stale: snapshot.is_stale,
    resolved_from: snapshot.resolved_from,
    source: snapshot.source,
    meta: snapshot.meta ?? null,
    state,
    pendingBuys: snapshot.pendingBuys,
  })
})

// GET /api/paper/execution-events — unified paper execution audit trail.

paper.get('/execution-events', async (c) => {
  const limit = Math.min(parseInt(c.req.query('limit') ?? '100'), 300)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM paper_execution_events WHERE account_id=? ORDER BY created_at DESC LIMIT ?',
  ).bind(ACCOUNT_ID, limit).all<any>().catch(() => ({ results: [] as any[] }))

  return c.json({ status: 'success', events: results ?? [] })
})

// POST /api/paper/buy — manual paper buy.

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
  if (!price) return c.json({ error: `找不到 ${symbol} 的可用價格，請稍後再試` }, 404)

  const name        = await getStockName(c.env.DB, symbol)
  const txValue     = price * sharesRaw
  const commission  = calcCommission(txValue, cfg)
  const totalCost   = txValue + commission   // Buy orders do not include sell-side tax.

  // T+2 cash rule: use settled cash minus pending buys plus same-day sell offsets.
  const acc = await c.env.DB.prepare('SELECT cash FROM paper_accounts WHERE id=?').bind(ACCOUNT_ID).first<any>()
  if (!acc) return c.json({ error: '找不到 paper account' }, 404)
  const { getAvailableCash, getSettlementDate } = await import('../lib/dateUtils')
  const availableCash = await getAvailableCash(c.env.DB, ACCOUNT_ID)
  if (availableCash < totalCost) {
    return c.json({
      error: `可用現金不足，需 NT$${Math.round(totalCost).toLocaleString()}，目前可用 NT$${Math.round(availableCash).toLocaleString()}，帳面現金 NT$${Math.round(acc.cash).toLocaleString()}`,
    }, 400)
  }

  const todayStr = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const settlementDate = await getSettlementDate(todayStr, c.env.KV)

  // Guardrail: enforce manual daily buy limit.
  const MANUAL_DAILY_LIMIT = cfg.position.manualDailyLimit
  const todayBoughtManual = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(total_cost), 0) as total FROM paper_orders WHERE account_id=? AND side='buy' AND created_at >= ?"
  ).bind(ACCOUNT_ID, todayStr).first<any>()
  if ((todayBoughtManual?.total ?? 0) + totalCost > MANUAL_DAILY_LIMIT) {
    return c.json({
      error: `超過手動買入日限額 NT$${MANUAL_DAILY_LIMIT.toLocaleString()}，今日已買入 NT$${Math.round(todayBoughtManual?.total ?? 0).toLocaleString()}`,
    }, 400)
  }

  // Position upsert bookkeeping.
  const existing = await c.env.DB.prepare(
    'SELECT shares, avg_cost FROM paper_positions WHERE account_id=? AND symbol=?'
  ).bind(ACCOUNT_ID, symbol).first<any>()

  const oldShares  = existing?.shares ?? 0
  const oldCost    = existing?.avg_cost ?? 0
  const newShares  = oldShares + sharesRaw
  // Weighted average cost including commission.
  const newAvgCost = (oldShares * oldCost + txValue + commission) / newShares

  // Record buy-side settlement so available cash follows T+2 rules.
  const orderInsert = c.env.DB.prepare(`
    INSERT INTO paper_orders
      (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
    VALUES (?, ?, ?, 'buy', ?, ?, ?, 0, ?, ?, ?, ?, ?)
  `).bind(ACCOUNT_ID, symbol, name, sharesRaw, price, commission, totalCost, source, signal ?? null, confidence ?? null, note ?? null)

  await c.env.DB.batch([
    // Upsert position immediately for T+0 paper state.
    c.env.DB.prepare(`
      INSERT INTO paper_positions (account_id, symbol, name, shares, avg_cost, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(account_id, symbol) DO UPDATE SET
        shares    = excluded.shares,
        avg_cost  = excluded.avg_cost,
        name      = excluded.name,
        updated_at = datetime('now')
    `).bind(ACCOUNT_ID, symbol, name, newShares, newAvgCost),

    // Insert order row.
    orderInsert,
  ])

  // Resolve inserted order id for settlement linkage.
  const lastOrder = await c.env.DB.prepare(
    "SELECT id FROM paper_orders WHERE account_id=? AND symbol=? AND side='buy' ORDER BY id DESC LIMIT 1"
  ).bind(ACCOUNT_ID, symbol).first<{ id: number }>()

  await c.env.DB.prepare(`
    INSERT INTO paper_settlements (account_id, order_id, symbol, side, amount, trade_date, settlement_date)
    VALUES (?, ?, ?, 'buy', ?, ?, ?)
  `).bind(ACCOUNT_ID, lastOrder?.id ?? 0, symbol, totalCost, todayStr, settlementDate).run()

  await recordPaperExecutionEvent(c.env, {
    tradeDate: todayStr,
    symbol,
    side: 'buy',
    eventType: 'paper_order',
    status: 'filled',
    reason: 'manual_buy',
    detail: { shares: sharesRaw, price, total_cost: totalCost },
    orderId: lastOrder?.id ?? null,
    source,
  })

  return c.json({
    status: 'success',
    action: 'buy',
    symbol, name, shares: sharesRaw,
    price:       Math.round(price * 100) / 100,
    commission,
    total_cost:  Math.round(totalCost),
    new_shares:  newShares,
    new_avg_cost: Math.round(newAvgCost * 100) / 100,
    message: `已買入 ${name}(${symbol}) ${sharesRaw} 股 @ NT$${price}，手續費 NT$${commission}，總成本 NT$${Math.round(totalCost).toLocaleString()}`,
  })
})

// POST /api/paper/sell — manual paper sell.

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

  // Check available position before selling.
  const pos = await c.env.DB.prepare(
    'SELECT * FROM paper_positions WHERE account_id=? AND symbol=?'
  ).bind(ACCOUNT_ID, symbol).first<any>()
  if (!pos || pos.shares < sharesRaw) {
    return c.json({
      error: `持股不足，目前 ${pos?.shares ?? 0} 股，欲賣出 ${sharesRaw} 股`,
    }, 400)
  }

  const price = priceOverride ?? await getLatestPrice(c.env.DB, symbol)
  if (!price) return c.json({ error: `找不到 ${symbol} 的價格` }, 404)

  const name       = pos.name || await getStockName(c.env.DB, symbol)
  const txValue    = price * sharesRaw
  const commission = calcCommission(txValue, cfg)
  const tax        = calcTax(txValue, cfg)
  const proceeds   = txValue - commission - tax  // Net proceeds after fees and tax.

  const newShares = pos.shares - sharesRaw

  // Realized PnL snapshot for response payloads and journaling.
  const costBasis      = pos.avg_cost * sharesRaw
  const realizedPnl    = proceeds - costBasis
  const realizedPnlPct = costBasis > 0 ? (realizedPnl / costBasis * 100) : 0

  // Record sell-side settlement so proceeds unlock on settlement date.
  const { getSettlementDate } = await import('../lib/dateUtils')
  const todayStr = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const settlementDate = await getSettlementDate(todayStr, c.env.KV)

  const sellNote = buildSellOrderNote(
    { memo: note ?? null, entry_date: pos.entry_date ?? null },
    { entryPrice: pos.avg_cost, exitPrice: price, shares: sharesRaw, commission, tax },
  )

  const sellOrderInsert = c.env.DB.prepare(`
    INSERT INTO paper_orders
      (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
    VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(ACCOUNT_ID, symbol, name, sharesRaw, price, commission, tax, proceeds, source, signal ?? null, confidence ?? null, sellNote)

  await c.env.DB.batch([
    // Update or delete position row depending on remaining shares.
    newShares > 0
      ? c.env.DB.prepare(
          "UPDATE paper_positions SET shares=?, updated_at=datetime('now') WHERE account_id=? AND symbol=?"
        ).bind(newShares, ACCOUNT_ID, symbol)
      : c.env.DB.prepare(
          'DELETE FROM paper_positions WHERE account_id=? AND symbol=?'
        ).bind(ACCOUNT_ID, symbol),

    // 建立賣出結算記錄。
    sellOrderInsert,
  ])

  // 用最新 sell order_id 寫入 settlement 紀錄。
  const lastSellOrder = await c.env.DB.prepare(
    "SELECT id FROM paper_orders WHERE account_id=? AND symbol=? AND side='sell' ORDER BY id DESC LIMIT 1"
  ).bind(ACCOUNT_ID, symbol).first<{ id: number }>()

  await c.env.DB.prepare(`
    INSERT INTO paper_settlements (account_id, order_id, symbol, side, amount, trade_date, settlement_date)
    VALUES (?, ?, ?, 'sell', ?, ?, ?)
  `).bind(ACCOUNT_ID, lastSellOrder?.id ?? 0, symbol, proceeds, todayStr, settlementDate).run()

  await recordPaperExecutionEvent(c.env, {
    tradeDate: todayStr,
    symbol,
    side: 'sell',
    eventType: 'paper_order',
    status: 'filled',
    reason: 'manual_sell',
    detail: { shares: sharesRaw, price, proceeds, realized_pnl: Math.round(realizedPnl) },
    orderId: lastSellOrder?.id ?? null,
    source,
  })

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
    message: `已賣出 ${name}(${symbol}) ${sharesRaw} 股 @ NT$${price}，已實現損益 NT$${Math.round(realizedPnl).toLocaleString()} (${Math.round(realizedPnlPct * 100) / 100}%)`,
  })
})

// POST /api/paper/snapshot — cron-facing snapshot writer.

paper.post('/snapshot', async (c) => {
  const acc = await c.env.DB.prepare(
    'SELECT cash, initial_cash FROM paper_accounts WHERE id=?'
  ).bind(ACCOUNT_ID).first<any>()
  if (!acc) return c.json({ error: '找不到 paper account' }, 404)

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

// POST /api/paper/reset — reset paper account, restricted to service token.

paper.post('/reset', async (c) => {
// Reset is intentionally blocked for JWT sessions.
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
