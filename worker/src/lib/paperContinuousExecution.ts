import type { Bindings } from '../types'
import { paperDomainDatabase } from './paperDomainDatabase'
import { paperExecutionNow } from './paperExecutionScope'

/** Execution only: daily-close observations remain available after this window. */
export function isPaperContinuousSession(nowMs = paperExecutionNow()): boolean {
  if (!Number.isFinite(nowMs)) return false
  const tw = new Date(nowMs + 8 * 3600_000)
  const minute = tw.getUTCHours() * 60 + tw.getUTCMinutes()
  return tw.getUTCDay() !== 0 && tw.getUTCDay() !== 6 && minute >= 540 && minute < 805
}

/** All Paper fills, including reductions and manual fills, share this final gate.
 * Do not await between the clock check and dispatching the atomic fill batch.
 * Paper has no broker-resting orders; a rejected batch leaves no simulated fill.
 */
export async function executeContinuousPaperBatch(env: Bindings, statements: D1PreparedStatement[],
  notAfterMs?: number): Promise<D1Result[]> {
  const nowMs = paperExecutionNow()
  if (!isPaperContinuousSession(nowMs)) throw new Error('paper_outside_continuous_session')
  if (notAfterMs != null && (!Number.isFinite(notAfterMs) || nowMs >= notAfterMs))
    throw new Error('paper_submission_window_expired')
  return paperDomainDatabase(env).batch(statements)
}
