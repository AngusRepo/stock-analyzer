import {
  ALLOCATOR_EV_FUSION_CONTRACT,
  L4_ALPHA_EV_CONTRACT,
} from './evidenceContracts'

export type ExpectedReturnMaturityModel = 'l4_alpha_ev' | 'allocator_ev_fusion'

export type WalkForwardFoldEvidence = {
  fold: number | null
  train_start_date: string | null
  train_end_date: string | null
  test_start_date: string | null
  test_end_date: string | null
  correlation: number | null
  spread: number | null
  passed: boolean | null
}

export type WalkForwardEvidence = {
  reason: string | null
  fold_count: number | null
  positive_corr_folds: number | null
  positive_spread_folds: number | null
  required_positive_folds: number | null
  folds: WalkForwardFoldEvidence[]
}

export interface ExpectedReturnCandidateDbRow {
  model_name: ExpectedReturnMaturityModel
  artifact_id: string | null
  version: string | null
  candidate_type?: string | null
  training_run_id?: string | null
  checksum?: string | null
  artifact_path?: string | null
  state: string | null
  source_run_date: string | null
  offline_gate_decision: string | null
  offline_gate_failed_gates: string | null
  live_gate_status: string | null
  updated_at: string | null
  offline_evidence_json: string | null
}

export interface ExpectedReturnCandidateEvidence {
  model_name: ExpectedReturnMaturityModel
  artifact_id: string | null
  artifact_path: string | null
  checksum: string | null
  version: string | null
  state: string | null
  source_run_date: string | null
  updated_at: string | null
  offline_gate_decision: string | null
  live_gate_status: string | null
  artifact_contract_version: string | null
  validation_schema_version: string | null
  cadence: 'daily' | 'weekly' | 'monthly' | 'manual' | 'event-driven' | 'unknown'
  identity_schema_version: string | null
  identity_assurance: 'content_addressed_v3' | 'explicit_payload_v2' | 'explicit_payload_v1' | 'invalid'
  identity_valid: boolean
  identity_blockers: string[]
  offline_gate_failed_gates: string[]
  sample_count: number | null
  date_count: number | null
  fit_min_samples: number | null
  fit_min_dates: number | null
  sector_samples: number | null
  sector_dates: number | null
  min_sector_samples: number | null
  min_sector_dates: number | null
  l4_samples: number | null
  l4_dates: number | null
  structure_samples: number | null
  structure_dates: number | null
  execution_samples: number | null
  execution_dates: number | null
  market_samples: number | null
  market_dates: number | null
  min_primary_samples: number | null
  min_primary_dates: number | null
  min_l4_samples: number | null
  min_l4_dates: number | null
  min_structure_samples: number | null
  min_structure_dates: number | null
  min_execution_samples: number | null
  min_execution_dates: number | null
  min_market_samples: number | null
  min_market_dates: number | null
  l4_corr_lcb90: number | null
  l4_spread_lcb90: number | null
  l4_top_return: number | null
  l4_top_lcb90: number | null
  selection_corr_lcb90: number | null
  selection_spread_lcb90: number | null
  fusion_corr_delta_lcb90: number | null
  fusion_spread_delta_lcb90: number | null
  residual_corr_lcb90: number | null
  residual_spread_lcb90: number | null
  fusion_top_trade_ev_lcb90: number | null
  fusion_oof_max_date: string | null
  mature_outcome_max_date: string | null
  fusion_final_comparison_decision: string | null
  fusion_final_comparison_samples: number | null
  fusion_final_comparison_dates: number | null
  fusion_final_comparison_reason: string | null
  walk_forward_passed: boolean | null
  walk_forward: WalkForwardEvidence | null
  execution_decision: string | null
  execution_probability_decision: string | null
  promotion_tier: string | null
}

export interface ExpectedReturnShadowDbRow {
  evaluation_id: string
  identity_schema_version: string
  subject_artifact_checksum: string | null
  evaluator_contract_checksum: string | null
  cohort_id: string
  base_manifest_checksum: string
  extension_manifest_checksum: string
  artifact_path: string
  artifact_checksum: string
  business_date: string
  model_name: ExpectedReturnMaturityModel
  model_version: string
  oof_min_date: string
  oof_max_date: string
  oof_date_count: number | string
  oof_row_count: number | string
  quality_decision: string
  policy_decision: string
  validation_packet_json: string
  updated_at: string | null
  previous_business_date?: string | null
  previous_cohort_id?: string | null
  previous_base_manifest_checksum?: string | null
  previous_evaluator_contract_checksum?: string | null
  previous_oof_max_date?: string | null
  previous_oof_date_count?: number | string | null
  previous_oof_row_count?: number | string | null
  previous_sample_count?: number | string | null
  previous_date_count?: number | string | null
}

