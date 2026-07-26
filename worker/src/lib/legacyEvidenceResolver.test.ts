import assert from 'node:assert/strict'
import { adminControlRoutes } from '../routes/adminControlRoutes'
import { sha256Text } from './datasetSnapshots'
import { resolveLegacyScreenerEvidence } from './legacyEvidenceResolver'

async function fixture() {
  const rowId = 77
  const sourceRunId = 'screener-2026-06-25-verified'
  const r2Key = [
    'evidence/class=superseded_run',
    'domain=legacy_screener_funnel_evidence',
    'business_date=2026-06-25',
    'chunk=verified.json',
  ].join('/')
  const body = JSON.stringify({
    schema_version: 'legacy-screener-funnel-evidence-v1',
    domain: 'legacy_screener_funnel_evidence',
    business_date: '2026-06-25',
    payload: {
      source_run_id: sourceRunId,
      rows: [{
        id: rowId,
        symbol: '2330',
        stage: 'scoring',
        evidence: JSON.stringify({ score_components: { version: 'score_v2' } }),
      }],
    },
  })
  const checksum = await sha256Text(body)
  const artifactId = 'artifact:legacy_screener_funnel_evidence:2026-06-25:verified'
  const manifest = {
    artifact_id: artifactId,
    status: 'ready',
    domain: 'legacy_screener_funnel_evidence',
    producer_run_id: `legacy-migration:${sourceRunId}:77-77`,
    r2_key: r2Key,
    checksum,
    schema_version: 'legacy-screener-funnel-evidence-v1',
    payload_deleted_at: null,
  }
  const env = {
    STOCKVISION_AUTH_TOKEN: 'service-token',
    DB: {
      prepare() {
        return { bind() { return { manifest } } }
      },
      async batch(statements: Array<{ manifest: typeof manifest }>) {
        return statements.map((statement) => ({ success: true, results: [statement.manifest] }))
      },
    },
    ARTIFACTS: {
      async get(key: string) {
        return key === r2Key ? { text: async () => body } : null
      },
    },
  } as any
  const request = {
    artifact_id: artifactId,
    r2_key: r2Key,
    checksum,
    source_run_id: sourceRunId,
    row_ids: [rowId],
  }
  return { env, request, rowId }
}

void (async () => {
  const { env, request, rowId } = await fixture()
  const result = await resolveLegacyScreenerEvidence(env, [request])
  assert.equal(result.artifacts, 1)
  assert.equal(result.rows[0].row_id, rowId)
  assert.equal(result.rows[0].symbol, '2330')

  await assert.rejects(
    resolveLegacyScreenerEvidence(env, [{ ...request, checksum: `sha256:${'f'.repeat(64)}` }]),
    /artifact_manifest_mismatch/,
  )

  const unauthorized = await adminControlRoutes.request(
    'https://worker.example.test/api/internal/evidence-artifacts/legacy-screener/resolve',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifacts: [request] }),
    },
    env,
  )
  assert.equal(unauthorized.status, 401)

  const response = await adminControlRoutes.request(
    'https://worker.example.test/api/internal/evidence-artifacts/legacy-screener/resolve',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer service-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifacts: [request] }),
    },
    env,
  )
  assert.equal(response.status, 200)
  const payload = await response.json() as any
  assert.equal(payload.ok, true)
  assert.equal(payload.rows[0].row_id, rowId)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
