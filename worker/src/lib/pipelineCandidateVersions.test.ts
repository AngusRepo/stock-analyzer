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
