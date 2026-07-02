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
import { putIntradayPrice } from './paperIntradayPriceCache'
import { recordPaperExecutionEvent } from './paperExecutionEvents'
import { buildStockVisionSellOrderIntent } from './stockvisionOrderIntent'
import { checkCircuitBreakers } from './pendingBuyOrchestrator'
import {
  assessS12IntradayStructureFromBaseBars,
  resolveS12PositionDecision,
  s12TimingPolicyFromEnv,
  type S12IntradayAssessment,
  type S12UnifiedDecision,
} from './s12IntradayStructure'
import { loadS12IntradayBaseBars } from './s12RuntimeBars'
import {
  getCurrentRegime as getCurrentSltpRegime,
  getTradingConfig,
  resolveSltpForRegime,
  type TradingConfig,
} from './tradingConfig'

const ACCOUNT_ID = 1
const S12_HOLDING_DEFENSE_EVENT_MIN_INTERVAL_MS = 10 * 60_000

type S12HoldingDefenseEventAction =
  | 'observe'
  | 'tighten_stop'
  | 'take_profit_or_tighten_stop'
  | 'trim_or_take_profit'
  | 'take_profit'
  | 'full_exit'
  | 'quote_unavailable'

function enabledFlag(value: unknown, fallback = false): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  return fallback
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function positiveNumber(value: unknown): number | null {
  const n = finiteNumber(value)
  return n != null && n > 0 ? n : null
}

export function resolveS12HoldingDefenseEventAction(reason: string | null | undefined): S12HoldingDefenseEventAction {
  const text = String(reason ?? '')
  if (text.includes('take_profit_or_tighten_stop') || text.includes('TAKE_PROFIT_OR_TIGHTEN_STOP')) return 'take_profit_or_tighten_stop'
  if (text.includes('trim_or_take_profit') || text.includes('TRIM_OR_TAKE_PROFIT')) return 'trim_or_take_profit'
  if (text.includes('quote_unavailable')) return 'quote_unavailable'
  if (text.includes('full_exit') || text.includes('reverse_bos')) return 'full_exit'
  if (text.includes('take_profit') || text.includes('tp1') || text.includes('tp2')) return 'take_profit'
  if (text.includes('TIGHTEN_STOP')) return 'tighten_stop'
  if (text.includes('tighten_stop')) return 'tighten_stop'
  return 'observe'
}

