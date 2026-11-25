import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { authorize, constantTimeEqual, normalizeTeamDomain, resetJwksCache } from './auth'
import { createMonitoringHandler, STATE_TTL_S, TIMELINE_TTL_S, ROUTES } from './index'
import { assertReadOnlySql, ReadLedger, readOnlyD1, ReadOnlyViolation } from './readOnlyD1'
import { accessHeaders, accessKeys, fakeCache, servicePayload, signJwt, TEST_AUD, TEST_KID, TEST_TEAM, TEST_TOKEN } from './monitoringAuth.testSupport'
import { TRADING_DAY_MEMO_TTL_S } from './tradingDay'

const NOW = Date.parse('2026-11-24T15:00:00Z')

function fakeKv(store: Record<string, string> = {}) {
  let gets = 0
  const kv = { get: async (key: string) => { gets += 1; return store[key] ?? null } } as unknown as KVNamespace
  return { kv, gets: () => gets }
}

function env(extra: Record<string, unknown> = {}) {
  return { ACCESS_TEAM_DOMAIN: TEST_TEAM, ACCESS_AUD: TEST_AUD, MONITORING_READ_TOKEN: TEST_TOKEN, KV: fakeKv().kv, ...extra } as never
}

async function request(path: string, headers: HeadersInit, init: RequestInit = {}) {
  return new Request(`https://monitoring.test${path}`, { headers, ...init })
}

beforeEach(() => resetJwksCache())

test('405 for every non-GET method, before any auth work', async () => {
  const keys = await accessKeys()
  const handler = createMonitoringHandler({ now: () => NOW, fetch: keys.fetcher, cache: null })
  const base = keys.jwksCalls()
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await handler(await request('/v1/trading-day', {}, { method }), env())
    assert.equal(response.status, 405, method)
    assert.equal(response.headers.get('allow'), 'GET')
  }
  assert.equal(keys.jwksCalls() - base, 0, 'JWKS not fetched for a 405')
})

test('403 without a valid Cloudflare Access JWT', async () => {
  const keys = await accessKeys()
  const handler = createMonitoringHandler({ now: () => NOW, fetch: keys.fetcher, cache: null })
  const bearer = { authorization: `Bearer ${TEST_TOKEN}` }
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const valid = await signJwt(keys.privateKey, servicePayload(NOW))
  const [head, body] = valid.split('.')
  const cases: Array<[string, HeadersInit, string, object?]> = [
    ['missing', bearer, 'access_jwt_missing'],
    ['malformed', { ...bearer, 'cf-access-jwt-assertion': 'abc.def' }, 'access_jwt_malformed'],
    ['bad signature', { ...bearer, 'cf-access-jwt-assertion': await signJwt(other.privateKey, servicePayload(NOW)) }, 'access_jwt_signature'],
    ['tampered payload', { ...bearer, 'cf-access-jwt-assertion': `${head}.${btoa(JSON.stringify(servicePayload(NOW, { aud: ['x'] }))).replace(/=+$/, '')}.${valid.split('.')[2]}` }, 'access_jwt_signature'],
    ['alg none', { ...bearer, 'cf-access-jwt-assertion': `${btoa(JSON.stringify({ alg: 'none', kid: TEST_KID })).replace(/=+$/, '')}.${body}.` }, 'access_jwt_alg'],
    ['HS256', { ...bearer, 'cf-access-jwt-assertion': await signJwt(keys.privateKey, servicePayload(NOW), { alg: 'HS256' }) }, 'access_jwt_alg'],
    ['unknown kid', { ...bearer, 'cf-access-jwt-assertion': await signJwt(keys.privateKey, servicePayload(NOW), { kid: 'rotated' }) }, 'access_jwt_unknown_key'],
    ['wrong aud', { ...bearer, 'cf-access-jwt-assertion': await signJwt(keys.privateKey, servicePayload(NOW, { aud: ['other-app'] })) }, 'access_jwt_audience'],
    ['wrong iss', { ...bearer, 'cf-access-jwt-assertion': await signJwt(keys.privateKey, servicePayload(NOW, { iss: 'https://evil.cloudflareaccess.com' })) }, 'access_jwt_issuer'],
    ['expired', { ...bearer, 'cf-access-jwt-assertion': await signJwt(keys.privateKey, servicePayload(NOW, { exp: NOW / 1000 - 60 })) }, 'access_jwt_expired'],
    ['no exp', { ...bearer, 'cf-access-jwt-assertion': await signJwt(keys.privateKey, servicePayload(NOW, { exp: undefined })) }, 'access_jwt_expired'],
    ['not yet valid', { ...bearer, 'cf-access-jwt-assertion': await signJwt(keys.privateKey, servicePayload(NOW, { nbf: NOW / 1000 + 600 })) }, 'access_jwt_not_yet_valid'],
    ['other service token', { ...bearer, 'cf-access-jwt-assertion': await signJwt(keys.privateKey, servicePayload(NOW, { common_name: 'someone-else.access' })) }, 'access_jwt_client',
      { ACCESS_SERVICE_TOKEN_CLIENT_ID: 'grafana-client.access' }],
    ['team not configured', { ...bearer, 'cf-access-jwt-assertion': valid }, 'access_not_configured', { ACCESS_TEAM_DOMAIN: undefined }],
    ['aud not configured', { ...bearer, 'cf-access-jwt-assertion': valid }, 'access_not_configured', { ACCESS_AUD: '' }],
    ['team not an Access domain', { ...bearer, 'cf-access-jwt-assertion': valid }, 'access_not_configured', { ACCESS_TEAM_DOMAIN: 'evil.example.com' }],
  ]
  for (const [name, headers, error, extra] of cases) {
    const response = await handler(await request('/v1/trading-day', headers), env(extra as Record<string, unknown>))
    assert.equal(response.status, 403, name)
    assert.deepEqual(await response.json(), { error }, name)
  }
})

