import { hashJson } from './hashing'
import type { AuditIssue } from './domain'
import type { CrossExaminationOutput } from './modelContracts'

function key(issue: AuditIssue): string {
  return [issue.target_type, [...issue.target_ids].sort().join(','), issue.category.toUpperCase(), issue.claim.trim().toLowerCase().replace(/\s+/g, ' ')].join('|')
}

export async function normalizeAndMergeIssues(runId: string, batches: AuditIssue[][]): Promise<{ issues: AuditIssue[]; hashes: Record<string, string> }> {
  const merged = new Map<string, AuditIssue>()
  for (const issue of batches.flat()) {
    if (issue.evidence_level === 'E0') continue
    const normalized: AuditIssue = {
      ...issue, run_id: runId, target_ids: [...new Set(issue.target_ids.map(String))].sort(), evidence_level: 'E1',
      cross_exam_status: 'POSSIBLE_BUT_UNVERIFIED', duplicate_of: null,
      blocks_if_confirmed: Boolean(issue.blocks_if_confirmed), critic_confidence: Math.max(0, Math.min(1, Number(issue.critic_confidence))),
    }
    const fingerprint = key(normalized)
    const existing = merged.get(fingerprint)
    if (!existing || normalized.critic_confidence > existing.critic_confidence) merged.set(fingerprint, normalized)
  }
  const rows = [...merged.values()].sort((a, b) => key(a).localeCompare(key(b)))
  const hashes: Record<string, string> = {}
  for (const [index, row] of rows.entries()) {
    row.issue_id = `ISS-${String(index + 1).padStart(3, '0')}`
    hashes[row.issue_id] = await hashJson(row)
  }
  return { issues: rows, hashes }
}

export function applyCrossExamination(issues: AuditIssue[], output: CrossExaminationOutput): AuditIssue[] {
  const assessments = new Map(output.assessments.map((row) => [row.issue_id, row]))
  return issues.map((issue) => {
    const assessment = assessments.get(issue.issue_id)
    if (!assessment) return issue
    const status = issue.evidence_level === 'E1' && assessment.status === 'VALID_CLAIM' ? 'POSSIBLE_BUT_UNVERIFIED' : assessment.status
    return { ...issue, severity_if_true: assessment.severity_if_true, missing_evidence: [...new Set([...issue.missing_evidence, ...assessment.missing_evidence])], cross_exam_status: status, duplicate_of: status === 'DUPLICATE' ? assessment.duplicate_of : null }
  })
}
