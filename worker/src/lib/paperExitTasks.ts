import type { Bindings } from '../types'
import { formatTradeNotification, sendDiscordNotification } from './notify'
import { checkExitConditions } from './paperExitPolicy'
import { batchGetIntradayPrices } from './paperIntradayData'
import {
  batchGetATR,
  getCurrentRegime,
  getPrevTradingDay,
  isDayTradeAllowed,
  logRegimeShadow,
  recordSellSettlement,
} from './paperMarketData'
import { applySlippage, calcCommission, calcTax } from './paperTradeMath'
import { checkCircuitBreakers } from './pendingBuyOrchestrator'
import { getTradingConfig, type TradingConfig } from './tradingConfig'

const ACCOUNT_ID = 1

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
  const priceMap = await batchGetIntradayPrices(symbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
  })
  const atrMap = await batchGetATR(env.DB, symbols)
  const regime = await getCurrentRegime(env.KV)

  for (const pos of sameDayPos) {
    const price = priceMap.get(pos.symbol)
    if (!price) continue
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
      (await import('./tradingConfig')).resolveSltpForRegime(cfg, await env.KV.get('ml:regime')),
      regime ?? undefined,
    )
    if (regime) logRegimeShadow('forceDayTradeClose', pos.symbol, regime, decision.action, decision.reason, env.DB)
    if (decision.action === 'hold') continue

    const dtCheck = await isDayTradeAllowed(pos.symbol, pos.shares, decision.reason, env.KV)
    if (!dtCheck.allowed) continue

    const shares = pos.shares
    const txValue = price * shares
    const commission = calcCommission(txValue, cfg)
    const tax = calcTax(txValue, cfg, true)
    const proceeds = txValue - commission - tax

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
        price,
        commission,
        tax,
        proceeds,
        null,
        JSON.stringify({
          reason: `[13:25 daytrade force close] ${decision.reason}`,
          entry_price: pos.entry_price ?? pos.avg_cost,
          entry_date: pos.entry_date,
        }),
      ),
    ])
    await recordSellSettlement(env.DB, env.KV, ACCOUNT_ID, pos.symbol, proceeds)
    const pnl = (price - (pos.entry_price ?? pos.avg_cost)) / (pos.entry_price ?? pos.avg_cost)
    console.log(`[DayTrade] 13:25 force close ${pos.symbol} ${shares} @ ${price} ${(pnl * 100).toFixed(1)}%`)
    void sendDiscordNotification(
      (env as any).DISCORD_WEBHOOK_URL,
      formatTradeNotification('sell', pos.symbol, pos.name, shares, price, `13:25 daytrade force close: ${decision.reason}`, pnl),
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
  const exitPriceMap = await batchGetIntradayPrices(exitSymbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
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
    const currentPrice = exitPriceMap.get(pos.symbol)
    if (!currentPrice) continue

    const atr14 = exitAtrMap.get(pos.symbol) ?? currentPrice * cfg.exit.fallbackAtrPct
    const decision = checkExitConditions(
      pos,
      currentPrice,
      atr14,
      sellRecMap.has(pos.symbol),
      true,
      cfg,
      (await import('./tradingConfig')).resolveSltpForRegime(cfg, await env.KV.get('ml:regime')),
      eodRegime ?? undefined,
    )
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
      const txValue = currentPrice * shares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
      const proceeds = txValue - commission - tax

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
          currentPrice,
          commission,
          tax,
          proceeds,
          sellRecMap.get(pos.symbol)?.signal ?? 'EXIT',
          sellRecMap.get(pos.symbol)?.confidence ?? null,
          JSON.stringify({
            reason: decision.reason,
            entry_price: pos.entry_price,
            entry_date: pos.entry_date,
            days_held: pos.entry_date ? Math.round((Date.now() - new Date(pos.entry_date).getTime()) / 86400000) : null,
          }),
        ),
      ])
      await recordSellSettlement(env.DB, env.KV, ACCOUNT_ID, pos.symbol, proceeds)
      const entryPx = pos.entry_price ?? pos.avg_cost
      const exitPnl = (currentPrice - entryPx) / entryPx
      const daysHeld = pos.entry_date ? Math.round((Date.now() - new Date(pos.entry_date).getTime()) / 86400000) : 0
      console.log(`[EODExit] full sell ${pos.symbol} ${shares} @ ${currentPrice} entry=${entryPx} days=${daysHeld} pnl=${(exitPnl * 100).toFixed(1)}% ${decision.reason}`)
      void sendDiscordNotification(
        (env as any).DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, shares, currentPrice, `${decision.reason} | entry=${entryPx} held=${daysHeld}d`, exitPnl),
      )
      await runPostExitDiscipline(env, cfg, pos.symbol, decision.reason, 'full_sell', 'EODExit')
    } else if (decision.action === 'partial_sell' && decision.sellShares) {
      const sellShares = decision.sellShares
      const txValue = currentPrice * sellShares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
      const proceeds = txValue - commission - tax
      const remainingShares = pos.shares - sellShares

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
        `).bind(ACCOUNT_ID, pos.symbol, pos.name, sellShares, currentPrice, commission, tax, proceeds, null, decision.reason),
      ])
      await recordSellSettlement(env.DB, env.KV, ACCOUNT_ID, pos.symbol, proceeds)
      const tp1Pnl = (currentPrice - (pos.entry_price ?? pos.avg_cost)) / (pos.entry_price ?? pos.avg_cost)
      console.log(`[EODExit] TP1 ${pos.symbol} ${sellShares} @ ${currentPrice}`)
      void sendDiscordNotification(
        (env as any).DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, sellShares, currentPrice, `TP1 已觸發，剩餘 ${remainingShares} 股`, tp1Pnl),
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
  const priceMap = await batchGetIntradayPrices(symbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
  })
  const atrMap = await batchGetATR(env.DB, symbols)
  const intraRegime = await getCurrentRegime(env.KV)

  if (priceMap.size === 0) {
    console.log('[Intraday] no intraday prices available')
    return
  }

  await Promise.allSettled(
    [...priceMap].map(([symbol, price]) => env.KV.put(`intraday:price:${symbol}`, String(price), { expirationTtl: 600 })),
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
    const currentPrice = priceMap.get(pos.symbol)
    if (!currentPrice) continue

    const atr14 = atrMap.get(pos.symbol) ?? currentPrice * cfg.exit.fallbackAtrPct
    const decision = checkExitConditions(
      pos,
      currentPrice,
      atr14,
      false,
      false,
      cfg,
      (await import('./tradingConfig')).resolveSltpForRegime(cfg, await env.KV.get('ml:regime')),
      intraRegime ?? undefined,
    )
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
      const sellFillPrice = applySlippage(currentPrice, 'sell', 1)
      const txValue = sellFillPrice * shares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
      const proceeds = txValue - commission - tax

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
          JSON.stringify({
            reason: `[intraday] ${decision.reason} (mkt=${currentPrice}, -1 tick fill)`,
            entry_price: pos.entry_price ?? pos.avg_cost,
            entry_date: pos.entry_date,
          }),
        ),
      ])
      await recordSellSettlement(env.DB, env.KV, ACCOUNT_ID, pos.symbol, proceeds)
      console.warn(`[Intraday] full sell ${pos.symbol} ${shares} @ ${sellFillPrice} (mkt ${currentPrice}) ${decision.reason}`)
      const intradayPnl = (sellFillPrice - (pos.entry_price ?? pos.avg_cost)) / (pos.entry_price ?? pos.avg_cost)
      void sendDiscordNotification(
        env.DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, shares, currentPrice, `盤中賣出: ${decision.reason}`, intradayPnl),
      )
      await runPostExitDiscipline(env, cfg, pos.symbol, decision.reason, 'full_sell', 'Intraday')
    } else if (decision.action === 'partial_sell' && decision.sellShares) {
      const sellShares = decision.sellShares
      const txValue = currentPrice * sellShares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
      const proceeds = txValue - commission - tax
      const remainingShares = pos.shares - sellShares

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
          currentPrice,
          commission,
          tax,
          proceeds,
          null,
          JSON.stringify({
            reason: `[intraday] ${decision.reason}`,
            entry_price: pos.entry_price ?? pos.avg_cost,
            entry_date: pos.entry_date,
          }),
        ),
      ])
      await recordSellSettlement(env.DB, env.KV, ACCOUNT_ID, pos.symbol, proceeds)
      console.log(`[Intraday] TP1 ${pos.symbol} ${sellShares} 股 @ ${currentPrice} | ${decision.reason}`)
      const tp1IntradayPnl = (currentPrice - (pos.entry_price ?? pos.avg_cost)) / (pos.entry_price ?? pos.avg_cost)
      void sendDiscordNotification(
        env.DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, sellShares, currentPrice, `盤中 TP1，剩餘 ${remainingShares} 股`, tp1IntradayPnl),
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

  console.log(`[Intraday] checked ${positions.length} positions with ${priceMap.size} quotes`)
}
