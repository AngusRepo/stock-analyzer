import { SWING_POLICY_VERSION, type SwingEntryDecision } from './paperSwingPolicy'

/** The assessor owns the ceiling. Execution may refresh the book, never reprice this authorization. */
export function swingExecutionAuthorization(decision: SwingEntryDecision | undefined) {
  if (decision?.action !== 'pass' || decision.policy !== SWING_POLICY_VERSION
    || !decision.signalKey || !Number.isFinite(decision.signalMs)
    || decision.submitUntilMs !== decision.signalMs! + 60_000
    || ![decision.maxBuyPrice, decision.orHigh, decision.orLow].every(v => Number.isFinite(v) && v! > 0)) return null
  return Object.freeze({
    policy: decision.policy,
    signalKey: decision.signalKey,
    signalMs: decision.signalMs!,
    submitUntilMs: decision.submitUntilMs!,
    maxBuyPrice: decision.maxBuyPrice!,
    orHigh: decision.orHigh!,
    orLow: decision.orLow!,
  })
}

export type SwingExecutionAuthorization = NonNullable<ReturnType<typeof swingExecutionAuthorization>>

export function swingExecutionRejection(authorization: SwingExecutionAuthorization | null,
  input: { nowMs: number; fillPrice: number; limitPrice: number; limitUp: number }) {
  if (!authorization) return 'swing_execution_window_or_price_changed'
  if (!Number.isFinite(input.nowMs) || input.nowMs < authorization.signalMs
    || input.nowMs >= authorization.submitUntilMs) return 'swing_next_bar_submission_missed'
  if (![input.fillPrice, input.limitPrice, input.limitUp].every(v => Number.isFinite(v) && v > 0))
    return 'swing_execution_window_or_price_changed'
  if (Math.max(input.fillPrice, input.limitPrice) > authorization.maxBuyPrice) return 'swing_chase_limit'
  if (Math.max(input.fillPrice, input.limitPrice) >= input.limitUp) return 'swing_buy_at_limit'
  return null
}
