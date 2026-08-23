import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { hydrateExpectedReturnConfigFromPointers } from './expectedReturnServingRegistry'
import type { ExpectedReturnPointerProjection } from './expectedReturnServingRegistry'
import { ALLOCATOR_EV_FUSION_CONTRACT, L4_ALPHA_EV_CONTRACT } from './evidenceContracts'
import { resolveDecisionOwnerContract, type ExpectedReturnActionGate } from './decisionOwnerContract'
import {
  isExactActiveForwardGuard,
  loadExpectedReturnForwardGuard,
  type ExpectedReturnForwardGuardState,
} from './expectedReturnForwardGuard'

export const EXPECTED_RETURN_SERVING_STATE_KEY = 'expected-return:serving-state:v1'

export type ExpectedReturnOwner = 'l4_alpha_ev' | 'allocator_ev_fusion'
export type ExpectedReturnArtifactState =
  | 'serving'
  | 'retired_incompatible'
  | 'candidate_not_ready'
  | 'runtime_guarded'
  | 'safe_abstention'
  | 'missing'

export interface ExpectedReturnArtifactServingState {
  owner: ExpectedReturnOwner
  artifact_state: ExpectedReturnArtifactState
  eligible: boolean
  artifact_id: string | null
  model_fingerprint: string | null
  model_version: string | null
  artifact_contract_version: string | null
  feature_semantic_version: string | null
  label_schema_version: string | null
  serving_mode: 'alpha' | 'abstention_baseline' | null
  promotion_state: string | null
  pointer_updated_at: string | null
  blockers: string[]
  serving_available: boolean
}