test('JWKS: cached for an hour, an unknown kid refetches at most once a minute, outage fails closed', async () => {
  const keys = await accessKeys()
  const good = await accessHeaders(keys, NOW)
  const base = keys.jwksCalls()
  assert.equal(await authorize(await request('/', good), env(), keys.fetcher, NOW), null)
  assert.equal(await authorize(await request('/', good), env(), keys.fetcher, NOW + 1000), null)
  assert.equal(keys.jwksCalls() - base, 1)
  const rotated = { 'cf-access-jwt-assertion': await signJwt(keys.privateKey, servicePayload(NOW), { kid: 'rotated' }), authorization: `Bearer ${TEST_TOKEN}` }
  await authorize(await request('/', rotated), env(), keys.fetcher, NOW + 2000)
  await authorize(await request('/', rotated), env(), keys.fetcher, NOW + 3000)
  assert.equal(keys.jwksCalls() - base, 1, 'within a minute of the last fetch: no refetch')
  await authorize(await request('/', rotated), env(), keys.fetcher, NOW + 61_000)
  assert.equal(keys.jwksCalls() - base, 2)
  // An outage after the TTL keeps the last good keys (network error or HTTP error), refetching at most once a minute.
  let attempts = 0
  const offline = (async () => { attempts += 1; throw new TypeError('network down') }) as typeof fetch
  const later = NOW + 2 * 3600_000
  assert.equal(await authorize(await request('/', await accessHeaders(keys, later)), env(), offline, later), null)
  assert.equal(await authorize(await request('/', await accessHeaders(keys, later)), env(), offline, later + 1000), null)
  assert.equal(attempts, 1)
  resetJwksCache()
  assert.deepEqual(await authorize(await request('/', good), env(), offline, NOW), { status: 403, error: 'access_jwks_unavailable' })
  resetJwksCache()
  const down = (async () => new Response('oops', { status: 503 })) as typeof fetch
  assert.deepEqual(await authorize(await request('/', good), env(), down, NOW), { status: 403, error: 'access_jwks_unavailable' })
})

test('401 without the bearer token, after Access passes', async () => {
  const keys = await accessKeys()
  const handler = createMonitoringHandler({ now: () => NOW, fetch: keys.fetcher, cache: null })
  const jwt = await signJwt(keys.privateKey, servicePayload(NOW))
  const cases: Array<[string, Record<string, string>, string, object?]> = [
    ['missing', {}, 'bearer_missing'],
    ['basic scheme', { authorization: `Basic ${TEST_TOKEN}` }, 'bearer_missing'],
    ['wrong', { authorization: 'Bearer nope' }, 'bearer_invalid'],
    ['prefix', { authorization: `Bearer ${TEST_TOKEN.slice(0, -1)}` }, 'bearer_invalid'],
    ['extra token', { authorization: `Bearer ${TEST_TOKEN} x` }, 'bearer_missing'],
    ['not configured', { authorization: `Bearer ${TEST_TOKEN}` }, 'bearer_not_configured', { MONITORING_READ_TOKEN: '' }],
  ]
  for (const [name, headers, error, extra] of cases) {
    const response = await handler(await request('/v1/trading-day', { 'cf-access-jwt-assertion': jwt, ...headers }), env(extra as Record<string, unknown>))
    assert.equal(response.status, 401, name)
    assert.deepEqual(await response.json(), { error }, name)
  }
  // Bearer alone (no Access JWT) is a 403, never a 200.
  const bearerOnly = await handler(await request('/v1/trading-day', { authorization: `Bearer ${TEST_TOKEN}` }), env())
  assert.equal(bearerOnly.status, 403)
})

