import type { Bindings } from '../types'
import { ALLOCATOR_EV_FUSION_CONTRACT, L4_ALPHA_EV_CONTRACT } from './evidenceContracts'

export const EXPECTED_RETURN_SERVING_STATE_KEY = 'expected-return:serving-state:v1'

export type ExpectedReturnOwner = 'l4_alpha_ev' | 'allocator_ev_fusion'
export type ExpectedReturnArtifactState =
  | 'serving'
  | 'retired_incompatible'
  | 'candidate_not_ready'
  | 'missing'

export interface ExpectedReturnArtifactServingState {
  owner: ExpectedReturnOwner
  artifact_state: ExpectedReturnArtifactState
  eligible: boolean
  model_version: string | null
  promotion_state: string | null
  blockers: string[]
}

export interface ExpectedReturnServingState {
  schema_version: 'expected-return-serving-state-v1'
  state: 'production_primary' | 'no_eligible_owner'
  expected_return_owner: ExpectedReturnOwner | null
  action_gate: 'expected_return_owner' | 'validated_s12_only'
  run_date: string | null
  evaluated_at: string
  source_of_truth: 'trading:config+strict_contract'
  artifacts: {
    l4_alpha_ev: ExpectedReturnArtifactServingState
    allocator_ev_fusion: ExpectedReturnArtifactServingState
  }
}

type ArtifactContract = {
  artifactContractVersion: string
  featureSemanticVersion: string
  labelSchemaVersion: string
  compatiblePairs?: readonly {
    artifactContractVersion: string
    featureSemanticVersion: string
    labelSchemaVersion: string
  }[]
}

function artifactObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null
}

function evaluateArtifact(
  owner: ExpectedReturnOwner,
  artifact: Record<string, any> | null,
  contract: ArtifactContract,
): ExpectedReturnArtifactServingState {
  if (!artifact) {
    return {
      owner,
      artifact_state: 'missing',
      eligible: false,
      model_version: null,
      promotion_state: null,
      blockers: ['artifact_missing'],
    }
  }

  const blockers: string[] = []
  const requiredPromotionState = owner === 'allocator_ev_fusion'
    ? 'production_primary'
    : 'production_approved'
  if (artifact.expected_return_owner !== owner) blockers.push('expected_return_owner_mismatch')
  if (artifact.promotion_state !== requiredPromotionState) blockers.push('promotion_state_not_serving')
  if (owner === 'allocator_ev_fusion' && artifact.primary_expected_return_allowed !== true) {
    blockers.push('primary_expected_return_not_allowed')
  }
  if (String(artifact.validation_packet?.decision ?? '').toUpperCase() !== 'PASS') {
    blockers.push('validation_not_pass')
  }
  const compatiblePairs = contract.compatiblePairs ?? [contract]
  const exactContractPair = compatiblePairs.some((pair) => (
    artifact.artifact_contract_version === pair.artifactContractVersion
    && artifact.feature_semantic_version === pair.featureSemanticVersion
    && artifact.label_schema_version === pair.labelSchemaVersion
  ))
  const knownArtifactVersion = compatiblePairs.some((pair) => (
    artifact.artifact_contract_version === pair.artifactContractVersion
  ))
  if (!knownArtifactVersion) {
    blockers.push('artifact_contract_version_incompatible')
  }
  if (knownArtifactVersion && !exactContractPair) {
    blockers.push('feature_semantic_version_incompatible')
  }
  if (!compatiblePairs.some((pair) => artifact.label_schema_version === pair.labelSchemaVersion)) {
    blockers.push('label_schema_version_incompatible')
  }
  const modelVersion = String(artifact.model_version ?? '').trim()
  if (!modelVersion) blockers.push('model_version_missing')

  const incompatible = blockers.some((blocker) => blocker.endsWith('_incompatible'))
  return {
    owner,
    artifact_state: blockers.length === 0
      ? 'serving'
      : incompatible
        ? 'retired_incompatible'
        : 'candidate_not_ready',
    eligible: blockers.length === 0,
    model_version: modelVersion || null,
    promotion_state: String(artifact.promotion_state ?? '').trim() || null,
    blockers,
  }
}

export function resolveExpectedReturnServingState(
  rawConfig: Record<string, any> | null | undefined,
  options: { runDate?: string | null; evaluatedAt?: string } = {},
): ExpectedReturnServingState {
  const ensembleV2 = artifactObject(rawConfig?.ensemble_v2) ?? {}
  const l4 = evaluateArtifact(
    'l4_alpha_ev',
    artifactObject(ensembleV2.l4AlphaEv ?? ensembleV2.l4_alpha_ev),
    L4_ALPHA_EV_CONTRACT,
  )
  const fusion = evaluateArtifact(
    'allocator_ev_fusion',
    artifactObject(ensembleV2.allocatorEvFusion ?? ensembleV2.allocator_ev_fusion),
    ALLOCATOR_EV_FUSION_CONTRACT,
  )
  const owner: ExpectedReturnOwner | null = fusion.eligible
    ? 'allocator_ev_fusion'
    : l4.eligible
      ? 'l4_alpha_ev'
      : null

  return {
    schema_version: 'expected-return-serving-state-v1',
    state: owner ? 'production_primary' : 'no_eligible_owner',
    expected_return_owner: owner,
    action_gate: owner ? 'expected_return_owner' : 'validated_s12_only',
    run_date: options.runDate ?? null,
    evaluated_at: options.evaluatedAt ?? new Date().toISOString(),
    source_of_truth: 'trading:config+strict_contract',
    artifacts: {
      l4_alpha_ev: l4,
      allocator_ev_fusion: fusion,
    },
  }
}

export async function refreshExpectedReturnServingState(
  env: Pick<Bindings, 'KV'>,
  runDate?: string | null,
): Promise<ExpectedReturnServingState> {
  const rawConfig = await env.KV.get('trading:config', 'json') as Record<string, any> | null
  const state = resolveExpectedReturnServingState(rawConfig, { runDate })
  await env.KV.put(EXPECTED_RETURN_SERVING_STATE_KEY, JSON.stringify(state))
  return state
}

export async function readCurrentExpectedReturnServingState(
  env: Pick<Bindings, 'KV'>,
  runDate?: string | null,
): Promise<ExpectedReturnServingState> {
  const rawConfig = await env.KV.get('trading:config', 'json') as Record<string, any> | null
  return resolveExpectedReturnServingState(rawConfig, { runDate })
}
