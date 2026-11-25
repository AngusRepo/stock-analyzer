/** /v1/capacity: live size per D1 binding (SELECT 1 → meta.size_after, 0 rows read) and the 45-day growth
 * runway from storage_capacity_daily (primary-key range on observed_date). Reuses the main Worker's
 * inspectStorageCapacityTelemetry and buildStorageCapacityGrowthEstimate. */
import { buildStorageCapacityGrowthEstimate, inspectStorageCapacityTelemetry } from '../lib/storageCapacityTelemetry'
import { addDays, memoized, twDate, type MonitoringEnv } from './env'

export const CAPACITY_HISTORY_DAYS = 45
/** storage_capacity_daily gets one row per binding per day: read once an hour. */
export const CAPACITY_HISTORY_TTL_S = 3600
type HistoryRow = { binding_name: string; used_bytes: number; observed_date: string; observed_at: string }

export const CAPACITY_HISTORY_SQL = `SELECT binding_name, used_bytes, observed_date, observed_at
  FROM storage_capacity_daily
 WHERE observed_date >= ?
   AND date(observed_at, '+8 hours') = observed_date`
// No ORDER BY (a temp B-tree D1 bills as a second read of every row): sorted in JS, same order as the main Worker.

export async function capacityReport(env: MonitoringEnv, nowMs: number) {
  const observedDate = twDate(nowMs)
  const [rows, history] = await Promise.all([
    inspectStorageCapacityTelemetry(env as never),
    memoized(env.MEMO, `capacity-history|${observedDate}`, CAPACITY_HISTORY_TTL_S, async () =>
      (await env.OPS_DB.prepare(CAPACITY_HISTORY_SQL).bind(addDays(observedDate, -CAPACITY_HISTORY_DAYS)).all<HistoryRow>()).results ?? []),
  ])
  const ordered = history.sort((a, b) => a.observed_date.localeCompare(b.observed_date) || a.observed_at.localeCompare(b.observed_at))
  return {
    observed_date: observedDate,
    // The main Worker also drops history before each domain's backfill cutover (data_domain_backfill_cursors,
    // a GROUP BY SCAN); every cutover is older than this 45-day window, so the filter is not applied here.
    baseline_filter: 'not_applied_cutovers_precede_window',
    rows: rows.map((row) => {
      const points = ordered
        .filter((point) => point.binding_name === row.binding_name)
        .map((point) => ({ observed_date: point.observed_date, used_bytes: Number(point.used_bytes) }))
      points.push({ observed_date: observedDate, used_bytes: row.used_bytes })
      const estimate = buildStorageCapacityGrowthEstimate({ currentUsedBytes: row.used_bytes, maxBytes: row.max_bytes, history: points })
      return {
        ...row,
        forecast_status: estimate.status,
        observation_count: estimate.observation_count,
        daily_growth_bytes: estimate.daily_growth_bytes,
        projected_days_to_warning_65pct: estimate.projected_days_to_warning_65pct,
        projected_days_to_critical_90pct: estimate.projected_days_to_critical_90pct,
      }
    }),
  }
}
