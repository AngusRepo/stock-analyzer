/** Wei-approved one-day recovery window; expires at the 2026-10-12 open. */
export function premarketPublicationTarget(tradeDate: string): string {
  return tradeDate === '2026-10-12' ? '09:00' : '08:45'
}

export function premarketPublicationCutoff(tradeDate: string): number {
  return Date.parse(`${tradeDate}T${premarketPublicationTarget(tradeDate)}:00+08:00`)
}

export function premarketPublicationMinutes(tradeDate: string): number {
  return tradeDate === '2026-10-12' ? 540 : 525
}
