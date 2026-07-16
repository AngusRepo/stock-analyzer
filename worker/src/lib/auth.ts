import type { Context, Next } from 'hono'
import type { Bindings, Variables } from '../types'
import { getCookie } from 'hono/cookie'

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>
export const SESSION_COOKIE_NAME = 'sv_session'
export const CSRF_COOKIE_NAME = 'sv_csrf'

function isLocalAuthBypass(c: AppContext): boolean {
  const enabled = String((c.env as any).LOCAL_AUTH_BYPASS ?? '').trim() === '1'
  const environment = String((c.env as any).ENVIRONMENT ?? 'development').trim().toLowerCase()
  return enabled && environment !== 'production'
}

function localDevPayload(): Record<string, unknown> {
  return {
    sub: '1',
    email: 'local@stockvision.dev',
    name: 'Local Dev',
    role: 'admin',
  }
}

function setLocalDevUser(c: AppContext) {
  c.set('userId', 1)
  c.set('userEmail', 'local@stockvision.dev')
  c.set('userRole', 'admin')
  c.set('userName', 'Local Dev')
}

// ─── JWT (using Web Crypto API, no external deps) ────────────────────────────
function base64url(data: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + (4 - s.length % 4) % 4, '=')
  const raw = atob(b64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function getHmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  )
}

