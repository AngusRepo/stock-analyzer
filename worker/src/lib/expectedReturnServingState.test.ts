import assert from 'node:assert/strict'
import { ALLOCATOR_EV_FUSION_CONTRACT, L4_ALPHA_EV_CONTRACT } from './evidenceContracts'
import { resolveExpectedReturnServingState } from './expectedReturnServingState'

function validL4(): Record<string, any> {
  return {
    expected_return_owner: 'l4_alpha_ev',
    promotion_state: 'production_approved',
    validation_packet: { decision: 'PASS' },
    artifact_contract_version: L4_ALPHA_EV_CONTRACT.artifactContractVersion,
    feature_semantic_version: L4_ALPHA_EV_CONTRACT.featureSemanticVersion,
    label_schema_version: L4_ALPHA_EV_CONTRACT.labelSchemaVersion,
    model_version: 'l4-v4-test',
  }
}

function validFusion(): Record<string, any> {
  return {
    expected_return_owner: 'allocator_ev_fusion',
    promotion_state: 'production_primary',
    primary_expected_return_allowed: true,
    validation_packet: { decision: 'PASS' },
    artifact_contract_version: ALLOCATOR_EV_FUSION_CONTRACT.artifactContractVersion,
    feature_semantic_version: ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion,
    label_schema_version: ALLOCATOR_EV_FUSION_CONTRACT.labelSchemaVersion,
    model_version: 'fusion-v11-test',
  }
}

const stale = resolveExpectedReturnServingState({
  ensemble_v2: {
    l4AlphaEv: {
      expected_return_owner: 'l4_alpha_ev',
      promotion_state: 'production_approved',
      validation_packet: { decision: 'PASS' },
      model_version: 'l4-alpha-ev-ridge-20260702',
    },
  },
}, { evaluatedAt: '2026-07-16T00:00:00.000Z' })
assert.equal(stale.expected_return_owner, null)
assert.equal(stale.action_gate, 'validated_s12_only')
assert.equal(stale.artifacts.l4_alpha_ev.artifact_state, 'retired_incompatible')
assert(stale.artifacts.l4_alpha_ev.blockers.includes('artifact_contract_version_incompatible'))

const l4Primary = resolveExpectedReturnServingState({
  ensemble_v2: { l4_alpha_ev: validL4() },
})
assert.equal(l4Primary.expected_return_owner, 'l4_alpha_ev')
assert.equal(l4Primary.artifacts.l4_alpha_ev.artifact_state, 'serving')

const fusionPrimary = resolveExpectedReturnServingState({
  ensemble_v2: {
    l4AlphaEv: validL4(),
    allocatorEvFusion: validFusion(),
  },
})
assert.equal(fusionPrimary.expected_return_owner, 'allocator_ev_fusion')
assert.equal(fusionPrimary.artifacts.l4_alpha_ev.artifact_state, 'serving')
assert.equal(fusionPrimary.artifacts.allocator_ev_fusion.artifact_state, 'serving')

const blockedFusion = validFusion()
blockedFusion.validation_packet = { decision: 'FAIL' }
const l4Fallback = resolveExpectedReturnServingState({
  ensemble_v2: {
    l4AlphaEv: validL4(),
    allocatorEvFusion: blockedFusion,
  },
})
assert.equal(l4Fallback.expected_return_owner, 'l4_alpha_ev')
assert.equal(l4Fallback.artifacts.allocator_ev_fusion.artifact_state, 'candidate_not_ready')

console.log('expectedReturnServingState tests passed')
