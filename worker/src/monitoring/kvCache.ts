/** Route cache and memo for workers.dev, where the Cache API stores nothing: an in-isolate map in front of a
 * dedicated KV namespace (MONITORING_CACHE). Freshness is the stored expiry (the response's max-age), not KV's own
 * TTL, so an entry is never served past its route TTL; KV only bounds how long the key lives (minimum 60 s). */

type Entry = { expires: number; status: number; headers: [string, string][]; body: string }
export type CacheLike = Pick<Cache, 'match' | 'put'>

const KV_MIN_TTL_S = 60
/** KV keys are at most 512 bytes; a longer key (an unvalidated parameter) is served without the cache. */
const KV_MAX_KEY_BYTES = 512
export const MEMORY_MAX_ENTRIES = 256
export const MEMORY_MAX_BYTES = 16 * 1024 * 1024

function keyOf(request: RequestInfo | URL): string {
  const url = new URL(request instanceof Request ? request.url : String(request))
  return `${url.pathname}${url.search}`
}

function toResponse(entry: Entry): Response {
  return new Response(entry.body, { status: entry.status, headers: entry.headers })
}

const tooLong = (key: string) => new TextEncoder().encode(key).length > KV_MAX_KEY_BYTES

export function kvCache(kv: KVNamespace, clock: () => number = Date.now, memory = new Map<string, Entry>()): CacheLike {
  const bytes = () => [...memory.values()].reduce((sum, entry) => sum + entry.body.length * 2, 0)
  const remember = (key: string, entry: Entry) => {
    memory.delete(key)
    memory.set(key, entry)
    while (memory.size > MEMORY_MAX_ENTRIES || (memory.size > 1 && bytes() > MEMORY_MAX_BYTES)) {
      memory.delete(memory.keys().next().value as string)
    }
  }
  return {
    match: async (request: RequestInfo | URL) => {
      const key = keyOf(request)
      if (tooLong(key)) return undefined
      const now = clock()
      const local = memory.get(key)
      if (local && local.expires > now) return toResponse(local)
      if (local) memory.delete(key)
      let stored: Entry | null
      try {
        stored = await kv.get(key, 'json') as Entry | null
      } catch (error) {
        // A KV outage must not fail a read D1 can still answer.
        console.warn(`[monitoring] cache read ${key} failed:`, error)
        return undefined
      }
      if (!stored || stored.expires <= now) return undefined
      remember(key, stored)
      return toResponse(stored)
    },
    put: async (request: RequestInfo | URL, response: Response) => {
      const ttlS = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 0)
      if (!(ttlS > 0)) return
      const key = keyOf(request)
      if (tooLong(key)) return
      const entry: Entry = { expires: clock() + ttlS * 1000, status: response.status, headers: [...response.headers], body: await response.text() }
      remember(key, entry)
      try {
        await kv.put(key, JSON.stringify(entry), { expirationTtl: Math.max(KV_MIN_TTL_S, ttlS) })
      } catch (error) {
        // KV allows one write per second per key; a lost write only costs the next isolate a re-read.
        console.warn(`[monitoring] cache write ${key} failed:`, error)
      }
    },
  } as CacheLike
}
