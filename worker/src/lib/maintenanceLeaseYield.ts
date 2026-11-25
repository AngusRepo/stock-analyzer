import { isMaintenanceLeaseBusy, runWithMaintenanceLease, type MaintenanceLeaseBusy } from './maintenanceLease'

// Kept out of maintenanceLease.ts: that module is bundled into native-paper.cjs,
// whose sha must stay identical across Worker-only releases.

// Only the multi-night opt-in audit-json drain yields; it releases the lease
// between attempts, so a short wait reaches the gap it leaves on request.
export const YIELDING_LEASE_HOLDER_TASK = 'audit-json-retention:queue'
export const MAINTENANCE_LEASE_YIELD_WAIT_MS = 40_000
const YIELD_REQUEST_TTL_SECONDS = 120
const YIELD_POLL_MS = 2000
// A same-run takeover also needs the holder to have held this long, so a live delivery is never
// displaced. ~13x the longest legitimate audit-json chunk wall seen (75s across 17:00-22:50 UTC on
// 11/23-24; the 11/24 holder invocations took 7.6-8.9s), and still well under the 300s lease.
export const LEAKED_LEASE_MIN_AGE_SECONDS = 120

function yieldRequestGroup(leaseGroup: string): string {
  return `${leaseGroup}:yield-request`
}

export async function maintenanceLeaseYieldRequested(db: D1Database, leaseGroup = 'd1_heavy_maintenance'): Promise<string | null> {
  const row = await db.prepare(`SELECT task_name FROM maintenance_task_leases
    WHERE lease_group=? AND lease_expires_at > CURRENT_TIMESTAMP`).bind(yieldRequestGroup(leaseGroup)).first<{ task_name: string }>()
  return row?.task_name ?? null
}

/**
 * `runWithMaintenanceLease` that, when busy behind the yielding drain, leaves a
 * yield request and (waitMs > 0) retries until the drain's gap. waitMs = 0 only
 * leaves the request, for callers that already retry on their own.
 */
export async function runWithMaintenanceLeaseYielding<T>(
  db: D1Database,
  input: { taskName: string; run: () => Promise<T>; leaseGroup?: string; leaseSeconds?: number },
  waitMs: number,
): Promise<T | MaintenanceLeaseBusy> {
  const leaseGroup = input.leaseGroup ?? 'd1_heavy_maintenance'
  const requestOwner = `yield-request:${input.taskName}:${crypto.randomUUID()}`
  let requested = false
  const run = async () => {
    if (requested) {
      await db.prepare(`DELETE FROM maintenance_task_leases WHERE lease_group=? AND owner_id=?`)
        .bind(yieldRequestGroup(leaseGroup), requestOwner).run().catch(() => {})
    }
    return input.run()
  }
  let result = await runWithMaintenanceLease(db, { ...input, run })
  if (!isMaintenanceLeaseBusy(result) || result.holderTaskName !== YIELDING_LEASE_HOLDER_TASK) return result
  await db.prepare(`INSERT INTO maintenance_task_leases (
      lease_group, task_name, owner_id, lease_expires_at, acquired_at, heartbeat_at
    ) VALUES (?, ?, ?, datetime('now', ?), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(lease_group) DO UPDATE SET task_name=excluded.task_name, owner_id=excluded.owner_id,
      lease_expires_at=excluded.lease_expires_at, acquired_at=CURRENT_TIMESTAMP, heartbeat_at=CURRENT_TIMESTAMP`)
    .bind(yieldRequestGroup(leaseGroup), `yield-request:${input.taskName}`, requestOwner, `+${YIELD_REQUEST_TTL_SECONDS} seconds`)
    .run().then(() => { requested = true }).catch(() => {})
  const deadline = Date.now() + Math.max(0, waitMs)
  while (isMaintenanceLeaseBusy(result) && Date.now() + YIELD_POLL_MS <= deadline) {
    await new Promise(resolve => setTimeout(resolve, YIELD_POLL_MS))
    result = await runWithMaintenanceLease(db, { ...input, run })
  }
  return result
}

function laterStepOfRun(holderOwnerId: string, runPrefix: string, step: number[]): boolean {
  if (!holderOwnerId.startsWith(runPrefix)) return false
  const held = holderOwnerId.slice(runPrefix.length).split(':')[0].split('.').map(Number)
  if (held.length !== step.length || held.some(n => !Number.isInteger(n))) return false
  const diff = step.findIndex((n, i) => n !== held[i])
  return diff >= 0 && step[diff] > held[diff]
}

