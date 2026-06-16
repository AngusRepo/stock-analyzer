import { sendDiscordNotification } from './notify'
import { getCurrentRegime as getCurrentSltpRegime, getTradingConfig, resolveSltpForRegime } from './tradingConfig'
import { batchGetIntradayOHLC, batchGetIntradayPrices } from './paperIntradayData'
import {
  batchGetATR,
  getCurrentRegime,
  isDayTradeAllowed,
  logRegimeShadow,
  recordSellSettlement,
} from './paperMarketData'
import { applyPartialFill, calcCommission, calcTax, resolveLimitBuyFill, resolveMarketSellFill } from './paperTradeMath'
import { buildSellOrderNote } from './paperOrderAccounting'
import { forceDayTradeClose, pollIntradayStopLoss } from './paperExitTasks'
import {
  loadPendingBuySnapshot,
  markPendingBuyExecutionEvents,
  persistPendingBuyActiveState,
  recordPendingBuyAuditOnly,
  type PendingBuy,
} from './pendingBuyStore'
import type { PendingBuyExecutionEvent, PendingBuyTerminalExecutionStatus } from './pendingBuyExecutionState'
import { checkCircuitBreakers, reconcilePendingBuyDebates } from './pendingBuyOrchestrator'
import { acquirePaperBuyIntent, completePaperBuyIntent } from './paperOrderIntent'
import { evaluatePreTradeExecution, type PreTradeMomentumContext } from './preTradeExecutionPolicy'
import { resolveAdaptiveExecutionPolicy } from './executionAdaptivePolicy'
import {
  buildFinLabL5MarketDataDetail,
  evaluateL5OrderBookPersistence,
  fetchFinLabL5MarketDataSnapshot,
  normalizeFinLabL5Quote,
  quoteQualityFromL5,
  type FinLabL5Quote,
} from './finlabL5MarketData'
import { fetchFinLabExecutionPreview } from './finlabExecutionPreviewClient'
import { buildStockVisionOrderIntent, buildStockVisionSellOrderIntent } from './stockvisionOrderIntent'
import { buildPaperBrokerReconciliation } from './paperBrokerReconciliation'
import { buildTwOrderLegs, getTwTickSize, normalizeTwFilledSharesForRequestedOrder, normalizeTwLimitPrice } from './twMarketRules'
import {
  buildIntradayTechnicalSnapshot,
  floorRollingBarIntervalMs,
  resolveIntradayTechnicalDecision,
  type IntradayRollingBar,
} from './intradayTechnicalSnapshot'
import { getTwClockParts, isTwIntradayTradingMinute } from './twMarketSession'
import {
  appendPendingBuyExecutionNote,
  applyPendingBuyExecutionStatusUpdates,
  extractPartialFillRemaining,
  type PendingBuyActiveExecutionStatus,
} from './pendingBuyExecutionState'
import { evaluatePartialFillRemainingPolicy } from './partialFillRemainingPolicy'
import { formatExecutionStatusEvent } from './executionEvent'
import { recordPaperExecutionEvent } from './paperExecutionEvents'
import { shouldMarkPendingDebateSlaReached } from './pendingDebateSla'
import { computeProjectedVolumeRatio } from './preTradeMomentum'
import { computePaperTotalValue, getUnsettledSettlementSummary } from './paperAccountValue'
import { fetchAttentionStocks, fetchPunishedStocks } from './twseApi'
import { loadTradingRestrictionSet, refreshOfficialTradingRestrictions } from './tradingRestrictions'
import { readScoreV2Snapshot } from './scoreV2Taxonomy'
import {
  buildFiveSlotCapitalPlan,
  buildFiveSlotExecutionDecision,
  fiveSlotHoldingWeaknessScore,
  formatFiveSlotDecisionWatchPoint,
  type FiveSlotDecision,
  type FiveSlotCandidate,
  type FiveSlotHolding,
} from './fiveSlotCapitalAllocator'
import {
  batchLoadOhlcvTradePlanLevelsBySymbol,
  formatOhlcvTradePlanWatchPoint,
  resolveOhlcvEntryPlan,
  type OhlcvRow,
} from './ohlcvTradePlanLevels'
import { buildEntryPriceModelV2FromOhlcvPlan, buildVolumeProfileV2 } from './entryPriceModelV2'
import { buildPriceActionStructure } from './priceActionStructure'
import type { Bindings } from '../types'

const ACCOUNT_ID = 1
const EXECUTION_RESTRICTED_REFRESH_TTL_MS = 30 * 60_000

function truthyFlag(value: unknown): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function enabledFlag(value: unknown, fallback = false): boolean {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  return fallback
}

function optionalPositiveNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function minutesSinceTwMarketOpen(hour: number, minute: number): number {
  return hour * 60 + minute - 9 * 60
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseEventTimeMs(value: unknown): number | null {
  if (!value) return null
  const text = String(value)
  const parsed = new Date(text.includes('T') ? text : text.replace(' ', 'T')).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function addRestrictedSymbolsFromRaw(target: Set<string>, raw: string | null): void {
  if (!raw) return
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return
    for (const item of parsed) {
      const symbol = typeof item === 'string' ? item : item?.symbol ?? item?.code
      if (symbol) target.add(String(symbol))
    }
  } catch {
    // Ignore malformed optional cache; execution still tries live refresh below.
  }
}

async function addD1TradingRestrictions(env: Bindings, target: Set<string>, tradeDate: string): Promise<void> {
  try {
    const canonical = await loadTradingRestrictionSet(env, tradeDate, { refreshOfficialIfStale: false })
    for (const symbol of canonical.symbols) target.add(symbol)
  } catch {
    // Canonical FinLab/official restriction table is additive; fall back below.
  }
  try {
    const { results } = await env.DB.prepare(`
      SELECT symbol
        FROM stock_trading_restrictions
       WHERE COALESCE(active, 1) = 1
         AND (start_date IS NULL OR start_date <= ?)
         AND (end_date IS NULL OR end_date >= ?)
    `).bind(tradeDate, tradeDate).all<{ symbol: string | null }>()
    for (const row of results ?? []) {
      if (row.symbol) target.add(String(row.symbol))
    }
  } catch {
    // Older D1 snapshots may not have this optional governance table.
  }
}

async function loadExecutionBlockedSymbols(env: Bindings, tradeDate: string): Promise<Set<string>> {
  const blocked = new Set<string>()
  const [
    punishedRaw,
    attentionRaw,
    tpexPunishedRaw,
    tpexAttentionRaw,
    delistingRaw,
    checkedAtRaw,
  ] = await Promise.all([
    env.KV.get('market:punished_stocks'),
    env.KV.get('market:attention_stocks'),
    env.KV.get('market:tpex_punished_stocks'),
    env.KV.get('market:tpex_attention_stocks'),
    env.KV.get('market:delisting_risk'),
    env.KV.get('market:restricted_execution_checked_at'),
  ])

  addRestrictedSymbolsFromRaw(blocked, punishedRaw)
  addRestrictedSymbolsFromRaw(blocked, attentionRaw)
  addRestrictedSymbolsFromRaw(blocked, tpexPunishedRaw)
  addRestrictedSymbolsFromRaw(blocked, tpexAttentionRaw)
  addRestrictedSymbolsFromRaw(blocked, delistingRaw)
  await addD1TradingRestrictions(env, blocked, tradeDate)

  const checkedAtMs = checkedAtRaw ? Date.parse(checkedAtRaw) : 0
  const shouldRefresh = !Number.isFinite(checkedAtMs) || Date.now() - checkedAtMs > EXECUTION_RESTRICTED_REFRESH_TTL_MS
  if (!shouldRefresh) return blocked

  const [punishedResult, attentionResult] = await Promise.allSettled([
    fetchPunishedStocks(),
    fetchAttentionStocks(),
  ])
  if (punishedResult.status === 'fulfilled' && punishedResult.value.length > 0) {
    for (const symbol of punishedResult.value) blocked.add(symbol)
    await env.KV.put('market:punished_stocks', JSON.stringify(punishedResult.value), { expirationTtl: 86400 })
  }
  if (attentionResult.status === 'fulfilled' && attentionResult.value.length > 0) {
    for (const symbol of attentionResult.value) blocked.add(symbol)
    await env.KV.put('market:attention_stocks', JSON.stringify(attentionResult.value), { expirationTtl: 86400 })
  }
  await refreshOfficialTradingRestrictions(env, tradeDate).catch(() => ({}))
  await env.KV.put('market:restricted_execution_checked_at', new Date().toISOString(), { expirationTtl: 3600 })
  return blocked
}

interface IntradayTechnicalBaseline {
  obvTemperature60: number | null
  adaptiveRsiUpper50: number | null
}

async function batchGetIntradayTechnicalBaselines(
  db: D1Database,
  symbols: string[],
  beforeDate: string,
): Promise<Map<string, IntradayTechnicalBaseline>> {
  const clean = [...new Set(symbols.map((symbol) => String(symbol).trim()).filter(Boolean))]
  const out = new Map<string, IntradayTechnicalBaseline>()
  if (clean.length === 0) return out
  const placeholders = clean.map(() => '?').join(',')
  const { results } = await db.prepare(`
    SELECT s.symbol,
           ti.obv_temperature_60 AS obvTemperature60,
           ti.adaptive_rsi_upper_50 AS adaptiveRsiUpper50
      FROM technical_indicators ti
      JOIN stocks s ON s.id = ti.stock_id
     WHERE s.symbol IN (${placeholders})
       AND ti.date < ?
     ORDER BY s.symbol, ti.date DESC
  `).bind(...clean, beforeDate).all<any>()
  for (const row of results ?? []) {
    const symbol = String(row.symbol ?? '')
    if (!symbol || out.has(symbol)) continue
    out.set(symbol, {
      obvTemperature60: finiteNumber(row.obvTemperature60),
      adaptiveRsiUpper50: finiteNumber(row.adaptiveRsiUpper50),
    })
  }
  return out
}

interface IntradaySnapshotSample {
  startMs: number
  close: number
  totalVolume: number
}

function parseFinLabL5EventQuote(symbol: string, row: { created_at?: string | null; detail_json?: string | null }): FinLabL5Quote | null {
  try {
    const detail = row.detail_json ? JSON.parse(row.detail_json) : null
    if (!detail || typeof detail !== 'object') return null
    return normalizeFinLabL5Quote(symbol, {
      provider: detail.provider,
      price: detail.last_price,
      best_bid: detail.best_bid,
      best_ask: detail.best_ask,
      bid_prices: detail.bid_prices,
      ask_prices: detail.ask_prices,
      bid_volumes: detail.bid_volumes,
      ask_volumes: detail.ask_volumes,
      source_time: detail.source_time,
      received_at: detail.received_at ?? row.created_at,
      status: detail.status,
    }, row.created_at ? new Date(row.created_at) : new Date())
  } catch {
    return null
  }
}

async function loadRecentFinLabL5QuoteHistory(
  env: Pick<Bindings, 'DB'>,
  tradeDate: string,
  symbol: string,
  currentQuote: FinLabL5Quote | null,
  limit = 5,
): Promise<FinLabL5Quote[]> {
  const cleanSymbol = String(symbol ?? '').trim()
  if (!cleanSymbol) return currentQuote ? [currentQuote] : []
  try {
    const previousLimit = Math.max(0, Math.min(20, Math.floor(limit)) - (currentQuote ? 1 : 0))
    const previousQuotes: FinLabL5Quote[] = []
    if (previousLimit > 0) {
      const { results } = await env.DB.prepare(`
        SELECT detail_json, created_at
          FROM paper_execution_events
         WHERE trade_date = ?
           AND symbol = ?
           AND side = 'buy'
           AND event_type = 'finlab_l5_market_data'
         ORDER BY created_at DESC
         LIMIT ?
      `).bind(tradeDate, cleanSymbol, previousLimit).all<{ detail_json?: string | null; created_at?: string | null }>()
      for (const row of [...(results ?? [])].reverse()) {
        const quote = parseFinLabL5EventQuote(cleanSymbol, row)
        if (quote) previousQuotes.push(quote)
      }
    }
    return currentQuote ? [...previousQuotes, currentQuote] : previousQuotes
  } catch {
    return currentQuote ? [currentQuote] : []
  }
}

function parseIntradaySnapshotSample(row: { created_at?: string | null; detail_json?: string | null }): IntradaySnapshotSample | null {
  const startMs = parseEventTimeMs(row.created_at)
  if (startMs == null) return null
  try {
    const detail = row.detail_json ? JSON.parse(row.detail_json) : null
    const close = finiteNumber(detail?.latestClose)
    if (close == null || close <= 0) return null
    return {
      startMs,
      close,
      totalVolume: Math.max(0, finiteNumber(detail?.totalVolume) ?? 0),
    }
  } catch {
    return null
  }
}

function samplesToRollingBars(samples: IntradaySnapshotSample[], intervalMs: number): IntradayRollingBar[] {
  const ordered = [...samples].sort((a, b) => a.startMs - b.startMs)
  const buckets = new Map<number, { open: number; high: number; low: number; close: number; lastTotalVolume: number }>()
  for (const sample of ordered) {
    const bucketMs = Math.floor(sample.startMs / intervalMs) * intervalMs
    const bucket = buckets.get(bucketMs)
    if (!bucket) {
      buckets.set(bucketMs, {
        open: sample.close,
        high: sample.close,
        low: sample.close,
        close: sample.close,
        lastTotalVolume: sample.totalVolume,
      })
    } else {
      bucket.high = Math.max(bucket.high, sample.close)
      bucket.low = Math.min(bucket.low, sample.close)
      bucket.close = sample.close
      bucket.lastTotalVolume = Math.max(bucket.lastTotalVolume, sample.totalVolume)
    }
  }

  const bars: IntradayRollingBar[] = []
  let previousTotalVolume: number | null = null
  for (const [startMs, bucket] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const volume = previousTotalVolume == null
      ? Math.max(0, bucket.lastTotalVolume)
      : Math.max(0, bucket.lastTotalVolume - previousTotalVolume)
    bars.push({
      startMs,
      open: bucket.open,
      high: bucket.high,
      low: bucket.low,
      close: bucket.close,
      volume,
    })
    previousTotalVolume = Math.max(previousTotalVolume ?? 0, bucket.lastTotalVolume)
  }
  return bars
}

function formatIntradayBarTime(startMs: number): string {
  const d = new Date(startMs + 8 * 3600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}`
}

function rollingBarsToOhlcvRows(tradeDate: string, bars: IntradayRollingBar[]): OhlcvRow[] {
  return bars
    .filter((bar) => (
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close) &&
      bar.high >= bar.low
    ))
    .map((bar) => ({
      date: tradeDate,
      time: formatIntradayBarTime(bar.startMs),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: Math.max(0, Number(bar.volume ?? 0)),
    }))
}

async function loadIntradayTechnicalRollingBars(
  env: Bindings,
  symbol: string,
  tradeDate: string,
  currentPrice: number,
  currentTotalVolume: number,
): Promise<IntradayRollingBar[]> {
  const intervalMs = floorRollingBarIntervalMs(Number((env as any).INTRADAY_TECHNICAL_BAR_INTERVAL_MS ?? 30_000))
  const lookback = Math.max(6, Math.min(120, Math.floor(Number((env as any).INTRADAY_TECHNICAL_BAR_LOOKBACK ?? 40))))
  const { results } = await env.DB.prepare(`
    SELECT created_at, detail_json
      FROM paper_execution_events
     WHERE trade_date = ?
       AND symbol = ?
       AND event_type = 'intraday_technical_decision'
     ORDER BY id DESC
     LIMIT ?
  `).bind(tradeDate, symbol, lookback).all<{ created_at: string | null; detail_json: string | null }>()
  const samples = (results ?? [])
    .map(parseIntradaySnapshotSample)
    .filter((sample): sample is IntradaySnapshotSample => sample != null)
  samples.push({
    startMs: Date.now(),
    close: currentPrice,
    totalVolume: Math.max(0, currentTotalVolume),
  })
  const bars = samplesToRollingBars(samples, intervalMs)
  return bars.length > 0
    ? bars.slice(-lookback)
    : [{
      startMs: Date.now(),
      open: currentPrice,
      high: currentPrice,
      low: currentPrice,
      close: currentPrice,
      volume: Math.max(0, currentTotalVolume),
    }]
}

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
      strongBreakoutVolumeRatio: cfg.momentum?.strongBreakoutVolumeRatio ?? 1.5,
      slope5min: trendData?.slope_5min ?? null,
      rangePosition,
      minRangePosition: cfg.momentum?.minRangePosition ?? 0.3,
      strongBreakoutRangePosition: cfg.momentum?.strongBreakoutRangePosition ?? 0.7,
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

function quoteAgeMs(quoteTime?: string): number | null {
  if (!quoteTime) return null
  const normalized = quoteTime.includes('T') ? quoteTime : quoteTime.replace(' ', 'T')
  const ts = new Date(normalized).getTime()
  if (!Number.isFinite(ts)) return null
  return Math.max(0, Date.now() - ts)
}

function pendingRunIdFromMeta(meta: Record<string, unknown> | undefined): number | null {
  const runId = Number(meta?.run_id)
  return Number.isFinite(runId) ? runId : null
}

function shouldPersistActiveExecutionStatus(status: PendingBuyActiveExecutionStatus): boolean {
  return status === 'requoted' || status === 'partially_filled' || status === 'quote_unavailable'
}

export async function runIntradayCheck(env: Bindings): Promise<void> {
  const cfg = await getTradingConfig(env.KV)
  const { hour: twHour, minute: twMin } = getTwClockParts()
  const minutesSinceOpen = minutesSinceTwMarketOpen(twHour, twMin)
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
  if (staleDebateItems.length > 0 && shouldMarkPendingDebateSlaReached(new Date(), pendingDebateSlaMinutes)) {
    const transition = applyPendingBuyExecutionStatusUpdates(
      debateSnapshot.pendingBuys,
      staleDebateItems.map((item) => ({
        symbol: item.symbol,
        status: 'pending',
        reason: 'debate_sla_waiting',
        detail: `sla_minutes=${pendingDebateSlaMinutes}`,
      })),
    )
    if (transition.changed) {
      await persistPendingBuyActiveState(
        env,
        today,
        transition.activeItems as PendingBuy[],
        { stage: 'debate_sla', reason: 'debate_sla_waiting', sla_minutes: pendingDebateSlaMinutes },
      )
    }
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
      console.log(`[Intraday] cancelling unfilled pending buys before close: ${cancelled}`)
      void sendDiscordNotification(
        (env as any).DISCORD_WEBHOOK_URL,
        `Cancel unfilled pending buys before close\n${pendingBuys.map((b) => `- ${b.symbol} ${b.name} @ $${b.ml_entry_price}`).join('\n')}`,
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
  const pendingRunId = pendingRunIdFromMeta(pendingSnapshot.meta)

  const pendingSymbols = pendingBuys.map((b) => b.symbol)
  const ohlcMap = await batchGetIntradayOHLC(pendingSymbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
    requireBrokerQuote: true,
  })
  const priceMap = new Map<string, number>()
  for (const [s, o] of ohlcMap) priceMap.set(s, o.last)
  const finLabL5MarketDataSnapshot = await fetchFinLabL5MarketDataSnapshot(env as any, pendingSymbols)
  const finLabL5MarketDataMap = finLabL5MarketDataSnapshot.quotes

  const zeroPriceSymbols = pendingSymbols.filter((s) => !priceMap.has(s) || priceMap.get(s) === 0)
  if (zeroPriceSymbols.length > 0) {
    const errMsg = `Shioaji quote anomaly: ${zeroPriceSymbols.join(',')}`
    console.error(`[Intraday] error ${errMsg}`)
    await env.KV.put(
      `scheduler:run:intraday-error:${today}`,
      JSON.stringify({ error: errMsg, symbols: zeroPriceSymbols, timestamp: new Date().toISOString() }),
      { expirationTtl: 86400 },
    )
    if ((env as any).DISCORD_WEBHOOK_URL) {
      void sendDiscordNotification(
        (env as any).DISCORD_WEBHOOK_URL,
        `Error **Shioaji quote missing** ${errMsg} (${zeroPriceSymbols.length}/${pendingSymbols.length} symbols)`,
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
  const posQuoteMap = await batchGetIntradayOHLC(posSymbols, {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
    requireBrokerQuote: true,
  })
  const posValueMap = new Map<string, number>()
  for (const [symbol, quote] of posQuoteMap) posValueMap.set(symbol, quote.last)
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
          console.log(`[RiskGate] market risk guard: ${marketRisk.risk_level} (${marketRisk.change_rate ?? 0}%) -> ${(marketRisk.risk_reasons ?? []).join(', ')}`)
        }
      }
    } catch (e) {
      console.warn('[RiskGate] market-risk fetch failed (fail-closed):', e)
    }
  }

  if (currentPositionCount >= maxPos && pendingBuys.length > 0) {
    console.log(`[Intraday] Position cap ${currentPositionCount}/${maxPos} reached, evaluating replacements...`)

    const { results: fullPositions } = await env.DB.prepare(`
      SELECT symbol, name, shares, avg_cost, entry_date, entry_price,
             initial_stop, tp1_price, tp1_hit, highest_since_entry
      FROM paper_positions WHERE account_id=? AND shares>0
    `).bind(ACCOUNT_ID).all<any>()

    const weaknessScores: { symbol: string; score: number }[] = []
    for (const pos of fullPositions ?? []) {
      const daysHeld = pos.entry_date
        ? Math.floor((Date.now() + 8 * 3600_000 - new Date(pos.entry_date + 'T00:00:00+08:00').getTime()) / 86400_000)
        : 0
      const score = fiveSlotHoldingWeaknessScore({
        symbol: String(pos.symbol),
        shares: Number(pos.shares ?? 0),
        avgCost: Number(pos.avg_cost ?? 0),
        lastPrice: posValueMap.get(pos.symbol) ?? Number(pos.avg_cost ?? 0),
        daysHeld,
        tp1Hit: Boolean(pos.tp1_hit),
      })
      weaknessScores.push({ symbol: pos.symbol, score })
    }
    weaknessScores.sort((a, b) => b.score - a.score)

    const minHoldDays = cfg.position.swapMinHoldDays ?? 3
    const autoSwapPlan = buildFiveSlotCapitalPlan({
      account: {
        cash: Number((acc as any).cash ?? 0),
        totalPortfolio,
        dailyRemaining: cfg.position.dailyBuyLimit,
      },
      marketRiskLevel: marketRisk.risk_level,
      config: {
        maxPositions: maxPos,
        maxPctOfPortfolio: cfg.position.maxPctOfPortfolio,
        maxPctOfCash: cfg.position.maxPctOfCash,
        dailyBuyLimit: cfg.position.dailyBuyLimit,
        minPositionValue: cfg.position.minPositionValue ?? 30_000,
        swapThreshold: cfg.position.swapThreshold,
      },
      holdings: (fullPositions ?? []).map((pos: any) => ({
        symbol: String(pos.symbol),
        shares: Number(pos.shares ?? 0),
        avgCost: Number(pos.avg_cost ?? 0),
        lastPrice: posValueMap.get(pos.symbol) ?? Number(pos.avg_cost ?? 0),
        daysHeld: pos.entry_date
          ? Math.floor((Date.now() + 8 * 3600_000 - new Date(String(pos.entry_date).slice(0, 10) + 'T00:00:00+08:00').getTime()) / 86400_000)
          : 0,
        tp1Hit: Boolean(pos.tp1_hit),
      })),
      candidates: pendingBuys.map((pending) => ({
        symbol: pending.symbol,
        confidence: pending.confidence,
        score_v2: pending.score_v2 ?? null,
        riskPct: pending.risk_pct,
      })),
    })

    const soldSwapSymbols = new Set<string>()
    for (const pending of [...pendingBuys]) {
      if (dailySwaps >= maxSwaps) break
      if ((fullPositions ?? []).length === 0) break

      const replacementDecision = autoSwapPlan.decisions.get(pending.symbol)
      if (replacementDecision?.action !== 'replace' || !replacementDecision.replaceSymbol) {
        console.log(`[Swap] ${pending.symbol} allocator decision=${replacementDecision?.action ?? 'none'}, skip replacement`)
        continue
      }
      const weakest = {
        symbol: replacementDecision.replaceSymbol,
        score: replacementDecision.replaceWeaknessScore ?? 0,
      }
      if (soldSwapSymbols.has(weakest.symbol)) continue
      const weakPos = (fullPositions ?? []).find((p: any) => p.symbol === weakest.symbol)
      if (!weakPos) continue

      const replacementQuote = ohlcMap.get(pending.symbol)
      const replacementPrice = priceMap.get(pending.symbol)
      const replacementFill = resolveLimitBuyFill({
        currentPrice: Number(replacementPrice ?? 0),
        limitPrice: Number(pending.ml_entry_price ?? 0),
        bestAsk: replacementQuote?.ask,
        bestBid: replacementQuote?.bid,
        intradayLow: replacementQuote?.low,
        intradayHigh: replacementQuote?.high,
        slippageTicks: cfg.position.fillSlippageTicks ?? 1,
        requireBestAsk: true,
      })
      if (replacementQuote?.source !== 'shioaji' || !replacementFill.fillable || replacementFill.fillPrice == null) {
        await recordPaperExecutionEvent(env, {
          tradeDate: today,
          symbol: pending.symbol,
          eventType: 'pending_buy',
          status: 'allocator_skip',
          reason: 'auto_swap_replacement_not_executable',
          detail: {
            sell_symbol: weakest.symbol,
            replacement_source: replacementQuote?.source ?? 'missing',
            replacement_price: replacementPrice ?? null,
            replacement_entry: pending.ml_entry_price ?? null,
            fill_reason: replacementFill.reason,
          },
          source: 'auto_swap',
        })
        continue
      }

      const daysHeld = weakPos.entry_date
        ? Math.floor((Date.now() + 8 * 3600_000 - new Date(weakPos.entry_date).getTime()) / 86400_000)
        : 0
      if (daysHeld < minHoldDays) {
        console.log(`[Swap] ${weakest.symbol} held only ${daysHeld}d < ${minHoldDays}d, skip swap`)
        continue
      }

      const weakPx = posValueMap.get(weakest.symbol) ?? weakPos.avg_cost
      if (weakPos.tp1_price && weakPx >= weakPos.tp1_price * cfg.position.tp1ProximityRatio) {
        console.log(`[Swap] ${weakest.symbol} near TP1 (${weakPx}/${weakPos.tp1_price}), skip swap`)
        continue
      }

      const weakQuote = posQuoteMap.get(weakest.symbol)
      if (!weakQuote) {
        await recordPaperExecutionEvent(env, {
          tradeDate: today,
          symbol: weakest.symbol,
          side: 'sell',
          eventType: 'paper_order',
          status: 'skipped',
          reason: 'auto_swap_quote_unavailable',
          detail: { replaced_by: pending.symbol, weakness_score: Math.round(weakest.score * 10) / 10 },
          source: 'auto_swap',
        })
        continue
      }
      const sellFill = resolveMarketSellFill({
        currentPrice: weakQuote.last,
        bestBid: weakQuote.bid,
        bestAsk: weakQuote.ask,
        intradayLow: weakQuote.low,
        intradayHigh: weakQuote.high,
        slippageTicks: 1,
        requireBestBid: true,
      })
      if (!sellFill.fillable || sellFill.fillPrice == null) {
        await recordPaperExecutionEvent(env, {
          tradeDate: today,
          symbol: weakest.symbol,
          side: 'sell',
          eventType: 'paper_order',
          status: 'skipped',
          reason: 'auto_swap_sell_unfillable',
          detail: {
            replaced_by: pending.symbol,
            weakness_score: Math.round(weakest.score * 10) / 10,
            fill_reason: sellFill.reason,
            quote_last: weakQuote.last,
            quote_bid: weakQuote.bid ?? null,
            quote_ask: weakQuote.ask ?? null,
            quote_low: weakQuote.low ?? null,
            quote_high: weakQuote.high ?? null,
            quote_time: weakQuote.quoteTime ?? null,
          },
          source: 'auto_swap',
        })
        continue
      }
      const sellPrice = sellFill.fillPrice
      const sellOrderIntent = buildStockVisionSellOrderIntent({
        accountId: ACCOUNT_ID,
        tradeDate: today,
        symbol: weakest.symbol,
        limitPrice: sellPrice,
        currentPrice: weakQuote.last,
        shares: weakPos.shares,
        reason: 'auto_swap',
        strategyType: 'auto_swap',
        marketRiskLevel: marketRisk.risk_level,
        quote: {
          bestBid: weakQuote.bid ?? null,
          bestAsk: weakQuote.ask ?? null,
          source: weakQuote.source ?? null,
          quoteAgeMs: quoteAgeMs(weakQuote.quoteTime),
        },
      })
      console.log(`[Swap] Replacing ${weakest.symbol}(weakness=${weakest.score.toFixed(1)}) with ${pending.symbol}(rank=${replacementDecision.candidateRank ?? 'na'})`)
      const sellValue = sellPrice * weakPos.shares
      const sellTax = calcTax(sellValue, cfg)
      const sellComm = calcCommission(sellValue, cfg)
      const sellProceeds = sellValue - sellTax - sellComm
      const sellNote = buildSellOrderNote({
        reason: 'auto_swap',
        weakness_score: Math.round(weakest.score * 10) / 10,
        candidate_rank: replacementDecision.candidateRank ?? null,
        allocator_reason: replacementDecision.reason,
        replaced_by: pending.symbol,
        entry_date: weakPos.entry_date ?? null,
        order_intent: sellOrderIntent,
        order_legs: sellOrderIntent.orderLegs,
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
        detail: {
          replaced_by: pending.symbol,
          weakness_score: Math.round(weakest.score * 10) / 10,
          candidate_rank: replacementDecision.candidateRank ?? null,
          allocator_reason: replacementDecision.reason,
          fill_reason: sellFill.reason,
          order_intent: sellOrderIntent,
          order_legs: sellOrderIntent.orderLegs,
          quote_last: weakQuote.last,
          quote_bid: weakQuote.bid ?? null,
          quote_ask: weakQuote.ask ?? null,
          quote_low: weakQuote.low ?? null,
          quote_high: weakQuote.high ?? null,
          quote_time: weakQuote.quoteTime ?? null,
        },
        orderId: swapOrderId,
        source: 'auto_swap',
      })
      acc.cash += sellProceeds

      weaknessScores.shift()
      soldSwapSymbols.add(weakest.symbol)
      dailySwaps++
    }
  }

  const atrMap = await batchGetATR(env.DB, pendingSymbols)
  const technicalBaselineMap = await batchGetIntradayTechnicalBaselines(env.DB, pendingSymbols, today).catch((error) => {
    console.warn('[Intraday] technical baselines unavailable:', error)
    return new Map<string, IntradayTechnicalBaseline>()
  })
  const ohlcvLevelsBySymbol = await batchLoadOhlcvTradePlanLevelsBySymbol(env.DB, pendingSymbols, today).catch((error) => {
    console.warn('[Intraday] OHLCV trade plan levels unavailable:', error)
    return new Map()
  })

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

  const { results: capitalPositionRows } = await env.DB.prepare(
    'SELECT symbol, shares, avg_cost, entry_date, tp1_hit FROM paper_positions WHERE account_id=? AND shares>0',
  ).bind(ACCOUNT_ID).all<any>()
  const capitalPositionSymbols = (capitalPositionRows ?? []).map((p: any) => p.symbol).filter(Boolean)

  const sectorCountMap = new Map<string, number>()
  if (capitalPositionSymbols.length > 0) {
    const sectorPlaceholders = capitalPositionSymbols.map(() => '?').join(',')
    const { results: sectorRows } = await env.DB.prepare(
      `SELECT symbol, sector FROM stocks WHERE symbol IN (${sectorPlaceholders})`,
    ).bind(...capitalPositionSymbols).all<{ symbol: string; sector: string | null }>()
    for (const row of sectorRows ?? []) {
      const sec = row.sector ?? 'UNKNOWN'
      sectorCountMap.set(sec, (sectorCountMap.get(sec) ?? 0) + 1)
    }
  }

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

  const blockedSymbols = await loadExecutionBlockedSymbols(env, today)

  const toCapitalHolding = (pos: any): FiveSlotHolding => {
    const symbol = String(pos.symbol)
    return {
      symbol,
      shares: Number(pos.shares ?? 0),
      avgCost: Number(pos.avg_cost ?? 0),
      lastPrice: priceMap.get(symbol) ?? posValueMap.get(symbol) ?? Number(pos.avg_cost ?? 0),
      daysHeld: pos.entry_date
        ? Math.floor((Date.now() + 8 * 3600_000 - new Date(String(pos.entry_date).slice(0, 10) + 'T00:00:00+08:00').getTime()) / 86400_000)
        : 0,
      tp1Hit: Boolean(pos.tp1_hit),
    }
  }
  const loadCurrentCapitalHoldings = async (): Promise<FiveSlotHolding[]> => {
    const { results } = await env.DB.prepare(`
      SELECT symbol, name, shares, avg_cost, entry_date, tp1_hit
      FROM paper_positions WHERE account_id=? AND shares>0
    `).bind(ACCOUNT_ID).all<any>()
    return (results ?? []).map(toCapitalHolding)
  }
  const buildExecutionAllocatorDecision = async (pending: PendingBuy): Promise<FiveSlotDecision | null> => {
    const candidate: FiveSlotCandidate = {
      symbol: pending.symbol,
      confidence: pending.confidence,
      score_v2: pending.score_v2 ?? null,
      riskPct: pending.risk_pct,
    }
    return buildFiveSlotExecutionDecision({
      account: {
        cash: Number((acc as any).cash ?? 0),
        totalPortfolio,
        dailyRemaining: Math.max(0, DAILY_BUY_LIMIT - dailyBuyTotal),
      },
      marketRiskLevel: marketRisk.risk_level,
      config: {
        maxPositions: maxPos,
        maxPctOfPortfolio: cfg.position.maxPctOfPortfolio,
        maxPctOfCash: cfg.position.maxPctOfCash,
        dailyBuyLimit: DAILY_BUY_LIMIT,
        minPositionValue: cfg.position.minPositionValue ?? 30_000,
        swapThreshold: cfg.position.swapThreshold,
      },
      holdings: await loadCurrentCapitalHoldings(),
      candidate,
    })
  }
  const capitalHoldings: FiveSlotHolding[] = (capitalPositionRows ?? []).map(toCapitalHolding)
  const capitalPlanPreview = buildFiveSlotCapitalPlan({
    account: {
      cash: Number((acc as any).cash ?? 0),
      totalPortfolio,
      dailyRemaining: Math.max(0, DAILY_BUY_LIMIT - dailyBuyTotal),
    },
    marketRiskLevel: marketRisk.risk_level,
    config: {
      maxPositions: maxPos,
      maxPctOfPortfolio: cfg.position.maxPctOfPortfolio,
      maxPctOfCash: cfg.position.maxPctOfCash,
      dailyBuyLimit: DAILY_BUY_LIMIT,
      minPositionValue: cfg.position.minPositionValue ?? 30_000,
      swapThreshold: cfg.position.swapThreshold,
    },
    holdings: capitalHoldings,
    candidates: [],
  })
  console.log(
    `[Allocator] 5-slot exposure=${(capitalPlanPreview.targetExposure * 100).toFixed(0)}% ` +
    `slot=${Math.round(capitalPlanPreview.targetSlotValue)} holdings=${capitalHoldings.length}/${maxPos}`,
  )

  let stateChanged = false
  const executionEvents: PendingBuyExecutionEvent[] = []
  const executionAuditEvents: { symbol: string; status: string; reason: string; detail?: string | null }[] = []
  const recordExecutionEvent = (
    symbol: string,
    status: PendingBuyTerminalExecutionStatus,
    reason: string,
    detail?: string | null,
  ) => {
    executionEvents.push({ symbol, status, reason, detail: detail ?? null })
    executionAuditEvents.push({ symbol, status, reason, detail: detail ?? null })
  }
  const recordExecutionNote = (symbol: string, status: string, reason: string, detail?: string | null) => {
    executionAuditEvents.push({ symbol, status, reason, detail: detail ?? null })
  }
  const recordActiveExecutionStatus = (
    symbol: string,
    status: PendingBuyActiveExecutionStatus,
    reason: string,
    detail?: string | null,
  ) => {
    recordExecutionNote(symbol, status, reason, detail)
    if (!shouldPersistActiveExecutionStatus(status)) return
    const transition = applyPendingBuyExecutionStatusUpdates(pendingBuys, [{ symbol, status, reason, detail }])
    pendingBuys = transition.allItems as PendingBuy[]
    if (transition.changed) stateChanged = true
  }
  const recordAllocatorDecision = (symbol: string, decision: FiveSlotDecision) => {
    recordExecutionNote(
      symbol,
      `allocator_${decision.action}`,
      decision.reason,
      `${formatFiveSlotDecisionWatchPoint(decision)};target=${Math.round(decision.targetPositionValue)};current=${Math.round(decision.currentPositionValue)};budget=${Math.round(decision.budgetCap)};replace=${decision.replaceSymbol ?? 'none'}`,
    )
  }
  for (const pending of [...pendingBuys]) {
    if ((pending.debate_verdict ?? 'PENDING') === 'PENDING') continue
    const price = priceMap.get(pending.symbol)
    if (!price) continue
    if (pending.execution_status === 'partially_filled') {
      const partial = extractPartialFillRemaining(pending)
      const decision = evaluatePartialFillRemainingPolicy({
        requestedShares: partial?.requested ?? 0,
        filledShares: partial?.filled ?? 0,
        remainingShares: partial?.remaining ?? 0,
        lastPrice: price,
        minPositionValue: cfg.position.minPositionValue ?? 30_000,
        intradayOpen: isTwIntradayTradingMinute(),
      })
      if (decision.action === 'keep') {
        recordExecutionNote(
          pending.symbol,
          'partially_filled',
          decision.reason,
          partial ? `remaining=${partial.remaining}` : null,
        )
        continue
      } else {
        recordExecutionEvent(
          pending.symbol,
          decision.action === 'cancel' ? 'cancelled' : 'expired',
          decision.reason,
          partial ? `remaining=${partial.remaining}` : null,
        )
        stateChanged = true
      }
      continue
    }

    if (blockedSymbols.has(pending.symbol)) {
      console.warn(`[Intraday] ${pending.symbol} restricted execution gate`)
      recordExecutionEvent(pending.symbol, 'skipped', 'restricted_execution_gate', 'punished_or_attention_or_delisting')
      stateChanged = true
      continue
    }

    const allocatorDecision = await buildExecutionAllocatorDecision(pending)
    if (allocatorDecision) recordAllocatorDecision(pending.symbol, allocatorDecision)
    if (!allocatorDecision || allocatorDecision.action === 'skip' || allocatorDecision.action === 'hold') {
      const reason = allocatorDecision?.reason ?? 'allocator_no_plan'
      recordActiveExecutionStatus(
        pending.symbol,
        'pending',
        reason,
        allocatorDecision
          ? `target=${Math.round(allocatorDecision.targetPositionValue)};current=${Math.round(allocatorDecision.currentPositionValue)}`
          : null,
      )
      console.log(`[Allocator] ${pending.symbol}: ${reason}`)
      continue
    }

    const currentOhlc = ohlcMap.get(pending.symbol)
    if (currentOhlc?.source !== 'shioaji') {
      const reason = `broker_quote_required:${currentOhlc?.source ?? 'missing'}`
      recordActiveExecutionStatus(pending.symbol, 'quote_unavailable', reason)
      console.log(`[Intraday] ${pending.symbol}: ${reason}`)
      continue
    }
    const ohlcvTradePlan = resolveOhlcvEntryPlan(ohlcvLevelsBySymbol.get(pending.symbol), { latestPrice: price })
    let entryModelV2 = ohlcvTradePlan
      ? buildEntryPriceModelV2FromOhlcvPlan(ohlcvTradePlan)
      : null
    let executionEntryPrice = pending.ml_entry_price
    let executionStopLoss = pending.ml_stop_loss
    if (ohlcvTradePlan) {
      executionEntryPrice = ohlcvTradePlan.entryPrice
      executionStopLoss = ohlcvTradePlan.stopLoss
      recordExecutionNote(
        pending.symbol,
        'ohlcv_trade_plan',
        'intraday_execution_plan',
        formatOhlcvTradePlanWatchPoint(ohlcvTradePlan),
      )
    }
    let intradayTechnicalSnapshot: ReturnType<typeof buildIntradayTechnicalSnapshot> | null = null
    const previousCloseForSnapshot = prevCloseMap.get(pending.symbol) ?? null
    if (previousCloseForSnapshot != null && previousCloseForSnapshot > 0) {
      try {
        const technicalBaseline = technicalBaselineMap.get(pending.symbol) ?? null
        const currentTotalVolume = Number(currentOhlc?.totalVolume ?? 0)
        const rollingBars = await loadIntradayTechnicalRollingBars(
          env,
          pending.symbol,
          today,
          price,
          currentTotalVolume,
        )
        if (ohlcvTradePlan) {
          const intradayRows = rollingBarsToOhlcvRows(today, rollingBars)
          const intradayProfile = buildVolumeProfileV2(intradayRows, {
            binCount: Math.max(12, Math.min(48, intradayRows.length * 4)),
            valueAreaPct: 0.7,
          })
          if (intradayProfile.poc != null && intradayProfile.vah != null && intradayProfile.val != null) {
            entryModelV2 = buildEntryPriceModelV2FromOhlcvPlan(ohlcvTradePlan, {
              anchorSource: 'intraday_volume_profile',
              profile: intradayProfile,
              priceActionStructure: buildPriceActionStructure(intradayRows, {
                latestPrice: price,
                breakLookback: 5,
                structureLookback: 5,
              }),
            })
            recordExecutionNote(
              pending.symbol,
              'entry_model_v2_intraday_profile',
              'intraday_volume_profile_active',
              [
                `poc=${intradayProfile.poc}`,
                `vah=${intradayProfile.vah}`,
                `val=${intradayProfile.val}`,
                `value_area=${intradayProfile.valueAreaVolumePct}`,
                `bars=${intradayRows.length}`,
              ].join(';'),
            )
          } else {
            recordExecutionNote(
              pending.symbol,
              'entry_model_v2_daily_proxy_fallback',
              'intraday_volume_profile_unavailable',
              `bars=${intradayRows.length}`,
            )
          }
        }
        intradayTechnicalSnapshot = buildIntradayTechnicalSnapshot({
          symbol: pending.symbol,
          previousClose: previousCloseForSnapshot,
          previousAtr14: atrMap.get(pending.symbol) ?? price * cfg.exit.fallbackAtrPct,
          previousObvTemperature60: technicalBaseline?.obvTemperature60 ?? null,
          previousAdaptiveRsiUpper50: technicalBaseline?.adaptiveRsiUpper50 ?? null,
          sessionHigh: currentOhlc?.high ?? null,
          sessionLow: currentOhlc?.low ?? null,
          sessionTotalVolume: currentTotalVolume,
          rollingBars,
        })
        await recordPaperExecutionEvent(env, {
          tradeDate: today,
          symbol: pending.symbol,
          side: 'buy',
          eventType: 'intraday_technical_decision',
          status: intradayTechnicalSnapshot.adaptiveRsiState,
          reason: 'intraday_dynamic_decision',
          detail: {
            ...intradayTechnicalSnapshot,
            guard_enabled: enabledFlag(env.INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED, true),
            previous_close: previousCloseForSnapshot,
            previous_obv_temperature_60: technicalBaseline?.obvTemperature60 ?? null,
            previous_adaptive_rsi_upper_50: technicalBaseline?.adaptiveRsiUpper50 ?? null,
          },
          pendingRunId,
          source: 'intraday_dynamic_technical_decision',
        })
      } catch (error) {
        recordExecutionNote(
          pending.symbol,
          'intraday_technical_decision_error',
          'intraday_dynamic_decision_failed',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    const technicalGuardEnabled = enabledFlag(env.INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED, true)
    const effectiveOhlcvTradePlan = ohlcvTradePlan && intradayTechnicalSnapshot && technicalGuardEnabled
      ? {
        ...ohlcvTradePlan,
        atrDefense: Math.max(ohlcvTradePlan.atrDefense ?? 0, intradayTechnicalSnapshot.atrDefense),
      }
      : ohlcvTradePlan
    const finLabL5Quote = finLabL5MarketDataMap.get(pending.symbol) ?? null
    const finLabL5Quality = finLabL5Quote
      ? quoteQualityFromL5(finLabL5Quote, {
        maxQuoteAgeMs: optionalPositiveNumber(env.FINLAB_L5_MAX_QUOTE_AGE_MS, Math.min(cfg.position.maxQuoteAgeMs ?? 60_000, 3000)),
        maxSpreadPct: optionalPositiveNumber(env.FINLAB_L5_MAX_SPREAD_PCT, 0.006),
        minDepthLevels: Math.max(1, Math.floor(optionalPositiveNumber(env.FINLAB_L5_MIN_DEPTH_LEVELS, 5))),
        minTopAskVolume: optionalPositiveNumber(env.FINLAB_L5_MIN_TOP_ASK_VOLUME, 1),
        minOrderBookImbalance: Number.isFinite(Number(env.FINLAB_L5_MIN_ORDER_BOOK_IMBALANCE))
          ? Number(env.FINLAB_L5_MIN_ORDER_BOOK_IMBALANCE)
          : -0.7,
      })
      : null
    const finLabL5MarketDataEnabled = truthyFlag(env.FINLAB_L5_MARKET_DATA_ENABLED)
    const finLabL5Persistence = finLabL5MarketDataEnabled
      ? evaluateL5OrderBookPersistence(
        await loadRecentFinLabL5QuoteHistory(env, today, pending.symbol, finLabL5Quote, 5),
      )
      : null
    if (finLabL5MarketDataEnabled) {
      await recordPaperExecutionEvent(env, {
        tradeDate: today,
        symbol: pending.symbol,
        side: 'buy',
        eventType: 'finlab_l5_market_data',
        status: finLabL5Quality?.status ?? 'missing',
        reason: finLabL5Quality?.reasons.join(',') || (finLabL5Quote ? 'l5_market_data_pass' : 'l5_market_data_missing'),
        detail: {
          ...buildFinLabL5MarketDataDetail(finLabL5Quote),
          controller_status: finLabL5MarketDataSnapshot.status,
          controller_blocked_reasons: finLabL5MarketDataSnapshot.blockedReasons,
          controller_env_missing: finLabL5MarketDataSnapshot.envMissing,
          controller_live_submit_enabled: finLabL5MarketDataSnapshot.liveSubmitEnabled,
          controller_can_submit_real_order: finLabL5MarketDataSnapshot.canSubmitRealOrder,
          quality: finLabL5Quality,
          persistence: finLabL5Persistence,
          production_grade_market_data: finLabL5MarketDataEnabled,
          live_submit_enabled: false,
        },
        pendingRunId,
        source: 'finlab_sinopac_l5_market_data',
      })
      if (finLabL5Persistence) {
        recordExecutionNote(
          pending.symbol,
          `l5_persistence_${finLabL5Persistence.status}`,
          finLabL5Persistence.reasons.join(',') || 'l5_persistence_neutral',
          JSON.stringify(finLabL5Persistence.metrics),
        )
      }
    }
    const baseMomentum = await loadPreTradeMomentum(env, cfg, pending.symbol, price)
    const adaptivePolicy = resolveAdaptiveExecutionPolicy({
      strategyMode: effectiveOhlcvTradePlan?.mode ?? null,
      marketRiskLevel: marketRisk.risk_level,
      l5Quality: finLabL5Quality,
      base: {
        minVolumeRatio: cfg.momentum?.minVolumeRatio ?? 0.8,
        minRangePosition: cfg.momentum?.minRangePosition ?? 0.3,
        maxEntryChasePct: cfg.position.maxEntryChasePct,
        strongBreakoutMaxEntryChasePct: cfg.position.strongBreakoutMaxEntryChasePct,
        strongBreakoutVolumeRatio: cfg.momentum?.strongBreakoutVolumeRatio ?? 1.5,
        strongBreakoutRangePosition: cfg.momentum?.strongBreakoutRangePosition ?? 0.7,
      },
    })
    recordExecutionNote(
      pending.symbol,
      'adaptive_gate_live',
      'adaptive_execution_policy',
      [
        `volume_min=${adaptivePolicy.momentum.minVolumeRatio}`,
        `range_min=${adaptivePolicy.momentum.minRangePosition}`,
        `chase_max=${adaptivePolicy.policy.maxEntryChasePct}`,
        `strong_chase_max=${adaptivePolicy.policy.strongBreakoutMaxEntryChasePct}`,
        finLabL5Quality ? `l5=${finLabL5Quality.status}` : null,
        adaptivePolicy.notes.join('|'),
      ].filter(Boolean).join(';'),
    )
    const closeWindowVolumeFloor = optionalPositiveNumber(env.EXECUTION_CLOSE_WINDOW_MIN_VOLUME_RATIO, 0.9)
    const closeWindowVolumeBridge =
      twHour === 13 &&
      Number(baseMomentum.volumeRatio ?? 0) >= closeWindowVolumeFloor &&
      adaptivePolicy.momentum.minVolumeRatio > closeWindowVolumeFloor
    const intradayTechnicalDecision = intradayTechnicalSnapshot && technicalGuardEnabled
      ? resolveIntradayTechnicalDecision({
        snapshot: intradayTechnicalSnapshot,
        strategyMode: effectiveOhlcvTradePlan?.mode ?? null,
        marketRiskLevel: marketRisk.risk_level,
        minRangePosition: adaptivePolicy.momentum.minRangePosition,
        minDistributionSkipBarCount: optionalPositiveNumber(env.INTRADAY_TECHNICAL_DISTRIBUTION_SKIP_MIN_BARS, 60),
      })
      : null
    if (intradayTechnicalDecision) {
      recordExecutionNote(
        pending.symbol,
        intradayTechnicalDecision.action === 'pass' ? 'technical_pass' : 'pending',
        intradayTechnicalDecision.reason,
        intradayTechnicalDecision.detail,
      )
    }
    const closeWindowTechnicalPass = !technicalGuardEnabled || intradayTechnicalDecision?.action === 'pass'
    const effectiveMomentumMinVolumeRatio =
      closeWindowVolumeBridge &&
      closeWindowTechnicalPass
        ? closeWindowVolumeFloor
        : adaptivePolicy.momentum.minVolumeRatio
    if (effectiveMomentumMinVolumeRatio !== adaptivePolicy.momentum.minVolumeRatio) {
      recordExecutionNote(
        pending.symbol,
        'closing_window_volume_bridge',
        'volume_near_miss_after_technical_pass',
        `volume_ratio=${baseMomentum.volumeRatio ?? 'na'};min=${adaptivePolicy.momentum.minVolumeRatio}->${effectiveMomentumMinVolumeRatio}`,
      )
    }
    if (adaptivePolicy.envelopeBlockReason && truthyFlag(env.FINLAB_L5_ENVELOPE_GUARD_ENABLED)) {
      recordActiveExecutionStatus(
        pending.symbol,
        'pending',
        adaptivePolicy.envelopeBlockReason,
        'finlab_l5_envelope_guard',
      )
      continue
    }
    const openingFastPath = {
      enabled: enabledFlag(env.ENTRY_MODEL_V2_OPENING_FAST_PATH_ENABLED, true),
      minutesSinceOpen,
      maxMinutes: optionalPositiveNumber(env.ENTRY_MODEL_V2_OPENING_FAST_PATH_MAX_MINUTES, 10),
      allowTrendUnavailable: enabledFlag(env.ENTRY_MODEL_V2_OPENING_FAST_PATH_ALLOW_TREND_UNAVAILABLE, true),
      maxPremiumPct: optionalPositiveNumber(env.ENTRY_MODEL_V2_OPENING_FAST_PATH_MAX_PREMIUM_PCT, 0.012),
      l5Status: finLabL5Quality?.status ?? null,
    }
    if (openingFastPath.enabled && minutesSinceOpen >= 0 && minutesSinceOpen <= openingFastPath.maxMinutes) {
      recordExecutionNote(
        pending.symbol,
        'opening_fast_path_context',
        'entry_model_v2_opening_fast_path',
        [
          `minutes_since_open=${minutesSinceOpen}`,
          `max_minutes=${openingFastPath.maxMinutes}`,
          `max_premium=${openingFastPath.maxPremiumPct}`,
          `l5=${openingFastPath.l5Status ?? 'na'}`,
        ].join(';'),
      )
    }
    const preTrade = evaluatePreTradeExecution({
      symbol: pending.symbol,
      currentPrice: price,
      entryPrice: executionEntryPrice,
      bestAsk: currentOhlc?.ask,
      stopLoss: executionStopLoss,
      originalEntry: effectiveOhlcvTradePlan?.entryPrice ?? (pending as any).original_entry ?? pending.ml_entry_price,
      retryCount: (pending as any).retry_count ?? 0,
      previousClose: prevCloseMap.get(pending.symbol) ?? null,
      quoteAgeMs: quoteAgeMs(currentOhlc?.quoteTime),
      quoteSource: currentOhlc?.source === 'shioaji' ? 'shioaji' : currentOhlc?.source === 'yahoo' ? 'yahoo' : 'none',
      marketRiskLevel: marketRisk.risk_level,
      momentum: {
        ...baseMomentum,
        minVolumeRatio: effectiveMomentumMinVolumeRatio,
        minRangePosition: adaptivePolicy.momentum.minRangePosition,
        strongBreakoutVolumeRatio: adaptivePolicy.momentum.strongBreakoutVolumeRatio,
        strongBreakoutRangePosition: adaptivePolicy.momentum.strongBreakoutRangePosition,
      },
      entryModelV2,
      openingFastPath,
      tradePlan: effectiveOhlcvTradePlan
        ? {
          source: effectiveOhlcvTradePlan.source,
          mode: effectiveOhlcvTradePlan.mode,
          confirmation: effectiveOhlcvTradePlan.confirmation,
          resistance: effectiveOhlcvTradePlan.resistance,
          support: effectiveOhlcvTradePlan.support,
          atrDefense: effectiveOhlcvTradePlan.atrDefense,
          volumeNode: effectiveOhlcvTradePlan.volumeNode,
          buyReferenceLow: effectiveOhlcvTradePlan.buyReferenceLow,
          buyReferenceHigh: effectiveOhlcvTradePlan.buyReferenceHigh,
          optimisticLow: effectiveOhlcvTradePlan.optimisticLow,
          optimisticHigh: effectiveOhlcvTradePlan.optimisticHigh,
        }
        : null,
      technical: intradayTechnicalDecision,
      policy: {
        limitUpPct: cfg.circuit.limitUpPct ?? 0.095,
        requoteDeviationMax: cfg.position.requoteDeviationMax,
        requoteDiscount: cfg.position.requoteDiscount,
        requoteStopFallback: cfg.position.requoteStopFallback,
        maxQuoteAgeMs: cfg.position.maxQuoteAgeMs,
        maxEntryChasePct: adaptivePolicy.policy.maxEntryChasePct,
        strongBreakoutMaxEntryChasePct: adaptivePolicy.policy.strongBreakoutMaxEntryChasePct,
      },
    })

    if (preTrade.action === 'REQUOTE') {
      const idx = pendingBuys.findIndex((b) => b.symbol === pending.symbol)
      if (idx >= 0 && preTrade.nextEntryPrice != null) {
        ;(pendingBuys[idx] as any).original_entry = (pending as any).original_entry ?? pending.ml_entry_price
        ;(pendingBuys[idx] as any).retry_count = preTrade.retryCount ?? ((pending as any).retry_count ?? 0) + 1
        pendingBuys[idx].ml_entry_price = preTrade.nextEntryPrice
        pendingBuys[idx].ml_stop_loss = preTrade.nextStopLoss ?? executionStopLoss
        pendingBuys[idx] = appendPendingBuyExecutionNote(
          pendingBuys[idx],
          formatExecutionStatusEvent('requoted', preTrade.reason, `${executionEntryPrice}->${preTrade.nextEntryPrice}`),
        ) as PendingBuy
        recordActiveExecutionStatus(pending.symbol, 'requoted', preTrade.reason, `${executionEntryPrice}->${preTrade.nextEntryPrice}`)
      }
      console.log(`[PreTrade] requote ${pending.symbol}: ${executionEntryPrice} -> ${preTrade.nextEntryPrice} (${preTrade.reason})`)
      stateChanged = true
      continue
    }
    if (preTrade.action === 'DEFER') {
      const activeStatus: PendingBuyActiveExecutionStatus = preTrade.reason.startsWith('stale_quote:')
        ? 'stale_quote'
        : preTrade.reason.startsWith('untrusted_quote_source:')
          ? 'quote_unavailable'
          : 'pending'
      recordActiveExecutionStatus(pending.symbol, activeStatus, preTrade.reason, preTrade.detail ?? null)
      console.log(`[PreTrade] defer ${pending.symbol}: ${preTrade.reason}`)
      continue
    }
    if (preTrade.action === 'SKIP') {
      console.log(`[PreTrade] skip ${pending.symbol}: ${preTrade.reason}`)
      recordExecutionEvent(pending.symbol, 'skipped', preTrade.reason, preTrade.detail ?? null)
      stateChanged = true
      continue
    }

    const rawLimitPrice = preTrade.limitPrice ?? executionEntryPrice
    const limitPrice = normalizeTwLimitPrice(rawLimitPrice, 'buy')
    const fill = resolveLimitBuyFill({
      currentPrice: price,
      limitPrice,
      bestAsk: currentOhlc?.ask,
      bestBid: currentOhlc?.bid,
      intradayLow: currentOhlc?.low,
      intradayHigh: currentOhlc?.high,
      slippageTicks: cfg.position.fillSlippageTicks ?? 1,
      requireBestAsk: true,
    })
    if (!fill.fillable || fill.fillPrice == null) {
      recordActiveExecutionStatus(
        pending.symbol,
        'submitted',
        fill.reason,
        `price=${price};limit=${limitPrice};low=${currentOhlc?.low ?? 'na'};high=${currentOhlc?.high ?? 'na'}`,
      )
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
    if ((currentCount?.cnt ?? 0) >= maxPos && allocatorDecision.action !== 'add') {
      console.log(`[Intraday] ${pending.symbol}: position cap (${maxPos}) reached, skip`)
      recordActiveExecutionStatus(
        pending.symbol,
        'pending',
        allocatorDecision.action === 'replace' ? 'allocator_replace_requires_sell_first' : 'allocator_full_requires_replacement',
        allocatorDecision.replaceSymbol
          ? `replace=${allocatorDecision.replaceSymbol};weakness=${allocatorDecision.replaceWeaknessScore ?? 'na'}`
          : null,
      )
      continue
    }

    if (dailyBuyTotal >= DAILY_BUY_LIMIT) break
    if (acc.cash < cfg.position.minCashToTrade) break

    const recSector = (await env.DB.prepare('SELECT sector FROM stocks WHERE symbol=?').bind(pending.symbol).first<any>())?.sector ?? 'UNKNOWN'
    if ((sectorCountMap.get(recSector) ?? 0) >= 2) {
      console.log(`[Intraday] ${pending.symbol}: sector cap reached, skip`)
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
      budget = Math.min(kellyBudget, allocatorDecision.budgetCap, totalPortfolio * cfg.position.maxPctOfPortfolio, acc.cash * cfg.position.maxPctOfCash, dailyRemaining)
      sizingMode = 'kelly'
      console.log(`[Sizing] ${pending.symbol} kelly ${(kellyAdj * 100).toFixed(1)}% -> budget ${budget.toFixed(0)}`)
    } else {
      const riskPctAdj = pending.risk_pct * mediumRiskDampen
      const riskBudget = totalPortfolio * riskPctAdj / stopPct
      budget = Math.min(riskBudget, allocatorDecision.budgetCap, totalPortfolio * cfg.position.maxPctOfPortfolio, acc.cash * cfg.position.maxPctOfCash, dailyRemaining)
      sizingMode = 'risk_parity'
    }

    const minPosVal = cfg.position.minPositionValue ?? 30_000
    if (budget < minPosVal) {
      recordActiveExecutionStatus(
        pending.symbol,
        'pending',
        'allocator_budget_below_min',
        `budget=${Math.round(budget)};min=${minPosVal};action=${allocatorDecision.action}`,
      )
      continue
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
    const requestedShares = shares
    const orderIntent = buildStockVisionOrderIntent({
      accountId: ACCOUNT_ID,
      tradeDate: today,
      pending,
      limitPrice,
      currentPrice: price,
      budget,
      shares: requestedShares,
      strategyMode: effectiveOhlcvTradePlan?.mode ?? null,
      marketRiskLevel: marketRisk.risk_level,
      quote: {
        bestAsk: currentOhlc?.ask ?? null,
        bestBid: currentOhlc?.bid ?? null,
        source: currentOhlc?.source ?? 'none',
        quoteAgeMs: quoteAgeMs(currentOhlc?.quoteTime),
      },
      adaptivePolicy: {
        maxEntryChasePct: adaptivePolicy.policy.maxEntryChasePct,
        minVolumeRatio: adaptivePolicy.momentum.minVolumeRatio,
        minRangePosition: adaptivePolicy.momentum.minRangePosition,
      },
    })
    const finLabExecutionPreview = await fetchFinLabExecutionPreview(env as any, orderIntent)
    if (finLabExecutionPreview) {
      await recordPaperExecutionEvent(env, {
        tradeDate: today,
        symbol: pending.symbol,
        side: 'buy',
        eventType: 'finlab_execution_preview',
        status: finLabExecutionPreview.status,
        reason: finLabExecutionPreview.visible_reason,
        detail: {
          previewOnly: true,
          intent: orderIntent,
          blocked_reasons: finLabExecutionPreview.blocked_reasons ?? [],
          warnings: finLabExecutionPreview.warnings ?? [],
          raw_status: finLabExecutionPreview.raw?.status ?? null,
          live_submit_enabled: false,
        },
        pendingRunId,
        source: 'finlab_execution_preview',
      })
      if (
        truthyFlag((env as any).FINLAB_EXECUTION_PREVIEW_GUARD_ENABLED) &&
        ['blocked', 'error'].includes(String(finLabExecutionPreview.status).toLowerCase())
      ) {
        recordActiveExecutionStatus(
          pending.symbol,
          'pending',
          finLabExecutionPreview.visible_reason,
          'finlab_execution_preview_guard',
        )
        continue
      }
    }
    const executableVolume = Number(currentOhlc?.totalVolume ?? 0)
    const rawFilledShares = applyPartialFill(shares, fillPrice, executableVolume, cfg)
    shares = normalizeTwFilledSharesForRequestedOrder(requestedShares, rawFilledShares)
    if (shares <= 0) {
      recordActiveExecutionStatus(
        pending.symbol,
        'submitted',
        'paper_partial_fill_below_tradeable_lot',
        `requested=${requestedShares};raw_filled=${rawFilledShares}`,
      )
      continue
    }
    const isPartialFill = shares < requestedShares
    const filledOrderLegs = buildTwOrderLegs(shares)

    const txValue = fillPrice * shares
    if (txValue < minPosVal) {
      console.log('[Intraday] txValue below minimum', pending.symbol, txValue, minPosVal)
      continue
    }
    const commission = calcCommission(txValue, cfg)
    const totalCost = txValue + commission
    if (totalCost > acc.cash || dailyBuyTotal + totalCost > DAILY_BUY_LIMIT) continue
    const brokerReconciliation = buildPaperBrokerReconciliation({
      intent: orderIntent,
      finlabPreview: finLabExecutionPreview,
      simulatedFill: {
        fillable: true,
        fillPrice,
        shares,
        reason: isPartialFill ? 'paper_order_partial_fill' : 'paper_order_created',
      },
      l5: {
        bestAsk: finLabL5Quote?.bestAsk ?? currentOhlc?.ask ?? null,
        bestBid: finLabL5Quote?.bestBid ?? currentOhlc?.bid ?? null,
        spreadPct: finLabL5Quote?.spreadPct ?? null,
        orderBookImbalance: finLabL5Quote?.orderBookImbalance ?? null,
      },
    })
    await recordPaperExecutionEvent(env, {
      tradeDate: today,
      symbol: pending.symbol,
      side: 'buy',
      eventType: 'paper_broker_reconciliation',
      status: brokerReconciliation.status,
      reason: brokerReconciliation.mismatches[0] ?? brokerReconciliation.simulatedFillReason,
      detail: {
        ...brokerReconciliation.detail,
        expected_slippage_pct: brokerReconciliation.expectedSlippagePct,
        mismatches: brokerReconciliation.mismatches,
        live_submit_enabled: false,
      },
      pendingRunId,
      source: 'paper_broker_reconciliation',
    })

    const volPct = atr14 / fillPrice
    const regimeLabel = await getCurrentSltpRegime(env.KV)
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
      const intentReason = intent.reason ?? 'duplicate_buy_intent'
      console.log(`[Intraday] ${pending.symbol}: buy intent unavailable, skip reason=${intentReason}`)
      recordExecutionEvent(pending.symbol, 'skipped', intentReason)
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
            allocation_action: allocatorDecision.action,
            allocation_reason: allocatorDecision.reason,
            allocation_target_exposure: allocatorDecision.targetExposure,
            allocation_target_slot: Math.round(allocatorDecision.targetSlotValue),
            allocation_target_position: Math.round(allocatorDecision.targetPositionValue),
            allocation_current_position: Math.round(allocatorDecision.currentPositionValue),
            allocation_budget_cap: Math.round(allocatorDecision.budgetCap),
            allocation_replace_symbol: allocatorDecision.replaceSymbol ?? null,
            allocation_replace_weakness: allocatorDecision.replaceWeaknessScore ?? null,
            allocation_candidate_rank: allocatorDecision.candidateRank ?? null,
            stop_pct: stopPct,
            atr14,
            budget: Math.round(budget),
            fill_type: 'limit_intraday',
            raw_limit_price: rawLimitPrice,
            normalized_limit_price: limitPrice,
            price_tick: getTwTickSize(limitPrice),
            requested_shares: requestedShares,
            requested_order_legs: orderIntent.orderLegs,
            filled_order_legs: filledOrderLegs,
            partial_fill: isPartialFill,
            quote_bid: currentOhlc?.bid ?? null,
            quote_ask: currentOhlc?.ask ?? null,
            quote_bid_volume: currentOhlc?.bidVolume ?? null,
            quote_ask_volume: currentOhlc?.askVolume ?? null,
            quote_total_volume: currentOhlc?.totalVolume ?? null,
            slippage_ticks: cfg.position.fillSlippageTicks ?? 1,
            market_price: price,
            pre_trade_action: preTrade.action,
            pre_trade_reason: preTrade.reason,
            market_risk_level: marketRisk.risk_level,
            market_risk_change_rate: marketRisk.change_rate ?? null,
            market_risk_reasons: marketRisk.risk_reasons ?? [],
            quote_source: currentOhlc?.source ?? 'none',
            order_intent: orderIntent,
            intraday_technical_decision: intradayTechnicalDecision,
            finlab_preview_status: finLabExecutionPreview?.status ?? null,
            finlab_preview_reason: finLabExecutionPreview?.visible_reason ?? null,
            paper_broker_reconciliation_status: brokerReconciliation.status,
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
    await completePaperBuyIntent(env, intent.intentKey, isPartialFill ? 'partial' : 'filled', autoOrderId?.id ?? null)
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
      status: isPartialFill ? 'partial' : 'filled',
      reason: isPartialFill ? 'paper_order_partial_fill' : 'paper_order_created',
      detail: {
        intent_key: intent.intentKey,
        requested_shares: requestedShares,
        shares,
        requested_order_legs: orderIntent.orderLegs,
        filled_order_legs: filledOrderLegs,
        raw_limit_price: rawLimitPrice,
        normalized_limit_price: limitPrice,
        price_tick: getTwTickSize(limitPrice),
        fill_price: fillPrice,
        total_cost: totalCost,
        quote_bid: currentOhlc?.bid ?? null,
        quote_ask: currentOhlc?.ask ?? null,
        quote_total_volume: currentOhlc?.totalVolume ?? null,
      },
      orderId: autoOrderId?.id ?? null,
      source: 'auto_ml',
    })

    ;(acc as any).cash -= totalCost
    dailyBuyTotal += totalCost
    sectorCountMap.set(recSector, (sectorCountMap.get(recSector) ?? 0) + 1)

    try {
      const recRow = await env.DB.prepare(
        `SELECT score_components
           FROM daily_recommendations
          WHERE date=? AND symbol=?`,
      ).bind(today, pending.symbol).first<any>()
      if (recRow) {
        const scoreV2 = readScoreV2Snapshot(recRow)
        if (!scoreV2) {
          console.warn(`[PaperEntry] missing Score V2 payload for decision log: ${pending.symbol}`)
        } else {
          const decisionScoreComponents = JSON.stringify({
            ...scoreV2.payload,
            finalScore: scoreV2.finalScore,
            alphaAdjustment: scoreV2.alphaAdjustment,
          })
          await env.DB.prepare(`
            INSERT OR REPLACE INTO decision_logs
              (date, symbol, action, score_components, ml_signal, ml_confidence,
               debate_verdict, debate_summary, market_risk, sector, entry_price)
            VALUES (?, ?, 'BUY', ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            today,
            pending.symbol,
            decisionScoreComponents,
            pending.signal,
            pending.confidence,
            pending.debate_verdict ?? null,
            null,
            marketRisk?.risk_level ?? null,
            recSector,
            fillPrice,
          ).run()
        }
      }
    } catch (e) {
      console.warn('[L2] Decision log failed:', e)
    }

    const lotTag = isOddLot ? ' [odd-lot]' : ''
    console.log(`[Intraday] filled ${pending.symbol} ${shares}${lotTag} @ ${fillPrice} (mkt ${price})`)
    void sendDiscordNotification(
      (env as any).DISCORD_WEBHOOK_URL,
      `Auto buy filled: ${pending.symbol} ${pending.name}\n${shares}${lotTag} @ $${fillPrice} (mkt ${price})\nSL $${initialStop.toFixed(1)} | TP1 $${tp1Price.toFixed(1)} | TP2 $${tp2Price.toFixed(1)}`,
    )

    if (isPartialFill) {
      recordActiveExecutionStatus(
        pending.symbol,
        'partially_filled',
        'paper_order_partial_fill',
        `requested=${requestedShares};filled=${shares};remaining=${requestedShares - shares}`,
      )
    } else {
      recordExecutionEvent(pending.symbol, 'filled', 'paper_order_created')
    }
    stateChanged = true
  }

  if (executionEvents.length > 0) {
    await markPendingBuyExecutionEvents(env, today, pendingBuys, executionEvents, { stage: 'intraday_check', execution_events: executionAuditEvents })
  } else if (stateChanged) {
    await persistPendingBuyActiveState(env, today, pendingBuys, { stage: 'intraday_check', execution_events: executionAuditEvents })
  } else if (executionAuditEvents.length > 0) {
    await recordPendingBuyAuditOnly(env, today, pendingRunId, 'intraday_check', executionAuditEvents)
  }
}
