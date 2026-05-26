export type PreTradeAction = 'BUY_AT' | 'REQUOTE' | 'DEFER' | 'SKIP'

export type QuoteSource = 'shioaji' | 'yahoo' | 'none'

export interface PreTradeMomentumContext {
  volumeRatio?: number | null
  minVolumeRatio?: number
  strongBreakoutVolumeRatio?: number
  slope5min?: number | null
  rangePosition?: number | null
  minRangePosition?: number
  strongBreakoutRangePosition?: number
  error?: string | null
}

export interface PreTradePolicyConfig {
  limitUpPct: number
  requoteDeviationMax: number
  requoteDiscount: number
  requoteStopFallback: number
  maxRetries?: number
  maxQuoteAgeMs?: number
  maxEntryChasePct?: number
  strongBreakoutMaxEntryChasePct?: number
}

export interface PreTradeOhlcvTradePlan {
  source?: 'ohlcv' | string | null
  mode?: 'breakout' | 'pullback' | string | null
  confirmation?: number | null
  resistance?: number | null
  support?: number | null
  atrDefense?: number | null
  volumeNode?: number | null
  buyReferenceLow?: number | null
  buyReferenceHigh?: number | null
  optimisticLow?: number | null
  optimisticHigh?: number | null
}

export interface PreTradeExecutionInput {
  symbol: string
  currentPrice: number
  entryPrice: number
  bestAsk?: number | null
  stopLoss?: number | null
  originalEntry?: number | null
  retryCount?: number | null
  previousClose?: number | null
  quoteAgeMs?: number | null
  quoteSource: QuoteSource
  marketRiskLevel?: string | null
  momentum?: PreTradeMomentumContext | null
  tradePlan?: PreTradeOhlcvTradePlan | null
  policy: PreTradePolicyConfig
}

export interface PreTradeExecutionDecision {
  action: PreTradeAction
  reason: string
  detail?: string | null
  limitPrice?: number
  nextEntryPrice?: number
  nextStopLoss?: number | null
  retryCount?: number
}

const DANGEROUS_RISK_LEVELS = new Set(['high', 'orange', 'red', 'black', 'extreme'])

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100
}

