import assert from 'node:assert/strict'
import { writeEvidenceArtifact } from './artifactLifecycle'
import type { EvidenceArtifactManifest, EvidenceArtifactWriteInput } from './evidenceArtifactContract'
import { RestEvidenceArtifactWriter } from '../node-runner/cloudflareRestBindings'
import { adminControlRoutes } from '../routes/adminControlRoutes'

const input: EvidenceArtifactWriteInput = {
  domain: 'screener_funnel',
  businessDate: '2026-07-14',
  producerRunId: 'screener-run-1',
  retentionClass: 'canonical_model_evidence',
  schemaVersion: 'screener-funnel-evidence-v2',
  payload: { items: [{ symbol: '2330' }] },
  rowCount: 1,
  metadata: { status: 'success' },
}

function readyManifest(): EvidenceArtifactManifest {
  return {
    artifact_id: 'artifact:screener_funnel:2026-07-14:abc',
    retention_class: 'canonical_model_evidence',
    status: 'ready',
    domain: 'screener_funnel',
    business_date: '2026-07-14',
    producer_run_id: 'screener-run-1',
    canonical_run_id: null,
    r2_key: 'evidence/class=canonical_model_evidence/domain=screener_funnel/business_date=2026-07-14/chunk=abc.json',
    checksum: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    schema_version: 'screener-funnel-evidence-v2',
    row_count: 1,
    byte_size: 100,
    created_at: '2026-07-14T13:00:00.000Z',
    retain_until: null,
    checksum_verified_at: '2026-07-14T13:00:01.000Z',
    metadata_json: '{}',
  }
}

