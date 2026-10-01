import { databaseForDataDomain } from './dataDomainRegistry'
import type { Bindings } from '../types'

/** One fenced producer per TW date. Failed attempts cool down; successes are immutable. */
export async function runPremarketEvidenceStage<T>(env: Bindings, date: string, stage: string,
  read: () => Promise<T | null>, produce: (assertOwner: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const db = databaseForDataDomain(env, 'ops')
  const owner = crypto.randomUUID()
  const key = `premarket_v2:${stage}`
  const existing = await read()
  if (existing) return existing
  const claim = await db.prepare(`
    INSERT INTO pipeline_stage_runs (business_date, stage, canonical_run_id, status,
      attempt_count, lease_owner, lease_expires_at, queued_at, started_at, updated_at)
    VALUES (?, ?, ?, 'running', 1, ?, datetime('now', '+600 seconds'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(business_date, stage) DO UPDATE SET
      status='running', attempt_count=pipeline_stage_runs.attempt_count+1,
      lease_owner=excluded.lease_owner, lease_expires_at=excluded.lease_expires_at,
      started_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE pipeline_stage_runs.attempt_count < 3
      AND pipeline_stage_runs.status != 'success'
      AND pipeline_stage_runs.lease_expires_at < CURRENT_TIMESTAMP
    RETURNING attempt_count
  `).bind(date, key, `${date}:${key}`, owner).first<{ attempt_count: number }>()
  if (!claim) {
    // A crashed final attempt must terminate visibly rather than wait forever.
    await db.prepare(`UPDATE pipeline_stage_runs SET status='error', last_error='attempts_exhausted_after_lease_expiry',
      lease_owner=NULL, updated_at=CURRENT_TIMESTAMP WHERE business_date=? AND stage=?
      AND status='running' AND attempt_count>=3 AND lease_expires_at < CURRENT_TIMESTAMP`).bind(date, key).run()
    const state = await db.prepare(`SELECT status, attempt_count, lease_expires_at FROM pipeline_stage_runs
      WHERE business_date=? AND stage=?`).bind(date, key).first<any>()
    throw new Error(`premarket_wait:${stage}:${state?.status ?? 'unknown'}:attempt=${state?.attempt_count ?? 0}:next=${state?.lease_expires_at ?? ''}`)
  }
  const assertOwner = async () => {
    const active = await db.prepare(`SELECT 1 AS ok FROM pipeline_stage_runs WHERE business_date=? AND stage=?
      AND lease_owner=? AND status='running' AND lease_expires_at >= CURRENT_TIMESTAMP`)
      .bind(date, key, owner).first()
    if (!active) throw new Error(`premarket_lease_lost:${stage}`)
  }
  try {
    const result = await produce(assertOwner)
    await assertOwner()
    const done = await db.prepare(`UPDATE pipeline_stage_runs SET status='success', persisted_count=1,
      lease_owner=NULL, lease_expires_at=NULL, completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, last_error=NULL
      WHERE business_date=? AND stage=? AND lease_owner=? AND status='running'
      RETURNING status`).bind(date, key, owner).first()
    if (!done) throw new Error(`premarket_lease_lost:${stage}`)
    return result
  } catch (error) {
    await db.prepare(`UPDATE pipeline_stage_runs SET status=?, last_error=?, lease_owner=NULL,
      lease_expires_at=datetime('now', '+600 seconds'), updated_at=CURRENT_TIMESTAMP
      WHERE business_date=? AND stage=? AND lease_owner=? AND status='running'`)
      .bind(claim.attempt_count >= 3 ? 'error' : 'waiting', String(error).slice(0, 900), date, key, owner).run()
    if (claim.attempt_count >= 3) throw new Error(`premarket_exhausted:${stage}:${String(error)}`)
    throw error
  }
}
