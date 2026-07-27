const INTRADAY_EXECUTION_LOCK_KEY = 'intraday:execution-loop'
const INTRADAY_EXECUTION_LOCK_OWNER = 'intraday_execution_loop'

export async function acquireIntradayExecutionLease(
  db: D1Database,
  runId: string,
  runDate: string,
  ttlSec = 180,
): Promise<boolean> {
  const now = new Date().toISOString()
  const expiresAt = new Date(Date.now() + Math.max(60, ttlSec) * 1000).toISOString()
  const result = await db.prepare(`
    INSERT INTO scheduler_locks (lock_key, owner, run_date, run_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(lock_key) DO UPDATE SET
      owner=excluded.owner,
      run_date=excluded.run_date,
      run_id=excluded.run_id,
      created_at=excluded.created_at,
      expires_at=excluded.expires_at
    WHERE scheduler_locks.expires_at IS NOT NULL
      AND scheduler_locks.expires_at <= excluded.created_at
  `).bind(
    INTRADAY_EXECUTION_LOCK_KEY,
    INTRADAY_EXECUTION_LOCK_OWNER,
    runDate,
    runId,
    now,
    expiresAt,
  ).run()
  return Number(result.meta?.changes ?? 0) > 0
}

export async function refreshIntradayExecutionLease(
  db: D1Database,
  runId: string,
  ttlSec = 180,
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + Math.max(60, ttlSec) * 1000).toISOString()
  const result = await db.prepare(`
    UPDATE scheduler_locks
       SET expires_at = ?
     WHERE lock_key = ?
       AND owner = ?
       AND run_id = ?
  `).bind(
    expiresAt,
    INTRADAY_EXECUTION_LOCK_KEY,
    INTRADAY_EXECUTION_LOCK_OWNER,
    runId,
  ).run()
  return Number(result.meta?.changes ?? 0) > 0
}

export async function releaseIntradayExecutionLease(
  db: D1Database,
  runId: string,
): Promise<void> {
  await db.prepare(`
    DELETE FROM scheduler_locks
     WHERE lock_key = ?
       AND owner = ?
       AND run_id = ?
  `).bind(
    INTRADAY_EXECUTION_LOCK_KEY,
    INTRADAY_EXECUTION_LOCK_OWNER,
    runId,
  ).run()
}