export interface ExpectedReturnServingState {
  schema_version: 'expected-return-serving-state-v1'
  state: 'production_primary' | 'no_eligible_owner'
  selection_signal_owner: 'score_v2_formal_ml'
  expected_return_owner: ExpectedReturnOwner | null
  allocation_utility_owner: 'expected_return_owner' | 'score_v2_formal_ml'
  execution_owner: 'allocator_opb_policy'
  execution_scope: 'recommendation_allocation_only_no_order_submission'
  action_gate: ExpectedReturnActionGate
  run_date: string | null
  evaluated_at: string
  source_of_truth: 'candidate_projection' | 'model_champion_pointers+artifact_payloads'
  artifacts: {
    l4_alpha_ev: ExpectedReturnArtifactServingState
    allocator_ev_fusion: ExpectedReturnArtifactServingState
  }
  runtime_forward_guard: ExpectedReturnForwardGuardState | null
  hard_alerts: string[]
  warnings: string[]
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
  pointer?: ExpectedReturnPointerProjection,
): ExpectedReturnArtifactServingState {
  if (!artifact) {
    const explicitSafeAbstention = pointer?.valid === true
      && pointer.serving_mode === 'abstention_baseline'
      && pointer.owner_state === 'safe_abstention'
    return {
      owner,
      artifact_state: explicitSafeAbstention ? 'safe_abstention' : 'missing',
      eligible: false,
      artifact_id: explicitSafeAbstention ? null : pointer?.champion_artifact_id ?? null,
      model_fingerprint: null,
      model_version: null,
      artifact_contract_version: null,
      feature_semantic_version: null,
      label_schema_version: null,
      serving_mode: pointer?.serving_mode ?? null,
      promotion_state: null,
      pointer_updated_at: pointer?.pointer_updated_at ?? null,
      blockers: explicitSafeAbstention ? [] : ['artifact_missing'],
      serving_available: explicitSafeAbstention,
    }
  }

  const blockers: string[] = []
  const servingMode = pointer?.serving_mode
    ?? (artifact.serving_mode === 'alpha' || artifact.serving_mode === 'abstention_baseline'
      ? artifact.serving_mode
      : null)
  const isAbstention = pointer?.valid === true
    && pointer.owner_state === 'safe_abstention'
    && pointer.serving_mode === 'abstention_baseline'
  if (servingMode === 'abstention_baseline' && !isAbstention) {
    blockers.push('abstention_artifact_deprecated')
  }
  const requiredPromotionState = owner === 'allocator_ev_fusion'
    ? 'production_primary'
    : 'production_approved'
  if (artifact.expected_return_owner !== owner) blockers.push('expected_return_owner_mismatch')
  if (artifact.output_is_net_of_costs !== true) blockers.push('expected_return_not_net_of_costs')
  if (String(artifact.validation_packet?.decision ?? '').toUpperCase() !== 'PASS') {
    blockers.push('validation_not_pass')
  }
  if (!isAbstention && artifact.promotion_state !== requiredPromotionState) {
    blockers.push('promotion_state_not_serving')
  }
  if (owner === 'allocator_ev_fusion' && !isAbstention) {
    const policyHeads = Array.isArray(artifact.policy_value_heads)
      ? artifact.policy_value_heads.map((value: unknown) => String(value ?? '').trim())
      : []
    if (artifact.policy_value_head_count !== 1) blockers.push('policy_value_head_count_not_one')
    if (policyHeads.length !== 1 || policyHeads[0] !== 'residual_adjustment_model') {
      blockers.push('policy_value_heads_incompatible')
    }
    const residualModel = artifactObject(artifact.residual_adjustment_model)
    if (!residualModel) blockers.push('residual_adjustment_model_missing')
    if (
      artifactObject(artifact.selection_model)
      || artifactObject(artifact.execution_probability_model)
      || artifactObject(artifact.conditional_execution_return_model)
      || artifact.intercept != null
      || artifactObject(artifact.coefficients)
    ) {
      blockers.push('legacy_serving_head_forbidden')
    }
    if (residualModel) {
      const coefficients = artifactObject(residualModel.coefficients) ?? {}
      const featureNames = Object.keys(coefficients)
      if (!featureNames.some((name) => name.startsWith('l4_'))) blockers.push('residual_adjustment_model_l4_feature_missing')
      if (featureNames.some((name) => name.startsWith('s12_') || name === 'l4_s12_edge_agreement')) {
        blockers.push('residual_adjustment_model_candidate_time_s12_feature_forbidden')
      }
    }
  }

  if (owner === 'allocator_ev_fusion' && !isAbstention && artifact.primary_expected_return_allowed !== true) {
    blockers.push('primary_expected_return_not_allowed')
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
    artifact_state: incompatible
      ? 'retired_incompatible'
      : blockers.length > 0
        ? 'candidate_not_ready'
        : isAbstention
          ? 'safe_abstention'
          : 'serving',
    eligible: !isAbstention && blockers.length === 0,
    artifact_id: pointer?.champion_artifact_id ?? (String(artifact.artifact_id ?? '').trim() || null),
    model_fingerprint: String(artifact.model_fingerprint ?? '').trim() || null,
    model_version: modelVersion || null,
    artifact_contract_version: String(artifact.artifact_contract_version ?? '').trim() || null,
    feature_semantic_version: String(artifact.feature_semantic_version ?? '').trim() || null,
    label_schema_version: String(artifact.label_schema_version ?? '').trim() || null,
    serving_mode: servingMode,
    promotion_state: String(artifact.promotion_state ?? '').trim() || null,
    pointer_updated_at: pointer?.pointer_updated_at ?? null,
    blockers,
    serving_available: blockers.length === 0,
  }
}

