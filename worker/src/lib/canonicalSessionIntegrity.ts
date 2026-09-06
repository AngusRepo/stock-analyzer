/** Price availability cannot define the calendar used to validate those same prices. */
export type SessionCoverage = { session_date: string; source_count: number; price_count: number; canonical_count: number }

export function assertCanonicalSessionCoverage(rows: SessionCoverage[], start: string, end: string): void {
  if (!rows.length) throw new Error(`finlab_source_calendar_missing:${start}:${end}`)
  const gaps = rows.filter(row => [row.source_count, row.price_count, row.canonical_count]
    .some(count => !Number.isFinite(count) || count < 100))
  if (gaps.length) throw new Error(`canonical_session_gap:${gaps.map(r => `${r.session_date}[source=${r.source_count},prices=${r.price_count},canonical=${r.canonical_count}]`).join(',')}`)
}

export async function verifiedCanonicalSessions(db: D1Database, start: string, end: string): Promise<SessionCoverage[]> {
  const { results } = await db.prepare(`
    WITH source AS (
      SELECT session_date, MAX(positive_close_count) AS source_count
        FROM finlab_source_sessions_v1 WHERE session_date BETWEEN ? AND ? GROUP BY session_date
    ), prices AS (
      SELECT date, COUNT(*) AS price_count FROM stock_prices
       WHERE date BETWEEN ? AND ? AND close>0 GROUP BY date
    ), canonical AS (
      SELECT date, COUNT(*) AS canonical_count FROM canonical_market_daily
       WHERE date BETWEEN ? AND ? AND close>0 AND source='finlab.price' GROUP BY date
    )
    SELECT s.session_date, s.source_count, COALESCE(p.price_count,0) AS price_count,
           COALESCE(c.canonical_count,0) AS canonical_count
      FROM source s LEFT JOIN prices p ON p.date=s.session_date
      LEFT JOIN canonical c ON c.date=s.session_date ORDER BY s.session_date
  `).bind(start, end, start, end, start, end).all<SessionCoverage>()
  const rows = results ?? []
  assertCanonicalSessionCoverage(rows, start, end)
  return rows
}
