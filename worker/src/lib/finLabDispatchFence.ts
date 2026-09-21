export type FinLabDispatchFenceResult = {
  ignored: boolean
  reason: 'stale_run_id' | 'stale_dispatch_attempt' | null
  incomingAttempt: number
  activeAttempt: number
}

function boundedAttempt(value: unknown): number {
  const attempt = Math.floor(Number(value) || 1)
  return Math.max(1, Math.min(5, attempt))
}

export function resolveFinLabDispatchFence(params: {
  activeRunId?: string | null
  activeSummary?: string | null
  incomingRunId?: string | null
  incomingAttempt?: unknown
}): FinLabDispatchFenceResult {
  const incomingAttempt = boundedAttempt(params.incomingAttempt)
  const currentAttemptMatch = String(params.activeSummary ?? '').match(/(?:^|\s)dispatch_attempt=([^\s;]+)/)
  const activeAttempt = boundedAttempt(currentAttemptMatch?.[1])
  const staleRunId = Boolean(
    params.activeRunId &&
    params.incomingRunId &&
    params.activeRunId !== params.incomingRunId
  )
  const staleAttempt = Boolean(
    params.activeRunId === params.incomingRunId &&
    incomingAttempt < activeAttempt
  )
  return {
    ignored: staleRunId || staleAttempt,
    reason: staleRunId ? 'stale_run_id' : staleAttempt ? 'stale_dispatch_attempt' : null,
    incomingAttempt,
    activeAttempt,
  }
}

/** Preserve dispatch identity when a callback replaces the scheduler head. */
export function finLabCallbackSummary(summary: string, attempt: unknown, activeSummary?: string | null): string {
  const call = String(activeSummary ?? '').match(/(?:^|\s)function_call_id=([^\s;]+)/)?.[1]
  const clean = summary.replace(/(?:^|\s)(?:dispatch_attempt|function_call_id)=[^\s;]+/g, '').trim()
  return `${clean} dispatch_attempt=${boundedAttempt(attempt)}${call ? ` function_call_id=${call}` : ''}`
}
