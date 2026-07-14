import assert from 'node:assert/strict'
import { applyCrossExamination, normalizeAndMergeIssues } from '../strategy-discovery/issues'
import type { AuditIssue } from '../strategy-discovery/domain'

function issue(overrides: Partial<AuditIssue>): AuditIssue {
  return { issue_id: 'raw', run_id: 'wrong', target_type: 'CANDIDATE', target_ids: ['C01'], category: 'LEAKAGE', claim: 'Possible point in time leak', attack_mechanism: 'timing', observed_evidence: [], missing_evidence: ['lineage'], severity_if_true: 'MAJOR', evidence_level: 'E1', critic_model: 'model', critic_confidence: 0.7, falsification_test: {}, blocks_if_confirmed: true, cross_exam_status: 'VALID_CLAIM', duplicate_of: null, ...overrides }
}

async function main() {
  const merged = await normalizeAndMergeIssues('RUN-1', [[issue({ critic_confidence: 0.6 }), issue({ critic_confidence: 0.9 })], [issue({ evidence_level: 'E0', claim: 'generic concern' })]])
  assert.equal(merged.issues.length, 1)
  assert.equal(merged.issues[0].run_id, 'RUN-1')
  assert.equal(merged.issues[0].critic_confidence, 0.9)
  assert.equal(merged.issues[0].cross_exam_status, 'POSSIBLE_BUT_UNVERIFIED')
  assert.ok(merged.hashes['ISS-001'])
  const examined = applyCrossExamination(merged.issues, { assessments: [{ issue_id: 'ISS-001', status: 'VALID_CLAIM', severity_if_true: 'FATAL', missing_evidence: ['test'], duplicate_of: null }] })
  assert.equal(examined[0].cross_exam_status, 'POSSIBLE_BUT_UNVERIFIED', 'E1 may not become confirmed through LLM cross-exam')
  assert.deepEqual(examined[0].missing_evidence.sort(), ['lineage', 'test'])
}

void main()