void (async () => {
  await assert.rejects(
    writeEvidenceArtifact({ DB: {} as D1Database }, input),
    /artifact_r2_binding_missing/,
  )

  let delegated: EvidenceArtifactWriteInput | null = null
  const delegatedManifest = await writeEvidenceArtifact({
    DB: {} as D1Database,
    EVIDENCE_ARTIFACT_WRITER: {
      async write(value) {
        delegated = value
        return readyManifest()
      },
    },
  }, input)
  assert.equal(delegated?.producerRunId, input.producerRunId)
  assert.equal(delegatedManifest.status, 'ready')

  const originalFetch = globalThis.fetch
  let request: { url: string; init?: RequestInit } | null = null
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init }
    return new Response(JSON.stringify({ ok: true, manifest: readyManifest() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const writer = new RestEvidenceArtifactWriter({
      workerUrl: 'https://worker.example.test',
      serviceToken: 'service-token',
      maxRetries: 0,
    })
    const manifest = await writer.write(input)
    assert.equal(manifest.domain, 'screener_funnel')
    assert.equal(request?.url, 'https://worker.example.test/api/internal/evidence-artifacts/screener-funnel')
    assert.equal(new Headers(request?.init?.headers).get('Authorization'), 'Bearer service-token')
  } finally {
    globalThis.fetch = originalFetch
  }

  let stored = ''
  let manifestWrites = 0
  const env = {
    STOCKVISION_AUTH_TOKEN: 'service-token',
    ARTIFACTS: {
      async put(_key: string, body: string) { stored = body },
      async get() { return stored ? { text: async () => stored } : null },
    },
    DB: {
      prepare() {
        return {
          bind() {
            return { async run() { manifestWrites += 1; return { success: true, meta: { changes: 1 } } } }
          },
        }
      },
    },
  } as any
  const unauthorized = await adminControlRoutes.request(
    'https://worker.example.test/api/internal/evidence-artifacts/screener-funnel',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    env,
  )
  assert.equal(unauthorized.status, 401)

  const missingR2 = await adminControlRoutes.request(
    'https://worker.example.test/api/internal/evidence-artifacts/screener-funnel',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    { ...env, ARTIFACTS: undefined },
  )
  assert.equal(missingR2.status, 503)

  const response = await adminControlRoutes.request(
    'https://worker.example.test/api/internal/evidence-artifacts/screener-funnel',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    env,
  )
  assert.equal(response.status, 200)
  const responseBody = await response.json() as any
  assert.equal(responseBody.ok, true)
  assert.equal(responseBody.manifest.status, 'ready')
  assert.equal(manifestWrites, 1)
  assert.match(stored, /screener_funnel/)

  const largeItems = Array.from({ length: 48 }, (_, index) => ({
    symbol: String(1000 + index),
    evidence: 'x'.repeat(80_000),
  }))
  const largeInput: EvidenceArtifactWriteInput = {
    ...input,
    producerRunId: 'screener-run-chunked',
    payload: {
      metadata: { status: 'success' },
      debug_log: ['chunk transport regression'],
      items: largeItems,
    },
    rowCount: largeItems.length,
  }
  const transportRequests: EvidenceArtifactWriteInput[] = []
  globalThis.fetch = async (_url, init) => {
    const value = JSON.parse(String(init?.body ?? '{}')) as EvidenceArtifactWriteInput
    transportRequests.push(value)
    const bodyBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    const manifest: EvidenceArtifactManifest = {
      ...readyManifest(),
      artifact_id: 'artifact:' + value.domain + ':2026-07-14:' + String(transportRequests.length).padStart(24, '0'),
      domain: value.domain,
      producer_run_id: value.producerRunId,
      r2_key: 'evidence/class=canonical_model_evidence/domain=' + value.domain + '/business_date=2026-07-14/chunk=' + transportRequests.length + '.json',
      checksum: 'sha256:' + String(transportRequests.length).padStart(64, '0'),
      schema_version: value.schemaVersion,
      row_count: value.rowCount,
      byte_size: bodyBytes,
    }
    return new Response(JSON.stringify({ ok: true, manifest }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  let chunkedManifest: EvidenceArtifactManifest
  try {
    chunkedManifest = await new RestEvidenceArtifactWriter({
      workerUrl: 'https://worker.example.test',
      serviceToken: 'service-token',
      maxRetries: 0,
    }).write(largeInput)
  } finally {
    globalThis.fetch = originalFetch
  }
  const childRequests = transportRequests.filter((value) => value.domain === 'screener_funnel_chunk')
  const parentRequest = transportRequests.at(-1)
  assert(childRequests.length > 1, 'large screener evidence must be split into multiple child artifacts')
  assert.equal(parentRequest?.domain, 'screener_funnel')
  assert.equal(parentRequest?.schemaVersion, 'screener-funnel-evidence-index-v1')
  assert.equal(parentRequest?.rowCount, largeItems.length)
  assert.equal(chunkedManifest.schema_version, 'screener-funnel-evidence-index-v1')
  assert(transportRequests.every((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 2 * 1024 * 1024))
  assert.deepEqual(
    childRequests.flatMap((value) => value.payload.items as unknown[]),
    largeItems,
    'chunking must preserve every screener evidence item in order',
  )
  const chunkIndex = parentRequest?.payload.chunks as Array<Record<string, unknown>>
  assert.match(String(parentRequest?.payload.logical_payload_checksum), /^sha256:[a-f0-9]{64}$/)
  assert.equal(chunkIndex.length, childRequests.length)
  assert.equal(chunkIndex.reduce((sum, chunk) => sum + Number(chunk.row_count), 0), largeItems.length)
  assert(chunkIndex.every((chunk, index) => chunk.chunk_index === index && Boolean(chunk.checksum)))

  const chunkRouteResponse = await adminControlRoutes.request(
    'https://worker.example.test/api/internal/evidence-artifacts/screener-funnel',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(childRequests[0]),
    },
    env,
  )
  assert.equal(chunkRouteResponse.status, 200)
  const indexRouteResponse = await adminControlRoutes.request(
    'https://worker.example.test/api/internal/evidence-artifacts/screener-funnel',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(parentRequest),
    },
    env,
  )
  assert.equal(indexRouteResponse.status, 200)
  const invalidParent = structuredClone(parentRequest) as EvidenceArtifactWriteInput
  ;(invalidParent.payload.chunks as Array<Record<string, unknown>>)[0].row_start = 1
  const invalidIndexResponse = await adminControlRoutes.request(
    'https://worker.example.test/api/internal/evidence-artifacts/screener-funnel',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidParent),
    },
    env,
  )
  assert.equal(invalidIndexResponse.status, 400)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
