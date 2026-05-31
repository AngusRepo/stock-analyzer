import { evaluateResearchInternGate } from './researchInternGate'
import { getResearchExperiment, type ResearchExperimentRecord } from './researchExperimentRegistry'
import { listResearchEvaluationRunReports, type StoredResearchEvaluationRunReport } from './researchEvaluationRunner'
import { assertOwnerCanOwn } from './strategyOwnerFreeze'

export const RESEARCH_PATCH_HANDOFF_PREFIX = 'research:patch_handoff:'
export const RESEARCH_PATCH_HANDOFF_VERSION = 'research-patch-handoff-v1'

export interface ResearchPatchHandoff {
  id: string
  version: string
  mode: 'metadata_only'
  experiment_id: string
  experiment_status: ResearchExperimentRecord['status']
  created_at: string
  reviewer: string
  reason: string | null
  production_effect: false
  can_write_model_artifact_registry: false
  artifact_bridge: {
    candidate_type: 'model_family_shadow' | 'research_benchmark' | 'strategy_patch'
    candidate_ids: string[]
    requires_external_artifact: boolean
    target_registry: 'model_artifact_registry' | 'strategy_spec_registry'
  }
  implementation_plan: string[]
  validation_plan: string[]
  latest_evaluation: Pick<StoredResearchEvaluationRunReport, 'id' | 'created_at' | 'verdict' | 'review_packet'> | null
  blocked_capabilities: string[]
}

function handoffPrefix(experimentId: string): string {
  return `${RESEARCH_PATCH_HANDOFF_PREFIX}${experimentId}:`
}

function handoffId(experimentId: string, createdAt: string): string {
  return `${handoffPrefix(experimentId)}${createdAt}`
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .slice(0, 12)
}

function artifactBridge(record: ResearchExperimentRecord): ResearchPatchHandoff['artifact_bridge'] {
  const shadowCandidates = cleanStringArray(record.data_slice?.shadow_candidates)
  const benchmarkCandidates = cleanStringArray(record.data_slice?.benchmark_candidates)
  const formalLayer3Candidates = [
    ...cleanStringArray(record.data_slice?.layer3_candidates),
    ...cleanStringArray(record.data_slice?.formal_family_candidates),
  ]
  if (shadowCandidates.length) {
    return {
      candidate_type: 'model_family_shadow',
      candidate_ids: shadowCandidates,
      requires_external_artifact: true,
      target_registry: 'model_artifact_registry',
    }
  }
  if (benchmarkCandidates.length || formalLayer3Candidates.length) {
    return {
      candidate_type: 'research_benchmark',
      candidate_ids: benchmarkCandidates.length ? benchmarkCandidates : [...new Set(formalLayer3Candidates)],
      requires_external_artifact: true,
      target_registry: 'model_artifact_registry',
    }
  }
  return {
    candidate_type: 'strategy_patch',
    candidate_ids: record.strategy_spec_ids,
    requires_external_artifact: false,
    target_registry: 'strategy_spec_registry',
  }
}

function implementationPlan(record: ResearchExperimentRecord, bridge: ResearchPatchHandoff['artifact_bridge']): string[] {
  if (bridge.target_registry === 'model_artifact_registry') {
    return [
      'Attach or produce a trained shadow artifact outside this metadata route.',
      `Register the artifact as candidate_type=${bridge.candidate_type} only after artifact checksum, feature policy, and evaluation evidence exist.`,
      'Keep vote_weight=0 and can_vote=false until promotion controller passes offline, live, and manual approval gates.',
      'Do not update champion pointer from this handoff.',
    ]
  }
  return [
    `Prepare a Strategy Lab patch for strategy specs: ${record.strategy_spec_ids.join(', ') || 'none'}.`,
    'Run local tests and dry-run validation before any runtime wiring.',
    'Keep production strategy unchanged until a separate reviewed patch is merged and deployed.',
  ]
}

function validationPlan(bridge: ResearchPatchHandoff['artifact_bridge']): string[] {
  if (bridge.target_registry === 'model_artifact_registry') {
    return [
      'Verify artifact checksum and training manifest.',
      'Verify OOS IC, CPCV/PBO, cost profile, and data-slice report.',
      'Verify model_artifact_registry row remains shadow/research state and does not update champion pointer.',
      'Verify Model Pool shows candidate as non-voting until promotion approval.',
    ]
  }
  return [
    'Run worker type-check and frontend build.',
    'Run Strategy Lab dry-run and reward ledger refresh.',
    'Verify production decision output is unchanged until explicit promotion wiring.',
  ]
}

export async function createResearchPatchHandoff(
  kv: KVNamespace,
  experimentId: string,
  options: { reviewer?: string; reason?: string } = {},
): Promise<{ ok: true; handoff: ResearchPatchHandoff } | { ok: false; status: number; error: string }> {
  assertOwnerCanOwn('research', 'experiment_registry')
  assertOwnerCanOwn('research', 'review_packet')

  const reviewer = typeof options.reviewer === 'string' ? options.reviewer.trim() : ''
  const gate = evaluateResearchInternGate({
    action: 'generate_patch',
    approval: { approved: true, reviewer },
    experimentId,
  })
  if (gate.decision !== 'ALLOW') return { ok: false, status: 400, error: gate.reason }

  const experiment = await getResearchExperiment(kv, experimentId)
  if (!experiment) return { ok: false, status: 404, error: 'research experiment not found' }
  if (experiment.status !== 'approved_for_patch') {
    return { ok: false, status: 409, error: 'experiment must be approved_for_patch before patch handoff' }
  }

  const [latestRun] = await listResearchEvaluationRunReports(kv, experimentId, 1)
  const createdAt = new Date().toISOString()
  const bridge = artifactBridge(experiment)
  const handoff: ResearchPatchHandoff = {
    id: handoffId(experimentId, createdAt),
    version: RESEARCH_PATCH_HANDOFF_VERSION,
    mode: 'metadata_only',
    experiment_id: experimentId,
    experiment_status: experiment.status,
    created_at: createdAt,
    reviewer,
    reason: options.reason?.trim() || null,
    production_effect: false,
    can_write_model_artifact_registry: false,
    artifact_bridge: bridge,
    implementation_plan: implementationPlan(experiment, bridge),
    validation_plan: validationPlan(bridge),
    latest_evaluation: latestRun
      ? {
          id: latestRun.id,
          created_at: latestRun.created_at,
          verdict: latestRun.verdict,
          review_packet: latestRun.review_packet,
        }
      : null,
    blocked_capabilities: ['production retrain', 'model promote', 'production deploy', 'paper/live trade execution'],
  }
  await kv.put(handoff.id, JSON.stringify(handoff))
  return { ok: true, handoff }
}

export async function listResearchPatchHandoffs(
  kv: KVNamespace,
  experimentId: string,
  limit = 10,
): Promise<ResearchPatchHandoff[]> {
  const requestedLimit = Math.max(1, Math.min(limit, 50))
  const { keys } = await kv.list({ prefix: handoffPrefix(experimentId), limit: 50 })
  const rows = await Promise.all(
    keys.map(async (key) => kv.get(key.name, 'json') as Promise<ResearchPatchHandoff | null>),
  )
  return rows
    .filter((row): row is ResearchPatchHandoff => row?.version === RESEARCH_PATCH_HANDOFF_VERSION)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
    .slice(0, requestedLimit)
}
