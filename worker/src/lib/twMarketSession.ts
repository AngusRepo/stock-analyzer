export function getTwClockParts(now = new Date()): { hour: number; minute: number } {
  return {
    hour: (now.getUTCHours() + 8) % 24,
    minute: now.getUTCMinutes(),
  }
}

export function isTwIntradayTradingMinute(now = new Date()): boolean {
  const { hour, minute } = getTwClockParts(now)
  return hour >= 9 && (hour < 13 || (hour === 13 && minute <= 30))
}
