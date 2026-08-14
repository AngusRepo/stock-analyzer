import assert from 'node:assert/strict'
import fs from 'node:fs'
import { assertExpectedReturnCandidateIdentityBackfillRows } from './expectedReturnCandidateIdentityBackfillGuard'

const trainingRunId = 'active8_oof:active8-oof-v7-immutable-fold-evidence-2026-01-29-2026-07-22-tr60-te10'
const labelSchema = 'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'

function candidate(owner: 'l4_alpha_ev' | 'allocator_ev_fusion'): Record<string, unknown> {
  const l4 = owner === 'l4_alpha_ev'
  const version = l4
    ? 'l4-alpha-ev-ridge-v5-sector-20260809'
    : 'allocator-ev-fusion-residual-v14-20260809'
  const checksum = l4
    ? '57924157cb6dbdf6a2bf3dd50f761b900b7530884dbfbcf9595364fbfc506acf'
    : '359b98684868acaf2ba7bc4bf27575538f99a7f57f110d8a53e67a52dcbe5d15'
  return {
    artifact_id: `${owner}:${version}`,
    model_name: owner,
    candidate_type: l4 ? 'l4_alpha_ev_refresh' : 'allocator_ev_fusion_refresh',
    version,
    training_run_id: trainingRunId,
    checksum,
    source_run_date: '2026-08-09',
    offline_gate_decision: 'FAIL',
    offline_evidence_json: JSON.stringify({
      artifact_contract_version: l4 ? 'l4-alpha-ev-contract-v5' : 'allocator-ev-fusion-contract-v14',
      feature_semantic_version: l4
        ? 'l4-directional-score-sector-components-v3-lineage-bound'
        : 'allocator-ev-fusion-l4-residual-overlay-day-t-causal-v1-lineage-bound',
      label_schema_version: labelSchema,
      identity_schema_version: 'expected-return-candidate-identity-v2',
      expected_return_owner: owner,
      model_version: version,
      artifact_checksum: checksum,
      cadence: 'weekly',
      validation_packet: {
        schema_version: l4 ? 'l4-alpha-ev-validation-packet-v1' : 'allocator-ev-fusion-validation-packet-v14',
        decision: 'FAIL',
      },
    }),
  }
}

assert.equal(assertExpectedReturnCandidateIdentityBackfillRows('core', 'model_artifact_registry', [candidate('l4_alpha_ev')]), 0)
assert.equal(assertExpectedReturnCandidateIdentityBackfillRows('learning', 'other_table', [candidate('l4_alpha_ev')]), 0)
assert.equal(assertExpectedReturnCandidateIdentityBackfillRows('learning', 'model_artifact_registry', [{
  artifact_id: 'unrelated:artifact',
  offline_evidence_json: '{bad-json',
}]), 0)
assert.equal(assertExpectedReturnCandidateIdentityBackfillRows('learning', 'model_artifact_registry', [
  candidate('l4_alpha_ev'),
  candidate('allocator_ev_fusion'),
]), 2)

const legacyEnvelope = candidate('l4_alpha_ev')
legacyEnvelope.offline_evidence_json = JSON.stringify({
  ...JSON.parse(String(legacyEnvelope.offline_evidence_json)),
  identity_schema_version: undefined,
})
assert.throws(
  () => assertExpectedReturnCandidateIdentityBackfillRows('learning', 'model_artifact_registry', [legacyEnvelope]),
  /expected_return_candidate_identity_backfill_mismatch:.*:identity_schema_version/,
)

const checksumMismatch = candidate('allocator_ev_fusion')
checksumMismatch.checksum = 'wrong'
assert.throws(
  () => assertExpectedReturnCandidateIdentityBackfillRows('learning', 'model_artifact_registry', [checksumMismatch]),
  /expected_return_candidate_identity_backfill_mismatch:.*:checksum/,
)

const schemaMismatch = candidate('allocator_ev_fusion')
schemaMismatch.offline_evidence_json = JSON.stringify({
  ...JSON.parse(String(schemaMismatch.offline_evidence_json)),
  validation_packet: { schema_version: 'wrong', decision: 'FAIL' },
})
assert.throws(
  () => assertExpectedReturnCandidateIdentityBackfillRows('learning', 'model_artifact_registry', [schemaMismatch]),
  /expected_return_candidate_identity_backfill_mismatch:.*:validation_schema_version/,
)

const backfillSource = fs.readFileSync('src/lib/dataDomainShadowBackfill.ts', 'utf8')
const rowsIndex = backfillSource.indexOf('const rows = selected.results ?? []')
const guardIndex = backfillSource.indexOf('assertExpectedReturnCandidateIdentityBackfillRows(domain, table, rows)', rowsIndex)
const rowBranchIndex = backfillSource.indexOf('if (rows.length)', rowsIndex)
assert(rowsIndex >= 0)
assert(guardIndex > rowsIndex)
assert(rowBranchIndex > guardIndex)
console.log('expected-return candidate identity backfill guard tests passed')
