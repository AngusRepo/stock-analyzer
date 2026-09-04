import { resolveExpectedReturnServingState, type ExpectedReturnOwner } from './expectedReturnServingState'
import { EXPECTED_RETURN_PROSPECTIVE_MIN_DATES } from './expectedReturnServingRegistry'

type JsonRecord = Record<string, any>

export interface ExpectedReturnPromotionCandidate {
  artifact_id: string
  artifact: JsonRecord
  validation_packet: JsonRecord
  operational_parity: JsonRecord
  cohort_id: string
  source_run_date: string
  artifact_path: string
  artifact_checksum: string
  prospective_validation: JsonRecord
  offline_admission: JsonRecord
}

export interface ExpectedReturnOwnerPromotionPlan {
  owner: ExpectedReturnOwner
  eligible: boolean
  blockers: string[]
  candidate_id: string
  model_version: string | null
  serving_artifact: JsonRecord | null
  next_config: JsonRecord
  serving_state: ReturnType<typeof resolveExpectedReturnServingState>
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function decision(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

function cleanDate(value: unknown): string {
  return String(value ?? '').trim().slice(0, 10)
}

function cleanId(value: unknown): string {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9:._-]+/g, '_').slice(0, 180)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : []
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const OFFLINE_EFFICACY_FINDINGS: Record<ExpectedReturnOwner, Set<string>> = {
  l4_alpha_ev: new Set([
    'oos_date_cluster_corr_lcb90_not_positive',
    'oos_date_cluster_spread_lcb90_not_above_cost',
    'oos_top_quintile_return_not_positive',
    'oos_date_cluster_top_quintile_return_lcb90_not_positive',
    'walk_forward_not_stable',
  ]),
  allocator_ev_fusion: new Set([
    'residual_adjustment:oos_prediction_target_corr_lcb90_not_positive',
    'residual_adjustment:oos_top_bottom_spread_lcb90_not_economic',
    'residual_adjustment:walk_forward_not_stable',
    'residual_champion:residual_adjustment_model_not_validated',
  ]),
}

export function buildExpectedReturnOwnerPromotionPlan(
  currentConfig: JsonRecord,
  owner: ExpectedReturnOwner,
  candidate: ExpectedReturnPromotionCandidate,
): ExpectedReturnOwnerPromotionPlan {
  const artifact = recordValue(candidate.artifact)
  const validationPacket = recordValue(candidate.validation_packet)
  const artifactValidation = recordValue(artifact.validation_packet)
  const parity = recordValue(candidate.operational_parity)
  const ownerParity = recordValue(recordValue(parity.owner_decisions)[owner])
  const trainingData = recordValue(artifact.training_data)
  const cohortId = cleanId(candidate.cohort_id)
  const sourceRunDate = cleanDate(candidate.source_run_date)
  const modelVersion = String(artifact.model_version ?? '').trim()
  const artifactPath = String(candidate.artifact_path ?? '').trim()
  const artifactChecksum = String(candidate.artifact_checksum ?? '').trim().toLowerCase()
  const artifactId = String(candidate.artifact_id ?? '').trim()
  const artifactFingerprint = String(artifact.model_fingerprint ?? '').trim().toLowerCase()
  const prospective = recordValue(candidate.prospective_validation)
  const offlineAdmission = recordValue(candidate.offline_admission)
  const trainedUntil = cleanDate(artifact.trained_until)
  const blockers: string[] = []

  if (!cohortId) blockers.push('cohort_id_missing')
  if (!sourceRunDate) blockers.push('source_run_date_missing')
  if (!modelVersion) blockers.push('model_version_missing')
  if (!/^[a-f0-9]{64}$/.test(artifactChecksum)) blockers.push('artifact_checksum_invalid')
  if (!/^[a-f0-9]{64}$/.test(artifactFingerprint)) blockers.push('model_fingerprint_invalid')
  if (artifactId !== `${owner}:${modelVersion}:${artifactChecksum}`) {
    blockers.push('artifact_id_checksum_lineage_mismatch')
  }
  const expectedArtifactPrefix = `universal/ev_candidates/${cohortId}/${owner}/`
  if (
    !artifactPath.startsWith(expectedArtifactPrefix)
    || !artifactPath.endsWith(`/${artifactChecksum}.json`)
  ) {
    blockers.push('artifact_path_checksum_lineage_mismatch')
  }
  if (artifact.expected_return_owner !== owner) blockers.push('expected_return_owner_mismatch')
  const sourceValidationGates = stringArray(validationPacket.failed_gates)
  const artifactValidationGates = stringArray(artifactValidation.failed_gates)
  const admissionSourceGates = stringArray(offlineAdmission.source_failed_gates)
  const sourceValidationDecision = decision(validationPacket.decision)
  const artifactValidationDecision = decision(artifactValidation.decision)
  const admissionSourceDecision = decision(offlineAdmission.source_validation_decision)
  if (offlineAdmission.schema_version !== 'expected-return-offline-admission-v1') blockers.push('offline_admission_contract_incompatible')
  if (decision(offlineAdmission.decision) !== 'PASS') blockers.push('offline_admission_not_pass')
  if (stringArray(offlineAdmission.hard_blockers).length > 0) blockers.push('offline_admission_has_hard_blockers')
  if (JSON.stringify([...sourceValidationGates].sort()) !== JSON.stringify([...artifactValidationGates].sort())) {
    blockers.push('offline_validation_artifact_mismatch')
  }
  if (sourceValidationDecision !== artifactValidationDecision) blockers.push('offline_validation_artifact_decision_mismatch')
  if (sourceValidationDecision !== admissionSourceDecision) blockers.push('offline_admission_source_decision_mismatch')
  if (!['PASS', 'FAIL'].includes(sourceValidationDecision)) blockers.push('offline_source_validation_not_terminal')
  if (sourceValidationDecision === 'PASS' && sourceValidationGates.length > 0) blockers.push('offline_source_pass_with_failed_gates')
  if (sourceValidationDecision === 'FAIL' && sourceValidationGates.length === 0) blockers.push('offline_source_failure_without_failed_gates')
  if (JSON.stringify([...sourceValidationGates].sort()) !== JSON.stringify([...admissionSourceGates].sort())) {
    blockers.push('offline_admission_source_mismatch')
  }
  if (sourceValidationGates.some((gate) => !OFFLINE_EFFICACY_FINDINGS[owner].has(gate))) {
    blockers.push('offline_admission_contains_non_efficacy_failure')
  }
  if (parity.schema_version !== 'ev-operational-parity-v2') blockers.push('owner_parity_contract_incompatible')
  if (decision(ownerParity.decision) !== 'PASS') blockers.push('owner_operational_parity_not_pass')
  if (stringArray(ownerParity.failed_gates).length > 0) blockers.push('owner_operational_parity_has_failed_gates')
  if (trainingData.generation_mode !== 'purged_oof') blockers.push('promotion_requires_purged_oof')
  if (cleanId(trainingData.cohort_id) !== cohortId) blockers.push('cohort_lineage_mismatch')
  if (!trainedUntil || (sourceRunDate && trainedUntil > sourceRunDate)) blockers.push('trained_until_after_source_run_date')
  if (artifact.output_is_net_of_costs !== true) blockers.push('expected_return_not_net_of_costs')
  if (prospective.schema_version !== 'expected-return-candidate-forward-gate-v2') {
    blockers.push('prospective_validation_contract_incompatible')
  }
  if (decision(prospective.decision) !== 'PASS') blockers.push('prospective_validation_not_pass')
  if (stringArray(prospective.failed_gates).length > 0) blockers.push('prospective_validation_has_failed_gates')
  if (prospective.candidate_artifact_id !== artifactId) blockers.push('prospective_candidate_artifact_mismatch')
  if (String(prospective.candidate_artifact_checksum ?? '').toLowerCase() !== artifactChecksum) {
    blockers.push('prospective_candidate_checksum_mismatch')
  }
  if (String(prospective.model_fingerprint ?? '').toLowerCase() !== artifactFingerprint) {
    blockers.push('prospective_model_fingerprint_mismatch')
  }
  if (cleanDate(prospective.source_run_date) !== sourceRunDate) blockers.push('prospective_source_run_date_mismatch')
  const prospectiveDates = Number(prospective.evaluable_date_count ?? 0)
  const minimumProspectiveDates = Number(prospective.minimum_evaluable_dates ?? 0)
  const prospectiveMinDate = cleanDate(prospective.prediction_date_min)
  const prospectiveMaxDate = cleanDate(prospective.prediction_date_max)
  const prospectiveLabelKnownMin = cleanDate(prospective.label_known_date_min)
  const prospectiveLabelKnownMax = cleanDate(prospective.label_known_date_max)
  const prospectiveTrainedUntil = cleanDate(prospective.artifact_trained_until)
  const selectionSemanticFloorDate = cleanDate(prospective.selection_semantic_floor_date)
  if (
    !Number.isInteger(prospectiveDates)
    || !Number.isInteger(minimumProspectiveDates)
    || minimumProspectiveDates !== EXPECTED_RETURN_PROSPECTIVE_MIN_DATES
    || prospectiveDates < minimumProspectiveDates
  ) blockers.push('prospective_date_count_below_floor')
  if (!prospectiveTrainedUntil || prospectiveTrainedUntil !== trainedUntil) blockers.push('prospective_trained_until_mismatch')
  if (!prospectiveMinDate || prospectiveMinDate <= trainedUntil) blockers.push('prediction_not_after_candidate_trained_until')
  if (!selectionSemanticFloorDate) blockers.push('selection_semantic_floor_missing')
  if (selectionSemanticFloorDate && prospectiveMinDate && prospectiveMinDate < selectionSemanticFloorDate) {
    blockers.push('prediction_before_selection_semantic_floor')
  }
  if (!prospectiveMaxDate || prospectiveMaxDate < prospectiveMinDate) blockers.push('prospective_prediction_range_invalid')
  if (!prospectiveLabelKnownMin || prospectiveLabelKnownMin <= sourceRunDate) blockers.push('label_known_not_after_candidate_freeze')
  if (!prospectiveLabelKnownMax || prospectiveLabelKnownMax < prospectiveLabelKnownMin) blockers.push('prospective_label_known_range_invalid')
  if (prospective.training_dispatched !== false) blockers.push('prospective_validation_dispatched_training')
  const corrOrDeltaLcb = finiteNumber(prospective.corr_or_delta_lcb90)
  const spreadOrDeltaLcb = finiteNumber(prospective.spread_or_delta_lcb90)
  const topReturnLcb = finiteNumber(prospective.top_return_lcb90)
  if (topReturnLcb == null || topReturnLcb <= 0) blockers.push('prospective_top_return_lcb90_not_positive')
  if (
    corrOrDeltaLcb == null
    || (owner === 'l4_alpha_ev' ? corrOrDeltaLcb <= 0 : corrOrDeltaLcb < 0)
  ) blockers.push('prospective_corr_or_delta_lcb90_not_pass')
  if (
    spreadOrDeltaLcb == null
    || (owner === 'l4_alpha_ev' ? spreadOrDeltaLcb <= 0 : spreadOrDeltaLcb < 0)
  ) blockers.push('prospective_spread_or_delta_lcb90_not_pass')

  const admittedValidationPacket = {
    ...validationPacket,
    decision: 'PASS',
    failed_gates: [],
    offline_admission: offlineAdmission,
    offline_efficacy_findings: sourceValidationGates,
  }
  const servingArtifact = blockers.length === 0
    ? {
      ...artifact,
      validation_packet: admittedValidationPacket,
      operational_parity: parity,
      prospective_validation: prospective,
      promotion_state: owner === 'l4_alpha_ev' ? 'production_approved' : 'production_primary',
      approval_state: owner === 'l4_alpha_ev' ? 'production_approved' : artifact.approval_state,
      promotion_tier: owner === 'allocator_ev_fusion' ? 'primary' : artifact.promotion_tier,
      primary_expected_return_allowed: owner === 'allocator_ev_fusion'
        ? true
        : artifact.primary_expected_return_allowed,
      operational_parity_required: false,
    }
    : null

  const ensemble = recordValue(currentConfig.ensemble_v2)
  const nextEnsemble = { ...ensemble }
  if (servingArtifact) {
    if (owner === 'l4_alpha_ev') {
      nextEnsemble.l4AlphaEv = servingArtifact
      nextEnsemble.l4_alpha_ev = servingArtifact
    } else {
      nextEnsemble.allocatorEvFusion = servingArtifact
      nextEnsemble.allocator_ev_fusion = servingArtifact
    }
  }
  const nextConfig = { ...currentConfig, ensemble_v2: nextEnsemble }
  const servingState = resolveExpectedReturnServingState(nextConfig, { runDate: sourceRunDate })
  const ownerState = servingState.artifacts[owner]
  if (servingArtifact && !ownerState.eligible) {
    blockers.push(...ownerState.blockers.map((blocker) => `serving_contract:${blocker}`))
  }
  if (
    owner === 'allocator_ev_fusion'
    && servingArtifact
    && !servingState.artifacts.l4_alpha_ev.eligible
  ) {
    blockers.push('fusion_requires_serving_compatible_l4')
  }

  const uniqueBlockers = [...new Set(blockers)]
  return {
    owner,
    eligible: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    candidate_id: cleanId(
      `parameter:expected_return:${owner}:${cohortId || 'unknown'}:${modelVersion || 'unknown'}:${artifactChecksum.slice(0, 16) || 'unknown'}`,
    ),
    model_version: modelVersion || null,
    serving_artifact: uniqueBlockers.length === 0 ? servingArtifact : null,
    next_config: uniqueBlockers.length === 0 ? nextConfig : currentConfig,
    serving_state: servingState,
  }
}
