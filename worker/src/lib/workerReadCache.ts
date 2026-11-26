// Shared read-through cache for dashboard/status GET endpoints that are not per-user.
//
// The Worker is served on *.workers.dev, where the Cache API (caches.default/open) is not a
// functional cache (Cloudflare documents functional cache operations for custom domains), so
// the shared tier is KV. A small per-isolate memory tier absorbs bursts (several panels or
// tabs asking for the same packet within seconds) without a KV read.
//
// Only successful values are cached; a fetcher error is never stored. TTLs are display
// freshness choices, not trading parameters, so they live next to each caller.
//
// Concurrent misses each read the source (no cross-request coalescing): with 1-3 tabs the worst
// case is a couple of extra rebuilds per TTL window, and a promise shared across Workers
// requests can hang when its initiator is cancelled. Stale-while-revalidate keeps one
// background refresh per key.

export type ReadCacheStatus = 'memory' | 'kv' | 'miss' | 'bypass'

export type ReadCacheEnvelope<T> = {
  value: T
  captured_at: string
}

export type ReadCacheResult<T> = {
  value: T
  capturedAt: string
  ageSeconds: number
  status: ReadCacheStatus
}

type KvLike = Pick<KVNamespace, 'get' | 'put'>

export const WORKER_READ_CACHE_PREFIX = 'cache:read:v1:'
// KV rejects expirationTtl < 60 s; shorter freshness is enforced from captured_at instead.
const KV_MIN_EXPIRATION_SECONDS = 60
const MEMORY_MAX_ENTRIES = 64
// Large packets (model-pool snapshot is MB-scale) stay out of isolate memory.
const MEMORY_MAX_CHARS = 512 * 1024
// Total JSON chars kept per isolate. Parsed objects take several times their JSON size in V8,
// so 8 M chars stays well inside the 128 MB isolate even when many factor-flow keys are in use.
export const WORKER_READ_CACHE_MEMORY_TOTAL_CHARS = 8 * 1024 * 1024
// A background refresh flag older than the ~30 s waitUntil grace is treated as gone.
const BACKGROUND_REFRESH_FLAG_MS = 30_000

const memory = new Map<string, { expiresAtMs: number; envelope: ReadCacheEnvelope<unknown>; chars: number }>()
let memoryChars = 0
const backgroundRefresh = new Map<string, number>()

export function workerReadCacheKey(namespace: string, parts: Record<string, string | number | boolean | null | undefined> = {}): string {
  const query = Object.keys(parts).sort()
    .filter((key) => parts[key] != null && parts[key] !== '')
    .map((key) => `${key}=${encodeURIComponent(String(parts[key]))}`)
    .join('&')
  return `${WORKER_READ_CACHE_PREFIX}${namespace}${query ? `?${query}` : ''}`
}

function ageSeconds(capturedAt: string, nowMs: number): number {
  const at = Date.parse(capturedAt)
  return Number.isFinite(at) ? Math.max(0, Math.floor((nowMs - at) / 1000)) : Number.POSITIVE_INFINITY
}

function forget(key: string) {
  const entry = memory.get(key)
  if (!entry) return
  memoryChars -= entry.chars
  memory.delete(key)
}

function remember(key: string, envelope: ReadCacheEnvelope<unknown>, serialized: string, ttlSeconds: number, nowMs: number) {
  forget(key)
  if (serialized.length > MEMORY_MAX_CHARS) return
  while (memory.size > 0 && (memory.size >= MEMORY_MAX_ENTRIES || memoryChars + serialized.length > WORKER_READ_CACHE_MEMORY_TOTAL_CHARS)) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    forget(oldest)
  }
  memory.set(key, { expiresAtMs: nowMs + ttlSeconds * 1000, envelope, chars: serialized.length })
  memoryChars += serialized.length
}

/** Test-only: JSON chars currently held in isolate memory. */
export function workerReadCacheMemoryChars(): number {
  return memoryChars
}

async function readSource<T>(
  kv: KvLike | undefined | null,
  key: string,
  fetcher: () => Promise<T>,
  ttlSeconds: number,
  now: () => number,
  cacheable?: (value: T) => boolean,
): Promise<ReadCacheEnvelope<T>> {
  const value = await fetcher()
  const envelope: ReadCacheEnvelope<T> = { value, captured_at: new Date(now()).toISOString() }
  if (cacheable && !cacheable(value)) return envelope
  const serialized = JSON.stringify(envelope)
  remember(key, envelope, serialized, ttlSeconds, now())
  if (kv) {
    try {
      await kv.put(key, serialized, { expirationTtl: Math.max(KV_MIN_EXPIRATION_SECONDS, ttlSeconds) })
    } catch { /* a failed cache write must not fail the read */ }
  }
  return envelope
}

