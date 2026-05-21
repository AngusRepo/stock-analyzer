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
import { getCurrentRegime as getCurrentSltpRegime, getTradingConfig, resolveSltpForRegime } from '../lib/tradingConfig'
import {
  batchGetATR,
  getLatestPrice,
  getStockName,
} from '../lib/paperMarketData'
import {
  calcCommission,
  calcTax,
} from '../lib/paperTradeMath'
import { batchGetIntradayOHLC } from '../lib/paperIntradayData'
import { buildSellOrderNote, estimateSellOrderRealizedPnl, parseSellOrderNote } from '../lib/paperOrderAccounting'
import { recordPaperExecutionEvent } from '../lib/paperExecutionEvents'
import { runDailySnapshot, type RescoreSellParams } from '../lib/paperWorkerTasks'
import { loadPendingBuyRunHistory, loadPendingBuySnapshot } from '../lib/pendingBuyStore'
import { buildPendingBuyStateSummary } from '../lib/pendingBuyStateSummary'
import { computePaperTotalValue, getUnsettledSettlementSummary } from '../lib/paperAccountValue'
import { isTwIntradayTradingMinute } from '../lib/twMarketSession'
import {
  appendUniqueWatchPoint,
  buildMarketStructureWatchPoint,
  buildMlVoteSummary,
  buildMlVoteWatchPoint,
  parsePredictionForecastData,
} from '../lib/recommendationContext'
import type { Bindings, Variables } from '../types'

const paper = new Hono<{ Bindings: Bindings; Variables: Variables }>()

const ACCOUNT_ID = 1
const PAPER_EXTRA_BENCHMARK_SYMBOLS = ['00981A', '00631L', '00403A'] as const

type BenchmarkPriceMap = Record<string, Record<string, number>>

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

async function loadPaperEtfBenchmarks(db: D1Database, dates: string[]): Promise<BenchmarkPriceMap> {
  const cleanDates = Array.from(new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))).sort()
  const out: BenchmarkPriceMap = {}
  if (!cleanDates.length) return out

  for (const dateChunk of chunkArray(cleanDates, 120)) {
    const dateValues = dateChunk.map(() => '(?)').join(',')
    const symbolValues = PAPER_EXTRA_BENCHMARK_SYMBOLS.map(() => '?').join(',')
    const rows = await db.prepare(`
      WITH target_dates(date) AS (VALUES ${dateValues})
      SELECT d.date AS snapshot_date,
             s.symbol,
             sp.close
        FROM target_dates d
        JOIN stocks s
          ON s.symbol IN (${symbolValues})
        LEFT JOIN stock_prices sp
          ON sp.stock_id = s.id
         AND sp.date = (
           SELECT MAX(sp2.date)
             FROM stock_prices sp2
            WHERE sp2.stock_id = s.id
              AND sp2.date <= d.date
              AND sp2.close IS NOT NULL
         )
       WHERE sp.close IS NOT NULL
       ORDER BY d.date ASC, s.symbol ASC
    `).bind(...dateChunk, ...PAPER_EXTRA_BENCHMARK_SYMBOLS).all<{
      snapshot_date: string
      symbol: string
      close: number | null
    }>()

    for (const row of rows.results ?? []) {
      const close = Number(row.close)
      if (!Number.isFinite(close) || close <= 0) continue
      out[row.snapshot_date] = out[row.snapshot_date] ?? {}
      out[row.snapshot_date][row.symbol] = close
    }
  }

  return out
}

