import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

export async function indicatorFinalizeLeaseActive(env: Bindings, date: string, runId: string): Promise<boolean> {
  const row = await databaseForDataDomain(env, 'ops').prepare(`
    SELECT expires_at FROM scheduler_locks WHERE lock_key=?
  `).bind(`indicator-finalize:${date}:${runId}`).first<{ expires_at: string | null }>()
  return Boolean(row?.expires_at && Date.parse(row.expires_at) > Date.now())
}

/** Release only this owner after its work settles, including a handled error.
 * A terminated Worker still relies on lease expiry; a failed old owner cannot
 * release the lease of a replacement owner.
 */
export async function withIndicatorFinalizeLease<T>(
  env: Bindings, date: string, runId: string, owner: string, work: () => Promise<T>,
): Promise<T> {
  try {
    return await work()
  } finally {
    await databaseForDataDomain(env, 'ops').prepare(`
      UPDATE scheduler_locks SET expires_at=?
       WHERE lock_key=? AND owner=? AND run_date=? AND run_id=?
    `).bind(new Date().toISOString(), `indicator-finalize:${date}:${runId}`, owner, date, runId).run()
  }
}
