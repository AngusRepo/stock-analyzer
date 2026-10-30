export type FinLabDispatchFenceResult = {
  ignored: boolean
  reason: 'stale_run_id' | 'stale_dispatch_attempt' | null
  incomingAttempt: number
  activeAttempt: number
}

/** Highest dispatch_attempt the controller accepts (ml-controller/routers/finlab.py dispatch_attempt le=5). */
export const FINLAB_DISPATCH_ATTEMPT_MAX = 5

function boundedAttempt(value: unknown): number {
  const attempt = Math.floor(Number(value) || 1)
  return Math.max(1, Math.min(FINLAB_DISPATCH_ATTEMPT_MAX, attempt))
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

/**
 * The FinLab job reports a composition fail-closed (daily_inference_composition_*) only in the canonical
 * apply blockers of the callback result; the run log keeps it as a summary field the watchdog can read.
 */
export function finLabCompositionBlockerSuffix(result: unknown): string {
  const perDataset = (result as { canonical_d1_apply?: { per_dataset?: unknown } } | null)?.canonical_d1_apply?.per_dataset
  const reasons = new Set<string>()
  for (const dataset of perDataset && typeof perDataset === 'object' ? Object.values(perDataset) : []) {
    const blockers = (dataset as { blockers?: unknown } | null)?.blockers
    for (const blocker of Array.isArray(blockers) ? blockers : []) {
      const reason = (blocker as { kind?: unknown; reason?: unknown } | null)
      if (reason?.kind === 'daily_inference_composition' && typeof reason.reason === 'string'
        && /^[a-z0-9_]+$/.test(reason.reason)) reasons.add(reason.reason)
    }
  }
  return reasons.size ? ` composition_blockers=${[...reasons].sort().join(',')}` : ''
}
