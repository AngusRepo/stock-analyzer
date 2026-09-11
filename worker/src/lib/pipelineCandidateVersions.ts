import type { ExpectedReturnCandidateEvidence } from './expectedReturnMaturityEvidence'

export type CandidateVersionSummary = {
  artifact_id: string | null; cohort_id: string | null; model_version: string | null
  trained_until: string | null; generated_date: string | null; state: string | null
  identity_valid: boolean; offline_decision: string | null; offline_findings: string[]
}
export type CandidateVersionComparison = {
  latest_candidate: CandidateVersionSummary | null
  evaluated_candidate: CandidateVersionSummary | null
  different_artifacts: boolean | null
  latest_query_status: 'available' | 'missing' | 'error'
  evaluation_query_status: 'available' | 'missing' | 'error'
}
export function compareCandidateVersions(
  latest: ExpectedReturnCandidateEvidence | undefined,
  evaluated: ExpectedReturnCandidateEvidence | undefined,
  latestError: string | null = null, evaluationError: string | null = null,
): CandidateVersionComparison {
  const summary = (candidate: ExpectedReturnCandidateEvidence | undefined): CandidateVersionSummary | null => candidate ? ({
    artifact_id: candidate.artifact_id, cohort_id: candidate.cohort_id, model_version: candidate.version,
    trained_until: candidate.trained_until, generated_date: candidate.source_run_date, state: candidate.state,
    identity_valid: candidate.identity_valid, offline_decision: candidate.offline_gate_decision,
    offline_findings: candidate.offline_gate_failed_gates,
  }) : null
  return {
    latest_candidate: summary(latest), evaluated_candidate: summary(evaluated),
    different_artifacts: latest?.identity_valid && evaluated?.identity_valid
      ? latest.artifact_id !== evaluated.artifact_id : null,
    latest_query_status: latestError ? 'error' : latest ? 'available' : 'missing',
    evaluation_query_status: evaluationError ? 'error' : evaluated ? 'available' : 'missing',
  }
}

export type ActiveMlEnsembleVersion = {
  status: 'serving' | 'blocked' | 'missing' | 'error'
  artifact_id: string | null; cohort_id: string | null; validation_end_date: string | null
  knowledge_cutoff_date: string | null; promoted_at: string | null
}
export async function readActiveMlEnsembleVersion(db: D1Database): Promise<ActiveMlEnsembleVersion> {
  const row = await db.prepare(`
    SELECT p.artifact_id, p.cohort_id, p.promoted_at, a.knowledge_cutoff_date,
           json_extract(a.validation_json, '$.validation_end_date') validation_end_date,
           CASE WHEN a.artifact_id IS NOT NULL AND a.cohort_id=p.cohort_id
                AND a.payload_checksum=p.payload_checksum
                AND a.base_artifact_set_checksum=p.base_artifact_set_checksum
                AND a.validation_decision='PASS' AND a.state='production' AND a.production_effect=1
                THEN 1 ELSE 0 END valid_serving
      FROM active8_ensemble_pointer_v1 p
      LEFT JOIN active8_ensemble_artifacts_v1 a ON a.artifact_id=p.artifact_id
     WHERE p.singleton_id=1
  `).first<Record<string, any>>()
  const valid = Number(row?.valid_serving) === 1
  return {
    status: !row ? 'missing' : valid ? 'serving' : 'blocked',
    artifact_id: row?.artifact_id ?? null, cohort_id: valid ? row?.cohort_id ?? null : null,
    validation_end_date: valid ? row?.validation_end_date ?? null : null,
    knowledge_cutoff_date: valid ? row?.knowledge_cutoff_date ?? null : null,
    promoted_at: row?.promoted_at ?? null,
  }
}