export interface ExpectedReturnShadowEvidence {
  evaluation_id: string
  cohort_id: string
  identity_schema_version: string
  subject_artifact_checksum: string | null
  evaluator_contract_checksum: string | null
  base_manifest_checksum: string
  extension_manifest_checksum: string
  artifact_path: string
  artifact_checksum: string
  business_date: string
  model_name: ExpectedReturnMaturityModel
  model_version: string
  oof_min_date: string
  oof_max_date: string
  oof_date_count: number
  oof_row_count: number
  quality_decision: string
  policy_decision: string
  updated_at: string | null
  validation_schema_version: string | null
  identity_valid: boolean
  identity_blockers: string[]
  failed_gates: string[]
  sample_count: number | null
  date_count: number | null
  sector_samples: number | null
  sector_dates: number | null
  l4_corr_lcb90: number | null
  l4_spread_lcb90: number | null
  l4_top_return: number | null
  l4_top_lcb90: number | null
  selection_corr_lcb90: number | null
  selection_spread_lcb90: number | null
  residual_corr_lcb90: number | null
  residual_spread_lcb90: number | null
  walk_forward_passed: boolean | null
  walk_forward: WalkForwardEvidence | null
  execution_decision: string | null
  execution_probability_decision: string | null
  previous_business_date: string | null
  evidence_comparable_to_previous_business_date: boolean | null
  evidence_advanced_from_previous_business_date: boolean | null
}

type JsonRecord = Record<string, any>

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function parseRecord(value: unknown): JsonRecord {
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    return record(JSON.parse(value))
  } catch {
    return {}
  }
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stringOrNull(value: unknown): string | null {
  const parsed = String(value ?? '').trim()
  return parsed || null
}

function boolOrNull(value: unknown): boolean | null {
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  return null
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item ?? '').trim()).filter(Boolean)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => String(item ?? '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function adaptWalkForward(value: unknown): WalkForwardEvidence | null {
  const raw = record(value)
  if (!Object.keys(raw).length) return null
  const folds = (Array.isArray(raw.folds) ? raw.folds : []).map((value): WalkForwardFoldEvidence => {
    const fold = record(value)
    const correlation = finiteOrNull(fold.date_mean_cross_section_corr ?? fold.prediction_target_corr)
    const spread = finiteOrNull(fold.date_mean_top_bottom_spread ?? fold.top_bottom_spread)
    return {
      fold: finiteOrNull(fold.fold),
      train_start_date: stringOrNull(fold.train_start_date),
      train_end_date: stringOrNull(fold.train_end_date),
      test_start_date: stringOrNull(fold.test_start_date),
      test_end_date: stringOrNull(fold.test_end_date),
      correlation,
      spread,
      passed: correlation == null || spread == null ? null : correlation > 0 && spread > 0,
    }
  })
  return {
    reason: stringOrNull(raw.reason),
    fold_count: finiteOrNull(raw.fold_count) ?? folds.length,
    positive_corr_folds: finiteOrNull(raw.positive_corr_folds),
    positive_spread_folds: finiteOrNull(raw.positive_spread_folds),
    required_positive_folds: finiteOrNull(raw.required_positive_folds),
    folds,
  }
}

function expectedIdentity(model: ExpectedReturnMaturityModel) {
  return model === 'l4_alpha_ev'
    ? {
      contract: L4_ALPHA_EV_CONTRACT,
      validationSchema: L4_ALPHA_EV_CONTRACT.validationSchemaVersion,
      modelVersionPrefix: L4_ALPHA_EV_CONTRACT.modelVersionPrefix,
      candidateType: 'l4_alpha_ev_refresh',
    }
    : {
      contract: ALLOCATOR_EV_FUSION_CONTRACT,
      validationSchema: ALLOCATOR_EV_FUSION_CONTRACT.validationSchemaVersion,
      modelVersionPrefix: ALLOCATOR_EV_FUSION_CONTRACT.modelVersionPrefix,
      candidateType: 'allocator_ev_fusion_refresh',
    }
}

