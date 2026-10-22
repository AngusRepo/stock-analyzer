/** A source quote must belong to the valuation session; receipt time is not evidence. */
export function quoteBelongsToSession(quoteTime: unknown, session: string): boolean {
  if (typeof quoteTime !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(session)) return false
  // Broker naive datetimes are Taiwan local time. Time-only values cannot prove a date.
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(quoteTime)) return false
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(quoteTime)
    ? quoteTime : quoteTime.replace(' ', 'T') + '+08:00'
  const stamp = Date.parse(zoned)
  return Number.isFinite(stamp) && new Date(stamp + 8 * 3600_000).toISOString().slice(0, 10) === session
}
