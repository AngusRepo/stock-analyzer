/** Two layers, both fail closed:
 * 1. Cloudflare Access service token: the Cf-Access-Jwt-Assertion JWT is verified in the Worker
 *    (RS256 signature against the team JWKS, iss, aud, exp/nbf, optionally the service token client id). → 403
 * 2. Authorization: Bearer <MONITORING_READ_TOKEN>, compared in constant time. → 401 */

export type AuthEnv = {
  /** Zero Trust team domain, `<team>.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string
  /** Application Audience (AUD) tag of the Access application protecting this Worker. */
  ACCESS_AUD?: string
  /** Optional: the Client ID of the Grafana service token; the JWT's common_name must equal it. */
  ACCESS_SERVICE_TOKEN_CLIENT_ID?: string
  /** Wrangler secret: the second-layer bearer token. */
  MONITORING_READ_TOKEN?: string
}

export type AuthFailure = { status: 401 | 403; error: string }

type Jwk = JsonWebKey & { kid?: string }
type JwksEntry = { keys: Jwk[]; fetchedAt: number; failedAt?: number }

const JWKS_TTL_MS = 60 * 60_000
const JWKS_REFRESH_FLOOR_MS = 60_000
const CLOCK_SKEW_S = 30
const jwksCache = new Map<string, JwksEntry>()

/** Test hook: forget fetched JWKS. */
export function resetJwksCache(): void {
  jwksCache.clear()
}

export function normalizeTeamDomain(value: string | undefined): string | null {
  const host = String(value ?? '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '')
  return /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(host) ? host : null
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('bad base64url')
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function base64UrlJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlBytes(value)))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad json')
  return parsed as Record<string, unknown>
}

async function loadJwks(team: string, fetcher: typeof fetch, nowMs: number, refresh: boolean): Promise<Jwk[]> {
  const cached = jwksCache.get(team)
  const fresh = cached && nowMs - cached.fetchedAt < JWKS_TTL_MS
  // An unknown kid refetches (key rotation), at most once a minute; so does a failed fetch.
  if (cached && fresh && (!refresh || nowMs - cached.fetchedAt < JWKS_REFRESH_FLOOR_MS)) return cached.keys
  if (cached?.failedAt != null && nowMs - cached.failedAt < JWKS_REFRESH_FLOOR_MS) return cached.keys
  let keys: Jwk[]
  try {
    const response = await fetcher(`https://${team}/cdn-cgi/access/certs`, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`jwks_http_${response.status}`)
    const body = await response.json() as { keys?: unknown }
    if (!Array.isArray(body?.keys)) throw new Error('jwks_malformed')
    keys = body.keys.filter((key): key is Jwk => Boolean(key && typeof key === 'object'))
  } catch (error) {
    // An outage keeps the last good keys (signatures, iss, aud and exp are still checked); none: fail closed.
    if (!cached) throw error
    cached.failedAt = nowMs
    return cached.keys
  }
  jwksCache.set(team, { keys, fetchedAt: nowMs })
  return keys
}

async function verifyAccessJwt(token: string, env: AuthEnv, team: string, aud: string, fetcher: typeof fetch, nowMs: number): Promise<string | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return 'access_jwt_malformed'
  let header: Record<string, unknown>
  let payload: Record<string, unknown>
  let signature: Uint8Array<ArrayBuffer>
  try {
    header = base64UrlJson(parts[0])
    payload = base64UrlJson(parts[1])
    signature = base64UrlBytes(parts[2])
  } catch {
    return 'access_jwt_malformed'
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return 'access_jwt_alg'
  let keys: Jwk[]
  try {
    keys = await loadJwks(team, fetcher, nowMs, false)
    if (!keys.some((key) => key.kid === header.kid)) keys = await loadJwks(team, fetcher, nowMs, true)
  } catch {
    return 'access_jwks_unavailable'
  }
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === 'RSA')
  if (!jwk) return 'access_jwt_unknown_key'
  let valid = false
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  } catch {
    valid = false
  }
  if (!valid) return 'access_jwt_signature'
  if (payload.iss !== `https://${team}`) return 'access_jwt_issuer'
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audiences.includes(aud)) return 'access_jwt_audience'
  const nowS = nowMs / 1000
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < nowS) return 'access_jwt_expired'
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > nowS) return 'access_jwt_not_yet_valid'
  const clientId = String(env.ACCESS_SERVICE_TOKEN_CLIENT_ID ?? '').trim()
  if (clientId && payload.common_name !== clientId) return 'access_jwt_client'
  return null
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

/** Constant time for any input: both sides are hashed to 32 bytes before an XOR accumulation. */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i]
  return diff === 0
}

export async function authorize(request: Request, env: AuthEnv, fetcher: typeof fetch, nowMs: number): Promise<AuthFailure | null> {
  const team = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN)
  const aud = String(env.ACCESS_AUD ?? '').trim()
  if (!team || !aud) return { status: 403, error: 'access_not_configured' }
  const assertion = request.headers.get('cf-access-jwt-assertion')
  if (!assertion) return { status: 403, error: 'access_jwt_missing' }
  const accessError = await verifyAccessJwt(assertion.trim(), env, team, aud, fetcher, nowMs)
  if (accessError) return { status: 403, error: accessError }

  const expected = String(env.MONITORING_READ_TOKEN ?? '')
  if (!expected) return { status: 401, error: 'bearer_not_configured' }
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(request.headers.get('authorization') ?? '')
  if (!match) return { status: 401, error: 'bearer_missing' }
  if (!(await constantTimeEqual(match[1], expected))) return { status: 401, error: 'bearer_invalid' }
  return null
}
