import assert from 'node:assert/strict'
import {
  adaptExpectedReturnCandidate,
  adaptExpectedReturnShadow,
  type ExpectedReturnCandidateDbRow,
} from './expectedReturnMaturityEvidence'
import { ALLOCATOR_EV_FUSION_CONTRACT, L4_ALPHA_EV_CONTRACT } from './evidenceContracts'

function row(
  model_name: ExpectedReturnCandidateDbRow['model_name'],
  version: string,
  artifact: Record<string, unknown>,
): ExpectedReturnCandidateDbRow {
  return {
    model_name,
    artifact_id: `${model_name}:${version}`,
    version,
    candidate_type: model_name === 'l4_alpha_ev' ? 'l4_alpha_ev_refresh' : 'allocator_ev_fusion_refresh',
    training_run_id: 'active8_oof:weekly-20260809',
    state: 'offline_failed',
    source_run_date: '2026-08-08',
    offline_gate_decision: 'FAIL',
    offline_gate_failed_gates: JSON.stringify(['walk_forward_not_stable']),
    live_gate_status: 'not_started',
    updated_at: '2026-08-08T12:00:00Z',
    offline_evidence_json: JSON.stringify(artifact),
  }
}

const l4Version = 'l4-alpha-ev-ridge-v5-sector-20260808'
const l4 = adaptExpectedReturnCandidate(row('l4_alpha_ev', l4Version, {
  expected_return_owner: 'l4_alpha_ev',
  model_version: l4Version,
  artifact_contract_version: L4_ALPHA_EV_CONTRACT.artifactContractVersion,
  feature_semantic_version: L4_ALPHA_EV_CONTRACT.featureSemanticVersion,
  label_schema_version: L4_ALPHA_EV_CONTRACT.labelSchemaVersion,
  validation_packet: {
    schema_version: 'l4-alpha-ev-validation-packet-v1',
    decision: 'FAIL',
    failed_gates: ['walk_forward_not_stable'],
    sample_audit: {
      sample_count: 1000,
      date_count: 10,
      sector_alpha_available_count: 1000,
      sector_alpha_available_date_count: 10,
      oof_max_date: '2026-07-31',
    },
    validation_scope: {
      fit_min_samples: 1500,
      fit_min_dates: 20,
      min_sector_alpha_samples: 300,
      min_sector_alpha_dates: 8,
    },
    oos_metrics: {
      date_mean_cross_section_corr_lcb90: -0.2,
      date_mean_top_bottom_spread_lcb90: -0.04,
      top_quintile_mean_return: -0.03,
      date_mean_top_quintile_return_lcb90: -0.05,
    },
    walk_forward: { passed: false },
  },
}))
assert.equal(l4.identity_valid, true)
assert.equal(l4.sector_samples, 1000)
assert.equal(l4.fusion_oof_max_date, '2026-07-31')
assert.equal(l4.l4_corr_lcb90, -0.2)

const fusionVersion = 'allocator-ev-fusion-residual-v14-20260808'
const fusionArtifact = {
  expected_return_owner: 'allocator_ev_fusion',
  model_version: fusionVersion,
  artifact_contract_version: ALLOCATOR_EV_FUSION_CONTRACT.artifactContractVersion,
  feature_semantic_version: ALLOCATOR_EV_FUSION_CONTRACT.featureSemanticVersion,
  label_schema_version: ALLOCATOR_EV_FUSION_CONTRACT.labelSchemaVersion,
  validation_packet: {
    schema_version: 'allocator-ev-fusion-validation-packet-v14',
    decision: 'FAIL',
    failed_gates: ['residual_corr_lcb90_not_positive'],
    sample_audit: {
      sample_count: 1000,
      date_count: 10,
      l4_available_count: 1000,
      l4_available_date_count: 10,
      sector_alpha_available_count: 1000,
      sector_alpha_available_date_count: 10,
      oof_max_date: '2026-07-31',
    },
    promotion: {
      tier: 'shadow',
      primary_requirements: {
        min_samples: 1500,
        min_dates: 20,
        min_l4_point_in_time_samples: 300,
        min_l4_point_in_time_dates: 8,
      },
    },
    residual_adjustment_model: {
      oos_metrics: {
        prediction_target_corr_lcb90: -0.2001,
        top_bottom_spread_lcb90: -0.056756,
      },
      walk_forward: { passed: false },
    },
    selection_diagnostic_oos_metrics_not_served: {
      prediction_target_corr_lcb90: 0.05,
      top_bottom_spread_lcb90: 0.01,
    },
    selection_diagnostic_comparison_not_served: {
      corr_delta_lcb90: -0.01,
      spread_delta_lcb90: -0.02,
    },
    champion_comparison: {
      decision: 'FAIL',
      failed_gates: ['residual_adjustment_model_not_validated'],
      sample_count: 0,
      oos_date_count: 0,
    },
    shadow_diagnostics: {
      conditional_execution_return_model: { decision: 'FAIL' },
      execution_probability_model: { decision: 'PASS' },
    },
  },
}
const fusion = adaptExpectedReturnCandidate(row('allocator_ev_fusion', fusionVersion, fusionArtifact))
assert.equal(fusion.identity_valid, true)
assert.equal(fusion.residual_corr_lcb90, -0.2001)
assert.equal(fusion.residual_spread_lcb90, -0.056756)
assert.equal(fusion.selection_corr_lcb90, 0.05)
assert.equal(fusion.execution_decision, 'FAIL')
assert.equal(fusion.fusion_final_comparison_reason, 'residual_adjustment_model_not_validated')
assert.equal(fusion.identity_assurance, 'explicit_payload_v1')

