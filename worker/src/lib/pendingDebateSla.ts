import { getTwClockParts } from './twMarketSession'

export function shouldFailClosedPendingDebate(now = new Date(), slaMinutesAfterOpen = 10): boolean {
  const { hour, minute } = getTwClockParts(now)
  if (hour < 9) return false
  if (hour > 9) return true
  return minute >= slaMinutesAfterOpen
}
