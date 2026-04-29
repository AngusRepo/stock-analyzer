import type { Bindings } from '../types'
import { formatDailySummary, sendDiscordNotification } from './notify'
import { batchGetLatestPrices, recordSellSettlement } from './paperMarketData'
import { batchGetIntradayPrices } from './paperIntradayData'
import { applySlippage, calcCommission, calcTax } from './paperTradeMath'
import { buildSellOrderNote } from './paperOrderAccounting'
import { recordPaperExecutionEvent } from './paperExecutionEvents'
import { reconcilePendingBuyDebates, setupMorningPendingBuys } from './pendingBuyOrchestrator'
import { computePaperTotalValue, getUnsettledSettlementSummary } from './paperAccountValue'

const ACCOUNT_ID = 1

export async function runDailySnapshot(env: Bindings): Promise<void> {
  console.log('[Snapshot] Starting...')
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  const updatedAcc = await env.DB.prepare('SELECT cash, initial_cash FROM paper_accounts WHERE id=?').bind(ACCOUNT_ID).first<any>()
  if (!updatedAcc) return

  const { results: finalPos } = await env.DB.prepare(
    'SELECT symbol, shares FROM paper_positions WHERE account_id=? AND shares>0',
  ).bind(ACCOUNT_ID).all<any>()

  const finalSymbols = (finalPos ?? []).map((p: any) => p.symbol)
  let finalPriceMap = await batchGetIntradayPrices(finalSymbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
  })
  if (finalPriceMap.size === 0) finalPriceMap = await batchGetLatestPrices(env.DB, finalSymbols)

  let finalPosValue = 0
  for (const p of (finalPos ?? [])) {
    const px = finalPriceMap.get(p.symbol)
    if (px) finalPosValue += px * p.shares
  }

  const settlement = await getUnsettledSettlementSummary(env.DB, ACCOUNT_ID)
  const totalValue = computePaperTotalValue({
    settledCash: updatedAcc.cash,
    positionsValue: finalPosValue,
    netUnsettledSettlement: settlement.netUnsettledSettlement,
  })
  const pnl = totalValue - updatedAcc.initial_cash
  const pnlPct = updatedAcc.initial_cash > 0 ? pnl / updatedAcc.initial_cash * 100 : 0

  const [benchRow, twiiRow] = await Promise.all([
    env.DB.prepare(`
      SELECT sp.close FROM stock_prices sp JOIN stocks s ON s.id = sp.stock_id
      WHERE s.symbol = '0050' AND sp.date <= ? AND sp.close IS NOT NULL ORDER BY sp.date DESC LIMIT 1
    `).bind(today).first<any>(),
    env.DB.prepare('SELECT twii_close FROM market_risk WHERE date <= ? ORDER BY date DESC LIMIT 1').bind(today).first<any>(),
  ])
  const benchmarkValue: number | null = benchRow?.close ?? null
  const twiiValue: number | null = twiiRow?.twii_close ?? null

  const { results: allSnapshots } = await env.DB.prepare(
    'SELECT total_value FROM paper_daily_snapshots WHERE account_id=? ORDER BY date ASC',
  ).bind(ACCOUNT_ID).all<any>()
  let maxDrawdownToDate: number | null = null
  if (allSnapshots && allSnapshots.length > 0) {
    let peak = updatedAcc.initial_cash
    let maxDd = 0
    for (const s of allSnapshots) {
      const value = s.total_value as number
      if (value > peak) peak = value
      const dd = peak > 0 ? (peak - value) / peak : 0
      if (dd > maxDd) maxDd = dd
    }
    maxDrawdownToDate = Math.max(maxDd, peak > 0 ? (peak - totalValue) / peak : 0)
  }

  let sharpe30d: number | null = null
  let sortino30d: number | null = null
  let cagr: number | null = null
  let calmar: number | null = null

  const { results: recent30 } = await env.DB.prepare(
    'SELECT total_value FROM paper_daily_snapshots WHERE account_id=? ORDER BY date DESC LIMIT 31',
  ).bind(ACCOUNT_ID).all<any>()
  if (recent30 && recent30.length >= 10) {
    const values = recent30.map((s: any) => s.total_value as number).reverse()
    const returns: number[] = []
    for (let i = 1; i < values.length; i += 1) {
      if (values[i - 1] > 0) returns.push((values[i] - values[i - 1]) / values[i - 1])
    }
    if (returns.length >= 5) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length
      const n = returns.length
      const std = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
      sharpe30d = std > 0 ? (mean / std) * Math.sqrt(252) : null

      const downStd = Math.sqrt(returns.reduce((a, r) => a + (r < 0 ? r ** 2 : 0), 0) / n)
      sortino30d = downStd > 0 ? (mean / downStd) * Math.sqrt(252) : null
    }
  }

  const firstSnapshot = await env.DB.prepare(
    'SELECT date FROM paper_daily_snapshots WHERE account_id=? ORDER BY date ASC LIMIT 1',
  ).bind(ACCOUNT_ID).first<any>()
  if (firstSnapshot?.date && updatedAcc.initial_cash > 0 && totalValue > 0) {
    const d0 = new Date(firstSnapshot.date)
    const d1 = new Date(today)
    const years = Math.max((d1.getTime() - d0.getTime()) / (365.25 * 86400_000), 0.01)
    cagr = Math.pow(totalValue / updatedAcc.initial_cash, 1 / years) - 1
  }
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
  `).bind(
    ACCOUNT_ID,
    today,
    updatedAcc.cash,
    finalPosValue,
    totalValue,
    pnl,
    pnlPct,
    benchmarkValue,
    twiiValue,
    maxDrawdownToDate,
    sharpe30d,
    sortino30d,
    calmar,
    cagr,
  ).run()

  const { auditPaperSnapshotConsistency } = await import('./paperSnapshotAudit')
  await auditPaperSnapshotConsistency(env, {
    date: today,
    cash: updatedAcc.cash,
    positionsValue: finalPosValue,
    totalValue,
  })

  console.log(`[Snapshot] total_value=NT$${Math.round(totalValue).toLocaleString()} pnl=${pnlPct.toFixed(2)}%`)

  const todayOrderCount = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM paper_orders WHERE account_id=? AND created_at >= ?",
  ).bind(ACCOUNT_ID, today).first<any>()
  void sendDiscordNotification(
    (env as any).DISCORD_WEBHOOK_URL,
    formatDailySummary(totalValue, pnlPct / 100, todayOrderCount?.cnt ?? 0, maxDrawdownToDate, sharpe30d),
  )
}

export async function runPaperAutoTrade(env: Bindings): Promise<void> {
  await setupMorningPendingBuys(env)
  await reconcilePendingBuyDebates(env)
}

export interface RescoreSellParams {
  symbol: string
  shares: number
  price: number
  reason: string
  source: string
}

export async function executeRescoreSell(env: Bindings, params: RescoreSellParams): Promise<void> {
  const { getTradingConfig } = await import('./tradingConfig')
  const cfg = await getTradingConfig(env.KV)
  const { symbol, shares, price, reason, source } = params

  const sellPrice = applySlippage(price, 'sell', 1)
  const txValue = sellPrice * shares
  const commission = calcCommission(txValue, cfg)
  const tax = calcTax(txValue, cfg, false)
  const proceeds = txValue - commission - tax

  const pos = await env.DB.prepare(
    'SELECT name, entry_price, entry_date, avg_cost FROM paper_positions WHERE account_id=? AND symbol=?',
  ).bind(ACCOUNT_ID, symbol).first<any>()

  const name = pos?.name ?? symbol
  const entryPrice = pos?.entry_price ?? pos?.avg_cost ?? price
  const daysHeld = pos?.entry_date ? Math.round((Date.now() - new Date(pos.entry_date).getTime()) / 86400000) : 0
  const sellNote = buildSellOrderNote(
    { reason, entry_date: pos?.entry_date, days_held: daysHeld },
    { entryPrice, exitPrice: sellPrice, shares, commission, tax },
  )

  await env.DB.batch([
    env.DB.prepare('DELETE FROM paper_positions WHERE account_id=? AND symbol=?').bind(ACCOUNT_ID, symbol),
    env.DB.prepare(`
      INSERT INTO paper_orders
        (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
      VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, ?, 'EXIT', NULL, ?)
    `).bind(
      ACCOUNT_ID,
      symbol,
      name,
      shares,
      sellPrice,
      commission,
      tax,
      proceeds,
      source,
      sellNote,
    ),
  ])
  const orderId = await recordSellSettlement(env.DB, env.KV, ACCOUNT_ID, symbol, proceeds)
  await recordPaperExecutionEvent(env, {
    symbol,
    side: 'sell',
    eventType: 'paper_order',
    status: 'filled',
    reason,
    detail: { shares, sell_price: sellPrice, proceeds, days_held: daysHeld },
    orderId,
    source,
  })

  console.log(`[Rescore-Sell] ${symbol} ${shares} 股 @ ${sellPrice} | entry=${entryPrice} | held=${daysHeld}d | ${reason}`)
}
