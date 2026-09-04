import assert from 'node:assert/strict'
import fs from 'node:fs'
import { ALLOCATOR_EV_FUSION_CONTRACT, L4_ALPHA_EV_CONTRACT } from './evidenceContracts'
import { buildExpectedReturnOwnerPromotionPlan } from './expectedReturnArtifactPromotion'

const cohortId = 'active8-oof-20260724'
const sourceRunDate = '2026-07-24'
const l4Checksum = 'a'.repeat(64)
const fusionChecksum = 'b'.repeat(64)
const l4Fingerprint = 'c'.repeat(64)
const fusionFingerprint = 'd'.repeat(64)
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

function offlineAdmission(sourceFailedGates: string[] = []) {
  return {
    schema_version: 'expected-return-offline-admission-v1',
    decision: 'PASS',
    hard_blockers: [],
    efficacy_findings: sourceFailedGates,
    source_failed_gates: sourceFailedGates,
    source_validation_decision: sourceFailedGates.length ? 'FAIL' : 'PASS',
  }
}

function l4Candidate() {
  const validation = { decision: 'PASS', failed_gates: [] }
  const version = 'l4-alpha-ev-ridge-v5-sector-20260724'
  return {
    artifact_id: `l4_alpha_ev:${version}:${l4Checksum}`,
    artifact: {
      expected_return_owner: 'l4_alpha_ev',
      artifact_contract_version: L4_ALPHA_EV_CONTRACT.artifactContractVersion,
      feature_semantic_version: L4_ALPHA_EV_CONTRACT.featureSemanticVersion,
      label_schema_version: L4_ALPHA_EV_CONTRACT.labelSchemaVersion,
      model_version: version,
      model_fingerprint: l4Fingerprint,
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
    offline_admission: offlineAdmission(),
    prospective_validation: {
      schema_version: 'expected-return-candidate-forward-gate-v2',
      decision: 'PASS',
      failed_gates: [],
      candidate_artifact_id: `l4_alpha_ev:${version}:${l4Checksum}`,
      candidate_artifact_checksum: l4Checksum,
      model_fingerprint: l4Fingerprint,
      source_run_date: sourceRunDate,
      artifact_trained_until: '2026-07-09',
      selection_semantic_floor_date: '2026-07-10',
      minimum_evaluable_dates: 10,
      evaluable_date_count: 10,
      prediction_date_min: '2026-07-10',
      prediction_date_max: '2026-07-23',
      label_known_date_min: '2026-07-27',
      label_known_date_max: '2026-08-07',
      corr_or_delta_lcb90: 0.01,
      spread_or_delta_lcb90: 0.005,
      top_return_lcb90: 0.004,
      training_dispatched: false,
    },
  }
}

function fusionCandidate(ownerParity = parity) {
  const validation = { decision: 'PASS', failed_gates: [] }
  const version = 'allocator-ev-fusion-residual-v14-20260724'
  return {
    artifact_id: `allocator_ev_fusion:${version}:${fusionChecksum}`,
    artifact: {
      expected_return_owner: 'allocator_ev_fusion',
      artifact_contract_version: ALLOCATOR_EV_FUSION_CONTRACT.artifactContractVersion,
      feature_semantic_version: ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion,
      label_schema_version: ALLOCATOR_EV_FUSION_CONTRACT.labelSchemaVersion,
      model_version: version,
      model_fingerprint: fusionFingerprint,
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
    offline_admission: offlineAdmission(),
    prospective_validation: {
      schema_version: 'expected-return-candidate-forward-gate-v2',
      decision: 'PASS',
      failed_gates: [],
      candidate_artifact_id: `allocator_ev_fusion:${version}:${fusionChecksum}`,
      candidate_artifact_checksum: fusionChecksum,
      model_fingerprint: fusionFingerprint,
      source_run_date: sourceRunDate,
      artifact_trained_until: '2026-07-09',
      selection_semantic_floor_date: '2026-07-10',
      minimum_evaluable_dates: 10,
      evaluable_date_count: 10,
      prediction_date_min: '2026-07-10',
      prediction_date_max: '2026-07-23',
      label_known_date_min: '2026-07-27',
      label_known_date_max: '2026-08-07',
      corr_or_delta_lcb90: 0,
      spread_or_delta_lcb90: 0,
      top_return_lcb90: 0.003,
      training_dispatched: false,
    },
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

const efficacyFinding = 'oos_date_cluster_corr_lcb90_not_positive'
const migratedL4 = l4Candidate()
migratedL4.validation_packet = { decision: 'FAIL', failed_gates: [efficacyFinding] }
migratedL4.artifact.validation_packet = migratedL4.validation_packet
migratedL4.offline_admission = offlineAdmission([efficacyFinding])
const migratedPlan = buildExpectedReturnOwnerPromotionPlan(staleConfig, 'l4_alpha_ev', migratedL4)
assert.equal(migratedPlan.eligible, true, 'legacy offline efficacy failure must enter prospective admission without bypassing hard blockers')

const hardFailedL4 = l4Candidate()
hardFailedL4.validation_packet = { decision: 'FAIL', failed_gates: ['insufficient_dates'] }
hardFailedL4.artifact.validation_packet = hardFailedL4.validation_packet
hardFailedL4.offline_admission = {
  ...offlineAdmission(['insufficient_dates']),
  decision: 'FAIL',
  hard_blockers: ['insufficient_dates'],
}
const hardFailedPlan = buildExpectedReturnOwnerPromotionPlan(staleConfig, 'l4_alpha_ev', hardFailedL4)
assert.equal(hardFailedPlan.eligible, false)
assert(hardFailedPlan.blockers.includes('offline_admission_not_pass'))

const unexplainedFailureL4 = l4Candidate()
unexplainedFailureL4.validation_packet = { decision: 'FAIL', failed_gates: [] }
unexplainedFailureL4.artifact.validation_packet = unexplainedFailureL4.validation_packet
unexplainedFailureL4.offline_admission = {
  ...offlineAdmission(),
  source_validation_decision: 'FAIL',
}
const unexplainedFailurePlan = buildExpectedReturnOwnerPromotionPlan(staleConfig, 'l4_alpha_ev', unexplainedFailureL4)
assert.equal(unexplainedFailurePlan.eligible, false)
assert(unexplainedFailurePlan.blockers.includes('offline_source_failure_without_failed_gates'))

const fiveDateFloorL4 = l4Candidate()
fiveDateFloorL4.prospective_validation.minimum_evaluable_dates = 5
fiveDateFloorL4.prospective_validation.evaluable_date_count = 5
const fiveDateFloorPlan = buildExpectedReturnOwnerPromotionPlan(staleConfig, 'l4_alpha_ev', fiveDateFloorL4)
assert.equal(fiveDateFloorPlan.eligible, false)
assert(fiveDateFloorPlan.blockers.includes('prospective_date_count_below_floor'))

const tamperedL4 = { ...l4Candidate(), artifact_checksum: 'c'.repeat(64) }
const tamperedPlan = buildExpectedReturnOwnerPromotionPlan(
  staleConfig,
  'l4_alpha_ev',
  tamperedL4,
)
assert.equal(tamperedPlan.eligible, false)
assert(tamperedPlan.blockers.includes('artifact_path_checksum_lineage_mismatch'))

const noProspectiveL4 = { ...l4Candidate(), prospective_validation: {} }
const noProspectivePlan = buildExpectedReturnOwnerPromotionPlan(
  staleConfig,
  'l4_alpha_ev',
  noProspectiveL4,
)
assert.equal(noProspectivePlan.eligible, false)
assert(noProspectivePlan.blockers.includes('prospective_validation_contract_incompatible'))

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
