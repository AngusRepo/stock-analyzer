import type { Bindings } from '../types'
import { formatTradeNotification, sendDiscordNotification } from './notify'
import { checkExitConditions, type ExitDecision } from './paperExitPolicy'
import { batchGetIntradayOHLC, type IntradayOHLC } from './paperIntradayData'
import {
  batchGetATR,
  getCurrentRegime,
  getPrevTradingDay,
  isDayTradeAllowed,
  logRegimeShadow,
  recordSellSettlement,
} from './paperMarketData'
import { calcCommission, calcTax, resolveMarketSellFill } from './paperTradeMath'
import { buildSellOrderNote, calcRealizedPnlSnapshot } from './paperOrderAccounting'
import { recordPaperExecutionEvent } from './paperExecutionEvents'
import { arbitratePaperExit, paperExitCandidateFromDecision, type PaperExitCandidate } from './paperExitArbiter'
import { buildHoldingExitReview, buildHoldingExitReviewCandidate, type HoldingExitReview } from './holdingExitReview'
import { loadHoldingExitFeatureMap } from './holdingExitFeatureLoader'
import { getHoldingExitAdaptiveParams, recordHoldingExitSellOutcome } from './holdingExitLearning'
import { buildMovingTakeProfitTarget, type MovingTakeProfitTargetDecision } from './holdingExitTarget'
import { checkCircuitBreakers } from './pendingBuyOrchestrator'
import {
  getCurrentRegime as getCurrentSltpRegime,
  getTradingConfig,
  resolveSltpForRegime,
  type TradingConfig,
} from './tradingConfig'

const ACCOUNT_ID = 1

function resolveExitSellFill(quote: IntradayOHLC): { fillable: boolean; price?: number; reason: string; detail: Record<string, unknown> } {
  const fill = resolveMarketSellFill({
    currentPrice: quote.last,
    bestBid: quote.bid,
    bestAsk: quote.ask,
    intradayLow: quote.low,
    intradayHigh: quote.high,
    slippageTicks: 1,
    requireBestBid: true,
  })
  return {
    fillable: fill.fillable,
    price: fill.fillPrice,
    reason: fill.reason,
    detail: {
      fill_reason: fill.reason,
      quote_last: quote.last,
      quote_bid: quote.bid ?? null,
      quote_ask: quote.ask ?? null,
      quote_low: quote.low ?? null,
      quote_high: quote.high ?? null,
      quote_bid_volume: quote.bidVolume ?? null,
      quote_ask_volume: quote.askVolume ?? null,
      quote_total_volume: quote.totalVolume ?? null,
      quote_time: quote.quoteTime ?? null,
      quote_source: quote.source ?? null,
    },
  }
}

function candidateToExitDecision(candidate: PaperExitCandidate, baseline: ExitDecision): ExitDecision {
  if (candidate.source === 'current_policy') return baseline
  if (candidate.action === 'full_sell') return { action: 'full_sell', reason: candidate.reason }
  if (candidate.action === 'partial_sell') {
    return { action: 'partial_sell', reason: candidate.reason, sellShares: candidate.sellShares }
  }
  return {
    action: 'hold',
    reason: candidate.reason,
    newTrailingStop: candidate.newTrailingStop,
    newHighest: candidate.newHighest,
  }
}

async function recordHoldingExitReviewEvent(
  env: Bindings,
  tradeDate: string,
  pos: any,
  review: HoldingExitReview,
  finalCandidate: PaperExitCandidate,
  movingTarget?: MovingTakeProfitTargetDecision,
): Promise<void> {
  await recordPaperExecutionEvent(env, {
    tradeDate,
    symbol: pos.symbol,
    side: null,
    eventType: 'holding_exit_review',
    status: review.action,
    reason: review.reasons.join(',') || 'holding_exit_review',
    detail: {
      score: review.score,
      confidence: review.confidence,
      reasons: review.reasons,
      factors: review.factors,
      features: review.features,
      suggested_trailing_stop: review.suggestedTrailingStop ?? null,
      moving_tp_target: movingTarget ?? null,
      baseline_counterfactual: review.baselineCounterfactual,
      final_candidate: finalCandidate,
    },
    source: 'adaptive_exit',
  })
}

async function applyTightenTrailCandidate(
  env: Bindings,
  pos: any,
  candidate: PaperExitCandidate,
): Promise<boolean> {
  if (candidate.action !== 'tighten_trail') return false
  const nextTrail = Number(candidate.newTrailingStop)
  if (!Number.isFinite(nextTrail) || nextTrail <= 0) return false
  const nextHighest = candidate.newHighest ?? pos.highest_since_entry
  await env.DB.prepare(`
    UPDATE paper_positions SET trailing_stop=?, highest_since_entry=?, updated_at=datetime('now')
    WHERE account_id=? AND symbol=?
  `).bind(
    nextTrail,
    nextHighest,
    ACCOUNT_ID,
    pos.symbol,
  ).run()
  return true
}

