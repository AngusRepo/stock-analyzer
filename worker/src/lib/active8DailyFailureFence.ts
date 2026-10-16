/** Operator-owned circuit breaker; never an accounting or success receipt. */
export const active8DailyFailureFenceKey = (day: string) => `active8:oof:daily:failure-fence:${day}`

export async function assertActive8DailyFailureFenceOpen(
  kv: Pick<KVNamespace, 'get'>,
  day: string,
): Promise<void> {
  const value = await kv.get(active8DailyFailureFenceKey(day), 'json') as Record<string, unknown> | null
  if (value == null) return
  if (value.schema_version !== 'active8-daily-failure-fence-v1'
      || value.business_date !== day || value.status !== 'blocked'
      || value.reason !== 'verified_cloud_run_terminal_failure'
      || !/^[a-f0-9]{64}$/.test(String(value.evidence_sha256 ?? ''))
      || !Array.isArray(value.failed_executions) || !value.failed_executions.length
      || value.failed_executions.some(name => typeof name !== 'string'
        || !/^active8-oof-materialize-[a-z0-9]+$/.test(name))) {
    throw new Error(`active8_daily_blocked:failure_fence_invalid:${day}`)
  }
  // Explicit repair must clear this fence after validation. A new watchdog
  // ticket or deployment must not silently reset a failed day's retry budget.
  throw new Error(`active8_daily_blocked:verified_cloud_run_failure_requires_repair:${day}:evidence=${value.evidence_sha256}`)
}
