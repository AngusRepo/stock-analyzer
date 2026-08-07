import type { Bindings } from '../types'
import { hydrateExpectedReturnConfigFromPointers } from './expectedReturnServingRegistry'
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
  serving_available: boolean
}

export interface ExpectedReturnServingState {
  schema_version: 'expected-return-serving-state-v1'
  state: 'production_primary' | 'no_eligible_owner'
  expected_return_owner: ExpectedReturnOwner | null
  action_gate: 'expected_return_owner' | 'fusion_primary_required'
  run_date: string | null
  evaluated_at: string
  source_of_truth: 'candidate_projection' | 'model_champion_pointers+artifact_payloads'
  artifacts: {
    l4_alpha_ev: ExpectedReturnArtifactServingState
    allocator_ev_fusion: ExpectedReturnArtifactServingState
  }
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

function isZeroControlHead(model: Record<string, any> | null): boolean {
  if (!model || model.model_type !== 'constant_abstention_control') return false
  if (Number(model.intercept ?? Number.NaN) !== 0) return false
  const coefficients = artifactObject(model.coefficients)
  if (!coefficients || Object.keys(coefficients).length === 0) return false
  return Object.values(coefficients).every((value) => Number(value) === 0)
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
      serving_available: false,
    }
  }

  const blockers: string[] = []
  const abstentionBaseline = artifact.serving_mode === 'abstention_baseline'
  const requiredPromotionState = owner === 'allocator_ev_fusion'
    ? 'production_primary'
    : 'production_approved'
  if (artifact.expected_return_owner !== owner) blockers.push('expected_return_owner_mismatch')
  if (artifact.output_is_net_of_costs !== true) blockers.push('expected_return_not_net_of_costs')
  if (abstentionBaseline) {
    if (artifact.promotion_state !== 'safe_abstention') blockers.push('abstention_promotion_state_invalid')
    if (artifact.validation_packet?.scope !== 'operational_safety_only') blockers.push('abstention_validation_scope_invalid')
    if (artifact.validation_packet?.alpha_quality_passed !== false) blockers.push('abstention_alpha_claim_invalid')
  } else if (artifact.promotion_state !== requiredPromotionState) {
    blockers.push('promotion_state_not_serving')
  }
  if (owner === 'allocator_ev_fusion') {
    const policyHeads = Array.isArray(artifact.policy_value_heads)
      ? artifact.policy_value_heads.map((value: unknown) => String(value ?? '').trim())
      : []
    const requiredHeads = ['execution_probability_model', 'conditional_execution_return_model']
    if (artifact.policy_value_head_count !== 2) blockers.push('policy_value_head_count_not_two')
    if (policyHeads.length !== 2 || requiredHeads.some((head) => !policyHeads.includes(head))) {
      blockers.push('policy_value_heads_incompatible')
    }
    if (artifactObject(artifact.selection_model) || artifact.intercept != null || artifactObject(artifact.coefficients)) {
      blockers.push('third_selection_serving_head_forbidden')
    }
    const probabilityModel = artifactObject(artifact.execution_probability_model)
    const returnModel = artifactObject(artifact.conditional_execution_return_model)
    if (!probabilityModel) blockers.push('execution_probability_model_missing')
    if (!returnModel) blockers.push('conditional_execution_return_model_missing')
    for (const [head, model] of [
      ['execution_probability_model', probabilityModel],
      ['conditional_execution_return_model', returnModel],
    ] as const) {
      if (!model) continue
      const coefficients = artifactObject(model.coefficients) ?? {}
      const featureNames = Object.keys(coefficients)
      if (!featureNames.some((name) => name.startsWith('l4_'))) blockers.push(`${head}_l4_feature_missing`)
      if (featureNames.some((name) => name.startsWith('s12_') || name === 'l4_s12_edge_agreement')) {
        blockers.push(`${head}_candidate_time_s12_feature_forbidden`)
      }
    }
    if (abstentionBaseline) {
      if (artifact.benchmark_role !== 'same_contract_no_trade_policy_value_baseline') {
        blockers.push('abstention_baseline_role_invalid')
      }
      if (!isZeroControlHead(probabilityModel)) blockers.push('execution_probability_baseline_head_not_zero')
      if (!isZeroControlHead(returnModel)) blockers.push('conditional_execution_return_baseline_head_not_zero')
    }
  }

  if (owner === 'allocator_ev_fusion') {
    if (abstentionBaseline) {
      if (artifact.primary_expected_return_allowed !== false) blockers.push('abstention_primary_permission_invalid')
    } else if (artifact.primary_expected_return_allowed !== true) {
      blockers.push('primary_expected_return_not_allowed')
    }
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
  if (abstentionBaseline) blockers.push('abstention_baseline_not_serving')

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
  } = {},
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
  const owner: ExpectedReturnOwner | null = fusion.eligible ? 'allocator_ev_fusion' : null
  const warnings = [l4, fusion]
    .filter((item) => item.blockers.includes('abstention_baseline_not_serving'))
    .map((item) => `${item.owner}:abstention_baseline_not_serving`)

  return {
    schema_version: 'expected-return-serving-state-v1',
    state: owner ? 'production_primary' : 'no_eligible_owner',
    expected_return_owner: owner,
    action_gate: owner ? 'expected_return_owner' : 'fusion_primary_required',
    run_date: options.runDate ?? null,
    evaluated_at: options.evaluatedAt ?? new Date().toISOString(),
    source_of_truth: options.sourceOfTruth ?? 'candidate_projection',
    artifacts: {
      l4_alpha_ev: l4,
      allocator_ev_fusion: fusion,
    },
    hard_alerts: [...new Set(options.alerts ?? [])],
    warnings,
  }
}

export async function refreshExpectedReturnServingState(
  env: Pick<Bindings, 'KV' | 'DB'>,
  runDate?: string | null,
): Promise<ExpectedReturnServingState> {
  const rawConfig = await env.KV.get('trading:config', 'json') as Record<string, any> | null
  const hydrated = await hydrateExpectedReturnConfigFromPointers(env.DB, rawConfig ?? {})
  const state = resolveExpectedReturnServingState(hydrated.config, {
    runDate,
    sourceOfTruth: 'model_champion_pointers+artifact_payloads',
    alerts: hydrated.alerts,
  })
  await env.KV.put(EXPECTED_RETURN_SERVING_STATE_KEY, JSON.stringify(state))
  return state
}

export async function readCurrentExpectedReturnServingState(
  env: Pick<Bindings, 'KV' | 'DB'>,
  runDate?: string | null,
): Promise<ExpectedReturnServingState> {
  const rawConfig = await env.KV.get('trading:config', 'json') as Record<string, any> | null
  const hydrated = await hydrateExpectedReturnConfigFromPointers(env.DB, rawConfig ?? {})
  return resolveExpectedReturnServingState(hydrated.config, {
    runDate,
    sourceOfTruth: 'model_champion_pointers+artifact_payloads',
    alerts: hydrated.alerts,
  })
}
