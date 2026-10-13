/** Wei-approved paper recovery: Oct 12 all day, Oct 13 until market open. */
export function premarketPublicationTarget(tradeDate: string): string {
  return tradeDate === '2026-10-12' ? '24:00' : tradeDate === '2026-10-13' ? '09:00' : '08:45'
}

export function premarketPublicationCutoff(tradeDate: string): number {
  return Date.parse(`${tradeDate}T${premarketPublicationTarget(tradeDate)}:00+08:00`)
}

export function premarketPublicationMinutes(tradeDate: string): number {
  return tradeDate === '2026-10-12' ? 1440 : tradeDate === '2026-10-13' ? 540 : 525
}
