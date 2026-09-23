import type { Bindings } from '../types'

const EVENING_WATCHDOGS = new Set(['screener-v2-watchdog', 'indicator-queue-watchdog'])

/** Select the original evening root, not a fresh midnight calendar date.
 * This does not authorize replay: the route and stage still enforce lineage fences.
 */
export async function resolveEveningWatchdogBusinessDate(
  env: Pick<Bindings, 'KV'>, task: string, requestedDate?: string, nowMs = Date.now(),
): Promise<string | undefined> {
  if (requestedDate || !EVENING_WATCHDOGS.has(task)) return requestedDate
  const taipei = new Date(nowMs + 8 * 3600_000)
  if (taipei.getUTCHours() >= 8) return undefined
  const priorDate = new Date(nowMs).toISOString().slice(0, 10)
  const root = await env.KV.get(`scheduler:run:evening-chain:${priorDate}`, 'json') as {
    run_id?: string; run_date?: string
  } | null
  if (!root?.run_id?.trim() || (root.run_date && root.run_date !== priorDate)) return undefined
  return priorDate
}
