import type { PendingBuyStateSummary } from './pendingBuyStateSummary'

export function formatPendingBuyCronSummary(
  prefix: string,
  state: PendingBuyStateSummary,
  extra?: Record<string, string | number | boolean | null | undefined>,
): string {
  const exec = state.execution_counts
  const parts = [
    prefix,
    `state=${state.state}(${state.label})`,
    `active=${state.active_count}/${state.total_count}`,
    `debate_pending=${state.debate_counts.pending}`,
    `exec[pending=${exec.pending} filled=${exec.filled} skipped=${exec.skipped} cancelled=${exec.cancelled} expired=${exec.expired} rejected=${exec.rejected}]`,
  ]

  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value == null) continue
    parts.push(`${key}=${value}`)
  }

  return parts.join('; ')
}
