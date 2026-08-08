import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ALLOCATOR_EV_FUSION_CONTRACT, L4_ALPHA_EV_CONTRACT } from './evidenceContracts'
import { resolveExpectedReturnServingState } from './expectedReturnServingState'
import type { ExpectedReturnForwardGuardState } from './expectedReturnForwardGuard'

const l4 = {
  artifact_id: 'l4_alpha_ev:l4-forward-guard-test',
  model_fingerprint: '1'.repeat(64),
  expected_return_owner: 'l4_alpha_ev',
  promotion_state: 'production_approved',
  validation_packet: { decision: 'PASS' },
  output_is_net_of_costs: true,
  artifact_contract_version: L4_ALPHA_EV_CONTRACT.artifactContractVersion,
  feature_semantic_version: L4_ALPHA_EV_CONTRACT.featureSemanticVersion,
  label_schema_version: L4_ALPHA_EV_CONTRACT.labelSchemaVersion,
  model_version: 'l4-forward-guard-test',
}

const fusion = {
  artifact_id: 'allocator_ev_fusion:fusion-forward-guard-test',
  model_fingerprint: '2'.repeat(64),
  expected_return_owner: 'allocator_ev_fusion',
  promotion_state: 'production_primary',
  primary_expected_return_allowed: true,
  validation_packet: { decision: 'PASS' },
  output_is_net_of_costs: true,
  artifact_contract_version: ALLOCATOR_EV_FUSION_CONTRACT.artifactContractVersion,
  feature_semantic_version: ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion,
  label_schema_version: ALLOCATOR_EV_FUSION_CONTRACT.labelSchemaVersion,
  model_version: 'fusion-forward-guard-test',
  policy_value_head_count: 1,
  policy_value_heads: ['residual_adjustment_model'],
  residual_adjustment_model: { coefficients: { l4_expected_return: 0.6 } },
}

function guard(overrides: Partial<ExpectedReturnForwardGuardState> = {}): ExpectedReturnForwardGuardState {
  return {
    model_name: 'allocator_ev_fusion',
    artifact_id: fusion.artifact_id,
    model_fingerprint: fusion.model_fingerprint,
    model_version: fusion.model_version,
    state: 'residual_bypass',
    evaluable_date_count: 5,
    degraded_streak: 3,
    recovery_streak: 0,
    last_prediction_date: '2026-08-06',
    evidence_json: '{}',
    updated_at: '2026-08-08T00:00:00Z',
    ...overrides,
  }
}

const exact = resolveExpectedReturnServingState(
  { ensemble_v2: { l4AlphaEv: l4, allocatorEvFusion: fusion } },
  { forwardGuard: guard() },
)
assert.equal(exact.expected_return_owner, 'l4_alpha_ev')
assert.equal(exact.artifacts.allocator_ev_fusion.artifact_state, 'runtime_guarded')
assert(exact.artifacts.allocator_ev_fusion.blockers.includes(
  'serving_forward_guard_residual_bypass_active',
))
assert(exact.warnings.includes(
  'allocator_ev_fusion:serving_forward_guard_residual_bypass_active',
))
assert.equal(exact.runtime_forward_guard?.degraded_streak, 3)

const mismatched = resolveExpectedReturnServingState(
  { ensemble_v2: { l4AlphaEv: l4, allocatorEvFusion: fusion } },
  { forwardGuard: guard({ model_fingerprint: '3'.repeat(64) }) },
)
assert.equal(mismatched.expected_return_owner, 'allocator_ev_fusion')
assert.equal(mismatched.artifacts.allocator_ev_fusion.artifact_state, 'serving')

const servingStateSource = fs.readFileSync('src/lib/expectedReturnServingState.ts', 'utf8')
assert(servingStateSource.includes("databaseForDataDomain(env, 'learning')"))
assert(!servingStateSource.includes('loadExpectedReturnForwardGuard(env.DB)'))
assert(!servingStateSource.includes('hydrateExpectedReturnConfigFromPointers(env.DB'))
assert.equal(
  (servingStateSource.match(/databaseForDataDomain\(env, 'learning'\)/g) ?? []).length, 2,
)
console.log('expected return serving forward guard tests passed')