async function resolveManualExecutablePrice(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  symbol: string,
  priceOverride: number | null,
): Promise<{ price: number | null; source: string; error?: string }> {
  if (priceOverride != null && Number.isFinite(priceOverride) && priceOverride > 0) {
    return { price: priceOverride, source: 'manual_override' }
  }

  if (!isTwIntradayTradingMinute()) {
    return { price: null, source: 'none', error: 'manual order requires explicit price outside TW market hours' }
  }

  const quotes = await batchGetIntradayOHLC([symbol], {
    SHIOAJI_PROXY_URL: (c.env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (c.env as any).PROXY_SERVICE_TOKEN,
    requireBrokerQuote: true,
  })
  const quote = quotes.get(symbol)
  if (!quote || quote.source !== 'shioaji') {
    return { price: null, source: quote?.source ?? 'none', error: 'manual order requires broker intraday quote' }
  }
  return { price: quote.last, source: 'shioaji' }
}

async function enrichPendingBuyContext(
  db: D1Database,
  pendingBuys: any[],
  sourceRecoDate: string,
): Promise<any[]> {
  if (pendingBuys.length === 0) return pendingBuys
  const symbols = [...new Set(pendingBuys.map((item) => String(item.symbol ?? '').trim()).filter(Boolean))]
  if (symbols.length === 0) return pendingBuys

  const placeholders = symbols.map(() => '?').join(',')
  const { results } = await db.prepare(`
    SELECT dr.symbol,
           s.id AS stock_id,
           p.forecast_data AS prediction_forecast_data
      FROM daily_recommendations dr
      LEFT JOIN stocks s ON s.symbol = dr.symbol
      LEFT JOIN predictions p ON p.id = (
        SELECT p2.id
         FROM predictions p2
         WHERE p2.stock_id = s.id
           AND p2.model_name = 'ensemble'
           AND (
             p2.prediction_date = dr.date
           )
         ORDER BY
           p2.generated_at DESC,
           p2.id DESC
         LIMIT 1
      )
     WHERE dr.date = ?
       AND dr.symbol IN (${placeholders})
  `).bind(sourceRecoDate, ...symbols).all<any>().catch(() => ({ results: [] as any[] }))

  const stockIds = [...new Set((results ?? []).map((row: any) => Number(row.stock_id)).filter((id: number) => Number.isFinite(id)))]
  const perModelByStock = new Map<number, any[]>()
  if (stockIds.length > 0) {
    const stockPlaceholders = stockIds.map(() => '?').join(',')
    const { results: perModelRows } = await db.prepare(`
      WITH ranked AS (
        SELECT stock_id, model_name, signal_raw, direction_accuracy, forecast_data,
               ROW_NUMBER() OVER (
                 PARTITION BY stock_id, model_name
                 ORDER BY
                   generated_at DESC,
                   id DESC
               ) AS rn
          FROM predictions
         WHERE stock_id IN (${stockPlaceholders})
           AND model_name != 'ensemble'
           AND model_name NOT LIKE '%::challenger'
           AND prediction_date = ?
      )
      SELECT stock_id, model_name, signal_raw, direction_accuracy, forecast_data
        FROM ranked
       WHERE rn = 1
       ORDER BY stock_id, model_name
    `).bind(
      ...stockIds,
      sourceRecoDate,
    ).all<any>().catch(() => ({ results: [] as any[] }))
    for (const row of perModelRows ?? []) {
      const stockId = Number(row.stock_id)
      const list = perModelByStock.get(stockId) ?? []
      list.push(row)
      perModelByStock.set(stockId, list)
    }
  }

  const contextBySymbol = new Map<string, any>()
  for (const row of results ?? []) {
    const forecastData = parsePredictionForecastData(row.prediction_forecast_data)
    if (!forecastData) continue
    const mlVoteSummary = buildMlVoteSummary(forecastData, perModelByStock.get(Number(row.stock_id)) ?? [])
    contextBySymbol.set(row.symbol, {
      prediction_forecast_data: row.prediction_forecast_data,
      alpha_context: forecastData.alpha_context ?? null,
      alpha_allocation: forecastData.alpha_allocation ?? null,
      ml_vote_summary: mlVoteSummary,
      market_watch_point: buildMarketStructureWatchPoint(forecastData.alpha_context),
      ml_watch_point: buildMlVoteWatchPoint(mlVoteSummary),
    })
  }

  return pendingBuys.map((item) => {
    const context = contextBySymbol.get(item.symbol)
    if (!context) return item
    let watchPoints = Array.isArray(item.watch_points) ? item.watch_points : []
    watchPoints = appendUniqueWatchPoint(watchPoints, context.market_watch_point)
    watchPoints = appendUniqueWatchPoint(watchPoints, context.ml_watch_point)
    return {
      ...item,
      alpha_context: context.alpha_context,
      alpha_allocation: context.alpha_allocation,
      ml_vote_summary: context.ml_vote_summary,
      prediction_forecast_data: context.prediction_forecast_data,
      watch_points: watchPoints,
    }
  })
}

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
  const isMarketOpen = isTwIntradayTradingMinute()

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

  const settlement = await getUnsettledSettlementSummary(c.env.DB, ACCOUNT_ID)
  const totalValue    = computePaperTotalValue({
    settledCash: acc.cash,
    positionsValue: totalPositionValue,
    netUnsettledSettlement: settlement.netUnsettledSettlement,
  })
  const totalPnl      = totalValue - acc.initial_cash
  const totalPnlPct   = acc.initial_cash > 0 ? (totalPnl / acc.initial_cash * 100) : 0

  return c.json({
    status: 'success',
    positions: enriched,
    summary: {
      cash:             Math.round(acc.cash),
      positions_value:  Math.round(totalPositionValue),
      unsettled_buy_amount: Math.round(settlement.unsettledBuyAmount),
      unsettled_sell_amount: Math.round(settlement.unsettledSellAmount),
      net_unsettled_settlement: Math.round(settlement.netUnsettledSettlement),
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
  const snapshotRows = snapshots ?? []
  const etfBenchmarks = await loadPaperEtfBenchmarks(c.env.DB, snapshotRows.map((row) => String(row.date ?? '').slice(0, 10)))

  return c.json({
    status: 'success',
    initial_cash: acc.initial_cash,
    current_cash: Math.round(acc.cash),
    benchmark_symbols: PAPER_EXTRA_BENCHMARK_SYMBOLS,
    snapshots: snapshotRows.map((row) => ({
      ...row,
      etf_benchmarks: etfBenchmarks[String(row.date ?? '').slice(0, 10)] ?? {},
    })),
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
  const sourceRecoDate = typeof snapshot.meta?.source_reco_date === 'string'
    ? snapshot.meta.source_reco_date
    : snapshot.date
  const pendingBuys = await enrichPendingBuyContext(c.env.DB, snapshot.pendingBuys, sourceRecoDate)
  const runHistory = await loadPendingBuyRunHistory(c.env, twToday, { limit: 5 })
  return c.json({
    requested_date: snapshot.requested_date,
    date: snapshot.date,
    is_stale: snapshot.is_stale,
    resolved_from: snapshot.resolved_from,
    source: snapshot.source,
    meta: snapshot.meta ?? null,
    state,
    pendingBuys,
    runHistory,
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

// GET /api/paper/gate-calibration — recent execution gate distribution.

paper.get('/gate-calibration', async (c) => {
  const rawDays = Number.parseInt(c.req.query('days') ?? '7', 10)
  const days = Math.max(1, Math.min(Number.isFinite(rawDays) ? rawDays : 7, 60))
  const sinceModifier = `-${days} days`

  const { results } = await c.env.DB.prepare(`
    SELECT
      status,
      reason,
      source,
      COUNT(*) AS count,
      MAX(created_at) AS last_seen
    FROM paper_execution_events
    WHERE account_id=?
      AND created_at >= datetime('now', ?)
    GROUP BY status, reason, source
    ORDER BY count DESC, last_seen DESC
  `).bind(ACCOUNT_ID, sinceModifier).all<any>().catch(() => ({ results: [] as any[] }))

  const rows = (results ?? []).map((row: any) => ({
    status: row.status ?? 'unknown',
    reason: row.reason ?? 'unknown',
    source: row.source ?? null,
    count: Number(row.count ?? 0),
    last_seen: row.last_seen ?? null,
  }))
  const countByStatus = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + row.count
    return acc
  }, {})
  const totalEvents = rows.reduce((sum, row) => sum + row.count, 0)

  return c.json({
    status: 'success',
    days,
    total_events: totalEvents,
    filled_events: countByStatus.filled ?? 0,
    deferred_events: countByStatus.deferred ?? 0,
    skipped_events: countByStatus.skipped ?? 0,
    cancelled_events: countByStatus.cancelled ?? 0,
    rows,
  })
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

  const resolvedPrice = await resolveManualExecutablePrice(c, symbol, priceOverride)
  const price = resolvedPrice.price
  if (!price) return c.json({ error: resolvedPrice.error ?? `找不到 ${symbol} 的可用成交價格，請稍後再試` }, 404)

  const name        = await getStockName(c.env.DB, symbol)
  const todayStr = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const atr14 = (await batchGetATR(c.env.DB, [symbol])).get(symbol) ?? price * cfg.exit.fallbackAtrPct
  const regimeLabel = await getCurrentSltpRegime(c.env.KV)
  const sltp = resolveSltpForRegime(cfg, regimeLabel)
  const volPct = atr14 / price
  const volLow = sltp?.volThresholdLow ?? 0.015
  const volHigh = sltp?.volThresholdHigh ?? 0.03
  const slBase = sltp?.slMultBase ?? 2.0
  const tpBase = sltp?.tpMultBase ?? 1.5
  const slLow = sltp?.slMultLow ?? 0.75
  const slHigh = sltp?.slMultHigh ?? 1.25
  const tpLow = sltp?.tpMultLow ?? 0.67
  const tpHigh = sltp?.tpMultHigh ?? 1.33
  const tp2Mult = sltp?.tp2DistanceMultiplier ?? 2.0
  const slMult = volPct < volLow ? slBase * slLow : volPct < volHigh ? slBase : slBase * slHigh
  const tpMult = volPct < volLow ? tpBase * tpLow : volPct < volHigh ? tpBase : tpBase * tpHigh
  const initialStop = price - atr14 * slMult
  const tp1Price = price + atr14 * tpMult
  const tp2Price = price + atr14 * tpMult * tp2Mult
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
  `).bind(
    ACCOUNT_ID,
    symbol,
    name,
    sharesRaw,
    price,
    commission,
    totalCost,
    source,
    signal ?? null,
    confidence ?? null,
    note ? `${note} | price_source=${resolvedPrice.source}` : `price_source=${resolvedPrice.source}`,
  )

  await c.env.DB.batch([
    // Upsert position immediately for T+0 paper state.
    c.env.DB.prepare(`
      INSERT INTO paper_positions (account_id, symbol, name, shares, avg_cost, updated_at,
        entry_price, entry_date, initial_stop, trailing_stop, highest_since_entry,
        stop_multiplier, tp1_price, tp2_price, tp1_hit, original_shares)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(account_id, symbol) DO UPDATE SET
        shares    = excluded.shares,
        avg_cost  = excluded.avg_cost,
        name      = excluded.name,
        updated_at = datetime('now')
    `).bind(
      ACCOUNT_ID,
      symbol,
      name,
      newShares,
      newAvgCost,
      price,
      todayStr,
      initialStop,
      initialStop,
      price,
      slMult,
      tp1Price,
      tp2Price,
      sharesRaw,
    ),

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
    detail: { shares: sharesRaw, price, price_source: resolvedPrice.source, total_cost: totalCost },
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

  const resolvedPrice = await resolveManualExecutablePrice(c, symbol, priceOverride)
  const price = resolvedPrice.price
  if (!price) return c.json({ error: resolvedPrice.error ?? `找不到 ${symbol} 的可用成交價格` }, 404)

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
    {
      memo: note ? `${note} | price_source=${resolvedPrice.source}` : `price_source=${resolvedPrice.source}`,
      entry_date: pos.entry_date ?? null,
    },
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
    detail: { shares: sharesRaw, price, price_source: resolvedPrice.source, proceeds, realized_pnl: Math.round(realizedPnl) },
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
  const requestedDate = c.req.query('date') || undefined
  const result = await runDailySnapshot(c.env, { date: requestedDate })
  const today = result.date
  const snapshot = await c.env.DB.prepare(
    `SELECT date, total_value, pnl, pnl_pct, benchmark_value, twii_value,
            max_drawdown_to_date, sharpe_30d, sortino_30d, calmar, cagr
       FROM paper_daily_snapshots
      WHERE account_id=? AND date=?`,
  ).bind(ACCOUNT_ID, today).first<any>()

  return c.json({
    status: 'success',
    date: snapshot?.date ?? today,
    total_value: snapshot?.total_value != null ? Math.round(snapshot.total_value) : null,
    pnl: snapshot?.pnl != null ? Math.round(snapshot.pnl) : null,
    pnl_pct: snapshot?.pnl_pct != null ? Math.round(snapshot.pnl_pct * 100) / 100 : null,
    benchmark_value: snapshot?.benchmark_value ?? null,
    twii_value: snapshot?.twii_value ?? null,
    max_drawdown_to_date: snapshot?.max_drawdown_to_date ?? null,
    sharpe_30d: snapshot?.sharpe_30d ?? null,
    sortino_30d: snapshot?.sortino_30d ?? null,
    calmar: snapshot?.calmar ?? null,
    cagr: snapshot?.cagr ?? null,
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
