/** One KV checkpoint per finalizer run and cache mode, shared by the queue finalizer and the manual
 * strategy-learning-finalize trigger. A completed stage is reused by the next attempt of either path, so a retry
 * resumes at the stage that failed instead of re-running every earlier heavy stage back to back (11/21: a manual
 * 11-10 finalize recomputed all of them and overloaded learning-db at route_backfill_eligibility). */
export type StrategyLearningFinalizerCacheMode = 'policy-mutation' | 'evidence-only'

const FINALIZER_CACHE_TTL_SECONDS = 7 * 24 * 3600

export function strategyLearningFinalizerCacheKey(
  triggerTime: string,
  canonicalRunId: string,
  finalizerCacheMode: StrategyLearningFinalizerCacheMode,
): string {
  return `strategy-learning:finalizer:${triggerTime}:${canonicalRunId}:${finalizerCacheMode}:v5-known-date-publication-fence`
}

export async function openStrategyLearningFinalizerCache(kv: KVNamespace, input: {
  runDate: string
  canonicalRunId: string
  policyMutationAllowed: boolean
  /** Ignore stored stages (a retry after repair must recompute on the repaired rows); persist still overwrites. */
  fresh?: boolean
}) {
  const mode: StrategyLearningFinalizerCacheMode = input.policyMutationAllowed ? 'policy-mutation' : 'evidence-only'
  const key = strategyLearningFinalizerCacheKey(input.runDate, input.canonicalRunId, mode)
  const cached = input.fresh ? null : await kv.get(key, 'json') as { canonical_run_id?: string; stages?: Record<string, unknown> } | null
  const stages: Record<string, unknown> = !input.fresh && cached?.canonical_run_id === input.canonicalRunId
    ? { ...(cached.stages ?? {}) }
    : {}
  const persist = async (stage: string, result: unknown): Promise<void> => {
    stages[stage] = result ?? null
    await kv.put(key, JSON.stringify({
      canonical_run_id: input.canonicalRunId,
      run_date: input.runDate,
      mode,
      stages,
      updated_at: new Date().toISOString(),
    }), { expirationTtl: FINALIZER_CACHE_TTL_SECONDS })
  }
  return { mode, stages, persist }
}
