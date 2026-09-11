import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { adaptExpectedReturnCandidate, type ExpectedReturnCandidateDbRow } from './expectedReturnMaturityEvidence'
import { L4_ALPHA_EV_CONTRACT } from './evidenceContracts'
import { compareCandidateVersions, readActiveMlEnsembleVersion } from './pipelineCandidateVersions'

function candidate(cutoff: string, state: string) {
  const version = `l4-alpha-ev-ridge-v5-sector-${cutoff.replaceAll('-', '')}`
  return adaptExpectedReturnCandidate({
    model_name: 'l4_alpha_ev', artifact_id: `l4_alpha_ev:${version}`, version,
    candidate_type: 'l4_alpha_ev_refresh', training_run_id: `active8_oof:cohort-${cutoff}`,
    state, source_run_date: '2026-09-10', offline_gate_decision: 'FAIL',
    offline_gate_failed_gates: '["pit_sector_alpha_dates_low"]',
    offline_evidence_json: JSON.stringify({
      expected_return_owner: 'l4_alpha_ev', identity_schema_version: 'expected-return-candidate-identity-v1',
      model_version: version, training_data: { trained_until: cutoff },
      artifact_contract_version: L4_ALPHA_EV_CONTRACT.artifactContractVersion,
      feature_semantic_version: L4_ALPHA_EV_CONTRACT.featureSemanticVersion,
      label_schema_version: L4_ALPHA_EV_CONTRACT.labelSchemaVersion,
      validation_packet: { schema_version: 'l4-alpha-ev-validation-packet-v1', decision: 'FAIL' },
    }),
  } as ExpectedReturnCandidateDbRow)
}

test('new failed cohort and old locked candidate remain distinct without moving gate credit', () => {
  const latest = candidate('2026-09-01', 'offline_failed')
  const locked = candidate('2026-08-18', 'shadowing')
  const before = JSON.stringify([latest, locked])
  const result = compareCandidateVersions(latest, locked)
  assert.equal(result.different_artifacts, true)
  assert.equal(result.latest_candidate?.trained_until, '2026-09-01')
  assert.equal(result.latest_candidate?.cohort_id, 'cohort-2026-09-01')
  assert.deepEqual(result.latest_candidate?.offline_findings, ['pit_sector_alpha_dates_low'])
  assert.equal(result.evaluated_candidate?.trained_until, '2026-08-18')
  assert.equal(result.evaluated_candidate?.state, 'shadowing')
  assert.equal(JSON.stringify([latest, locked]), before)
  assert.equal(compareCandidateVersions(locked, locked).different_artifacts, false)
})

test('missing, query error and untrusted identity cannot imply a version rollover', () => {
  const latest = candidate('2026-09-01', 'offline_failed')
  assert.equal(compareCandidateVersions(latest, undefined).evaluation_query_status, 'missing')
  const failed = compareCandidateVersions(undefined, undefined, 'query failed', 'query failed')
  assert.equal(failed.latest_query_status, 'error')
  assert.equal(failed.evaluation_query_status, 'error')
  assert.equal(failed.different_artifacts, null)
  assert.equal(compareCandidateVersions(latest, { ...latest, identity_valid: false }).different_artifacts, null)
})

test('formal ML version follows the verified serving pointer, including checksum and cohort checks', async () => {
  const sql = new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE active8_ensemble_pointer_v1 (
    singleton_id INTEGER, artifact_id TEXT, cohort_id TEXT, promoted_at TEXT,
    payload_checksum TEXT, base_artifact_set_checksum TEXT);
    CREATE TABLE active8_ensemble_artifacts_v1 (
    artifact_id TEXT, cohort_id TEXT, knowledge_cutoff_date TEXT, validation_json TEXT,
    payload_checksum TEXT, base_artifact_set_checksum TEXT, validation_decision TEXT, state TEXT, production_effect INTEGER);
    INSERT INTO active8_ensemble_artifacts_v1 VALUES (
    'formal', 'cohort-20260901', '2026-09-08', '{"validation_end_date":"2026-09-01"}', 'payload', 'base', 'PASS', 'production', 1);`)
  const db = { prepare: (query: string) => ({ first: async () => sql.prepare(query).get() ?? null }) } as unknown as D1Database
  try {
    assert.equal((await readActiveMlEnsembleVersion(db)).status, 'missing')
    sql.exec("INSERT INTO active8_ensemble_pointer_v1 VALUES (1, 'formal', 'cohort-20260901', '2026-09-08', 'payload', 'base')")
    const formal = await readActiveMlEnsembleVersion(db)
    assert.equal(formal.status, 'serving')
    assert.equal(formal.validation_end_date, '2026-09-01')
    assert.equal(formal.knowledge_cutoff_date, '2026-09-08')
    for (const field of ['artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum']) {
      sql.exec('SAVEPOINT check_identity')
      sql.exec(`UPDATE active8_ensemble_pointer_v1 SET ${field}='other'`)
      const blocked = await readActiveMlEnsembleVersion(db)
      assert.equal(blocked.status, 'blocked', field)
      assert.equal(blocked.validation_end_date, null)
      assert.equal(blocked.cohort_id, null)
      sql.exec('ROLLBACK TO check_identity; RELEASE check_identity')
    }
    sql.exec("UPDATE active8_ensemble_artifacts_v1 SET state='rejected', production_effect=0")
    assert.equal((await readActiveMlEnsembleVersion(db)).status, 'blocked')
  } finally { sql.close() }
})
