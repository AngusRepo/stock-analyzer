import { isMaintenanceLeaseBusy, runWithMaintenanceLease, type MaintenanceLeaseBusy } from './maintenanceLease'

// Kept out of maintenanceLease.ts: that module is bundled into native-paper.cjs,
// whose sha must stay identical across Worker-only releases.

// Only the multi-night opt-in audit-json drain yields; it releases the lease
// between attempts, so a short wait reaches the gap it leaves on request.
export const YIELDING_LEASE_HOLDER_TASK = 'audit-json-retention:queue'
export const MAINTENANCE_LEASE_YIELD_WAIT_MS = 40_000
const YIELD_REQUEST_TTL_SECONDS = 120
const YIELD_POLL_MS = 2000

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
