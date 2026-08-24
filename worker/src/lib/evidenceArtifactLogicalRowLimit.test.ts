import assert from 'node:assert/strict'
import { RestEvidenceArtifactWriter } from '../node-runner/cloudflareRestBindings'
import type { EvidenceArtifactManifest, EvidenceArtifactWriteInput } from './evidenceArtifactContract'
import { parseScreenerArtifactInput } from '../routes/adminControlRoutes'

function manifestFor(input: EvidenceArtifactWriteInput, ordinal: number): EvidenceArtifactManifest {
  return {
    artifact_id: 'artifact:' + input.domain + ':2026-08-24:' + String(ordinal).padStart(24, '0'),
    retention_class: input.retentionClass,
    status: 'ready',
    domain: input.domain,
    business_date: input.businessDate,
    producer_run_id: input.producerRunId,
    canonical_run_id: null,
    r2_key: 'evidence/class=canonical_model_evidence/domain=' + input.domain + '/business_date=2026-08-24/chunk=' + ordinal + '.json',
    checksum: 'sha256:' + String(ordinal).padStart(64, '0'),
    schema_version: input.schemaVersion,
    row_count: input.rowCount,
    byte_size: Buffer.byteLength(JSON.stringify(input), 'utf8'),
    created_at: '2026-08-24T13:00:00.000Z',
    retain_until: null,
    checksum_verified_at: '2026-08-24T13:00:01.000Z',
    metadata_json: '{}',
  }
}

void (async () => {
  const items = Array.from({ length: 5201 }, (_, index) => ({
    symbol: String(100000 + index),
    stage: 'strategy_hit',
  }))
  const input: EvidenceArtifactWriteInput = {
    domain: 'screener_funnel',
    businessDate: '2026-08-24',
    producerRunId: 'screener-v2-wide-contract',
    retentionClass: 'canonical_model_evidence',
    schemaVersion: 'screener-funnel-evidence-v3',
    payload: {
      metadata: { status: 'success' },
      debug_log: [],
      items,
    },
    rowCount: items.length,
    metadata: { status: 'success' },
  }

  const requests: EvidenceArtifactWriteInput[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as EvidenceArtifactWriteInput
    requests.push(request)
    return new Response(JSON.stringify({
      ok: true,
      manifest: manifestFor(request, requests.length),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await new RestEvidenceArtifactWriter({
      workerUrl: 'https://worker.example.test',
      serviceToken: 'service-token',
      maxRetries: 0,
    }).write(input)
  } finally {
    globalThis.fetch = originalFetch
  }

  const children = requests.filter((request) => request.domain === 'screener_funnel_chunk')
  const parent = requests.at(-1)
  assert.equal(children.length, 2)
  assert.deepEqual(children.map((request) => request.rowCount), [5000, 201])
  assert(children.every((request) => request.rowCount <= 5000))
  assert.equal(parent?.domain, 'screener_funnel')
  assert.equal(parent?.schemaVersion, 'screener-funnel-evidence-index-v1')
  assert.equal(parent?.rowCount, 5201)
  assert.equal(parent?.payload.item_count, 5201)
  assert.equal(
    (parent?.payload.chunks as Array<Record<string, unknown>>)
      .reduce((sum, chunk) => sum + Number(chunk.row_count), 0),
    5201,
  )

  const parsed = parseScreenerArtifactInput(parent)
  assert.equal(parsed.rowCount, 5201)
  assert.equal(parsed.schemaVersion, 'screener-funnel-evidence-index-v1')

  assert.throws(
    () => parseScreenerArtifactInput({ ...input, rowCount: 5201 }),
    /rowCount must be an integer between 0 and 5000/,
  )
  const oversizedChildIndex = structuredClone(parent) as EvidenceArtifactWriteInput
  oversizedChildIndex.payload.chunks = [{
    ...(oversizedChildIndex.payload.chunks as Array<Record<string, unknown>>)[0],
    row_start: 0,
    row_end_exclusive: 5201,
    row_count: 5201,
  }]
  assert.throws(
    () => parseScreenerArtifactInput(oversizedChildIndex),
    /invalid screener chunk manifest entry:0/,
  )

  console.log('evidence artifact logical row-limit contract passed')
})()
