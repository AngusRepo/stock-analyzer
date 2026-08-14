import type { DataDomain } from './dataDomainRegistry'

type ExpectedCandidateIdentity = {
  artifactId: string
  modelName: string
  candidateType: string
  version: string
  trainingRunId: string
  checksum: string
  sourceRunDate: string
  artifactContractVersion: string
  featureSemanticVersion: string
  labelSchemaVersion: string
  validationSchemaVersion: string
}

const TRAINING_RUN_ID = 'active8_oof:active8-oof-v7-immutable-fold-evidence-2026-01-29-2026-07-22-tr60-te10'
const LABEL_SCHEMA_VERSION = 'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'
const IDENTITY_SCHEMA_VERSION = 'expected-return-candidate-identity-v2'
const VALID_CADENCES = new Set(['daily', 'weekly', 'monthly', 'manual', 'event-driven'])

const EXPECTED_BY_ARTIFACT_ID = new Map<string, ExpectedCandidateIdentity>([
  ['l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-20260809', {
    artifactId: 'l4_alpha_ev:l4-alpha-ev-ridge-v5-sector-20260809',
    modelName: 'l4_alpha_ev',
    candidateType: 'l4_alpha_ev_refresh',
    version: 'l4-alpha-ev-ridge-v5-sector-20260809',
    trainingRunId: TRAINING_RUN_ID,
    checksum: '57924157cb6dbdf6a2bf3dd50f761b900b7530884dbfbcf9595364fbfc506acf',
    sourceRunDate: '2026-08-09',
    artifactContractVersion: 'l4-alpha-ev-contract-v5',
    featureSemanticVersion: 'l4-directional-score-sector-components-v3-lineage-bound',
    labelSchemaVersion: LABEL_SCHEMA_VERSION,
    validationSchemaVersion: 'l4-alpha-ev-validation-packet-v1',
  }],
  ['allocator_ev_fusion:allocator-ev-fusion-residual-v14-20260809', {
    artifactId: 'allocator_ev_fusion:allocator-ev-fusion-residual-v14-20260809',
    modelName: 'allocator_ev_fusion',
    candidateType: 'allocator_ev_fusion_refresh',
    version: 'allocator-ev-fusion-residual-v14-20260809',
    trainingRunId: TRAINING_RUN_ID,
    checksum: '359b98684868acaf2ba7bc4bf27575538f99a7f57f110d8a53e67a52dcbe5d15',
    sourceRunDate: '2026-08-09',
    artifactContractVersion: 'allocator-ev-fusion-contract-v14',
    featureSemanticVersion: 'allocator-ev-fusion-l4-residual-overlay-day-t-causal-v1-lineage-bound',
    labelSchemaVersion: LABEL_SCHEMA_VERSION,
    validationSchemaVersion: 'allocator-ev-fusion-validation-packet-v14',
  }],
])

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseEvidence(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return record(JSON.parse(value))
  } catch {
    return null
  }
}

function assertExact(
  artifactId: string,
  field: string,
  actual: unknown,
  expected: unknown,
): void {
  if (actual !== expected) {
    throw new Error(`expected_return_candidate_identity_backfill_mismatch:${artifactId}:${field}`)
  }
}

export function assertExpectedReturnCandidateIdentityBackfillRows(
  domain: DataDomain,
  table: string,
  rows: Record<string, unknown>[],
): number {
  if (domain !== 'learning' || table !== 'model_artifact_registry') return 0

  let matched = 0
  for (const row of rows) {
    const artifactId = String(row.artifact_id ?? '')
    const expected = EXPECTED_BY_ARTIFACT_ID.get(artifactId)
    if (!expected) continue
    matched += 1

    assertExact(artifactId, 'model_name', row.model_name, expected.modelName)
    assertExact(artifactId, 'candidate_type', row.candidate_type, expected.candidateType)
    assertExact(artifactId, 'version', row.version, expected.version)
    assertExact(artifactId, 'training_run_id', row.training_run_id, expected.trainingRunId)
    assertExact(artifactId, 'checksum', row.checksum, expected.checksum)
    assertExact(artifactId, 'source_run_date', row.source_run_date, expected.sourceRunDate)
    assertExact(artifactId, 'offline_gate_decision', String(row.offline_gate_decision ?? '').toUpperCase(), 'FAIL')

    const evidence = parseEvidence(row.offline_evidence_json)
    if (!evidence) {
      throw new Error(`expected_return_candidate_identity_backfill_mismatch:${artifactId}:offline_evidence_json`)
    }
    assertExact(artifactId, 'artifact_contract_version', evidence.artifact_contract_version, expected.artifactContractVersion)
    assertExact(artifactId, 'feature_semantic_version', evidence.feature_semantic_version, expected.featureSemanticVersion)
    assertExact(artifactId, 'label_schema_version', evidence.label_schema_version, expected.labelSchemaVersion)
    assertExact(artifactId, 'identity_schema_version', evidence.identity_schema_version, IDENTITY_SCHEMA_VERSION)
    assertExact(artifactId, 'expected_return_owner', evidence.expected_return_owner, expected.modelName)
    assertExact(artifactId, 'model_version', evidence.model_version, expected.version)
    assertExact(artifactId, 'artifact_checksum', evidence.artifact_checksum, expected.checksum)
    if (!VALID_CADENCES.has(String(evidence.cadence ?? ''))) {
      throw new Error(`expected_return_candidate_identity_backfill_mismatch:${artifactId}:cadence`)
    }

    const packet = record(evidence.validation_packet)
    if (!packet) {
      throw new Error(`expected_return_candidate_identity_backfill_mismatch:${artifactId}:validation_packet`)
    }
    assertExact(artifactId, 'validation_schema_version', packet.schema_version, expected.validationSchemaVersion)
    assertExact(artifactId, 'validation_decision', String(packet.decision ?? '').toUpperCase(), 'FAIL')
  }
  return matched
}
