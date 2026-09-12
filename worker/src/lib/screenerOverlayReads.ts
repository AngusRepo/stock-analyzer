/** Date-bounded inputs for the existing screener overlays. No score decisions. */
function signalDay(date: string): number {
  const value = Date.parse(`${date}T00:00:00+08:00`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value)
    || new Date(value + 8 * 3600_000).toISOString().slice(0, 10) !== date) {
    throw new Error('screener_overlay_signal_date_invalid')
  }
  return value
}

export function screenerOverlayCutoff(date: string, observedAt: string) {
  const start = signalDay(date)
  const observed = Date.parse(observedAt)
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(observedAt) || !Number.isFinite(observed) || observed < start) {
    throw new Error('screener_overlay_observation_time_invalid')
  }
  return { start: new Date(start).toISOString(), cutoff: new Date(Math.min(observed, start + 24 * 3600_000)).toISOString() }
}

export async function readScreenerNewsSentiment(db: D1Database, stockIds: number[],
  date: string, observedAt: string) {
  const { start, cutoff } = screenerOverlayCutoff(date, observedAt)
  if (stockIds.some(id => !Number.isSafeInteger(id) || id <= 0) || stockIds.length > 400) {
    throw new Error('screener_overlay_stock_ids_invalid')
  }
  if (!stockIds.length) return []
  const marks = stockIds.map(() => '?').join(',')
  const result = await db.prepare(`
    SELECT stock_id, sentiment, COUNT(*) AS cnt FROM news
     WHERE stock_id IN (${marks})
       AND julianday(published_at) >= julianday(?, '-7 days')
       AND julianday(published_at) < julianday(?)
       AND julianday(created_at) < julianday(?)
     GROUP BY stock_id, sentiment
  `).bind(...stockIds, start, cutoff, cutoff)
    .all<{ stock_id: number; sentiment: string; cnt: number }>()
  if (!result.success || !Array.isArray(result.results)) throw new Error('screener_news_query_failed')
  return result.results
}

export async function readScreenerForeignFlow(db: D1Database, date: string) {
  signalDay(date)
  async function read(table: 'canonical_chip_daily' | 'chip_data') {
    const result = await db.prepare(`
      SELECT date, SUM(foreign_net) AS total_foreign_net FROM ${table}
       WHERE date >= date(?, '-40 days') AND date <= ?
       GROUP BY date ORDER BY date
    `).bind(date, date).all<{ date: string; total_foreign_net: number }>()
    if (!result.success || !Array.isArray(result.results)) throw new Error('screener_foreign_query_failed')
    return result.results
  }
  let rows: Array<{ date: string; total_foreign_net: number }>
  try { rows = await read('canonical_chip_daily') } catch { rows = [] }
  if (rows.length >= 10) return { rows, source: 'canonical_chip_daily' }
  // Retain the existing fallback policy, with the SAME bounded business date.
  return { rows: await read('chip_data'), source: 'legacy.chip_data' }
}
