import { paperExecutionDate } from './paperExecutionScope'
import { getTwClockParts } from './twMarketSession'

export function shouldMarkPendingDebateSlaReached(now = paperExecutionDate(), slaMinutesAfterOpen = 10): boolean {
  const { hour, minute } = getTwClockParts(now)
  if (hour < 9) return false
  if (hour > 9) return true
  return minute >= slaMinutesAfterOpen
}
