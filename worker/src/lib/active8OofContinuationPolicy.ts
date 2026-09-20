// Covers two queued eight-hour OOF runs plus the five-hour full-fit budget.
// This is a polling bound, never permission to redispatch training.
export const ACTIVE8_OOF_CONTINUATION_MAX_ATTEMPTS = 64

export function active8OofContinuationDelay(nextAttempt: number): number {
  if (!Number.isInteger(nextAttempt) || nextAttempt < 1 || nextAttempt > ACTIVE8_OOF_CONTINUATION_MAX_ATTEMPTS) {
    throw new Error('active8_oof_continuation_attempt_invalid')
  }
  return Math.min(1800, 300 * 2 ** Math.min(nextAttempt - 1, 3))
}