function candidateCadence(artifact: JsonRecord): ExpectedReturnCandidateEvidence['cadence'] {
  const cadence = stringOrNull(artifact.cadence)
  return cadence === 'daily' || cadence === 'weekly' || cadence === 'monthly'
    || cadence === 'manual' || cadence === 'event-driven'
    ? cadence
    : 'unknown'
}

function candidateIdentityBlockers(row: ExpectedReturnCandidateDbRow, artifact: JsonRecord, packet: JsonRecord): string[] {
  const expected = expectedIdentity(row.model_name)
  const blockers: string[] = []
  const identitySchema = stringOrNull(artifact.identity_schema_version)
  const payloadChecksum = stringOrNull(artifact.artifact_checksum)
  const registryChecksum = stringOrNull(row.checksum)
  if (!row.artifact_id || !row.version) blockers.push('candidate_registry_identity_missing')
  if (row.candidate_type !== expected.candidateType) blockers.push('candidate_type_owner_mismatch')
  const payloadOwner = stringOrNull(artifact.expected_return_owner)
  const payloadVersion = stringOrNull(artifact.model_version)
  if (!payloadOwner) blockers.push('candidate_artifact_owner_missing')
  else if (payloadOwner !== row.model_name) blockers.push('candidate_artifact_owner_mismatch')
  if (!payloadVersion) blockers.push('candidate_payload_version_missing')
  else if (payloadVersion !== row.version) blockers.push('candidate_payload_version_mismatch')
  if (identitySchema === 'expected-return-candidate-identity-v3') {
    if (!payloadChecksum || !registryChecksum) {
      blockers.push('candidate_artifact_checksum_missing')
    } else {
      if (!/^[0-9a-f]{64}$/.test(payloadChecksum) || !/^[0-9a-f]{64}$/.test(registryChecksum)) {
        blockers.push('candidate_artifact_checksum_invalid')
      }
      if (payloadChecksum !== registryChecksum) blockers.push('candidate_artifact_checksum_mismatch')
      if (row.artifact_id !== `${row.model_name}:${row.version}:${registryChecksum}`) {
        blockers.push('candidate_artifact_id_checksum_mismatch')
      }
      if (!String(row.artifact_path ?? '').endsWith(`/${registryChecksum}.json`)) {
        blockers.push('candidate_artifact_path_checksum_mismatch')
      }
    }
  } else if (identitySchema === 'expected-return-candidate-identity-v2') {
    if (row.artifact_id !== `${row.model_name}:${row.version}`) {
      blockers.push('candidate_artifact_id_version_mismatch')
    }
    if (!payloadChecksum || !registryChecksum) blockers.push('candidate_artifact_checksum_missing')
    else if (payloadChecksum !== registryChecksum) blockers.push('candidate_artifact_checksum_mismatch')
  } else if (identitySchema === 'expected-return-candidate-identity-v1') {
    if (row.artifact_id !== `${row.model_name}:${row.version}`) {
      blockers.push('candidate_artifact_id_version_mismatch')
    }
  } else {
    blockers.push('candidate_identity_schema_incompatible')
  }
  if (!String(row.version ?? '').startsWith(expected.modelVersionPrefix)) blockers.push('candidate_model_version_unsupported')
  if (artifact.artifact_contract_version !== expected.contract.artifactContractVersion) blockers.push('candidate_contract_version_incompatible')
  if (artifact.feature_semantic_version !== expected.contract.featureSemanticVersion) blockers.push('candidate_feature_semantic_incompatible')
  if (artifact.label_schema_version !== expected.contract.labelSchemaVersion) blockers.push('candidate_label_schema_incompatible')
  if (packet.schema_version !== expected.validationSchema) blockers.push('candidate_validation_schema_incompatible')
  if (String(packet.decision ?? '').toUpperCase() !== String(row.offline_gate_decision ?? '').toUpperCase()) {
    blockers.push('candidate_registry_validation_decision_mismatch')
  }
  return blockers
}

