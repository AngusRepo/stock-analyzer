import type { Context, Next } from 'hono'
import type { Bindings, Variables } from '../types'

// ─── JWT (using Web Crypto API, no external deps) ────────────────────────────
function base64url(data: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(data)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + (4 - s.length % 4) % 4, '=')
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
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
    if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null
    return payload
  } catch { return null }
}

// ─── Auth Middleware ─────────────────────────────────────────────────────────
export const authMiddleware = async (c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) => {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

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
  if (c.get('userRole') !== 'admin') return c.json({ error: '需要管理員權限' }, 403)
  await next()
}
