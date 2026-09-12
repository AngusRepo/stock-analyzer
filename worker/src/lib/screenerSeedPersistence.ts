/** D1 acknowledgement checks for the original screener seed write owner.
 * A failed/short batch must never be followed by a successful canonical funnel.
 */
export function assertScreenerSeedWriteResults(results: Array<{ success: boolean }>, expected: number): void {
  if (!Array.isArray(results) || results.length !== expected || results.some(row => row.success !== true)) {
    throw new Error('screener_seed_write_not_acknowledged')
  }
}

export async function writeScreenerSeedBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += 50) {
    const batch = statements.slice(offset, offset + 50)
    assertScreenerSeedWriteResults(await db.batch(batch), batch.length)
  }
}

/** Raw pre-write state for the ORIGINAL upsert. Read-only, never a Core write.
 * Captured before the formal batch; it is not historical PIT reconstruction.
 */
export async function readScreenerCoreBeforeWrite(db: D1Database, runDate: string, symbols: string[]) {
  const rows = async (sql: string, params: (string | number)[] = []) => {
    const result = await db.prepare(sql).bind(...params).all<Record<string, unknown>>()
    if (!result.success || !Array.isArray(result.results)) throw new Error('screener_core_before_read_failed')
    return result.results
  }
  const schema = await rows("SELECT sql FROM sqlite_master WHERE type='table' AND name='daily_recommendations'")
  if (schema.length !== 1 || typeof schema[0].sql !== 'string') throw new Error('screener_core_before_schema_missing')
  const sequence = await rows("SELECT seq FROM sqlite_sequence WHERE name='daily_recommendations'")
  if (sequence.length > 1 || sequence.length && (!Number.isSafeInteger(sequence[0].seq) || Number(sequence[0].seq) < 0)) {
    throw new Error('screener_core_before_sequence_invalid')
  }
  const stockRows: Record<string, unknown>[] = [], dailyRows: Record<string, unknown>[] = []
  const scope = [...new Set(symbols)].sort()
  for (let offset = 0; offset < scope.length; offset += 40) {
    const part = scope.slice(offset, offset + 40), placeholders = part.map(() => '?').join(',')
    stockRows.push(...await rows(`SELECT id,symbol,name,sector,market FROM stocks WHERE symbol IN (${placeholders})`, part))
    dailyRows.push(...await rows(`SELECT * FROM daily_recommendations WHERE date=? AND symbol IN (${placeholders})`, [runDate, ...part]))
  }
  return { schema_version: 'screener-core-before-write-v1' as const, signal_date: runDate,
    symbols: scope, table_sql: schema[0].sql, sequence: sequence.length ? Number(sequence[0].seq) : 0,
    stock_rows: stockRows, daily_rows: dailyRows,
    knowledge_scope: 'observed_before_seed_write_not_historical_asof' as const }
}
