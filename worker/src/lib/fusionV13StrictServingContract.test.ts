import assert from 'node:assert/strict'
import { ALLOCATOR_EV_FUSION_CONTRACT } from './evidenceContracts'
import { resolveExpectedReturnServingState } from './expectedReturnServingState'

function validFusion(): Record<string, any> {
  return {
    expected_return_owner: 'allocator_ev_fusion',
    promotion_state: 'production_primary',
    primary_expected_return_allowed: true,
    validation_packet: { decision: 'PASS' },
    artifact_contract_version: ALLOCATOR_EV_FUSION_CONTRACT.artifactContractVersion,
    feature_semantic_version: ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion,
    label_schema_version: ALLOCATOR_EV_FUSION_CONTRACT.labelSchemaVersion,
    model_version: 'fusion-v13-strict-test',
    policy_value_head_count: 2,
    policy_value_heads: ['execution_probability_model', 'conditional_execution_return_model'],
    execution_probability_model: { coefficients: { l4_available: 0.4 } },
    conditional_execution_return_model: { coefficients: { l4_expected_return: 0.6 } },
  }
}

function evaluate(candidate: Record<string, any>) {
  return resolveExpectedReturnServingState({
    ensemble_v2: { allocatorEvFusion: candidate },
  }).artifacts.allocator_ev_fusion
}

assert.equal(evaluate(validFusion()).artifact_state, 'serving')

const thirdHead = validFusion()
thirdHead.selection_model = { coefficients: { l4_expected_return: 1 } }
assert(evaluate(thirdHead).blockers.includes('third_selection_serving_head_forbidden'))

const candidateTimeS12 = validFusion()
candidateTimeS12.execution_probability_model.coefficients.s12_structure_ready = 1
candidateTimeS12.conditional_execution_return_model.coefficients.l4_s12_edge_agreement = 1
const candidateTimeBlockers = evaluate(candidateTimeS12).blockers
assert(candidateTimeBlockers.includes('execution_probability_model_candidate_time_s12_feature_forbidden'))
assert(candidateTimeBlockers.includes('conditional_execution_return_model_candidate_time_s12_feature_forbidden'))

const oneHead = validFusion()
oneHead.policy_value_head_count = 1
oneHead.policy_value_heads = ['execution_probability_model']
delete oneHead.conditional_execution_return_model
const oneHeadBlockers = evaluate(oneHead).blockers
assert(oneHeadBlockers.includes('policy_value_head_count_not_two'))
assert(oneHeadBlockers.includes('policy_value_heads_incompatible'))
assert(oneHeadBlockers.includes('conditional_execution_return_model_missing'))

console.log('Fusion v13 strict serving contract tests passed')
