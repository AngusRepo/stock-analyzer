export type PartialFillRemainingAction = 'keep' | 'cancel' | 'expire'

export interface PartialFillRemainingPolicyInput {
  requestedShares: number
  filledShares: number
  remainingShares: number
  lastPrice: number
  minPositionValue: number
  intradayOpen: boolean
}

export interface PartialFillRemainingPolicyDecision {
  action: PartialFillRemainingAction
  reason: string
}

export function evaluatePartialFillRemainingPolicy(input: PartialFillRemainingPolicyInput): PartialFillRemainingPolicyDecision {
  const remainingShares = Number(input.remainingShares)
  const lastPrice = Number(input.lastPrice)
  if (!Number.isFinite(remainingShares) || remainingShares <= 0) {
    return { action: 'expire', reason: 'no_remaining_shares' }
  }
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
    return { action: 'keep', reason: 'remaining_order_price_unknown' }
  }
  if (!input.intradayOpen) {
    return { action: 'expire', reason: 'partial_fill_remaining_session_closed' }
  }
  const minPositionValue = Math.max(0, Number(input.minPositionValue) || 0)
  if (remainingShares * lastPrice < minPositionValue) {
    return { action: 'cancel', reason: 'remaining_below_min_position_value' }
  }
  return { action: 'keep', reason: 'remaining_order_pending_same_session' }
}