function parseTimeMs(value: unknown): number | null {
  if (!value) return null
  const parsed = new Date(String(value).includes('T') ? String(value) : String(value).replace(' ', 'T')).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function buildPaperSellOrderIntent(params: {
  tradeDate: string
  symbol: string
  shares: number
  fillPrice: number
  quote: IntradayOHLC
  reason: string
  strategyType: string
}) {
  return buildStockVisionSellOrderIntent({
    accountId: ACCOUNT_ID,
    tradeDate: params.tradeDate,
    symbol: params.symbol,
    limitPrice: params.fillPrice,
    currentPrice: params.quote.last,
    shares: params.shares,
    reason: params.reason,
    strategyType: params.strategyType,
    quote: {
      bestBid: params.quote.bid ?? null,
      bestAsk: params.quote.ask ?? null,
      source: params.quote.source ?? null,
      quoteAgeMs: null,
    },
  })
}

async function persistExitPositionUpdate(
  env: Pick<Bindings, 'DB'>,
  tradeDate: string,
  pos: any,
  decision: ExitDecision,
  source: string,
): Promise<void> {
  const nextTrailingStop = decision.newTrailingStop ?? pos.trailing_stop
  const nextHighest = decision.newHighest ?? pos.highest_since_entry
  const nextTp2 = decision.newTp2Price ?? pos.tp2_price
  const changed =
    nextTrailingStop !== pos.trailing_stop ||
    nextHighest !== pos.highest_since_entry ||
    nextTp2 !== pos.tp2_price

  if (!changed) return

  await env.DB.prepare(`
    UPDATE paper_positions
    SET trailing_stop=?, highest_since_entry=?, tp2_price=?, updated_at=datetime('now')
    WHERE account_id=? AND symbol=?
  `).bind(
    nextTrailingStop,
    nextHighest,
    nextTp2,
    ACCOUNT_ID,
    pos.symbol,
  ).run()

  await recordPaperExecutionEvent(env, {
    tradeDate,
    symbol: pos.symbol,
    side: null,
    eventType: 'paper_position_update',
    status: 'updated',
    reason: decision.reason,
    detail: {
      previous_trailing_stop: pos.trailing_stop ?? null,
      new_trailing_stop: nextTrailingStop ?? null,
      previous_highest_since_entry: pos.highest_since_entry ?? null,
      new_highest_since_entry: nextHighest ?? null,
      previous_tp2_price: pos.tp2_price ?? null,
      new_tp2_price: nextTp2 ?? null,
    },
    source,
  })
}

function resolveExitSellFill(
  quote: IntradayOHLC,
  options: { allowLastPriceFallback?: boolean } = {},
): { fillable: boolean; price?: number; reason: string; detail: Record<string, unknown> } {
  const fill = resolveMarketSellFill({
    currentPrice: quote.last,
    bestBid: quote.bid,
    bestAsk: quote.ask,
    intradayLow: quote.low,
    intradayHigh: quote.high,
    slippageTicks: 1,
    requireBestBid: !options.allowLastPriceFallback,
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

export function resolveS12HoldingDefenseUpdate(params: {
  pos: {
    shares?: number | null
    original_shares?: number | null
    avg_cost: number
    entry_price: number | null
    initial_stop: number | null
    trailing_stop: number | null
    highest_since_entry: number | null
    tp1_price?: number | null
    tp2_price?: number | null
    tp1_hit: number
  }
  currentPrice: number
  atr14: number
  assessment: S12IntradayAssessment | null
  executableBookAvailable?: boolean
  tp1SellRatio?: number | null
}): ExitDecision | null {
  const s12Decision = resolveS12PositionDecision({
    assessment: params.assessment,
    currentPrice: params.currentPrice,
    executableBookAvailable: params.executableBookAvailable ?? true,
    atr14: params.atr14,
    tp1SellRatio: params.tp1SellRatio,
    pos: params.pos,
  })
  return s12PositionDecisionToExitDecision(s12Decision, params.pos, params.currentPrice)
}

function s12PositionDecisionToExitDecision(
  decision: S12UnifiedDecision,
  pos: { shares?: number | null; highest_since_entry?: number | null },
  currentPrice: number,
): ExitDecision | null {
  const shares = Math.floor(positiveNumber(pos.shares) ?? 0)
  const highest = Math.max(positiveNumber(pos.highest_since_entry) ?? currentPrice, currentPrice)
  if (decision.action === 'TAKE_PROFIT') {
    const sellShares = Math.min(shares, Math.floor(positiveNumber(decision.sellShares) ?? shares))
    if (sellShares > 0 && sellShares < shares) {
      return {
        action: 'partial_sell',
        reason: `S12 ${decision.reason} @ ${currentPrice.toFixed(2)}`,
        sellShares,
        moveStopToEntry: true,
        newHighest: highest,
      }
    }
    if (shares > 0) {
      return {
        action: 'full_sell',
        reason: `S12 ${decision.reason} @ ${currentPrice.toFixed(2)}`,
        newHighest: highest,
      }
    }
  }
  if (decision.action === 'EXIT_ON_REVERSE_BOS') {
    return {
      action: 'full_sell',
      reason: `S12 ${decision.reason} @ ${currentPrice.toFixed(2)}`,
      newHighest: highest,
    }
  }
  if (decision.action === 'TIGHTEN_STOP' && decision.stopPrice != null) {
    return {
      action: 'hold',
      reason: `S12 ${decision.reason} @ ${Number(decision.stopPrice).toFixed(2)}`,
      newTrailingStop: Number(decision.stopPrice),
      newHighest: highest,
    }
  }
  return null
}

function mergeHoldExitUpdates(base: ExitDecision, overlay: ExitDecision | null): ExitDecision {
  if (!overlay) return base
  return {
    ...base,
    reason: base.reason === 'no trigger' ? overlay.reason : `${base.reason}; ${overlay.reason}`,
    newTrailingStop: Math.max(
      positiveNumber(base.newTrailingStop) ?? Number.NEGATIVE_INFINITY,
      positiveNumber(overlay.newTrailingStop) ?? Number.NEGATIVE_INFINITY,
      0,
    ) || undefined,
    newHighest: Math.max(
      positiveNumber(base.newHighest) ?? Number.NEGATIVE_INFINITY,
      positiveNumber(overlay.newHighest) ?? Number.NEGATIVE_INFINITY,
      0,
    ) || undefined,
    newTp2Price: base.newTp2Price,
  }
}

function resolveS12PrimaryExitDecision(s12Decision: ExitDecision | null, fallbackDecision: ExitDecision): ExitDecision {
  if (s12Decision?.action && s12Decision.action !== 'hold') return s12Decision
  if (fallbackDecision.action !== 'hold') return fallbackDecision
  return mergeHoldExitUpdates(fallbackDecision, s12Decision)
}

export function shouldRecordS12HoldingDefenseEvent(params: {
  latest: { status?: unknown; reason?: unknown; detail_json?: unknown; created_at?: unknown } | null
  nextStatus: string
  nextReason: string
  nextActive: boolean
  nextTrailingAfter: number | null
  nowMs: number
  minIntervalMs?: number
}): boolean {
  const latest = params.latest
  if (!latest) return true

  const createdAtMs = parseTimeMs(latest.created_at)
  if (createdAtMs == null) return true
  if (params.nowMs - createdAtMs >= (params.minIntervalMs ?? S12_HOLDING_DEFENSE_EVENT_MIN_INTERVAL_MS)) return true

  let latestDetail: any = null
  try {
    latestDetail = latest.detail_json ? JSON.parse(String(latest.detail_json)) : null
  } catch {
    latestDetail = null
  }

  const latestActive = Boolean(latestDetail?.holding_defense?.active)
  const latestTrailingAfter = positiveNumber(latestDetail?.holding_defense?.trailing_stop_after)
  if (String(latest.status ?? '') !== params.nextStatus) return true
  if (String(latest.reason ?? '') !== params.nextReason) return true
  if (latestActive !== params.nextActive) return true
  if (
    params.nextActive &&
    params.nextTrailingAfter != null &&
    (latestTrailingAfter == null || Math.abs(latestTrailingAfter - params.nextTrailingAfter) >= 0.01)
  ) return true

  return false
}

async function evaluateS12HoldingDefense(
  env: Bindings,
  tradeDate: string,
  pos: any,
  quote: IntradayOHLC,
  atr14: number,
  cfg: TradingConfig,
): Promise<ExitDecision | null> {
  if (!enabledFlag((env as any).S12_INTRADAY_HOLDING_DEFENSE_ENABLED, true)) return null
  try {
    const s12Base = await loadS12IntradayBaseBars(
      env,
      pos.symbol,
      tradeDate,
      quote.last,
      Number(quote.totalVolume ?? 0),
    )
    const assessment = assessS12IntradayStructureFromBaseBars({
      symbol: pos.symbol,
      baseBars: s12Base.bars,
      fallback4hBars: s12Base.fallback4hBars,
      fallback1hBars: s12Base.fallback1hBars,
      nowMs: Date.now(),
      policy: s12TimingPolicyFromEnv(env as any),
      barDiagnostics: s12Base.diagnostics,
      h4ReferenceDate: s12Base.diagnostics.previous_4h_reference_date,
      h4ReferenceClose: s12Base.diagnostics.previous_4h_reference_close,
    })
    const executableBookAvailable = positiveNumber(quote.bid) != null && positiveNumber(quote.ask) != null
    const s12Decision = resolveS12PositionDecision({
      assessment,
      currentPrice: quote.last,
      executableBookAvailable,
      atr14,
      tp1SellRatio: cfg.exit.tp1SellRatio,
      pos,
    })
    const update = resolveS12HoldingDefenseUpdate({
      pos,
      currentPrice: quote.last,
      atr14,
      assessment,
      executableBookAvailable,
      tp1SellRatio: cfg.exit.tp1SellRatio,
    })
    const eventReason = update?.reason ?? (s12Decision.action === 'QUOTE_UNAVAILABLE' ? s12Decision.reason : assessment.reason)
    const holdingDefenseAction = resolveS12HoldingDefenseEventAction(update?.reason ?? s12Decision.reason)
    const eventDetail = {
      ...assessment,
      holding_defense: {
        active: update != null || s12Decision.action === 'QUOTE_UNAVAILABLE',
        trailing_stop_before: pos.trailing_stop ?? null,
        trailing_stop_after: update?.newTrailingStop ?? null,
        action: holdingDefenseAction,
        decision_action: s12Decision.action,
        decision_reason: s12Decision.reason,
        decision_detail: s12Decision.detail,
        advisory_only: false,
        no_short_order: true,
        executable_book_available: executableBookAvailable,
        position_exit_policy: 's12_primary_independent_of_long_entry_readiness',
        execution_owner: 's12_position_decision_v1',
        fallback_exit_owner: 'paper_sltp_atr_trailing_v1',
        bar_source: s12Base.source,
        bar_diagnostics: s12Base.diagnostics,
      },
    }
    const latestEvent = await env.DB.prepare(`
      SELECT status, reason, detail_json, created_at
        FROM paper_execution_events
       WHERE account_id = ?
         AND trade_date = ?
         AND symbol = ?
         AND event_type = 's12_intraday_structure'
         AND source = 's12_holding_defense'
       ORDER BY id DESC
       LIMIT 1
    `).bind(ACCOUNT_ID, tradeDate, pos.symbol).first<any>()
    if (shouldRecordS12HoldingDefenseEvent({
      latest: latestEvent ?? null,
      nextStatus: assessment.state,
      nextReason: eventReason,
      nextActive: update != null || s12Decision.action === 'QUOTE_UNAVAILABLE',
      nextTrailingAfter: update?.newTrailingStop ?? null,
      nowMs: Date.now(),
    })) {
      await recordPaperExecutionEvent(env, {
        tradeDate,
        symbol: pos.symbol,
        side: null,
        eventType: 's12_intraday_structure',
        status: assessment.state,
        reason: eventReason,
        detail: eventDetail,
        source: 's12_holding_defense',
      })
    }
    return update
  } catch (error) {
    await recordPaperExecutionEvent(env, {
      tradeDate,
      symbol: pos.symbol,
      side: null,
      eventType: 's12_intraday_structure',
      status: 'error',
      reason: 's12_holding_defense_unavailable',
      detail: { error: error instanceof Error ? error.message : String(error) },
      source: 's12_holding_defense',
    })
    return null
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

    let decision = checkExitConditions(
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
    const sellOrderIntent = buildPaperSellOrderIntent({
      tradeDate: today,
      symbol: pos.symbol,
      shares,
      fillPrice,
      quote,
      reason: decision.reason,
      strategyType: 'daytrade_force_close',
    })
    const txValue = fillPrice * shares
    const commission = calcCommission(txValue, cfg)
    const tax = calcTax(txValue, cfg, true)
    const proceeds = txValue - commission - tax
    const entryPrice = pos.entry_price ?? pos.avg_cost
    const sellNote = buildSellOrderNote({
      reason: `[13:25 daytrade force close] ${decision.reason}`,
      entry_date: pos.entry_date,
      order_intent: sellOrderIntent,
      order_legs: sellOrderIntent.orderLegs,
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
      detail: { shares, order_intent: sellOrderIntent, order_legs: sellOrderIntent.orderLegs, price: fillPrice, proceeds, exit_reason: decision.reason, ...sellFill.detail },
      orderId,
      source: 'daytrade_force_close',
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

  for (const pos of exitPositions) {
    const quote = exitQuoteMap.get(pos.symbol)
    if (!quote) continue
    const currentPrice = quote.last

    const atr14 = exitAtrMap.get(pos.symbol) ?? currentPrice * cfg.exit.fallbackAtrPct
    const s12ExitDecision = await evaluateS12HoldingDefense(
      env,
      eodToday,
      pos,
      quote,
      atr14,
      cfg,
    )
    const fallbackDecision = checkExitConditions(
      pos,
      currentPrice,
      atr14,
      sellRecMap.has(pos.symbol),
      true,
      cfg,
      resolveSltpForRegime(cfg, await getCurrentSltpRegime(env.KV)),
      eodRegime ?? undefined,
    )
    let decision = resolveS12PrimaryExitDecision(s12ExitDecision, fallbackDecision)
    if (eodRegime) logRegimeShadow('runEODExit', pos.symbol, eodRegime, decision.action, decision.reason, env.DB)

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
      const sellOrderIntent = buildPaperSellOrderIntent({
        tradeDate: eodToday,
        symbol: pos.symbol,
        shares,
        fillPrice,
        quote,
        reason: decision.reason,
        strategyType: 'eod_exit',
      })
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
        order_intent: sellOrderIntent,
        order_legs: sellOrderIntent.orderLegs,
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
        detail: { shares, order_intent: sellOrderIntent, order_legs: sellOrderIntent.orderLegs, price: fillPrice, proceeds, exit_reason: decision.reason, ...sellFill.detail },
        orderId,
        source: 'eod_exit',
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
      const sellOrderIntent = buildPaperSellOrderIntent({
        tradeDate: eodToday,
        symbol: pos.symbol,
        shares: sellShares,
        fillPrice,
        quote,
        reason: decision.reason,
        strategyType: 'eod_tp1',
      })
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
        order_intent: sellOrderIntent,
        order_legs: sellOrderIntent.orderLegs,
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
        detail: { shares: sellShares, order_intent: sellOrderIntent, order_legs: sellOrderIntent.orderLegs, remaining_shares: remainingShares, price: fillPrice, proceeds, exit_reason: decision.reason, ...sellFill.detail },
        orderId,
        source: 'eod_tp1',
      })
      const tp1Pnl = (fillPrice - entryPx) / entryPx
      console.log(`[EODExit] TP1 ${pos.symbol} ${sellShares} @ ${fillPrice}`)
      void sendDiscordNotification(
        (env as any).DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, sellShares, fillPrice, `TP1 已觸發，剩餘 ${remainingShares} 股`, tp1Pnl),
      )
    } else if (decision.action === 'hold') {
      await persistExitPositionUpdate(env, eodToday, pos, decision, 'eod_exit_hold_update')
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
    [...quoteMap].map(([symbol, quote]) => putIntradayPrice(env.KV, symbol, quote.last)),
  )

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
    for (const r of prevRows ?? []) {
      if (!prevCloseMapSell.has(r.symbol)) prevCloseMapSell.set(r.symbol, r.close)
    }
  }

  for (const pos of positions) {
    const quote = quoteMap.get(pos.symbol)
    if (!quote) continue
    const currentPrice = quote.last

    const atr14 = atrMap.get(pos.symbol) ?? currentPrice * cfg.exit.fallbackAtrPct
    const s12ExitDecision = await evaluateS12HoldingDefense(
      env,
      intradayToday,
      pos,
      quote,
      atr14,
      cfg,
    )
    const fallbackDecision = checkExitConditions(
      pos,
      currentPrice,
      atr14,
      false,
      false,
      cfg,
      resolveSltpForRegime(cfg, await getCurrentSltpRegime(env.KV)),
      intraRegime ?? undefined,
    )
    let decision = resolveS12PrimaryExitDecision(s12ExitDecision, fallbackDecision)
    if (intraRegime) logRegimeShadow('pollIntradayStopLoss', pos.symbol, intraRegime, decision.action, decision.reason, env.DB)

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
      const sellOrderIntent = buildPaperSellOrderIntent({
        tradeDate: intradayToday,
        symbol: pos.symbol,
        shares,
        fillPrice: sellFillPrice,
        quote,
        reason: decision.reason,
        strategyType: 'intraday_exit',
      })
      const txValue = sellFillPrice * shares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
      const proceeds = txValue - commission - tax
      const entryPx = pos.entry_price ?? pos.avg_cost
      const sellNote = buildSellOrderNote({
        reason: `[intraday] ${decision.reason} (mkt=${currentPrice}, -1 tick fill)`,
        entry_date: pos.entry_date,
        order_intent: sellOrderIntent,
        order_legs: sellOrderIntent.orderLegs,
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
        detail: { shares, order_intent: sellOrderIntent, order_legs: sellOrderIntent.orderLegs, fill_price: sellFillPrice, market_price: currentPrice, proceeds, exit_reason: decision.reason, ...sellFill.detail },
        orderId,
        source: 'intraday_exit',
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
      const sellOrderIntent = buildPaperSellOrderIntent({
        tradeDate: intradayToday,
        symbol: pos.symbol,
        shares: sellShares,
        fillPrice,
        quote,
        reason: decision.reason,
        strategyType: 'intraday_tp1',
      })
      const txValue = fillPrice * sellShares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
      const proceeds = txValue - commission - tax
      const remainingShares = pos.shares - sellShares
      const entryPx = pos.entry_price ?? pos.avg_cost
      const sellNote = buildSellOrderNote({
        reason: `[intraday] ${decision.reason}`,
        entry_date: pos.entry_date,
        order_intent: sellOrderIntent,
        order_legs: sellOrderIntent.orderLegs,
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
        detail: { shares: sellShares, order_intent: sellOrderIntent, order_legs: sellOrderIntent.orderLegs, remaining_shares: remainingShares, price: fillPrice, proceeds, exit_reason: decision.reason, ...sellFill.detail },
        orderId,
        source: 'intraday_tp1',
      })
      console.log(`[Intraday] TP1 ${pos.symbol} ${sellShares} 股 @ ${fillPrice} | ${decision.reason}`)
      const tp1IntradayPnl = calcRealizedPnlSnapshot({ entryPrice: entryPx, exitPrice: fillPrice, shares: sellShares, commission, tax }).realized_pnl_pct / 100
      void sendDiscordNotification(
        env.DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, sellShares, fillPrice, `盤中 TP1，剩餘 ${remainingShares} 股`, tp1IntradayPnl),
      )
    } else if (decision.action === 'hold') {
      await persistExitPositionUpdate(env, intradayToday, pos, decision, 'intraday_exit_hold_update')
    }
  }

  console.log(`[Intraday] checked ${positions.length} positions with ${quoteMap.size} quotes`)
}
