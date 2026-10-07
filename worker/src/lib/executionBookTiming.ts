/** Minted by the Worker transport, never copied from the broker payload. */
export interface ExecutionBookTimingReceipt {
  requestStartedAtMs: number
  responseReceivedAtMs: number
  quoteAgeMs: number
  sourceAgeMs: number
}

export function nonNegativeAge(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Broker ages use its clock; all elapsed/transport time uses the Worker clock.
 * Charging the entire round trip gives a conservative upper bound on age.
 */
export function executionBookTimingAges(receipt: ExecutionBookTimingReceipt, nowMs: number): {
  quoteAgeMs: number; sourceAgeMs: number; elapsedUpperBoundMs: number
} | null {
  if (![receipt.requestStartedAtMs, receipt.responseReceivedAtMs, nowMs].every(Number.isFinite)
    || receipt.responseReceivedAtMs < receipt.requestStartedAtMs || nowMs < receipt.responseReceivedAtMs
    || nonNegativeAge(receipt.quoteAgeMs) == null || nonNegativeAge(receipt.sourceAgeMs) == null) return null
  const elapsedUpperBoundMs = nowMs - receipt.requestStartedAtMs
  return {
    quoteAgeMs: receipt.quoteAgeMs + elapsedUpperBoundMs,
    sourceAgeMs: receipt.sourceAgeMs + elapsedUpperBoundMs,
    elapsedUpperBoundMs,
  }
}

export function twDateAt(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)
}