test('200 with Access JWT and bearer; optional service-token client id; unknown route 404 only after auth', async () => {
  const keys = await accessKeys()
  const handler = createMonitoringHandler({ now: () => NOW, fetch: keys.fetcher, cache: null })
  const ok = await handler(await request('/v1/trading-day?date=2026-11-24', await accessHeaders(keys, NOW)), env({ ACCESS_SERVICE_TOKEN_CLIENT_ID: 'grafana-client.access' }))
  assert.equal(ok.status, 200)
  const body = await ok.json() as any
  assert.deepEqual([body.trading, body.rows_read, body.rows], [true, 0, [{ date: '2026-11-24', trading: true }]])
  assert.equal(body.generated_at, new Date(NOW).toISOString())
  assert.equal(ok.headers.get('cache-control'), 'private, no-store')
  assert.equal((await handler(await request('/v1/nope', {}), env())).status, 403, 'no route discovery without auth')
  assert.equal((await handler(await request('/v1/nope', await accessHeaders(keys, NOW)), env())).status, 404)
  assert.equal((await handler(await request('/v1/trading-day?date=2026-13-01', await accessHeaders(keys, NOW)), env())).status, 400)
  assert.equal((await handler(await request('/v1/chain/timeline?days=abc', await accessHeaders(keys, NOW)), env())).status, 400)
})

test('constantTimeEqual and team-domain normalisation', async () => {
  assert.equal(await constantTimeEqual('abc', 'abc'), true)
  assert.equal(await constantTimeEqual('abc', 'abd'), false)
  assert.equal(await constantTimeEqual('abc', 'abcd'), false)
  assert.equal(await constantTimeEqual('', 'a'), false)
  assert.equal(normalizeTeamDomain('https://Team-1.cloudflareaccess.com/'), 'team-1.cloudflareaccess.com')
  assert.equal(normalizeTeamDomain('team.cloudflareaccess.com.evil.com'), null)
  assert.equal(normalizeTeamDomain('a.b.cloudflareaccess.com'), null)
})

test('Cache API: 30 s state / 300 s timeline; HIT skips every read; auth still runs on a HIT; key ignores headers and unknown params', async () => {
  assert.deepEqual([STATE_TTL_S, TIMELINE_TTL_S], [30, 300])
  assert.equal(ROUTES['/v1/chain/state'].ttl, 30)
  assert.equal(ROUTES['/v1/chain/alerts'].ttl, 30)
  assert.equal(ROUTES['/v1/chain/timeline'].ttl, 300)
  let clock = NOW
  const cache = fakeCache(() => clock)
  const { store } = cache
  const keys = await accessKeys()
  const handler = createMonitoringHandler({ now: () => clock, fetch: keys.fetcher, cache: cache as never })
  const { kv, gets } = fakeKv()
  const call = async (path: string) => handler(await request(path, await accessHeaders(keys, clock)), env({ KV: kv }))
  const first = await call('/v1/trading-day?date=2026-11-24&utm=1')
  assert.equal(first.headers.get('x-monitoring-cache'), 'MISS')
  assert.equal(first.headers.get('cache-control'), 'private, no-store', 'clients never cache')
  const readsAfterMiss = gets()
  assert.ok(readsAfterMiss > 0)
  const second = await call('/v1/trading-day?utm=2&date=2026-11-24')
  assert.equal(second.headers.get('x-monitoring-cache'), 'HIT')
  assert.equal(gets(), readsAfterMiss, 'a HIT reads nothing')
  const memoKey = 'https://monitoring.test/__memo/trading-day%7C2026-11-24'
  assert.deepEqual([...store.keys()].sort(), [memoKey, 'https://monitoring.test/v1/trading-day?date=2026-11-24'])
  assert.equal((await call('/__memo/trading-day%7C2026-11-24')).status, 404, 'memo entries are never served')
  assert.equal((await handler(await request('/v1/trading-day?date=2026-11-24', { authorization: `Bearer ${TEST_TOKEN}` }), env({ KV: kv }))).status, 403, 'cached data still needs Access')
  clock += 31_000
  assert.equal((await call('/v1/trading-day?date=2026-11-24')).headers.get('x-monitoring-cache'), 'MISS', 'expired after 30 s')
  assert.equal(gets(), readsAfterMiss, 'the closure is asked of KV once per 5 minutes, not per miss')
  clock += TRADING_DAY_MEMO_TTL_S * 1000
  await call('/v1/trading-day?date=2026-11-24')
  assert.ok(gets() > readsAfterMiss, 'and again after the memo expires')
})

