import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const store = new Map<string, string>()
;(globalThis as any).window = {
  sessionStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  },
}
const { clearCachedAuthMe, readCachedAuthMe, tokenFingerprint, writeCachedAuthMe } = await import('./authMeCache.ts')

const t0 = Date.parse('2026-11-26T03:00:00Z')
const user = { email: 'wei@example.test', role: 'admin' }

assert.notEqual(tokenFingerprint('token-a'), tokenFingerprint('token-b'))
assert.equal(readCachedAuthMe('token-a', t0), undefined)

writeCachedAuthMe('token-a', user, t0)
assert.ok(![...store.values()].some((value) => value.includes('token-a')), 'the raw token must not be copied into the cache')
assert.deepEqual(readCachedAuthMe('token-a', t0 + 60_000), { user, updatedAt: t0 })
// A different token never sees the previous user.
assert.equal(readCachedAuthMe('token-b', t0 + 60_000), undefined)
assert.equal(readCachedAuthMe(null, t0 + 60_000), undefined)
// Too old or from the future: not used.
assert.equal(readCachedAuthMe('token-a', t0 + 31 * 60_000), undefined)
assert.equal(readCachedAuthMe('token-a', t0 - 1), undefined)

writeCachedAuthMe('token-a', null, t0)
assert.equal(readCachedAuthMe('token-a', t0), undefined, 'an empty answer clears the cache')
writeCachedAuthMe('token-a', user, t0)
clearCachedAuthMe()
assert.equal(readCachedAuthMe('token-a', t0), undefined)

store.set('sv_auth_me', '{not json')
assert.equal(readCachedAuthMe('token-a', t0), undefined)

const hook = readFileSync(new URL('../_core/hooks/useAuth.ts', import.meta.url), 'utf8')
assert.ok(hook.includes('initialData: cachedMe?.user') && hook.includes('initialDataUpdatedAt: cachedMe?.updatedAt'), 'useAuth seeds /auth/me from the session cache')
assert.ok((hook.match(/clearCachedAuthMe\(\)/g) ?? []).length >= 3, 'logout, sign-out event and a failed /auth/me clear the cache')

console.log('authMeCache: OK')
