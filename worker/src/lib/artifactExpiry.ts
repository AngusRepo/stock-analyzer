import { paperExecutionDate } from './paperExecutionScope'

const ELIGIBLE = `a.status='ready' AND a.payload_deleted_at IS NULL AND a.retain_until IS NOT NULL
  AND datetime(a.retain_until)<=datetime(?) AND a.pinned=0 AND a.legal_hold=0 AND a.hard_ref_count=0
  AND a.checksum_verified_at IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM artifact_hard_references r WHERE r.artifact_id=a.artifact_id AND r.active=1)`
const LEASE_MS = 120_000
export type ArtifactExpiryOptions = {now?:string;limit?:number;budgetMs?:number;clock?:()=>number}
export type ArtifactExpiryResult = {
  candidates:number;claimed:number;deleted:number;failed:number;skipped:number;budget_exhausted:boolean;has_more:boolean;errors:string[]
}
type Candidate = {artifact_id:string;r2_key:string;checksum:string;scheduled_at:string}

/** A page is retryable across process death and either R2/D1 response loss. No reference can attach after claim. */
export async function sweepExpiredArtifacts(db: D1Database, r2: {delete(key:string):Promise<unknown>},
  options: ArtifactExpiryOptions = {}): Promise<ArtifactExpiryResult> {
  const now = new Date(options.now ?? paperExecutionDate().toISOString()).toISOString()
  const limit = Math.max(1,Math.min(1000,Math.floor(options.limit ?? 250)))
  const clock = options.clock ?? Date.now, started = clock()
  const budget = Math.max(1,Math.min(60_000,Math.floor(options.budgetMs ?? 25_000)))
  if (![limit,budget].every(Number.isFinite)) throw new Error('artifact_expiry_budget_invalid')
  // Query each indexed queue once. Updating a failed claim's scheduling time prevents a bad oldest object pinning the head.
  const retries = (await db.prepare(`SELECT artifact_id,r2_key,checksum,COALESCE(last_attempt_at,claimed_at) scheduled_at
    FROM artifact_deletion_claims_v1 WHERE status='pending' AND next_attempt_at<=? AND lease_until<=?
    ORDER BY next_attempt_at,artifact_id LIMIT ?`).bind(now,now,limit).all<Candidate>()).results ?? []
  const fresh = (await db.prepare(`SELECT a.artifact_id,a.r2_key,a.checksum,a.retain_until scheduled_at FROM run_artifacts a
    WHERE ${ELIGIBLE} AND NOT EXISTS(SELECT 1 FROM artifact_deletion_claims_v1 c WHERE c.artifact_id=a.artifact_id)
    ORDER BY a.retain_until,a.artifact_id LIMIT ?`).bind(now,limit).all<Candidate>()).results ?? []
  // Reserve progress for both queues: a large old fresh backlog must not starve a claimed R2 retry.
  const candidates:Candidate[]=[]
  for (let i=0;candidates.length<limit && (i<retries.length || i<fresh.length);i++) {
    if (i<retries.length) candidates.push(retries[i])
    if (candidates.length<limit && i<fresh.length) candidates.push(fresh[i])
  }
  const result:ArtifactExpiryResult = {candidates:candidates.length,claimed:0,deleted:0,failed:0,skipped:0,
    budget_exhausted:false,has_more:retries.length+fresh.length>candidates.length || fresh.length===limit || retries.length===limit,errors:[]}
  for (const row of candidates) {
    if (clock()-started>=budget) {result.budget_exhausted=true;result.has_more=true;break}
    const owner = crypto.randomUUID()
    // Wall clock advances within this invocation even when tests pin the starting business time.
    const attemptAt = new Date(Date.parse(now)+Math.max(0,clock()-started)).toISOString()
    const leaseUntil = new Date(Date.parse(attemptAt)+LEASE_MS).toISOString()
    try {
      // The predicate is rechecked atomically AFTER candidate selection. An insert-first reference wins this race.
      await db.prepare(`INSERT INTO artifact_deletion_claims_v1
        (artifact_id,r2_key,checksum,status,lease_until,next_attempt_at,claimed_at)
        SELECT a.artifact_id,a.r2_key,a.checksum,'pending',?,?,? FROM run_artifacts a
        WHERE ${ELIGIBLE} AND a.artifact_id=? AND a.r2_key=? AND a.checksum=?
          AND NOT EXISTS(SELECT 1 FROM artifact_deletion_claims_v1 c WHERE c.artifact_id=a.artifact_id)`)
        .bind(attemptAt,attemptAt,attemptAt,attemptAt,row.artifact_id,row.r2_key,row.checksum).run()
      const claimed = await db.prepare(`UPDATE artifact_deletion_claims_v1 SET owner_id=?,lease_until=?,
        last_attempt_at=?,attempts=attempts+1,last_error=NULL
        WHERE artifact_id=? AND r2_key=? AND checksum=? AND status='pending' AND lease_until<=? AND next_attempt_at<=?
        RETURNING attempts`).bind(owner,leaseUntil,attemptAt,row.artifact_id,row.r2_key,row.checksum,attemptAt,attemptAt)
        .first<{attempts:number}>()
      if (!claimed) {result.skipped++;continue}
      result.claimed++
      await r2.delete(row.r2_key)
      // Both metadata records settle atomically. A lost commit response is reconciled below.
      await db.batch([
        db.prepare(`UPDATE run_artifacts SET status='payload_deleted',payload_deleted_at=?,updated_at=CURRENT_TIMESTAMP
          WHERE artifact_id=? AND r2_key=? AND checksum=? AND EXISTS(SELECT 1 FROM artifact_deletion_claims_v1 c
            WHERE c.artifact_id=run_artifacts.artifact_id AND c.status='pending' AND c.owner_id=?)`)
          .bind(attemptAt,row.artifact_id,row.r2_key,row.checksum,owner),
        db.prepare(`UPDATE artifact_deletion_claims_v1 SET status='done',completed_at=?,owner_id=NULL,
          lease_until=?,last_error=NULL WHERE artifact_id=? AND owner_id=? AND status='pending'
          AND EXISTS(SELECT 1 FROM run_artifacts a WHERE a.artifact_id=artifact_deletion_claims_v1.artifact_id
            AND a.status='payload_deleted' AND a.r2_key=artifact_deletion_claims_v1.r2_key AND a.checksum=artifact_deletion_claims_v1.checksum)`)
          .bind(attemptAt,attemptAt,row.artifact_id,owner),
      ])
      const done = await db.prepare(`SELECT status FROM artifact_deletion_claims_v1 WHERE artifact_id=?`)
        .bind(row.artifact_id).first<{status:string}>()
      if (done?.status!=='done') throw new Error('artifact_expiry_completion_not_owned')
      result.deleted++
    } catch (error) {
      const done = await db.prepare(`SELECT status FROM artifact_deletion_claims_v1 WHERE artifact_id=?`)
        .bind(row.artifact_id).first<{status:string}>()
      if (done?.status==='done') {result.deleted++;continue}
      const message = String(error).slice(0,1000)
      await db.prepare(`UPDATE artifact_deletion_claims_v1 SET owner_id=NULL,lease_until=?,last_error=?,
        next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ',?,'+' || MIN(3600,30*(1 << MIN(attempts,7))) || ' seconds')
        WHERE artifact_id=? AND owner_id=? AND status='pending'`)
        .bind(attemptAt,message,attemptAt,row.artifact_id,owner).run()
      result.failed++;result.has_more=true;result.errors.push(row.artifact_id+':'+message)
    }
  }
  // Backoff/leased work is still backlog, even when no object is due in this invocation.
  result.has_more = Boolean(await db.prepare(`SELECT 1 pending FROM artifact_deletion_claims_v1 WHERE status='pending'
    UNION ALL SELECT 1 FROM run_artifacts a WHERE ${ELIGIBLE}
      AND NOT EXISTS(SELECT 1 FROM artifact_deletion_claims_v1 c WHERE c.artifact_id=a.artifact_id) LIMIT 1`)
    .bind(now).first())
  return result
}
