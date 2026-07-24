import assert from 'node:assert/strict'
import test from 'node:test'

import { buildWorkerHealthPayload } from './runtimeVersion'

test('worker health reports immutable Cloudflare version metadata', () => {
  const payload = buildWorkerHealthPayload({
    id: 'version-123',
    tag: '0123456789abcdef0123456789abcdef01234567',
    timestamp: '2026-07-24T00:00:00.000Z',
  })

  assert.equal(payload.provenance.attested, true)
  assert.equal(payload.provenance.versionId, 'version-123')
  assert.equal(payload.provenance.sourceSha, '0123456789abcdef0123456789abcdef01234567')
})

test('worker health is explicit when provenance is unavailable locally', () => {
  const payload = buildWorkerHealthPayload()

  assert.equal(payload.provenance.attested, false)
  assert.equal(payload.provenance.sourceSha, '')
})
