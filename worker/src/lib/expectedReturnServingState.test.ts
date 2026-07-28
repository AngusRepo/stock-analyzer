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
    output_is_net_of_costs: true,
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
    output_is_net_of_costs: true,
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

const legacyV11Fusion = {
  ...validFusion(),
  artifact_contract_version: 'allocator-ev-fusion-contract-v11',
  feature_semantic_version: 'allocator-ev-fusion-directional-components-v2-lineage-bound',
  model_version: 'fusion-v11-production',
}
const legacyV11StillServes = resolveExpectedReturnServingState({
  ensemble_v2: { l4AlphaEv: validL4(), allocatorEvFusion: legacyV11Fusion },
})
assert.equal(legacyV11StillServes.expected_return_owner, 'allocator_ev_fusion')
assert.equal(legacyV11StillServes.artifacts.allocator_ev_fusion.artifact_state, 'serving')

const hybridV11V12 = {
  ...legacyV11Fusion,
  feature_semantic_version: ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion,
}
const hybridRejected = resolveExpectedReturnServingState({
  ensemble_v2: { l4AlphaEv: validL4(), allocatorEvFusion: hybridV11V12 },
})
assert.equal(hybridRejected.expected_return_owner, 'l4_alpha_ev')
assert(hybridRejected.artifacts.allocator_ev_fusion.blockers.includes('feature_semantic_version_incompatible'))

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

const grossReturnL4 = validL4()
grossReturnL4.output_is_net_of_costs = false
const grossReturnRejected = resolveExpectedReturnServingState({
  ensemble_v2: { l4AlphaEv: grossReturnL4 },
})
assert.equal(grossReturnRejected.expected_return_owner, null)
assert(grossReturnRejected.artifacts.l4_alpha_ev.blockers.includes('expected_return_not_net_of_costs'))

const safeBaseline = resolveExpectedReturnServingState({
  ensemble_v2: {
    l4AlphaEv: {
      expected_return_owner: 'l4_alpha_ev',
      serving_mode: 'abstention_baseline',
      promotion_state: 'safe_abstention',
      validation_packet: {
        decision: 'PASS',
        alpha_quality_passed: false,
      },
      artifact_contract_version: L4_ALPHA_EV_CONTRACT.artifactContractVersion,
      feature_semantic_version: L4_ALPHA_EV_CONTRACT.featureSemanticVersion,
      label_schema_version: L4_ALPHA_EV_CONTRACT.labelSchemaVersion,
      model_version: 'l4-alpha-ev-abstention-baseline-v1',
      output_is_net_of_costs: true,
    },
  },
})
assert.equal(safeBaseline.state, 'safe_abstention')
assert.equal(safeBaseline.expected_return_owner, null)
assert.equal(safeBaseline.artifacts.l4_alpha_ev.artifact_state, 'abstention_baseline')
assert.equal(safeBaseline.artifacts.l4_alpha_ev.serving_available, true)

console.log('expectedReturnServingState tests passed')
