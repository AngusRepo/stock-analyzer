import type { Bindings } from '../types'

export const MODEL_POOL_READ_CACHE_PREFIX = 'controller:model_pool:read:v1:'
export const DEFAULT_MODEL_POOL_READ_CACHE_TTL_SECONDS = 45

function parseTtl(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(300, Math.floor(n)))
}

export function resolveModelPoolReadCacheTtl(env: Partial<Bindings> & Record<string, unknown>): number {
  return (
    parseTtl(env.MODEL_POOL_PROXY_CACHE_TTL_SECONDS) ??
    parseTtl(env.MODEL_POOL_READ_CACHE_TTL_SECONDS) ??
    DEFAULT_MODEL_POOL_READ_CACHE_TTL_SECONDS
  )
}

export function shouldBypassModelPoolReadCache(queryValue?: string | null, cacheControl?: string | null): boolean {
  const normalized = String(queryValue ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  return String(cacheControl ?? '').toLowerCase().includes('no-cache')
}

export function buildModelPoolControllerPath(
  basePath: string,
  params: URLSearchParams | Record<string, string | number | boolean | null | undefined> = {},
  options: { bypassCache?: boolean } = {},
): string {
  const query = params instanceof URLSearchParams ? new URLSearchParams(params) : new URLSearchParams()
  if (!(params instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') query.set(key, String(value))
    }
  }
  if (options.bypassCache) query.set('bypass_cache', 'true')
  const qs = query.toString()
  return `${basePath}${qs ? `?${qs}` : ''}`
}

export function modelPoolReadCacheKey(controllerPath: string): string {
  return `${MODEL_POOL_READ_CACHE_PREFIX}${encodeURIComponent(controllerPath)}`
}

export async function readThroughModelPoolCache<T>(
  kv: KVNamespace,
  controllerPath: string,
  fetcher: () => Promise<T>,
  options: { ttlSeconds?: number; bypassCache?: boolean } = {},
): Promise<T> {
  const ttlSeconds = Math.max(0, Math.floor(options.ttlSeconds ?? DEFAULT_MODEL_POOL_READ_CACHE_TTL_SECONDS))
  if (options.bypassCache || ttlSeconds <= 0) return fetcher()

  const key = modelPoolReadCacheKey(controllerPath)
  try {
    const cached = await kv.get(key, 'json') as T | null
    if (cached != null) return cached
  } catch {}

  const data = await fetcher()
  try {
    await kv.put(key, JSON.stringify(data), { expirationTtl: ttlSeconds })
  } catch {}
  return data
}

export async function invalidateModelPoolReadCache(kv: KVNamespace): Promise<{ deleted: number }> {
  try {
    const listed = await kv.list({ prefix: MODEL_POOL_READ_CACHE_PREFIX, limit: 1000 })
    await Promise.allSettled(listed.keys.map((key) => kv.delete(key.name)))
    return { deleted: listed.keys.length }
  } catch {
    return { deleted: 0 }
  }
}
