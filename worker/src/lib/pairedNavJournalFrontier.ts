/** Existing immutable journal frontier, not another efficacy or maturity gate. */
export interface NavJournalFrontier {
  pair_id: string
  accounted_sessions: number
  last_session_date: string | null
  last_journal_checksum: string | null
}

export function parseNavJournalFrontier(value: unknown, pairIds: string[], asOf: string): NavJournalFrontier[] {
  if (!Array.isArray(value) || !value.length || !Array.isArray(pairIds)
    || value.length !== pairIds.length) throw new Error('nav_promotion_journal_frontier_missing')
  const ids = [...pairIds].sort()
  const rows = value as NavJournalFrontier[]
  if (new Set(ids).size !== ids.length || rows.some((row, index) => !row || row.pair_id !== ids[index]
    || typeof row.pair_id !== 'string' || !row.pair_id
    || !Number.isSafeInteger(row.accounted_sessions) || row.accounted_sessions < 0
    || (row.accounted_sessions === 0
      ? row.last_session_date !== null || row.last_journal_checksum !== null
      : typeof row.last_session_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.last_session_date)
        || !Number.isFinite(Date.parse(row.last_session_date))
        || new Date(row.last_session_date).toISOString().slice(0, 10) !== row.last_session_date
        || row.last_session_date > asOf || typeof row.last_journal_checksum !== 'string'
        || !/^[a-f0-9]{64}$/.test(row.last_journal_checksum))))
    throw new Error('nav_promotion_journal_frontier_invalid')
  return structuredClone(rows)
}

export async function verifyNavJournalFrontier(db: D1Database, rows: NavJournalFrontier[]): Promise<void> {
  for (const expected of rows) {
    const actual = await db.prepare(`SELECT COUNT(*) AS accounted_sessions, MAX(session_date) AS last_session_date,
      (SELECT payload_checksum FROM paired_nav_daily_journal_v1 WHERE pair_id=? ORDER BY session_date DESC LIMIT 1)
        AS last_journal_checksum FROM paired_nav_daily_journal_v1 WHERE pair_id=?`)
      .bind(expected.pair_id, expected.pair_id).first<Record<string, unknown>>()
    if (!actual || ['accounted_sessions', 'last_session_date', 'last_journal_checksum']
      .some(key => actual[key] !== expected[key as keyof NavJournalFrontier]))
      throw new Error('nav_promotion_journal_frontier_changed')
  }
}

export function navJournalFrontierStatement(db: D1Database, rows: NavJournalFrontier[]): D1PreparedStatement {
  // One bound JSON list avoids unbounded SQL placeholders. Execute in the SAME
  // transaction as publication: a new journal between reads and writes aborts.
  return db.prepare(`SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM json_each(?) f WHERE
      (SELECT COUNT(*) FROM paired_nav_daily_journal_v1 j WHERE j.pair_id=json_extract(f.value,'$.pair_id'))
        != json_extract(f.value,'$.accounted_sessions')
      OR (SELECT session_date FROM paired_nav_daily_journal_v1 j WHERE j.pair_id=json_extract(f.value,'$.pair_id')
        ORDER BY session_date DESC LIMIT 1) IS NOT json_extract(f.value,'$.last_session_date')
      OR (SELECT payload_checksum FROM paired_nav_daily_journal_v1 j WHERE j.pair_id=json_extract(f.value,'$.pair_id')
        ORDER BY session_date DESC LIMIT 1) IS NOT json_extract(f.value,'$.last_journal_checksum')
    ) THEN 1 ELSE json('nav_promotion_journal_frontier_changed') END AS nav_journal_stable`)
    .bind(JSON.stringify(rows))
}
