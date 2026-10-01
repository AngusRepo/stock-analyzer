import type { Bindings } from '../types'
import { ensurePremarketEventChain, premarketClock } from './premarketEventChain'

/** Recovery wakes durable incomplete stages; it never rebuilds completed work. */
export async function runPremarketEvidenceWatchdog(env: Bindings): Promise<string> {
  const now = Date.now()
  const clock = premarketClock(now)
  if (clock.minutes < 420 || clock.minutes >= 540) return 'status=skipped premarket_recovery_outside_window'
  return ensurePremarketEventChain(env,clock.date,now)
}
