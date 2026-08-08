import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ALLOCATOR_EV_FUSION_CONTRACT, L4_ALPHA_EV_CONTRACT } from './evidenceContracts'
import { buildExpectedReturnOwnerPromotionPlan } from './expectedReturnArtifactPromotion'

const cohortId = 'active8-oof-20260724'
const sourceRunDate = '2026-07-24'
const l4Checksum = 'a'.repeat(64)
const fusionChecksum = 'b'.repeat(64)
const parity = {
  schema_version: 'ev-operational-parity-v2',
  decision: 'FAIL',
  owner_decisions: {
    l4_alpha_ev: {
      decision: 'PASS',
      failed_gates: [],
      serving_coverage: 1,
    },
    allocator_ev_fusion: {
      decision: 'FAIL',
      failed_gates: ['fusion_serving_coverage_below_98pct'],
      serving_coverage: 0.5,
    },
  },
}

function l4Candidate() {
  const validation = { decision: 'PASS', failed_gates: [] }
  return {
    artifact: {
      expected_return_owner: 'l4_alpha_ev',
      artifact_contract_version: L4_ALPHA_EV_CONTRACT.artifactContractVersion,
      feature_semantic_version: L4_ALPHA_EV_CONTRACT.featureSemanticVersion,
      label_schema_version: L4_ALPHA_EV_CONTRACT.labelSchemaVersion,
      model_version: 'l4-alpha-ev-ridge-v5-sector-20260724',
      trained_until: '2026-07-09',
      output_is_net_of_costs: true,
      validation_packet: validation,
      training_data: { generation_mode: 'purged_oof', cohort_id: cohortId },
    },
    validation_packet: validation,
    operational_parity: parity,
    cohort_id: cohortId,
    source_run_date: sourceRunDate,
    artifact_path: `universal/ev_candidates/${cohortId}/l4_alpha_ev/${l4Checksum}.json`,
    artifact_checksum: l4Checksum,
  }
}

function fusionCandidate(ownerParity = parity) {
  const validation = { decision: 'PASS', failed_gates: [] }
  return {
    artifact: {
      expected_return_owner: 'allocator_ev_fusion',
      artifact_contract_version: ALLOCATOR_EV_FUSION_CONTRACT.artifactContractVersion,
      feature_semantic_version: ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion,
      label_schema_version: ALLOCATOR_EV_FUSION_CONTRACT.labelSchemaVersion,
      model_version: 'allocator-ev-fusion-residual-v14-20260724',
      policy_value_head_count: 1,
      policy_value_heads: ['residual_adjustment_model'],
      residual_adjustment_model: { coefficients: { l4_expected_return: 0.6 } },
      trained_until: '2026-07-09',
      output_is_net_of_costs: true,
      validation_packet: validation,
      training_data: { generation_mode: 'purged_oof', cohort_id: cohortId },
    },
    validation_packet: validation,
    operational_parity: ownerParity,
    cohort_id: cohortId,
    source_run_date: sourceRunDate,
    artifact_path: `universal/ev_candidates/${cohortId}/allocator_ev_fusion/${fusionChecksum}.json`,
    artifact_checksum: fusionChecksum,
  }
}

const staleConfig = {
  ensemble_v2: {
    l4AlphaEv: {
      expected_return_owner: 'l4_alpha_ev',
      promotion_state: 'production_approved',
      validation_packet: { decision: 'PASS' },
      model_version: 'l4-alpha-ev-ridge-20260702',
    },
  },
}

const l4Plan = buildExpectedReturnOwnerPromotionPlan(staleConfig, 'l4_alpha_ev', l4Candidate())
assert.equal(l4Plan.eligible, true)
assert.equal(l4Plan.serving_state.artifacts.l4_alpha_ev.eligible, true)
assert.equal(l4Plan.serving_state.expected_return_owner, 'l4_alpha_ev')

const tamperedL4 = { ...l4Candidate(), artifact_checksum: 'c'.repeat(64) }
const tamperedPlan = buildExpectedReturnOwnerPromotionPlan(
  staleConfig,
  'l4_alpha_ev',
  tamperedL4,
)
assert.equal(tamperedPlan.eligible, false)
assert(tamperedPlan.blockers.includes('artifact_path_checksum_lineage_mismatch'))

const fusionBlocked = buildExpectedReturnOwnerPromotionPlan(
  staleConfig,
  'allocator_ev_fusion',
  fusionCandidate(),
)
assert.equal(fusionBlocked.eligible, false)
assert(fusionBlocked.blockers.includes('owner_operational_parity_not_pass'))

const fullParity = {
  ...parity,
  decision: 'PASS',
  owner_decisions: {
    ...parity.owner_decisions,
    allocator_ev_fusion: {
      decision: 'PASS',
      failed_gates: [],
      serving_coverage: 1,
    },
  },
}
const fusionDependencyBlocked = buildExpectedReturnOwnerPromotionPlan(
  staleConfig,
  'allocator_ev_fusion',
  fusionCandidate(fullParity),
)
assert.equal(fusionDependencyBlocked.eligible, false)
assert(fusionDependencyBlocked.blockers.includes('fusion_requires_serving_compatible_l4'))
const fusionPlan = buildExpectedReturnOwnerPromotionPlan(
  l4Plan.next_config,
  'allocator_ev_fusion',
  fusionCandidate(fullParity),
)
assert.equal(fusionPlan.eligible, true)
assert.equal(fusionPlan.serving_state.expected_return_owner, 'allocator_ev_fusion')

const route = fs.readFileSync('src/routes/adminConfigCoreRoutes.ts', 'utf8')
const start = route.indexOf("adminConfigCoreRoutes.post('/api/admin/config/expected-return/promote'")
const end = route.indexOf("adminConfigCoreRoutes.post('/api/admin/config/push-defaults'", start)
const promotionRoute = route.slice(start, end)
assert(start >= 0)
assert(promotionRoute.includes('recordParameterCandidateEvidence'))
assert(promotionRoute.includes('validatePromotionPacketForProd'))
assert(promotionRoute.includes('markParameterCandidatePromoted'))
assert(!promotionRoute.includes('recordProductionOverride'))

console.log('expectedReturnArtifactPromotion tests passed')
