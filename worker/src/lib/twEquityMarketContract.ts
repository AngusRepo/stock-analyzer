import { getTwTickSize, snapToTwPriceTick, type TwOrderLotType } from './twMarketRules'

export type TwEquitySessionPhase =
  | 'closed'
  | 'pre_open'
  | 'continuous'
  | 'odd_lot_first_match'
  | 'close_window'
  | 'delayed_close'

export interface TwEquityTradingStatus {
  holiday?: boolean
  suspended?: boolean
  halted?: boolean
  disposition?: boolean
  fullCashDelivery?: boolean
  newlyListedNoLimit?: boolean
  corporateActionAdjusted?: boolean
  delayedClose?: boolean
}

export interface TwEquityPriceBand {
  referencePrice: number
  limitUp: number | null
  limitDown: number | null
  limitPct: number
  unrestricted: boolean
}

export interface TwEquityExecutionGate {
  allowed: boolean
  phase: TwEquitySessionPhase
  reason: string
  requiresDedicatedOddLotBook: boolean
}

const TW_OFFSET_MS = 8 * 60 * 60_000

function twParts(now: Date): { weekday: number; minuteOfDay: number } {
  const shifted = new Date(now.getTime() + TW_OFFSET_MS)
  return {
    weekday: shifted.getUTCDay(),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

export function resolveTwEquitySessionPhase(
  now = new Date(),
  status: Pick<TwEquityTradingStatus, 'holiday' | 'delayedClose'> = {},
): TwEquitySessionPhase {
  const { weekday, minuteOfDay } = twParts(now)
  if (weekday === 0 || weekday === 6 || status.holiday) return 'closed'
  if (minuteOfDay < 9 * 60) return minuteOfDay >= 8 * 60 + 30 ? 'pre_open' : 'closed'
  if (minuteOfDay <= 9 * 60 + 9) return 'continuous'
  if (minuteOfDay === 9 * 60 + 10) return 'odd_lot_first_match'
  if (minuteOfDay < 13 * 60) return 'continuous'
  if (minuteOfDay <= 13 * 60 + 30) return 'close_window'
  if (status.delayedClose && minuteOfDay <= 13 * 60 + 33) return 'delayed_close'
  return 'closed'
}

export function resolveTwEquityPriceBand(
  referencePrice: number,
  options: { limitPct?: number; unrestricted?: boolean } = {},
): TwEquityPriceBand {
  const reference = Number(referencePrice)
  const limitPct = Math.max(0, Math.min(0.2, Number(options.limitPct ?? 0.1)))
  const unrestricted = options.unrestricted === true
  if (!Number.isFinite(reference) || reference <= 0) {
    return { referencePrice: 0, limitUp: null, limitDown: null, limitPct, unrestricted }
  }
  if (unrestricted) {
    return { referencePrice: reference, limitUp: null, limitDown: null, limitPct, unrestricted }
  }
  return {
    referencePrice: reference,
    limitUp: snapToTwPriceTick(reference * (1 + limitPct), 'floor'),
    limitDown: snapToTwPriceTick(reference * (1 - limitPct), 'ceil'),
    limitPct,
    unrestricted,
  }
}

export function normalizeTwEquityStopPrice(price: number, band?: TwEquityPriceBand | null): number {
  const normalized = snapToTwPriceTick(price, 'floor')
  if (!band || band.unrestricted) return normalized
  return Math.max(band.limitDown ?? normalized, Math.min(band.limitUp ?? normalized, normalized))
}

export function normalizeTwEquityTargetPrice(price: number, band?: TwEquityPriceBand | null): number {
  const normalized = snapToTwPriceTick(price, 'ceil')
  if (!band || band.unrestricted) return normalized
  return Math.max(band.limitDown ?? normalized, Math.min(band.limitUp ?? normalized, normalized))
}

export function resolveTwEquityExecutionGate(params: {
  now?: Date
  lotType: TwOrderLotType
  marketDataLotType?: TwOrderLotType | null
  status?: TwEquityTradingStatus
}): TwEquityExecutionGate {
  const status = params.status ?? {}
  const now = params.now ?? new Date()
  const phase = resolveTwEquitySessionPhase(now, status)
  const requiresDedicatedOddLotBook = params.lotType === 'odd_lot'
  if (status.suspended || status.halted) {
    return { allowed: false, phase, reason: 'tw_equity_suspended_or_halted', requiresDedicatedOddLotBook }
  }
  if (status.disposition) {
    return { allowed: false, phase, reason: 'tw_equity_disposition_execution_block', requiresDedicatedOddLotBook }
  }
  if (status.fullCashDelivery) {
    return { allowed: false, phase, reason: 'tw_equity_full_cash_delivery_execution_block', requiresDedicatedOddLotBook }
  }
  if (!['continuous', 'odd_lot_first_match', 'close_window', 'delayed_close'].includes(phase)) {
    return { allowed: false, phase, reason: 'tw_equity_market_closed', requiresDedicatedOddLotBook }
  }
  if (requiresDedicatedOddLotBook && twParts(now).minuteOfDay < 9 * 60 + 10) {
    return { allowed: false, phase, reason: 'tw_equity_odd_lot_waiting_first_match', requiresDedicatedOddLotBook }
  }
  if (requiresDedicatedOddLotBook && params.marketDataLotType !== 'odd_lot') {
    return { allowed: false, phase, reason: 'tw_equity_odd_lot_book_required', requiresDedicatedOddLotBook }
  }
  return { allowed: true, phase, reason: 'tw_equity_execution_allowed', requiresDedicatedOddLotBook }
}

export function twEquityRiskTicks(entryPrice: number, stopPrice: number): number | null {
  const entry = Number(entryPrice)
  const stop = Number(stopPrice)
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry <= stop || stop <= 0) return null
  return Math.max(1, Math.round((entry - stop) / getTwTickSize(stop)))
}
