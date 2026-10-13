import type { Bindings } from '../types'
import { paperExecutionNow, scopedPaperAccountId } from './paperExecutionScope'
import type { PremarketPayload } from './premarketEventChain'

/** Explicit dated publication recovery, never accounting or execution.
 * Current account capture still includes unsettled cash. Missing preopen corporate
 * evidence is retained for reconciliation, not fabricated by moving the clock.
 */
export function afterClosePaperRecovery(env: Bindings, date: string, input: PremarketPayload,
  now = paperExecutionNow()): boolean {
  const seal = input.l3_receipt as {run_date?:string} | undefined
  const context = input.morning_context as {trade_date?:string} | undefined
  const tw = new Date(now + 8 * 3600_000)
  const october13 = date === '2026-10-13' && input.signal_date === '2026-10-12'
    && env.LIVE_EXECUTION_SUBMIT_GUARD_ENABLED === '0'
  const allowed = october13 || (date === '2026-10-12' && input.signal_date === '2026-10-08')
  return scopedPaperAccountId() === null && env.PAPER_DAILY_PLAN_OWNER === 'premarket_once_v1'
    && env.LIVE_EXECUTION_CLIENT_ENABLED === '0'
    && allowed && tw.toISOString().slice(0,10) === date
    && tw.getUTCHours() * 60 + tw.getUTCMinutes() >= (october13 ? 540 : 810)
    && seal?.run_date === input.signal_date
    && context?.trade_date === date
}
