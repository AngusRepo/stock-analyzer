import { evaluatePartialFillRemainingPolicy } from './partialFillRemainingPolicy'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const decision = evaluatePartialFillRemainingPolicy({
    requestedShares: 1000,
    filledShares: 800,
    remainingShares: 200,
    lastPrice: 100,
    minPositionValue: 30_000,
    intradayOpen: true,
  })
  assert(decision.action === 'cancel', 'remaining order below minimum tradable value should be cancelled')
  assert(decision.reason === 'remaining_below_min_position_value', 'cancel reason should be explicit')
}

{
  const decision = evaluatePartialFillRemainingPolicy({
    requestedShares: 2000,
    filledShares: 1000,
    remainingShares: 1000,
    lastPrice: 100,
    minPositionValue: 30_000,
    intradayOpen: true,
  })
  assert(decision.action === 'keep', 'same-session meaningful remaining order should stay active')
  assert(decision.reason === 'remaining_order_pending_same_session', 'keep reason should be explicit')
}

{
  const decision = evaluatePartialFillRemainingPolicy({
    requestedShares: 2000,
    filledShares: 1000,
    remainingShares: 1000,
    lastPrice: 100,
    minPositionValue: 30_000,
    intradayOpen: false,
  })
  assert(decision.action === 'expire', 'remaining order should expire after intraday session closes')
  assert(decision.reason === 'partial_fill_remaining_session_closed', 'expiry reason should be explicit')
}
