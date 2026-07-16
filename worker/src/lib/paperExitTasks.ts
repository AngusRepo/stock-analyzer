import type { Bindings } from '../types'
import { formatTradeNotification, sendDiscordNotification } from './notify'
import { checkExitConditions, type ExitDecision } from './paperExitPolicy'
import { batchGetExecutionOrderbooks, batchGetIntradayOHLC, type IntradayOHLC } from './paperIntradayData'
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
import { resolveTwEquityPriceBand } from './twEquityMarketContract'
import { buildTwOrderLegs } from './twMarketRules'
import { resolveAuthoritativeSellExecutionSnapshot, type AuthoritativeExecutionSnapshot } from './authoritativeExecutionSnapshot'
import { runLiveExecutionShadow } from './liveExecutionShadow'
import { matchPaperOrderAgainstAuthoritativeDepth } from './paperOrderBookMatcher'
import { resolveTwEquitySessionPhase } from './twEquityMarketContract'
import { checkCircuitBreakers } from './pendingBuyOrchestrator'
import {
  aggregateCompletedS12Bars,
  applyS12TakeoverContinuity,
  assessS12IntradayStructureFromBaseBars,
  buildS12LongPositionStopPlan,
  resolveS12PositionDecision,
  s12TimingPolicyFromEnv,
  type S12IntradayAssessment,
  type S12UnifiedDecision,
} from './s12IntradayStructure'
import { loadS12IntradayBaseBars } from './s12RuntimeBars'
import {
  applyS12TwCalibrationArtifact,
  listApprovedS12TwCalibrationArtifacts,
  resolveS12TwCalibrationArtifact,
} from './s12TwEquityCalibration'
import { persistS12StructureSnapshot } from './s12StructureSnapshots'
import {
  getCurrentRegime as getCurrentSltpRegime,
  getTradingConfig,
  resolveSltpForRegime,
  type TradingConfig,
} from './tradingConfig'
import {
  extractTwEquityExitFusionAnchorsFromOrderNote,
  isTwEquityExitFusionEligible,
  migrateCanonicalLifecycleExitFusionV2,
  resolveTwEquityExitFusionV2,
} from './twEquityExitFusion'

const ACCOUNT_ID = 1
const S12_HOLDING_DEFENSE_EVENT_MIN_INTERVAL_MS = 10 * 60_000
const S12_M15_MS = 15 * 60_000

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

function parseJsonObject(value: unknown): Record<string, any> | null {
  if (!value) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null
  } catch {
    return null
  }
}

function lifecycleS12ExitPlanFromPosition(pos: { trade_lifecycle_json?: unknown }): Record<string, any> | null {
  const lifecycle = parseJsonObject(pos.trade_lifecycle_json)
  if (lifecycle?.version !== 'canonical_trade_lifecycle_v1') return null
  const plan = lifecycle.entry?.s12?.exitPlan
  return plan && typeof plan === 'object' && !Array.isArray(plan) ? plan as Record<string, any> : null
}

function lifecycleS12StopFromPosition(pos: { trade_lifecycle_json?: unknown }): {
  price: number
  source: string | null
  method: string | null
} | null {
  if (!isTwEquityExitFusionEligible(pos.trade_lifecycle_json)) return null
  const lifecycle = parseJsonObject(pos.trade_lifecycle_json)
  if (lifecycle?.version !== 'canonical_trade_lifecycle_v1') return null
  const s12 = lifecycle.entry?.s12
  const plan = s12?.exitPlan
  const candidates = [
    plan?.trailingInitial,
    s12?.structureStop,
    lifecycle.entry?.stopLoss,
  ]
  const price = candidates.map(positiveNumber).find((value): value is number => value != null)
  if (price == null) return null
  return {
    price,
    source: String(plan?.trailingSource ?? 'canonical_trade_lifecycle').trim() || 'canonical_trade_lifecycle',
    method: String(plan?.trailingMethod ?? 'lifecycle_s12_structural_stop').trim() || 'lifecycle_s12_structural_stop',
  }
}

function lifecycleFusionTargetsFromPosition(pos: {
  trade_lifecycle_json?: unknown
  entry_order_note?: unknown
}, exitCalibration: import('./s12TwEquityCalibration').S12TwExitCalibration | null = null) {
  return resolveTwEquityExitFusionV2(
    pos.trade_lifecycle_json,
    extractTwEquityExitFusionAnchorsFromOrderNote(pos.entry_order_note),
    exitCalibration,
  )
}

function withLifecycleS12ExitInputs<T extends Record<string, any>>(pos: T): T {
  const plan = lifecycleS12ExitPlanFromPosition(pos)
  const fusionTargets = lifecycleFusionTargetsFromPosition(pos)
  const lifecycleStop = lifecycleS12StopFromPosition(pos)
  const existingStop = positiveNumber(pos.s12_position_stop_price)
  const stopPrice = existingStop ?? lifecycleStop?.price ?? null
  return {
    ...pos,
    s12_position_stop_price: stopPrice,
    s12_position_stop_source: pos.s12_position_stop_source ?? lifecycleStop?.source ?? null,
    s12_position_stop_method: pos.s12_position_stop_method ?? lifecycleStop?.method ?? null,
    tp1_price: pos.tp1_price ?? positiveNumber(plan?.tp1),
    tp2_price: pos.tp2_price ?? positiveNumber(plan?.mainExit),
    tp3_price: pos.tp3_price ?? positiveNumber(plan?.tp3),
    tp4_price: pos.tp4_price ?? positiveNumber(plan?.tp4),
    s12_tp1_source: pos.s12_tp1_source ?? plan?.tp1Source ?? null,
    s12_pressure_tp1: pos.s12_pressure_tp1 ?? fusionTargets.nearPressureTp1,
    s12_pressure_tp1_source: pos.s12_pressure_tp1_source ?? fusionTargets.nearPressureTp1Source,
    fusion_runner_tp1: pos.fusion_runner_tp1 ?? fusionTargets.runnerTp1,
    fusion_runner_tp1_source: pos.fusion_runner_tp1_source ?? fusionTargets.runnerTp1Source,
    s12_main_exit_source: pos.s12_main_exit_source ?? plan?.mainExitSource ?? null,
    planned_take_profit: pos.planned_take_profit ?? plan?.plannedTakeProfit ?? null,
  }
}

function resolveEffectiveS12PositionStop(pos: Record<string, any>, minimumStop?: number | null): number | null {
  const enriched = withLifecycleS12ExitInputs(pos)
  const candidates = [
    positiveNumber(enriched.s12_position_stop_price),
    positiveNumber(enriched.trailing_stop),
    positiveNumber(minimumStop),
  ].filter((value): value is number => value != null)
  return candidates.length > 0 ? Math.max(...candidates) : null
}

function s12TrailingSourceFromReason(reason: string): { source: string; method: string } {
  if (reason.includes('bearish_defense')) {
    return { source: 's12_bearish_defense', method: 's12_bearish_defense_tighten_stop' }
  }
  if (reason.includes('tp1')) {
    return { source: 's12_tp1_profit_lock', method: 's12_tp1_move_stop_to_structure_or_entry' }
  }
  if (reason.includes('position_structural_stop')) {
    return { source: 's12_position_structural_stop', method: 's12_structure_trailing_stop_v1' }
  }
  return { source: 's12_holding_defense', method: 's12_structure_trailing_stop_v1' }
}

