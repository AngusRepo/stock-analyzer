import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareNavCandidateVersions } from './pipelineCandidateVersions'
import type { ExpectedReturnCandidateEvidence } from './expectedReturnMaturityEvidence'
import type { ExpectedReturnNavView } from './expectedReturnNavMaturity'

// Projection-only identities, not fabricated promotion receipts.
const candidate = (id: string, checksum: string) => ({ artifact_id: id, checksum,
  cohort_id: 'cohort-old', trained_until: '2026-08-18', version: 'fixed', source_run_date: '2026-08-30',
  state: 'shadowing', identity_valid: true, offline_gate_decision: 'FAIL', offline_gate_failed_gates: []
}) as ExpectedReturnCandidateEvidence
const evaluated = candidate('old', 'a'.repeat(64))
const nav = { availability: 'available', artifact_id: 'old', artifact_checksum: evaluated.checksum } as ExpectedReturnNavView
test('new candidate version does not replace evaluated identity despite offline FAIL', () => {
  const result = compareNavCandidateVersions(candidate('new', 'b'.repeat(64)), evaluated, nav)
  assert.equal(result.different_artifacts, true)
  assert.equal(result.evaluated_candidate?.artifact_id, 'old')
  assert.equal(result.evaluation_query_status, 'available')
})
test('identical candidate and checksum is one identity', () => {
  assert.equal(compareNavCandidateVersions(evaluated, evaluated, nav).different_artifacts, false)
})
test('changed checksum cannot reuse NAV identity', () => {
  const result = compareNavCandidateVersions(evaluated, candidate('old', 'b'.repeat(64)), nav)
  assert.equal(result.different_artifacts, null)
  assert.equal(result.evaluation_query_status, 'blocked')
})
test('missing and failed queries remain distinct', () => {
  assert.equal(compareNavCandidateVersions(undefined, undefined, undefined).latest_query_status, 'missing')
  const result = compareNavCandidateVersions(evaluated, evaluated, nav, true, true)
  assert.equal(result.latest_query_status, 'error')
  assert.equal(result.evaluation_query_status, 'error')
  assert.equal(result.different_artifacts, null)
})


test('Paper serving display requires the exact still-active operator admission', async () => {
  const { readActiveMlEnsembleVersion } = await import('./pipelineCandidateVersions')
  const admission = { scope: 'paper', approved: true, efficacy_status: 'unproven',
    strategy_bundle: { candidate_l3_identity: { artifact_id: 'A', payload_checksum: 'a'.repeat(64) } } }
  const row = { valid_serving: 1, artifact_id: 'A', payload_checksum: 'a'.repeat(64),
    promotion_evidence_json: JSON.stringify({ paper_admission: admission }), validation_decision: 'PASS' }
  const db = { prepare: () => ({ first: async () => row }) } as any
  for (const active of [null, { ...admission, approved: false }, { ...admission, scope: 'live' }]) {
    const env = { KV: { get: async () => active } } as any
    assert.equal((await readActiveMlEnsembleVersion(db, env)).status, 'blocked')
  }
  assert.equal((await readActiveMlEnsembleVersion(db, { KV: { get: async () => admission } } as any)).status, 'serving')
})