function formatQuoteAge(quoteAgeMs: number): string {
  const seconds = Math.max(0, Math.round(quoteAgeMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSeconds = seconds % 60
  return remainSeconds > 0 ? `${minutes}m${remainSeconds}s` : `${minutes}m`
}

function finitePositive(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function roundMetric(value: number, decimals = 4): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

function metricDetail(items: Array<[string, number | null | undefined]>): string {
  return items
    .filter(([, value]) => value != null && Number.isFinite(Number(value)))
    .map(([key, value]) => `${key}=${roundPrice(Number(value))}`)
    .join(';')
}

export function evaluatePreTradeExecution(input: PreTradeExecutionInput): PreTradeExecutionDecision {
  const currentPrice = Number(input.currentPrice)
  const entryPrice = Number(input.entryPrice)
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { action: 'DEFER', reason: 'invalid_current_price' }
  }
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { action: 'SKIP', reason: 'invalid_entry_price' }
  }

  if (input.quoteSource !== 'shioaji') {
    return { action: 'DEFER', reason: `untrusted_quote_source:${input.quoteSource}` }
  }
  const quoteAgeMs = Number(input.quoteAgeMs ?? 0)
  const maxQuoteAgeMs = Number(input.policy.maxQuoteAgeMs ?? 0)
  if (maxQuoteAgeMs > 0 && Number.isFinite(quoteAgeMs) && quoteAgeMs > maxQuoteAgeMs) {
    return { action: 'DEFER', reason: `stale_quote:${formatQuoteAge(quoteAgeMs)}` }
  }

  const previousClose = Number(input.previousClose ?? 0)
  if (previousClose > 0) {
    const changePct = (currentPrice - previousClose) / previousClose
    if (changePct >= input.policy.limitUpPct) {
      return { action: 'SKIP', reason: `limit_up_chase:${(changePct * 100).toFixed(1)}%` }
    }
  }

  const risk = String(input.marketRiskLevel ?? 'unknown').toLowerCase()
  if (!risk || risk === 'unknown') {
    return { action: 'DEFER', reason: 'market_risk_unknown' }
  }

  if (DANGEROUS_RISK_LEVELS.has(risk)) {
    const retryCount = Number(input.retryCount ?? 0)
    const maxRetries = input.policy.maxRetries ?? 3
    const originalEntry = Number(input.originalEntry ?? entryPrice)
    const deviationPct = Math.abs(entryPrice - originalEntry) / originalEntry
    if (retryCount >= maxRetries || deviationPct > input.policy.requoteDeviationMax) {
      return { action: 'SKIP', reason: `risk_requote_exhausted:${risk}` }
    }
    const nextEntryPrice = roundPrice(entryPrice * input.policy.requoteDiscount)
    const nextStopLoss = input.stopLoss != null
      ? roundPrice(Number(input.stopLoss) * input.policy.requoteDiscount)
      : roundPrice(nextEntryPrice * input.policy.requoteStopFallback)
    return {
      action: 'REQUOTE',
      reason: `market_risk_${risk}`,
      nextEntryPrice,
      nextStopLoss,
      retryCount: retryCount + 1,
    }
  }

  const momentum = input.momentum
  if (momentum?.error) {
    return { action: 'DEFER', reason: `momentum_unavailable:${momentum.error}` }
  }
  if (momentum?.volumeRatio != null && momentum.volumeRatio < (momentum.minVolumeRatio ?? 0.8)) {
    return {
      action: 'DEFER',
      reason: 'volume_ratio_low',
      detail: `volume_ratio=${roundMetric(momentum.volumeRatio)};min_volume_ratio=${roundMetric(momentum.minVolumeRatio ?? 0.8)}`,
    }
  }
  if (momentum?.slope5min != null && momentum.slope5min < 0) {
    return {
      action: 'DEFER',
      reason: 'falling_5min',
      detail: `slope_5min=${roundMetric(momentum.slope5min)}`,
    }
  }
  if (momentum?.rangePosition != null && momentum.rangePosition < (momentum.minRangePosition ?? 0.3)) {
    return {
      action: 'DEFER',
      reason: 'range_position_low',
      detail: `range_position=${roundMetric(momentum.rangePosition)};min=${roundMetric(momentum.minRangePosition ?? 0.3)}`,
    }
  }

  const tradePlan = input.tradePlan?.source === 'ohlcv' ? input.tradePlan : null
  if (tradePlan) {
    const support = finitePositive(tradePlan.support)
    const atrDefense = finitePositive(tradePlan.atrDefense)
    const confirmation = finitePositive(tradePlan.confirmation)
    const optimisticHigh = finitePositive(tradePlan.optimisticHigh ?? tradePlan.resistance)
    const buyReferenceHigh = finitePositive(tradePlan.buyReferenceHigh ?? tradePlan.volumeNode ?? tradePlan.support)
    const mode = String(tradePlan.mode ?? '').toLowerCase()

    if ((support != null && currentPrice < support) || (atrDefense != null && currentPrice < atrDefense)) {
      return {
        action: 'DEFER',
        reason: 'ohlcv_support_lost',
        detail: metricDetail([
          ['current', currentPrice],
          ['support', support],
          ['atr_defense', atrDefense],
        ]),
      }
    }
    if (mode === 'breakout' && confirmation != null && currentPrice < confirmation) {
      return {
        action: 'DEFER',
        reason: 'waiting_for_ohlcv_confirmation',
        detail: metricDetail([
          ['current', currentPrice],
          ['confirmation', confirmation],
        ]),
      }
    }
    if (mode === 'pullback' && buyReferenceHigh != null && confirmation != null && currentPrice > buyReferenceHigh && currentPrice < confirmation) {
      return {
        action: 'DEFER',
        reason: 'between_buy_reference_and_confirmation',
        detail: metricDetail([
          ['current', currentPrice],
          ['buy_reference_high', buyReferenceHigh],
          ['confirmation', confirmation],
        ]),
      }
    }
    if (optimisticHigh != null && currentPrice > optimisticHigh) {
      return {
        action: 'DEFER',
        reason: 'price_above_ohlcv_optimistic_range',
        detail: metricDetail([
          ['current', currentPrice],
          ['optimistic_high', optimisticHigh],
          ['confirmation', confirmation],
        ]),
      }
    }
  }

  if (currentPrice > entryPrice) {
    const maxEntryChasePct = Number(input.policy.maxEntryChasePct ?? 0)
    const strongBreakoutMaxEntryChasePct = Number(input.policy.strongBreakoutMaxEntryChasePct ?? maxEntryChasePct)
    const bestAsk = finitePositive(input.bestAsk)
    const chaseLimit = bestAsk ?? currentPrice
    const chasePremiumPct = (chaseLimit - entryPrice) / entryPrice
    const strongBreakoutOk =
      (momentum?.volumeRatio != null && momentum.volumeRatio >= (momentum.strongBreakoutVolumeRatio ?? 1.5)) &&
      (momentum?.slope5min != null && momentum.slope5min > 0) &&
      (momentum?.rangePosition != null && momentum.rangePosition >= (momentum.strongBreakoutRangePosition ?? 0.7)) &&
      (!tradePlan || finitePositive(tradePlan.confirmation) == null || currentPrice >= Number(tradePlan.confirmation))
    const allowedChasePct = strongBreakoutOk
      ? Math.max(maxEntryChasePct, strongBreakoutMaxEntryChasePct)
      : maxEntryChasePct
    const chaseMomentumOk =
      (momentum?.volumeRatio == null || momentum.volumeRatio >= (momentum.minVolumeRatio ?? 0.8)) &&
      (momentum?.slope5min == null || momentum.slope5min >= 0) &&
      (momentum?.rangePosition == null || momentum.rangePosition >= (momentum.minRangePosition ?? 0.3))
    if (allowedChasePct > 0 && chasePremiumPct >= 0 && chasePremiumPct <= allowedChasePct) {
      if (chaseMomentumOk) {
        return {
          action: 'BUY_AT',
          reason: `${strongBreakoutOk && chasePremiumPct > maxEntryChasePct ? 'strong_breakout_chase_confirmed' : 'entry_chase_confirmed'}:${(chasePremiumPct * 100).toFixed(2)}%`,
          limitPrice: roundPrice(chaseLimit),
        }
      }
    }
    return {
      action: 'DEFER',
      reason: 'price_above_entry',
      detail: [
        `current=${roundPrice(currentPrice)}`,
        `entry=${roundPrice(entryPrice)}`,
        bestAsk != null ? `bestAsk=${roundPrice(bestAsk)}` : null,
        `premium=${roundMetric(chasePremiumPct)}`,
        `max=${roundMetric(allowedChasePct)}`,
        `normal_max=${roundMetric(maxEntryChasePct)}`,
        `strong_breakout=${strongBreakoutOk ? '1' : '0'}`,
      ].filter(Boolean).join(';'),
    }
  }

  return { action: 'BUY_AT', reason: 'pre_trade_pass', limitPrice: entryPrice }
}
