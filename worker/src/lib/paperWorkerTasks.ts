import { paperExecutionNow, paperAccountId, scopedPaperAccountId } from './paperExecutionScope'
import { executeContinuousPaperBatch, isPaperContinuousSession } from './paperContinuousExecution'
import type { Bindings } from '../types'
import { formatDailySummary, sendDiscordNotification } from './notify'
import { recordSellSettlement, getPrevTradingDay } from './paperMarketData'
import { batchGetClosingMarksByDomain, batchGetClosingPricesByDomain } from './paperMarketDomainData'
import { batchGetIntradayPrices, type IntradayOHLC } from './paperIntradayData'
import { refreshOpenPositionPostClosePriceCache } from './paperIntradayPriceCache'
import { sessionMarkDateIssues } from './paperValuationDate'
import { calcCommission, calcTax, resolveMarketSellFill } from './paperTradeMath'
import { buildSellOrderNote } from './paperOrderAccounting'
import { recordPaperExecutionEvent } from './paperExecutionEvents'
import { reconcilePendingBuyDebates, setupMorningPendingBuys } from './pendingBuyOrchestrator'
import { computePaperTotalValue, getUnsettledSettlementSummary, requireCompletePaperPositionValue } from './paperAccountValue'
import { buildStockVisionSellOrderIntent } from './stockvisionOrderIntent'
import { writeDailyExecutionPaperClosureArtifacts } from './dailyExecutionPaperLineage'
import { databaseForDataDomain } from './dataDomainRegistry'
import { paperDomainDatabase } from './paperDomainDatabase'
import { outstandingCorporateEntitlements, corporateReceivableBounds } from './paperCorporateActions'


export type DailySnapshotOptions = {
  date?: string
  allowUnpricedRights?: boolean
}

