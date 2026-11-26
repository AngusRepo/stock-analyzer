// Retention runs outside the d1_heavy_maintenance lease (it lost 11 of 14 nights to audit-json),
// so each run is one indexed delete of at most this many rows; a backlog drains over later nights.
// Kept out of debateMemory.ts, which is a native release identity input.
const DEBATE_MEMORY_RETENTION_DAYS = 180
export const DEBATE_MEMORY_RETENTION_DELETE_LIMIT = 500

export async function deleteExpiredDebateMemory(db: D1Database): Promise<string> {
  const res = await db.prepare(`
    DELETE FROM debate_memory
     WHERE id IN (
       SELECT id FROM debate_memory
        WHERE debate_date < DATE('now', ?)
        ORDER BY debate_date
        LIMIT ?
     )
  `).bind(`-${DEBATE_MEMORY_RETENTION_DAYS} days`, DEBATE_MEMORY_RETENTION_DELETE_LIMIT).run()
  const meta = (res as any)?.meta ?? {}
  const deleted = Number(meta.changes ?? 0)
  return `deleted=${deleted} rows_read=${meta.rows_read ?? 0}`
    + `${deleted >= DEBATE_MEMORY_RETENTION_DELETE_LIMIT ? ` capped_at=${DEBATE_MEMORY_RETENTION_DELETE_LIMIT}` : ''}`
}
