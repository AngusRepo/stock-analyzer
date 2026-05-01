import { sendDiscordNotification } from './notify'
import { getTradingConfig } from './tradingConfig'
import { batchGetIntradayOHLC, batchGetIntradayPrices } from './paperIntradayData'
import {
  batchGetATR,
  getCurrentRegime,
  isDayTradeAllowed,
  logRegimeShadow,
  recordSellSettlement,
} from './paperMarketData'
import { calcCommission, calcTax, resolveLimitBuyFill } from './paperTradeMath'
import { buildSellOrderNote } from './paperOrderAccounting'
import { forceDayTradeClose, pollIntradayStopLoss } from './paperExitTasks'
import {
  loadPendingBuySnapshot,
  markPendingBuyExecutionEvents,
  persistPendingBuyActiveState,
  type PendingBuy,
} from './pendingBuyStore'
import type { PendingBuyExecutionEvent, PendingBuyTerminalExecutionStatus } from './pendingBuyExecutionState'
import { checkCircuitBreakers, reconcilePendingBuyDebates } from './pendingBuyOrchestrator'
import { acquirePaperBuyIntent, completePaperBuyIntent } from './paperOrderIntent'
import { evaluatePreTradeExecution, type PreTradeMomentumContext } from './preTradeExecutionPolicy'
import { getTwClockParts, isTwIntradayTradingMinute } from './twMarketSession'
import { appendPendingBuyExecutionNote } from './pendingBuyExecutionState'
import { formatExecutionStatusEvent } from './executionEvent'
import { recordPaperExecutionEvent } from './paperExecutionEvents'
import { shouldFailClosedPendingDebate } from './pendingDebateSla'
import { computeProjectedVolumeRatio } from './preTradeMomentum'
import { computePaperTotalValue, getUnsettledSettlementSummary } from './paperAccountValue'
import type { Bindings } from '../types'

const ACCOUNT_ID = 1