function snapshotDate(raw?: string): string {
  const value = String(raw ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  return new Date(paperExecutionNow() + 8 * 3600_000).toISOString().slice(0, 10)
}

export async function runDailySnapshot(env: Bindings, options: DailySnapshotOptions = {}) {
  console.log('[Snapshot] Starting...')
  const today = snapshotDate(options.date)
  const paperDb = paperDomainDatabase(env)
  const weekday = new Date(today + 'T00:00:00Z').getUTCDay()
  const valuationSession = weekday === 0 || weekday === 6 || await env.KV.get(`holiday:${today}`)
    ? await getPrevTradingDay(databaseForDataDomain(env, 'core'), env.KV, today) : today

  const updatedAcc = await paperDb.prepare('SELECT cash, initial_cash FROM paper_accounts WHERE id=?').bind(paperAccountId()).first<any>()
  if (!updatedAcc) throw new Error('paper_snapshot_account_missing')

  const { results: finalPos } = await paperDb.prepare(
    'SELECT symbol, shares FROM paper_positions WHERE account_id=? AND shares>0',
  ).bind(paperAccountId()).all<any>()

  const corporateRights = await outstandingCorporateEntitlements(paperDb, paperAccountId())
  const stockRights = corporateRights.filter(row => row.shares_due > 0 || row.kind === 'subscription').map(row => row.symbol)
  const finalSymbols = [...new Set([...(finalPos ?? []).map((p: any) => p.symbol), ...stockRights])]
  const postCloseRefresh = await refreshOpenPositionPostClosePriceCache(env, { tradeDate: valuationSession, additionalSymbols: stockRights })
  const finalPriceMap = new Map<string, number>(
    [...postCloseRefresh.prices.entries()].map(([symbol, snapshot]) => [symbol, snapshot.price]),
  )
  const missingFinalSymbols = finalSymbols.filter((symbol: string) => !finalPriceMap.has(symbol))
  const eodMarks = await batchGetClosingMarksByDomain(env, missingFinalSymbols, valuationSession)
  for (const [symbol, mark] of eodMarks) finalPriceMap.set(symbol, mark.price)
  const markEvidence = Object.fromEntries(finalSymbols.filter(s => finalPriceMap.has(s)).map(symbol => {
    const quote = postCloseRefresh.prices.get(symbol)
    // price_date comes from the row that supplied the price, never from the session we asked for.
    return [symbol, { price: finalPriceMap.get(symbol), price_date: quote?.trade_date ?? eodMarks.get(symbol)?.date ?? null,
      source: quote?.source ?? 'stock_prices.exact_session_close',
      quote_time: quote?.quote_time ?? null, observed_at: quote?.updated_at ?? null }]
  }))

  // Never persist a partial valuation as a genuine account loss. Retrying after
  // prices arrive is safe; no snapshot/closure has been written at this point.
  // O04: every held mark must be dated the valuation session. Record the pending valuation before
  // failing so the gap is visible; a price from another day never stands in.
  const heldSymbols = (finalPos ?? []).filter((p: any) => Number(p.shares) > 0).map((p: any) => String(p.symbol))
  const markIssues = sessionMarkDateIssues(heldSymbols, markEvidence, valuationSession, postCloseRefresh.rejected)
  if (markIssues.length > 0) {
    const dateMismatch = markIssues.filter(issue => issue.issue !== 'missing')
    const reason = dateMismatch.length ? 'paper_snapshot_mark_date_mismatch' : 'paper_snapshot_held_marks_missing'
    await recordPaperExecutionEvent(env, {
      tradeDate: today, eventType: 'snapshot_audit', status: 'pending_valuation', reason,
      detail: { valuation_session: valuationSession, mark_issues: markIssues,
        missing_symbols: markIssues.filter(issue => issue.issue === 'missing').map(issue => issue.symbol),
        positions: Object.fromEntries((finalPos ?? []).map((p: any) => [p.symbol, p.shares])),
        marks: Object.fromEntries(finalPriceMap), mark_evidence: markEvidence,
        rejected_quotes: Object.fromEntries(postCloseRefresh.rejected) },
      source: 'daily-snapshot',
    })
    if (dateMismatch.length) {
      throw new Error(`${reason}:${valuationSession}:` + dateMismatch.map(issue => `${issue.symbol}@${issue.price_date ?? 'undated'}`).join(','))
    }
  }
  const finalPosValue = requireCompletePaperPositionValue(finalPos ?? [], finalPriceMap)

  const settlement = await getUnsettledSettlementSummary(paperDb, paperAccountId())
  const bounds = corporateReceivableBounds(corporateRights, finalPriceMap)
  const corporateValue = bounds.lower
  const totalValue = computePaperTotalValue({
    settledCash: updatedAcc.cash,
    positionsValue: finalPosValue,
    netUnsettledSettlement: settlement.netUnsettledSettlement,
    corporateReceivablesValue: corporateValue,
  })
  const valuation = {
    settled_cash: updatedAcc.cash, cash: updatedAcc.cash + settlement.netUnsettledSettlement,
    positions: Object.fromEntries((finalPos ?? []).map((p: any) => [p.symbol, p.shares])),
    corporate_receivables: corporateRights,
    corporate_receivables_value: bounds.complete ? corporateValue : null,
    marks: Object.fromEntries(finalPriceMap), mark_evidence: markEvidence, nav: bounds.complete ? totalValue : null,
    nav_lower_bound: totalValue, nav_upper_bound: totalValue + bounds.upper - bounds.lower,
    unpriced_rights: bounds.unpricedRights, valuation_complete: bounds.complete,
  }
  if (!bounds.complete) {
    if (!options.allowUnpricedRights || scopedPaperAccountId() === null) {
      // Persist uncertainty, never an invented exact NAV or green closure.
      // Exits, settlements and rights expiry have independent cron owners.
      await recordPaperExecutionEvent(env, {
        tradeDate: today, eventType: 'snapshot_audit', status: 'pending_valuation',
        reason: 'paper_subscription_fair_value_unobservable', detail: valuation,
        source: 'daily-snapshot',
      })
      throw new Error('paper_subscription_fair_value_unobservable:' + bounds.unpricedRights.join(','))
    }
    // Only the isolated native runner owns accounting-only continuation. Do
    // not write an invented NAV into formal snapshots or a green closure.
    return { date: today, valuation }
  }
  const pnl = totalValue - updatedAcc.initial_cash
  const pnlPct = updatedAcc.initial_cash > 0 ? pnl / updatedAcc.initial_cash * 100 : 0

  // AUD-20: benchmarks are the valuation session's exact closes; a gap stays null, never an older close.
  const [benchmarkPrices, twiiRow] = await Promise.all([
    batchGetClosingPricesByDomain(env, ['0050'], valuationSession),
    databaseForDataDomain(env, 'core').prepare(
      'SELECT twii_close FROM market_risk WHERE date = ? AND twii_close > 0',
    ).bind(valuationSession).first<any>(),
  ])
  const normalizedBenchmarkValue: number | null = benchmarkPrices.get('0050') ?? null
  const twiiValue: number | null = twiiRow?.twii_close ?? null
  if (normalizedBenchmarkValue == null || twiiValue == null) {
    await recordPaperExecutionEvent(env, {
      tradeDate: today, eventType: 'snapshot_audit', status: 'warn', reason: 'benchmark_mark_missing',
      detail: { valuation_session: valuationSession, benchmark_0050: normalizedBenchmarkValue, twii: twiiValue },
      source: 'daily-snapshot',
    })
  }

  const { results: allSnapshots } = await paperDb.prepare(
    'SELECT total_value FROM paper_daily_snapshots WHERE account_id=? AND date < ? ORDER BY date ASC',
  ).bind(paperAccountId(), today).all<any>()
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

  const { results: recent30 } = await paperDb.prepare(
    'SELECT total_value FROM paper_daily_snapshots WHERE account_id=? AND date < ? ORDER BY date DESC LIMIT 30',
  ).bind(paperAccountId(), today).all<any>()
  if (recent30 && recent30.length >= 9) {
    const values = [...recent30.map((s: any) => s.total_value as number).reverse(), totalValue]
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

  const firstSnapshot = await paperDb.prepare(
    'SELECT date FROM paper_daily_snapshots WHERE account_id=? ORDER BY date ASC LIMIT 1',
  ).bind(paperAccountId()).first<any>()
  if (firstSnapshot?.date && updatedAcc.initial_cash > 0 && totalValue > 0) {
    const d0 = new Date(firstSnapshot.date)
    const d1 = new Date(today)
    const years = Math.max((d1.getTime() - d0.getTime()) / (365.25 * 86400_000), 0.01)
    cagr = Math.pow(totalValue / updatedAcc.initial_cash, 1 / years) - 1
  }
  if (cagr != null && maxDrawdownToDate != null && maxDrawdownToDate > 0) {
    calmar = cagr / maxDrawdownToDate
  }

  const snapshotWrite = paperDb.prepare(`
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
    paperAccountId(),
    today,
    updatedAcc.cash,
    finalPosValue,
    totalValue,
    pnl,
    pnlPct,
    normalizedBenchmarkValue,
    twiiValue,
    maxDrawdownToDate,
    sharpe30d,
    sortino30d,
    calmar,
    cagr,
  )
  // The TW 18:25 settle run re-marks the same session on the exact close once
  // stock_prices has it; only the first write of a session notifies.
  const priorSnapshot = await paperDb.prepare(
    'SELECT 1 AS present FROM paper_daily_snapshots WHERE account_id=? AND date=?',
  ).bind(paperAccountId(), today).first<any>()
  // Persist per-symbol marks atomically with the NAV that used them. This is
  // necessary to explain historical valuation; aggregate NAV alone cannot.
  const saved = await paperDb.batch([snapshotWrite, paperDb.prepare(`
    INSERT INTO paper_execution_events(account_id,trade_date,event_type,status,reason,detail_json,source)
    VALUES(?,?,'snapshot_audit','verified','dated_marks_complete',?,'daily-snapshot')
  `).bind(paperAccountId(), today, JSON.stringify(valuation))])
  if (saved.some(result => !result.success)) throw new Error('paper_snapshot_mark_receipt_write_failed')

  const { auditPaperSnapshotConsistency } = await import('./paperSnapshotAudit')
  await auditPaperSnapshotConsistency(env, {
    date: today,
    cash: updatedAcc.cash,
    positionsValue: finalPosValue,
    totalValue,
  })
  const { reconcilePaperNavCashFlow } = await import('./paperSnapshotAudit')
  await reconcilePaperNavCashFlow(env, { date: today, valuation, notify: !priorSnapshot })
  await writeDailyExecutionPaperClosureArtifacts(env, today)
  const { recordL4AccountReward } = await import('./l4AccountReward')
  const l4Reward = await recordL4AccountReward(env, today, totalValue)
  if (l4Reward.status === 'unavailable') console.warn('[Snapshot] L4 reward unavailable:', l4Reward.reason)
  const {updateRotationAudit}=await import('./paperRotationAudit')
  await updateRotationAudit(env,today)

  console.log(
    `[Snapshot] total_value=NT$${Math.round(totalValue).toLocaleString()} pnl=${pnlPct.toFixed(2)}% ` +
    `valuation_session=${valuationSession} marks=${finalPriceMap.size}/${finalSymbols.length} rerun=${Boolean(priorSnapshot)}`,
  )

  const todayOrderCount = await paperDb.prepare(
    "SELECT COUNT(*) as cnt FROM paper_orders WHERE account_id=? AND created_at >= ?",
  ).bind(paperAccountId(), today).first<any>()
  if (!priorSnapshot) {
    void sendDiscordNotification(
      (env as any).DISCORD_WEBHOOK_URL,
      formatDailySummary(totalValue, pnlPct / 100, todayOrderCount?.cnt ?? 0, maxDrawdownToDate, sharpe30d),
    )
  }

  return { date: today, valuation, l4Reward, valuation_session: valuationSession, rerun: Boolean(priorSnapshot) }
}

export async function runPaperAutoTrade(env: Bindings): Promise<void> {
  await setupMorningPendingBuys(env)
  await reconcilePendingBuyDebates(env)
}

export interface RescoreSellParams {
  symbol: string
  shares: number
  price: number
  quote?: IntradayOHLC
  reason: string
  source: string
}

export async function executeRescoreSell(env: Bindings, params: RescoreSellParams): Promise<{ filled: boolean; price?: number; reason?: string }> {
  if (!isPaperContinuousSession()) return { filled: false, reason: 'paper_outside_continuous_session' }
  const { getTradingConfig } = await import('./tradingConfig')
  const cfg = await getTradingConfig(env.KV)
  const { symbol, shares, price, quote, reason, source } = params
  const paperDb = paperDomainDatabase(env)

  const fill = resolveMarketSellFill({
    currentPrice: quote?.last ?? price,
    bestBid: quote?.bid,
    bestAsk: quote?.ask,
    intradayLow: quote?.low,
    intradayHigh: quote?.high,
    slippageTicks: 1,
    requireBestBid: true,
  })
  if (!fill.fillable || fill.fillPrice == null) {
    await recordPaperExecutionEvent(env, {
      symbol,
      side: 'sell',
      eventType: 'paper_order',
      status: 'skipped',
      reason: 'rescore_sell_unfillable',
      detail: {
        shares,
        requested_price: price,
        exit_reason: reason,
        fill_reason: fill.reason,
        quote_last: quote?.last ?? null,
        quote_bid: quote?.bid ?? null,
        quote_ask: quote?.ask ?? null,
        quote_low: quote?.low ?? null,
        quote_high: quote?.high ?? null,
        quote_time: quote?.quoteTime ?? null,
        quote_source: quote?.source ?? null,
      },
      source,
    })
    return { filled: false, reason: fill.reason }
  }

  const sellPrice = fill.fillPrice
  const txValue = sellPrice * shares
  const commission = calcCommission(txValue, cfg, shares)
  const tax = calcTax(txValue, cfg, false)
  const proceeds = txValue - commission - tax

  const pos = await paperDb.prepare(
    'SELECT name, shares, entry_price, entry_date, avg_cost FROM paper_positions WHERE account_id=? AND symbol=?',
  ).bind(paperAccountId(), symbol).first<any>()

  if (!pos || !Number.isSafeInteger(Number(pos.shares)) || Number(pos.shares) <= 0
    || !Number.isSafeInteger(shares) || shares <= 0 || shares > Number(pos.shares)) {
    throw new Error('rescore_sell_position_or_quantity_invalid')
  }

  const name = pos?.name ?? symbol
  const entryPrice = pos?.entry_price ?? pos?.avg_cost ?? price
  const daysHeld = pos?.entry_date ? Math.round((paperExecutionNow() - new Date(pos.entry_date).getTime()) / 86400000) : 0
  const tradeDate = new Date(paperExecutionNow() + 8 * 3600_000).toISOString().slice(0, 10)
  const sellOrderIntent = buildStockVisionSellOrderIntent({
    accountId: paperAccountId(),
    tradeDate,
    symbol,
    limitPrice: sellPrice,
    currentPrice: quote?.last ?? price,
    shares,
    reason,
    strategyType: 'rescore_sell',
    quote: {
      bestBid: quote?.bid ?? null,
      bestAsk: quote?.ask ?? null,
      source: quote?.source ?? null,
      quoteAgeMs: null,
    },
  })
  const sellNote = buildSellOrderNote(
    { reason, is_day_trade: false, entry_date: pos?.entry_date, days_held: daysHeld, order_intent: sellOrderIntent, order_legs: sellOrderIntent.orderLegs },
    { entryPrice, exitPrice: sellPrice, shares, commission, tax },
  )

  await executeContinuousPaperBatch(env,[
    shares === Number(pos.shares)
      ? paperDb.prepare('DELETE FROM paper_positions WHERE account_id=? AND symbol=?').bind(paperAccountId(), symbol)
      : paperDb.prepare('UPDATE paper_positions SET shares=shares-? WHERE account_id=? AND symbol=?')
          .bind(shares, paperAccountId(), symbol),
    paperDb.prepare(`
      INSERT INTO paper_orders
        (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
      VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, ?, 'EXIT', NULL, ?)
    `).bind(
      paperAccountId(),
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
  const orderId = await recordSellSettlement(paperDb, env.KV, paperAccountId(), symbol, proceeds)
  await recordPaperExecutionEvent(env, {
    symbol,
    side: 'sell',
    eventType: 'paper_order',
    status: 'filled',
    reason,
    detail: {
      shares,
      order_intent: sellOrderIntent,
      order_legs: sellOrderIntent.orderLegs,
      sell_price: sellPrice,
      proceeds,
      days_held: daysHeld,
      fill_reason: fill.reason,
      quote_last: quote?.last ?? null,
      quote_bid: quote?.bid ?? null,
      quote_ask: quote?.ask ?? null,
      quote_low: quote?.low ?? null,
      quote_high: quote?.high ?? null,
      quote_time: quote?.quoteTime ?? null,
      quote_source: quote?.source ?? null,
    },
    orderId,
    source,
  })

  console.log(`[Rescore-Sell] ${symbol} ${shares} 股 @ ${sellPrice} | entry=${entryPrice} | held=${daysHeld}d | ${reason}`)
  return { filled: true, price: sellPrice, reason: fill.reason }
}
