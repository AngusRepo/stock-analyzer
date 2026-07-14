import { STRATEGY_DISCOVERY_SCHEMA_VERSION } from './config'
import { contentAddressedKey, sha256Hex, stableStringify } from './hashing'
import type { ArtifactManifestInput, StrategyDiscoveryRepository } from './repositories'
import type { R2Bucket } from '../types'

export interface StoredArtifact {
  artifactId: string
  runId: string
  artifactType: string
  key: string
  hash: string
  contentType: string
  bytes: number
}

export class StrategyDiscoveryArtifacts {
  constructor(
    private readonly bucket: R2Bucket | undefined,
    private readonly repository: Pick<StrategyDiscoveryRepository, 'recordArtifact'>,
  ) {}

  private requireBucket(): R2Bucket {
    if (!this.bucket) throw new Error('strategy_discovery_r2_binding_missing')
    return this.bucket
  }

  async putBytes(input: {
    runId: string
    artifactType: string
    bytes: Uint8Array
    extension: string
    contentType: string
    metadata?: Record<string, unknown>
    schemaVersion?: string | null
  }): Promise<StoredArtifact> {
    const hash = await sha256Hex(input.bytes)
    const key = contentAddressedKey(input.runId, input.artifactType, hash, input.extension)
    const artifactId = `${input.runId}:${input.artifactType}:${hash.slice(0, 16)}`
    await this.requireBucket().put(key, input.bytes, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: { sha256: hash, runId: input.runId, artifactType: input.artifactType },
    })
    const object = await this.requireBucket().head(key)
    if (!object || Number(object.size) !== input.bytes.byteLength) throw new Error('strategy_discovery_r2_write_verification_failed')
    const manifest: ArtifactManifestInput = {
      artifact_id: artifactId,
      run_id: input.runId,
      artifact_type: input.artifactType,
      r2_key: key,
      artifact_hash: hash,
      content_type: input.contentType,
      byte_size: input.bytes.byteLength,
      schema_version: input.schemaVersion ?? null,
      metadata: input.metadata ?? {},
    }
    await this.repository.recordArtifact(manifest)
    return { artifactId, runId: input.runId, artifactType: input.artifactType, key, hash, contentType: input.contentType, bytes: input.bytes.byteLength }
  }

  putJson(runId: string, artifactType: string, value: unknown, metadata?: Record<string, unknown>): Promise<StoredArtifact> {
    return this.putBytes({
      runId,
      artifactType,
      bytes: new TextEncoder().encode(stableStringify(value)),
      extension: 'json',
      contentType: 'application/json',
      metadata,
      schemaVersion: STRATEGY_DISCOVERY_SCHEMA_VERSION,
    })
  }

  async getBytes(key: string, expectedHash?: string): Promise<Uint8Array> {
    const object = await this.requireBucket().get(key)
    if (!object) throw new Error('strategy_discovery_artifact_missing')
    const bytes = new Uint8Array(await object.arrayBuffer())
    if (expectedHash && await sha256Hex(bytes) !== expectedHash) throw new Error('strategy_discovery_artifact_hash_mismatch')
    return bytes
  }

  async exists(key: string, expectedHash?: string): Promise<boolean> {
    const object = await this.requireBucket().head(key)
    if (!object) return false
    if (expectedHash && object.customMetadata?.sha256 !== expectedHash) return false
    return true
  }
}