async function loadPreTradeMomentum(
  env: Bindings,
  cfg: Awaited<ReturnType<typeof getTradingConfig>>,
  symbol: string,
  price: number,
): Promise<PreTradeMomentumContext> {
  const proxyUrl = (env as any).SHIOAJI_PROXY_URL as string | undefined
  if (!proxyUrl) return { error: 'no_shioaji_proxy' }

  try {
    const auth = { Authorization: `Bearer ${(env as any).PROXY_SERVICE_TOKEN ?? ''}` }
    const snapRes = await fetch(`${proxyUrl}/snapshot/${symbol}`, {
      headers: auth,
      signal: AbortSignal.timeout(5000),
    })
    const snapData = snapRes.ok ? ((await snapRes.json()) as any)?.data : null
    if (!snapData) return { error: `snapshot_http_${snapRes.status}` }

    const trendRes = await fetch(`${proxyUrl}/trend/${symbol}?minutes=5`, {
      headers: auth,
      signal: AbortSignal.timeout(5000),
    })
    const trendData = trendRes.ok ? ((await trendRes.json()) as any) : null

    const avgVolumeLookbackDays = Math.max(1, Math.floor(Number(cfg.momentum?.avgVolumeLookbackDays ?? 20)))
    const avgVolRow = await env.DB.prepare(
      `SELECT AVG(volume) as avg_vol
         FROM (
           SELECT sp.volume
             FROM stock_prices sp
             JOIN stocks s ON s.id=sp.stock_id
            WHERE s.symbol=?
            ORDER BY sp.date DESC
            LIMIT ?
         )`,
    ).bind(symbol, avgVolumeLookbackDays).first<any>()
    const avgVol = avgVolRow?.avg_vol ?? 0
    const twNow = new Date(Date.now() + 8 * 3600_000)
    const minutesSinceOpen = Math.max(1, twNow.getUTCHours() * 60 + twNow.getUTCMinutes() - 9 * 60)
    const tradingMin = cfg.momentum?.tradingDayMinutes ?? 270
    const minutesFloor = cfg.momentum?.minutesFractionFloor ?? 0.1
    const timePct = Math.max(minutesFloor, minutesSinceOpen / tradingMin)
    const volumeRatio = computeProjectedVolumeRatio({
      intradayTotalVolume: snapData.total_volume,
      avgDailyVolumeShares: avgVol,
      elapsedSessionFraction: timePct,
      intradayVolumeLotSize: cfg.momentum?.intradayVolumeLotSize ?? 1000,
    })
    const rangePosition = snapData.high > snapData.low
      ? (price - snapData.low) / (snapData.high - snapData.low)
      : null

    return {
      volumeRatio,
      minVolumeRatio: cfg.momentum?.minVolumeRatio ?? 0.8,
      slope5min: trendData?.slope_5min ?? null,
      rangePosition,
      minRangePosition: cfg.momentum?.minRangePosition ?? 0.3,
      error: trendData ? null : `trend_http_${trendRes.status}`,
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function hasFilledBuyToday(env: Bindings, symbol: string, today: string): Promise<boolean> {
  const existing = await env.DB.prepare(
    "SELECT id FROM paper_orders WHERE account_id=? AND symbol=? AND side='buy' AND created_at >= ? LIMIT 1",
  ).bind(ACCOUNT_ID, symbol, today).first<{ id: number }>()
  return Boolean(existing?.id)
}

export async function runIntradayCheck(env: Bindings): Promise<void> {
  const cfg = await getTradingConfig(env.KV)
  const { hour: twHour, minute: twMin } = getTwClockParts()
  const isMarketOpen = isTwIntradayTradingMinute()

  if (!isMarketOpen) return
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  await reconcilePendingBuyDebates(env, today).catch((e) =>
    console.warn('[Intraday] pending debate reconcile failed:', e),
  )

  const debateSnapshot = await loadPendingBuySnapshot(env, today, { allowFallbackRecent: false })
  const staleDebateItems = debateSnapshot.pendingBuys.filter((item) =>
    (item.debate_verdict ?? 'PENDING') === 'PENDING' || (item.debate_status ?? 'pending') === 'pending',
  )
  const pendingDebateSlaMinutes = Number((cfg.position as any).pendingDebateSlaMinutes ?? 10)
  if (staleDebateItems.length > 0 && shouldFailClosedPendingDebate(new Date(), pendingDebateSlaMinutes)) {
    await markPendingBuyExecutionEvents(
      env,
      today,
      debateSnapshot.pendingBuys,
      staleDebateItems.map((item) => ({ symbol: item.symbol, status: 'skipped', reason: 'debate_sla_expired' })),
      { stage: 'debate_sla', reason: 'debate_sla_expired', sla_minutes: pendingDebateSlaMinutes },
    )
  }

  await pollIntradayStopLoss(env)

  const riskRaw = await env.KV.get('market:risk_level')
  if (riskRaw && ['orange', 'red', 'black'].includes(riskRaw)) {
    await new Promise((r) => setTimeout(r, 30_000))
    await pollIntradayStopLoss(env)
  }

  if (twHour === 13 && twMin >= 25) {
    await forceDayTradeClose(env, cfg, today)

    const pendingSnapshot = await loadPendingBuySnapshot(env, today, { allowFallbackRecent: false })
    if (pendingSnapshot.pendingBuys.length > 0) {
      const pendingBuys = pendingSnapshot.pendingBuys
      const cancelled = pendingBuys.map((b) => b.symbol).join(', ')
      console.log(`[Intraday] 收盤前取消未成交掛單: ${cancelled}`)
      void sendDiscordNotification(
        (env as any).DISCORD_WEBHOOK_URL,
        `收盤前取消未成交掛單\n${pendingBuys.map((b) => `- ${b.symbol} ${b.name} @ $${b.ml_entry_price}`).join('\n')}`,
      )
      await markPendingBuyExecutionEvents(
        env,
        today,
        pendingBuys,
        pendingBuys.map((item) => ({ symbol: item.symbol, status: 'cancelled', reason: 'rod_cancelled' })),
        { stage: 'intraday_close', reason: 'rod_cancelled' },
      )
    }
    return
  }

  const pendingSnapshot = await loadPendingBuySnapshot(env, today, { allowFallbackRecent: false })
  let pendingBuys: PendingBuy[] = pendingSnapshot.pendingBuys
  if (pendingBuys.length === 0) return

  const pendingSymbols = pendingBuys.map((b) => b.symbol)
  const ohlcMap = await batchGetIntradayOHLC(pendingSymbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
    requireBrokerQuote: true,
  })
  const priceMap = new Map<string, number>()
  for (const [s, o] of ohlcMap) priceMap.set(s, o.last)

  const zeroPriceSymbols = pendingSymbols.filter((s) => !priceMap.has(s) || priceMap.get(s) === 0)
  if (zeroPriceSymbols.length > 0) {
    const errMsg = `Shioaji 報價異常: ${zeroPriceSymbols.join(',')}`
    console.error(`[Intraday] 錯誤 ${errMsg}`)
    await env.KV.put(
      `scheduler:run:intraday-error:${today}`,
      JSON.stringify({ error: errMsg, symbols: zeroPriceSymbols, timestamp: new Date().toISOString() }),
      { expirationTtl: 86400 },
    )
    if ((env as any).DISCORD_WEBHOOK_URL) {
      void sendDiscordNotification(
        (env as any).DISCORD_WEBHOOK_URL,
        `錯誤 **Shioaji 報價缺失** ${errMsg} (${zeroPriceSymbols.length}/${pendingSymbols.length} 檔)`,
      )
    }
  }
  if (priceMap.size === 0) return

  const acc = await env.DB.prepare('SELECT cash, initial_cash FROM paper_accounts WHERE id=?').bind(ACCOUNT_ID).first<any>()
  if (!acc) return
  const settledCash = Number(acc.cash ?? 0)
  const { getAvailableCash: getAvailCash } = await import('./dateUtils')
  const availableCash = await getAvailCash(env.DB, ACCOUNT_ID)
  ;(acc as any).cash = availableCash
  if (availableCash < cfg.position.minCashToTrade) return

  const { results: positions } = await env.DB.prepare(
    'SELECT symbol, shares FROM paper_positions WHERE account_id=? AND shares>0',
  ).bind(ACCOUNT_ID).all<any>()
  const posSymbols = (positions ?? []).map((p: any) => p.symbol)
  const posValueMap = await batchGetIntradayPrices(posSymbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
  })
  let positionValue = 0
  for (const pos of positions ?? []) {
    const p = posValueMap.get(pos.symbol) ?? 0
    positionValue += p * pos.shares
  }
  const settlement = await getUnsettledSettlementSummary(env.DB, ACCOUNT_ID)
  const totalPortfolio = computePaperTotalValue({
    settledCash,
    positionsValue: positionValue,
    netUnsettledSettlement: settlement.netUnsettledSettlement,
  })
  const currentPositionCount = (positions ?? []).length

  const maxPos = cfg.position.maxPositions ?? 5
  let dailySwaps = 0
  const maxSwaps = cfg.position.maxDailySwaps ?? 1

  if (currentPositionCount >= maxPos && pendingBuys.length > 0) {
    console.log(`[Intraday] Position cap ${currentPositionCount}/${maxPos} reached, evaluating replacements...`)

    const { results: fullPositions } = await env.DB.prepare(`
      SELECT symbol, name, shares, avg_cost, entry_date, entry_price,
             initial_stop, tp1_price, tp1_hit, highest_since_entry
      FROM paper_positions WHERE account_id=? AND shares>0
    `).bind(ACCOUNT_ID).all<any>()

    const weaknessScores: { symbol: string; score: number }[] = []
    for (const pos of fullPositions ?? []) {
      const px = posValueMap.get(pos.symbol) ?? pos.avg_cost
      const pnlPct = pos.avg_cost > 0 ? (px - pos.avg_cost) / pos.avg_cost : 0
      const daysHeld = pos.entry_date
        ? Math.floor((Date.now() + 8 * 3600_000 - new Date(pos.entry_date + 'T00:00:00+08:00').getTime()) / 86400_000)
        : 0
      const timeRatio = Math.min(1, daysHeld / (cfg.exit.timeStopDays ?? 20))

      const sw = cfg.position.swapWeights
      const tp1MissMult = (sw as any).tp1MissMultiplier ?? 0.5
      const tp1NotHitPen = (sw as any).tp1NotHitPenalty ?? 40
      const lossPen = (sw as any).lossPenalty ?? 20
      const pnlScore = Math.max(0, -pnlPct * 100)
      const timeScore = timeRatio * 100
      const score =
        pnlScore * sw.pnl +
        timeScore * sw.time +
        (1 - (pos.tp1_hit ? tp1MissMult : 0)) * tp1NotHitPen * sw.tp1 +
        (pnlPct < 0 ? lossPen : 0) * sw.loss
      weaknessScores.push({ symbol: pos.symbol, score })
    }
    weaknessScores.sort((a, b) => b.score - a.score)

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

      const newQuality = (pending.confidence ?? cfg.signal.buySignalScore) * 100
      const weaknessThreshold = 100 / swapThreshold
      if (weakest.score < weaknessThreshold || newQuality < 55) {
        console.log(`[Swap] ${weakest.symbol}(weakness=${weakest.score.toFixed(0)}) not weak enough (need>${weaknessThreshold.toFixed(0)}) or ${pending.symbol}(quality=${newQuality.toFixed(0)}) not strong enough, skip`)
        continue
      }

      const weakPx = posValueMap.get(weakest.symbol) ?? weakPos.avg_cost
      if (weakPos.tp1_price && weakPx >= weakPos.tp1_price * cfg.position.tp1ProximityRatio) {
        console.log(`[Swap] ${weakest.symbol} near TP1 (${weakPx}/${weakPos.tp1_price}), skip swap`)
        continue
      }

      const sellPrice = weakPx
      if (!sellPrice || sellPrice <= 0) {
        console.warn(`[Swap] ${weakest.symbol} has no valid price (${sellPrice}), skip swap`)
        continue
      }
      console.log(`[Swap] Replacing ${weakest.symbol}(weakness=${weakest.score.toFixed(1)}) with ${pending.symbol}(quality=${newQuality.toFixed(1)})`)
      const sellValue = sellPrice * weakPos.shares
      const sellTax = calcTax(sellValue, cfg)
      const sellComm = calcCommission(sellValue, cfg)
      const sellProceeds = sellValue - sellTax - sellComm
      const sellNote = buildSellOrderNote({
        reason: 'auto_swap',
        weakness_score: Math.round(weakest.score * 10) / 10,
        replaced_by: pending.symbol,
        entry_date: weakPos.entry_date ?? null,
      }, {
        entryPrice: weakPos.entry_price ?? weakPos.avg_cost,
        exitPrice: sellPrice,
        shares: weakPos.shares,
        commission: sellComm,
        tax: sellTax,
      })

      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO paper_orders (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, note, created_at)
          VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, 'auto_swap', ?, datetime('now'))
        `).bind(
          ACCOUNT_ID,
          weakest.symbol,
          weakPos.name ?? weakest.symbol,
          weakPos.shares,
          sellPrice,
          sellComm,
          sellTax,
          sellProceeds,
          sellNote,
        ),
        env.DB.prepare('DELETE FROM paper_positions WHERE account_id=? AND symbol=?').bind(ACCOUNT_ID, weakest.symbol),
      ])
      const swapOrderId = await recordSellSettlement(env.DB, env.KV, ACCOUNT_ID, weakest.symbol, sellProceeds)
      await recordPaperExecutionEvent(env, {
        tradeDate: today,
        symbol: weakest.symbol,
        side: 'sell',
        eventType: 'paper_order',
        status: 'filled',
        reason: 'auto_swap',
        detail: { replaced_by: pending.symbol, weakness_score: Math.round(weakest.score * 10) / 10 },
        orderId: swapOrderId,
        source: 'auto_swap',
      })
      acc.cash += sellProceeds

      weaknessScores.shift()
      dailySwaps++
    }
  }

  const atrMap = await batchGetATR(env.DB, pendingSymbols)

  const recentSells = await env.DB.prepare(
    "SELECT SUM(total_cost) as unsettled FROM paper_orders WHERE account_id=? AND side='sell' AND created_at > datetime('now', '-2 days')",
  ).bind(ACCOUNT_ID).first<any>()
  if (recentSells?.unsettled > 0) {
    console.warn(`[Paper] T+2 warning: $${recentSells.unsettled} unsettled from recent sells`)
  }

  const DAILY_BUY_LIMIT = cfg.position.dailyBuyLimit
  const todayBought = await env.DB.prepare(
    "SELECT COALESCE(SUM(total_cost), 0) as total FROM paper_orders WHERE account_id=? AND side='buy' AND created_at >= ?",
  ).bind(ACCOUNT_ID, today).first<any>()
  let dailyBuyTotal = todayBought?.total ?? 0

  const sectorCountMap = new Map<string, number>()
  if (posSymbols.length > 0) {
    const sectorPlaceholders = posSymbols.map(() => '?').join(',')
    const { results: sectorRows } = await env.DB.prepare(
      `SELECT symbol, sector FROM stocks WHERE symbol IN (${sectorPlaceholders})`,
    ).bind(...posSymbols).all<{ symbol: string; sector: string | null }>()
    for (const row of sectorRows ?? []) {
      const sec = row.sector ?? 'UNKNOWN'
      sectorCountMap.set(sec, (sectorCountMap.get(sec) ?? 0) + 1)
    }
  }

  const [punishedRaw, attentionRaw, delistingRaw] = await Promise.all([
    env.KV.get('market:punished_stocks'),
    env.KV.get('market:attention_stocks'),
    env.KV.get('market:delisting_risk'),
  ])

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
    for (const r of prevRows ?? []) {
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

  let marketRisk: { risk_level: string; change_rate?: number; risk_reasons?: string[] } = { risk_level: 'unknown' }
  if ((env as any).SHIOAJI_PROXY_URL) {
    try {
      const mrRes = await fetch(`${(env as any).SHIOAJI_PROXY_URL}/market-risk`, {
        headers: { Authorization: `Bearer ${(env as any).PROXY_SERVICE_TOKEN ?? ''}` },
        signal: AbortSignal.timeout(5000),
      })
      if (mrRes.ok) {
        marketRisk = (await mrRes.json()) as any
        if (marketRisk.risk_level !== 'low') {
          console.log(`[RiskGate] 市場風險升高: ${marketRisk.risk_level} (${marketRisk.change_rate ?? 0}%) -> ${(marketRisk.risk_reasons ?? []).join(', ')}`)
        }
      }
    } catch (e) {
      console.warn('[RiskGate] market-risk fetch failed (fail-closed):', e)
    }
  }

  let stateChanged = false
  const executionEvents: PendingBuyExecutionEvent[] = []
  const executionAuditEvents: { symbol: string; status: string; reason: string; detail?: string | null }[] = []
  const recordExecutionEvent = (
    symbol: string,
    status: PendingBuyTerminalExecutionStatus,
    reason: string,
    detail?: string | null,
  ) => {
    executionEvents.push({ symbol, status, reason })
    executionAuditEvents.push({ symbol, status, reason, detail: detail ?? null })
  }
  const recordExecutionNote = (symbol: string, status: string, reason: string, detail?: string | null) => {
    executionAuditEvents.push({ symbol, status, reason, detail: detail ?? null })
  }
  for (const pending of [...pendingBuys]) {
    if ((pending.debate_verdict ?? 'PENDING') === 'PENDING') continue
    const price = priceMap.get(pending.symbol)
    if (!price) continue

    if (blockedSymbols.has(pending.symbol)) {
      console.warn(`[Intraday] ${pending.symbol} 屬於懲罰/注意/下市風險清單，移出待買清單`)
      recordExecutionEvent(pending.symbol, 'skipped', 'blocked_symbol')
      stateChanged = true
      continue
    }

    const currentOhlc = ohlcMap.get(pending.symbol)
    if (currentOhlc?.source !== 'shioaji') {
      const reason = `broker_quote_required:${currentOhlc?.source ?? 'missing'}`
      const idx = pendingBuys.findIndex((b) => b.symbol === pending.symbol)
      if (idx >= 0) {
        const nextPending = appendPendingBuyExecutionNote(
          pendingBuys[idx],
          formatExecutionStatusEvent('deferred', reason),
        ) as PendingBuy
        if ((nextPending.watch_points ?? []).length !== (pendingBuys[idx].watch_points ?? []).length) {
          pendingBuys[idx] = nextPending
          recordExecutionNote(pending.symbol, 'deferred', reason)
          stateChanged = true
        }
      }
      console.log(`[Intraday] ${pending.symbol}: ${reason}`)
      continue
    }
    const preTrade = evaluatePreTradeExecution({
      symbol: pending.symbol,
      currentPrice: price,
      entryPrice: pending.ml_entry_price,
      stopLoss: pending.ml_stop_loss,
      originalEntry: (pending as any).original_entry ?? pending.ml_entry_price,
      retryCount: (pending as any).retry_count ?? 0,
      previousClose: prevCloseMap.get(pending.symbol) ?? null,
      quoteSource: currentOhlc?.source === 'shioaji' ? 'shioaji' : currentOhlc?.source === 'yahoo' ? 'yahoo' : 'none',
      marketRiskLevel: marketRisk.risk_level,
      momentum: await loadPreTradeMomentum(env, cfg, pending.symbol, price),
      policy: {
        limitUpPct: cfg.circuit.limitUpPct ?? 0.095,
        requoteDeviationMax: cfg.position.requoteDeviationMax,
        requoteDiscount: cfg.position.requoteDiscount,
        requoteStopFallback: cfg.position.requoteStopFallback,
      },
    })

    if (preTrade.action === 'REQUOTE') {
      const idx = pendingBuys.findIndex((b) => b.symbol === pending.symbol)
      if (idx >= 0 && preTrade.nextEntryPrice != null) {
        ;(pendingBuys[idx] as any).original_entry = (pending as any).original_entry ?? pending.ml_entry_price
        ;(pendingBuys[idx] as any).retry_count = preTrade.retryCount ?? ((pending as any).retry_count ?? 0) + 1
        pendingBuys[idx].ml_entry_price = preTrade.nextEntryPrice
        pendingBuys[idx].ml_stop_loss = preTrade.nextStopLoss ?? pending.ml_stop_loss
        pendingBuys[idx] = appendPendingBuyExecutionNote(
          pendingBuys[idx],
          formatExecutionStatusEvent('requote', preTrade.reason, `${pending.ml_entry_price}->${preTrade.nextEntryPrice}`),
        ) as PendingBuy
        recordExecutionNote(pending.symbol, 'requote', preTrade.reason, `${pending.ml_entry_price}->${preTrade.nextEntryPrice}`)
      }
      console.log(`[PreTrade] requote ${pending.symbol}: ${pending.ml_entry_price} -> ${preTrade.nextEntryPrice} (${preTrade.reason})`)
      stateChanged = true
      continue
    }
    if (preTrade.action === 'DEFER') {
      const idx = pendingBuys.findIndex((b) => b.symbol === pending.symbol)
      if (idx >= 0) {
        const nextPending = appendPendingBuyExecutionNote(
          pendingBuys[idx],
          formatExecutionStatusEvent('deferred', preTrade.reason),
        ) as PendingBuy
        if ((nextPending.watch_points ?? []).length !== (pendingBuys[idx].watch_points ?? []).length) {
          pendingBuys[idx] = nextPending
          recordExecutionNote(pending.symbol, 'deferred', preTrade.reason)
          stateChanged = true
        }
      }
      console.log(`[PreTrade] defer ${pending.symbol}: ${preTrade.reason}`)
      continue
    }
    if (preTrade.action === 'SKIP') {
      console.log(`[PreTrade] skip ${pending.symbol}: ${preTrade.reason}`)
      recordExecutionEvent(pending.symbol, 'skipped', preTrade.reason)
      stateChanged = true
      continue
    }

    const limitPrice = preTrade.limitPrice ?? pending.ml_entry_price
    const fill = resolveLimitBuyFill({
      currentPrice: price,
      limitPrice,
      intradayLow: currentOhlc?.low,
      intradayHigh: currentOhlc?.high,
      slippageTicks: cfg.position.fillSlippageTicks ?? 1,
    })
    if (!fill.fillable || fill.fillPrice == null) {
      const idx = pendingBuys.findIndex((b) => b.symbol === pending.symbol)
      if (idx >= 0) {
        const nextPending = appendPendingBuyExecutionNote(
          pendingBuys[idx],
          formatExecutionStatusEvent('deferred', fill.reason, `price=${price};limit=${limitPrice};low=${currentOhlc?.low ?? 'na'};high=${currentOhlc?.high ?? 'na'}`),
        ) as PendingBuy
        if ((nextPending.watch_points ?? []).length !== (pendingBuys[idx].watch_points ?? []).length) {
          pendingBuys[idx] = nextPending
          recordExecutionNote(pending.symbol, 'deferred', fill.reason, `price=${price};limit=${limitPrice};low=${currentOhlc?.low ?? 'na'};high=${currentOhlc?.high ?? 'na'}`)
          stateChanged = true
        }
      }
      console.log(`[Intraday] ${pending.symbol}: limit not filled (${fill.reason}) price=${price} limit=${limitPrice} low=${currentOhlc?.low ?? 'na'} high=${currentOhlc?.high ?? 'na'}`)
      continue
    }
    const fillPriceOverride = fill.fillPrice

    if (await hasFilledBuyToday(env, pending.symbol, today)) {
      console.log(`[Intraday] ${pending.symbol}: already filled today, removing stale pending buy`)
      recordExecutionEvent(pending.symbol, 'filled', 'already_filled_today')
      stateChanged = true
      continue
    }

    const currentCount = await env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM paper_positions WHERE account_id=? AND shares>0',
    ).bind(ACCOUNT_ID).first<any>()
    if ((currentCount?.cnt ?? 0) >= maxPos) {
      console.log(`[Intraday] ${pending.symbol}: position cap (${maxPos}) reached, skip`)
      continue
    }

    if (dailyBuyTotal >= DAILY_BUY_LIMIT) break
    if (acc.cash < cfg.position.minCashToTrade) break

    const recSector = (await env.DB.prepare('SELECT sector FROM stocks WHERE symbol=?').bind(pending.symbol).first<any>())?.sector ?? 'UNKNOWN'
    if ((sectorCountMap.get(recSector) ?? 0) >= 2) {
      console.log(`[Intraday] ${pending.symbol} 同產業已達持倉上限，跳過`)
      continue
    }

    const atr14 = atrMap.get(pending.symbol) ?? price * cfg.exit.fallbackAtrPct
    const dailyRemaining = DAILY_BUY_LIMIT - dailyBuyTotal
    const mediumRiskDampen = marketRisk.risk_level === 'medium' ? cfg.L2_formula.medium_risk_scale : 1.0
    const stopPct = Math.max(cfg.position.minStopPct, (atr14 * 2) / price)

    let budget: number
    let sizingMode: 'kelly' | 'risk_parity'
    if (pending.kelly_pct != null && pending.kelly_pct > 0) {
      const kellyAdj = pending.kelly_pct * mediumRiskDampen
      const kellyBudget = totalPortfolio * kellyAdj
      budget = Math.min(kellyBudget, totalPortfolio * cfg.position.maxPctOfPortfolio, acc.cash * cfg.position.maxPctOfCash, dailyRemaining)
      sizingMode = 'kelly'
      console.log(`[Sizing] ${pending.symbol} kelly ${(kellyAdj * 100).toFixed(1)}% -> budget ${budget.toFixed(0)}`)
    } else {
      const riskPctAdj = pending.risk_pct * mediumRiskDampen
      const riskBudget = totalPortfolio * riskPctAdj / stopPct
      budget = Math.min(riskBudget, totalPortfolio * cfg.position.maxPctOfPortfolio, acc.cash * cfg.position.maxPctOfCash, dailyRemaining)
      sizingMode = 'risk_parity'
    }

    const fillPrice = fillPriceOverride
    const fullLots = Math.floor(budget / (fillPrice * 1000))
    let shares: number
    let isOddLot = false
    if (fullLots >= 1) {
      shares = fullLots * 1000
    } else {
      shares = Math.floor(budget / fillPrice)
      isOddLot = true
      if (shares < 1) {
        console.log('[Intraday] shares<1, skip', pending.symbol)
        continue
      }
    }

    const txValue = fillPrice * shares
    const minPosVal = cfg.position.minPositionValue ?? 30_000
    if (txValue < minPosVal) {
      console.log('[Intraday] txValue below minimum', pending.symbol, txValue, minPosVal)
      continue
    }
    const commission = calcCommission(txValue, cfg)
    const totalCost = txValue + commission
    if (totalCost > acc.cash || dailyBuyTotal + totalCost > DAILY_BUY_LIMIT) continue

    const volPct = atr14 / fillPrice
    const { resolveSltpForRegime } = await import('./tradingConfig')
    const regimeLabel = await env.KV.get('ml:regime')
    const sltp = resolveSltpForRegime(cfg, regimeLabel)
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
    const initialStop = fillPrice - atr14 * slMult
    const tp1Price = fillPrice + atr14 * tpMult
    const tp2Price = fillPrice + atr14 * tpMult * tp2Mult

    const existing = await env.DB.prepare(
      'SELECT shares, avg_cost FROM paper_positions WHERE account_id=? AND symbol=?',
    ).bind(ACCOUNT_ID, pending.symbol).first<any>()
    const oldShares = existing?.shares ?? 0
    const oldAvgCost = existing?.avg_cost ?? 0
    const updatedShares = oldShares + shares
    const updatedAvgCost = oldShares > 0 ? (oldShares * oldAvgCost + txValue + commission) / updatedShares : totalCost / shares

    const intent = await acquirePaperBuyIntent(env, today, pending.symbol)
    if (!intent.acquired) {
      console.log(`[Intraday] ${pending.symbol}: duplicate buy intent, skip`)
      recordExecutionEvent(pending.symbol, 'skipped', 'duplicate_buy_intent')
      stateChanged = true
      continue
    }

    try {
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO paper_positions (account_id, symbol, name, shares, avg_cost, updated_at,
            entry_price, entry_date, initial_stop, trailing_stop, highest_since_entry,
            stop_multiplier, tp1_price, tp2_price, tp1_hit, original_shares)
          VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT(account_id, symbol) DO UPDATE SET
            shares=excluded.shares, avg_cost=excluded.avg_cost, name=excluded.name, updated_at=datetime('now')
        `).bind(
          ACCOUNT_ID,
          pending.symbol,
          pending.name,
          updatedShares,
          updatedAvgCost,
          fillPrice,
          today,
          initialStop,
          initialStop,
          fillPrice,
          slMult,
          tp1Price,
          tp2Price,
          shares,
        ),
        env.DB.prepare(`
          INSERT INTO paper_orders
            (account_id, symbol, name, side, shares, price, commission, tax, total_cost, source, signal, confidence, note)
          VALUES (?, ?, ?, 'buy', ?, ?, ?, 0, ?, 'auto_ml', ?, ?, ?)
        `).bind(
          ACCOUNT_ID,
          pending.symbol,
          pending.name,
          shares,
          fillPrice,
          commission,
          totalCost,
          pending.signal,
          pending.confidence,
          JSON.stringify({
            debate: pending.debate_verdict,
            ml_entry: pending.ml_entry_price,
            ml_stop: pending.ml_stop_loss,
            ml_t1: pending.ml_target1,
            ml_t2: pending.ml_target2,
            risk_pct: pending.risk_pct,
            kelly_pct: pending.kelly_pct,
            sizing_mode: sizingMode,
            stop_pct: stopPct,
            atr14,
            budget: Math.round(budget),
            fill_type: 'limit_intraday',
            slippage_ticks: cfg.position.fillSlippageTicks ?? 1,
            market_price: price,
            pre_trade_action: preTrade.action,
            pre_trade_reason: preTrade.reason,
            quote_source: currentOhlc?.source ?? 'none',
            intent_key: intent.intentKey,
          }),
        ),
      ])
    } catch (error) {
      await completePaperBuyIntent(
        env,
        intent.intentKey,
        'failed',
        null,
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }

    const autoOrderId = await env.DB.prepare(
      "SELECT id FROM paper_orders WHERE account_id=? AND symbol=? AND side='buy' ORDER BY id DESC LIMIT 1",
    ).bind(ACCOUNT_ID, pending.symbol).first<{ id: number }>()
    await completePaperBuyIntent(env, intent.intentKey, 'filled', autoOrderId?.id ?? null)
    const { getSettlementDate } = await import('./dateUtils')
    const settleDate = await getSettlementDate(today, env.KV)
    await env.DB.prepare(
      "INSERT INTO paper_settlements (account_id, order_id, symbol, side, amount, trade_date, settlement_date) VALUES (?, ?, ?, 'buy', ?, ?, ?)",
    ).bind(ACCOUNT_ID, autoOrderId?.id ?? 0, pending.symbol, totalCost, today, settleDate).run()
    await recordPaperExecutionEvent(env, {
      tradeDate: today,
      symbol: pending.symbol,
      side: 'buy',
      eventType: 'paper_order',
      status: 'filled',
      reason: 'paper_order_created',
      detail: { intent_key: intent.intentKey, shares, fill_price: fillPrice, total_cost: totalCost },
      orderId: autoOrderId?.id ?? null,
      source: 'auto_ml',
    })

    ;(acc as any).cash -= totalCost
    dailyBuyTotal += totalCost
    sectorCountMap.set(recSector, (sectorCountMap.get(recSector) ?? 0) + 1)

    try {
      const recRow = await env.DB.prepare(
        'SELECT chip_score, tech_score, ml_score, score FROM daily_recommendations WHERE date=? AND symbol=?',
      ).bind(today, pending.symbol).first<any>()
      if (recRow) {
        const total = recRow.score || 1
        await env.DB.prepare(`
          INSERT OR REPLACE INTO decision_logs
            (date, symbol, action, chip_score, tech_score, ml_score, total_score,
             chip_pct, tech_pct, ml_pct, ml_signal, ml_confidence,
             debate_verdict, debate_summary, market_risk, sector, entry_price)
          VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          today,
          pending.symbol,
          recRow.chip_score,
          recRow.tech_score,
          recRow.ml_score,
          total,
          Math.round((recRow.chip_score / total) * 100) / 100,
          Math.round((recRow.tech_score / total) * 100) / 100,
          Math.round((recRow.ml_score / total) * 100) / 100,
          pending.signal,
          pending.confidence,
          pending.debate_verdict ?? null,
          null,
          marketRisk?.risk_level ?? null,
          recSector,
          fillPrice,
        ).run()
      }
    } catch (e) {
      console.warn('[L2] Decision log failed:', e)
    }

    const lotTag = isOddLot ? ' [零股]' : ''
    console.log(`[Intraday] filled ${pending.symbol} ${shares}${lotTag} @ ${fillPrice} (mkt ${price})`)
    void sendDiscordNotification(
      (env as any).DISCORD_WEBHOOK_URL,
      `Auto buy filled: ${pending.symbol} ${pending.name}\n${shares}${lotTag} @ $${fillPrice} (mkt ${price})\nSL $${initialStop.toFixed(1)} | TP1 $${tp1Price.toFixed(1)} | TP2 $${tp2Price.toFixed(1)}`,
    )

    recordExecutionEvent(pending.symbol, 'filled', 'paper_order_created')
    stateChanged = true
  }

  if (executionEvents.length > 0) {
    await markPendingBuyExecutionEvents(env, today, pendingBuys, executionEvents, { stage: 'intraday_check', execution_events: executionAuditEvents })
  } else if (stateChanged) {
    await persistPendingBuyActiveState(env, today, pendingBuys, { stage: 'intraday_check', execution_events: executionAuditEvents })
  }
}
