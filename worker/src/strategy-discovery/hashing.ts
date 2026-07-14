function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical_json_non_finite_number')
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen))
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (seen.has(object)) throw new Error('canonical_json_cycle')
    seen.add(object)
    const next: Record<string, unknown> = {}
    for (const key of Object.keys(object).sort()) {
      const child = object[key]
      if (child !== undefined) next[key] = canonicalize(child, seen)
    }
    seen.delete(object)
    return next
  }
  throw new Error(`canonical_json_unsupported_type:${typeof value}`)
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()))
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const input = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  input.set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', input.buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashJson(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value))
}

export function contentAddressedKey(runId: string, artifactType: string, hash: string, extension: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('invalid_run_id_for_artifact_key')
  if (!/^[a-z0-9._-]+$/.test(artifactType)) throw new Error('invalid_artifact_type_for_key')
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid_artifact_hash_for_key')
  if (!/^[a-z0-9]+$/.test(extension)) throw new Error('invalid_artifact_extension')
  return `strategy-discovery/runs/${runId}/${artifactType}/${hash}.${extension}`
}
