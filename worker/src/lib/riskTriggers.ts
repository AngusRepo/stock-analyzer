/**
 * riskTriggers.ts — #28b Tier 1 event triggers (T1.2 / T1.3 / T1.4).
 *
 * Three risk-event detectors that enqueue Optuna re-tune requests to the
 * pending_optuna_queue. Each is idempotent same-day via optunaQueue.ts key
 * generation (reason:YYYY-MM-DD).
 *
 *   T1.2 detectRegimeShift   — called from regime-compute cron, reads KV
 *                              ml:regime before compute + compares new label
 *   T1.3 checkRollingSharpe  — called from daily-report cron, queries
 *                              paper_daily_snapshots.sharpe_30d latest vs
 *                              KV trading:config.risk.sharpe_rolling_threshold
 *   T1.4 checkDailyDrawdown  — called from daily-report cron, compares latest
 *                              two total_value rows in paper_daily_snapshots
 *                              against trading:config.risk.dd_spike_threshold
 *
 * All three graceful-skip on error (don't break their host cron) and log
 * structured summary strings for cron-log visibility.
 *
 * Console.log is used for alerts (Discord webhook deferred per 2026-04-21
 * scope-cut). When Wei adds DISCORD_WEBHOOK_URL secret later, notify.ts
 * sendDiscordNotification() can be slotted in at the console.log sites.
 */

import type { Bindings } from '../types'
import { enqueueOptunaRequest } from './optunaQueue'

// Default thresholds — mirror ratings.md defaults, overridable via KV.
const DEFAULT_SHARPE_THRESHOLD = 0.5     // rolling 30d sharpe alert floor
const DEFAULT_DD_SPIKE_THRESHOLD = 0.08  // single-day drawdown alert (8%)

/**
 * T1.2: detect HMM regime label change (today vs prev KV value). Must be
 * called BEFORE the /regime/compute call overwrites ml:regime. Caller passes
 * the new label post-compute for comparison.
 *
 * @returns summary string for cron log (e.g. "shift:sideways→volatile" / "same")
 */
export async function detectRegimeShift(
  env: Bindings,
  prevLabel: string | null,
  newLabel: string | null,
): Promise<string> {
  if (!prevLabel || !newLabel) return 'skip(missing_label)'
  if (prevLabel === newLabel) return 'same'
  try {
    const { enqueued } = await enqueueOptunaRequest(env.KV, {
      reason: 'regime_shift',
      target: 'per_regime',
      regime_hint: newLabel,
      note: `${prevLabel}→${newLabel}`,
    })
    const verb = enqueued ? 'enqueued' : 'deduped'
    console.log(`[RiskTrigger/T1.2] regime shift ${prevLabel}→${newLabel} ${verb}`)
    return `shift:${prevLabel}→${newLabel} ${verb}`
  } catch (e: any) {
    console.warn(`[RiskTrigger/T1.2] enqueue failed: ${e?.message ?? e}`)
    return `shift:${prevLabel}→${newLabel} error`
  }
}


/**
 * T1.3: rolling 30d sharpe below threshold → alert + queue. Reads latest row
 * from paper_daily_snapshots (sharpe_30d is pre-computed by daily-snapshot cron).
 *
 * @returns summary (e.g. "sharpe=0.42<0.5 enqueued" / "sharpe=0.78 ok" / "skip(no_data)")
 */
export async function checkRollingSharpe(
  env: Bindings,
  threshold: number = DEFAULT_SHARPE_THRESHOLD,
): Promise<string> {
  try {
    const row = await env.DB.prepare(
      'SELECT date, sharpe_30d FROM paper_daily_snapshots WHERE sharpe_30d IS NOT NULL ORDER BY date DESC LIMIT 1'
    ).first<{ date: string; sharpe_30d: number }>()

    if (!row) return 'skip(no_data)'
    const sharpe = row.sharpe_30d
    if (typeof sharpe !== 'number' || !Number.isFinite(sharpe)) return 'skip(invalid_sharpe)'
    if (sharpe >= threshold) return `sharpe=${sharpe.toFixed(2)} ok`

    const { enqueued } = await enqueueOptunaRequest(env.KV, {
      reason: 'sharpe_rolling',
      target: 'per_regime',
      note: `sharpe_30d=${sharpe.toFixed(3)} < threshold=${threshold} on ${row.date}`,
    })
    const verb = enqueued ? 'enqueued' : 'deduped'
    console.log(`[RiskTrigger/T1.3] sharpe_30d=${sharpe.toFixed(3)} < ${threshold} ${verb}`)
    return `sharpe=${sharpe.toFixed(2)}<${threshold} ${verb}`
  } catch (e: any) {
    console.warn(`[RiskTrigger/T1.3] failed: ${e?.message ?? e}`)
    return `error(${String(e?.message ?? e).slice(0, 40)})`
  }
}


/**
 * T1.4: single-day drawdown > threshold → alert + queue. Computes from the
 * latest two paper_daily_snapshots.total_value rows (no pre-computed field —
 * max_drawdown_to_date is cumulative, not single-day).
 *
 * @returns summary (e.g. "dd=-9.2%>8% enqueued" / "dd=-1.1% ok" / "skip(need_2_rows)")
 */
export async function checkDailyDrawdown(
  env: Bindings,
  threshold: number = DEFAULT_DD_SPIKE_THRESHOLD,
): Promise<string> {
  try {
    const { results } = await env.DB.prepare(
      'SELECT date, total_value FROM paper_daily_snapshots ORDER BY date DESC LIMIT 2'
    ).all<{ date: string; total_value: number }>()

    if (!results || results.length < 2) return 'skip(need_2_rows)'
    const [today, prev] = results
    if (!prev.total_value || prev.total_value <= 0) return 'skip(prev_value_invalid)'

    const ddPct = (prev.total_value - today.total_value) / prev.total_value
    // ddPct positive = drop; we trigger when drop exceeds threshold.
    if (ddPct < threshold) return `dd=${(ddPct * 100).toFixed(2)}% ok`

    const { enqueued } = await enqueueOptunaRequest(env.KV, {
      reason: 'dd_spike',
      target: 'per_regime',
      note: `single_day_dd=${(ddPct * 100).toFixed(2)}% > threshold=${(threshold * 100).toFixed(1)}% on ${today.date}`,
    })
    const verb = enqueued ? 'enqueued' : 'deduped'
    console.log(`[RiskTrigger/T1.4] dd=${(ddPct * 100).toFixed(2)}% > ${(threshold * 100).toFixed(1)}% ${verb}`)
    return `dd=${(ddPct * 100).toFixed(2)}%>${(threshold * 100).toFixed(1)}% ${verb}`
  } catch (e: any) {
    console.warn(`[RiskTrigger/T1.4] failed: ${e?.message ?? e}`)
    return `error(${String(e?.message ?? e).slice(0, 40)})`
  }
}
