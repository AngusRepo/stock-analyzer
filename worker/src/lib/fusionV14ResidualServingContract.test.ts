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
    model_version: 'allocator-ev-fusion-residual-v14-strict-test',
    policy_value_head_count: 1,
    policy_value_heads: ['residual_adjustment_model'],
    residual_adjustment_model: { coefficients: { l4_expected_return: 0.6 } },
  }
}

function evaluate(candidate: Record<string, any>) {
  return resolveExpectedReturnServingState({
    ensemble_v2: { allocatorEvFusion: candidate },
  }).artifacts.allocator_ev_fusion
}

assert.equal(evaluate(validFusion()).artifact_state, 'serving')

const legacyHeads = validFusion()
legacyHeads.execution_probability_model = { coefficients: { l4_available: 0.4 } }
legacyHeads.conditional_execution_return_model = { coefficients: { l4_expected_return: 0.6 } }
assert(evaluate(legacyHeads).blockers.includes('legacy_serving_head_forbidden'))

const candidateTimeS12 = validFusion()
candidateTimeS12.residual_adjustment_model.coefficients.s12_structure_ready = 1
assert(evaluate(candidateTimeS12).blockers.includes('residual_adjustment_model_candidate_time_s12_feature_forbidden'))

const twoHeads = validFusion()
twoHeads.policy_value_head_count = 2
twoHeads.policy_value_heads = ['residual_adjustment_model', 'execution_probability_model']
const twoHeadBlockers = evaluate(twoHeads).blockers
assert(twoHeadBlockers.includes('policy_value_head_count_not_one'))
assert(twoHeadBlockers.includes('policy_value_heads_incompatible'))

const noL4Feature = validFusion()
noL4Feature.residual_adjustment_model.coefficients = { market_return_5d: 0.5 }
assert(evaluate(noL4Feature).blockers.includes('residual_adjustment_model_l4_feature_missing'))

console.log('Fusion v14 residual serving contract tests passed')
