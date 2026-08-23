export interface MaintenanceLeaseBusy {
  skipped: true
  reason: string
  leaseGroup: string
  holderTaskName: string
  holderOwnerId: string
  leaseExpiresAt: string
}

export function isMaintenanceLeaseBusy(value: unknown): value is MaintenanceLeaseBusy {
  return Boolean(value && typeof value === 'object' && 'skipped' in value && (value as any).skipped === true)
}

export async function runWithMaintenanceLease<T>(
  db: D1Database,
  input: {
    taskName: string
    run: () => Promise<T>
    leaseGroup?: string
    leaseSeconds?: number
  },
): Promise<T | MaintenanceLeaseBusy> {
  const leaseGroup = input.leaseGroup ?? 'd1_heavy_maintenance'
  const ownerId = `${input.taskName}:${crypto.randomUUID()}`
  const modifier = `+${Math.max(300, Math.floor(input.leaseSeconds ?? 3600))} seconds`
  const claimed = await db.prepare(`
    INSERT INTO maintenance_task_leases (
      lease_group, task_name, owner_id, lease_expires_at, acquired_at, heartbeat_at
    ) VALUES (?, ?, ?, datetime('now', ?), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(lease_group) DO UPDATE SET
      task_name=excluded.task_name,
      owner_id=excluded.owner_id,
      lease_expires_at=excluded.lease_expires_at,
      acquired_at=CURRENT_TIMESTAMP,
      heartbeat_at=CURRENT_TIMESTAMP
    WHERE maintenance_task_leases.lease_expires_at < CURRENT_TIMESTAMP
       OR maintenance_task_leases.owner_id=excluded.owner_id
    RETURNING owner_id
  `).bind(leaseGroup, input.taskName, ownerId, modifier).first<{ owner_id: string }>()
  if (!claimed || claimed.owner_id !== ownerId) {
    const holder = await db.prepare(`
      SELECT task_name, owner_id, lease_expires_at
        FROM maintenance_task_leases
       WHERE lease_group=?
    `).bind(leaseGroup).first<{ task_name: string; owner_id: string; lease_expires_at: string }>()
    const holderTaskName = holder?.task_name ?? 'unknown'
    const holderOwnerId = holder?.owner_id ?? 'unknown'
    const leaseExpiresAt = holder?.lease_expires_at ?? 'unknown'
    return {
      skipped: true,
      reason: `maintenance_lease_busy:${holderTaskName}:${leaseExpiresAt}`,
      leaseGroup,
      holderTaskName,
      holderOwnerId,
      leaseExpiresAt,
    }
  }
  try {
    return await input.run()
  } finally {
    await db.prepare(`
      DELETE FROM maintenance_task_leases
       WHERE lease_group=? AND owner_id=?
    `).bind(leaseGroup, ownerId).run().catch(() => {})
  }
}

export function summarizeMaintenanceLeaseResult(result: unknown): string {
  if (isMaintenanceLeaseBusy(result)) {
    return String((result as any).reason ?? 'maintenance_lease_busy')
  }
  return String(result ?? '')
}
