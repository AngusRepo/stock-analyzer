/** Test-only Cloudflare Access issuer: an RSA key pair, a fake JWKS endpoint and signed service-token JWTs. */
export const TEST_TEAM = 'stockvision-test.cloudflareaccess.com'
export const TEST_AUD = 'test-aud-0000000000000000000000000000000000000000000000000000000000'
export const TEST_TOKEN = 'test-bearer-token-not-a-secret'
export const TEST_KID = 'test-kid-1'

export type AccessKeys = {
  privateKey: CryptoKey
  publicJwk: JsonWebKey & { kid: string }
  fetcher: typeof fetch
  jwksCalls: () => number
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64json = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)))

async function rsaPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  ) as CryptoKeyPair
}

let shared: Promise<AccessKeys> | null = null

/** One key pair per process (RSA generation is slow); the fetcher serves its JWKS at the team certs URL only. */
export function accessKeys(): Promise<AccessKeys> {
  shared ??= (async () => {
    const pair = await rsaPair()
    const publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey, kid: TEST_KID }
    let calls = 0
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url !== `https://${TEST_TEAM}/cdn-cgi/access/certs`) return new Response('not found', { status: 404 })
      calls += 1
      return Response.json({ keys: [publicJwk], public_cert: { kid: TEST_KID, cert: 'unused' } })
    }) as typeof fetch
    return { privateKey: pair.privateKey, publicJwk, fetcher, jwksCalls: () => calls }
  })()
  return shared
}

export async function signJwt(privateKey: CryptoKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const head = b64json({ alg: 'RS256', kid: TEST_KID, typ: 'JWT', ...header })
  const body = b64json(payload)
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`)))
  return `${head}.${body}.${b64url(signature)}`
}

export function servicePayload(nowMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(nowMs / 1000)
  return { aud: [TEST_AUD], iss: `https://${TEST_TEAM}`, iat, nbf: iat, exp: iat + 3600, type: 'app', common_name: 'grafana-client.access', sub: '', ...overrides }
}

export async function accessHeaders(keys: AccessKeys, nowMs: number, overrides: Record<string, unknown> = {}): Promise<Headers> {
  return new Headers({
    'cf-access-jwt-assertion': await signJwt(keys.privateKey, servicePayload(nowMs, overrides)),
    authorization: `Bearer ${TEST_TOKEN}`,
  })
}

/** Cache API double: honours max-age against the caller's clock. `store` keys are the cached URLs. */
export function fakeCache(clock: () => number) {
  const store = new Map<string, { response: Response; expires: number }>()
  const url = (key: RequestInfo | URL) => String(key instanceof Request ? key.url : key)
  return {
    store,
    match: async (key: RequestInfo | URL) => {
      const hit = store.get(url(key))
      return hit && hit.expires > clock() ? hit.response.clone() : undefined
    },
    put: async (key: RequestInfo | URL, response: Response) => {
      const ttl = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 0)
      store.set(url(key), { response, expires: clock() + ttl * 1000 })
    },
  }
}
