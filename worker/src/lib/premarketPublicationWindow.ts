/** Wei-approved dated paper recovery; market open remains the completion target. */
export function premarketPublicationTarget(tradeDate: string): string {
  return ['2026-10-12','2026-10-13'].includes(tradeDate) ? '24:00' : '08:45'
}

export function premarketPublicationCutoff(tradeDate: string): number {
  return Date.parse(`${tradeDate}T${premarketPublicationTarget(tradeDate)}:00+08:00`)
}

export function premarketPublicationMinutes(tradeDate: string): number {
  return ['2026-10-12','2026-10-13'].includes(tradeDate) ? 1440 : 525
}
