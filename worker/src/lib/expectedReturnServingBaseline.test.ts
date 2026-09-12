import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ALLOCATOR_EV_FUSION_CONTRACT as F, L4_ALPHA_EV_CONTRACT as L } from './evidenceContracts'
import { resolveExpectedReturnServingState } from './expectedReturnServingState'
import { NAV_GATE_SCHEMA } from './pairedNavPromotionEvidence'

// Serving identity fixtures, not fabricated NAV evidence or investment results.
const l4 = {
  expected_return_owner: 'l4_alpha_ev', promotion_state: 'production_approved',
  validation_packet: { decision: 'PASS' }, output_is_net_of_costs: true,
  artifact_contract_version: L.artifactContractVersion, feature_semantic_version: L.featureSemanticVersion,
  label_schema_version: L.labelSchemaVersion, model_version: 'fixture-l4',
  prospective_validation: { schema_version: NAV_GATE_SCHEMA, candidate_artifact_checksum: 'a'.repeat(64) },
}
const fusion = {
  expected_return_owner: 'allocator_ev_fusion', promotion_state: 'production_primary',
  primary_expected_return_allowed: true, validation_packet: { decision: 'PASS' }, output_is_net_of_costs: true,
  artifact_contract_version: F.artifactContractVersion, feature_semantic_version: F.featureSemanticVersion,
  label_schema_version: F.labelSchemaVersion, model_version: 'fixture-fusion',
  policy_value_head_count: 1, policy_value_heads: ['residual_adjustment_model'],
  residual_adjustment_model: { coefficients: { l4_expected_return: .6 } },
  prospective_validation: { schema_version: NAV_GATE_SCHEMA, nav_validation: { baseline_checksum: 'a'.repeat(64) } },
}
function resolve(base: any, residual: any = fusion, options: any = {}) {
  return resolveExpectedReturnServingState({ ensemble_v2: { l4AlphaEv: base, allocatorEvFusion: residual } }, options)
}

test('the exact serving L4 keeps NAV-approved Fusion available', () => {
  assert.equal(resolve(l4).expected_return_owner, 'allocator_ev_fusion')
})
test('a changed L4 invalidates the old Fusion comparison, not L4 itself', () => {
  const changed = { ...l4, prospective_validation: { ...l4.prospective_validation, candidate_artifact_checksum: 'b'.repeat(64) } }
  const state = resolve(changed)
  assert.equal(state.expected_return_owner, 'l4_alpha_ev')
  assert.equal(state.artifacts.allocator_ev_fusion.serving_available, false)
  assert(state.artifacts.allocator_ev_fusion.blockers.includes('nav_exact_l4_dependency_not_serving'))
})
test('missing L4 abstains without substituting ML advice or unsupported residuals', () => {
  const state = resolve(null)
  assert.equal(state.expected_return_owner, null)
  assert.equal(state.allocation_utility_owner, 'risk_abstention')
  assert.equal(state.selection_signal_owner, 'allocator_opb_policy')
  assert.equal(state.action_gate, 'validated_expected_return_required')
})
test('the authoritative L4 pointer wins over a stale embedded artifact checksum', () => {
  const state = resolve(l4, fusion, { pointerProjections: {
    l4_alpha_ev: { champion_artifact_id: `l4_alpha_ev:fixture-l4:${'b'.repeat(64)}`, serving_mode: 'alpha' },
    allocator_ev_fusion: { champion_artifact_id: `allocator_ev_fusion:fixture-fusion:${'c'.repeat(64)}`, serving_mode: 'alpha' },
  } })
  assert.equal(state.expected_return_owner, 'l4_alpha_ev')
  assert(state.warnings.includes('allocator_ev_fusion:nav_exact_l4_dependency_not_serving'))
})
for (const baseline of ['', 'not-a-checksum', 'b'.repeat(64)]) {
  test(`invalid NAV baseline (${baseline.slice(0, 8)}) cannot fall back to an unrelated L4`, () => {
    const residual = { ...fusion, prospective_validation: { ...fusion.prospective_validation,
      nav_validation: { baseline_checksum: baseline } } }
    assert.equal(resolve(l4, residual).expected_return_owner, 'l4_alpha_ev')
  })
}
