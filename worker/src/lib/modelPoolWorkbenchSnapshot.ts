// /model-pool reads one source-verified controller observation (ml-controller
// /model_pool/workbench). On 2026-11-25 Cloud Run logged 46-51 s and 5,346,108 bytes per call,
// 82-157 s when five ran at once. The page needs it on every visit, so the Worker keeps the last
// verified observation and splits it into a small summary (first paint) and an evidence section
// fetched by snapshot id, so both halves always come from the same observation.
//
// The snapshot is display state for the UI only. Promotion still goes through the controller's
// promotion_controller, which re-reads the authoritative D1 pointers.
//
// Each request that needs an observation runs its own, with its client waiting (no coalescing
// across requests: for 1-3 tabs it saves little and a promise shared across Workers requests can
// hang when its initiator is cancelled):
// - cached: the KV latest snapshot (any age within retention), else observe;
// - fresh (Refresh button, after a promotion): always observe;
// - revalidate (the page's background refresh of a stale copy): the latest if it is within
//   fresh_seconds (the caller's copy was stale, so it is newer even with the same content id),
//   else observe.
// Before moving the latest pointer the current one is read once and only replaced by an
// observation that started later. KV has no compare-and-set, so two observations finishing at
// nearly the same time can still leave the older pointer; the next revalidate replaces it.

type KvLike = Pick<KVNamespace, 'get' | 'put'>

export type WorkbenchPayload = {
  status?: string
  lineage?: unknown
  selection?: unknown
  promotion_queue?: unknown
  champion_pointers?: Record<string, unknown> | null
  overview?: unknown
  [key: string]: unknown
}

export type WorkbenchSnapshotMeta = {
  id: string
  captured_at: string
  age_seconds: number
  cache: 'kv' | 'memory' | 'miss' | 'refresh'
  stale: boolean
  fresh_seconds: number
  section_bytes: Record<string, number>
  /** Returned to this request only, never stored or shared (the evidence half travels inline). */
  degraded?: 'overview_unavailable'
}

type SnapshotPointer = { id: string; captured_at: string; started_at?: string; section_bytes: Record<string, number> }

export type WorkbenchLoadMode = 'cached' | 'fresh' | 'revalidate'

export const MODEL_POOL_WORKBENCH_LATEST_KEY = 'cache:read:v1:model-pool:workbench:latest'
export const modelPoolWorkbenchSnapshotKey = (id: string) => `cache:read:v1:model-pool:workbench:snapshot:${id}`
// Younger than this the snapshot is served as current; older it is served marked stale and the
// page revalidates once in the background. Kept 6 h so a visit never waits 50 s cold
// unless nobody opened the page for 6 h.
export const MODEL_POOL_WORKBENCH_FRESH_SECONDS = 600
export const MODEL_POOL_WORKBENCH_RETAIN_SECONDS = 6 * 3600
// Latest plus the one before it, so an evidence read for the previous id still hits memory.
const MEMORY_MAX_SNAPSHOTS = 2

type StoredSnapshot = { pointer: SnapshotPointer; payload: WorkbenchPayload }

const memory = new Map<string, StoredSnapshot>()

function bytes(value: unknown): number {
  return value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).length
}

function ageSeconds(capturedAt: string, nowMs: number): number {
  const at = Date.parse(capturedAt)
  return Number.isFinite(at) ? Math.max(0, Math.floor((nowMs - at) / 1000)) : Number.POSITIVE_INFINITY
}

function startedMs(pointer: SnapshotPointer | null | undefined): number {
  const at = Date.parse(pointer?.started_at ?? pointer?.captured_at ?? '')
  return Number.isFinite(at) ? at : 0
}