export function adaptExpectedReturnCandidate(row: ExpectedReturnCandidateDbRow): ExpectedReturnCandidateEvidence {
  const artifact = parseRecord(row.offline_evidence_json)
  const packet = record(artifact.validation_packet)
  const identityBlockers = candidateIdentityBlockers(row, artifact, packet)
  const trusted = identityBlockers.length === 0
  const trustedPacket = trusted ? packet : {}
  const sampleAudit = record(trustedPacket.sample_audit)
  const validationScope = record(trustedPacket.validation_scope)
  const promotion = record(trustedPacket.promotion)
  const primaryRequirements = record(promotion.primary_requirements)
  const oos = record(trustedPacket.oos_metrics)
  const walkForward = row.model_name === 'l4_alpha_ev'
    ? record(trustedPacket.walk_forward)
    : record(record(trustedPacket.residual_adjustment_model).walk_forward)
  const residual = record(trustedPacket.residual_adjustment_model)
  const residualOos = record(residual.oos_metrics)
  const selectionOos = record(trustedPacket.selection_diagnostic_oos_metrics_not_served)
  const selectionComparison = record(trustedPacket.selection_diagnostic_comparison_not_served)
  const championComparison = record(trustedPacket.champion_comparison)
  const championFailed = stringArray(championComparison.failed_gates)
  const pairedSamples = finiteOrNull(championComparison.sample_count ?? championComparison.samples)
  const shadowDiagnostics = record(trustedPacket.shadow_diagnostics)
  const executionModel = record(shadowDiagnostics.conditional_execution_return_model)
  const executionProbabilityModel = record(shadowDiagnostics.execution_probability_model)

  return {
    model_name: row.model_name,
    artifact_id: row.artifact_id,
    version: row.version,
    state: row.state,
    artifact_path: stringOrNull(row.artifact_path),
    checksum: stringOrNull(row.checksum),
    source_run_date: row.source_run_date,
    updated_at: row.updated_at,
    offline_gate_decision: row.offline_gate_decision,
    live_gate_status: row.live_gate_status,
    artifact_contract_version: stringOrNull(artifact.artifact_contract_version),
    validation_schema_version: stringOrNull(packet.schema_version),
    cadence: candidateCadence(artifact),
    identity_schema_version: stringOrNull(artifact.identity_schema_version),
    identity_assurance: identityBlockers.length
      ? 'invalid'
      : artifact.identity_schema_version === 'expected-return-candidate-identity-v3'
        ? 'content_addressed_v3'
        : artifact.identity_schema_version === 'expected-return-candidate-identity-v2'
          ? 'explicit_payload_v2'
          : 'explicit_payload_v1',
    identity_valid: trusted,
    identity_blockers: identityBlockers,
    offline_gate_failed_gates: [...new Set([...stringArray(row.offline_gate_failed_gates), ...identityBlockers])],
    sample_count: finiteOrNull(sampleAudit.sample_count),
    date_count: finiteOrNull(sampleAudit.date_count),
    fit_min_samples: finiteOrNull(validationScope.fit_min_samples),
    fit_min_dates: finiteOrNull(validationScope.fit_min_dates),
    sector_samples: finiteOrNull(sampleAudit.sector_alpha_available_count),
    sector_dates: finiteOrNull(sampleAudit.sector_alpha_available_date_count),
    min_sector_samples: finiteOrNull(validationScope.min_sector_alpha_samples),
    min_sector_dates: finiteOrNull(validationScope.min_sector_alpha_dates),
    l4_samples: finiteOrNull(sampleAudit.l4_available_count),
    l4_dates: finiteOrNull(sampleAudit.l4_available_date_count),
    structure_samples: finiteOrNull(sampleAudit.s12_structure_available_count),
    structure_dates: finiteOrNull(sampleAudit.s12_structure_available_date_count),
    execution_samples: finiteOrNull(sampleAudit.execution_sample_count),
    execution_dates: finiteOrNull(sampleAudit.execution_date_count),
    market_samples: finiteOrNull(sampleAudit.market_context_available_count),
    market_dates: finiteOrNull(sampleAudit.market_context_available_date_count),
    min_primary_samples: finiteOrNull(primaryRequirements.min_samples),
    min_primary_dates: finiteOrNull(primaryRequirements.min_dates),
    min_l4_samples: finiteOrNull(primaryRequirements.min_l4_point_in_time_samples),
    min_l4_dates: finiteOrNull(primaryRequirements.min_l4_point_in_time_dates),
    min_structure_samples: finiteOrNull(primaryRequirements.min_s12_structure_samples),
    min_structure_dates: finiteOrNull(primaryRequirements.min_s12_structure_dates),
    min_execution_samples: finiteOrNull(primaryRequirements.min_execution_samples),
    min_execution_dates: finiteOrNull(primaryRequirements.min_execution_dates),
    min_market_samples: finiteOrNull(primaryRequirements.min_market_context_samples),
    min_market_dates: finiteOrNull(primaryRequirements.min_market_context_dates),
    l4_corr_lcb90: finiteOrNull(oos.date_mean_cross_section_corr_lcb90),
    l4_spread_lcb90: finiteOrNull(oos.date_mean_top_bottom_spread_lcb90),
    l4_top_return: finiteOrNull(oos.top_quintile_mean_return),
    l4_top_lcb90: finiteOrNull(oos.date_mean_top_quintile_return_lcb90),
    selection_corr_lcb90: finiteOrNull(selectionOos.prediction_target_corr_lcb90),
    selection_spread_lcb90: finiteOrNull(selectionOos.top_bottom_spread_lcb90),
    fusion_corr_delta_lcb90: finiteOrNull(selectionComparison.corr_delta_lcb90),
    fusion_spread_delta_lcb90: finiteOrNull(selectionComparison.spread_delta_lcb90),
    residual_corr_lcb90: finiteOrNull(residualOos.prediction_target_corr_lcb90),
    residual_spread_lcb90: finiteOrNull(residualOos.top_bottom_spread_lcb90),
    fusion_top_trade_ev_lcb90: finiteOrNull(championComparison.top_trade_ev_lcb90),
    fusion_oof_max_date: stringOrNull(sampleAudit.oof_max_date),
    mature_outcome_max_date: stringOrNull(sampleAudit.label_known_max_date),
    fusion_final_comparison_decision: stringOrNull(championComparison.decision),
    fusion_final_comparison_samples: pairedSamples,
    fusion_final_comparison_dates: finiteOrNull(championComparison.oos_date_count),
    fusion_final_comparison_reason: pairedSamples === 0 && championFailed.includes('residual_adjustment_model_not_validated')
      ? 'residual_adjustment_model_not_validated'
      : null,
    walk_forward_passed: boolOrNull(walkForward.passed),
    walk_forward: adaptWalkForward(walkForward),
    execution_decision: stringOrNull(executionModel.decision),
    execution_probability_decision: stringOrNull(executionProbabilityModel.decision),
    promotion_tier: stringOrNull(promotion.tier),
  }
}

