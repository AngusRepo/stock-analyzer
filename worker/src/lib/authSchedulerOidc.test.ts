import assert from 'node:assert/strict'
import { verifyGoogleSchedulerOIDC } from './auth'

function base64url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function run(): Promise<void> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey)
  Object.assign(publicJwk, { kid: 'scheduler-test-key', alg: 'RS256', use: 'sig' })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  })

  const audience = 'https://worker.example.test'
  const serviceAccount = 'scheduler@example-project.iam.gserviceaccount.com'
  const now = Math.floor(Date.now() / 1000)
  const sign = async (payload: Record<string, unknown>, alg = 'RS256') => {
    const header = base64url(JSON.stringify({ alg, typ: 'JWT', kid: 'scheduler-test-key' }))
    const body = base64url(JSON.stringify(payload))
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(`${header}.${body}`),
    )
    return `${header}.${body}.${base64url(new Uint8Array(signature))}`
  }
  const validClaims = {
    iss: 'https://accounts.google.com',
    aud: audience,
    sub: 'scheduler-subject',
    email: serviceAccount,
    email_verified: true,
    iat: now,
    exp: now + 300,
  }

  try {
    const valid = await sign(validClaims)
    assert.equal((await verifyGoogleSchedulerOIDC(valid, audience, serviceAccount))?.email, serviceAccount)
    assert.equal(await verifyGoogleSchedulerOIDC(valid, `${audience}/wrong`, serviceAccount), null)
    assert.equal(await verifyGoogleSchedulerOIDC(valid, audience, `other@${serviceAccount.split('@')[1]}`), null)
    assert.equal(await verifyGoogleSchedulerOIDC(await sign({ ...validClaims, exp: now - 1 }), audience, serviceAccount), null)
    assert.equal(await verifyGoogleSchedulerOIDC(await sign(validClaims, 'HS256'), audience, serviceAccount), null)
    const tampered = `${valid.split('.')[0]}.${base64url(JSON.stringify({ ...validClaims, email: 'attacker@example.test' }))}.${valid.split('.')[2]}`
    assert.equal(await verifyGoogleSchedulerOIDC(tampered, audience, serviceAccount), null)
  } finally {
    globalThis.fetch = originalFetch
  }
}

void run().catch((error) => {
  throw error
})
