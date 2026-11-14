// KV config as code (Phase E-7). Values live only in private GCS; the public repo pins each
// key's digest in config/kv/manifest.json. A nightly task digests the live KV value and reports
// drift. Fields that runtime code publishes on its own are excluded from the digest.
// The digest is HMAC-SHA256 keyed by a KV-held key: a plain hash of a small config whose defaults
// are public in source would let anyone confirm guessed production values.

export const KV_CONFIG_MANIFEST_SCHEMA = 'stockvision-kv-config-manifest-v1'
export const KV_CONFIG_MANIFEST_URL =
  'https://raw.githubusercontent.com/AngusRepo/stock-analyzer/main/config/kv/manifest.json'
export const KV_CONFIG_DIGEST_KEY = 'kv-config:digest-key'

export interface KvConfigManifestEntry {
  /** HMAC-SHA256 (see KV_CONFIG_DIGEST_KEY) of the canonical value minus runtime_owned. */
  digest: string
  /** Dot paths written by runtime owners (e.g. OPB NAV publication), not by a config change. */
  runtime_owned: string[]
}

export interface KvConfigManifest {
  schema_version: string
  store: string
  keys: Record<string, KvConfigManifestEntry>
}

export type KvConfigDriftStatus = 'match' | 'drift' | 'missing' | 'invalid'

export interface KvConfigDriftResult {
  key: string
  status: KvConfigDriftStatus
  expected: string
  actual: string | null
}

// Sorted keys at every depth, no whitespace; JSON.stringify formats strings and numbers.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return '{' + Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key])).join(',') + '}'
  }
  const text = JSON.stringify(value)
  if (text === undefined) throw new Error('kv_config_unserializable_value')
  return text
}

export function withoutPaths(value: unknown, paths: string[]): unknown {
  const copy = structuredClone(value)
  for (const path of paths) {
    const parts = path.split('.')
    let node: any = copy
    for (const part of parts.slice(0, -1)) {
      node = node && typeof node === 'object' ? node[part] : undefined
    }
    if (node && typeof node === 'object') delete node[parts[parts.length - 1]]
  }
  return copy
}

export async function hmacSha256Hex(secret: string, text: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('kv_config_digest_key_invalid')
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function kvConfigDigest(raw: string, runtimeOwned: string[], secret: string): Promise<string> {
  return hmacSha256Hex(secret, canonicalJson(withoutPaths(JSON.parse(raw), runtimeOwned)))
}

export function parseKvConfigManifest(value: unknown): KvConfigManifest {
  const manifest = value as KvConfigManifest
  if (manifest?.schema_version !== KV_CONFIG_MANIFEST_SCHEMA) throw new Error('kv_config_manifest_schema_mismatch')
  const keys = Object.entries(manifest.keys ?? {})
  if (!keys.length) throw new Error('kv_config_manifest_empty')
  for (const [key, entry] of keys) {
    if (!/^[0-9a-f]{64}$/.test(entry?.digest ?? '') || !Array.isArray(entry.runtime_owned)) {
      throw new Error('kv_config_manifest_entry_invalid:' + key)
    }
  }
  return manifest
}

export async function checkKvConfigDrift(
  kv: Pick<KVNamespace, 'get'>,
  manifest: KvConfigManifest,
): Promise<KvConfigDriftResult[]> {
  const secret = await kv.get(KV_CONFIG_DIGEST_KEY)
  if (!secret) throw new Error('kv_config_digest_key_missing')
  const results: KvConfigDriftResult[] = []
  for (const [key, entry] of Object.entries(manifest.keys)) {
    const raw = await kv.get(key)
    if (raw === null) {
      results.push({ key, status: 'missing', expected: entry.digest, actual: null })
      continue
    }
    let actual: string
    try {
      actual = await kvConfigDigest(raw, entry.runtime_owned, secret)
    } catch {
      results.push({ key, status: 'invalid', expected: entry.digest, actual: null })
      continue
    }
    results.push({ key, status: actual === entry.digest ? 'match' : 'drift', expected: entry.digest, actual })
  }
  return results
}

/** Nightly task body: throws on any non-match so the scheduler logger raises the usual alert. */
export async function runKvConfigDriftCheck(
  kv: Pick<KVNamespace, 'get'>,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const response = await fetcher(KV_CONFIG_MANIFEST_URL, { cf: { cacheTtl: 0 } } as RequestInit)
  if (!response.ok) throw new Error('kv_config_manifest_unavailable:' + response.status)
  const results = await checkKvConfigDrift(kv, parseKvConfigManifest(await response.json()))
  const summary = results.map((r) => `${r.key}=${r.status}${r.actual ? ':' + r.actual.slice(0, 12) : ''}`).join(' ')
  if (results.some((r) => r.status !== 'match')) throw new Error('kv_config_drift ' + summary)
  return 'kv_config_drift ' + summary
}
