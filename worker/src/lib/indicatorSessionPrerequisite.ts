import { verifiedCanonicalSessions } from './canonicalSessionIntegrity'

/** Refresh the source-verified calendar before risk/HMM reads it. No labels or models. */
export async function materializeIndicatorSessions(db: D1Database, date: string): Promise<number> {
  const end = new Date(date + 'T00:00:00Z')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(end.getTime())
      || end.toISOString().slice(0, 10) !== date) throw new Error('indicator_session_date_invalid')
  const start = new Date(end.getTime() - 120 * 86400_000).toISOString().slice(0, 10)
  const rows = await verifiedCanonicalSessions(db, start, date)
  if (rows.length < 60 || rows.at(-1)?.session_date !== date) {
    throw new Error(`indicator_session_window_incomplete:${date}`)
  }
  // Same provenance and upsert as priceHorizonProjection; validate the entire window first.
  for (let offset = 0; offset < rows.length; offset += 20) {
    await db.batch(rows.slice(offset, offset + 20).map(row => db.prepare(`
      INSERT INTO market_trading_sessions (session_date, source, sample_size)
      VALUES (?, ?, ?)
      ON CONFLICT(session_date) DO UPDATE SET source=excluded.source,
        sample_size=excluded.sample_size, materialized_at=CURRENT_TIMESTAMP
    `).bind(row.session_date, 'canonical_market_daily:finlab_adjusted_price_lineage', row.price_count)))
  }
  return rows.length
}
