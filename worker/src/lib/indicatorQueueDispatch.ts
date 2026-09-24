import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

/** One atomic dispatch owner per business date. KV is a receipt, never a lock. */
export async function claimIndicatorQueueDispatch(
  env: Bindings, date: string, force = false,
): Promise<string | null> {
  const db = databaseForDataDomain(env, 'ops')
  const key = `indicator-dispatch:${date}`
  const previous = await db.prepare('SELECT run_id,expires_at FROM scheduler_locks WHERE lock_key=?')
    .bind(key).first<{ run_id: string; expires_at: string }>()
  const receipt = await env.KV.get(`scheduler:run:indicator-queue:${date}`, 'json') as { run_id?: string } | null
  const now = new Date().toISOString()
  // Recover a crash between the atomic claim and the first KV receipt, using
  // the original identity. Never create another set of shards for that date.
  if (previous && receipt?.run_id !== previous.run_id) {
    if (previous.expires_at > now) return null
    const resumed = await db.prepare(`UPDATE scheduler_locks SET expires_at=?
      WHERE lock_key=? AND run_id=? AND expires_at=?`)
      .bind(new Date(Date.now()+120_000).toISOString(),key,previous.run_id,previous.expires_at).run()
    return Number(resumed.meta?.changes ?? 0)>0 ? previous.run_id : null
  }
  const priorRun = previous?.run_id ?? receipt?.run_id
  // An automatic force refresh must not fork an unfinished indicator chain.
  if (priorRun && (!force || !await env.KV.get(`cron:indicator-queue:${date}:${priorRun}:finalized`))) return null
  const runId = `${date}-${crypto.randomUUID()}`
  const result = await db.prepare(`
    INSERT INTO scheduler_locks (lock_key,owner,run_date,run_id,created_at,expires_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(lock_key) DO UPDATE SET owner=excluded.owner,run_id=excluded.run_id,
      created_at=excluded.created_at,expires_at=excluded.expires_at
    WHERE scheduler_locks.run_id=? AND ?=1
  `).bind(key,runId,date,runId,now,new Date(Date.now()+120_000).toISOString(),
    previous?.run_id ?? '',force ? 1 : 0).run()
  return Number(result.meta?.changes ?? 0)>0 ? runId : null
}


/** A durable screener producer owns recovery after this handoff, even if a
 * duplicate legacy indicator run still has messages in the queue. */
export async function closeHandedOffIndicatorRun(env: Bindings, date: string, runId: string): Promise<boolean> {
  const row = await databaseForDataDomain(env, 'ops').prepare(`
    SELECT canonical_run_id FROM pipeline_stage_runs
     WHERE business_date=? AND stage='screener_v2' AND cursor_key IS NOT NULL AND cursor_key<>''
       AND status IN ('running','success','waiting')
  `).bind(date).first<{ canonical_run_id: string }>()
  if (!row?.canonical_run_id) return false
  await env.KV.put(`cron:indicator-queue:${date}:${runId}:finalized`,
    JSON.stringify({handoff_owner:row.canonical_run_id,stage:'screener_v2',superseded:row.canonical_run_id!==runId}),
    {expirationTtl:7*86400})
  return true
}
