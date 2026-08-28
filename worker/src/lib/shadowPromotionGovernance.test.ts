import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  SHADOW_PROMOTION_GOVERNANCE,
  assertAutomaticPromotionAllowed,
} from './shadowPromotionGovernance'

for (const policy of Object.values(SHADOW_PROMOTION_GOVERNANCE)) {
  assert.equal(policy.realOrderEffect, false)
  assert.equal(policy.realtimeMutation, false)
  if (policy.canAutoPromote) {
    assert.equal(policy.mode, 'automatic_evidence_gated')
    assert.equal(policy.rollbackRequired, true)
    assert.notEqual(policy.target, 'none')
  }
}

assert.doesNotThrow(() => assertAutomaticPromotionAllowed('paper_kelly', 'paper_position_cap'))
assert.doesNotThrow(() => assertAutomaticPromotionAllowed('s12_profit_continuation', 'paper_exit_policy'))
assert.doesNotThrow(() => assertAutomaticPromotionAllowed('multi_horizon_evidence', 'decision_artifact'))
assert.throws(() => assertAutomaticPromotionAllowed('state_space_overlay', 'decision_artifact'))
assert.throws(() => assertAutomaticPromotionAllowed('execution_parity', 'paper_position_cap'))

const weekly = fs.readFileSync('src/lib/durableSchedulerTask.ts', 'utf8')
const postMarket = fs.readFileSync('src/lib/postMarketChain.ts', 'utf8')
const active8 = fs.readFileSync('../ml-controller/services/model_artifact_registry.py', 'utf8')
const meta = fs.readFileSync('src/lib/adaptiveMetaPolicyController.ts', 'utf8')
const stateSpace = fs.readFileSync('../ml-service/app/state_space_universal.py', 'utf8')
const rfs = fs.readFileSync('../ml-controller/tests/test_allocator_direction_authority.py', 'utf8')

assert.match(weekly, /assertAutomaticPromotionAllowed\('paper_kelly', 'paper_position_cap'\)/)
assert.match(postMarket, /assertAutomaticPromotionAllowed\('multi_horizon_evidence', 'decision_artifact'\)/)
assert.match(active8, /active8-ensemble-atomic-promotion-evidence-v1/)
assert.match(active8, /active8_ensemble_pointer_v1/)
assert.match(meta, /CANARY_CAP/)
assert.match(meta, /ownsServingPolicy ?\? 'rollback' : 'reject'/)
assert.match(stateSpace, /do not enter alpha IC, challenger shadow, or promotion lifecycle/)
assert.match(rfs, /production_effect.*is False/)
