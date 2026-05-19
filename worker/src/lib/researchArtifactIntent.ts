import { getResearchExperiment } from './researchExperimentRegistry'
import { listResearchPatchHandoffs, type ResearchPatchHandoff } from './researchPatchHandoff'
import { assertOwnerCanOwn } from './strategyOwnerFreeze'

export const RESEARCH_ARTIFACT_INTENT_PREFIX = 'research:artifact_intent:'
export const RESEARCH_ARTIFACT_INTENT_VERSION = 'research-artifact-intent-v1'

type RegistryCandidateType = 'model_family_shadow' | 'research_benchmark'
type IntentStatus = 'blocked_missing_artifact' | 'ready_for_registry_preflight'

export interface ResearchArtifactIntentInput {
  model_name?: unknown
  artifact_version?: unknown
  artifact_path?: unknown
  metadata_path?: unknown
  training_manifest_path?: unknown
  feature_policy_version?: unknown
  checksum?: unknown
  reviewer?: unknown
  reason?: unknown
}

export interface ResearchArtifactIntent {
  id: string
  version: string
  mode: 'metadata_only'
  experiment_id: string
  handoff_id: string
  status: IntentStatus
  created_at: string
  reviewer: string
  reason: string | null
  production_effect: false
  target_registry: 'model_artifact_registry'
  registry_candidate: {
    artifact_id: string
    model_name: string
    version: string
    candidate_type: RegistryCandidateType
    state: 'registered'
    artifact_path: string | null
    metadata_path: string | null
    training_manifest_path: string | null
    feature_policy_version: string | null
    checksum: string | null
    source_run_date: string
    approval_state: 'required'
    promotion_decision: 'not_evaluated'
  }
  preflight: {
    can_write_registry: false
    ready_for_manual_registry_write: boolean
    missing_fields: string[]
    blockers: string[]
    required_manual_steps: string[]
  }
  blocked_capabilities: string[]
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sourceRunDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function intentPrefix(experimentId: string): string {
  return `${RESEARCH_ARTIFACT_INTENT_PREFIX}${experimentId}:`
}

function intentId(experimentId: string, createdAt: string): string {
  return `${intentPrefix(experimentId)}${createdAt}`
}

function firstCandidate(handoff: ResearchPatchHandoff): string {
  return handoff.artifact_bridge.candidate_ids[0] ?? handoff.experiment_id
}

function candidateType(handoff: ResearchPatchHandoff): RegistryCandidateType | null {
  if (handoff.artifact_bridge.candidate_type === 'model_family_shadow') return 'model_family_shadow'
  if (handoff.artifact_bridge.candidate_type === 'research_benchmark') return 'research_benchmark'
  return null
}

function missingFields(candidate: ResearchArtifactIntent['registry_candidate']): string[] {
  const fields: Array<keyof ResearchArtifactIntent['registry_candidate']> = [
    'model_name',
    'version',
    'candidate_type',
    'artifact_path',
    'training_manifest_path',
    'feature_policy_version',
    'checksum',
  ]
  return fields.filter((field) => !candidate[field])
}

export async function createResearchArtifactIntent(
  kv: KVNamespace,
  experimentId: string,
  input: ResearchArtifactIntentInput = {},
): Promise<{ ok: true; intent: ResearchArtifactIntent } | { ok: false; status: number; error: string }> {
  assertOwnerCanOwn('research', 'experiment_registry')
  assertOwnerCanOwn('research', 'review_packet')

  const experiment = await getResearchExperiment(kv, experimentId)
  if (!experiment) return { ok: false, status: 404, error: 'research experiment not found' }
  if (experiment.status !== 'approved_for_patch') {
    return { ok: false, status: 409, error: 'experiment must be approved_for_patch before artifact intent' }
  }

  const [handoff] = await listResearchPatchHandoffs(kv, experimentId, 1)
  if (!handoff) return { ok: false, status: 409, error: 'patch handoff missing' }
  if (handoff.artifact_bridge.target_registry !== 'model_artifact_registry') {
    return { ok: false, status: 409, error: 'handoff target is not model_artifact_registry' }
  }
  const type = candidateType(handoff)
  if (!type) return { ok: false, status: 409, error: 'handoff candidate type cannot enter model_artifact_registry' }

  const createdAt = new Date().toISOString()
  const modelName = clean(input.model_name) || firstCandidate(handoff)
  const artifactVersion = clean(input.artifact_version) || `${RESEARCH_ARTIFACT_INTENT_VERSION}-${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}`
  const registryCandidate: ResearchArtifactIntent['registry_candidate'] = {
    artifact_id: `${modelName}:${artifactVersion}:${type}`,
    model_name: modelName,
    version: artifactVersion,
    candidate_type: type,
    state: 'registered',
    artifact_path: clean(input.artifact_path) || null,
    metadata_path: clean(input.metadata_path) || null,
    training_manifest_path: clean(input.training_manifest_path) || null,
    feature_policy_version: clean(input.feature_policy_version) || null,
    checksum: clean(input.checksum) || null,
    source_run_date: sourceRunDate(),
    approval_state: 'required',
    promotion_decision: 'not_evaluated',
  }
  const missing = missingFields(registryCandidate)
  const ready = missing.length === 0
  const intent: ResearchArtifactIntent = {
    id: intentId(experimentId, createdAt),
    version: RESEARCH_ARTIFACT_INTENT_VERSION,
    mode: 'metadata_only',
    experiment_id: experimentId,
    handoff_id: handoff.id,
    status: ready ? 'ready_for_registry_preflight' : 'blocked_missing_artifact',
    created_at: createdAt,
    reviewer: clean(input.reviewer) || 'Wei',
    reason: clean(input.reason) || null,
    production_effect: false,
    target_registry: 'model_artifact_registry',
    registry_candidate: registryCandidate,
    preflight: {
      can_write_registry: false,
      ready_for_manual_registry_write: ready,
      missing_fields: missing,
      blockers: ready ? [] : missing.map((field) => `missing_${field}`),
      required_manual_steps: [
        'Produce or attach the trained artifact and immutable metadata outside this metadata route.',
        'Verify checksum, training manifest, feature policy, and evaluation evidence.',
        'Only then use the model_artifact_registry owner path to write a non-voting candidate row.',
        'Promotion controller and manual approval still own any champion pointer movement.',
      ],
    },
    blocked_capabilities: ['model_artifact_registry write', 'champion pointer update', 'production deploy', 'paper/live trade execution'],
  }
  await kv.put(intent.id, JSON.stringify(intent))
  return { ok: true, intent }
}

export async function listResearchArtifactIntents(
  kv: KVNamespace,
  experimentId: string,
  limit = 10,
): Promise<ResearchArtifactIntent[]> {
  const requestedLimit = Math.max(1, Math.min(limit, 50))
  const { keys } = await kv.list({ prefix: intentPrefix(experimentId), limit: 50 })
  const rows = await Promise.all(
    keys.map(async (key) => kv.get(key.name, 'json') as Promise<ResearchArtifactIntent | null>),
  )
  return rows
    .filter((row): row is ResearchArtifactIntent => row?.version === RESEARCH_ARTIFACT_INTENT_VERSION)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
    .slice(0, requestedLimit)
}