export function resolveExpectedReturnServingState(
  rawConfig: Record<string, any> | null | undefined,
  options: {
    runDate?: string | null
    evaluatedAt?: string
    sourceOfTruth?: ExpectedReturnServingState['source_of_truth']
    alerts?: string[]
    pointerProjections?: Record<ExpectedReturnOwner, ExpectedReturnPointerProjection>
    forwardGuard?: ExpectedReturnForwardGuardState | null
  } = {},
): ExpectedReturnServingState {
  const ensembleV2 = artifactObject(rawConfig?.ensemble_v2) ?? {}
  const l4 = evaluateArtifact(
    'l4_alpha_ev',
    artifactObject(ensembleV2.l4AlphaEv ?? ensembleV2.l4_alpha_ev),
    L4_ALPHA_EV_CONTRACT,
    options.pointerProjections?.l4_alpha_ev,
  )
  let fusion = evaluateArtifact(
    'allocator_ev_fusion',
    artifactObject(ensembleV2.allocatorEvFusion ?? ensembleV2.allocator_ev_fusion),
    ALLOCATOR_EV_FUSION_CONTRACT,
    options.pointerProjections?.allocator_ev_fusion,
  )
  if (isExactActiveForwardGuard(options.forwardGuard, fusion.artifact_id, fusion.model_fingerprint)) {
    fusion = {
      ...fusion,
      artifact_state: 'runtime_guarded',
      eligible: false,
      blockers: [...new Set([...fusion.blockers, 'serving_forward_guard_residual_bypass_active'])],
      serving_available: false,
    }
  }
  const owner: ExpectedReturnOwner | null = fusion.eligible ? 'allocator_ev_fusion' : l4.eligible ? 'l4_alpha_ev' : null
  const warnings = [l4, fusion]
    .filter((item) => item.artifact_state === 'safe_abstention')
    .map((item) => `${item.owner}:alpha_champion_not_promoted`)
  if (fusion.artifact_state === 'runtime_guarded') {
    warnings.push('allocator_ev_fusion:serving_forward_guard_residual_bypass_active')
  }

  const decisionOwners = resolveDecisionOwnerContract(owner)
  return {
    schema_version: 'expected-return-serving-state-v1',
    state: owner ? 'production_primary' : 'no_eligible_owner',
    selection_signal_owner: decisionOwners.selection_signal_owner,
    expected_return_owner: owner,
    allocation_utility_owner: decisionOwners.allocation_utility_owner,
    execution_owner: decisionOwners.execution_owner,
    execution_scope: decisionOwners.execution_scope,
    action_gate: decisionOwners.action_gate,
    run_date: options.runDate ?? null,
    evaluated_at: options.evaluatedAt ?? new Date().toISOString(),
    source_of_truth: options.sourceOfTruth ?? 'candidate_projection',
    artifacts: {
      l4_alpha_ev: l4,
      allocator_ev_fusion: fusion,
    },
    runtime_forward_guard: options.forwardGuard ?? null,
    hard_alerts: [...new Set(options.alerts ?? [])],
    warnings,
  }
}

type ExpectedReturnServingEnv = Pick<Bindings, 'KV' | 'DB'> & Partial<Pick<
  Bindings,
  'LEARNING_DB' | 'MULTI_D1_ACTIVE_DOMAINS' | 'MULTI_D1_STRICT'
>>

export async function refreshExpectedReturnServingState(
  env: ExpectedReturnServingEnv,
  runDate?: string | null,
): Promise<ExpectedReturnServingState> {
  const rawConfig = await env.KV.get('trading:config', 'json') as Record<string, any> | null
  const learningDb = databaseForDataDomain(env, 'learning')
  const [hydrated, forwardGuard] = await Promise.all([
    hydrateExpectedReturnConfigFromPointers(learningDb, rawConfig ?? {}),
    loadExpectedReturnForwardGuard(learningDb),
  ])
  const state = resolveExpectedReturnServingState(hydrated.config, {
    runDate,
    sourceOfTruth: 'model_champion_pointers+artifact_payloads',
    alerts: hydrated.alerts,
    pointerProjections: hydrated.projections,
    forwardGuard,
  })
  await env.KV.put(EXPECTED_RETURN_SERVING_STATE_KEY, JSON.stringify(state))
  return state
}

export async function readCurrentExpectedReturnServingState(
  env: ExpectedReturnServingEnv,
  runDate?: string | null,
): Promise<ExpectedReturnServingState> {
  const rawConfig = await env.KV.get('trading:config', 'json') as Record<string, any> | null
  const learningDb = databaseForDataDomain(env, 'learning')
  const [hydrated, forwardGuard] = await Promise.all([
    hydrateExpectedReturnConfigFromPointers(learningDb, rawConfig ?? {}),
    loadExpectedReturnForwardGuard(learningDb),
  ])
  return resolveExpectedReturnServingState(hydrated.config, {
    runDate,
    sourceOfTruth: 'model_champion_pointers+artifact_payloads',
    alerts: hydrated.alerts,
    pointerProjections: hydrated.projections,
    forwardGuard,
  })
}
