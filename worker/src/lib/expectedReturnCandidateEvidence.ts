export type ExpectedReturnCandidateOwner = 'l4_alpha_ev' | 'allocator_ev_fusion'

export type ExpectedReturnCandidateResolution =
  | 'true_missing'
  | 'candidate_failed_validation'
  | 'candidate_passed_not_promoted'
  | 'promotion_failed'
  | 'promoted_candidate_present'
  | 'legacy_candidate_type_misclassified'
  | 'candidate_pending'

export interface ExpectedReturnCandidateEvidence {
  owner: ExpectedReturnCandidateOwner
  candidate_type: 'l4_alpha_ev_refresh' | 'allocator_ev_fusion_refresh'
  registry_candidate_type: string | null
  candidate_found: boolean
  resolution: ExpectedReturnCandidateResolution
  artifact_id: string | null
  model_version: string | null
  registry_state: string | null
  offline_gate_decision: string | null
  failed_gates: string[]
  rows_loaded: number | null
  candidate_end_date: string | null
  source_run_date: string | null
  live_gate_status: string | null
  promotion_error: string | null
  updated_at: string | null
}

export interface ExpectedReturnCandidateEvidenceReport {
  schema_version: 'expected-return-candidate-evidence-v1'
  inspected_at: string
  candidates: {
    l4_alpha_ev: ExpectedReturnCandidateEvidence
    allocator_ev_fusion: ExpectedReturnCandidateEvidence
  }
}

type RegistryRow = {
  artifact_id?: string | null
  version?: string | null
  candidate_type?: string | null
  state?: string | null
  source_run_date?: string | null
  offline_gate_decision?: string | null
  offline_gate_failed_gates?: string | null
  offline_evidence_json?: string | null
  live_gate_status?: string | null
  live_evidence_json?: string | null
  updated_at?: string | null
}

function jsonObject(value: unknown): Record<string, any> {
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => String(item).trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function resolutionFor(row: RegistryRow | null): ExpectedReturnCandidateResolution {
  if (!row) return 'true_missing'
  if (row.candidate_type === 'model_family_shadow') return 'legacy_candidate_type_misclassified'
  const decision = String(row.offline_gate_decision ?? '').toUpperCase()
  const liveGate = String(row.live_gate_status ?? '').toLowerCase()
  const state = String(row.state ?? '').toLowerCase()
  if (liveGate === 'promotion_failed') return 'promotion_failed'
  if (decision === 'FAIL') return 'candidate_failed_validation'
  if (decision === 'PASS' && state === 'production') return 'promoted_candidate_present'
  if (decision === 'PASS') return 'candidate_passed_not_promoted'
  return 'candidate_pending'
}

function evidenceFor(
  owner: ExpectedReturnCandidateOwner,
  candidateType: ExpectedReturnCandidateEvidence['candidate_type'],
  row: RegistryRow | null,
): ExpectedReturnCandidateEvidence {
  const offline = jsonObject(row?.offline_evidence_json)
  const live = jsonObject(row?.live_evidence_json)
  return {
    owner,
    candidate_type: candidateType,
    registry_candidate_type: row?.candidate_type ?? null,
    candidate_found: Boolean(row),
    resolution: resolutionFor(row),
    artifact_id: row?.artifact_id ?? null,
    model_version: row?.version ?? null,
    registry_state: row?.state ?? null,
    offline_gate_decision: row?.offline_gate_decision ?? null,
    failed_gates: stringArray(row?.offline_gate_failed_gates),
    rows_loaded: finiteNumber(offline.rows_loaded),
    candidate_end_date: typeof offline.end_date === 'string' ? offline.end_date : null,
    source_run_date: row?.source_run_date ?? null,
    live_gate_status: row?.live_gate_status ?? null,
    promotion_error: typeof live.promotion_error === 'string' && live.promotion_error.trim()
      ? live.promotion_error
      : null,
    updated_at: row?.updated_at ?? null,
  }
}

async function latestCandidate(
  db: D1Database,
  owner: ExpectedReturnCandidateOwner,
  candidateType: ExpectedReturnCandidateEvidence['candidate_type'],
): Promise<RegistryRow | null> {
  return db.prepare(`
    SELECT artifact_id, version, candidate_type, state, source_run_date,
           offline_gate_decision, offline_gate_failed_gates, offline_evidence_json,
           live_gate_status, live_evidence_json, updated_at
      FROM model_artifact_registry
     WHERE model_name=?
       AND candidate_type IN (?, 'model_family_shadow')
     ORDER BY COALESCE(source_run_date, '') DESC, updated_at DESC, artifact_id DESC
     LIMIT 1
  `).bind(owner, candidateType).first<RegistryRow>()
}

export async function inspectExpectedReturnCandidateEvidence(
  db: D1Database,
): Promise<ExpectedReturnCandidateEvidenceReport> {
  const [l4, fusion] = await Promise.all([
    latestCandidate(db, 'l4_alpha_ev', 'l4_alpha_ev_refresh'),
    latestCandidate(db, 'allocator_ev_fusion', 'allocator_ev_fusion_refresh'),
  ])
  return {
    schema_version: 'expected-return-candidate-evidence-v1',
    inspected_at: new Date().toISOString(),
    candidates: {
      l4_alpha_ev: evidenceFor('l4_alpha_ev', 'l4_alpha_ev_refresh', l4),
      allocator_ev_fusion: evidenceFor('allocator_ev_fusion', 'allocator_ev_fusion_refresh', fusion),
    },
  }
}
