/** Dispatch-to-completion wall time for this exact indicator run, not its finalizer. */
export function indicatorQueueDurationMs(meta: unknown, date: string, runId: string, completedAt: number): number | null {
  if (!meta || typeof meta !== 'object') return null
  const value = meta as Record<string, unknown>
  if (value.run_id !== runId || value.trigger_time !== date || typeof value.started_at !== 'string') return null
  const startedAt = Date.parse(value.started_at)
  return Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt
    ? completedAt - startedAt : null
}
