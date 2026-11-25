// The /obs page polls the events report, the deploy-gate pill and data quality every 60s and
// scheduler status every 3-15s. A poll that opts in (cache=ui) may take a result another request
// in this isolate read less than OBS_UI_REUSE_MAX_AGE_MS ago. Only finished, successful results
// are kept, as copies, so no request awaits another request's I/O. Calls without the opt-in,
// including every CD and release gate call, read fresh.
export const OBS_UI_REUSE_MAX_AGE_MS = 30_000

const recentReads = new Map<string, { readAt: number; value: unknown }>()

export async function obsRecentRead<T>(
  key: string,
  read: () => Promise<T>,
  options: { reuse: boolean; maxAgeMs?: number },
): Promise<T> {
  if (options.reuse) {
    const recent = recentReads.get(key)
    if (recent && Date.now() - recent.readAt <= (options.maxAgeMs ?? OBS_UI_REUSE_MAX_AGE_MS)) {
      return structuredClone(recent.value) as T
    }
  }
  const value = await read()
  const readAt = Date.now()
  for (const [staleKey, stale] of recentReads) {
    if (readAt - stale.readAt > OBS_UI_REUSE_MAX_AGE_MS) recentReads.delete(staleKey)
  }
  recentReads.set(key, { readAt, value: structuredClone(value) })
  return value
}

export function clearObsRecentReads(): void {
  recentReads.clear()
}
