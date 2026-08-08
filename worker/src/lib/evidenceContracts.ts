export const EVIDENCE_LABEL_SCHEMA_VERSION =
  'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'

export const L4_ALPHA_EV_CONTRACT = Object.freeze({
  artifactContractVersion: 'l4-alpha-ev-contract-v5',
  featureSemanticVersion: 'l4-directional-score-sector-components-v3-lineage-bound',
  labelSchemaVersion: EVIDENCE_LABEL_SCHEMA_VERSION,
})

export const ALLOCATOR_EV_FUSION_CONTRACT = Object.freeze({
  artifactContractVersion: 'allocator-ev-fusion-contract-v14',
  featureSemanticVersion: 'allocator-ev-fusion-l4-residual-overlay-day-t-causal-v1-lineage-bound',
  labelSchemaVersion: EVIDENCE_LABEL_SCHEMA_VERSION,
  compatiblePairs: Object.freeze([
    Object.freeze({
      artifactContractVersion: 'allocator-ev-fusion-contract-v14',
      featureSemanticVersion: 'allocator-ev-fusion-l4-residual-overlay-day-t-causal-v1-lineage-bound',
      labelSchemaVersion: EVIDENCE_LABEL_SCHEMA_VERSION,
    }),
  ]),
})