async function applyMovingTp2Target(
  env: Bindings,
  tradeDate: string,
  pos: any,
  decision: MovingTakeProfitTargetDecision,
): Promise<any> {
  if (decision.action !== 'move_tp2' || decision.nextTp2Price == null) return pos
  await env.DB.prepare(`
    UPDATE paper_positions SET tp2_price=?, updated_at=datetime('now')
    WHERE account_id=? AND symbol=?
  `).bind(
    decision.nextTp2Price,
    ACCOUNT_ID,
    pos.symbol,
  ).run()
  await recordPaperExecutionEvent(env, {
    tradeDate,
    symbol: pos.symbol,
    side: null,
    eventType: 'holding_exit_target_update',
    status: 'move_tp2',
    reason: decision.reason,
    detail: { ...decision },
    source: 'adaptive_exit',
  })
  return { ...pos, tp2_price: decision.nextTp2Price }
}

async function recordExitLearningOutcome(input: {
  env: Bindings
  tradeDate: string
  pos: any
  entryDate?: string | null
  entryPrice: number
  exitPrice: number
  shares: number
  positionSharesBeforeExit?: number | null
  exitReason: string
  exitSource: string
  orderId?: number | null
}): Promise<void> {
  try {
    await recordHoldingExitSellOutcome({
      env: input.env,
      tradeDate: input.tradeDate,
      symbol: input.pos.symbol,
      entryDate: input.entryDate ?? input.pos.entry_date ?? null,
      entryPrice: input.entryPrice,
      exitPrice: input.exitPrice,
      shares: input.shares,
      positionSharesBeforeExit: input.positionSharesBeforeExit ?? input.pos.shares ?? null,
      exitReason: input.exitReason,
      exitSource: input.exitSource,
      orderId: input.orderId ?? null,
    })
  } catch (error) {
    console.warn(`[HoldingExitLearning] outcome record failed for ${input.pos.symbol}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runPostExitDiscipline(
  env: Bindings,
  cfg: TradingConfig,
  symbol: string,
  reason: string,
  stage: 'full_sell',
  logPrefix: 'EODExit' | 'Intraday',
): Promise<void> {
  try {
    const { onPostExit } = await import('./postExit')
    const twToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    const rerankEnabled = (cfg as any).postExit?.enableRerank === true
    const outcome = await onPostExit(
      {
        kv: env.KV,
        db: env.DB,
        today: twToday,
        soldSymbol: symbol,
        exitReason: reason,
        exitAction: stage,
        accountId: ACCOUNT_ID,
      },
      { enableRerank: rerankEnabled, maxPositions: cfg.position.maxPositions ?? 5 },
    )
    console.log(
      `[${logPrefix}] post-exit ${symbol}: category=${outcome.category} cooldown=${outcome.cooldown_days}d freeze=${outcome.freeze_applied} rerank=${outcome.rerank_queued} (${outcome.reason ?? ''})`,
    )
  } catch (e) {
    console.warn(`[${logPrefix}] post-exit hook failed (non-fatal):`, e)
  }
}

export async function forceDayTradeClose(env: Bindings, cfg: TradingConfig, today: string): Promise<void> {
  const { results: sameDayPos } = await env.DB.prepare(
    'SELECT * FROM paper_positions WHERE account_id=? AND shares>0 AND entry_date=?',
  ).bind(ACCOUNT_ID, today).all<any>()
  if (!sameDayPos?.length) return

  const symbols = sameDayPos.map((p: any) => p.symbol)
  const quoteMap = await batchGetIntradayOHLC(symbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
    requireBrokerQuote: true,
  })
  const atrMap = await batchGetATR(env.DB, symbols)
  const regime = await getCurrentRegime(env.KV)

  for (const pos of sameDayPos) {
    const quote = quoteMap.get(pos.symbol)
    if (!quote) continue
    const price = quote.last
    const atr = atrMap.get(pos.symbol) ?? price * cfg.exit.fallbackAtrPct

    const prevCloseRow = await env.DB.prepare(
      'SELECT close, volume FROM stock_prices WHERE stock_id=(SELECT id FROM stocks WHERE symbol=?) ORDER BY date DESC LIMIT 1',
    ).bind(pos.symbol).first<any>()
    if (prevCloseRow && prevCloseRow.close > 0) {
      const dropPct = (price - prevCloseRow.close) / prevCloseRow.close
      const limitDownLog = cfg.circuit.limitDownPct ?? -0.095
      if (dropPct <= limitDownLog) {
        console.log(`[Exit] ${pos.symbol} at limit-down (${(dropPct * 100).toFixed(1)}%), sell may not execute`)
      }
    }

    const decision = checkExitConditions(
      pos,
      price,
      atr,
      false,
      false,
      cfg,
      resolveSltpForRegime(cfg, await getCurrentSltpRegime(env.KV)),
      regime ?? undefined,
    )
    if (regime) logRegimeShadow('forceDayTradeClose', pos.symbol, regime, decision.action, decision.reason, env.DB)
    if (decision.action === 'hold') continue

    const dtCheck = await isDayTradeAllowed(pos.symbol, pos.shares, decision.reason, env.KV)
    if (!dtCheck.allowed) continue

    const shares = pos.shares
    const sellFill = resolveExitSellFill(quote)
    if (!sellFill.fillable || sellFill.price == null) {
      await recordPaperExecutionEvent(env, {
        tradeDate: today,
        symbol: pos.symbol,
        side: 'sell',
        eventType: 'paper_order',
        status: 'skipped',
        reason: 'daytrade_sell_unfillable',
        detail: { shares, exit_reason: decision.reason, ...sellFill.detail },
        source: 'daytrade_force_close',
      })
      continue
    }
    const fillPrice = sellFill.price
    const txValue = fillPrice * shares
    const commission = calcCommission(txValue, cfg)
    const tax = calcTax(txValue, cfg, true)
    const proceeds = txValue - commission - tax
    const entryPrice = pos.entry_price ?? pos.avg_cost
    const sellNote = buildSellOrderNote({
      reason: `[13:25 daytrade force close] ${decision.reason}`,
      entry_date: pos.entry_date,
    }, { entryPrice, exitPrice: fillPrice, shares, commission, tax })

    await env.DB.batch([
      env.DB.prepare('DELETE FROM paper_positions WHERE account_id=? AND symbol=?').bind(ACCOUNT_ID, pos.symbol),
      env.DB.prepare(`
        INSERT INTO paper_orders
          (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
        VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, 'daytrade_force_close', 'EXIT', ?, ?)
      `).bind(
        ACCOUNT_ID,
        pos.symbol,
        pos.name,
        shares,
        fillPrice,
        commission,
        tax,
        proceeds,
        null,
        sellNote,
      ),
    ])
    const orderId = await recordSellSettlement(env.DB, env.KV, ACCOUNT_ID, pos.symbol, proceeds)
    await recordPaperExecutionEvent(env, {
      tradeDate: today,
      symbol: pos.symbol,
      side: 'sell',
      eventType: 'paper_order',
      status: 'filled',
      reason: 'daytrade_force_close',
      detail: { shares, price: fillPrice, proceeds, exit_reason: decision.reason, ...sellFill.detail },
      orderId,
      source: 'daytrade_force_close',
    })
    await recordExitLearningOutcome({
      env,
      tradeDate: today,
      pos,
      entryPrice,
      exitPrice: fillPrice,
      shares,
      exitReason: decision.reason,
      exitSource: 'daytrade_force_close',
      orderId,
    })
    const pnl = (fillPrice - entryPrice) / entryPrice
    console.log(`[DayTrade] 13:25 force close ${pos.symbol} ${shares} @ ${fillPrice} ${(pnl * 100).toFixed(1)}%`)
    void sendDiscordNotification(
      (env as any).DISCORD_WEBHOOK_URL,
      formatTradeNotification('sell', pos.symbol, pos.name, shares, fillPrice, `13:25 daytrade force close: ${decision.reason}`, pnl),
    )
  }
}

export async function runEODExit(env: Bindings): Promise<void> {
  console.log('[EODExit] Starting...')
  const cfg = await getTradingConfig(env.KV)

  const { results: exitPositions } = await env.DB.prepare(
    `SELECT symbol, shares, avg_cost, name, entry_price, entry_date,
            initial_stop, trailing_stop, highest_since_entry, stop_multiplier,
            tp1_price, tp2_price, tp1_hit, original_shares
     FROM paper_positions WHERE account_id=? AND shares>0`,
  ).bind(ACCOUNT_ID).all<any>()

  if (!exitPositions || exitPositions.length === 0) {
    console.log('[EODExit] no open positions')
    return
  }

  const exitSymbols = exitPositions.map((p: any) => p.symbol)
  const exitQuoteMap = await batchGetIntradayOHLC(exitSymbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
    requireBrokerQuote: true,
  })
  const exitAtrMap = await batchGetATR(env.DB, exitSymbols)
  const eodRegime = await getCurrentRegime(env.KV)

  const prevDay = await getPrevTradingDay(env.DB, env.KV)
  const cb = await checkCircuitBreakers(env.DB, cfg, env.KV)
  {
    const { writeAuditEntry } = await import('./riskAudit')
    writeAuditEntry(env.DB, {
      triggerEvent: 'eod_exit',
      decision: cb.halt ? 'halt' : 'executed',
      riskState: cb,
    }).catch(() => {})
  }

  const sellRecMap = new Map<string, any>()
  if (exitSymbols.length > 0) {
    const placeholders = exitSymbols.map(() => '?').join(',')
    const { results: sellRecs } = await env.DB.prepare(`
      SELECT symbol, signal, confidence FROM daily_recommendations
      WHERE date=? AND symbol IN (${placeholders})
        AND signal IN ('SELL','STRONG_SELL') AND confidence >= ?
    `).bind(prevDay, ...exitSymbols, cb.sellConfThreshold).all<any>()
    for (const r of sellRecs ?? []) sellRecMap.set(r.symbol, r)
  }

  const eodToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const eodPriceMap = new Map<string, number>()
  for (const pos of exitPositions) {
    const quote = exitQuoteMap.get(pos.symbol)
    if (quote) eodPriceMap.set(pos.symbol, quote.last)
  }
  const eodHoldingExitFeatures = await loadHoldingExitFeatureMap(
    env.DB,
    exitPositions,
    eodPriceMap,
    eodToday,
    eodRegime ?? null,
  )
  const eodHoldingExitParams = await getHoldingExitAdaptiveParams(env.KV)

  for (const pos of exitPositions) {
    const quote = exitQuoteMap.get(pos.symbol)
    if (!quote) continue
    const currentPrice = quote.last

    const atr14 = exitAtrMap.get(pos.symbol) ?? currentPrice * cfg.exit.fallbackAtrPct
    const staticBaselineDecision = checkExitConditions(
      pos,
      currentPrice,
      atr14,
      sellRecMap.has(pos.symbol),
      true,
      cfg,
      resolveSltpForRegime(cfg, await getCurrentSltpRegime(env.KV)),
      eodRegime ?? undefined,
    )
    const holdingFeatures = eodHoldingExitFeatures.get(pos.symbol)
    const preliminaryReview = buildHoldingExitReview({
      position: pos,
      currentPrice,
      atr14,
      baseline: staticBaselineDecision,
      features: holdingFeatures,
      params: eodHoldingExitParams,
    })
    const movingTarget = buildMovingTakeProfitTarget({
      position: pos,
      currentPrice,
      atr14,
      review: preliminaryReview,
      staticBaseline: staticBaselineDecision,
      params: eodHoldingExitParams,
    })
    const activePos = await applyMovingTp2Target(env, eodToday, pos, movingTarget)
    const activeBaselineDecision = movingTarget.action === 'move_tp2'
      ? checkExitConditions(
        activePos,
        currentPrice,
        atr14,
        sellRecMap.has(pos.symbol),
        true,
        cfg,
        resolveSltpForRegime(cfg, await getCurrentSltpRegime(env.KV)),
        eodRegime ?? undefined,
      )
      : staticBaselineDecision
    const holdingReview = movingTarget.action === 'move_tp2'
      ? buildHoldingExitReview({
        position: activePos,
        currentPrice,
        atr14,
        baseline: staticBaselineDecision,
        features: holdingFeatures,
        params: eodHoldingExitParams,
      })
      : preliminaryReview
    const holdingCandidate = buildHoldingExitReviewCandidate(holdingReview, {
      allowSellActions: eodHoldingExitParams.sellActions.enabled,
      position: activePos,
      sellActions: eodHoldingExitParams.sellActions,
      dataQuality: eodHoldingExitParams.dataQuality,
    })
    const finalCandidate = arbitratePaperExit(
      [paperExitCandidateFromDecision(activeBaselineDecision), holdingCandidate],
      { currentTrailingStop: activePos.trailing_stop },
    )
    await recordHoldingExitReviewEvent(env, eodToday, activePos, holdingReview, finalCandidate, movingTarget)
    const decision = candidateToExitDecision(finalCandidate, activeBaselineDecision)
    if (eodRegime) logRegimeShadow('runEODExit', pos.symbol, eodRegime, decision.action, decision.reason, env.DB)

    if (await applyTightenTrailCandidate(env, pos, finalCandidate)) {
      console.log(`[EODExit] tighten trail ${pos.symbol} -> ${finalCandidate.newTrailingStop} (${finalCandidate.reason})`)
      continue
    }

    let dayTradeSell = false
    if (pos.entry_date === eodToday && decision.action !== 'hold') {
      const dtCheck = await isDayTradeAllowed(pos.symbol, pos.shares, decision.reason, env.KV)
      if (!dtCheck.allowed) {
        console.log(`[EODExit] daytrade blocked ${pos.symbol}: ${dtCheck.reason}`)
        continue
      }
      console.log(`[EODExit] daytrade sell ${pos.symbol}: ${dtCheck.reason}`)
      dayTradeSell = true
    }

    if (decision.action === 'full_sell') {
      const shares = pos.shares
      const sellFill = resolveExitSellFill(quote)
      if (!sellFill.fillable || sellFill.price == null) {
        await recordPaperExecutionEvent(env, {
          tradeDate: eodToday,
          symbol: pos.symbol,
          side: 'sell',
          eventType: 'paper_order',
          status: 'skipped',
          reason: 'eod_sell_unfillable',
          detail: { shares, exit_reason: decision.reason, ...sellFill.detail },
          source: 'eod_exit',
        })
        continue
      }
      const fillPrice = sellFill.price
      const txValue = fillPrice * shares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
      const proceeds = txValue - commission - tax
      const entryPx = pos.entry_price ?? pos.avg_cost
      const daysHeld = pos.entry_date ? Math.round((Date.now() - new Date(pos.entry_date).getTime()) / 86400000) : null
      const sellNote = buildSellOrderNote({
        reason: decision.reason,
        entry_date: pos.entry_date,
        days_held: daysHeld,
      }, { entryPrice: entryPx, exitPrice: fillPrice, shares, commission, tax })

      await env.DB.batch([
        env.DB.prepare('DELETE FROM paper_positions WHERE account_id=? AND symbol=?').bind(ACCOUNT_ID, pos.symbol),
        env.DB.prepare(`
          INSERT INTO paper_orders
            (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
          VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, 'eod_exit', ?, ?, ?)
        `).bind(
          ACCOUNT_ID,
          pos.symbol,
          pos.name,
          shares,
          fillPrice,
          commission,
          tax,
          proceeds,
          sellRecMap.get(pos.symbol)?.signal ?? 'EXIT',
          sellRecMap.get(pos.symbol)?.confidence ?? null,
          sellNote,
        ),
      ])
      const orderId = await recordSellSettlement(env.DB, env.KV, ACCOUNT_ID, pos.symbol, proceeds)
      await recordPaperExecutionEvent(env, {
        tradeDate: eodToday,
        symbol: pos.symbol,
        side: 'sell',
        eventType: 'paper_order',
        status: 'filled',
        reason: 'eod_exit',
        detail: { shares, price: fillPrice, proceeds, exit_reason: decision.reason, ...sellFill.detail },
        orderId,
        source: 'eod_exit',
      })
      await recordExitLearningOutcome({
        env,
        tradeDate: eodToday,
        pos,
        entryPrice: entryPx,
        exitPrice: fillPrice,
        shares,
        exitReason: decision.reason,
        exitSource: 'eod_exit',
        orderId,
      })
      const exitPnl = (fillPrice - entryPx) / entryPx
      console.log(`[EODExit] full sell ${pos.symbol} ${shares} @ ${fillPrice} entry=${entryPx} days=${daysHeld} pnl=${(exitPnl * 100).toFixed(1)}% ${decision.reason}`)
      void sendDiscordNotification(
        (env as any).DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, shares, fillPrice, `${decision.reason} | entry=${entryPx} held=${daysHeld}d`, exitPnl),
      )
      await runPostExitDiscipline(env, cfg, pos.symbol, decision.reason, 'full_sell', 'EODExit')
    } else if (decision.action === 'partial_sell' && decision.sellShares) {
      const sellShares = decision.sellShares
      const sellFill = resolveExitSellFill(quote)
      if (!sellFill.fillable || sellFill.price == null) {
        await recordPaperExecutionEvent(env, {
          tradeDate: eodToday,
          symbol: pos.symbol,
          side: 'sell',
          eventType: 'paper_order',
          status: 'skipped',
          reason: 'eod_tp1_unfillable',
          detail: { shares: sellShares, exit_reason: decision.reason, ...sellFill.detail },
          source: 'eod_tp1',
        })
        continue
      }
      const fillPrice = sellFill.price
      const txValue = fillPrice * sellShares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
      const proceeds = txValue - commission - tax
      const remainingShares = pos.shares - sellShares
      const entryPx = pos.entry_price ?? pos.avg_cost
      const sellNote = buildSellOrderNote({
        reason: decision.reason,
        entry_date: pos.entry_date,
        days_held: pos.entry_date ? Math.round((Date.now() - new Date(pos.entry_date).getTime()) / 86400000) : null,
      }, { entryPrice: entryPx, exitPrice: fillPrice, shares: sellShares, commission, tax })

      await env.DB.batch([
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
        `).bind(ACCOUNT_ID, pos.symbol, pos.name, sellShares, fillPrice, commission, tax, proceeds, null, sellNote),
      ])
      const orderId = await recordSellSettlement(env.DB, env.KV, ACCOUNT_ID, pos.symbol, proceeds)
      await recordPaperExecutionEvent(env, {
        tradeDate: eodToday,
        symbol: pos.symbol,
        side: 'sell',
        eventType: 'paper_order',
        status: 'filled',
        reason: 'eod_tp1',
        detail: { shares: sellShares, remaining_shares: remainingShares, price: fillPrice, proceeds, exit_reason: decision.reason, ...sellFill.detail },
        orderId,
        source: 'eod_tp1',
      })
      await recordExitLearningOutcome({
        env,
        tradeDate: eodToday,
        pos,
        entryPrice: entryPx,
        exitPrice: fillPrice,
        shares: sellShares,
        exitReason: decision.reason,
        exitSource: 'eod_tp1',
        orderId,
      })
      const tp1Pnl = (fillPrice - entryPx) / entryPx
      console.log(`[EODExit] TP1 ${pos.symbol} ${sellShares} @ ${fillPrice}`)
      void sendDiscordNotification(
        (env as any).DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, sellShares, fillPrice, `TP1 已觸發，剩餘 ${remainingShares} 股`, tp1Pnl),
      )
    }
  }

  console.log('[EODExit] Done.')
}

