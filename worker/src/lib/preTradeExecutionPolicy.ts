export type PreTradeAction = 'BUY_AT' | 'REQUOTE' | 'DEFER' | 'SKIP'

export type QuoteSource = 'shioaji' | 'yahoo' | 'none'

export interface PreTradeMomentumContext {
  volumeRatio?: number | null
  minVolumeRatio?: number
  slope5min?: number | null
  rangePosition?: number | null
  minRangePosition?: number
  error?: string | null
}

export interface PreTradePolicyConfig {
  limitUpPct: number
  requoteDeviationMax: number
  requoteDiscount: number
  requoteStopFallback: number
  maxRetries?: number
}

export interface PreTradeExecutionInput {
  symbol: string
  currentPrice: number
  entryPrice: number
  stopLoss?: number | null
  originalEntry?: number | null
  retryCount?: number | null
  previousClose?: number | null
  quoteSource: QuoteSource
  marketRiskLevel?: string | null
  momentum?: PreTradeMomentumContext | null
  policy: PreTradePolicyConfig
}

export interface PreTradeExecutionDecision {
  action: PreTradeAction
  reason: string
  limitPrice?: number
  nextEntryPrice?: number
  nextStopLoss?: number | null
  retryCount?: number
}

const DANGEROUS_RISK_LEVELS = new Set(['high', 'orange', 'red', 'black', 'extreme'])

function roundPrice(value: number): number {
  return Math.round(value * 100) / 100
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
    return { action: 'DEFER', reason: `volume_ratio_low:${momentum.volumeRatio.toFixed(2)}` }
  }
  if (momentum?.slope5min != null && momentum.slope5min < 0) {
    return { action: 'DEFER', reason: `falling_5min:${(momentum.slope5min * 100).toFixed(2)}%` }
  }
  if (momentum?.rangePosition != null && momentum.rangePosition < (momentum.minRangePosition ?? 0.3)) {
    return { action: 'DEFER', reason: `range_position_low:${(momentum.rangePosition * 100).toFixed(0)}%` }
  }

  if (currentPrice > entryPrice) {
    return { action: 'DEFER', reason: 'price_above_entry' }
  }

  return { action: 'BUY_AT', reason: 'pre_trade_pass', limitPrice: entryPrice }
}