export async function readThroughWorkerCache<T>(
  kv: KvLike | undefined | null,
  key: string,
  fetcher: () => Promise<T>,
  options: {
    ttlSeconds: number
    /** ?fresh=1: skip the cached copy and read the source. */
    bypass?: boolean
    nowMs?: () => number
    /** Packets that degrade instead of throwing (partial reads) return false and are not stored. */
    cacheable?: (value: T) => boolean
    /** Covers the cache write if the client disconnects right after the source answers. */
    waitUntil?: (promise: Promise<unknown>) => void
  },
): Promise<ReadCacheResult<T>> {
  const now = options.nowMs ?? Date.now
  const ttlSeconds = Math.max(1, Math.floor(options.ttlSeconds))

  if (!options.bypass) {
    const local = memory.get(key)
    if (local && local.expiresAtMs > now()) {
      const envelope = local.envelope as ReadCacheEnvelope<T>
      return { value: envelope.value, capturedAt: envelope.captured_at, ageSeconds: ageSeconds(envelope.captured_at, now()), status: 'memory' }
    }
    if (local) forget(key)
    if (kv) {
      try {
        const raw = await kv.get(key)
        if (raw) {
          const envelope = JSON.parse(raw) as ReadCacheEnvelope<T>
          const age = ageSeconds(envelope?.captured_at, now())
          if (envelope && 'value' in envelope && age < ttlSeconds) {
            remember(key, envelope, raw, ttlSeconds - age, now())
            return { value: envelope.value, capturedAt: envelope.captured_at, ageSeconds: age, status: 'kv' }
          }
        }
      } catch { /* cache read failure falls through to the source */ }
    }
  }

  const read = readSource(kv, key, fetcher, ttlSeconds, now, options.cacheable)
  options.waitUntil?.(read.catch(() => undefined))
  const envelope = await read
  return {
    value: envelope.value,
    capturedAt: envelope.captured_at,
    ageSeconds: ageSeconds(envelope.captured_at, now()),
    status: options.bypass ? 'bypass' : 'miss',
  }
}

export type StaleWhileRevalidateResult<T> = ReadCacheResult<T> & { revalidating: boolean }

/**
 * Public, cheap-to-rebuild packets (market indices, news). Within freshSeconds the cached copy is
 * returned; up to staleSeconds the stale copy is returned at once and one background refresh per
 * key is scheduled through waitUntil (HTTP waitUntil work is bounded at ~30 s, so only use this
 * for sources that rebuild in seconds); older or missing copies are rebuilt inline.
 */
export async function readStaleWhileRevalidate<T>(
  kv: KvLike | undefined | null,
  key: string,
  fetcher: () => Promise<T>,
  options: { freshSeconds: number; staleSeconds: number; waitUntil?: (promise: Promise<unknown>) => void; nowMs?: () => number },
): Promise<StaleWhileRevalidateResult<T>> {
  const now = options.nowMs ?? Date.now
  const freshSeconds = Math.max(1, Math.floor(options.freshSeconds))
  const staleSeconds = Math.max(freshSeconds, Math.floor(options.staleSeconds))

  let cached: ReadCacheEnvelope<T> | null = null
  let source: ReadCacheStatus = 'kv'
  const local = memory.get(key)
  if (local && local.expiresAtMs > now()) { cached = local.envelope as ReadCacheEnvelope<T>; source = 'memory' }
  if (!cached && kv) {
    try {
      const raw = await kv.get(key)
      if (raw) {
        const parsed = JSON.parse(raw) as ReadCacheEnvelope<T>
        if (parsed && 'value' in parsed) {
          cached = parsed
          const age = ageSeconds(parsed.captured_at, now())
          if (age < staleSeconds) remember(key, parsed, raw, staleSeconds - age, now())
        }
      }
    } catch { /* fall through to rebuild */ }
  }
  if (cached) {
    const age = ageSeconds(cached.captured_at, now())
    if (age < freshSeconds) {
      return { value: cached.value, capturedAt: cached.captured_at, ageSeconds: age, status: source, revalidating: false }
    }
    if (age < staleSeconds && options.waitUntil) {
      const flaggedAt = backgroundRefresh.get(key)
      if (flaggedAt === undefined || now() - flaggedAt >= BACKGROUND_REFRESH_FLAG_MS) {
        const startedAt = now()
        backgroundRefresh.set(key, startedAt)
        options.waitUntil(readSource(kv, key, fetcher, staleSeconds, now)
          .catch((error) => console.warn('[workerReadCache] background refresh failed', key, error))
          .finally(() => { if (backgroundRefresh.get(key) === startedAt) backgroundRefresh.delete(key) }))
      }
      return { value: cached.value, capturedAt: cached.captured_at, ageSeconds: age, status: source, revalidating: true }
    }
  }
  const read = readSource(kv, key, fetcher, staleSeconds, now)
  options.waitUntil?.(read.catch(() => undefined))
  const fresh = await read
  return { value: fresh.value, capturedAt: fresh.captured_at, ageSeconds: ageSeconds(fresh.captured_at, now()), status: 'miss', revalidating: false }
}

/** Response headers describing a cached read; browsers must not keep authenticated packets. */
export function workerReadCacheHeaders(result: ReadCacheResult<unknown>, ttlSeconds: number): Record<string, string> {
  return {
    'Cache-Control': 'private, no-store',
    'X-SV-Cache': result.status,
    'X-SV-Cache-Age': String(Number.isFinite(result.ageSeconds) ? result.ageSeconds : 0),
    'X-SV-Cache-TTL': String(ttlSeconds),
  }
}

// Only an explicit ?fresh=1 bypasses. The request Cache-Control header is ignored on purpose:
// the frontend fetches with cache: 'no-store', and the Fetch spec then adds
// "Cache-Control: no-cache" to every GET, which would turn the cache off for all reads.
export function shouldBypassWorkerReadCache(fresh: string | undefined | null): boolean {
  return ['1', 'true', 'yes'].includes(String(fresh ?? '').trim().toLowerCase())
}

/** The request's waitUntil, or undefined where no ExecutionContext exists (tests, scripts). */
export function requestWaitUntil(c: { executionCtx: ExecutionContext }): ((promise: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx
    return (promise) => ctx.waitUntil(promise)
  } catch {
    return undefined
  }
}

/** Test-only: clears the isolate tier between cases. */
export function resetWorkerReadCacheMemory(): void {
  memory.clear()
  memoryChars = 0
  backgroundRefresh.clear()
}