export async function pollIntradayStopLoss(env: Bindings): Promise<void> {
  const cfg = await getTradingConfig(env.KV)
  const { results: positions } = await env.DB.prepare(
    `SELECT symbol, shares, avg_cost, name, entry_price, entry_date,
            initial_stop, trailing_stop, highest_since_entry, stop_multiplier,
            tp1_price, tp2_price, tp1_hit, original_shares
     FROM paper_positions WHERE account_id=? AND shares>0`,
  ).bind(ACCOUNT_ID).all<any>()

  if (!positions || positions.length === 0) return

  const symbols = positions.map((p: any) => p.symbol)
  const quoteMap = await batchGetIntradayOHLC(symbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
    requireBrokerQuote: true,
  })
  const atrMap = await batchGetATR(env.DB, symbols)
  const intraRegime = await getCurrentRegime(env.KV)

  if (quoteMap.size === 0) {
    console.log('[Intraday] no intraday prices available')
    return
  }

  await Promise.allSettled(
    [...quoteMap].map(([symbol, quote]) => env.KV.put(`intraday:price:${symbol}`, String(quote.last), { expirationTtl: 600 })),
  )

  const intradayToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const intradayPriceMap = new Map<string, number>()
  for (const [symbol, quote] of quoteMap) intradayPriceMap.set(symbol, quote.last)
  const intradayHoldingExitFeatures = await loadHoldingExitFeatureMap(
    env.DB,
    positions,
    intradayPriceMap,
    intradayToday,
    intraRegime ?? null,
  )
  const intradayHoldingExitParams = await getHoldingExitAdaptiveParams(env.KV)
  const prevCloseMapSell = new Map<string, number>()
  if (symbols.length > 0) {
    const ph = symbols.map(() => '?').join(',')
    const { results: prevRows } = await env.DB.prepare(`
      SELECT s.symbol, sp.close FROM stock_prices sp
      JOIN stocks s ON s.id = sp.stock_id
      WHERE s.symbol IN (${ph}) AND sp.date < ?
      ORDER BY sp.date DESC
    `).bind(...symbols, intradayToday).all<{ symbol: string; close: number }>()
    for (const r of prevRows ?? []) {
      if (!prevCloseMapSell.has(r.symbol)) prevCloseMapSell.set(r.symbol, r.close)
    }
  }

  for (const pos of positions) {
    const quote = quoteMap.get(pos.symbol)
    if (!quote) continue
    const currentPrice = quote.last

    const atr14 = atrMap.get(pos.symbol) ?? currentPrice * cfg.exit.fallbackAtrPct
    const staticBaselineDecision = checkExitConditions(
      pos,
      currentPrice,
      atr14,
      false,
      false,
      cfg,
      resolveSltpForRegime(cfg, await getCurrentSltpRegime(env.KV)),
      intraRegime ?? undefined,
    )
    const holdingFeatures = intradayHoldingExitFeatures.get(pos.symbol)
    const preliminaryReview = buildHoldingExitReview({
      position: pos,
      currentPrice,
      atr14,
      baseline: staticBaselineDecision,
      features: holdingFeatures,
      params: intradayHoldingExitParams,
    })
    const movingTarget = buildMovingTakeProfitTarget({
      position: pos,
      currentPrice,
      atr14,
      review: preliminaryReview,
      staticBaseline: staticBaselineDecision,
      params: intradayHoldingExitParams,
    })
    const activePos = await applyMovingTp2Target(env, intradayToday, pos, movingTarget)
    const activeBaselineDecision = movingTarget.action === 'move_tp2'
      ? checkExitConditions(
        activePos,
        currentPrice,
        atr14,
        false,
        false,
        cfg,
        resolveSltpForRegime(cfg, await getCurrentSltpRegime(env.KV)),
        intraRegime ?? undefined,
      )
      : staticBaselineDecision
    const holdingReview = movingTarget.action === 'move_tp2'
      ? buildHoldingExitReview({
        position: activePos,
        currentPrice,
        atr14,
        baseline: staticBaselineDecision,
        features: holdingFeatures,
        params: intradayHoldingExitParams,
      })
      : preliminaryReview
    const holdingCandidate = buildHoldingExitReviewCandidate(holdingReview, {
      allowSellActions: intradayHoldingExitParams.sellActions.enabled,
      position: activePos,
      sellActions: intradayHoldingExitParams.sellActions,
      dataQuality: intradayHoldingExitParams.dataQuality,
    })
    const finalCandidate = arbitratePaperExit(
      [paperExitCandidateFromDecision(activeBaselineDecision), holdingCandidate],
      { currentTrailingStop: activePos.trailing_stop },
    )
    await recordHoldingExitReviewEvent(env, intradayToday, activePos, holdingReview, finalCandidate, movingTarget)
    const decision = candidateToExitDecision(finalCandidate, activeBaselineDecision)
    if (intraRegime) logRegimeShadow('pollIntradayStopLoss', pos.symbol, intraRegime, decision.action, decision.reason, env.DB)

    if (await applyTightenTrailCandidate(env, pos, finalCandidate)) {
      console.log(`[Intraday] tighten trail ${pos.symbol} -> ${finalCandidate.newTrailingStop} (${finalCandidate.reason})`)
      continue
    }

    if (decision.action !== 'hold') {
      const prevC = prevCloseMapSell.get(pos.symbol)
      if (prevC && prevC > 0) {
        const changePct = (currentPrice - prevC) / prevC
        const limitDown = cfg.circuit.limitDownPct ?? -0.095
        if (changePct <= limitDown) {
          console.warn(`[Intraday] skip ${pos.symbol}: likely limit-down ${(changePct * 100).toFixed(1)}%`)
          continue
        }
      }
    }

    let dayTradeSell = false
    if (pos.entry_date === intradayToday && decision.action !== 'hold') {
      const dtCheck = await isDayTradeAllowed(pos.symbol, pos.shares, decision.reason, env.KV)
      if (!dtCheck.allowed) {
        if (new Date().getUTCMinutes() % 10 === 0) {
          console.log(`[Intraday] daytrade blocked ${pos.symbol}: ${dtCheck.reason}`)
        }
        continue
      }
      dayTradeSell = true
    }

    if (decision.action === 'full_sell') {
      const shares = pos.shares
      const sellFill = resolveExitSellFill(quote)
      if (!sellFill.fillable || sellFill.price == null) {
        await recordPaperExecutionEvent(env, {
          tradeDate: intradayToday,
          symbol: pos.symbol,
          side: 'sell',
          eventType: 'paper_order',
          status: 'skipped',
          reason: 'intraday_sell_unfillable',
          detail: { shares, exit_reason: decision.reason, ...sellFill.detail },
          source: 'intraday_exit',
        })
        continue
      }
      const sellFillPrice = sellFill.price
      const txValue = sellFillPrice * shares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
      const proceeds = txValue - commission - tax
      const entryPx = pos.entry_price ?? pos.avg_cost
      const sellNote = buildSellOrderNote({
        reason: `[intraday] ${decision.reason} (mkt=${currentPrice}, -1 tick fill)`,
        entry_date: pos.entry_date,
      }, { entryPrice: entryPx, exitPrice: sellFillPrice, shares, commission, tax })

      await env.DB.batch([
        env.DB.prepare('DELETE FROM paper_positions WHERE account_id=? AND symbol=?').bind(ACCOUNT_ID, pos.symbol),
        env.DB.prepare(`
          INSERT INTO paper_orders
            (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
          VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, 'intraday_exit', 'EXIT', ?, ?)
        `).bind(
          ACCOUNT_ID,
          pos.symbol,
          pos.name,
          shares,
          sellFillPrice,
          commission,
          tax,
          proceeds,
          null,
          sellNote,
        ),
      ])
      const orderId = await recordSellSettlement(env.DB, env.KV, ACCOUNT_ID, pos.symbol, proceeds)
      await recordPaperExecutionEvent(env, {
        tradeDate: intradayToday,
        symbol: pos.symbol,
        side: 'sell',
        eventType: 'paper_order',
        status: 'filled',
        reason: 'intraday_exit',
        detail: { shares, fill_price: sellFillPrice, market_price: currentPrice, proceeds, exit_reason: decision.reason, ...sellFill.detail },
        orderId,
        source: 'intraday_exit',
      })
      await recordExitLearningOutcome({
        env,
        tradeDate: intradayToday,
        pos,
        entryPrice: entryPx,
        exitPrice: sellFillPrice,
        shares,
        exitReason: decision.reason,
        exitSource: 'intraday_exit',
        orderId,
      })
      console.warn(`[Intraday] full sell ${pos.symbol} ${shares} @ ${sellFillPrice} (mkt ${currentPrice}) ${decision.reason}`)
      const intradayPnl = calcRealizedPnlSnapshot({ entryPrice: entryPx, exitPrice: sellFillPrice, shares, commission, tax }).realized_pnl_pct / 100
      void sendDiscordNotification(
        env.DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, shares, sellFillPrice, `盤中賣出: ${decision.reason}`, intradayPnl),
      )
      await runPostExitDiscipline(env, cfg, pos.symbol, decision.reason, 'full_sell', 'Intraday')
    } else if (decision.action === 'partial_sell' && decision.sellShares) {
      const sellShares = decision.sellShares
      const sellFill = resolveExitSellFill(quote)
      if (!sellFill.fillable || sellFill.price == null) {
        await recordPaperExecutionEvent(env, {
          tradeDate: intradayToday,
          symbol: pos.symbol,
          side: 'sell',
          eventType: 'paper_order',
          status: 'skipped',
          reason: 'intraday_tp1_unfillable',
          detail: { shares: sellShares, exit_reason: decision.reason, ...sellFill.detail },
          source: 'intraday_tp1',
        })
        continue
      }
      const fillPrice = sellFill.price
      const txValue = fillPrice * sellShares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
      const proceeds = txValue - commission - tax
      const remainingShares = pos.shares - sellShares
      const entryPx = pos.entry_price ?? pos.avg_cost
      const sellNote = buildSellOrderNote({
        reason: `[intraday] ${decision.reason}`,
        entry_date: pos.entry_date,
      }, { entryPrice: entryPx, exitPrice: fillPrice, shares: sellShares, commission, tax })

      await env.DB.batch([
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
        `).bind(
          ACCOUNT_ID,
          pos.symbol,
          pos.name,
          sellShares,
          fillPrice,
          commission,
          tax,
          proceeds,
          null,
          sellNote,
        ),
      ])
      const orderId = await recordSellSettlement(env.DB, env.KV, ACCOUNT_ID, pos.symbol, proceeds)
      await recordPaperExecutionEvent(env, {
        tradeDate: intradayToday,
        symbol: pos.symbol,
        side: 'sell',
        eventType: 'paper_order',
        status: 'filled',
        reason: 'intraday_tp1',
        detail: { shares: sellShares, remaining_shares: remainingShares, price: fillPrice, proceeds, exit_reason: decision.reason, ...sellFill.detail },
        orderId,
        source: 'intraday_tp1',
      })
      await recordExitLearningOutcome({
        env,
        tradeDate: intradayToday,
        pos,
        entryPrice: entryPx,
        exitPrice: fillPrice,
        shares: sellShares,
        exitReason: decision.reason,
        exitSource: 'intraday_tp1',
        orderId,
      })
      console.log(`[Intraday] TP1 ${pos.symbol} ${sellShares} 股 @ ${fillPrice} | ${decision.reason}`)
      const tp1IntradayPnl = calcRealizedPnlSnapshot({ entryPrice: entryPx, exitPrice: fillPrice, shares: sellShares, commission, tax }).realized_pnl_pct / 100
      void sendDiscordNotification(
        env.DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, sellShares, fillPrice, `盤中 TP1，剩餘 ${remainingShares} 股`, tp1IntradayPnl),
      )
    } else if (decision.action === 'hold' && (decision.newTrailingStop || decision.newHighest)) {
      await env.DB.prepare(`
        UPDATE paper_positions SET trailing_stop=?, highest_since_entry=?, updated_at=datetime('now')
        WHERE account_id=? AND symbol=?
      `).bind(
        decision.newTrailingStop ?? pos.trailing_stop,
        decision.newHighest ?? pos.highest_since_entry,
        ACCOUNT_ID,
        pos.symbol,
      ).run()
    }
  }

  console.log(`[Intraday] checked ${positions.length} positions with ${quoteMap.size} quotes`)
}
