"""Canonical cross-layer versions for production expected-return artifacts."""

LABEL_SCHEMA_VERSION = "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
LEGACY_LABEL_SCHEMA_VERSION = "next-session-raw-open-to-fifth-session-raw-close-canonical-finlab-factor-net-v3"
CANONICAL_ROUNDTRIP_COST_BPS = 18.0
CANONICAL_ROUNDTRIP_COST_RATE = CANONICAL_ROUNDTRIP_COST_BPS / 10_000.0

LEGACY_L4_ARTIFACT_CONTRACT_VERSION = "l4-alpha-ev-contract-v4"
LEGACY_L4_FEATURE_SEMANTIC_VERSION = "l4-directional-score-components-v2-lineage-bound"
L4_ARTIFACT_CONTRACT_VERSION = "l4-alpha-ev-contract-v5"
L4_FEATURE_SEMANTIC_VERSION = "l4-directional-score-sector-components-v3-lineage-bound"
SUPPORTED_L4_SERVING_CONTRACT_PAIRS = frozenset({
    ("l4-alpha-ev-contract-v3", LEGACY_LABEL_SCHEMA_VERSION),
    (LEGACY_L4_ARTIFACT_CONTRACT_VERSION, LABEL_SCHEMA_VERSION),
    (L4_ARTIFACT_CONTRACT_VERSION, LABEL_SCHEMA_VERSION),
})
SUPPORTED_L4_FEATURE_SEMANTICS = {
    "l4-alpha-ev-contract-v3": LEGACY_L4_FEATURE_SEMANTIC_VERSION,
    LEGACY_L4_ARTIFACT_CONTRACT_VERSION: LEGACY_L4_FEATURE_SEMANTIC_VERSION,
    L4_ARTIFACT_CONTRACT_VERSION: L4_FEATURE_SEMANTIC_VERSION,
}

# Fusion v13 is the only production serving contract.

ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION = "allocator-ev-fusion-contract-v13"
ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION = "allocator-ev-fusion-s12-policy-value-day-t-causal-v4-lineage-bound"
SUPPORTED_ALLOCATOR_EV_SERVING_CONTRACT_PAIRS = frozenset({
    (
        ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION,
        LABEL_SCHEMA_VERSION,
    ),
})
SUPPORTED_ALLOCATOR_EV_FEATURE_SEMANTICS = {
    ALLOCATOR_EV_ARTIFACT_CONTRACT_VERSION: ALLOCATOR_EV_FEATURE_SEMANTIC_VERSION,
}
