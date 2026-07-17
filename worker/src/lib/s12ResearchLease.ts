const S12_RESEARCH_LOCK_KEY = 's12:research-market-data'

export async function acquireS12ResearchLease(
  db: D1Database,
  runId: string,
  runDate: string,
  ttlSec = 900,
): Promise<boolean> {
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + Math.max(60, ttlSec) * 1000).toISOString()
  const result = await db.prepare(`
    INSERT INTO scheduler_locks (lock_key, owner, run_date, run_id, created_at, expires_at)
    VALUES (?, 's12_research_market_data', ?, ?, ?, ?)
    ON CONFLICT(lock_key) DO UPDATE SET
      owner=excluded.owner,
      run_date=excluded.run_date,
      run_id=excluded.run_id,
      created_at=excluded.created_at,
      expires_at=excluded.expires_at
    WHERE scheduler_locks.expires_at IS NOT NULL
      AND scheduler_locks.expires_at <= excluded.created_at
  `).bind(S12_RESEARCH_LOCK_KEY, runDate, runId, now, expiresAt).run()
  return Number(result.meta?.changes ?? 0) > 0
}

export async function releaseS12ResearchLease(db: D1Database, runId: string): Promise<void> {
  await db.prepare(`
    DELETE FROM scheduler_locks
     WHERE lock_key = ?
       AND owner = 's12_research_market_data'
       AND run_id = ?
  `).bind(S12_RESEARCH_LOCK_KEY, runId).run()
}
