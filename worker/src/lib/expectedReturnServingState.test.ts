import assert from 'node:assert/strict'
import { ALLOCATOR_EV_FUSION_CONTRACT, L4_ALPHA_EV_CONTRACT } from './evidenceContracts'
import { resolveExpectedReturnServingState } from './expectedReturnServingState'

function validL4(): Record<string, any> {
  return {
    expected_return_owner: 'l4_alpha_ev',
    promotion_state: 'production_approved',
    validation_packet: { decision: 'PASS' },
    output_is_net_of_costs: true,
    artifact_contract_version: L4_ALPHA_EV_CONTRACT.artifactContractVersion,
    feature_semantic_version: L4_ALPHA_EV_CONTRACT.featureSemanticVersion,
    label_schema_version: L4_ALPHA_EV_CONTRACT.labelSchemaVersion,
    model_version: 'l4-alpha-ev-ridge-v5-sector-test',
  }
}

function validFusion(): Record<string, any> {
  return {
    expected_return_owner: 'allocator_ev_fusion',
    promotion_state: 'production_primary',
    primary_expected_return_allowed: true,
    validation_packet: { decision: 'PASS' },
    output_is_net_of_costs: true,
    artifact_contract_version: ALLOCATOR_EV_FUSION_CONTRACT.artifactContractVersion,
    policy_value_head_count: 1,
    policy_value_heads: ['residual_adjustment_model'],
    residual_adjustment_model: { coefficients: { l4_expected_return: 0.6 } },
    feature_semantic_version: ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion,
    label_schema_version: ALLOCATOR_EV_FUSION_CONTRACT.labelSchemaVersion,
    model_version: 'allocator-ev-fusion-residual-v14-test',
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
assert.equal(stale.action_gate, 'fusion_primary_required')
assert.equal(stale.artifacts.l4_alpha_ev.artifact_state, 'retired_incompatible')
assert(stale.artifacts.l4_alpha_ev.blockers.includes('artifact_contract_version_incompatible'))

const l4Primary = resolveExpectedReturnServingState({
  ensemble_v2: { l4_alpha_ev: validL4() },
})
assert.equal(l4Primary.expected_return_owner, 'l4_alpha_ev')
assert.equal(l4Primary.artifacts.l4_alpha_ev.artifact_state, 'serving')

const l4AbstentionArtifact = {
  ...validL4(),
  promotion_state: 'safe_abstention',
  serving_mode: 'abstention_baseline',
}
const l4Abstention = resolveExpectedReturnServingState({
  ensemble_v2: { l4_alpha_ev: l4AbstentionArtifact },
})
assert.equal(l4Abstention.expected_return_owner, null)
assert.equal(l4Abstention.artifacts.l4_alpha_ev.artifact_state, 'safe_abstention')
assert.equal(l4Abstention.artifacts.l4_alpha_ev.eligible, false)
assert.equal(l4Abstention.artifacts.l4_alpha_ev.serving_available, true)
assert.deepEqual(l4Abstention.artifacts.l4_alpha_ev.blockers, [])
assert(l4Abstention.warnings.includes('l4_alpha_ev:alpha_champion_not_promoted'))

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
assert.equal(legacyV11StillServes.expected_return_owner, 'l4_alpha_ev')
assert.equal(legacyV11StillServes.action_gate, 'expected_return_owner')
assert.equal(legacyV11StillServes.artifacts.allocator_ev_fusion.artifact_state, 'retired_incompatible')

const hybridV11V12 = {
  ...legacyV11Fusion,
  feature_semantic_version: ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion,
}
const hybridRejected = resolveExpectedReturnServingState({
  ensemble_v2: { l4AlphaEv: validL4(), allocatorEvFusion: hybridV11V12 },
})
assert.equal(hybridRejected.expected_return_owner, 'l4_alpha_ev')
assert(hybridRejected.artifacts.allocator_ev_fusion.blockers.includes('artifact_contract_version_incompatible'))

const blockedFusion = validFusion()
blockedFusion.validation_packet = { decision: 'FAIL' }
const l4Fallback = resolveExpectedReturnServingState({
  ensemble_v2: {
    l4AlphaEv: validL4(),
    allocatorEvFusion: blockedFusion,
  },
})
assert.equal(l4Fallback.expected_return_owner, 'l4_alpha_ev')
assert.equal(l4Fallback.action_gate, 'expected_return_owner')
assert.equal(l4Fallback.artifacts.allocator_ev_fusion.artifact_state, 'candidate_not_ready')

console.log('expectedReturnServingState tests passed')
