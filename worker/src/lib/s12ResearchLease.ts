export const S12_RESEARCH_LOCK_KEY = 's12:research-market-data'
const S12_RESEARCH_LOCK_OWNER = 's12_research_market_data'
const S12_RESEARCH_LEASE_DEFAULT_SECONDS = 1800

export type S12ResearchLeaseClaim =
  | {
      acquired: true
      runId: string
      leaseExpiresAt: string
    }
  | {
      acquired: false
      holderOwner: string
      holderRunId: string
      leaseExpiresAt: string
    }

export async function acquireS12ResearchLeaseDetailed(
  db: D1Database,
  runId: string,
  runDate: string,
  ttlSec = S12_RESEARCH_LEASE_DEFAULT_SECONDS,
  nowMs = Date.now(),
): Promise<S12ResearchLeaseClaim> {
  const now = new Date(nowMs).toISOString()
  const leaseSeconds = Math.max(60, Math.floor(ttlSec))
  const expiresAt = new Date(nowMs + leaseSeconds * 1000).toISOString()
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
  `).bind(S12_RESEARCH_LOCK_KEY, S12_RESEARCH_LOCK_OWNER, runDate, runId, now, expiresAt).run()
  if (Number(result.meta?.changes ?? 0) > 0) {
    return { acquired: true, runId, leaseExpiresAt: expiresAt }
  }
  const holder = await db.prepare(`
    SELECT owner, run_id, expires_at
      FROM scheduler_locks
     WHERE lock_key=?
  `).bind(S12_RESEARCH_LOCK_KEY).first<{
    owner?: string | null
    run_id?: string | null
    expires_at?: string | null
  }>()
  return {
    acquired: false,
    holderOwner: String(holder?.owner ?? S12_RESEARCH_LOCK_OWNER),
    holderRunId: String(holder?.run_id ?? 'unknown'),
    leaseExpiresAt: String(holder?.expires_at ?? 'unknown'),
  }
}

export async function acquireS12ResearchLease(
  db: D1Database,
  runId: string,
  runDate: string,
  ttlSec = S12_RESEARCH_LEASE_DEFAULT_SECONDS,
): Promise<boolean> {
  return (await acquireS12ResearchLeaseDetailed(db, runId, runDate, ttlSec)).acquired
}

export class S12ResearchLeaseLostError extends Error {
  readonly runId: string
  readonly leaseCause: unknown

  constructor(runId: string, leaseCause?: unknown) {
    super(`s12_research_lease_lost:${runId}`)
    this.name = 'S12ResearchLeaseLostError'
    this.runId = runId
    this.leaseCause = leaseCause
  }
}

export async function renewS12ResearchLease(
  db: D1Database,
  runId: string,
  ttlSec = S12_RESEARCH_LEASE_DEFAULT_SECONDS,
  nowMs = Date.now(),
): Promise<boolean> {
  const now = new Date(nowMs).toISOString()
  const leaseSeconds = Math.max(60, Math.floor(ttlSec))
  const expiresAt = new Date(nowMs + leaseSeconds * 1000).toISOString()
  const result = await db.prepare(`
    UPDATE scheduler_locks
       SET expires_at = ?
     WHERE lock_key = ?
       AND owner = ?
       AND run_id = ?
       AND expires_at IS NOT NULL
       AND expires_at > ?
  `).bind(expiresAt, S12_RESEARCH_LOCK_KEY, S12_RESEARCH_LOCK_OWNER, runId, now).run()
  return Number(result.meta?.changes ?? 0) > 0
}

export async function assertS12ResearchLeaseRenewed(
  db: D1Database,
  runId: string,
  ttlSec = S12_RESEARCH_LEASE_DEFAULT_SECONDS,
): Promise<void> {
  try {
    if (await renewS12ResearchLease(db, runId, ttlSec)) return
  } catch (error) {
    throw new S12ResearchLeaseLostError(runId, error)
  }
  throw new S12ResearchLeaseLostError(runId)
}

export function isS12ResearchLeaseLost(error: unknown): error is S12ResearchLeaseLostError {
  return error instanceof S12ResearchLeaseLostError
    || (error instanceof Error && error.message.startsWith('s12_research_lease_lost:'))
}

export async function releaseS12ResearchLease(db: D1Database, runId: string): Promise<boolean> {
  const result = await db.prepare(`
    DELETE FROM scheduler_locks
     WHERE lock_key = ?
       AND owner = ?
       AND run_id = ?
  `).bind(S12_RESEARCH_LOCK_KEY, S12_RESEARCH_LOCK_OWNER, runId).run()
  return Number(result.meta?.changes ?? 0) > 0
}
