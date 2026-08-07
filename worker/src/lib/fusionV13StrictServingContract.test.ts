import assert from 'node:assert/strict'
import { ALLOCATOR_EV_FUSION_CONTRACT } from './evidenceContracts'
import { resolveExpectedReturnServingState } from './expectedReturnServingState'

function validFusion(): Record<string, any> {
  return {
    expected_return_owner: 'allocator_ev_fusion',
    promotion_state: 'production_primary',
    primary_expected_return_allowed: true,
    validation_packet: { decision: 'PASS' },
    output_is_net_of_costs: true,
    artifact_contract_version: ALLOCATOR_EV_FUSION_CONTRACT.artifactContractVersion,
    feature_semantic_version: ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion,
    label_schema_version: ALLOCATOR_EV_FUSION_CONTRACT.labelSchemaVersion,
    model_version: 'fusion-v14-strict-test',
    policy_value_head_count: 1,
    policy_value_heads: ['residual_adjustment_model'],
    residual_adjustment_model: { coefficients: { l4_expected_return: 0.25 } },
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
candidateTimeS12.residual_adjustment_model.coefficients.s12_structure_ready = 1
const candidateTimeBlockers = evaluate(candidateTimeS12).blockers
assert(candidateTimeBlockers.includes('residual_adjustment_model_candidate_time_s12_feature_forbidden'))

const missingResidual = validFusion()
missingResidual.policy_value_head_count = 0
missingResidual.policy_value_heads = []
delete missingResidual.residual_adjustment_model
const missingResidualBlockers = evaluate(missingResidual).blockers
assert(missingResidualBlockers.includes('policy_value_head_count_not_one'))
assert(missingResidualBlockers.includes('policy_value_heads_incompatible'))
assert(missingResidualBlockers.includes('residual_adjustment_model_missing'))

console.log('Fusion v14 residual strict serving contract tests passed')