function updateLifecycleS12TrailingStop(
  raw: unknown,
  nextTrailingStop: number | null,
  reason: string,
): string | null {
  const stop = positiveNumber(nextTrailingStop)
  if (stop == null) return typeof raw === 'string' ? raw : null
  const lifecycle = parseJsonObject(raw)
  if (lifecycle?.version !== 'canonical_trade_lifecycle_v1') return typeof raw === 'string' ? raw : null

  const next = JSON.parse(JSON.stringify(lifecycle)) as Record<string, any>
  const { source, method } = s12TrailingSourceFromReason(reason)
  next.owners = {
    ...(next.owners ?? {}),
    exit: 'tw_equity_exit_fusion_v2',
    fallbackExit: 'paper_sltp_atr_trailing_v1',
  }
  next.entry = next.entry && typeof next.entry === 'object' ? next.entry : {}
  next.entry.s12 = next.entry.s12 && typeof next.entry.s12 === 'object' ? next.entry.s12 : {}
  next.entry.s12.exitPlan = next.entry.s12.exitPlan && typeof next.entry.s12.exitPlan === 'object' ? next.entry.s12.exitPlan : {}
  next.entry.s12.structureStop = Math.max(positiveNumber(next.entry.s12.structureStop) ?? 0, stop)
  next.entry.s12.exitPlan.trailingInitial = stop
  next.entry.s12.exitPlan.trailingSource = next.entry.s12.exitPlan.trailingSource ?? source
  next.entry.s12.exitPlan.trailingMethod = next.entry.s12.exitPlan.trailingMethod ?? method
  next.exit = next.exit && typeof next.exit === 'object' ? next.exit : {}
  next.exit.trailingStop = stop
  next.exit.fallbackOwner = 'paper_sltp_atr_trailing_v1'
  return JSON.stringify(next)
}