export async function signJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  const jti    = crypto.randomUUID()   // 唯一 token ID，用於撤銷（blacklist）
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body   = base64url(new TextEncoder().encode(JSON.stringify({ ...payload, jti, iat: Math.floor(Date.now()/1000) })))
  const key    = await getHmacKey(secret)
  const sig    = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`))
  return `${header}.${body}.${base64url(sig)}`
}

export async function verifyJWT(token: string, secret: string): Promise<Record<string, unknown> | null> {
  try {
    const [header, body, sig] = token.split('.')
    if (!header || !body || !sig) return null
    // [SECURITY] Defense-in-depth: 明確驗證 header alg 欄位，防止 algorithm confusion attack
    const decodedHeader = JSON.parse(new TextDecoder().decode(b64urlDecode(header)))
    if (decodedHeader.alg !== 'HS256') return null
    const key   = await getHmacKey(secret)
    const valid = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), new TextEncoder().encode(`${header}.${body}`))
    if (!valid) return null
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)))
    if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now()/1000)) return null
    return payload
  } catch { return null }
}

export function getBearerToken(authHeader?: string | null): string | null {
  if (!authHeader) return null
  const raw = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
  const token = raw.trim()
  return token.length > 0 ? token : null
}

export function hasServiceToken(token: string | null | undefined, serviceToken?: string): boolean {
  return Boolean(token && serviceToken && constantTimeEqual(token, serviceToken))
}

type GoogleJwk = JsonWebKey & { kid?: string; alg?: string; use?: string }
let googleJwksCache: { keys: GoogleJwk[]; expiresAtMs: number } | null = null
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

function cacheMaxAgeMs(cacheControl: string | null): number {
  const match = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/i)
  const seconds = match ? Number(match[1]) : 300
  return Math.max(60, Math.min(Number.isFinite(seconds) ? seconds : 300, 3600)) * 1000
}

async function loadGoogleJwks(forceRefresh = false): Promise<GoogleJwk[]> {
  const now = Date.now()
  if (!forceRefresh && googleJwksCache && googleJwksCache.expiresAtMs > now) return googleJwksCache.keys
  const response = await fetch(GOOGLE_JWKS_URL, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`google_jwks_fetch_failed:${response.status}`)
  const body = await response.json() as { keys?: GoogleJwk[] }
  const keys = Array.isArray(body.keys) ? body.keys.filter((key) => key.kty === 'RSA' && key.kid) : []
  if (!keys.length) throw new Error('google_jwks_empty')
  googleJwksCache = { keys, expiresAtMs: now + cacheMaxAgeMs(response.headers.get('Cache-Control')) }
  return keys
}

async function googleSigningKey(kid: string): Promise<CryptoKey | null> {
  let keys = await loadGoogleJwks()
  let jwk = keys.find((candidate) => candidate.kid === kid)
  if (!jwk) {
    keys = await loadGoogleJwks(true)
    jwk = keys.find((candidate) => candidate.kid === kid)
  }
  if (!jwk || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) return null
  return crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  )
}

export async function verifyGoogleSchedulerOIDC(
  token: string,
  expectedAudience?: string,
  expectedServiceAccount?: string,
): Promise<Record<string, unknown> | null> {
  const audience = String(expectedAudience ?? '').trim()
  const serviceAccount = String(expectedServiceAccount ?? '').trim().toLowerCase()
  if (!audience || !serviceAccount) return null
  try {
    const [headerSegment, payloadSegment, signatureSegment, extra] = token.split('.')
    if (!headerSegment || !payloadSegment || !signatureSegment || extra) return null
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerSegment))) as Record<string, unknown>
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return null
    const key = await googleSigningKey(header.kid)
    if (!key) return null
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64urlDecode(signatureSegment),
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
    )
    if (!valid) return null
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadSegment))) as Record<string, unknown>
    const now = Math.floor(Date.now() / 1000)
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') return null
    if (payload.aud !== audience) return null
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null
    if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null
    if (payload.email_verified !== true) return null
    if (String(payload.email ?? '').trim().toLowerCase() !== serviceAccount) return null
    if (typeof payload.sub !== 'string' || !payload.sub) return null
    return payload
  } catch {
    return null
  }
}

async function getJwtOrServicePayload(c: AppContext): Promise<Record<string, unknown> | null> {
  const token = getBearerToken(c.req.header('Authorization')) ?? getCookie(c, SESSION_COOKIE_NAME) ?? null
  if (!token) return isLocalAuthBypass(c) ? localDevPayload() : null
  if (hasServiceToken(token, c.env.STOCKVISION_AUTH_TOKEN)) {
    return { role: 'service', sub: 'service' }
  }
  const schedulerPayload = await verifyGoogleSchedulerOIDC(
    token, c.env.GOOGLE_SCHEDULER_AUDIENCE, c.env.GOOGLE_SCHEDULER_SERVICE_ACCOUNT,
  )
  if (schedulerPayload) return { ...schedulerPayload, role: 'service' }
  const payload = await verifyJWT(token, c.env.JWT_SECRET)
  if (!payload) return null
  const jti = payload.jti as string | undefined
  if (jti && await c.env.KV.get(`jwt_blacklist:${jti}`) !== null) return null
  return payload
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return diff === 0
}

function csrfErrorForCookieMutation(c: AppContext): Response | null {
  if (getBearerToken(c.req.header('Authorization'))) return null
  if (!getCookie(c, SESSION_COOKIE_NAME)) return null
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method.toUpperCase())) return null
  const cookieToken = getCookie(c, CSRF_COOKIE_NAME) ?? ''
  const headerToken = c.req.header('X-CSRF-Token') ?? ''
  if (cookieToken && headerToken && constantTimeEqual(cookieToken, headerToken)) return null
  return c.json({ error: 'CSRF validation failed' }, 403)
}

export async function requireServiceToken(c: AppContext): Promise<Response | null> {
  if (isLocalAuthBypass(c)) return null
  const token = getBearerToken(c.req.header('Authorization'))
  if (hasServiceToken(token, c.env.STOCKVISION_AUTH_TOKEN)) return null
  if (token && await verifyGoogleSchedulerOIDC(
    token, c.env.GOOGLE_SCHEDULER_AUDIENCE, c.env.GOOGLE_SCHEDULER_SERVICE_ACCOUNT,
  )) return null
  return c.json({ error: 'Unauthorized' }, 401)
}

export async function requireValidToken(c: AppContext): Promise<Response | null> {
  const csrfError = csrfErrorForCookieMutation(c)
  if (csrfError) return csrfError
  const payload = await getJwtOrServicePayload(c)
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  return null
}

export async function requireAdminJWT(c: AppContext): Promise<Response | null> {
  if (isLocalAuthBypass(c)) return null
  const csrfError = csrfErrorForCookieMutation(c)
  if (csrfError) return csrfError
  const token = getBearerToken(c.req.header('Authorization')) ?? getCookie(c, SESSION_COOKIE_NAME) ?? null
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  const payload = await verifyJWT(token, c.env.JWT_SECRET)
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  const jti = payload.jti as string | undefined
  if (jti && await c.env.KV.get(`jwt_blacklist:${jti}`) !== null) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (payload.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
  return null
}

export async function requireAdminOrServiceToken(c: AppContext): Promise<Response | null> {
  const csrfError = csrfErrorForCookieMutation(c)
  if (csrfError) return csrfError
  const payload = await getJwtOrServicePayload(c)
  if (!payload) return c.json({ error: 'Unauthorized' }, 401)
  if (payload.role === 'service' || payload.role === 'admin') return null
  return c.json({ error: 'Admin only' }, 403)
}

// ─── Auth Middleware ─────────────────────────────────────────────────────────
export const authMiddleware = async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
  if (c.get('userId') !== undefined && c.get('userRole')) {
    await next()
    return
  }
  const csrfError = csrfErrorForCookieMutation(c)
  if (csrfError) return csrfError
  const token = getBearerToken(c.req.header('Authorization')) ?? getCookie(c, SESSION_COOKIE_NAME) ?? null

  if (!token && isLocalAuthBypass(c)) {
    setLocalDevUser(c)
    if (new URL(c.req.url).pathname.endsWith('/auth/me')) {
      return c.json({
        id: 1,
        email: 'local@stockvision.dev',
        name: 'Local Dev',
        avatar: null,
        role: 'admin',
        is_primary_admin: true,
        approval_status: 'approved',
        created_at: new Date().toISOString(),
      })
    }
    await next()
    return
  }
  if (!token) return c.json({ error: '請先登入' }, 401)

  const payload = await verifyJWT(token, c.env.JWT_SECRET)
  if (!payload) return c.json({ error: 'Token 無效或已過期' }, 401)

  // [SECURITY] jti blacklist 檢查：token 是否已被登出撤銷（TTL = JWT exp，最長 7 天）
  const jti = payload.jti as string | undefined
  if (jti) {
    const revoked = await c.env.KV.get(`jwt_blacklist:${jti}`)
    if (revoked !== null) return c.json({ error: 'Token 已撤銷，請重新登入' }, 401)
  }

  // [CODE-REVIEW-FIX] 2026-03-23: parseInt 替代 as number 強制 cast，sub 可能是 string
  c.set('userId',    parseInt(String(payload.sub), 10) as number)
  c.set('userEmail', payload.email as string)
  c.set('userRole',  payload.role as string)
  c.set('userName',  payload.name as string)
  await next()
}

// ─── JWT 撤銷（登出時呼叫）──────────────────────────────────────────────────
/** 將 token 加入 KV blacklist，TTL 設為 exp - now（token 自然過期後自動清除）*/
export async function revokeJWT(
  payload: Record<string, unknown>,
  kv: KVNamespace,
): Promise<void> {
  const jti = payload.jti as string | undefined
  if (!jti) return
  const exp = payload.exp as number | undefined
  const ttl = exp ? Math.max(60, exp - Math.floor(Date.now() / 1000)) : 60 * 60 * 24 * 7
  await kv.put(`jwt_blacklist:${jti}`, '1', { expirationTtl: ttl })
}

export const adminMiddleware = async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
  if (isLocalAuthBypass(c) && c.get('userRole') !== 'admin') {
    setLocalDevUser(c)
  }
  if (c.get('userRole') !== 'admin') return c.json({ error: '需要管理員權限' }, 403)
  await next()
}
