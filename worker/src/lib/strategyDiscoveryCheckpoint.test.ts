import assert from 'node:assert/strict'
import { runCheckpoint } from '../strategy-discovery/checkpoints'
import { hashJson } from '../strategy-discovery/hashing'
import type { CheckpointRecord } from '../strategy-discovery/repositories'

async function main() {
  let checkpoint: CheckpointRecord | null = null
  const bodies = new Map<string, Uint8Array>()
  let computeCount = 0
  const repository = {
    checkpoint: async () => checkpoint,
    saveCheckpoint: async (value: any) => { checkpoint = { ...value, metadata_json: JSON.stringify(value.metadata ?? {}) } },
  }
  const artifacts = {
    putJson: async (runId: string, type: string, value: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value))
      const hash = await hashJson(value)
      const key = `test/${type}/${hash}.json`
      bodies.set(key, bytes)
      return { artifactId: `${runId}:${type}`, runId, artifactType: type, key, hash, contentType: 'application/json', bytes: bytes.byteLength }
    },
    exists: async (key: string) => bodies.has(key),
    getBytes: async (key: string) => {
      const bytes = bodies.get(key)
      if (!bytes) throw new Error('missing')
      return bytes
    },
  }
  const first = await runCheckpoint({
    runId: 'RUN-1', stepId: '03_feature_intelligence', stepInput: { snapshot: 'A' }, repository, artifacts,
    compute: async () => { computeCount += 1; return { result: 1 } },
  })
  assert.equal(first.reused, false)
  assert.equal(computeCount, 1)
  const second = await runCheckpoint({
    runId: 'RUN-1', stepId: '03_feature_intelligence', stepInput: { snapshot: 'A' }, repository, artifacts,
    compute: async () => { computeCount += 1; return { result: 2 } },
  })
  assert.equal(second.reused, true)
  assert.deepEqual(second.value, { result: 1 })
  assert.equal(computeCount, 1)
  const changed = await runCheckpoint({
    runId: 'RUN-1', stepId: '03_feature_intelligence', stepInput: { snapshot: 'B' }, repository, artifacts,
    compute: async () => { computeCount += 1; return { result: 3 } },
  })
  assert.equal(changed.reused, false)
  assert.equal(computeCount, 2)
  assert.deepEqual(changed.value, { result: 3 })
}

void main()
