export function arrayFromPayload<T = any>(payload: unknown): T[] {
  return Array.isArray(payload) ? payload as T[] : []
}

export function arrayFieldFromPayload<T = any>(payload: unknown, field: string): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (!payload || typeof payload !== 'object') return []
  return arrayFromPayload<T>((payload as Record<string, unknown>)[field])
}

export function paperOrdersFromPayload<T = any>(payload: unknown): T[] {
  return arrayFieldFromPayload<T>(payload, 'orders')
}

export function paperPositionsFromPayload<T = any>(payload: unknown): T[] {
  return arrayFieldFromPayload<T>(payload, 'positions')
}

export function paperPendingBuysFromPayload<T = any>(payload: unknown): T[] {
  return arrayFieldFromPayload<T>(payload, 'pendingBuys')
}

export function paperPnlSnapshotsFromPayload<T = any>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[]
  if (!payload || typeof payload !== 'object') return []

  const record = payload as Record<string, unknown>
  const snapshots = arrayFromPayload<T>(record.snapshots)
  if (snapshots.length > 0) return snapshots
  return arrayFromPayload<T>(record.daily)
}
