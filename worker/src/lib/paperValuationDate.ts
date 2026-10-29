/** A source quote must belong to the valuation session; receipt time is not evidence. */
export function quoteBelongsToSession(quoteTime: unknown, session: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(session) && quoteSessionDate(quoteTime) === session
}

/**
 * Price date of a source quote (Taiwan calendar day), or null when the quote time cannot prove one.
 * Broker naive datetimes are Taiwan local time; time-only values cannot prove a date.
 */
export function quoteSessionDate(quoteTime: unknown): string | null {
  if (typeof quoteTime !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(quoteTime)) return null
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(quoteTime) ? quoteTime : quoteTime.replace(' ', 'T') + '+08:00'
  const stamp = Date.parse(zoned)
  return Number.isFinite(stamp) ? new Date(stamp + 8 * 3600_000).toISOString().slice(0, 10) : null
}

export interface SessionMarkEvidence {
  price?: number | null
  price_date?: string | null
  source?: string | null
  quote_time?: string | null
}

export interface SessionMarkIssue {
  symbol: string
  issue: 'missing' | 'stale' | 'undated'
  price_date: string | null
  source: string | null
}

/**
 * O04 mark-date check: every held position's mark must be dated the valuation session (its exact
 * session close, or a broker quote whose own time falls on that session). A price from any other
 * day is stale, a quote without a provable date is undated; neither may stand in for the session.
 * `rejected` lists prices a source returned that were already refused for their date.
 */
export function sessionMarkDateIssues(
  heldSymbols: string[], evidence: Record<string, SessionMarkEvidence | undefined>, session: string,
  rejected: ReadonlyMap<string, { quote_time: string | null; source: string }> = new Map(),
): SessionMarkIssue[] {
  const issues: SessionMarkIssue[] = []
  for (const symbol of [...new Set(heldSymbols)].sort()) {
    const mark = evidence[symbol]
    const price = Number(mark?.price)
    if (mark && Number.isFinite(price) && price > 0) {
      const quoteDate = mark.quote_time != null ? quoteSessionDate(mark.quote_time) : undefined
      if (quoteDate === null || !mark.price_date) issues.push({ symbol, issue: 'undated', price_date: null, source: mark.source ?? null })
      else if (mark.price_date !== session || (quoteDate !== undefined && quoteDate !== session))
        issues.push({ symbol, issue: 'stale', price_date: quoteDate ?? mark.price_date ?? null, source: mark.source ?? null })
      continue
    }
    const refused = rejected.get(symbol)
    if (refused) {
      const date = quoteSessionDate(refused.quote_time)
      issues.push({ symbol, issue: date ? 'stale' : 'undated', price_date: date, source: refused.source })
    } else issues.push({ symbol, issue: 'missing', price_date: null, source: null })
  }
  return issues
}
