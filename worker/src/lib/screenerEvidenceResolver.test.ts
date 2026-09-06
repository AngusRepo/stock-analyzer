import assert from 'node:assert/strict'
import { sha256Text } from './datasetSnapshots'
import { resolveScreenerEvidence } from './screenerEvidenceResolver'
import { adminControlRoutes } from '../routes/adminControlRoutes'

async function fixture() {
  const id = 'd1_audit_json_archive:canonical_screener_funnel_items:2026-09-05:archive:77'
  const key = 'archives/d1_audit_json_archive/target=canonical_screener_funnel_items/chunk=77.json'
  const evidence = JSON.stringify({ score_components: { version: 'score_v2', components: { technicalStructure: 8 } } })
  const archive = { schema_version: 'd1-audit-json-archive-v1', archive_kind: 'd1_audit_json_archive',
    table: 'screener_funnel_items', target: 'canonical_screener_funnel_items', key_column: 'id',
    blob_columns: ['evidence'], row_count: 1, rows: [{ id: 77, run_id: 'original-run', stage: 'scoring', symbol: '2330', evidence }] }
  const body = JSON.stringify(archive)
  const checksum = await sha256Text(body)
  const manifest = { snapshot_id: id, kind: 'd1_audit_json_archive', schema_version: archive.schema_version,
    primary_store: 'r2', r2_key: key, status: 'ready', checksum, row_count: 1,
    metadata_json: JSON.stringify({ table: archive.table, target: archive.target, key_column: 'id', blob_columns: ['evidence'] }) }
  const state = { body, manifest, objectMissing: false }
  const db = { prepare(sql: string) { assert.match(sql, /FROM dataset_snapshots/); return {
    bind(value: string) { assert.equal(value, id); return { async first() { return state.manifest } } },
  } } }
  const env = { DB: db, LEARNING_DB: db, STOCKVISION_AUTH_TOKEN: 'fixture-token', ARTIFACTS: {
    async get(value: string) { assert.equal(value, key); return state.objectMissing ? null : { text: async () => state.body } },
  } } as any
  const request = { schema_version: 'd1-audit-json-pointer-v1', artifact_id: id, snapshot_id: id,
    r2_key: key, checksum, source_run_id: 'original-run', row_ids: [77] }
  return { env, request, state, evidence, archive }
}

void (async () => {
  const f = await fixture()
  const resolved = await resolveScreenerEvidence(f.env, [f.request])
  assert.equal(resolved.rows[0].evidence, f.evidence)
  assert.equal(resolved.rows[0].source_run_id, 'original-run')
  await assert.rejects(resolveScreenerEvidence(f.env, [{ ...f.request, source_run_id: 'forged' }]), /row_identity_mismatch/)
  await assert.rejects(resolveScreenerEvidence(f.env, [{ ...f.request, row_ids: [78] }]), /row_identity_mismatch/)
  await assert.rejects(resolveScreenerEvidence(f.env, [f.request, f.request]), /row_ids_invalid/)
  await assert.rejects(resolveScreenerEvidence(f.env, [{ ...f.request, schema_version: 'unknown' }]), /schema_unsupported/)
  await assert.rejects(resolveScreenerEvidence(f.env, [{ ...f.request, r2_key: 'secret/private' }]), /pointer_invalid/)
  f.state.body += ' '
  await assert.rejects(resolveScreenerEvidence(f.env, [f.request]), /checksum_mismatch/)
  f.state.body = JSON.stringify(f.archive)
  f.state.manifest.status = 'expired'
  await assert.rejects(resolveScreenerEvidence(f.env, [f.request]), /manifest_mismatch/)
  f.state.manifest.status = 'ready'
  f.state.objectMissing = true
  await assert.rejects(resolveScreenerEvidence(f.env, [f.request]), /payload_missing/)
  f.state.objectMissing = false
  for (const [token, status] of [['wrong', 401], ['fixture-token', 200]] as const) {
    const response = await adminControlRoutes.request('https://fixture.test/api/internal/evidence-artifacts/legacy-screener/resolve', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifacts: [f.request] }),
    }, f.env)
    assert.equal(response.status, status)
  }
  console.log('generic archive resolver: identity, checksum, expiry, coverage and auth PASS')
})().catch(error => { console.error(error); process.exitCode = 1 })
