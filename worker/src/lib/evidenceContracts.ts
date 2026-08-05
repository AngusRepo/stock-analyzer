export const EVIDENCE_LABEL_SCHEMA_VERSION =
  'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'

export const L4_ALPHA_EV_CONTRACT = Object.freeze({
  artifactContractVersion: 'l4-alpha-ev-contract-v4',
  featureSemanticVersion: 'l4-directional-score-components-v2-lineage-bound',
  labelSchemaVersion: EVIDENCE_LABEL_SCHEMA_VERSION,
})

export const ALLOCATOR_EV_FUSION_CONTRACT = Object.freeze({
  artifactContractVersion: 'allocator-ev-fusion-contract-v13',
  featureSemanticVersion: 'allocator-ev-fusion-s12-policy-value-day-t-causal-v4-lineage-bound',
  labelSchemaVersion: EVIDENCE_LABEL_SCHEMA_VERSION,
  compatiblePairs: Object.freeze([
    Object.freeze({
      artifactContractVersion: 'allocator-ev-fusion-contract-v13',
      featureSemanticVersion: 'allocator-ev-fusion-s12-policy-value-day-t-causal-v4-lineage-bound',
      labelSchemaVersion: EVIDENCE_LABEL_SCHEMA_VERSION,
    }),
  ]),
})
