const S12_INTRADAY_SESSION_LOCK_KEY = 's12:intraday-session'
const S12_INTRADAY_SESSION_LOCK_OWNER = 's12_intraday_session'

export interface S12IntradaySessionLease {
  run_date: string | null
  run_id: string | null
  expires_at: string | null
  active: boolean
}

export async function inspectS12IntradaySessionLease(
  db: D1Database,
  runDate: string,
  nowMs = Date.now(),
): Promise<S12IntradaySessionLease | null> {
  const row = await db.prepare(`
    SELECT run_date, run_id, expires_at
      FROM scheduler_locks
     WHERE lock_key = ?
       AND owner = ?
  `).bind(
    S12_INTRADAY_SESSION_LOCK_KEY,
    S12_INTRADAY_SESSION_LOCK_OWNER,
  ).first<{ run_date?: string | null; run_id?: string | null; expires_at?: string | null }>()
  if (!row) return null
  const expiresAtMs = Date.parse(String(row.expires_at ?? ''))
  return {
    run_date: row.run_date ?? null,
    run_id: row.run_id ?? null,
    expires_at: row.expires_at ?? null,
    active: row.run_date === runDate && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs,
  }
}

export async function acquireS12IntradaySessionLease(
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
    WHERE scheduler_locks.expires_at IS NULL
       OR scheduler_locks.expires_at <= excluded.created_at
       OR (
         scheduler_locks.owner=excluded.owner
         AND scheduler_locks.run_date=excluded.run_date
         AND scheduler_locks.run_id=excluded.run_id
       )
  `).bind(
    S12_INTRADAY_SESSION_LOCK_KEY,
    S12_INTRADAY_SESSION_LOCK_OWNER,
    runDate,
    runId,
    now,
    expiresAt,
  ).run()
  return Number(result.meta?.changes ?? 0) > 0
}

export async function refreshS12IntradaySessionLease(
  db: D1Database,
  runId: string,
  runDate: string,
  ttlSec = 180,
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + Math.max(60, ttlSec) * 1000).toISOString()
  const result = await db.prepare(`
    UPDATE scheduler_locks
       SET expires_at = ?
     WHERE lock_key = ?
       AND owner = ?
       AND run_date = ?
       AND run_id = ?
  `).bind(
    expiresAt,
    S12_INTRADAY_SESSION_LOCK_KEY,
    S12_INTRADAY_SESSION_LOCK_OWNER,
    runDate,
    runId,
  ).run()
  return Number(result.meta?.changes ?? 0) > 0
}

export async function releaseS12IntradaySessionLease(
  db: D1Database,
  runId: string,
  runDate: string,
): Promise<void> {
  await db.prepare(`
    DELETE FROM scheduler_locks
     WHERE lock_key = ?
       AND owner = ?
       AND run_date = ?
       AND run_id = ?
  `).bind(
    S12_INTRADAY_SESSION_LOCK_KEY,
    S12_INTRADAY_SESSION_LOCK_OWNER,
    runDate,
    runId,
  ).run()
}
