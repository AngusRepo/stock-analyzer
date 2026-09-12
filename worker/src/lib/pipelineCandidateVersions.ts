import type { ExpectedReturnCandidateEvidence } from './expectedReturnMaturityEvidence'
import type { ExpectedReturnNavView } from './expectedReturnNavMaturity'

export type CandidateVersionSummary = {
  artifact_id: string | null; checksum: string | null; cohort_id: string | null
  model_version: string | null; trained_until: string | null; generated_date: string | null
  state: string | null; identity_valid: boolean; offline_decision: string | null
  offline_findings: string[]
}
export type CandidateVersionComparison = {
  latest_candidate: CandidateVersionSummary | null
  evaluated_candidate: CandidateVersionSummary | null
  different_artifacts: boolean | null
  latest_query_status: 'available' | 'missing' | 'error'
  evaluation_query_status: 'available' | 'missing' | 'error' | 'blocked'
}

/** Display identity only: never choose a candidate or transfer maturity. */
export function compareNavCandidateVersions(
  latest: ExpectedReturnCandidateEvidence | undefined,
  evaluated: ExpectedReturnCandidateEvidence | undefined,
  nav: ExpectedReturnNavView | undefined,
  latestError = false, evaluationError = false,
): CandidateVersionComparison {
  const summary = (c: ExpectedReturnCandidateEvidence | undefined): CandidateVersionSummary | null => c ? {
    artifact_id: c.artifact_id, checksum: c.checksum, cohort_id: c.cohort_id,
    model_version: c.version, trained_until: c.trained_until, generated_date: c.source_run_date,
    state: c.state, identity_valid: c.identity_valid, offline_decision: c.offline_gate_decision,
    offline_findings: c.offline_gate_failed_gates,
  } : null
  const current = summary(evaluated)
  const navMatches = nav?.availability === 'available' && nav.artifact_id === evaluated?.artifact_id
    && Boolean(nav.artifact_checksum) && nav.artifact_checksum === evaluated?.checksum
  // NAV identity is verified by the existing projection, not by offline PASS.
  if (current) {
    current.identity_valid = Boolean(navMatches)
    if (!evaluated?.identity_valid) current.model_version = null
  }
  const canCompare = !latestError && !evaluationError && latest?.identity_valid && navMatches
  return {
    latest_candidate: summary(latest), evaluated_candidate: current,
    different_artifacts: canCompare ? latest.artifact_id !== evaluated?.artifact_id
      || latest.checksum !== evaluated?.checksum : null,
    latest_query_status: latestError ? 'error' : latest ? 'available' : 'missing',
    evaluation_query_status: evaluationError ? 'error' : !evaluated ? 'missing'
      : navMatches ? 'available' : 'blocked',
  }
}
