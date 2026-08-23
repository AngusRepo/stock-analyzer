import contractManifest from '../../../schemas/expected-return-contracts-v1.json'

type ManifestContract = {
  artifact_contract_version: string
  feature_semantic_version: string
  label_schema_version: string
  model_version_prefix: string
  validation_schema_version: string
  expected_return_semantic: string
}

const manifest = contractManifest as {
  schema_version: string
  canonical_label_schema_version: string
  legacy_label_schema_version: string
  canonical_roundtrip_cost_bps: number
  owners: {
    l4_alpha_ev: { current: ManifestContract; retired_compatibility: Record<string, unknown>[] }
    allocator_ev_fusion: { current: ManifestContract; retired_compatibility: Record<string, unknown>[] }
  }
}

function runtimeContract(value: ManifestContract) {
  return Object.freeze({
    artifactContractVersion: value.artifact_contract_version,
    featureSemanticVersion: value.feature_semantic_version,
    labelSchemaVersion: value.label_schema_version,
    modelVersionPrefix: value.model_version_prefix,
    validationSchemaVersion: value.validation_schema_version,
    expectedReturnSemantic: value.expected_return_semantic,
  })
}

export const EXPECTED_RETURN_CONTRACT_MANIFEST_VERSION = manifest.schema_version
export const EVIDENCE_LABEL_SCHEMA_VERSION = manifest.canonical_label_schema_version
export const LEGACY_EVIDENCE_LABEL_SCHEMA_VERSION = manifest.legacy_label_schema_version
export const CANONICAL_ROUNDTRIP_COST_BPS = manifest.canonical_roundtrip_cost_bps
export const RETIRED_EXPECTED_RETURN_COMPATIBILITY = Object.freeze({
  l4_alpha_ev: Object.freeze([...manifest.owners.l4_alpha_ev.retired_compatibility]),
  allocator_ev_fusion: Object.freeze([...manifest.owners.allocator_ev_fusion.retired_compatibility]),
})

export const L4_ALPHA_EV_CONTRACT = runtimeContract(manifest.owners.l4_alpha_ev.current)

const fusionCurrent = runtimeContract(manifest.owners.allocator_ev_fusion.current)
export const ALLOCATOR_EV_FUSION_CONTRACT = Object.freeze({
  ...fusionCurrent,
  compatiblePairs: Object.freeze([fusionCurrent]),
})
