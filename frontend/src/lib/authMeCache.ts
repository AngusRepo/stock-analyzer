// GET /auth/me ran on every full page load (the in-memory React Query cache is lost on reload,
// and several pages are reached by plain <a href> links). The last answer is kept in
// sessionStorage, keyed by a fingerprint of the current token, and seeds the query with its
// original timestamp: within the query's staleTime no request is made, after it the cached user
// renders while /auth/me revalidates in the background. Same tab scope and lifetime as the token.
const STORAGE_KEY = 'sv_auth_me'

type Stored = { fp: string; at: number; user: unknown }

// Not a security boundary (the token itself sits in sessionStorage); it only ties the cached
// user to the token it was fetched with, so a token switch never shows the previous user.
export function tokenFingerprint(token: string | null): string {
  let hash = 0x811c9dc5
  for (const char of token ?? '') {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${(token ?? '').length}:${hash.toString(16)}`
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}

export function readCachedAuthMe(token: string | null, nowMs = Date.now(), maxAgeMs = 30 * 60_000): { user: unknown; updatedAt: number } | undefined {
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const stored = JSON.parse(raw) as Stored
    if (stored?.fp !== tokenFingerprint(token) || !stored.user || !Number.isFinite(stored.at)) return undefined
    if (nowMs - stored.at > maxAgeMs || stored.at > nowMs) return undefined
    return { user: stored.user, updatedAt: stored.at }
  } catch {
    return undefined
  }
}

export function writeCachedAuthMe(token: string | null, user: unknown, nowMs = Date.now()): void {
  try {
    if (!user) {
      clearCachedAuthMe()
      return
    }
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ fp: tokenFingerprint(token), at: nowMs, user } satisfies Stored))
  } catch { /* storage full or blocked: the query still works without it */ }
}

export function clearCachedAuthMe(): void {
  try {
    storage()?.removeItem(STORAGE_KEY)
  } catch { /* ignore */ }
}
