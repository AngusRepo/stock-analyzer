import type { Bindings } from '../types'
import { paperExecutionNow, scopedPaperAccountId } from './paperExecutionScope'
import type { PremarketPayload } from './premarketEventChain'

/** Explicit October 8 -> October 12 publication recovery, never accounting or execution.
 * Current account capture still includes unsettled cash. Missing preopen corporate
 * evidence is retained for reconciliation, not fabricated by moving the clock.
 */
export function afterClosePaperRecovery(env: Bindings, date: string, input: PremarketPayload,
  now = paperExecutionNow()): boolean {
  const seal = input.l3_receipt as {run_date?:string} | undefined
  const context = input.morning_context as {trade_date?:string} | undefined
  const tw = new Date(now + 8 * 3600_000)
  return scopedPaperAccountId() === null && env.PAPER_DAILY_PLAN_OWNER === 'premarket_once_v1'
    && env.LIVE_EXECUTION_CLIENT_ENABLED === '0'
    && date === '2026-10-12' && tw.toISOString().slice(0,10) === date
    && tw.getUTCHours() * 60 + tw.getUTCMinutes() >= 810
    && input.signal_date === '2026-10-08' && seal?.run_date === input.signal_date
    && context?.trade_date === date
}
