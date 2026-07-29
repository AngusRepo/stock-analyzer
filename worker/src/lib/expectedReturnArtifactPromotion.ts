import { resolveExpectedReturnServingState, type ExpectedReturnOwner } from './expectedReturnServingState'

type JsonRecord = Record<string, any>

export interface ExpectedReturnPromotionCandidate {
  artifact: JsonRecord
  validation_packet: JsonRecord
  operational_parity: JsonRecord
  cohort_id: string
  source_run_date: string
  artifact_path: string
  artifact_checksum: string
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
  const trainedUntil = cleanDate(artifact.trained_until)
  const blockers: string[] = []

  if (!cohortId) blockers.push('cohort_id_missing')
  if (!sourceRunDate) blockers.push('source_run_date_missing')
  if (!modelVersion) blockers.push('model_version_missing')
  if (!/^[a-f0-9]{64}$/.test(artifactChecksum)) blockers.push('artifact_checksum_invalid')
  const expectedArtifactPrefix = `universal/ev_candidates/${cohortId}/${owner}/`
  if (
    !artifactPath.startsWith(expectedArtifactPrefix)
    || !artifactPath.endsWith(`/${artifactChecksum}.json`)
  ) {
    blockers.push('artifact_path_checksum_lineage_mismatch')
  }
  if (artifact.expected_return_owner !== owner) blockers.push('expected_return_owner_mismatch')
  if (decision(validationPacket.decision) !== 'PASS') blockers.push('offline_validation_not_pass')
  if (stringArray(validationPacket.failed_gates).length > 0) blockers.push('offline_validation_has_failed_gates')
  if (decision(artifactValidation.decision) !== 'PASS') blockers.push('artifact_validation_not_pass')
  if (stringArray(artifactValidation.failed_gates).length > 0) blockers.push('artifact_validation_has_failed_gates')
  if (parity.schema_version !== 'ev-operational-parity-v2') blockers.push('owner_parity_contract_incompatible')
  if (decision(ownerParity.decision) !== 'PASS') blockers.push('owner_operational_parity_not_pass')
  if (stringArray(ownerParity.failed_gates).length > 0) blockers.push('owner_operational_parity_has_failed_gates')
  if (trainingData.generation_mode !== 'purged_oof') blockers.push('promotion_requires_purged_oof')
  if (cleanId(trainingData.cohort_id) !== cohortId) blockers.push('cohort_lineage_mismatch')
  if (!trainedUntil || (sourceRunDate && trainedUntil > sourceRunDate)) blockers.push('trained_until_after_source_run_date')
  if (artifact.output_is_net_of_costs !== true) blockers.push('expected_return_not_net_of_costs')

  const servingArtifact = blockers.length === 0
    ? {
      ...artifact,
      validation_packet: validationPacket,
      operational_parity: parity,
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