export function resolveS12HoldingDefenseEventAction(reason: string | null | undefined): S12HoldingDefenseEventAction {
  const text = String(reason ?? '')
  if (text.includes('take_profit_or_tighten_stop') || text.includes('TAKE_PROFIT_OR_TIGHTEN_STOP')) return 'take_profit_or_tighten_stop'
  if (text.includes('trim_or_take_profit') || text.includes('TRIM_OR_TAKE_PROFIT')) return 'trim_or_take_profit'
  if (text.includes('quote_unavailable')) return 'quote_unavailable'
  if (text.includes('full_exit') || text.includes('reverse_bos')) return 'full_exit'
  if (text.includes('profit_protect')) return 'take_profit'
  if (text.includes('take_profit') || text.includes('tp1') || text.includes('tp2')) return 'take_profit'
  if (text.includes('structural_stop')) return 'tighten_stop'
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
  const nextLifecycleJson = updateLifecycleS12TrailingStop(pos.trade_lifecycle_json, positiveNumber(nextTrailingStop), decision.reason)
  const changed =
    nextTrailingStop !== pos.trailing_stop ||
    nextHighest !== pos.highest_since_entry ||
    nextTp2 !== pos.tp2_price ||
    (nextLifecycleJson != null && nextLifecycleJson !== pos.trade_lifecycle_json)

  if (!changed) return

  await env.DB.prepare(`
    UPDATE paper_positions
    SET trailing_stop=?, highest_since_entry=?, tp2_price=?,
        trade_lifecycle_json=COALESCE(?, trade_lifecycle_json),
        updated_at=datetime('now')
    WHERE account_id=? AND symbol=?
  `).bind(
    nextTrailingStop,
    nextHighest,
    nextTp2,
    nextLifecycleJson,
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
): { fillable: boolean; price?: number; reason: string; detail: Record<string, unknown> } {
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

function buildSellShadowSnapshots(
  shares: number,
  books: { boardLot?: IntradayOHLC | null; oddLot?: IntradayOHLC | null },
  limitPrice: number,
  maxAgeMs: number,
): Partial<Record<'board_lot' | 'odd_lot', AuthoritativeExecutionSnapshot>> {
  const snapshots: Partial<Record<'board_lot' | 'odd_lot', AuthoritativeExecutionSnapshot>> = {}
  for (const leg of buildTwOrderLegs(shares)) {
    const quote = leg.lotType === 'odd_lot' ? books.oddLot : books.boardLot
    snapshots[leg.lotType] = resolveAuthoritativeSellExecutionSnapshot({
      limitPrice,
      lotType: leg.lotType,
      maxAgeMs,
      observations: quote
        ? [{
            source: 'shioaji_hub',
            lotType: quote.lotType ?? leg.lotType,
            bid: quote.bid ?? null,
            ask: quote.ask ?? null,
            bidVolume: quote.bidVolume ?? null,
            askVolume: quote.askVolume ?? null,
            bidPrices: quote.bidPrices ?? [],
            askPrices: quote.askPrices ?? [],
            bidVolumes: quote.bidVolumes ?? [],
            askVolumes: quote.askVolumes ?? [],
            volumeUnit: quote.volumeUnit,
            sourceTime: quote.quoteTime ?? null,
            receivedAt: quote.confirmationTime ?? null,
            ageMs: quote.confirmationTime ? Math.max(0, Date.now() - (parseTimeMs(quote.confirmationTime) ?? Date.now())) : quote.quoteAgeMs ?? null,
            sessionEpoch: quote.sessionEpoch ?? null,
          }]
        : [],
    })
  }
  return snapshots
}

export function resolvePositionExitSellFill(
  shares: number,
  books: { boardLot?: IntradayOHLC | null; oddLot?: IntradayOHLC | null },
  options: { maxAgeMs?: number; nowMs?: number } = {},
): { fillable: boolean; price?: number; filledShares?: number; complete?: boolean; reason: string; detail: Record<string, unknown> } {
  const legs = buildTwOrderLegs(shares)
  if (legs.length === 0) return { fillable: false, reason: 'invalid_exit_shares', detail: { shares } }

  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = Math.max(100, Number(options.maxAgeMs ?? 1500))
  const fills: Array<{ lot_type: 'board_lot' | 'odd_lot'; shares: number; price: number; reason: string; match: unknown; snapshot: AuthoritativeExecutionSnapshot }> = []
  const unfilled: Array<{ lot_type: 'board_lot' | 'odd_lot'; shares: number; reason: string; snapshot?: AuthoritativeExecutionSnapshot }> = []
  for (const leg of legs) {
    const quote = leg.lotType === 'odd_lot' ? books.oddLot : books.boardLot
    if (!quote || quote.lotType !== leg.lotType) {
      unfilled.push({
        lot_type: leg.lotType,
        shares: leg.shares,
        reason: leg.lotType === 'odd_lot' ? 'tw_equity_odd_lot_book_required' : 'tw_equity_board_lot_book_required',
      })
      continue
    }
    const visibleBidPrices = [...(quote.bidPrices ?? []), quote.bid ?? 0].filter((price) => price > 0)
    const limitPrice = visibleBidPrices.length > 0 ? Math.min(...visibleBidPrices) : 0
    const snapshot = resolveAuthoritativeSellExecutionSnapshot({
      limitPrice,
      lotType: leg.lotType,
      maxAgeMs,
      nowMs,
      observations: [{
        source: 'shioaji_hub', lotType: quote.lotType ?? leg.lotType,
        bid: quote.bid ?? null, ask: quote.ask ?? null,
        bidVolume: quote.bidVolume ?? null, askVolume: quote.askVolume ?? null,
        bidPrices: quote.bidPrices ?? [], askPrices: quote.askPrices ?? [],
        bidVolumes: quote.bidVolumes ?? [], askVolumes: quote.askVolumes ?? [],
        volumeUnit: quote.volumeUnit, sourceTime: quote.quoteTime ?? null,
        receivedAt: quote.confirmationTime ?? null,
        ageMs: quote.confirmationTime ? Math.max(0, Date.now() - (parseTimeMs(quote.confirmationTime) ?? Date.now())) : quote.quoteAgeMs ?? null,
        sessionEpoch: quote.sessionEpoch ?? null,
      }],
    })
    const match = matchPaperOrderAgainstAuthoritativeDepth({ snapshot, requestedShares: leg.shares, limitPrice })
    if (!['filled', 'partial'].includes(match.status) || match.averageFillPrice == null || match.filledShares <= 0) {
      unfilled.push({ lot_type: leg.lotType, shares: leg.shares, reason: match.reason, snapshot })
      continue
    }
    fills.push({ lot_type: leg.lotType, shares: match.filledShares, price: match.averageFillPrice, reason: match.reason, match, snapshot })
    if (match.restingShares > 0) unfilled.push({ lot_type: leg.lotType, shares: match.restingShares, reason: match.reason, snapshot })
  }

  const totalShares = fills.reduce((sum, fill) => sum + fill.shares, 0)
  if (totalShares <= 0) {
    return {
      fillable: false,
      reason: unfilled[0]?.reason ?? 'no_visible_exit_depth',
      detail: { shares, order_legs: legs, unfilled_legs: unfilled, execution_snapshot_at: new Date(nowMs).toISOString(), max_age_ms: maxAgeMs },
    }
  }
  const weightedPrice = fills.reduce((sum, fill) => sum + fill.price * fill.shares, 0) / totalShares
  const complete = totalShares >= shares
  return {
    fillable: true,
    filledShares: totalShares,
    complete,
    price: weightedPrice,
    reason: complete ? (fills.length > 1 ? 'tw_equity_split_lot_sell_fill' : `${fills[0].lot_type}_sell_fill`) : 'tw_equity_visible_depth_partial_exit',
    detail: {
      requested_shares: shares,
      filled_shares: totalShares,
      remaining_shares: shares - totalShares,
      order_legs: legs,
      leg_fills: fills,
      unfilled_legs: unfilled,
      execution_snapshot_at: new Date(nowMs).toISOString(),
      max_age_ms: maxAgeMs,
    },
  }
}

export function mergePendingExitAttemptDetail(
  previous: Record<string, unknown> | null,
  input: { reason: string; attemptedAt: string; detail: Record<string, unknown> },
): Record<string, unknown> {
  const previousCount = previous
    ? Math.max(1, Math.floor(Number(previous.attempt_count ?? 1)))
    : 0
  const previousHistory = Array.isArray(previous?.attempt_history) ? previous.attempt_history : []
  const unfilledLegs = Array.isArray(input.detail.unfilled_legs) ? input.detail.unfilled_legs : []
  const attempt = {
    attempted_at: input.attemptedAt,
    reason: input.reason,
    snapshot_at: input.detail.execution_snapshot_at ?? null,
    max_age_ms: input.detail.max_age_ms ?? null,
    snapshots: unfilledLegs.map((leg: any) => ({
      lot_type: leg?.lot_type ?? null,
      reason: leg?.reason ?? null,
      snapshot_id: leg?.snapshot?.snapshotId ?? null,
      status: leg?.snapshot?.status ?? null,
      snapshot_reason: leg?.snapshot?.reason ?? null,
      age_ms: leg?.snapshot?.ageMs ?? null,
      source_time: leg?.snapshot?.selectedSourceTime ?? null,
      received_at: leg?.snapshot?.selectedReceivedAt ?? null,
      session_epoch: leg?.snapshot?.sessionEpoch ?? null,
    })),
  }
  return {
    ...(previous ?? {}),
    ...input.detail,
    attempt_count: previousCount + 1,
    first_attempted_at: previous?.first_attempted_at ?? input.attemptedAt,
    last_attempted_at: input.attemptedAt,
    latest_attempt: attempt,
    attempt_history: [...previousHistory, attempt].slice(-20),
  }
}

async function recordPendingExitAttempt(
  env: Bindings,
  input: {
    tradeDate: string
    symbol: string
    reason: string
    source: string
    intentKey: string
    detail: Record<string, unknown>
  },
): Promise<boolean> {
  const supersededAt = new Date().toISOString()
  await env.DB.prepare(`
    UPDATE paper_execution_events
       SET status = 'superseded',
           reason = 'exit_intent_superseded_by_new_stop_version',
           detail_json = json_set(
             COALESCE(detail_json, '{}'),
             '$.resolved_at', ?,
             '$.resolution_status', 'superseded',
             '$.superseded_by_exit_intent_key', ?
           )
     WHERE trade_date = ?
       AND symbol = ?
       AND side = 'sell'
       AND event_type = 'paper_order'
       AND status = 'pending'
       AND source IN ('intraday_exit', 'intraday_tp1')
       AND json_extract(detail_json, '$.exit_intent_key') <> ?
  `).bind(
    supersededAt,
    input.intentKey,
    input.tradeDate,
    input.symbol,
    input.intentKey,
  ).run()
  const existing = await env.DB.prepare(`
    SELECT id, detail_json
      FROM paper_execution_events
     WHERE trade_date = ?
       AND symbol = ?
       AND side = 'sell'
       AND event_type = 'paper_order'
       AND status = 'pending'
       AND json_extract(detail_json, '$.exit_intent_key') = ?
     ORDER BY id DESC
     LIMIT 1
  `).bind(input.tradeDate, input.symbol, input.intentKey).first<{ id: number; detail_json?: string | null }>()
  const attemptedAt = new Date().toISOString()
  let previous: Record<string, unknown> | null = null
  try {
    previous = existing?.detail_json ? JSON.parse(existing.detail_json) as Record<string, unknown> : null
  } catch {
    previous = null
  }
  const detail = mergePendingExitAttemptDetail(previous, {
    reason: input.reason,
    attemptedAt,
    detail: { ...input.detail, exit_intent_key: input.intentKey },
  })
  if (existing?.id) {
    await env.DB.prepare(`
      UPDATE paper_execution_events
         SET reason = ?, detail_json = ?, source = ?
       WHERE id = ? AND status = 'pending'
    `).bind(input.reason, JSON.stringify(detail), input.source, existing.id).run()
    return false
  }
  await recordPaperExecutionEvent(env, {
    tradeDate: input.tradeDate,
    symbol: input.symbol,
    side: 'sell',
    eventType: 'paper_order',
    status: 'pending',
    reason: input.reason,
    detail,
    source: input.source,
  })
  return true
}

async function resolvePendingExitIntent(
  env: Bindings,
  input: { tradeDate: string; symbol: string; intentKey: string; status: 'filled' | 'partial'; orderId: number },
): Promise<void> {
  await env.DB.prepare(`
    UPDATE paper_execution_events
       SET status = ?, reason = ?, order_id = ?,
           detail_json = json_set(
             COALESCE(detail_json, '{}'),
             '$.resolved_at', ?,
             '$.resolution_status', ?,
             '$.resolution_order_id', ?
           )
     WHERE trade_date = ?
       AND symbol = ?
       AND side = 'sell'
       AND event_type = 'paper_order'
       AND status = 'pending'
       AND json_extract(detail_json, '$.exit_intent_key') = ?
  `).bind(
    input.status,
    `exit_intent_${input.status}`,
    input.orderId,
    new Date().toISOString(),
    input.status,
    input.orderId,
    input.tradeDate,
    input.symbol,
    input.intentKey,
  ).run()
  await env.DB.prepare(`
    UPDATE paper_execution_events
       SET status = 'superseded',
           reason = 'exit_intent_superseded_by_position_resolution',
           detail_json = json_set(
             COALESCE(detail_json, '{}'),
             '$.resolved_at', ?,
             '$.resolution_status', 'superseded',
             '$.superseded_by_exit_intent_key', ?
           )
     WHERE trade_date = ?
       AND symbol = ?
       AND side = 'sell'
       AND event_type = 'paper_order'
       AND status = 'pending'
       AND source IN ('intraday_exit', 'intraday_tp1')
       AND json_extract(detail_json, '$.exit_intent_key') <> ?
  `).bind(
    new Date().toISOString(),
    input.intentKey,
    input.tradeDate,
    input.symbol,
    input.intentKey,
  ).run()
}

export function buildExitIntentKey(input: {
  accountId: number
  symbol: string
  entryDate: string
  shares: number
  stopVersion: number | null
  action: string
}): string {
  const stop = input.stopVersion == null ? 'none' : Number(input.stopVersion).toFixed(4)
  return [input.accountId, input.symbol, input.entryDate, input.shares, stop, input.action].join(':')
}

async function fetchFreshPositionExitBooks(
  symbol: string,
  shares: number,
  env: { SHIOAJI_PROXY_URL?: string; PROXY_SERVICE_TOKEN?: string },
): Promise<{ boardLot: IntradayOHLC | null; oddLot: IntradayOHLC | null }> {
  const normalizedShares = Math.max(0, Math.floor(Number(shares)))
  const [boardLotMap, oddLotMap] = await Promise.all([
    normalizedShares >= 1000
      ? batchGetExecutionOrderbooks([symbol], { ...env, marketDataLotType: 'board_lot' })
      : Promise.resolve(new Map<string, IntradayOHLC>()),
    normalizedShares % 1000 !== 0
      ? batchGetExecutionOrderbooks([symbol], { ...env, marketDataLotType: 'odd_lot' })
      : Promise.resolve(new Map<string, IntradayOHLC>()),
  ])
  return {
    boardLot: boardLotMap.get(symbol) ?? null,
    oddLot: oddLotMap.get(symbol) ?? null,
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
    s12_position_stop_price?: number | null
    s12_position_stop_source?: string | null
    s12_position_stop_method?: string | null
    s12_tp1_source?: string | null
    s12_pressure_tp1?: number | null
    s12_pressure_tp1_source?: string | null
    fusion_runner_tp1?: number | null
    fusion_runner_tp1_source?: string | null
    tp1_source?: string | null
    s12_main_exit_source?: string | null
    position_opened_today?: boolean | null
    trade_lifecycle_json?: unknown
  }
  currentPrice: number
  atr14: number
  assessment: S12IntradayAssessment | null
  executableBookAvailable?: boolean
  tp1SellRatio?: number | null
}): ExitDecision | null {
  const pos = withLifecycleS12ExitInputs(params.pos)
  const s12Decision = resolveS12PositionDecision({
    assessment: params.assessment,
    currentPrice: params.currentPrice,
    executableBookAvailable: params.executableBookAvailable ?? true,
    atr14: params.atr14,
    tp1SellRatio: params.tp1SellRatio,
    pos,
  })
  return s12PositionDecisionToExitDecision(s12Decision, pos, params.currentPrice)
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
        exitIntentKind: 'take_profit',
        sellShares,
        moveStopToEntry: true,
        newHighest: highest,
      }
    }
    if (shares > 0) {
      return {
        action: 'full_sell',
        reason: `S12 ${decision.reason} @ ${currentPrice.toFixed(2)}`,
        exitIntentKind: 'take_profit',
        newHighest: highest,
      }
    }
  }
  if (decision.action === 'EXIT_ON_REVERSE_BOS') {
    return {
      action: 'full_sell',
      reason: `S12 ${decision.reason} @ ${currentPrice.toFixed(2)}`,
      exitIntentKind: 'risk_stop',
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
  if (decision.action === 'SET_STRUCTURAL_STOP' && decision.stopPrice != null) {
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
  if (s12Decision?.action === 'hold' && String(s12Decision.reason ?? '').includes('s12_position_structural_stop')) return s12Decision
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
  executionBooks: { boardLot?: IntradayOHLC | null; oddLot?: IntradayOHLC | null } = {},
): Promise<ExitDecision | null> {
  if (!enabledFlag((env as any).S12_INTRADAY_HOLDING_DEFENSE_ENABLED, true)) return null
  if (!isTwEquityExitFusionEligible(pos.trade_lifecycle_json)) return null
  try {
    const [latestEvent, stockRow, calibrationArtifacts] = await Promise.all([
      env.DB.prepare(`
        SELECT status, reason, detail_json, created_at
          FROM paper_execution_events
         WHERE account_id = ?
           AND symbol = ?
           AND trade_date = ?
           AND event_type = 's12_intraday_structure'
           AND source = 's12_holding_defense'
         ORDER BY id DESC
         LIMIT 1
      `).bind(ACCOUNT_ID, pos.symbol, tradeDate).first<any>(),
      env.DB.prepare('SELECT market FROM stocks WHERE symbol = ? LIMIT 1').bind(pos.symbol).first<{ market?: string | null }>(),
      listApprovedS12TwCalibrationArtifacts(env.DB).catch(() => []),
    ])
    const calibration = resolveS12TwCalibrationArtifact(calibrationArtifacts, {
      marketSegment: stockRow?.market ?? 'UNKNOWN',
      asOfDate: tradeDate,
    })
    const policy = applyS12TwCalibrationArtifact(s12TimingPolicyFromEnv(env as any), calibration)
    const s12Base = await loadS12IntradayBaseBars(
      env,
      pos.symbol,
      tradeDate,
      quote.last,
      Number(quote.totalVolume ?? 0),
    )
    const completed15m = aggregateCompletedS12Bars(s12Base.bars, S12_M15_MS, Date.now())
    const entryPrice = positiveNumber(pos.entry_price) ?? positiveNumber(pos.avg_cost) ?? 0
    const previousTrailingStop = positiveNumber(pos.trailing_stop)
    const lifecycleStop = lifecycleS12StopFromPosition(pos)
    const lifecycleExitPlan = lifecycleS12ExitPlanFromPosition(pos)
    const lifecycleFusionTargets = lifecycleFusionTargetsFromPosition(pos, calibration?.exit ?? null)
    const currentPositionTp1 = positiveNumber(pos.tp1_price)
    const legacyPressureTarget = lifecycleFusionTargets.nearPressureTp1
    const shouldMigrateLegacyTarget =
      lifecycleFusionTargets.runnerTp1 != null &&
      (
        lifecycleFusionTargets.recoveredAnchorCount > 0 ||
        currentPositionTp1 == null ||
        Math.abs(lifecycleFusionTargets.runnerTp1 - currentPositionTp1) >= 0.01 ||
        (
          currentPositionTp1 != null &&
          legacyPressureTarget != null &&
          Math.abs(currentPositionTp1 - legacyPressureTarget) < 0.01
        )
      )
    if (shouldMigrateLegacyTarget) {
      const migratedLifecycle = migrateCanonicalLifecycleExitFusionV2(pos.trade_lifecycle_json, lifecycleFusionTargets)
      await env.DB.prepare(`
        UPDATE paper_positions
           SET tp1_price=?,
               tp2_price=COALESCE(?, tp2_price),
               trade_lifecycle_json=COALESCE(?, trade_lifecycle_json),
               updated_at=datetime('now')
         WHERE account_id=? AND symbol=?
      `).bind(
        lifecycleFusionTargets.runnerTp1,
        lifecycleFusionTargets.runnerTp2,
        migratedLifecycle,
        ACCOUNT_ID,
        pos.symbol,
      ).run()
      pos.tp1_price = lifecycleFusionTargets.runnerTp1
      if (lifecycleFusionTargets.runnerTp2 != null) pos.tp2_price = lifecycleFusionTargets.runnerTp2
      pos.trade_lifecycle_json = migratedLifecycle ?? pos.trade_lifecycle_json
    }
    const computedPositionStop = buildS12LongPositionStopPlan({
      bars15m: completed15m,
      entryPrice,
      referencePrice: quote.last,
      policy,
      stopSource: policy.positionStopSource,
      minConfirmationBars: 1,
    })
    const effectiveStopCandidate = computedPositionStop ?? (
      lifecycleStop
        ? {
          price: lifecycleStop.price,
          source: 'adaptive' as const,
          method: lifecycleStop.method as any,
          zoneLow: null,
          zoneHigh: null,
          noAtrBuffer: true,
        }
        : null
    )
    const appliedPositionStopPrice = effectiveStopCandidate
      ? Math.max(previousTrailingStop ?? effectiveStopCandidate.price, effectiveStopCandidate.price)
      : null
    const positionStop = effectiveStopCandidate && appliedPositionStopPrice != null
      ? { ...effectiveStopCandidate, price: appliedPositionStopPrice }
      : null
    const rawAssessment = assessS12IntradayStructureFromBaseBars({
      symbol: pos.symbol,
      baseBars: s12Base.bars,
      fallback15mBars: s12Base.fallback15mBars,
      fallback4hBars: s12Base.fallback4hBars,
      fallbackDailyBars: s12Base.fallbackDailyBars,
      fallback1hBars: s12Base.fallback1hBars,
      nowMs: Date.now(),
      policy,
      barDiagnostics: {
        ...s12Base.diagnostics,
        calibration_artifact_id: calibration?.artifactId ?? null,
        calibration_scope: calibration?.scope ?? null,
      },
      h4ReferenceDate: s12Base.diagnostics.previous_daily_context_date,
      h4ReferenceClose: quote.referencePrice ?? s12Base.diagnostics.previous_daily_raw_close,
    })
    const assessment = applyS12TakeoverContinuity(rawAssessment, latestEvent?.detail_json)
    await persistS12StructureSnapshot(env, {
      tradeDate,
      symbol: pos.symbol,
      assessment,
      source: 's12_holding_defense',
      side: 'sell',
    })
    const positionShares = Math.max(0, Math.floor(Number(pos.shares ?? 0)))
    const requiresBoardLotBook = positionShares >= 1000
    const requiresOddLotBook = positionShares % 1000 !== 0
    const boardLotQuote = executionBooks.boardLot ?? (quote.lotType === 'board_lot' ? quote : null)
    const oddLotQuote = executionBooks.oddLot ?? (quote.lotType === 'odd_lot' ? quote : null)
    const boardLotBookAvailable = !requiresBoardLotBook || (
      boardLotQuote?.lotType === 'board_lot' && positiveNumber(boardLotQuote.bid) != null && positiveNumber(boardLotQuote.ask) != null
    )
    const oddLotBookAvailable = !requiresOddLotBook || (
      oddLotQuote?.lotType === 'odd_lot' && positiveNumber(oddLotQuote.bid) != null && positiveNumber(oddLotQuote.ask) != null
    )
    const executableBookAvailable = boardLotBookAvailable && oddLotBookAvailable
    const s12Position = {
      ...pos,
      s12_position_stop_price: positionStop?.price ?? null,
      s12_position_stop_source: computedPositionStop?.source ?? lifecycleStop?.source ?? positionStop?.source ?? null,
      s12_position_stop_method: computedPositionStop?.method ?? lifecycleStop?.method ?? positionStop?.method ?? null,
      tp1_price: pos.tp1_price ?? positiveNumber(lifecycleExitPlan?.tp1),
      tp2_price: pos.tp2_price ?? positiveNumber(lifecycleExitPlan?.mainExit),
      tp3_price: pos.tp3_price ?? positiveNumber(lifecycleExitPlan?.tp3),
      tp4_price: pos.tp4_price ?? positiveNumber(lifecycleExitPlan?.tp4),
      s12_tp1_source: lifecycleExitPlan?.tp1Source ?? null,
      s12_pressure_tp1: lifecycleFusionTargets.nearPressureTp1,
      s12_pressure_tp1_source: lifecycleFusionTargets.nearPressureTp1Source,
      fusion_runner_tp1: lifecycleFusionTargets.runnerTp1,
      fusion_runner_tp1_source: lifecycleFusionTargets.runnerTp1Source,
      tp1_source: lifecycleFusionTargets.runnerTp1Source,
      s12_main_exit_source: lifecycleExitPlan?.mainExitSource ?? null,
      position_opened_today: pos.entry_date === tradeDate,
      planned_take_profit: pos.planned_take_profit ?? lifecycleExitPlan?.plannedTakeProfit ?? null,
    }
    const s12Decision = resolveS12PositionDecision({
      assessment,
      currentPrice: quote.last,
      executableBookAvailable,
      atr14,
      tp1SellRatio: cfg.exit.tp1SellRatio,
      pos: s12Position,
    })
    const update = resolveS12HoldingDefenseUpdate({
      pos: s12Position,
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
        required_lot_types: [requiresBoardLotBook ? 'board_lot' : null, requiresOddLotBook ? 'odd_lot' : null].filter(Boolean),
        board_lot_book_available: boardLotBookAvailable,
        odd_lot_book_available: oddLotBookAvailable,
        position_exit_policy: 's12_primary_independent_of_long_entry_readiness',
        execution_owner: 's12_position_decision_v1',
        fallback_exit_owner: 'paper_sltp_atr_trailing_v1',
        bar_source: s12Base.source,
        bar_diagnostics: s12Base.diagnostics,
        calibration_artifact_id: calibration?.artifactId ?? null,
        position_stop_trailing: positionStop
          ? {
            mode: 's12_structure_trailing_stop_v1',
            candidate_price: computedPositionStop?.price ?? null,
            lifecycle_price: lifecycleStop?.price ?? null,
            applied_price: positionStop.price,
            previous_trailing_stop: previousTrailingStop ?? null,
            source: computedPositionStop?.source ?? lifecycleStop?.source ?? positionStop.source,
            method: computedPositionStop?.method ?? lifecycleStop?.method ?? positionStop.method,
            zone_low: positionStop.zoneLow,
            zone_high: positionStop.zoneHigh,
            no_atr_buffer: true,
            trailing_rule: 'never_loosen_max_existing',
            auto_trade_adaptation: computedPositionStop
              ? 'recompute_15m_structure_below_current_price'
              : 'preserve_canonical_lifecycle_s12_stop_until_new_15m_structure',
          }
          : {
            mode: 's12_structure_trailing_stop_v1',
            candidate_price: null,
            lifecycle_price: lifecycleStop?.price ?? null,
            applied_price: null,
            previous_trailing_stop: previousTrailingStop ?? null,
            no_atr_buffer: true,
            trailing_rule: 'never_loosen_max_existing',
            auto_trade_adaptation: 'preserve_canonical_lifecycle_s12_stop_until_new_15m_structure',
          },
      },
    }
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
      const referencePrice = quote.referencePrice ?? prevCloseRow.close
      const priceBand = resolveTwEquityPriceBand(referencePrice)
      if (priceBand.limitDown != null && price <= priceBand.limitDown) {
        await recordPaperExecutionEvent(env, {
          tradeDate: today,
          symbol: pos.symbol,
          side: 'sell',
          eventType: 'paper_order',
          status: 'pending',
          reason: 'tw_equity_limit_down_unfilled',
          detail: { current_price: price, reference_price: referencePrice, limit_down: priceBand.limitDown },
          source: 'force_day_trade_close',
        })
        continue
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

    const exitIntentKind = decision.exitIntentKind ?? 'forced_close'
    const dtCheck = await isDayTradeAllowed(pos.symbol, pos.shares, exitIntentKind, env.KV)
    if (!dtCheck.allowed) {
      await recordPaperExecutionEvent(env, {
        tradeDate: today,
        symbol: pos.symbol,
        side: 'sell',
        eventType: 'paper_order',
        status: 'blocked',
        reason: dtCheck.reason,
        detail: { shares: pos.shares, exit_reason: decision.reason, exit_intent_kind: exitIntentKind },
        source: 'force_day_trade_close',
      })
      continue
    }

    const shares = pos.shares
    if (Math.max(0, Math.floor(Number(shares))) % 1000 !== 0) {
      await recordPaperExecutionEvent(env, {
        tradeDate: today,
        symbol: pos.symbol,
        side: 'sell',
        eventType: 'paper_order',
        status: 'pending',
        reason: 'tw_equity_odd_lot_book_required',
        detail: { shares, exit_reason: decision.reason },
        source: 'daytrade_force_close',
      })
      continue
    }
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
            tp1_price, tp2_price, tp1_hit, original_shares, trade_lifecycle_json,
            (SELECT note FROM paper_orders po
              WHERE po.account_id=paper_positions.account_id
                AND po.symbol=paper_positions.symbol AND po.side='buy'
              ORDER BY po.id DESC LIMIT 1) AS entry_order_note
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
      const exitIntentKind = decision.exitIntentKind ?? 'risk_stop'
      const dtCheck = await isDayTradeAllowed(pos.symbol, pos.shares, exitIntentKind, env.KV)
      if (!dtCheck.allowed) {
        console.log(`[EODExit] daytrade blocked ${pos.symbol}: ${dtCheck.reason}`)
        await recordPaperExecutionEvent(env, {
          tradeDate: eodToday,
          symbol: pos.symbol,
          side: 'sell',
          eventType: 'paper_order',
          status: 'blocked',
          reason: dtCheck.reason,
          detail: { shares: pos.shares, exit_reason: decision.reason, exit_intent_kind: exitIntentKind },
          source: 'run_eod_exit',
        })
        continue
      }
      console.log(`[EODExit] daytrade sell ${pos.symbol}: ${dtCheck.reason}`)
      dayTradeSell = true
    }

    if (decision.action === 'full_sell') {
      const shares = pos.shares
      if (Math.max(0, Math.floor(Number(shares))) % 1000 !== 0) {
        await recordPaperExecutionEvent(env, {
          tradeDate: eodToday,
          symbol: pos.symbol,
          side: 'sell',
          eventType: 'paper_order',
          status: 'pending',
          reason: 'tw_equity_odd_lot_book_required',
          detail: { shares, exit_reason: decision.reason },
          source: 'eod_exit',
        })
        continue
      }
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
      const partialTrailingStop = resolveEffectiveS12PositionStop(pos, entryPx) ?? entryPx
      const partialLifecycleJson = updateLifecycleS12TrailingStop(pos.trade_lifecycle_json, partialTrailingStop, decision.reason)
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
            trade_lifecycle_json=COALESCE(?, trade_lifecycle_json),
            updated_at=datetime('now')
          WHERE account_id=? AND symbol=?
        `).bind(remainingShares, partialTrailingStop, partialTrailingStop, partialLifecycleJson, ACCOUNT_ID, pos.symbol),
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

export type IntradayStopLossPollResult = {
  status: 'healthy_empty' | 'ok' | 'partial'
  positions: number
  quoted: number
  missing_symbols: string[]
}

export async function pollIntradayStopLoss(env: Bindings): Promise<IntradayStopLossPollResult> {
  const cfg = await getTradingConfig(env.KV)
  const { results: positions } = await env.DB.prepare(
    `SELECT symbol, shares, avg_cost, name, entry_price, entry_date,
            initial_stop, trailing_stop, highest_since_entry, stop_multiplier,
            tp1_price, tp2_price, tp1_hit, original_shares, trade_lifecycle_json,
            (SELECT note FROM paper_orders po
              WHERE po.account_id=paper_positions.account_id
                AND po.symbol=paper_positions.symbol AND po.side='buy'
              ORDER BY po.id DESC LIMIT 1) AS entry_order_note
     FROM paper_positions WHERE account_id=? AND shares>0`,
  ).bind(ACCOUNT_ID).all<any>()

  if (!positions || positions.length === 0) {
    return { status: 'healthy_empty', positions: 0, quoted: 0, missing_symbols: [] }
  }

  const symbols = positions.map((p: any) => p.symbol)
  const boardLotSymbols = positions
    .filter((p: any) => Math.max(0, Math.floor(Number(p.shares ?? 0))) >= 1000)
    .map((p: any) => p.symbol)
  const oddLotSymbols = positions
    .filter((p: any) => Math.max(0, Math.floor(Number(p.shares ?? 0))) % 1000 !== 0)
    .map((p: any) => p.symbol)
  const quoteEnv = {
    SHIOAJI_PROXY_URL: (env as any).SHIOAJI_PROXY_URL,
    PROXY_SERVICE_TOKEN: (env as any).PROXY_SERVICE_TOKEN,
    requireBrokerQuote: true,
  }
  const executionMaxAgeMs = positiveNumber((env as any).EXECUTION_BOOK_MAX_AGE_MS) ?? 1500
  const [boardLotQuoteMap, oddLotQuoteMap] = await Promise.all([
    batchGetIntradayOHLC(boardLotSymbols, { ...quoteEnv, marketDataLotType: 'board_lot' }),
    batchGetIntradayOHLC(oddLotSymbols, { ...quoteEnv, marketDataLotType: 'odd_lot' }),
  ])
  const quoteMap = new Map<string, IntradayOHLC>()
  for (const pos of positions) {
    const shares = Math.max(0, Math.floor(Number(pos.shares ?? 0)))
    const quote = shares >= 1000 ? boardLotQuoteMap.get(pos.symbol) : oddLotQuoteMap.get(pos.symbol)
    if (quote) quoteMap.set(pos.symbol, quote)
  }
  const intradayToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const missingQuotePositions = positions.filter((pos: any) => !quoteMap.has(pos.symbol))
  const recordMissingHoldingQuote = async (pos: any): Promise<void> => {
    const shares = Math.max(0, Math.floor(Number(pos.shares ?? 0)))
    const recent = await env.DB.prepare(`
      SELECT id FROM paper_execution_events
      WHERE account_id=? AND trade_date=? AND symbol=?
        AND event_type='s12_intraday_structure'
        AND reason='holding_authoritative_market_data_unavailable'
        AND created_at >= datetime('now', '-10 minutes')
      LIMIT 1
    `).bind(ACCOUNT_ID, intradayToday, pos.symbol).first<{ id: number }>()
    if (recent) return
    await recordPaperExecutionEvent(env, {
      tradeDate: intradayToday,
      symbol: pos.symbol,
      side: 'sell',
      eventType: 's12_intraday_structure',
      status: 'blocked',
      reason: 'holding_authoritative_market_data_unavailable',
      detail: {
        stage: 'authoritative_holding_market_data',
        shares,
        required_lot_type: shares >= 1000 ? 'board_lot' : 'odd_lot',
        broker_quote_required: true,
        contract_bypass_allowed: false,
      },
      source: 's12_holding_defense',
    })
  }
  const atrMap = await batchGetATR(env.DB, symbols)
  const intraRegime = await getCurrentRegime(env.KV)

  if (quoteMap.size === 0) {
    await Promise.all(missingQuotePositions.map(recordMissingHoldingQuote))
    throw new Error('holding_authoritative_market_data_unavailable_all_positions')
  }

  await Promise.allSettled(
    [...quoteMap].map(([symbol, quote]) => putIntradayPrice(env.KV, symbol, quote.last, undefined, {
      source: quote.source ?? 'shioaji',
      quoteTime: quote.quoteTime ?? null,
    })),
  )

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
      {
        boardLot: boardLotQuoteMap.get(pos.symbol) ?? null,
        oddLot: oddLotQuoteMap.get(pos.symbol) ?? null,
      },
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
        const referencePrice = quote.referencePrice ?? prevC
        const priceBand = resolveTwEquityPriceBand(referencePrice)
        if (priceBand.limitDown != null && currentPrice <= priceBand.limitDown) {
          await recordPaperExecutionEvent(env, {
            tradeDate: intradayToday,
            symbol: pos.symbol,
            side: 'sell',
            eventType: 'paper_order',
            status: 'pending',
            reason: 'tw_equity_limit_down_unfilled',
            detail: { current_price: currentPrice, reference_price: referencePrice, limit_down: priceBand.limitDown },
            source: 'poll_intraday_stop_loss',
          })
          continue
        }
      }
    }

    let dayTradeSell = false
    if (pos.entry_date === intradayToday && decision.action !== 'hold') {
      const exitIntentKind = decision.exitIntentKind ?? 'risk_stop'
      const dtCheck = await isDayTradeAllowed(pos.symbol, pos.shares, exitIntentKind, env.KV)
      if (!dtCheck.allowed) {
        if (new Date().getUTCMinutes() % 10 === 0) {
          console.log(`[Intraday] daytrade blocked ${pos.symbol}: ${dtCheck.reason}`)
        }
        await recordPaperExecutionEvent(env, {
          tradeDate: intradayToday,
          symbol: pos.symbol,
          side: 'sell',
          eventType: 'paper_order',
          status: 'blocked',
          reason: dtCheck.reason,
          detail: { shares: pos.shares, exit_reason: decision.reason, exit_intent_kind: exitIntentKind },
          source: 'poll_intraday_stop_loss',
        })
        continue
      }
      dayTradeSell = true
    }

    if (decision.action === 'full_sell') {
      const requestedExitShares = pos.shares
      const exitIntentKey = buildExitIntentKey({
        accountId: ACCOUNT_ID,
        symbol: pos.symbol,
        entryDate: pos.entry_date,
        shares: requestedExitShares,
        stopVersion: resolveEffectiveS12PositionStop(pos, pos.entry_price ?? pos.avg_cost),
        action: decision.action,
      })
      const freshExecutionBooks = await fetchFreshPositionExitBooks(pos.symbol, requestedExitShares, quoteEnv)
      const executionSnapshotAtMs = Date.now()
      const sellFill = resolvePositionExitSellFill(requestedExitShares, freshExecutionBooks, {
        maxAgeMs: executionMaxAgeMs,
        nowMs: executionSnapshotAtMs,
      })
      if (!sellFill.fillable || sellFill.price == null) {
        await recordPendingExitAttempt(env, {
          tradeDate: intradayToday,
          symbol: pos.symbol,
          reason: sellFill.reason,
          intentKey: exitIntentKey,
          detail: { shares: requestedExitShares, exit_reason: decision.reason, ...sellFill.detail },
          source: 'intraday_exit',
        })
        continue
      }
      const shares = Math.max(0, Math.floor(sellFill.filledShares ?? requestedExitShares))
      const remainingExitShares = Math.max(0, requestedExitShares - shares)
      const sellFillPrice = sellFill.price
      const executionQuote = freshExecutionBooks.boardLot ?? freshExecutionBooks.oddLot ?? quote
      const sellOrderIntent = buildPaperSellOrderIntent({
        tradeDate: intradayToday,
        symbol: pos.symbol,
        shares,
        fillPrice: sellFillPrice,
        quote: executionQuote,
        reason: decision.reason,
        strategyType: 'intraday_exit',
      })
      const shadowReferencePrice = Number(executionQuote.referencePrice ?? quote.referencePrice ?? prevCloseMapSell.get(pos.symbol) ?? currentPrice)
      const shadowBand = resolveTwEquityPriceBand(shadowReferencePrice)
      const shadowPhase = resolveTwEquitySessionPhase()
      const executionShadow = await runLiveExecutionShadow({
        env: env as any,
        intent: sellOrderIntent,
        snapshots: buildSellShadowSnapshots(
          shares,
          {
            boardLot: freshExecutionBooks.boardLot,
            oddLot: freshExecutionBooks.oddLot,
          },
          sellFillPrice,
          executionMaxAgeMs,
        ),
        referencePrice: shadowBand.referencePrice,
        limitUp: shadowBand.limitUp ?? 0,
        limitDown: shadowBand.limitDown ?? 0,
        marketSessionOpen: shadowPhase === 'continuous',
        tradingDayConfirmed: sellOrderIntent.tradeDate === intradayToday,
        marketPhase: shadowPhase,
        source: 'paper_intraday_full_exit_pre_fill',
      })
      if (executionShadow.guardBlocked) continue
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
        remainingExitShares === 0
          ? env.DB.prepare('DELETE FROM paper_positions WHERE account_id=? AND symbol=?').bind(ACCOUNT_ID, pos.symbol)
          : env.DB.prepare(`UPDATE paper_positions SET shares=?, updated_at=datetime('now') WHERE account_id=? AND symbol=?`)
            .bind(remainingExitShares, ACCOUNT_ID, pos.symbol),
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
        status: remainingExitShares === 0 ? 'filled' : 'partial',
        reason: remainingExitShares === 0 ? 'intraday_exit' : 'intraday_exit_partial_depth',
        detail: { shares, requested_shares: requestedExitShares, remaining_shares: remainingExitShares, exit_intent_key: exitIntentKey, order_intent: sellOrderIntent, order_legs: sellOrderIntent.orderLegs, fill_price: sellFillPrice, market_price: currentPrice, proceeds, exit_reason: decision.reason, ...sellFill.detail },
        orderId,
        source: 'intraday_exit',
      })
      await resolvePendingExitIntent(env, {
        tradeDate: intradayToday,
        symbol: pos.symbol,
        intentKey: exitIntentKey,
        status: remainingExitShares === 0 ? 'filled' : 'partial',
        orderId,
      })
      console.warn(`[Intraday] full sell ${pos.symbol} ${shares} @ ${sellFillPrice} (mkt ${currentPrice}) ${decision.reason}`)
      const intradayPnl = calcRealizedPnlSnapshot({ entryPrice: entryPx, exitPrice: sellFillPrice, shares, commission, tax }).realized_pnl_pct / 100
      void sendDiscordNotification(
        env.DISCORD_WEBHOOK_URL,
        formatTradeNotification('sell', pos.symbol, pos.name, shares, sellFillPrice, `盤中賣出: ${decision.reason}`, intradayPnl),
      )
      if (remainingExitShares === 0) {
        await runPostExitDiscipline(env, cfg, pos.symbol, decision.reason, 'full_sell', 'Intraday')
      }
    } else if (decision.action === 'partial_sell' && decision.sellShares) {
      const requestedSellShares = Math.min(pos.shares, decision.sellShares)
      const exitIntentKey = buildExitIntentKey({
        accountId: ACCOUNT_ID,
        symbol: pos.symbol,
        entryDate: pos.entry_date,
        shares: requestedSellShares,
        stopVersion: resolveEffectiveS12PositionStop(pos, pos.entry_price ?? pos.avg_cost),
        action: decision.action,
      })
      const freshExecutionBooks = await fetchFreshPositionExitBooks(pos.symbol, requestedSellShares, quoteEnv)
      const executionSnapshotAtMs = Date.now()
      const sellFill = resolvePositionExitSellFill(requestedSellShares, freshExecutionBooks, {
        maxAgeMs: executionMaxAgeMs,
        nowMs: executionSnapshotAtMs,
      })
      if (!sellFill.fillable || sellFill.price == null) {
        await recordPendingExitAttempt(env, {
          tradeDate: intradayToday,
          symbol: pos.symbol,
          reason: sellFill.reason,
          intentKey: exitIntentKey,
          detail: { shares: requestedSellShares, exit_reason: decision.reason, ...sellFill.detail },
          source: 'intraday_tp1',
        })
        continue
      }
      const sellShares = Math.max(0, Math.floor(sellFill.filledShares ?? requestedSellShares))
      if (sellShares <= 0) continue
      const tp1Complete = sellShares >= requestedSellShares
      const fillPrice = sellFill.price
      const executionQuote = freshExecutionBooks.boardLot ?? freshExecutionBooks.oddLot ?? quote
      const sellOrderIntent = buildPaperSellOrderIntent({
        tradeDate: intradayToday,
        symbol: pos.symbol,
        shares: sellShares,
        fillPrice,
        quote: executionQuote,
        reason: decision.reason,
        strategyType: 'intraday_tp1',
      })
      const shadowReferencePrice = Number(executionQuote.referencePrice ?? quote.referencePrice ?? prevCloseMapSell.get(pos.symbol) ?? currentPrice)
      const shadowBand = resolveTwEquityPriceBand(shadowReferencePrice)
      const shadowPhase = resolveTwEquitySessionPhase()
      const executionShadow = await runLiveExecutionShadow({
        env: env as any,
        intent: sellOrderIntent,
        snapshots: buildSellShadowSnapshots(
          sellShares,
          {
            boardLot: freshExecutionBooks.boardLot,
            oddLot: freshExecutionBooks.oddLot,
          },
          fillPrice,
          executionMaxAgeMs,
        ),
        referencePrice: shadowBand.referencePrice,
        limitUp: shadowBand.limitUp ?? 0,
        limitDown: shadowBand.limitDown ?? 0,
        marketSessionOpen: shadowPhase === 'continuous',
        tradingDayConfirmed: sellOrderIntent.tradeDate === intradayToday,
        marketPhase: shadowPhase,
        source: 'paper_intraday_partial_exit_pre_fill',
      })
      if (executionShadow.guardBlocked) continue
      const txValue = fillPrice * sellShares
      const commission = calcCommission(txValue, cfg)
      const tax = calcTax(txValue, cfg, dayTradeSell)
      const proceeds = txValue - commission - tax
      const remainingShares = pos.shares - sellShares
      const entryPx = pos.entry_price ?? pos.avg_cost
      const partialTrailingStop = resolveEffectiveS12PositionStop(pos, entryPx) ?? entryPx
      const partialLifecycleJson = updateLifecycleS12TrailingStop(pos.trade_lifecycle_json, partialTrailingStop, decision.reason)
      const sellNote = buildSellOrderNote({
        reason: `[intraday] ${decision.reason}`,
        entry_date: pos.entry_date,
        order_intent: sellOrderIntent,
        order_legs: sellOrderIntent.orderLegs,
      }, { entryPrice: entryPx, exitPrice: fillPrice, shares: sellShares, commission, tax })

      await env.DB.batch([
        env.DB.prepare(`
          UPDATE paper_positions SET shares=?, tp1_hit=?,
            trailing_stop=CASE WHEN ? > COALESCE(trailing_stop, 0) THEN ? ELSE trailing_stop END,
            trade_lifecycle_json=COALESCE(?, trade_lifecycle_json),
            updated_at=datetime('now')
          WHERE account_id=? AND symbol=?
        `).bind(remainingShares, tp1Complete ? 1 : (pos.tp1_hit ?? 0), partialTrailingStop, partialTrailingStop, partialLifecycleJson, ACCOUNT_ID, pos.symbol),
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
        status: tp1Complete ? 'filled' : 'partial',
        reason: tp1Complete ? 'intraday_tp1' : 'intraday_tp1_partial_depth',
        detail: { shares: sellShares, requested_shares: requestedSellShares, exit_intent_key: exitIntentKey, order_intent: sellOrderIntent, order_legs: sellOrderIntent.orderLegs, remaining_shares: remainingShares, price: fillPrice, proceeds, exit_reason: decision.reason, ...sellFill.detail },
        orderId,
        source: 'intraday_tp1',
      })
      await resolvePendingExitIntent(env, {
        tradeDate: intradayToday,
        symbol: pos.symbol,
        intentKey: exitIntentKey,
        status: tp1Complete ? 'filled' : 'partial',
        orderId,
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

  if (missingQuotePositions.length > 0) {
    await Promise.all(missingQuotePositions.map(recordMissingHoldingQuote))
    console.warn(`[Intraday] partial holding quote coverage: missing=${missingQuotePositions.map((pos: any) => pos.symbol).join(',')}`)
  }

  console.log(`[Intraday] checked ${positions.length} positions with ${quoteMap.size} quotes`)
  return {
    status: missingQuotePositions.length > 0 ? 'partial' : 'ok',
    positions: positions.length,
    quoted: quoteMap.size,
    missing_symbols: missingQuotePositions.map((pos: any) => String(pos.symbol)),
  }
}