/**
 * The audit-json drain's lease. owner_id names its run and step (a tuple that only grows along
 * one run), so a later step takes over, by owner_id CAS, a lease an earlier delivery of the same
 * run left behind (its release failed, or it was killed) instead of yielding to itself until the
 * lease expires, once it is LEAKED_LEASE_MIN_AGE_SECONDS old: a duplicate delivery's lease_busy
 * continuation is also a later step and must not displace a holder still running. An equal or
 * earlier step may be a live duplicate or a stale redelivery and always yields; every other run and task stays mutually exclusive. task_name is unchanged, so other
 * callers still recognize the yielding drain.
 */
export async function runWithRunStepMaintenanceLease<T>(
  db: D1Database,
  input: { taskName: string; runId: string; step: number[]; run: () => Promise<T>; leaseGroup?: string; leaseSeconds?: number },
): Promise<T | MaintenanceLeaseBusy> {
  const leaseGroup = input.leaseGroup ?? 'd1_heavy_maintenance'
  const runPrefix = `${input.taskName}:run=${input.runId}:step=`
  const ownerId = `${runPrefix}${input.step.join('.')}:${crypto.randomUUID()}`
  const modifier = `+${Math.max(300, Math.floor(input.leaseSeconds ?? 3600))} seconds`
  const readHolder = () => db.prepare(`SELECT task_name, owner_id, lease_expires_at FROM maintenance_task_leases WHERE lease_group=?`)
    .bind(leaseGroup).first<{ task_name: string; owner_id: string; lease_expires_at: string }>()
  let claimed = await db.prepare(`INSERT INTO maintenance_task_leases (
      lease_group, task_name, owner_id, lease_expires_at, acquired_at, heartbeat_at
    ) VALUES (?, ?, ?, datetime('now', ?), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(lease_group) DO UPDATE SET task_name=excluded.task_name, owner_id=excluded.owner_id,
      lease_expires_at=excluded.lease_expires_at, acquired_at=CURRENT_TIMESTAMP, heartbeat_at=CURRENT_TIMESTAMP
    WHERE maintenance_task_leases.lease_expires_at < CURRENT_TIMESTAMP
       OR maintenance_task_leases.owner_id=excluded.owner_id
    RETURNING owner_id`).bind(leaseGroup, input.taskName, ownerId, modifier).first<{ owner_id: string }>()
  let holder = claimed?.owner_id === ownerId ? null : await readHolder()
  if (holder && laterStepOfRun(holder.owner_id, runPrefix, input.step)) {
    claimed = await db.prepare(`UPDATE maintenance_task_leases SET task_name=?, owner_id=?, lease_expires_at=datetime('now', ?),
        acquired_at=CURRENT_TIMESTAMP, heartbeat_at=CURRENT_TIMESTAMP
      WHERE lease_group=? AND owner_id=? AND acquired_at <= datetime('now', ?) RETURNING owner_id`)
      .bind(input.taskName, ownerId, modifier, leaseGroup, holder.owner_id, `-${LEAKED_LEASE_MIN_AGE_SECONDS} seconds`)
      .first<{ owner_id: string }>()
    if (claimed?.owner_id === ownerId) console.warn(`[maintenance-lease] took over leaked lease lease_group=${leaseGroup} owner=${holder.owner_id} by=${ownerId}`)
    else holder = await readHolder()
  }
  if (claimed?.owner_id !== ownerId) {
    const holderTaskName = holder?.task_name ?? 'unknown'
    const leaseExpiresAt = holder?.lease_expires_at ?? 'unknown'
    return { skipped: true, reason: `maintenance_lease_busy:${holderTaskName}:${leaseExpiresAt}`, leaseGroup,
      holderTaskName, holderOwnerId: holder?.owner_id ?? 'unknown', leaseExpiresAt }
  }
  const release = () => db.prepare(`DELETE FROM maintenance_task_leases WHERE lease_group=? AND owner_id=?`)
    .bind(leaseGroup, ownerId).run()
  try {
    return await input.run()
  } finally {
    // One bounded retry, then a loud log: a lease left behind blocks every d1-heavy job until it
    // expires. Never thrown, so the chunk's own result or error stays the one reported.
    await release().catch(first => release().catch(error => {
      console.error(`[maintenance-lease] release failed lease_group=${leaseGroup} owner=${ownerId}:`, first, error)
    }))
  }
}