test('assertReadOnlySql: SELECT / WITH … SELECT / EXPLAIN only', () => {
  for (const sql of [
    'SELECT 1',
    '  select * from t where a = ? ;',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'EXPLAIN QUERY PLAN SELECT * FROM t',
    "SELECT replace(name, 'a', 'b') FROM t",
    "SELECT 'DELETE FROM t; DROP TABLE t' AS s",
    'SELECT "update" FROM t -- insert into t\n',
    "SELECT /* drop table */ 1",
    "SELECT created_at, updated_at FROM t",
  ]) assert.doesNotThrow(() => assertReadOnlySql(sql), sql)
  for (const sql of [
    '', 'DELETE FROM t', 'INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'REPLACE INTO t VALUES (1)', 'DROP TABLE t',
    'CREATE TABLE t (a)', 'ALTER TABLE t ADD COLUMN b', 'PRAGMA table_info(t)', "ATTACH 'x' AS y", 'VACUUM', 'BEGIN',
    'WITH x AS (SELECT 1) DELETE FROM t', 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x',
    'SELECT 1; DELETE FROM t', 'SELECT 1; SELECT 2', 'EXPLAIN DELETE FROM t', 'SELECT * FROM t RETURNING *',
    "SELECT 'unterminated", 'SELECT 1 /* unterminated', 'values (1)', 'ANALYZE',
  ]) assert.throws(() => assertReadOnlySql(sql), ReadOnlyViolation, sql)
})

function fakeD1(meta: Record<string, unknown> = { rows_read: 7, rows_written: 0, changes: 0, changed_db: false }) {
  const calls: string[] = []
  const statement = (sql: string): D1PreparedStatement => ({
    bind: () => statement(sql),
    all: async () => { calls.push(sql); return { results: [{ a: 1 }], success: true, meta } },
    first: async () => { throw new Error('inner first() must not be used') },
    run: async () => { throw new Error('inner run() must not be used') },
    raw: async () => { throw new Error('inner raw() must not be used') },
  }) as unknown as D1PreparedStatement
  const db = {
    prepare: statement,
    batch: async (statements: D1PreparedStatement[]) => Promise.all(statements.map((s) => s.all())),
    exec: async () => { calls.push('exec') },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database
  return { db, calls }
}

test('readOnlyD1: writes refused before D1, escape hatches closed, rows_read accounted, a reported write throws', async () => {
  const { db, calls } = fakeD1()
  const ledger = new ReadLedger()
  const ro = readOnlyD1(db, 'OPS_DB', ledger)
  assert.throws(() => ro.prepare('DELETE FROM ops_chain_stage_state_v1'), ReadOnlyViolation)
  assert.throws(() => ro.prepare('WITH x AS (SELECT 1) UPDATE t SET a = 1'), ReadOnlyViolation)
  await assert.rejects(() => ro.exec('SELECT 1'), ReadOnlyViolation)
  await assert.rejects(() => (ro as any).dump(), ReadOnlyViolation)
  assert.throws(() => (ro as any).withSession(), ReadOnlyViolation)
  await assert.rejects(() => ro.prepare('SELECT 1').raw(), ReadOnlyViolation)
  await assert.rejects(() => ro.batch([db.prepare('DELETE FROM t')]), ReadOnlyViolation, 'unwrapped statements are refused')
  assert.deepEqual(calls, [], 'nothing reached D1')

  assert.deepEqual(await ro.prepare('SELECT a FROM t WHERE b = ?').bind(1).first(), { a: 1 })
  assert.equal(await ro.prepare('SELECT a FROM t').first('a'), 1)
  await ro.prepare('SELECT 2').run()
  await ro.batch([ro.prepare('SELECT 3'), ro.prepare('SELECT 4').bind('x')])
  assert.equal(ledger.rowsRead, 5 * 7)
  assert.deepEqual(ledger.queries.map((q) => [q.db, q.sql, q.params]), [
    ['OPS_DB', 'SELECT a FROM t WHERE b = ?', [1]], ['OPS_DB', 'SELECT a FROM t', []], ['OPS_DB', 'SELECT 2', []],
    ['OPS_DB', 'SELECT 3', []], ['OPS_DB', 'SELECT 4', ['x']],
  ])
  for (const meta of [{ rows_written: 1 }, { changes: 2 }, { changed_db: true }]) {
    const writer = readOnlyD1(fakeD1(meta).db, 'X', new ReadLedger())
    await assert.rejects(() => writer.prepare('SELECT 1').all(), ReadOnlyViolation, JSON.stringify(meta))
  }
})