export function adaptExpectedReturnShadow(row: ExpectedReturnShadowDbRow): ExpectedReturnShadowEvidence {
  const packet = parseRecord(row.validation_packet_json)
  const expected = expectedIdentity(row.model_name)
  const blockers: string[] = []
  const canonicalSha256 = (value: unknown): boolean => /^[0-9a-f]{64}$/.test(String(value ?? ''))
  if (row.identity_schema_version === 'expected-return-shadow-evaluation-identity-legacy-v1') {
    blockers.push('shadow_identity_legacy_unverified')
  } else if (row.identity_schema_version === 'expected-return-shadow-evaluation-identity-v2') {
    if (!canonicalSha256(row.evaluation_id)) blockers.push('shadow_evaluation_id_invalid')
    if (!canonicalSha256(row.subject_artifact_checksum)) {
      blockers.push('shadow_subject_artifact_checksum_invalid')
    }
    if (!canonicalSha256(row.evaluator_contract_checksum)) {
      blockers.push('shadow_evaluator_contract_checksum_invalid')
    }
  } else {
    blockers.push('shadow_identity_schema_incompatible')
  }
  if (!row.evaluation_id || !row.cohort_id) blockers.push('shadow_lineage_identity_missing')
  if (!canonicalSha256(row.base_manifest_checksum)
      || !canonicalSha256(row.extension_manifest_checksum)) {
    blockers.push('shadow_manifest_checksum_invalid')
  }
  if (!canonicalSha256(row.artifact_checksum)
      || !String(row.artifact_path ?? '').endsWith(`/${row.artifact_checksum}.json`)) {
    blockers.push('shadow_artifact_identity_invalid')
  }
  if (!row.model_version.startsWith(expected.modelVersionPrefix)) blockers.push('shadow_model_version_unsupported')
  if (packet.schema_version !== expected.validationSchema) blockers.push('shadow_validation_schema_incompatible')
  if (stringOrNull(packet.model_version) && packet.model_version !== row.model_version) blockers.push('shadow_payload_version_mismatch')
  if (String(packet.decision ?? '').toUpperCase() !== String(row.quality_decision ?? '').toUpperCase()) {
    blockers.push('shadow_quality_decision_mismatch')
  }
  if (row.policy_decision !== 'shadow_only') blockers.push('shadow_policy_scope_mismatch')
  const trusted = blockers.length === 0
  const trustedPacket = trusted ? packet : {}
  const sampleAudit = record(trustedPacket.sample_audit)
  const l4Oos = record(trustedPacket.oos_metrics)
  const residual = record(trustedPacket.residual_adjustment_model)
  const residualOos = record(residual.oos_metrics)
  const selectionOos = record(trustedPacket.selection_diagnostic_oos_metrics_not_served)
  const walkForward = row.model_name === 'l4_alpha_ev'
    ? record(trustedPacket.walk_forward)
    : record(residual.walk_forward)
  const shadowDiagnostics = record(trustedPacket.shadow_diagnostics)
  return {
    evaluation_id: row.evaluation_id,
    cohort_id: row.cohort_id,
    base_manifest_checksum: row.base_manifest_checksum,
    extension_manifest_checksum: row.extension_manifest_checksum,
    identity_schema_version: row.identity_schema_version,
    subject_artifact_checksum: row.subject_artifact_checksum,
    evaluator_contract_checksum: row.evaluator_contract_checksum,
    artifact_path: row.artifact_path,
    artifact_checksum: row.artifact_checksum,
    business_date: row.business_date,
    model_name: row.model_name,
    model_version: row.model_version,
    oof_min_date: row.oof_min_date,
    oof_max_date: row.oof_max_date,
    oof_date_count: finiteOrNull(row.oof_date_count) ?? 0,
    oof_row_count: finiteOrNull(row.oof_row_count) ?? 0,
    quality_decision: row.quality_decision,
    policy_decision: row.policy_decision,
    updated_at: row.updated_at,
    validation_schema_version: stringOrNull(packet.schema_version),
    identity_valid: trusted,
    identity_blockers: blockers,
    failed_gates: [...new Set([...stringArray(trustedPacket.failed_gates), ...blockers])],
    sample_count: finiteOrNull(sampleAudit.sample_count),
    date_count: finiteOrNull(sampleAudit.date_count),
    sector_samples: finiteOrNull(sampleAudit.sector_alpha_available_count),
    sector_dates: finiteOrNull(sampleAudit.sector_alpha_available_date_count),
    l4_corr_lcb90: finiteOrNull(l4Oos.date_mean_cross_section_corr_lcb90),
    l4_spread_lcb90: finiteOrNull(l4Oos.date_mean_top_bottom_spread_lcb90),
    l4_top_return: finiteOrNull(l4Oos.top_quintile_mean_return),
    l4_top_lcb90: finiteOrNull(l4Oos.date_mean_top_quintile_return_lcb90),
    selection_corr_lcb90: finiteOrNull(selectionOos.prediction_target_corr_lcb90),
    selection_spread_lcb90: finiteOrNull(selectionOos.top_bottom_spread_lcb90),
    residual_corr_lcb90: finiteOrNull(residualOos.prediction_target_corr_lcb90),
    residual_spread_lcb90: finiteOrNull(residualOos.top_bottom_spread_lcb90),
    walk_forward_passed: boolOrNull(walkForward.passed),
    walk_forward: adaptWalkForward(walkForward),
    execution_decision: stringOrNull(record(shadowDiagnostics.conditional_execution_return_model).decision),
    execution_probability_decision: stringOrNull(record(shadowDiagnostics.execution_probability_model).decision),
    previous_business_date: stringOrNull(row.previous_business_date),
    evidence_comparable_to_previous_business_date: !row.previous_business_date
      ? null
      : row.cohort_id === stringOrNull(row.previous_cohort_id)
        && row.base_manifest_checksum === stringOrNull(row.previous_base_manifest_checksum)
        && row.evaluator_contract_checksum === stringOrNull(row.previous_evaluator_contract_checksum),
    evidence_advanced_from_previous_business_date: !row.previous_business_date
      || row.cohort_id !== stringOrNull(row.previous_cohort_id)
      || row.base_manifest_checksum !== stringOrNull(row.previous_base_manifest_checksum)
      || row.evaluator_contract_checksum !== stringOrNull(row.previous_evaluator_contract_checksum)
      ? null
      : row.oof_max_date !== stringOrNull(row.previous_oof_max_date)
        || (finiteOrNull(row.oof_date_count) ?? 0) !== (finiteOrNull(row.previous_oof_date_count) ?? 0)
        || (finiteOrNull(row.oof_row_count) ?? 0) !== (finiteOrNull(row.previous_oof_row_count) ?? 0)
        || finiteOrNull(sampleAudit.sample_count) !== finiteOrNull(row.previous_sample_count)
        || finiteOrNull(sampleAudit.date_count) !== finiteOrNull(row.previous_date_count),
  }
}