async function snapshotId(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function meta(pointer: SnapshotPointer, cache: WorkbenchSnapshotMeta['cache'], nowMs: number): WorkbenchSnapshotMeta {
  const age = ageSeconds(pointer.captured_at, nowMs)
  return {
    id: pointer.id,
    captured_at: pointer.captured_at,
    age_seconds: Number.isFinite(age) ? age : MODEL_POOL_WORKBENCH_RETAIN_SECONDS,
    cache,
    stale: age >= MODEL_POOL_WORKBENCH_FRESH_SECONDS,
    fresh_seconds: MODEL_POOL_WORKBENCH_FRESH_SECONDS,
    section_bytes: pointer.section_bytes,
  }
}

function keepInMemory(stored: StoredSnapshot): void {
  memory.delete(stored.pointer.id)
  memory.set(stored.pointer.id, stored)
  while (memory.size > MEMORY_MAX_SNAPSHOTS) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

async function readSnapshot(kv: KvLike | null | undefined, id: string): Promise<{ stored: StoredSnapshot; fromMemory: boolean } | null> {
  const local = memory.get(id)
  if (local) return { stored: local, fromMemory: true }
  if (!kv) return null
  try {
    const stored = await kv.get(modelPoolWorkbenchSnapshotKey(id), 'json') as StoredSnapshot | null
    if (stored?.pointer?.id !== id || !stored.payload) return null
    // Parsed once per isolate: later summary and evidence reads of the same id reuse it.
    keepInMemory(stored)
    return { stored, fromMemory: false }
  } catch {
    return null
  }
}

async function readLatestPointer(kv: KvLike | null | undefined): Promise<SnapshotPointer | null> {
  if (!kv) return null
  try {
    const pointer = await kv.get(MODEL_POOL_WORKBENCH_LATEST_KEY, 'json') as SnapshotPointer | null
    return pointer?.id ? pointer : null
  } catch {
    return null
  }
}

async function observe(
  kv: KvLike | null | undefined,
  fetchController: () => Promise<WorkbenchPayload>,
  now: () => number,
): Promise<{ stored: StoredSnapshot; degraded: boolean }> {
  const started = now()
  const payload = await fetchController()
  if (payload?.status === 'error') throw new Error(String((payload as any).error ?? 'model_pool_workbench_error'))
  const serialized = JSON.stringify(payload)
  const pointer: SnapshotPointer = {
    id: await snapshotId(serialized),
    captured_at: new Date(now()).toISOString(),
    started_at: new Date(started).toISOString(),
    section_bytes: Object.fromEntries(Object.keys(payload ?? {}).map((key) => [key, bytes(payload[key])])),
  }
  const stored = { pointer, payload }
  // Sizes per section go to Workers Logs so the split can be re-measured without a D1 read.
  console.log('[model-pool/workbench] snapshot', JSON.stringify({ id: pointer.id, total_bytes: serialized.length, section_bytes: pointer.section_bytes, observe_ms: now() - started }))
  // The controller degrades a failed optional overview to status ok + overview null. That
  // observation is shown to this request but never published: one controller timeout would
  // otherwise hide the overview for everyone for up to 6 h.
  if (payload?.overview == null) {
    console.warn('[model-pool/workbench] overview unavailable; observation not cached', JSON.stringify({ id: pointer.id }))
    return { stored, degraded: true }
  }
  keepInMemory(stored)
  if (kv) {
    try {
      await kv.put(modelPoolWorkbenchSnapshotKey(pointer.id), JSON.stringify(stored), { expirationTtl: MODEL_POOL_WORKBENCH_RETAIN_SECONDS })
      const current = await readLatestPointer(kv)
      if (!current || startedMs(current) <= started) {
        await kv.put(MODEL_POOL_WORKBENCH_LATEST_KEY, JSON.stringify(pointer), { expirationTtl: MODEL_POOL_WORKBENCH_RETAIN_SECONDS })
      } else {
        console.log('[model-pool/workbench] newer observation already published; latest pointer kept', JSON.stringify({ id: pointer.id, latest: current.id }))
      }
    } catch (error) {
      console.warn('[model-pool/workbench] snapshot cache write failed', error)
    }
  }
  return { stored, degraded: false }
}

export async function loadModelPoolWorkbenchSnapshot(
  kv: KvLike | null | undefined,
  fetchController: () => Promise<WorkbenchPayload>,
  options: {
    mode?: WorkbenchLoadMode
    /** Logged only. */
    staleId?: string | null
    nowMs?: () => number
    waitUntil?: (promise: Promise<unknown>) => void
  } = {},
): Promise<{ meta: WorkbenchSnapshotMeta; payload: WorkbenchPayload }> {
  const now = options.nowMs ?? Date.now
  const mode: WorkbenchLoadMode = options.mode ?? 'cached'

  if (mode !== 'fresh') {
    const pointer = await readLatestPointer(kv)
    const age = pointer ? ageSeconds(pointer.captured_at, now()) : Number.POSITIVE_INFINITY
    if (pointer && age < (mode === 'cached' ? MODEL_POOL_WORKBENCH_RETAIN_SECONDS : MODEL_POOL_WORKBENCH_FRESH_SECONDS)) {
      const found = await readSnapshot(kv, pointer.id)
      if (found) return { meta: meta(found.stored.pointer, found.fromMemory ? 'memory' : 'kv', now()), payload: found.stored.payload }
    }
  }

  if (mode === 'revalidate') console.log('[model-pool/workbench] revalidate observes', JSON.stringify({ stale_id: options.staleId ?? null }))
  const observation = observe(kv, fetchController, now)
  // The client of this request is waiting for it; waitUntil only covers the KV writes if the
  // client disconnects right after the controller answers.
  options.waitUntil?.(observation.catch(() => undefined))
  const { stored, degraded } = await observation
  const result = meta(stored.pointer, mode === 'cached' ? 'miss' : 'refresh', now())
  return { meta: degraded ? { ...result, degraded: 'overview_unavailable' } : result, payload: stored.payload }
}

export async function loadModelPoolWorkbenchSnapshotById(
  kv: KvLike | null | undefined,
  id: string,
  nowMs: () => number = Date.now,
): Promise<{ meta: WorkbenchSnapshotMeta; payload: WorkbenchPayload } | null> {
  if (!/^[a-f0-9]{24}$/.test(id)) return null
  const found = await readSnapshot(kv, id)
  if (!found) return null
  return { meta: meta(found.stored.pointer, found.fromMemory ? 'memory' : 'kv', nowMs()), payload: found.stored.payload }
}

/**
 * First-paint half: lineage, V5 bundle/pointer readiness and overview. The legacy
 * champion_pointers.pointers[] list embeds full registry rows (audit-only, unused by the page),
 * so the summary keeps only its identities.
 */
export function modelPoolWorkbenchSummary(payload: WorkbenchPayload) {
  const pointers = payload.champion_pointers && typeof payload.champion_pointers === 'object'
    ? payload.champion_pointers as Record<string, unknown>
    : null
  const legacy = Array.isArray(pointers?.pointers) ? pointers!.pointers as Array<Record<string, unknown>> : []
  return {
    status: payload.status ?? 'ok',
    lineage: payload.lineage ?? null,
    champion_pointers: pointers ? {
      ...pointers,
      pointers: legacy.map((row) => ({
        model_name: row.model_name ?? null,
        champion_version: row.champion_version ?? null,
        champion_artifact_id: row.champion_artifact_id ?? null,
        authority: row.authority ?? 'legacy_rollback_audit_only',
      })),
    } : null,
    overview: payload.overview ?? null,
  }
}

/** Second half: candidate selection and promotion queue (per-model registry evidence). */
export function modelPoolWorkbenchEvidence(payload: WorkbenchPayload) {
  return {
    status: payload.status ?? 'ok',
    selection: payload.selection ?? null,
    promotion_queue: payload.promotion_queue ?? null,
  }
}

/** Test-only. */
export function resetModelPoolWorkbenchSnapshotMemory(): void {
  memory.clear()
}
