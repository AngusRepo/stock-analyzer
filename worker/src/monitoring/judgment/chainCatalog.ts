// Copied from worker/src/lib/opsChainStageCatalog.ts (P2b, contract section "P2b 擴充"): the chain ids, each
// chain's period, and the first scheduled stage's deadline (a period with no row after it is missed). The stage
// rows themselves carry their own expected_by; this module only knows what judging an absent period needs, so
// the monitoring Worker never bundles the writer. monitoringEndpoints.test.ts checks periodKeyFor and the
// deadlines against a table taken from the writer's functions.
import type { ChainScope } from './executionChainDag'

export const CHAIN_IDS = ['daily_readiness', 'intraday_guard', 'weekly_research', 'monthly_artifact'] as const
export type ChainId = typeof CHAIN_IDS[number]

export type ChainSpec = {
  chainId: ChainId
  /** The panel scope (executionChainDag SCOPES) the chain's stages come from. */
  scope: ChainScope['id']
  /** 'trading_day': business_date is a TW trading day (closed days have no rows). 'week' / 'month': business_date
   * is the period key (periodKeyFor) and the period runs on non-trading days. */
  period: 'trading_day' | 'week' | 'month'
  /** The catalog's first stage, and its deadline on the business date (Taiwan "HH:MM"): the missed cut-off. */
  firstStage: string
  firstDeadlineTw: string
  /** History and timeline of a period chain: its last N periods (retention: weekly 35 days, monthly 70 days). */
  historyPeriods: number
  /** The catalog's repeating stage (`repeat: true`) and the Taiwan time its schedule ends: between the first
   * deadline and then, a row whose updated_at stops moving is a stalled guard (chainAlerts). */
  repeat?: { stageId: string; windowEndTw: string }
  /** The catalog's watcher stages (`watcher: true`): expected_by is the first result's deadline and completed_at the
   * last result, so they get no ETA margin and are overdue only while they have no result (chain.ts). */
  watchers?: readonly string[]
}

/** The writer refreshes a repeating stage's row at most this often while its status is unchanged
 * (opsChainStageState.ts CHAIN_STAGE_HEARTBEAT_MIN_MS, the `refresh` statement's cut-off). */
export const REPEAT_REFRESH_MIN_MS = 5 * 60_000
/** A repeating stage's row older than two refresh periods has stopped receiving results. */
export const REPEAT_STALL_AFTER_MS = 2 * REPEAT_REFRESH_MIN_MS

export const CHAIN_SPECS: Record<ChainId, ChainSpec> = {
  daily_readiness: { chainId: 'daily_readiness', scope: 'daily_readiness', period: 'trading_day', firstStage: 'market-close-refresh', firstDeadlineTw: '18:30', historyPeriods: 0 },
  // intraday-check runs every minute until 13:30 (infra/gcp-scheduler-jobs.json intraday-check-close-window, 0-30 5 UTC).
  intraday_guard: { chainId: 'intraday_guard', scope: 'intraday', period: 'trading_day', firstStage: 'intraday-check', firstDeadlineTw: '09:10', historyPeriods: 0,
    repeat: { stageId: 'intraday-check', windowEndTw: '13:30' }, watchers: ['intraday-check'] },
  weekly_research: { chainId: 'weekly_research', scope: 'weekly', period: 'week', firstStage: 'weekly-audit', firstDeadlineTw: '19:00', historyPeriods: 5 },
  monthly_artifact: { chainId: 'monthly_artifact', scope: 'monthly', period: 'month', firstStage: 'monthly-strategy-mining', firstDeadlineTw: '13:00', historyPeriods: 3 },
}

/** Whether a stage of a chain is a watcher (see ChainSpec.watchers). */
export function isWatcherStage(chainId: string, stageId: string): boolean {
  return isChainId(chainId) && (CHAIN_SPECS[chainId].watchers ?? []).includes(stageId)
}

export function isChainId(value: string): value is ChainId {
  return (CHAIN_IDS as readonly string[]).includes(value)
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
const dayIndex = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS
const dateOfIndex = (index: number) => new Date(index * DAY_MS).toISOString().slice(0, 10)

/** First `weekday` (0 = Sunday … 6 = Saturday) of the month of a YYYY-MM-DD date. */
function firstWeekdayOfMonth(date: string, weekday: number): string {
  const first = dayIndex(`${date.slice(0, 7)}-01`)
  // 1970-01-01 (index 0) was a Thursday (4).
  return dateOfIndex(first + ((weekday - (first + 4) % 7) + 7) % 7)
}

/** The business_date (period key) a stage run on TW date `twDate` belongs to: the date itself (trading-day chains),
 * the latest Friday on or before it (weekly_research), the first Saturday of its month (monthly_artifact). */
export function periodKeyFor(chainId: string, twDate: string): string | null {
  const chain = isChainId(chainId) ? CHAIN_SPECS[chainId] : undefined
  if (!chain || !DATE.test(twDate) || !Number.isFinite(dayIndex(twDate))) return null
  if (chain.period === 'week') {
    const index = dayIndex(twDate)
    return dateOfIndex(index - ((index + 4) % 7 - 5 + 7) % 7)
  }
  return chain.period === 'month' ? firstWeekdayOfMonth(twDate, 6) : twDate
}

/** The period before `key` of a week / month chain: the Friday a week earlier; the previous month's first Saturday. */
export function previousPeriodKey(chainId: ChainId, key: string): string | null {
  const chain = CHAIN_SPECS[chainId]
  if (chain.period === 'week') return dateOfIndex(dayIndex(key) - 7)
  if (chain.period === 'month') return periodKeyFor(chainId, dateOfIndex(dayIndex(`${key.slice(0, 7)}-01`) - 1))
  return null
}

/** The last `count` period keys ending at `key`, newest first. */
export function periodKeys(chainId: ChainId, key: string, count: number): string[] {
  const out = [key]
  while (out.length < count) {
    const previous = previousPeriodKey(chainId, out.at(-1)!)
    if (!previous) break
    out.push(previous)
  }
  return out
}
