// Admission budget: finish an in-flight verified archive/delete transaction before stopping.
// Future calls resume from remaining source rows and immutable release receipts.
export type DrainPass = {
  policy_id: string
  status: 'dry_run' | 'success' | 'error'
  backlog_remaining: boolean
  deleted_rows: number
}

export async function runRetentionDrainRounds<T extends DrainPass>(input: {
  policyIds: readonly string[]
  dryRun: boolean
  maxRounds?: number
  budgetMs?: number
  run: (policyId: string) => Promise<T>
  now?: () => number
}) {
  const bounded = (v: number | undefined, fallback: number, max: number) =>
    Number.isFinite(v) ? Math.max(1, Math.min(Math.floor(v!), max)) : fallback
  const maxRounds = input.dryRun ? 1 : bounded(input.maxRounds, 1, 10)
  const budgetMs = bounded(input.budgetMs, 60_000, 120_000)
  const now = input.now ?? (() => performance.now())
  const started = now()
  const attempts: T[] = []
  const latest = new Map<string, T>()
  let pending = [...new Set(input.policyIds)]
  let stopReason: 'complete' | 'preflight' | 'round_limit' | 'time_budget' | 'blocked_or_no_progress' = 'complete'
  for (let round = 0; round < maxRounds && pending.length; round++) {
    const next: string[] = []
    for (const id of pending) {
      if (now() - started >= budgetMs) { stopReason = 'time_budget'; break }
      const result = await input.run(id)
      attempts.push(result)
      latest.set(id, result)
      // Do not spin on failed readers, source changes, or zero-progress reconciliation.
      if (!input.dryRun && result.status === 'success'
          && result.backlog_remaining && result.deleted_rows > 0) next.push(id)
    }
    if (stopReason === 'time_budget') break
    pending = next
  }
  const unstarted = [...new Set(input.policyIds)].filter(id => !latest.has(id))
  const remaining = [...new Set(input.policyIds)].filter(id => {
    const result = latest.get(id)
    return !result || result.status === 'error' || result.backlog_remaining
  })
  if (stopReason !== 'time_budget') {
    stopReason = input.dryRun ? 'preflight' : pending.length ? 'round_limit'
      : remaining.length ? 'blocked_or_no_progress' : 'complete'
  }
  return { attempts, latest: [...latest.values()], pendingPolicyIds: remaining,
    unstartedPolicyIds: unstarted, stopReason, elapsedMs: Math.max(0, now() - started) }
}
