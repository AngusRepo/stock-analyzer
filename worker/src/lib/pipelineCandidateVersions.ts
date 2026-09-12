import type { ExpectedReturnCandidateEvidence } from './expectedReturnMaturityEvidence'
import type { ExpectedReturnNavView } from './expectedReturnNavMaturity'
import type { Bindings } from '../types'
import { verifyNavFormalBaseline } from './pairedNavPromotionContext'

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

export type ActiveMlEnsembleVersion = {
  status: 'serving' | 'blocked' | 'missing' | 'error'
  artifact_id: string | null; cohort_id: string | null; validation_end_date: string | null
  knowledge_cutoff_date: string | null; promoted_at: string | null
}
export async function readActiveMlEnsembleVersion(db: D1Database, env?: Bindings): Promise<ActiveMlEnsembleVersion> {
  const row = await db.prepare(`
    SELECT p.*, a.knowledge_cutoff_date, a.validation_decision,
           json_extract(a.validation_json, '$.validation_end_date') validation_end_date,
           CASE WHEN a.artifact_id IS NOT NULL AND a.cohort_id=p.cohort_id
                AND a.payload_checksum=p.payload_checksum
                AND a.base_artifact_set_checksum=p.base_artifact_set_checksum
                AND a.state='production' AND a.production_effect=1
                THEN 1 ELSE 0 END valid_serving
      FROM active8_ensemble_pointer_v1 p
      LEFT JOIN active8_ensemble_artifacts_v1 a ON a.artifact_id=p.artifact_id
     WHERE p.singleton_id=1
  `).first<Record<string, any>>()
  let valid = Number(row?.valid_serving) === 1
  if (valid && row) {
    try {
      const receipt = JSON.parse(row.promotion_evidence_json ?? '{}')
      if (receipt && Object.hasOwn(receipt, 'nav_validation')) {
        await verifyNavFormalBaseline(db, row, env)
      } else valid = row.validation_decision === 'PASS'
    } catch { valid = false }
  }
  return {
    status: !row ? 'missing' : valid ? 'serving' : 'blocked',
    artifact_id: row?.artifact_id ?? null, cohort_id: valid ? row?.cohort_id ?? null : null,
    validation_end_date: valid ? row?.validation_end_date ?? null : null,
    knowledge_cutoff_date: valid ? row?.knowledge_cutoff_date ?? null : null,
    promoted_at: row?.promoted_at ?? null,
  }
}
