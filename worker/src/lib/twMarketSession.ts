export function getTwClockParts(now = new Date()): { hour: number; minute: number } {
  return {
    hour: (now.getUTCHours() + 8) % 24,
    minute: now.getUTCMinutes(),
  }
}

export function isTwIntradayTradingMinute(
  now = new Date(),
  options: { holiday?: boolean; delayedClose?: boolean } = {},
): boolean {
  const twNow = new Date(now.getTime() + 8 * 60 * 60_000)
  const weekday = twNow.getUTCDay()
  if (weekday === 0 || weekday === 6 || options.holiday) return false
  const minuteOfDay = twNow.getUTCHours() * 60 + twNow.getUTCMinutes()
  const closeMinute = options.delayedClose ? 13 * 60 + 33 : 13 * 60 + 30
  return minuteOfDay >= 9 * 60 && minuteOfDay <= closeMinute
}