const missingIdentityArtifact = { ...fusionArtifact } as Record<string, unknown>
delete missingIdentityArtifact.expected_return_owner
delete missingIdentityArtifact.model_version
const missingIdentity = adaptExpectedReturnCandidate({
  ...row('allocator_ev_fusion', fusionVersion, missingIdentityArtifact),
  candidate_type: 'allocator_ev_fusion_refresh',
  training_run_id: 'active8_oof:weekly-20260809',
  checksum: 'candidate-checksum',
})
assert.equal(missingIdentity.identity_valid, false)
assert(missingIdentity.identity_blockers.includes('candidate_artifact_owner_missing'))
assert(missingIdentity.identity_blockers.includes('candidate_payload_version_missing'))
assert(!missingIdentity.identity_blockers.includes('candidate_artifact_owner_mismatch'))
assert.equal(missingIdentity.residual_corr_lcb90, null)

const v2Artifact = {
  ...fusionArtifact,
  identity_schema_version: 'expected-return-candidate-identity-v2',
  artifact_checksum: 'candidate-checksum',
  cadence: 'weekly',
}
const v2 = adaptExpectedReturnCandidate({
  ...row('allocator_ev_fusion', fusionVersion, v2Artifact),
  candidate_type: 'allocator_ev_fusion_refresh',
  training_run_id: 'active8_oof:weekly-20260809',
  checksum: 'candidate-checksum',
})
assert.equal(v2.identity_valid, true)
assert.equal(v2.identity_assurance, 'explicit_payload_v2')
assert.equal(v2.cadence, 'weekly')
assert.equal(v2.fusion_oof_max_date, '2026-07-31')

const manualCadence = adaptExpectedReturnCandidate({
  ...row('allocator_ev_fusion', fusionVersion, { ...v2Artifact, cadence: 'manual' }),
  checksum: 'candidate-checksum',
})
assert.equal(manualCadence.cadence, 'manual')
const unknownCadence = adaptExpectedReturnCandidate({
  ...row('allocator_ev_fusion', fusionVersion, { ...v2Artifact, cadence: 'wekly' }),
  checksum: 'candidate-checksum',
})
assert.equal(unknownCadence.cadence, 'unknown')

const checksumMismatch = adaptExpectedReturnCandidate({
  ...row('allocator_ev_fusion', fusionVersion, v2Artifact),
  candidate_type: 'allocator_ev_fusion_refresh',
  training_run_id: 'active8_oof:weekly-20260809',
  checksum: 'different-checksum',
})
assert.equal(checksumMismatch.identity_valid, false)
assert(checksumMismatch.identity_blockers.includes('candidate_artifact_checksum_mismatch'))

const mismatched = adaptExpectedReturnCandidate({
  ...row('allocator_ev_fusion', fusionVersion, fusionArtifact),
  version: 'allocator-ev-fusion-two-head-v13-20260808',
})
assert.equal(mismatched.identity_valid, false)
assert(mismatched.identity_blockers.includes('candidate_artifact_id_version_mismatch'))
assert(mismatched.identity_blockers.includes('candidate_model_version_unsupported'))
assert.equal(mismatched.residual_corr_lcb90, null)

const wrongCandidateType = adaptExpectedReturnCandidate({
  ...row('allocator_ev_fusion', fusionVersion, fusionArtifact),
  candidate_type: 'l4_alpha_ev_refresh',
})
assert.equal(wrongCandidateType.identity_valid, false)
assert(wrongCandidateType.identity_blockers.includes('candidate_type_owner_mismatch'))
assert.equal(wrongCandidateType.residual_corr_lcb90, null)

const shadow = adaptExpectedReturnShadow({
  evaluation_id: 'fusion-shadow:2026-08-08',
  cohort_id: 'cohort-20260808',
  base_manifest_checksum: 'a'.repeat(64),
  extension_manifest_checksum: 'b'.repeat(64),
  artifact_path: 'universal/ev_shadow_evaluations/cohort-20260808/fusion.json',
  artifact_checksum: 'c'.repeat(64),
  business_date: '2026-08-08',
  model_name: 'allocator_ev_fusion',
  model_version: fusionVersion,
  oof_max_date: '2026-07-31',
  oof_date_count: 10,
  oof_row_count: 1000,
  quality_decision: 'FAIL',
  policy_decision: 'shadow_only',
  validation_packet_json: JSON.stringify(fusionArtifact.validation_packet),
  updated_at: '2026-08-08T12:30:00Z',
})
assert.equal(shadow.identity_valid, true)
assert.equal(shadow.sector_samples, 1000)
assert.equal(shadow.residual_corr_lcb90, -0.2001)
assert.equal(shadow.walk_forward_passed, false)

const wrongShadowSchema = adaptExpectedReturnShadow({
  evaluation_id: 'fusion-shadow:v13',
  cohort_id: 'cohort-20260808',
  base_manifest_checksum: 'a'.repeat(64),
  extension_manifest_checksum: 'b'.repeat(64),
  artifact_path: 'universal/ev_shadow_evaluations/cohort-20260808/fusion-v13.json',
  artifact_checksum: 'd'.repeat(64),
  business_date: '2026-08-08',
  model_name: 'allocator_ev_fusion',
  model_version: fusionVersion,
  oof_max_date: '2026-07-31',
  oof_date_count: 10,
  oof_row_count: 1000,
  quality_decision: 'FAIL',
  policy_decision: 'shadow_only',
  validation_packet_json: JSON.stringify({ ...fusionArtifact.validation_packet, schema_version: 'allocator-ev-fusion-validation-packet-v13' }),
  updated_at: '2026-08-08T12:30:00Z',
})
assert.equal(wrongShadowSchema.identity_valid, false)
assert.equal(wrongShadowSchema.residual_corr_lcb90, null)

console.log('expectedReturnMaturityEvidence tests passed')
