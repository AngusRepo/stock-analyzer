/** Wei-approved paper-trading recovery for all of 2026-10-12; other dates are unchanged. */
export function premarketPublicationTarget(tradeDate: string): string {
  return tradeDate === '2026-10-12' ? '24:00' : '08:45'
}

export function premarketPublicationCutoff(tradeDate: string): number {
  return Date.parse(`${tradeDate}T${premarketPublicationTarget(tradeDate)}:00+08:00`)
}

export function premarketPublicationMinutes(tradeDate: string): number {
  return tradeDate === '2026-10-12' ? 1440 : 525
}
